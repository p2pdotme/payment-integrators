# CubeSkins — next steps to testnet and production

Status as of **2026-08-03**. This is the working checklist for taking
`CubeSkinsIntegrator` from reviewed code to a live Base mainnet integrator.

Two decisions are already settled and need no further discussion:

- **Liveness-only KYC is approved.** Per-tx cap **200 USDC**, gated on a
  simple-kyc liveness attestation. No passport tier. 200 is now a **hard ceiling
  in the bytecode**, not a config value — see [§7](#7-raising-the-cap-later).
- **Settlement routing is `usdcThroughIntegrator = false`.** See
  [Routing](#3-routing-correction-important) below — this is a correction to the
  original PR.

---

## 1. What changed in the contract

The reviewed version differs from the original PR #28 in three ways.

### Liveness-gated limits replace RP

RP-based limits (`userRP`, `rpToUsdc`, `baseTxLimit`, `setUserRP`,
`batchSetUserRP`) are gone. Limits are now gated on a simple-kyc liveness
attestation:

| Tier | Requirement | Per-tx cap |
|---|---|---|
| `TIER_NONE` (0) | none | **0 — cannot transact** |
| `TIER_LIVENESS` (1) | liveness check | `min(attested limit, 200 USDC)` |

A user with no attestation cannot place any order. The effective cap is the
lower of what your liveness service signed and the on-chain `livenessTierCap`,
so a compromised attestor key still cannot authorize more than 200 USDC.

### Limits are bounded by immutable ceilings

`MAX_LIVENESS_TIER_CAP` (`200e6`) and `MAX_DAILY_TX_COUNT_LIMIT` (`5`) are
committed to the bytecode. `setLivenessTierCap` and `setDailyTxCountLimit`
revert `CapExceedsCeiling` above them, and so does the constructor. The owner
may **tighten** policy at any time, never loosen it past what was reviewed.
`setTierCap(uint8,uint256)` is gone; the read-only `tierCap(uint8)` view is kept
so existing frontends keep working.

This is not distrust of your relayer key — a whitelisted integrator bypasses the
protocol's own RP / daily / monthly / yearly volume limits and self-enforces in
`validateOrder`, so an unbounded setter would be a protocol-level lever rather
than partner config.

### Two stranding bugs fixed

Both allowed an admin action to make a **settled** order permanently
unfinalisable — the Diamond's `onOrderComplete` would revert forever, so a buyer
could pay PIX and the order could never be marked paid.

1. `cancelRegistration` deleted the registration even with a live P2P session.
   `onOrderComplete` then read a zeroed registration and reverted `AmountMismatch`.
2. `registerOrder` only guarded on `fulfilled`, not `placed`. Re-registering
   mid-flight reset `placed = false` — letting the buyer place a **second** P2P
   order against one marketplace order, and desynchronising the live session.

Fixes: `onOrderComplete` now validates against the **session** only (immutable
once written, never re-reads the owner-mutable registration), and both admin
functions refuse to touch a registration with a live session.

### `owner` is now a constructor parameter

Previously `owner = msg.sender`, so whoever deployed held the admin key. It is
now explicit, which lets P2P deploy on your behalf for testnet while **your**
relayer holds the admin key.

---

## 2. What we need from you before we can deploy

We cannot deploy until you send these. Please double-check them — `treasury` and
`owner` are **immutable**, so a mistake means redeploying and re-whitelisting.

| Value | What it is | Notes |
|---|---|---|
| `TREASURY_ADDRESS` | Where settled USDC lands | Immutable. Every BRL payment ends up here. |
| `INTEGRATOR_OWNER` | Your backend relayer address | Immutable. The only key that can call `registerOrder`. Use a key your backend actually controls in production, not a dev wallet. |
| `LIVENESS_ATTESTOR` | secp256k1 signer of your liveness attestations | Settable later via `setLivenessAttestor`, so it can follow. |

Send one set for **Base Sepolia** and one for **Base mainnet** — they should not
be the same keys.

> **Until `livenessAttestor` is set, no order can be placed.** An unset attestor
> leaves every user at `TIER_NONE`, whose per-tx limit is 0. This is intentional
> fail-closed behaviour, but it will look like "everything reverts" if you miss it.

---

## 3. Routing correction (important)

The original PR documented `usdcThroughIntegrator = true`. We will register it as
**`false`**, matching every other integrator.

`userPlaceOrder` already pins `recipientAddr = address(this)`, so the Diamond
delivers completion USDC straight to the integrator; `onOrderComplete` then
forwards it to `treasury`. This matches how `ShowdownCheckoutIntegrator` works.

> An earlier draft of this doc said `true` would "double-route". That was wrong:
> the gateway sends to `recipientAddr` when the flag is `false` and to the
> integrator when it is `true`, and the recipient pin makes those the same
> address — so for this contract the flag is behaviourally inert. `false` is
> still the correct registration, and it is what we will file.

No change needed on your side; just don't be surprised the whitelist entry says
`false` while your notes say `true`.

---

## 4. Liveness attestation — what to build

Register the deployed integrator address as the tenant `contract_address` with
your liveness service, so attestations are bound to it.

Attestation is EIP-712, byte-compatible with simple-kyc's reference
`LivenessAttestationVerifier`:

```
domain:   name "LivenessVerifier", version "1", chainId, verifyingContract = integrator
typehash: LivenessAttestation(address wallet,bytes32 nullifier,uint256 limit,uint256 expiry)
sig:      65-byte secp256k1 (r ‖ s ‖ v), low-s only (EIP-2)
```

Flow to implement:

1. User completes the liveness check in your frontend.
2. Your service signs an attestation for their **wallet address** with
   `limit` (≤ 200e6) and a short `expiry`.
3. Frontend calls `submitLivenessAttestation(nullifier, limit, expiry, signature)`
   from the user's wallet. One-time per wallet.
4. From then on `effectiveLimit(user)` is non-zero and orders can be placed.

The `nullifier` is per-(tenant, human) and **single-use on-chain** — that is what
stops one person claiming from many wallets. Make sure your service derives it
from the verified human, not from the wallet.

Gate your checkout UI on `effectiveLimit(user) >= orderAmount` so users hit a
clear "verify to continue" screen instead of a revert.

### The $20 clamp — a P2P-side change, not yours

During Sepolia testing a verified buyer got a **$20** limit, not $200. The contract
was correct: the on-chain cap read `200000000` and the attestation carried
`attestedLimit = 20000000`, so `min(20, 200) = 20`. **The liveness service signed
$20.**

`$20` is the liveness verifier's house default (`DEFAULT_LIMIT_USDC = 20.0`), and
`limit_usdc` is a per-tenant column. Raising the on-chain cap alone changes nothing.
Four fields on the CubeSkins tenant must be updated, by P2P:

| Field | To | Why |
|---|---|---|
| `tenants.limit_usdc` | `200` | the value signed into new attestations |
| `liveness_identities.limit_usdc` | `200` | **snapshotted at enrollment — existing rows keep 20** |
| `tenants.contract_address` | the new integrator | EIP-712 `verifyingContract`; wrong ⇒ every claim reverts |
| `tenants.chain_id` | `84532`, then `8453` | must match the deploy |

The second row is the one that bites: `issue_attestation` reads the limit from the
per-identity ledger, not the tenant, so anyone already enrolled keeps `$20` even
after the tenant is raised. They would re-test and see no change.

There is **no update endpoint** — the liveness verifier exposes only
`POST /v1/tenants` plus reads. This is a direct DB `UPDATE` on the deployed
Postgres, or someone adds a route first.

Note also that the service models the limit as a *cumulative drawdown*
(`limit − consumed`, via `/v1/limits/debit`) while the contract treats it as a
*per-tx ceiling that only ratchets up*. Once a user has claimed, on-chain
`grantedLimit` never shrinks, so the service-side ledger has no on-chain effect.

---

## 5. Sequence to live

| # | Step | Owner |
|---|---|---|
| 1 | Review + merge the updated PR | P2P |
| 2 | You send Sepolia `treasury` / `owner` / `attestor` addresses | CubeSkins |
| 3 | Deploy on Base Sepolia + verify on Basescan | P2P |
| 4 | Whitelist on the Sepolia Diamond (`usdcThroughIntegrator = false`) | P2P |
| 5 | Update the liveness tenant: `limit_usdc` 200, backfill identities, `contract_address`, `chain_id` ([§4](#4-liveness-attestation--what-to-build)) | P2P |
| 6 | Point your backend at the deployed address, `USE_DEMO = false` | CubeSkins |
| 7 | Wire up liveness attestation submission | CubeSkins |
| 8 | **At least one real end-to-end Sepolia order**, incl. `onOrderComplete` | Both |
| 9 | You send mainnet addresses | CubeSkins |
| 10 | `onOrderCancel` facet upgrade live + opt this integrator in ([§8](#8-cancellation-is-not-wired-yet-protocol-side)) | P2P |
| 11 | Mainnet deploy + verify + whitelist | P2P |
| 12 | Backend switches to mainnet config | CubeSkins |

Step 8 is a hard gate, not a formality — `docs/WHITELISTING.md` requires a
working Sepolia deployment and at least one successful E2E order before mainnet.
Your current Sepolia testing runs against the **demo** integrator, which does not
satisfy this; it must be one real order through `CubeSkinsIntegrator` itself.
**As of today no CubeSkins order has ever reached `onOrderComplete` on-chain**,
so this step is entirely outstanding.

Step 5 is the one that silently bites: without it every attestation carries $20
and the 200 cap is invisible, which is exactly what was reported from the last
round of testing.

---

## 6. E2E checklist for step 8

Confirm all of these on Sepolia before we move to mainnet:

- [ ] `submitLivenessAttestation` succeeds and `effectiveLimit(buyer)` is 200e6
- [ ] `registerOrder` from your relayer succeeds; a non-relayer key is rejected
- [ ] `userPlaceOrder` from a different wallet than the registered buyer reverts
      `BuyerMismatch`
- [ ] An order above `effectiveLimit` is rejected
- [ ] Happy path: register → place → pay PIX → merchant settles →
      `CheckoutFulfilled` emitted → USDC arrives at `treasury`
- [ ] Your indexer sees `CheckoutFulfilled` from the pinned integrator address
      and only then sets `status = paid`
- [ ] Daily limit: 6th order in a UTC day is rejected (cap is 5)
- [ ] Cancellation path — see the caveat below. Until the `onOrderCancel` facet
      upgrade ships **and** this integrator is opted in, a cancelled order does
      **not** release `placed` and does **not** refund the daily slot. Confirm
      your backend issues a **fresh `marketplaceOrderId`** on retry rather than
      re-using the cancelled one.

---

## 7. Raising the cap later

The 200 USDC figure is a **hard ceiling in the deployed bytecode**
(`MAX_LIVENESS_TIER_CAP`), not a config value.

| Change | How |
|---|---|
| Lower the cap (or 0, to pause new orders) | `setLivenessTierCap`, owner-only, immediate. No redeploy. |
| Lower the daily count (1..5) | `setDailyTxCountLimit`, owner-only, immediate. |
| **Raise the cap above 200** | **New contract + fresh whitelist review.** Not a config call. |
| Add a passport tier / change custody | New contract + fresh whitelist review. |

You asked for **600 USDC/tx**; the approved starting figure is **200**. An
earlier draft of this doc said the cap could be raised later with a config call
and no redeploy — that is no longer true, and it is a deliberate change. Moving
past 200 is a policy decision plus a redeploy and re-whitelist, so treat 200 as
the number to plan around for launch. Settled Sepolia and early mainnet volume
is the evidence that would support raising it.

Nothing on your side changes when it moves: the integrator address changes, so
you re-point your backend and we re-register the liveness tenant's
`contract_address`.

---

## 8. Cancellation is not wired yet (protocol-side)

`onOrderCancel` releases the `placed` flag and refunds the daily slot. The live
Diamond does **not** call it — the call site lands with contracts-v4 `603b16f`,
which is still unmerged, and it is now **opt-in per integrator**
(`setIntegratorCancelCallback`, superadmin, default off).

Until that upgrade is deployed *and* CubeSkins is opted in:

- a cancelled order's `marketplaceOrderId` **cannot be retried** — issue a fresh
  one from your backend instead;
- the daily count of 5 counts **placements**, not completions.

Neither loses funds, but both are user-visible, so plan the backend around them.

CubeSkins is safe to opt in once the facet ships: the opt-in is unsafe only for
integrators that latch a `cancelled` flag and then refuse to complete on it
(which broke LotPot, because a CANCELLED BUY is re-opened to PAID on the dispute
path). `onOrderComplete` here records `ANOMALY_SESSION_CANCELLED` and settles
anyway, so a post-cancellation dispute completion still pays out.

**Do not deploy to mainnet ahead of that facet upgrade.**

---

## 9. Reference

| | |
| --- | --- |
| Base Sepolia Diamond | `0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9` |
| Base Sepolia USDC | `0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d` |
| Base mainnet Diamond | provided at step 9 |
| `livenessTierCap` | `200000000` (200 USDC, 6dp) — ceiling `MAX_LIVENESS_TIER_CAP` |
| `dailyTxCountLimit` | `5` — ceiling `MAX_DAILY_TX_COUNT_LIMIT` |
| `usdcThroughIntegrator` | **`false`** |
| Liveness attestor (live signer) | `0x6cC780E44f9Ac850e6D6B8f52A5663286F1A2978` |

Integrator contracts are immutable. Adding a passport tier, changing custody, or
raising the cap past 200 means a new contract and a fresh whitelist request.
