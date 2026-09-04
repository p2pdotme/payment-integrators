# Merchant Terminal Integrator

`contracts/integrators/merchant-terminal/MerchantTerminalIntegrator.sol`

## What it serves

A point-of-sale terminal for merchants. A customer pays the merchant in local
currency (INR via UPI, BRL via PIX, ARS, …) through the P2P network; the merchant
receives USDC on Base held under a **configurable settlement lock** (default 10
minutes, tunable per currency), then withdraws either as **local fiat to their
saved payout handle** (a SELL offramp through the merchant's proxy) or as **USDC to
their wallet**. The offramp currency is chosen per merchant at registration, so any
country the P2P protocol has a circle for is supported with no contract change.

It differs from the other integrators as follows:

- **ExampleIntegrator** delivers a product (mints an NFT) on completion. The
  merchant terminal instead **custodies** the USDC in per-merchant settlement
  buckets and releases it after the lock — there is no product delivery.
- **TradeStars / Marketplace** use the proxy SELL offramp for a sell-back. The
  merchant terminal reuses that same offramp pattern for the merchant's **fiat
  withdrawal**, including a `reconcileWithdrawal` recovery path for cancelled SELL
  orders.

## Custody model — INTERNAL (this is the important part)

**All merchant USDC is custodied inside the integrator itself. There is no external
vault.** USDC swept from a merchant proxy at BUY completion lands directly on the
integrator's own balance, and every withdrawal pays out from that same balance. The
integrator keeps both the funds _and_ the accounting (per-merchant settlement
buckets, `totalOwed`, roles, limits).

The hard solvency invariant is a **local** property, checkable from one contract:

```
usdc.balanceOf(integrator) >= totalOwed        (== Σ over all merchants' buckets)
```

Money math is pure add / subtract / min (no division in any value path), so there
is no place a rounding residue can appear — proven to the wei in test `11a` with odd
amounts and an odd fee.

### Why internal custody (and not a separate vault)

An earlier iteration split custody into a separate `PayQRVault`. Review
([PR #33](https://github.com/p2pdotme/payment-integrators/pull/33)) identified that
this made **upgrades unsafe**: the vault authorised exactly one integrator at a time,
so repointing it to a replacement instantly disabled the old integrator's
withdrawals while the new one held no per-merchant records — stranding every
merchant's balance. Holding funds and records together in one contract removes that
failure mode structurally. See **Upgrades** below.

## Flow

### BUY (customer pays the merchant)

1. Merchant calls
   `userPlaceOrder(client, productId, quantity, currency, circleId, pubKey)`.
2. The order routes through the merchant's `UserProxy` clone; `recipientAddr` is the
   proxy and the integrator registers with `usdcThroughIntegrator = false`, so the
   Diamond pays USDC to the proxy at completion.
3. On `onOrderComplete`, the integrator sweeps the USDC off the proxy via
   `transferERC20ToIntegrator` (it now sits in the integrator's own custody) and
   records a `SettlementBucket {amount, unlockTimestamp = now + lockPeriod(currency)}`.

### BUY via a payment link (customer has no wallet)

`userPlaceOrder` credits `msg.sender`, so only the merchant's own signer can call
it. That works at the counter, where the merchant's device signs while the
customer pays fiat beside them — but not for a link the customer opens on their
own phone, with no wallet, while the merchant is away.

1. Merchant calls `createLink(linkId, amount, currency, expiresAt, maxUses,
   encryptedConfig)` from their own signer. `owner` is taken from `msg.sender`,
   so a link can only ever be created for oneself. `linkId` MUST come from
   `PaymentLinksLib.computeLinkId(merchant, salt)`.
2. The customer opens the link and taps Pay. Their browser has no key, so a
   keeper — the contract's existing `trustedRelayer` — calls
   `relayerPlaceOrder(linkId, client, productId, quantity, currency, circleId,
   pubKey)` on the merchant's behalf.
3. The customer pays fiat to the LP, then `relayerMarkPaid(linkId, orderId)`
   moves the order to PAID.
4. The LP confirms receipt and completes. From there the order settles
   **identically to a counter sale**: same `onOrderComplete` sweep, same
   `SettlementBucket`. Payment links change nothing about custody or unlock
   timing.

#### Why a link order's `order.user` is the merchant's PROXY

The Diamond authorises `paidBuyOrder` against **`order.user`** — not the placer,
and not `recipientAddr`. Verified by `eth_call` against both the Base mainnet
Diamond (`0x4cad…6368`) and the Base Sepolia Diamond (`0xeb0B…beb9`): from
`order.user` the call clears the ACL and fails only on a status/expiry check,
while every other caller — including the order's own `recipientAddr` — reverts
`NotAuthorized()`.

So a link order that recorded the MERCHANT as `order.user` could never be marked
paid: the merchant is absent by construction, and their key is the only one the
Diamond would accept. The customer's fiat would be gone and the order would sit
until TTL and cancel.

`_placeOrder` therefore takes a `userIsProxy` flag:

| path | `order.user` | who advances it |
| --- | --- | --- |
| `userPlaceOrder` (POS) | the merchant | the merchant's own device, directly |
| `relayerPlaceOrder` (link) | the merchant's `UserProxy` | this contract, via `relayerMarkPaid` |

The POS shape is unchanged, so the shipped `@p2pdotme/widgets` flow still signs
`paidBuyOrder` itself.

Two consequences fall out of that, and both are handled explicitly:

- **`validateOrder`** sees a proxy as `order.user` for BOTH a SELL placement and
  a link BUY. The old blanket `proxyMerchant[user] != 0 → return true` carve-out
  would have silently disabled the per-tx cap, the daily count and the
  frozen-merchant switch on the one flow open to anonymous customers. It is now
  narrowed to a `transient _sellPlacement` flag set only around our own SELL
  placement, and a link BUY **resolves** the proxy back to its owner so the
  merchant's real limits apply.
- **`onOrderComplete`** receives the proxy as `user`, so it resolves
  proxy → merchant before touching money. Without this, `proxyAddress(proxy)`
  is an address that was never deployed and the USDC sweep reverts — after the
  customer has already paid.

#### Link lifecycle

`maxUses` is how many **successful** payments a link accepts; `0` is unlimited
and `1` is the old single-use link. A cancelled or abandoned order releases its
use in `onOrderCancel` (via `orderToLink`), so a customer who taps Pay and walks
away does not retire the merchant's link.

`revokeLink(linkId)` is callable by the link's owner or an `isOwner[]` admin —
deliberately **not** by the relayer, which has no authority over link lifecycle.
Because status, expiry, and use count are all checked inside `relayerPlaceOrder`
itself, a revocation and the next payment attempt can never diverge.

`setLinkOrdersEnabled(bool)` (MANAGER) is a kill switch scoped to link orders
only: flipping it off stops `relayerPlaceOrder` and `relayerMarkPaid` while
leaving the relayer's unrelated keeper duties — and every merchant's fiat
withdrawal — working.

#### False payment claims (`strikes`)

PAID is a **claim**, not a settlement: no USDC moves, and the LP still settles
against their own bank. A customer who lies cannot steal — but they can waste
the LP's escrowed capital and dispute time for free.

`relayerMarkPaid` takes a provisional strike, and `onOrderComplete` releases it
when the claim proves true. An order marked paid and then CANCELLED therefore
leaves exactly one permanent strike, with no per-order storage.

Strikes are **advisory on-chain**: the contract records them so the merchant can
see a link attracting false claims, and never blocks on them. Blocking the link
would let anyone kill any merchant's link with two taps — a worse griefing
surface than the one it closes. Throttling the CLAIMANT is the relayer service's
job, because only it can see an IP. `resetLinkStrikes(linkId)` clears the
counter (owner or admin).

**Relayer blast radius.** The relayer is never a registered merchant, so
`withdrawUSDC`, `withdrawFiat`, and `updateProfile` all reject it on
`msg.sender`. Both relayer entry points require `orderToLink[orderId] == linkId`,
so it cannot touch an order that did not come from the link it names. The worst
a fully compromised relayer key can do is place spurious orders that **credit**
merchants, and claim payment on a genuine link order that was not in fact paid —
which the LP rejects, because the LP settles against their own bank.

#### Contract size

This contract sits against the 24,576-byte EIP-170 ceiling. Payment-link
lifecycle lives in `PaymentLinksLib`, an external (delegatecall) library, and
`hardhat.config.ts` carries a **per-file** optimizer override (`runs: 50`) for
this contract alone. Even so the margin is 72 bytes. The next feature here
needs the withdrawal / fund-helper sections (~44% of the contract) moved into
their own library, or a facet split.

### SELL (merchant withdraws fiat)

1. Merchant calls `withdrawFiat(amount, circleId, pubKey, encPayout)` against
   unlocked buckets.
2. The integrator funds the **merchant's own proxy** and places `placeB2BSellOrder`
   with the merchant's relay pubkey as `userPubKey`. The payout handle (UPI/PIX) is
   delivered later, encrypted, via `deliverFiatPayout` → `setSellOrderUpi`.
3. If the Diamond cancels the SELL order, `reconcileWithdrawal(orderId)` reads the
   authoritative status from the Diamond, sweeps the refunded USDC back off the proxy
   into custody (capped at the recorded amount), and re-credits the merchant — so no
   funds are stranded.

`withdrawUSDC(amount)` sends unlocked USDC straight to the merchant wallet from the
integrator's own balance.


## The contract is at its size ceiling

`MerchantTerminalIntegrator` measures **24,515 of the 24,576 bytes** EIP-170
allows — 61 bytes of headroom, at `runs: 50` for this file only.

This is a standing constraint on the contract, not a note about one change. Any
addition to it needs a plan for where the space comes from: relocating the
withdrawal and fund-helper sections into a library (~44% of the contract), or
splitting into facets. Both touch audited custody code and belong in their own
reviewed change.

Everything in the payment-links work is additive — `LinkRouter` is a separate
contract with its own budget — so none of it consumed that headroom.

## Deployment and whitelisting checklist

Payment links depend on three things that live OUTSIDE this repository. All
three are silent when missing — nothing reverts, nothing logs, the feature
simply does not work — so they are listed here rather than discovered later.

### 0. LinkRouter must be deployed and wired (required)

Every link payment goes through `LinkRouter`. Without it the integrator's
`trustedRelayer` still points at whatever it pointed at before, and no link
payment can be placed at all.

```
INTEGRATOR=0x… npx hardhat run scripts/deploy-link-router.ts --network base
```

That deploys `LinkRouter(integrator)` and calls `setTrustedRelayer(router)`,
which needs the MANAGER role. Pass `SKIP_WIRE=1` to deploy only, when the
manager is a different key.

`setTrustedRelayer` is also the rollback: pointing it back at the previous
address stops every link payment without touching anything else.

Then the Worker needs the account-abstraction wiring — see `worker/README.md`
for the full list. Two are worth repeating because getting them wrong is
invisible:

- **`ACCOUNT_FACTORY_KIND`** — `thirdweb` takes `(address, bytes)`,
  the ERC-4337 reference factory takes `(address, uint256)`. Different
  argument types mean different SELECTORS, so the wrong value does not fail
  loudly; it calls a function the factory does not have. This shipped wrong once.
- **`SPONSOR_VERIFIER_SECRET`** — `/api/sponsor-check` FAILS CLOSED without
  it. That is deliberate: unauthenticated, an outsider can exhaust a link's
  sponsorship allowance without ever sending a transaction.

Finally, the provider's sponsorship policy must allowlist **this Router and
nothing else**, and point its server verifier at `/api/sponsor-check`. Without
the allowlist a leaked client id sponsors strangers' transactions on your bill.

### 0a. Creating a link is two calls, in this order

A link needs a wallet before it can be paid, and the merchant app must mint one:

```
POST /api/links/:linkId/wallet   →  { account }        (merchant-signed)
then batch, IN THIS ORDER:
  integrator.createLink(linkId, …)
  router.registerAgent(linkId, account)
```

`registerAgent` reads `getLink` to check ownership, so `createLink` has to land
first within the batch. Reversed, the batch reverts. **Omitted entirely, the
link looks completely correct** — on-chain, owned by the merchant, active,
correct amount — and can never be paid, with nothing before the first payment
attempt to say so.

`registerAgent` is write-once. A link whose wallet is lost cannot be re-bound;
revoke it and issue a new one.

### 1. The cancel callback must be switched on (required)

`onOrderCancel` is only delivered if a p2p super-admin has run
`setIntegratorCancelCallback(integrator, true)`. It is per-integrator and
defaults to OFF. Without it, on the real Diamond:

- a link's `uses` is never released, so a `maxUses = 1` link is burned by the
  first abandoned tap and no later customer can pay it;
- the merchant's daily slot is never released on cancellation or expiry;
- `OrderCancelled` never fires, so the relayer's false-claim sweep records
  nothing and the per-claimant block is dead code.

This integrator meets the callback's requirements: `onOrderCancel` is
idempotent, `onOrderComplete` does not revert on a re-opened CANCELLED → PAID
order, and both are well inside the 250k gas ceiling.

### 2. Fraud screening must be wired to the pay page (required for INR)

The merchant app only accepts an order that has an approved screening record,
keyed by order id, and INR BUY orders are not auto-approved. An unscreened
order sits at PLACED until it expires. Testnet demo bots do not enforce this,
so a green testnet run says nothing about it.

The screening call must be EIP-191 signed by "the user", and `order.user` for a
link order is the merchant's proxy, which cannot sign. The workable path is the
one `<Checkout>` already supports: the pay page passes the screening prop and
gives its signer stub a `signMessage` backed by the customer's ephemeral key —
the same key it already generates for `pubKey` — so the screening subject is
that ephemeral address. That also satisfies the engine's one-in-flight-per-
wallet rule, which the relayer as subject would trip immediately.

Also needed: a fraud-engine CORS entry for the pay-page origin, and the shared
key handover.

### 3. Deploy is two contracts, and the optimizer setting is not standard

`PaymentLinksLib` is an external library and must be deployed and linked before
the integrator. The whitelist request needs BOTH addresses, and Basescan
verification of the integrator needs the library address too.

This contract also carries a per-file optimizer override (`runs: 50`) because it
sits against the size ceiling. That has a consequence worth stating plainly:
the constructor deploys a `UserProxy`, and an overridden file is compiled
together with its imports, so the `proxyImpl` this integrator deploys is built
at `runs: 50` rather than the `runs: 200` used by every other integrator. Since
whitelisting checks `proxyImpl` against the canonical `UserProxy` bytecode and
`proxyImpl` is set-once on the Diamond, this needs either an explicit exception
with a reproducible build recipe, or the size problem solved structurally so
the override can be dropped.

### Also confirm before going live

- `setLinkRelayer` for each relaying key, and `setTrustedRelayer` for the fiat
  keeper — these are separate roles.
- `ALLOWED_ORIGINS` set to the real pay-page origins, not the `*` fallback.
- Worker secrets stored with `--env production`; bindings repeated under
  `[env.production]` (they are not inherited).
- **Turnstile is configured**: `wrangler secret put TURNSTILE_SECRET --env
  production`, and the pay page renders the widget and sends the token (header
  `cf-turnstile-response`, or `turnstileToken` in the body) on both `/api/pay`
  and `/api/relay-tx`.

  Order placement is anonymous and the relayer pays for it, so rate limits
  ration the wrong thing — requests are free to an attacker and each one that
  lands costs a real transaction and a real slot out of a merchant's daily
  limit. `REQUIRE_TURNSTILE = "true"` is already set for production, so a
  missing secret is a loud 503 rather than an open door; `GET /health` reports
  `turnstile: true` once the gate is live. Confirm that before announcing a
  link publicly.

## Limits (enforced in `validateOrder`)

| Limit                   | Value                                                          |
| ----------------------- | -------------------------------------------------------------- |
| Per-transaction cap     | 50 USDC (INR) / 100 USDC (other markets)                       |
| Daily transaction count | 25 per merchant per UTC day                                    |
| Settlement lock         | default 10 min; per-currency override; bounds [1 min, 30 days] |

The settlement lock is **admin-configurable with no redeploy**: `setSettlementPeriod`
sets the global default and `setLockPeriod(currency, seconds)` overrides per currency
(both super-admin-only, both bounded). Lock changes apply to **new** credits only;
existing buckets keep their original unlock timestamp.

Link payments consume the **same** allowance as counter sales — one shared
per-tx cap and one shared daily count per merchant, because both paths reach
`validateOrder` through the same `_placeOrder` helper. A link order arrives at
`validateOrder` with the merchant's proxy as `user`, and is resolved back to the
merchant there, so the limits that apply are the merchant's own.

The merchant's own proxy is carved out of `validateOrder` so SELL/withdrawal
placements do not hit buy-side limits — but only while `_sellPlacement` is set,
i.e. for the duration of a withdrawal this contract is itself placing. A link
BUY also arrives with a proxy as `order.user` and is deliberately NOT carved
out. The daily counter resets when the UTC day
(`block.timestamp / 86400`) changes; `onOrderCancel` releases a consumed slot for the
current day only.

## Governance & recovery

- **RBAC:** 5 tiers (NONE < VIEWER < SUPPORT < MANAGER < FINANCE). Owners are
  effective FINANCE + can pause.
- **Super-admin:** a single unremovable root, above every owner, that alone manages
  the owner set and role assignments. It moves only via a **two-step handoff**
  (`transferSuperAdmin` proposes → the successor calls `acceptSuperAdmin`), which
  prevents a fat-fingered handoff to an uncontrolled address from bricking
  governance. A proposal is only acceptable for `SUPER_ADMIN_HANDOFF_TTL` (7 days);
  a stale, forgotten proposal expires (`HandoffExpired`) so a since-compromised
  pending key can never seize root months later. **For production the super-admin
  should be a multisig** (see the security notes / PR #33 H-3).
- **Break-glass pause:** any owner can `pause()` to halt new BUY orders and all
  withdrawals; Diamond completion/cancel callbacks, reconciliation, and admin
  recovery paths stay live so an incident can be wound down. `unpause()` resumes.
- **Dormant escheat:** a merchant frozen continuously for **90 days** (`frozenAt`,
  reset on any unfreeze) can have their entire remaining balance swept by the
  super-admin via `adminEscheat(merchant, to)` — so funds behind a permanently
  abandoned/blocked account are never lost. Buckets are zeroed before the transfer
  (CEI + `nonReentrant`), and `totalOwed` drops by exactly the amount, so it can
  never be double-claimed and solvency is preserved.
- **Wedge recovery:** `adminForceUnwedge` / `adminForceAbandonWedge` (frozen-gated)
  free a stuck in-flight withdrawal slot; the slot release is idempotent
  (`slotFreed`) so it happens exactly once across every recovery path.
- **Surplus skim:** `skimExcess(to)` (super-admin) withdraws USDC the contract holds
  **above `totalOwed`** — donations, Diamond over-refunds, and remainders absorbed
  by the capped recovery sweeps. Safe by construction: the amount is exactly
  `balanceOf(this) - totalOwed`, so merchant-owed funds can never be touched.
- **Completed-order leftover:** `finalizeWithdrawal` also sweeps any USDC left on
  the merchant proxy after a COMPLETED SELL (Diamond under-pull / stray transfer)
  and re-credits the merchant, capped at that order's principal + fee and re-locked
  under a fresh settlement window; anything above the cap becomes skimmable surplus.

## Upgrades (drain-in-place — no fund migration)

Because funds and records live together in the integrator, an upgrade is simply a
**fresh deployment** — there is **no** `migrateState`, `setVault`, or any
cross-contract fund-migration primitive (they were removed):

1. Deploy a new integrator for **new** orders and point the app at it.
2. **Leave the old integrator live.** It still holds its own USDC and its own
   per-merchant records, so merchants withdraw their balances from it normally until
   it is empty. Nothing cuts it off — this is the standard "old deployment stays live
   to drain" pattern.
3. For balances no one withdraws, the **90-day dormant escheat** recovers them from
   the old integrator, after which it is fully empty and can be retired.

No merchant's funds ever have to move between contracts, so a custody handoff can
never strand them. This is verified end-to-end by the `H-1: INTERNAL CUSTODY +
drain-based upgrade` tests (drain-in-place after a new integrator is deployed, and
dormant-leftover recovery via escheat).

## Safety properties

- All USDC movements use `SafeERC20`. No upgradeability, no `delegatecall`, no
  `selfdestruct`. Uses the canonical `UserProxy` (not forked) — a merchant has no
  path to extract USDC parked on their proxy (`sweepERC20` blocks the integrator's
  USDC; `execute`/`transferERC20ToIntegrator` are integrator-only).
- `validateOrder` / `onOrderComplete` / `onOrderCancel` are `onlyDiamond`.
- Settlement buckets are compacted (spent buckets dropped) and bounded by
  `MAX_BUCKETS = 256` to keep withdrawal gas bounded.
- `nonReentrant` + CEI on `userPlaceOrder`, `relayerPlaceOrder`, every
  withdrawal, and all reconcile/recovery paths. `relayerPlaceOrder` increments
  the link's use counter **before** the external call, so a single-use link is
  consumed at commit time independently of the reentrancy guard.
- Payment links pin what the merchant committed to: a fixed amount must match
  exactly (`LinkAmountMismatch`), and the currency is fixed at creation
  (`InvalidCurrency`), so even a compromised relayer cannot re-price a link into
  another currency's cap or lock-period regime. `createLink` also rejects an
  amount above the merchant's per-tx cap — keyed off their **registered**
  currency, matching what `validateOrder` enforces at pay time — so a link
  cannot be created that would only fail once a customer tries to pay it.
- The offramp fee is charged to the withdrawing merchant (debited from their own
  buckets), never sourced from the commingled pool.
- The merchant payout handle is **client-side encrypted** to the merchant's relay
  pubkey before it reaches the contract; it is stored as an opaque `bytes` blob,
  never decoded on-chain, and never emitted in events.

## Deploy

```bash
DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x... \
  npx hardhat run scripts/deploy-merchant-terminal.ts --network baseSepolia
```

Whitelist the **integrator** with `usdcThroughIntegrator = false` (the Diamond pays
the merchant proxy; `onOrderComplete` pulls into the integrator), alongside the
pinned `proxyImpl`. After deploy, hand the super-admin to a multisig via
`transferSuperAdmin` → `acceptSuperAdmin`.
