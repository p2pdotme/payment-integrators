# PR #39 — CubeSkinsIntegrator — pre-prod security & logic audit

Date: **2026-07-28**. Reviewed at commit `0446808` (branch `feat/cubeskins-liveness`),
fixes applied on `feat/cubeskins-prod-hardening`.

Scope: the full contract, its deploy path, and the off-chain configuration the
contract's behaviour actually depends on. Protocol-side claims were verified
against `contracts-v4` source **and** the live Base Sepolia Diamond rather than
taken from the PR description.

---

## 0. Root cause of the "$20 instead of $200" report

The CubeSkins dev completed liveness verification on Sepolia and still got a $20
per-tx limit. **The contract was correct.** Read from chain on the deployed
integrator `0x9c64B399cA97A87Be2F59dc05Cc5F4ce1C1078B7`:

```
LivenessClaimed   attestedLimit = 20000000    grantedLimit = 20000000
tierCap[1]                      = 200000000   ← the approved 200 USDC
effectiveLimit = min(20e6, 200e6) = 20e6
```

The clamp `min(attested, cap)` behaved as specified; the **liveness service signed
$20**. `$20` is the liveness verifier's house default (`DEFAULT_LIMIT_USDC = 20.0`)
and `limit_usdc` is a per-tenant column that was never raised for CubeSkins.

This is a service-side configuration fix, not a code fix. It is written up in
`docs/integrators/cubeskins-next-steps.md` §4. The trap worth repeating: the signed
limit is read from **`liveness_identities.limit_usdc`**, snapshotted at enrollment,
not from the tenant row — so raising the tenant alone leaves already-enrolled users
at $20. There is no update endpoint on the liveness verifier (`POST /v1/tenants`
plus reads only), so this is a direct DB `UPDATE`.

Separately, the on-chain `livenessAttestor` was deployed as `0x9FEd11b8…` while the
live signer was `0x6cC780…`; CubeSkins rotated it at block 44498316. The deploy
script now fetches the attestor from `GET /v1/attestor` instead of accepting a
relayed value, and warns on any override mismatch.

---

## 1. Verdict against the three standing requirements

| Requirement | Verdict | Note |
|---|---|---|
| **1. Non-upgradeable** | ✅ **PASS** | No proxy, no `delegatecall`, no `selfdestruct`; identity is `immutable`. |
| **2. Limits cannot be *raised*** | ✅ **RESOLVED** (was ❌) | Fixed via immutable ceilings — see F1. Owner may lower, never raise past `MAX_LIVENESS_TIER_CAP` (200 USDC) / `MAX_DAILY_TX_COUNT_LIMIT` (5). |
| **3. No risk to the P2P protocol** | ⚠️ **QUALIFIED** | No path for a non-owner to exceed limits or move funds. With F1 fixed, owner-drivable volume is bounded by construction. Residual risk is the attestor control point and the deploy-gate items in §4. |

---

## 2. Findings

### F1 — HIGH (governance/design): every limit was owner-raisable — RESOLVED

`setTierCap(uint8,uint256)` and `setDailyTxCountLimit(uint256)` had no upper bound,
and `dailyTxCountLimit == 0` meant "unlimited". `owner` is CubeSkins' relayer
(`0x73Fb829f…`), not P2P, and is immutable.

Why this is a *protocol* finding and not partner config: a whitelisted integrator
**bypasses the protocol's own RP / daily / monthly / yearly volume limits** and is
trusted to enforce its own in `validateOrder` (`IB2BGateway` NatSpec). A compromised
or malicious owner key could, in four transactions, `setLivenessAttestor(ownKey)` →
self-attest an arbitrary `grantedLimit` → `setTierCap(1, huge)` →
`setDailyTxCountLimit(0)`, and route unbounded fiat→USDC through P2P's LP network.
That is exactly the un-KYC'd conversion the liveness cap exists to prevent.
"Non-upgradeable" does not imply "limits can't change" — the bytecode is fixed, the
limits lived in owner-writable storage.

