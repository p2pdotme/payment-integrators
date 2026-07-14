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
integrator keeps both the funds *and* the accounting (per-merchant settlement
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

## Limits (enforced in `validateOrder`)

| Limit | Value |
| --- | --- |
| Per-transaction cap | 50 USDC (INR) / 100 USDC (other markets) |
| Daily transaction count | 25 per merchant per UTC day |
| Settlement lock | default 10 min; per-currency override; bounds [1 min, 30 days] |

The settlement lock is **admin-configurable with no redeploy**: `setSettlementPeriod`
sets the global default and `setLockPeriod(currency, seconds)` overrides per currency
(both super-admin-only, both bounded). Lock changes apply to **new** credits only;
existing buckets keep their original unlock timestamp.

The merchant's own proxy is carved out of `validateOrder` so SELL/withdrawal
placements do not hit buy-side limits. The daily counter resets when the UTC day
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
- `nonReentrant` + CEI on `userPlaceOrder`, every withdrawal, and all
  reconcile/recovery paths.
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
