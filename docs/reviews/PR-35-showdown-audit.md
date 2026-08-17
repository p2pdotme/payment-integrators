# PR #35 — Showdown CCTP Checkout Integrator — pre-prod launch audit

> **Re-cut 2026-08-17 against the merged head (#54).** The load-bearing wrong claims this doc
> carried are corrected in place and marked: **D1** described the deploy script as doing the
> opposite of what it does, **D3** predated the `DRY_RUN` carve-out and the EOA-owner decision, and
> **F4** overclaimed reentrancy coverage that the mutation review disproved. Test counts are no
> longer stated here — they moved every commit and were wrong within a day; the PR carries the
> current number.
>
> **What this doc is:** the launch audit's findings (F1–F10) and the deploy gates (D1–D10), which are
> still the right go/no-go checklist. **What it is not:** a description of every change since. Three
> further adversarial review rounds followed this audit and their findings are tracked as issues
> (#44 #45 #47 #51 #52 #53 #55 #68 #69 #72 #73 #74 #75 #76 #78 — all closed), not folded in here.
> Read this for the gates; read the PR body for current state.
>
> Two findings below are superseded by upstream work rather than by anything in this repo: **F9**
> (`onOrderCancel` is live as of contracts-v4 #362, opt-in and default-off — see D9) and the
> `offrampRelayer` half of the delivery discussion (the relayer was removed outright, #53.2).

**Scope:** `contracts/integrators/showdown/ShowdownCheckoutIntegrator.sol` (branch
`feat/showdown-cctp-integrator`), plus its deploy / smoke / attestor scripts, tests and docs.
**Goal of this pass (per request):** confirm the contract is launch-ready for a Base **mainnet**
deploy, and re-cut the limits to the agreed policy — ceilings the owner can move _down_ but never up.
**Method:** full static read of the contract; conformance against `IP2PIntegrator` / `IB2BGateway` /
`IOrderFlow` / `UserProxy`; harness-fidelity check against `MockDiamond`; diff against the reviewed
siblings (`LotPotCheckoutIntegrator`, `UsdcDirectCheckoutIntegrator`, and the Investabl audit
`PR-40-investabl-audit.md`, of which Showdown is the two-way superset); compiled + ran the suite
(`evm: cancun`, `viaIR`). Baseline **54/54**, after changes **81/81**.

---

## Agreed limit policy

| Tier | Attestation         | India (INR) | Abroad   |
| ---- | ------------------- | ----------- | -------- |
| 0    | none                | blocked     | blocked  |
| 1    | liveness            | **$20**     | **$50**  |
| 2    | passport + liveness | **$100**    | **$200** |

Plus **5 orders/day per user**, budgeted separately per direction. All five numbers are immutable
`MAX_*` constants; the owner may set below them, never above.

**Region is derived from the order's fiat currency** — `INR` → India, everything else → Abroad
(decision 2026-07-27). This is a _payment-rail_ gate, not a nationality gate: the user picks the
currency, so the binding constraint is which fiat rail they can actually settle on. It needs zero
backend change and resolves at the Diamond's authoritative gate, since `validateOrder` receives the
currency. A true nationality gate would have to live in the attestation — a new EIP-712 typehash and
coordinated `simple-kyc` work on both live tenants.

---

## Findings

Severity is relative to a mainnet launch. **F1–F5 are fixed on this branch**; F6–F10 are accepted/documented; D1–D8 are deploy gates
that correct code cannot save you from.

### F1 — HIGH (governance): every limit was owner-raisable without bound → **FIXED**

`setTierCap` and `setDailyTxCountLimit` had no upper bound, `dailyTxCountLimit == 0` meant
_unlimited_, and `owner` is `immutable` — neither transferable nor renounceable, with no timelock.

This is a **protocol** risk, not a partner-config nit: a whitelisted integrator **bypasses the
protocol's own RP / daily / monthly / yearly volume limits and is trusted to enforce its own in
`validateOrder`** (`IB2BGateway` NatSpec). So a malicious _or compromised_ owner could, in four
transactions, `setLivenessAttestor(ownKey)` → self-attest a huge `grantedLimit` → `setTierCap(1, huge)`
→ `setDailyTxCountLimit(0)`, and route unbounded fiat→USDC through P2P's LP network. Showdown is the
worst case for this among the integrators: the proceeds are then **burned to Solana**, leaving the
P2P stack entirely.

**Fix (same remediation Investabl F1 took, extended to the region matrix):** immutable ceilings
`MAX_TIER_CAP_LIVENESS_INDIA` / `_LIVENESS_ABROAD` / `_KYC_INDIA` / `_KYC_ABROAD` and
`MAX_DAILY_TX_COUNT_LIMIT`, enforced in **both** the setters and the constructor via
`CapExceedsCeiling`. `dailyTxCountLimit == 0` is now rejected outright (`InvalidAmount`) — it was the
hole in the ceiling. `MAX_BRIDGE_MAX_FEE_BPS = 100` was added for the same reason: the old bound was
100%, which let an owner route an arbitrary share of every burn to the attestation service (no owner
gain, but user-fund destruction).

Ownership stays with Showdown by design: with the caps un-raisable, worst-case volume is bounded by
construction and P2P's lever is **de-registration**. Residual: Showdown still controls
`setLivenessAttestor` / `setKycAttestor`, so they can self-attest wallets that skipped the real
check — but each remains bounded by the immutable per-wallet caps, and aggregate abuse across many
wallets is what de-registration plus the per-human nullifier cover.

### F2 — MEDIUM (correctness/funds): `onOrderComplete` reserved USDC that may never have arrived → **FIXED**

The hook ignored both the delivered `amount` and `recipientAddr`, reserving and later burning
`session.amount` instead. Showdown is the case where that actually bites: **unbridged onramps share
one pooled balance on the integrator**, so a short delivery would have funded the burn out of another
buyer's reserved USDC and broken the invariant `usdc.balanceOf(this) >= unbridgedTotal` — which
`withdrawUsdc`, `retryBridge` _and_ `userRescueStuckBridge` all depend on. LotPot
(`LotPotCheckoutIntegrator.sol:802`) and Investabl (commit `cd84727`) both already guard this;
Showdown did not.

**Fix — two guards, deliberately asymmetric:**

- `recipientAddr != address(this)` → **revert** `UnexpectedRecipient`. The USDC did not arrive here,
  so recording it would be a lie; the gateway swallows the revert and nothing is stranded here.
- The delivered amount → **clamped, and the clamp runs unconditionally**. A revert would be _wrong_:
  the USDC did arrive, and a swallowed revert leaves it with no session record — i.e. sweepable by
  the owner as "surplus". The siblings can revert with `AmountMismatch` because they do not pool user
  funds; Showdown cannot.

  **Superseded (#73):** this originally read "re-pin to what was delivered", and the first
  implementation did exactly that, only when the reported amount differed from the placed one. Both
  halves were wrong. The session is now pinned to `min(reported, placed, unreserved balance)` on
  **every** completion — a Diamond that reports the placed amount while transferring less is the case
  the pooled-balance invariant actually needs, and bounding by free balance alone let an over-report
  reserve unrelated surplus. `OnrampAmountAdjusted` still fires on any discrepancy, including one the
  clamp absorbs.

Happy path is unchanged (no netting ⇒ always equal). Alert on `OnrampAmountAdjusted`; it should never
fire.

### F3 — MEDIUM (limits): the offramp bypassed the daily count entirely → **FIXED**

`validateOrder`'s seller branch returned before touching the counter, so "N per day" applied only to
onramp BUYs. A KYC'd user could place 5 onramps and then unlimited offramp SELLs. Both directions
convert between fiat and USDC, so both are the regulated activity.

**Fix:** a second counter `userDailyOfframpCount`, consumed in the seller branch and keyed to the
resolved human (not their proxy). Per the 2026-07-27 decision the two directions get **separate**
budgets of `dailyTxCountLimit` each.

### F4 — LOW (defense-in-depth): no reentrancy guards → **FIXED**

Showdown had no reentrancy guards. **Correction (#77):** this originally said "the siblings use
`nonReentrant`", which is false for half of them — `MarketplaceCheckoutIntegrator`,
`UsdcDirectCheckoutIntegrator` and both LotPot versions have **zero**. Only `MerchantTerminal` (19)
and `Investabl` (2) had any. Getting this wrong is itself the evidence for #77's argument: nobody
holds a family-wide view, so each audit assumes the others are fine. Not exploitable with real USDC (no transfer
hooks) and `UserProxy.execute` is itself guarded, but `userBridgeBackToSolana` reads
`usdc.balanceOf(proxy)` and _then_ pulls — a hook-bearing token would double-spend it.

**Fix:** transient-storage `nonReentrant` (matching `UserProxy`) on the seven value-moving
entrypoints. Deliberately **not** on `validateOrder` (the Diamond re-enters it inside
`userBuyUsdcToSolana` / `userInitiateOfframp`) nor on `onOrderComplete` / `selfBridge` (which
self-call by design).

**Correction (#54):** this finding originally claimed the guards were "covered by the existing
suite, which exercises both re-entry paths". They were not. No mock re-entered the burn path, so the
plain suite could not see it — commit `8cbc368` exists precisely because of that gap, adding
`MockReentrantUSDC`, which re-enters `retryBridge` from inside the messenger's `transferFrom`. That
is a real regression pin, verified by mutation: reverting the CEI ordering in `_bridge` turns exactly
one test red. The audit overclaimed coverage the mutation review disproved.

### F5 — (product): no way to stop one user → **FIXED**

`grantedLimit` and `userTier` are monotonic by design — a claim only ever raises them, and there was
no revocation. The only lever was zeroing a whole tier cap, which stops _everyone_.

**Fix:** `setUserBlocked(user, bool)`, a **binary gate only** — it never sets a per-user limit; limits
still come solely from the KYC tier and the region ceiling. It applies at both the entrypoints
(`UserIsBlocked`) and `validateOrder`. It deliberately does **not** gate `userBridgeBackToSolana` or
`userRescueStuckBridge`, so a block never strands funds the user already paid for. If seizing funds
from a sanctioned wallet is ever a requirement, that is a different and much larger design decision —
raise it before assuming this covers it.

### F6 — INFO: a block does not stop an order already placed (no fix — deliberate)

`setUserBlocked` gates _placement_ (`userBuyUsdcToSolana`, `userInitiateOfframp`, `validateOrder`)
and does not gate `onOrderComplete`, so a BUY placed before the block runs to completion.

> **Half of this finding was reversed (#53.1).** It originally said the block also does not gate
> `deliverOfframpUpi`, and argued that was correct. It is not, and the contract now honours
> `blocked[record.user]` at delivery: `blocked[]` exists precisely to stop a payout on a fraud report
> or sanctions hit, so a seller blocked _after_ placement must not be paid. The stranding worry that
> justified the old position does not apply — the USDC is still on the seller's own proxy, and both
> `userBridgeBackToSolana` and `userRescueProxyUsdc` (#74) remain open to them. The asymmetry that
> survives is with the `offrampEnabled` kill switch, which _does_ deliberately let in-flight orders
> settle so an accepted merchant is not stranded.

The `onOrderComplete` half stands. Blocking it would strand USDC the Diamond has already delivered,
recoverable only through the 7-day rescue. Blocking `onOrderComplete` would strand USDC the Diamond has already
delivered, recoverable only through the 7-day rescue. **Operationally: a block takes effect from the
next placement, not retroactively.** If an in-flight order must be stopped, that is a Diamond-side
cancellation, not an integrator lever.

### F7 — INFO: zeroing a higher tier's cell can invert the tiers (no fix — operator footgun)

`effectiveLimit` reads `tierCap[userTier[user]][region]` — the user's _own_ tier, not the best cell
available to them. So `setTierCap(TIER_KYC, REGION_INDIA, 0)` blocks passport-verified users from INR
orders while liveness-only users keep their $20. Upgrading your KYC would then _reduce_ your access.

Left as-is on purpose: making the lookup take the max across tiers at or below the user's would break
the per-lane kill switch, which is the more valuable property. Noted so the inversion isn't a surprise
if a lane is ever switched off — if you mean to stop everyone in a region, zero **both** cells.

### F8 — INFO: `userRescueStuckBridge` is the one path USDC reaches a user EOA (no fix — re-confirm)

Deliberate, and unchanged: buyer-only, after 7 days, and only reachable when CCTP has refused the
burn for that long. It is the one place the `UserProxy` USDC-trap is relaxed, i.e. a bounded
fiat→spendable-USDC route that skips consumer-side fraud checks. The bound has just moved from $50 to
**$200 per order** with the new matrix. The trade (bounded exposure vs. permanent loss of funds the
user already paid fiat for) still looks right, but it is a design decision worth re-confirming at the
new number rather than inheriting.

### F9 — RESOLVED upstream 2026-08-10: `onOrderCancel` is live, but Showdown must opt in

**Superseded.** This finding recorded that selector `0x7ff83a04` was absent from all 21 mainnet
facets, so `dailyTxCountLimit` bounded **placements** per day. That was true until 2026-08-05.

`contracts-v4` **#362** ("opt-in `IP2PIntegrator.onOrderCancel` on B2B BUY cancellation + bounded
callbacks", merge `962911e`) is now **merged and deployed** to the mainnet Diamond. Verified
2026-08-10: `setIntegratorCancelCallback(address,bool)` (`0x42de055b`) is present in live facet
`0x06909D396f04579fcEc20af17eAC6Efe56Bb939E`, and `getIntegratorConfig` now returns five fields
including `cancelCallbackEnabled`.

Three things follow for Showdown:

1. **It is opt-in and defaults to off.** Enabling is a separate super-admin
   `setIntegratorCancelCallback(showdown, true)` call **after** registration — see the deploy gates.
   Until that call, `dailyTxCountLimit` still bounds placements per day exactly as described above.
2. **It is BUY-only.** `onB2BOrderCancelled` is gated on `orderType == BUY`, so the offramp/SELL side
   still relies on `reconcile` to release its own daily slot.
3. **The gas cap is real.** #362 bounds the cancel callback at 250k gas because it runs inside the
   permissionless `autoCancelExpiredOrders` keeper. Showdown's `onOrderCancel` measures **27,860**
   gas (24,416 on a repeat call), comfortably inside, and #362 names Showdown as qualifying on all
   three of its enable gates.

Still **surface remaining-count in the widget** either way.

### F10 — INFO: the per-tx cap bounds the SELL _principal_, not principal + fee (no fix)

`userInitiateOfframp` checks `amount`, but `deliverOfframpUpi` pulls the authoritative
`actualUsdtAmount` (= principal + the Diamond's fee) from the proxy. So the value actually leaving a
user can exceed their tier cap by the fee. Immaterial in size; noted so the cap is not described as a
strict bound on value moved.

---

## The three PR #58 design calls — settled 2026-08-13

PR #58 fixed what it could and deliberately left three questions to p2p, all of them
bytecode-gating because the integrator is immutable. All three are now decided.

### #51.1 — `userCancelOfframp`: **not adding it**

A user-facing SELL cancel is not shipping. A cancel that could still land after the merchant has
sent the rupees is a merchant-funded double-spend, and it could not be verified against
`MockDiamond.cancelSellOrder`, which is permissive. Users who change their mind wait for expiry;
`reconcile` then releases the escrow and — for an order no merchant ever accepted — refunds the
daily slot. That path is already implemented and tested. Cost is UX on a mistyped amount, not funds.

### #53.2 — `offrampRelayer`: **removed entirely**

The state variable, the `setOfframpRelayer` setter and the `OfframpRelayerUpdated` event are gone;
`deliverOfframpUpi` is now initiator-only. This was not merely a dormant power: `encUpi` **is** the
fiat payout target, `placeB2BSellOrder` leaves `order.encUpi` empty, and the Diamond's substitution
guard accepts any string into an empty slot — so a set relayer could redirect any seller's payout to
itself, with the order still moving to PAID and every health metric reading clean.

Binding it to a user EIP-712 signature over `keccak256(encUpi)` was considered and **rejected as
illusory**: `encUpi` is encrypted to the _matched merchant_, who is unknown until after the accept,
so the user cannot pre-sign the destination at placement. By the time they can sign it they are
online and can simply deliver it themselves. Since Showdown's client encrypts `encUpi` locally, the
relayer bought no capability the user lacked — only a way to lose money. Removing it also shrinks
the owner's authority: the owner can no longer name who delivers a payout.

### #44 — fee headroom: **widget-side, no contract bound**

No `MAX_SELL_FEE_BPS` was added. The Diamond's fee is charged on top of principal and is unknown
until delivery, so a full-balance SELL can still be undeliverable. This is handled in the product:
the widget quotes the exact net fiat before the user confirms, and **caps the maximum cash-out at
balance − fee headroom** so an undeliverable order cannot be placed through the UI.

Residual, accepted knowingly: a caller that bypasses the widget and hits `userInitiateOfframp`
directly can still strand. Funds are never lost — the USDC stays on the user's own proxy, `reconcile`
releases the escrow and refunds the slot, and `userBridgeBackToSolana` remains open. The contract-side
bound stays available until the deploy transaction and not after.

---

## Deploy gates (correct code, wrong config still bricks or weakens it)

- **D1 — CCTP addresses in the deploy script are TESTNET-ONLY.** `0x8FE6B999…` / `0xE737e5cE…` are
  the V2 addresses shared by every supported EVM _testnet_; Base mainnet's differ. A wrong messenger
  produces burns that can never be minted — the silent, unrecoverable failure mode.

  **Mitigated, but not the way this gate originally described (#54).** The script does the opposite
  of "refuses to run unless the addresses are supplied": verified Base-mainnet CCTP V2 addresses are
  **baked into a preset table** picked by chainId, and a conflicting `TOKEN_MESSENGER` /
  `MESSAGE_TRANSMITTER` / `DIAMOND_ADDRESS` / `USDC_ADDRESS` in the environment is **ignored** on
  mainnet unless `ALLOW_ADDRESS_OVERRIDE=true`. That is deliberate and stronger: `.env` carries
  testnet values and dotenv applies them to every network, so honouring them would point a mainnet
  deploy at the Sepolia Diamond — the exact mistake the table exists to prevent.

  On top of the presets the script hard-fails on mainnet if `burnLimitsPerMessage(USDC) == 0`, if
  the Solana route is missing, if the Diamond holds none of the configured USDC (D2), if
  `EXPECTED_CHAIN_ID` is absent or mismatched (#76), or if either attestor equals the deploy key
  (#69). Note `ALLOW_ADDRESS_OVERRIDE` unlocks the Diamond and USDC presets together with one flag —
  a legitimate Diamond override silently re-opens the USDC one.

- **D2 — `usdc` must be canonical Circle USDC on Base mainnet,** and it must be the token the mainnet
  Diamond actually settles in. This is doubly load-bearing: the `UserProxy` USDC-trap resolves via
  `integrator.usdc()`, _and_ CCTP will only burn Circle-issued USDC. This is exactly the Sepolia
  GoofyGoober problem — on mainnet it must not exist.
- **D3 — `owner` is immutable: deploy FROM the owner key.** No transfer, no renounce, no timelock.
  The script refuses a mainnet deploy whose signer does not match `DEPLOY_OWNER`, **except under
  `DRY_RUN=1`**, which skips the signer-identity assertion so a read-only preflight does not require
  the real owner key in hand (the `DEPLOY_OWNER` presence check still applies). Superseded on one
  point: the owner is a Showdown-held **EOA**, not a multisig — a Safe cannot be a hardhat deploy
  signer and this bytecode has no `_owner` constructor parameter, so a Safe-owned deploy is not
  expressible. Decision recorded 2026-08-13.
- **D4 — Attestors must come from each live service's own `/v1/attestor` endpoint,** never a
  partner- or teammate-relayed value. Both Showdown attestors were wrong once on Sepolia for that
  exact reason. Each service's EIP-712 domain must set `verifyingContract` = the **prod** integrator
  address, or nothing verifies. A wrong attestor fails closed (product broken), not open.
- **D5 — Register with `usdcThroughIntegrator = false`** and `proxyImpl` = this integrator's own
  `new UserProxy()` (set-once, `B2BProxyImplLocked`). Reviewers must confirm off-chain that
  `proxyImpl` bytecode matches canonical `UserProxy` — per `WHITELISTING.md` that is the actual
  security gate.
- **D6 — Basescan verification has never run** (no `BASESCAN_API_KEY`). Required by
  `WHITELISTING.md` step 2 before a formal whitelist request. The deploy script prints the command.
- **D7 — Attestation delivery is still unbuilt, and it is the launch blocker.** CCTP does not
  auto-deliver: a burn only authorizes a mint. Without a service fetching the Iris attestation and
  submitting `receiveMessage` on Solana, an onramp burns on Base and **the user's USDC never
  arrives** — while `unbridgedTotal` reads 0 and the contract looks perfectly healthy. Note this is
  _worse_ than the fail-closed case: there is no on-chain recovery once the burn lands. It stays
  permissionless and therefore recoverable by anyone, forever — but someone has to do it.
- **D9 — Enable the cancel callback after registration.** `setIntegratorCancelCallback(showdown, true)`,
  super-admin, on the Diamond. New since `contracts-v4` #362 (2026-08-05) and **defaults to off**, so
  skipping it silently leaves `dailyTxCountLimit` bounding placements/day rather than orders/day. See
  F9. Do it after `registerIntegrator`, not before — the setter reverts `ZeroAddress` for an
  unregistered integrator.
- **D10 — Read `getIntegratorConfig` with the 5-field ABI.** #362 added `cancelCallbackEnabled` as the
  third field. A stale 4-field ABI does not revert; it reads `proxyImpl` as `address(0)`, which is
  exactly the value D5 depends on. Fixed in `deploy-showdown.ts`; confirm any other tool you register
  with was updated too.
- **D8 — No genuine on-chain attestation has ever happened.** "Wired end-to-end" on Sepolia meant
  CORS/proxy 200s. The first real `submitLivenessAttestation` from a live face capture is the actual
  proof, and it has not been produced.

---

## What is sound (verified — do not re-litigate)

- **Non-upgradeable.** No proxy, no `delegatecall`, no `selfdestruct`; the only `assembly` is the
  standard r/s/v extraction in `_recover` and the `UserProxy` immutable-args reads. Identity
  (`diamond`, `usdc`, `owner`, `proxyImpl`, the CCTP contracts, `solanaDomain`) is `immutable`.
- **Authoritative gate.** `validateOrder` is `onlyDiamond`, and the Diamond **hard-reverts** placement
  on a false gate (`require(allowed)`, not try/catch). The friendly pre-checks in the entrypoints
  cannot be bypassed: `UserProxy.execute` is integrator-only, so the proxy path is the only route and
  `validateOrder` re-enforces on it. The proxy→seller resolution means an offramp SELL is checked
  against the _human's_ tier, not the proxy's.
- **Attestation crypto.** EIP-712 binds `wallet + verifyingContract + chainId` (no cross-wallet,
  cross-contract or cross-chain replay; wallet-binding also blocks a front-run nullifier burn),
  single-use nullifiers namespaced per service, EIP-2 low-`s` + `v ∈ {27,28}` + `signer != 0`, and the
  domain separator is recomputed each call (no fork-cache bug). Fails closed when an attestor is unset.
- **Custody.** Canonical `UserProxy` used verbatim; the seller's offramp funds never transit the
  integrator (`order.user` = their own proxy, so a cancel-while-PAID refunds straight back to it);
  `withdrawUsdc` is hard-bounded by `unbridgedTotal`, so the owner cannot touch in-flight onramps; the
  Solana destination is pinned at order time and cannot be redirected by anyone, owner included —
  which is what makes permissionless `retryBridge` safe.
- **Bridge failure is fail-closed, not fund-loss.** The burn runs through an external self-call under
  try/catch, so a CCTP refusal cannot roll back the hook's bookkeeping; the order stays
  fulfilled-but-unbridged with its USDC reserved, recoverable via permissionless `retryBridge` or the
  buyer's delayed rescue. No dangling messenger allowance after a failed burn (asserted).
- **`receiveFromSolana`** carries and grants no privilege: `receiveMessage` mints to the
  `mintRecipient` encoded in the attested message, never to `msg.sender`. Calling the transmitter
  directly is equivalent.

---

## Test coverage (see the PR for the current count — this section is not re-cut per commit)

Region matrix across all four cells and both directions, resolved inside `validateOrder`; the
immutable ceilings (setter _and_ constructor rejection, per-cell, plus the daily-count and bridge-fee
ceilings, plus the ceiling getters); owner-lowering a cap and it binding; separate per-direction daily
budgets and the 6th-order cutoff in each; block/unblock at both the entrypoint and the authoritative
gate, and the two "a block never traps funds" paths; the delivered-amount re-pin, the
`balanceOf >= unbridgedTotal` invariant after a short delivery, and the wrong-recipient rejection.

**Gaps since closed** (#54, #47, #78): the reentrancy test now exists as `MockReentrantUSDC` (not
`ReentrantTarget.sol`, which was the wrong shape — it could not re-enter mid-burn); signature
malleability is covered by the low-s test; the rescue boundary is exercised at exactly
`completedAt + BRIDGE_RESCUE_DELAY`; and UTC-day-boundary tests now exist for both direction budgets.

**Still open:** cross-`verifyingContract` / `chainId` replay rejection (low risk — the EIP-712 stack
is byte-identical by diff to the reviewed siblings).

---

## Bottom line

The custody model, the bridge failure mode and the non-owner attack surface were already clean and
remain so. What was **not** launch-ready was the limit model: every cap was owner-raisable without
bound (F1), the offramp escaped the daily count entirely (F3), and the completion hook could reserve
USDC that never arrived against a pooled balance (F2). All three are fixed and covered on this branch.

Remaining before mainnet is configuration and one missing service, not code: clear **D1–D6**, and
understand that **D7 (attestation delivery) is a hard launch blocker** — without it every onramp
completes on Base and silently fails to deliver on Solana. F8 (the $200 rescue path) is the one
design decision worth re-confirming at the new numbers.