**Resolution.** Added immutable `MAX_LIVENESS_TIER_CAP = 200e6` and
`MAX_DAILY_TX_COUNT_LIMIT = 5`, enforced in both setters *and* the constructor
(`CapExceedsCeiling`). `dailyTxCountLimit == 0` is now rejected. The single-tier
`tierCap` mapping was collapsed to `livenessTierCap` (this also removes the
unvalidated tier-index nit); a `tierCap(uint8)` view is retained for existing
frontends. `livenessTierCap = 0` remains legal as a pause switch — it can only ever
*reduce* throughput.

Same remedy as Investabl PR #40 F1 (`4b611e5`) and Showdown PR #35 F1 (`76138d0`).

### F2 — HIGH (liveness/correctness): `onOrderCancel` is dead code, so registrations brick permanently

Verified two independent ways:

- `contracts-v4`'s canonical `IP2PIntegrator` declares only `validateOrder` and
  `onOrderComplete`. `onB2BOrderCancelled` is Diamond-internal bookkeeping
  (`activeOrderCount--`) and never calls the integrator.
- Selector `0x7ff83a04` (`onOrderCancel(uint256)`) is **absent** from all 17 facets
  / 265 selectors on the live Base Sepolia Diamond `0xeb0BB8E3…`.

Consequence on cancel or expiry: `reg.placed` stays `true` forever, and then
`registerOrder`, `cancelRegistration` **and** `userPlaceOrder` all revert
`OrderAlreadyPlaced`. The `marketplaceOrderId` is permanently unusable on-chain.
The PR's own E2E checklist item ("order cancelled → `placed` released → buyer can
retry the same `marketplaceOrderId`") is not satisfiable against the live protocol.

All seven Sepolia test orders are already in this state — they sit at `ACCEPTED`
with no cancellation, and their marketplace IDs (175–178, 185–187) can never be
retried on that deployment.

**Status: mitigated, with a deploy-order gate.** The call site lands with
contracts-v4 `603b16f` (`feat/integrator-on-order-cancel`), which P2P confirms will
merge. That commit wraps the hook in `try/catch`, so our implementation cannot block
cancellation. A dedicated trustless `releaseOrder(orderId)` reading
`getOrdersById(orderId).status` was designed and **not** built, on the basis that the
protocol change makes it redundant — `getOrdersById` is present on the Diamond, so
that option remains open if the upgrade slips.

**Gate: do not deploy CubeSkins to mainnet ahead of that facet upgrade.** Any
cancellation in the interim strands a registration with no recovery path.

### F3 — HIGH (availability): the daily counter never refunds — same root cause

`userDailyCount` is incremented in `validateOrder` and decremented only in the dead
`onOrderCancel`. So `dailyTxCountLimit = 5` counts **placements**, not completions.

This is not a corner case. Investabl's production completion rate is 16.7% (18
orders → 3 completed). At that rate a buyer has a ≈40% chance of burning all five
slots without a single successful purchase — `0.833^5 ≈ 0.40` — and is then locked
out of CubeSkins for the rest of the UTC day. The Sepolia history shows the same
shape: 7 placements, 0 completions.

**Status: mitigated by the same protocol upgrade as F2**, plus a regression test
(`refunds the daily slot so failed matches do not lock the buyer out`) that pins the
refund behaviour so it cannot silently regress.

### F4 — MEDIUM (fund safety): a reverting `onOrderComplete` strands USDC forever — RESOLVED

The gateway transfers settlement USDC to `recipientAddr` (pinned to the integrator)
**before** invoking the callback, wraps the call in `try/catch`, and finalises
protocol state regardless. A revert therefore undoes nothing — it only leaves the
USDC in a contract with no withdrawal path, permanently. The original code reverted
on four branches (`UnknownOrder`, `AmountMismatch`, `OrderAlreadyCancelled`,
`OrderAlreadyFulfilled`), and the failure would have been near-silent: a single
`B2BIntegratorCallbackFailed` event.

