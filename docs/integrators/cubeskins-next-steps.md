# CubeSkins — next steps to testnet and production

Status as of **2026-07-20**. This is the working checklist for taking
`CubeSkinsIntegrator` from reviewed code to a live Base mainnet integrator.

Two decisions are already settled and need no further discussion:

- **Liveness-only KYC is approved.** Per-tx cap **200 USDC**, gated on a
  simple-kyc liveness attestation. No passport tier.
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
lower of what your liveness service signed and the on-chain `tierCap[1]`, so a
compromised attestor key still cannot authorize more than 200 USDC.

**On the 200 vs 600 figure:** you asked for 600 USDC/tx; the approved starting
cap is **200**. This is a config value, not a structural one — `setTierCap` is
owner-only and takes effect immediately, with **no redeploy and no
re-whitelisting**. So the cap can be raised once there is settled Sepolia and
early mainnet volume to point at. Nothing about the integration needs to change
when it moves.

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

The original PR documented `usdcThroughIntegrator = true`. **That is wrong for
this contract** and we will register it as `false`.

`userPlaceOrder` already pins `recipientAddr = address(this)`, so the Diamond
delivers completion USDC straight to the integrator; `onOrderComplete` then
forwards it to `treasury`. The recipient pin does the routing — setting the flag
as well would double-route. This matches how `ShowdownCheckoutIntegrator` works.

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

---

## 5. Sequence to live

| # | Step | Owner |
|---|---|---|
| 1 | Review + merge the updated PR | P2P |
| 2 | You send Sepolia `treasury` / `owner` / `attestor` addresses | CubeSkins |
| 3 | Deploy on Base Sepolia + verify on Basescan | P2P |
| 4 | Whitelist on the Sepolia Diamond (`usdcThroughIntegrator = false`) | P2P |
| 5 | Point your backend at the deployed address, `USE_DEMO = false` | CubeSkins |
| 6 | Wire up liveness attestation submission | CubeSkins |
| 7 | **At least one real end-to-end Sepolia order**, incl. `onOrderComplete` | Both |
| 8 | You send mainnet addresses | CubeSkins |
| 9 | Mainnet deploy + verify + whitelist | P2P |
| 10 | Backend switches to mainnet config | CubeSkins |

Step 7 is a hard gate, not a formality — `docs/WHITELISTING.md` requires a
working Sepolia deployment and at least one successful E2E order before mainnet.
Your current Sepolia testing runs against the **demo** integrator, which does not
satisfy this; it must be one real order through `CubeSkinsIntegrator` itself.

---

## 6. E2E checklist for step 7

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
- [ ] Cancellation path: order cancelled → `placed` released → buyer can retry
      the same `marketplaceOrderId`
- [ ] Daily limit: 6th order in a UTC day is rejected (cap is 5)

---

## 7. Reference

| | |
| --- | --- |
| Base Sepolia Diamond | `0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9` |
| Base Sepolia USDC | `0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d` |
| Base mainnet Diamond | provided at step 9 |
| `tierCap[TIER_LIVENESS]` | `200000000` (200 USDC, 6dp) |
| `dailyTxCountLimit` | `5` |
| `usdcThroughIntegrator` | **`false`** |

Integrator contracts are immutable. Changing the tier cap later is a config call
(`setTierCap`, owner-only), but adding a passport tier or changing custody means a
new contract and a fresh whitelist request.