**Resolution.** `onOrderComplete` no longer reverts. It forwards
`min(amount, balanceOf(this))` to `treasury` first — the balance cap makes a short or
duplicate delivery impossible to revert on — then performs bookkeeping and emits
`SettlementAnomaly(orderId, reason, expected, actual, forwarded)` for any
disagreement. `CheckoutFulfilled` now carries what actually reached the treasury
rather than what the gateway claimed.

Unlike Showdown (F2 in its audit), CubeSkins does not pool user funds — each
completion forwards immediately — so unconditional forwarding is safe here and no
asymmetric handling is needed.

### F5 — MEDIUM (fund safety): no recovery path for stray USDC — RESOLVED

The contract had no sweep of any kind, so USDC arriving outside the order flow (a
mistaken direct transfer, or any settlement whose callback could not be matched)
was unrecoverable. Investabl and Showdown both carry one.

**Resolution.** Added `sweepUsdc(address to, uint256 amount)` (`onlyOwner`, zero-address
checked, emits `UsdcSwept`). No reserve bound is needed because settlement USDC never
rests in the contract. Signed off explicitly: this grants CubeSkins no reach they lack,
since every legitimate payment already lands in a treasury they control.

### F6 — MEDIUM (accepted): tier grants are permanent and cannot be revoked

`grantedLimit` and `userTier` only ever ratchet upward; `expiry` is a claim-freshness
deadline, not an ongoing clock. There is no revocation, and no `setUserBlocked`.

**Accepted, deliberately.** `registerOrder` is already `onlyOwner`, so no buyer can
transact unless CubeSkins' backend registers their order first — declining to register
*is* the fraud gate. An on-chain block-list would be a second lock on a locked door.
This differs from Showdown, whose users self-serve and which therefore needs one.

### F7 — LOW (accepted): nullifier reuse permanently locks a user out of a new wallet

`livenessNullifierSpent` is permanent and the nullifier is per-(tenant, human). A user
who loses their wallet gets the same nullifier re-issued and can never claim again on
that deployment. This is the intended Sybil resistance; the cost is a permanent
lockout on wallet loss, with no owner override. Accepted as designed — an owner reset
would weaken the Sybil property that is the whole point.

### F8 — LOW (hygiene): the branch commits `node_modules` — RESOLVED

`node_modules` was committed as a **symlink to an absolute path on a specific
developer machine** (`/Users/aashritgarg/Desktop/Work/P2P/payment-integrators/node_modules`),
mode `120000`, despite `.gitignore` listing `node_modules/`. Leftover from a worktree
session. Untracked on the fix branch.

### F9 — INFO (docs): the `usdcThroughIntegrator` rationale was wrong — RESOLVED

The PR and docs claimed registering `true` would "double-route" settlement. It would
not: the gateway sends to `recipientAddr` when `false` and to the integrator when
`true`, and `userPlaceOrder` pins `recipientAddr = address(this)`, making the two
identical for this contract. `false` is still the correct registration (it matches
every other integrator), but the stated reason was incorrect and partners copy these
docs. Corrected in `cubeskins.md`.

### F10 — INFO (accepted): `validateOrder` does not constrain `currency`

A buyer could place against a non-BRL rail. Volume is still dollar-bounded by the
cap, and settlement still reaches the treasury, so there is no loss — only routing to
an unintended merchant pool. Left open deliberately: pinning the currency would need
a policy decision about which rails CubeSkins is allowed to settle on.

---

## 3. What is sound (verified — do not re-litigate)

- **Amount integrity.** `userPlaceOrder` reads the price from the owner registration;
  user input cannot alter it. `BuyerMismatch` binds the placer to the registered buyer.
- **Session immutability.** `onOrderComplete` validates against `sessions[orderId]`,
  written once at placement, never against the owner-mutable registration. This is
  what makes the settled path un-strandable by an admin action, and it is correct.
- **EIP-712 verification.** Typehash, domain (`LivenessVerifier` / `1` / chainId /
  `verifyingContract = this`), low-`s` enforcement (EIP-2), `v ∈ {27,28}`, and the
  `ecrecover == 0` check are all correct and byte-compatible with the service.
  The domain separator is recomputed per call, so there is no cached-chainId bug.
- **Sybil resistance.** The nullifier is spent before any state grant, and is checked
  before signature recovery — no partial-state path.
- **Reentrancy.** `UserProxy.execute` is `nonReentrant` (transient), and the Diamond
  holds the protocol-wide lock across `placeB2BOrder`, so `validateOrder` cannot
  re-enter. `reg.placed` is set *before* the external call. No guard is needed on
  `userPlaceOrder`; the Diamond cannot complete an order in the same transaction it
  is placed.
- **Proxy determinism.** `Clones.cloneDeterministicWithImmutableArgs` with
  `salt = user`, asserted against `predictDeterministicAddressWithImmutableArgs`.
- **Access control.** Every mutating entry point is `onlyOwner` or `onlyDiamond`
  except `userPlaceOrder` and `submitLivenessAttestation`, both of which act only on
  `msg.sender`.

---

## 4. Deploy-gate items (correct code, wrong config still breaks it)

| # | Item | Owner |
|---|---|---|
| **D1** | **No E2E settlement has ever run.** 7 orders placed on Sepolia, **0 completed, 0 cancelled**; `B2BOrderCompleted = 0`, integrator and treasury USDC balances both `0.0`. `onOrderComplete` has never executed on-chain. `docs/WHITELISTING.md` makes this a hard mainnet gate. | Both |
| **D2** | Deploy **after** the contracts-v4 `onOrderCancel` facet upgrade — see F2. | P2P |
| **D3** | Update the liveness tenant: `limit_usdc → 200`, **backfill `liveness_identities.limit_usdc`**, `contract_address` → the new integrator, `chain_id`. No update endpoint exists; direct DB write. | P2P |
| **D4** | `owner` and `treasury` are immutable and cannot be transferred or renounced. Confirm `0x73Fb829f…` is a key CubeSkins controls **in production**, not a dev relayer. | CubeSkins |
| **D5** | Fresh deploy + re-whitelist: the bytecode changed, so the existing `0x9c64B399…` deployment is stale. Register `usdcThroughIntegrator = false`. | P2P |
| **D6** | Basescan verification was never run on the previous deploy (no API key). Do it this time — partners read the verified source. | P2P |

---

## 5. Test coverage

48 CubeSkins cases (was 29), **492 repo-wide, all passing**. Added:

- ceilings: lower-ok, raise-rejected, zero-daily-rejected, constructor-rejected on
  all three, and the end-to-end "compromised attestor self-attests $1m, still capped
  at $200" case
- `sweepUsdc`: recovery, event, non-owner, zero-address
- non-reverting settlement: unknown order, amount mismatch, short balance, double
  settlement (asserting the treasury is not paid twice)
- non-reverting cancel: unknown id, repeat call, cancel-after-settlement, and the
  daily-slot refund

`MockDiamond` gained `adminCallOnOrderCancel`, mirroring the existing
`adminCallOnOrderComplete` — `simulateOrderCancelled` guards on its own order
bookkeeping and reverts before the integrator is reached, so it cannot exercise the
hook's tolerance branches.

---

## 6. Bottom line

The contract's core design is sound: amounts are owner-pinned, the settled path is
validated against immutable session state, and the attestation verification is
correct. The two things that would have hurt in production were **owner-raisable
limits** (a protocol-level risk, now closed by immutable ceilings) and **a settlement
callback that could permanently strand funds by reverting** (now closed by
forward-first + anomaly events).

The order-stranding and daily-lockout findings (F2/F3) are real and currently live,
but their fix belongs to the protocol, not this contract — which makes D2 the
sequencing constraint on shipping.

The `$20` that triggered this review is not a contract defect and will not be fixed
by redeploying. Without D3 the new $200 cap changes nothing observable.
