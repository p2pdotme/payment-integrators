# Investabl Challenge

`InvestablChallengeCheckoutIntegrator` lets an [Investabl](https://investabl.ai)
user pay local fiat (INR via UPI) to buy a prop-trading **challenge**.

## Product

The "product" is a prop-firm challenge account (a simulated-balance evaluation).
It is granted **off-chain** in Investabl's backend and is non-transferable — the
user never receives spendable USDC. That makes it the low-fraud goods/service
model, so there is no reputation system and no passport-tier KYC — but every
buyer must still clear a one-time **liveness** check.

## External protocols + addresses

No upstream protocol beyond the P2P Diamond. Investabl's backend consumes the
`ChallengePurchased` event to grant the challenge.

| | Base Mainnet | Base Sepolia |
|---|---|---|
| P2P Diamond | `0x4cad6eC90e65baBec9335cAd728DDC610c316368` | `0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d` |
| Integrator | `<TBD after deploy>` | `<TBD after deploy>` |

## Order lifecycle (user POV)

1. User taps **"Pay with UPI"** in Investabl checkout. Their embedded (Privy)
   wallet calls `buyChallenge(amount, "INR", circleId, pubKey, …, sessionRef)`.
   The call places a B2B BUY order through the user's `UserProxy` with
   `recipientAddr = the integrator`.
2. User pays INR off-chain (UPI) to the matched liquidity provider.
3. On settlement the Diamond delivers the purchased USDC to the integrator and
   calls `onOrderComplete`, which emits `ChallengePurchased(orderId, user,
   amount, sessionRef)`.
4. Investabl's backend watches that event and grants the challenge, mapping
   `sessionRef` back to the checkout session.

> **Backend MUST validate before granting.** The contract only enforces
> `amount ≤ effectiveLimit` and blindly echoes the client-supplied `sessionRef`
> into `ChallengePurchased`; it has no notion of challenge prices. So the backend
> must independently verify: **(a)** `sessionRef` belongs to `user`, and **(b)**
> the delivered `amount` equals the price of the challenge that `sessionRef` maps
> to. Treat `sessionRef` as **single-use** to guard against replay/forged refs.
> Without this, a user could pay for a cheap challenge on-chain while passing the
> `sessionRef` of a more expensive one. (`onOrderComplete` additionally reverts
> `AmountMismatch` if the Diamond ever delivers an amount other than the order's,
> so the emitted `amount` is always the settled amount.)

## Custody / fund flow

Register with **`usdcThroughIntegrator = false`**. `buyChallenge` pins
`recipientAddr = address(this)`, so the recipient pin already routes settlement
USDC to the integrator — setting the flag as well would double-route. Every
integrator in this repo registers `false`; see
[WHITELISTING.md](../WHITELISTING.md). Purchased USDC
accrues on the integrator and leaves **only** via the owner's `sweepUsdc(amount)`
to `treasury` (default: owner). It is then bridged to Investabl's Arbitrum
treasury out of band (CCTP). USDC is never routed to a user EOA.

### Disputes — where the USDC lands
A BUY order can be disputed only once it is CANCELLED and was marked PAID
(`OrderProcessorFacet.raiseDispute`). If a circle admin settles **in the user's
favor** (fault = merchant/bank, not user), `adminSettleDispute` calls the normal
`completeOrder` → `onB2BOrderComplete` — the *same* settlement path as any
completion. With `usdcThroughIntegrator = false` + `recipientAddr = address(this)`
the **USDC lands on the integrator contract**, `onOrderComplete` fires →
`ChallengePurchased` → the backend grants the challenge. So the user who won the
dispute gets their challenge, Investabl receives the USDC, and the user **never**
touches spendable USDC — the goods-model invariant holds through disputes. A
user-fault settlement moves no USDC (the order stays CANCELLED, reputation-only).
Because the live protocol never calls `onOrderCancel`, `session.cancelled` is
never set, so `onOrderComplete` completes this cleanly (and must **not** gain a
`cancelled`-guard, which would suppress the challenge grant the user just won).

## Limits — liveness-gated

Replaces the RP model with a **liveness-tier cap** (see
[LIMITS-AND-RP.md](../LIMITS-AND-RP.md) §"Overriding limits"):

| Tier | Requirement | Per-tx cap |
|---|---|---|
| `TIER_NONE` (0) | none | **0 — cannot buy** |
| `TIER_LIVENESS` (1) | one-time liveness check | `min(attested limit, livenessTierCap)`, deployed at **20 USDC** (the immutable ceiling) |

The effective cap is `min(attested limit, livenessTierCap)`: the simple-kyc service
signs a dollar limit into the attestation and the contract additionally clamps it
to `livenessTierCap`. That cap is owner-tunable but hard-bounded by the immutable
`MAX_LIVENESS_TIER_CAP` (20 USDC), so neither a compromised attestor key nor a
compromised owner can authorize more than the agreed policy. The $15 challenge sits
under the $20 cap.

`dailyTxCountLimit` — max challenge orders per user per UTC day (default 5, the
immutable `MAX_DAILY_TX_COUNT_LIMIT` ceiling), reserved in `validateOrder`.

> **Daily-count semantics on current mainnet.** The slot is *released* in
> `onOrderCancel`, but the live P2P Diamond does **not** call `onOrderCancel`
> (verified on Base mainnet — its selector `0x7ff83a04` is in none of the
> deployed facets; it is wired only in the unmerged
> `feat/integrator-on-order-cancel` protocol branch). So today the count bounds
> **placements per UTC day**: a cancelled or expired order keeps consuming its
> slot until UTC midnight. This is strictly safe (a slot can never be freed
> early, so the cap can't be exceeded) but a user whose orders keep failing can
> be locked out for the day. **Decision before whitelisting:** ship that protocol
> feature (restores per-order release — recommended; the integrator is already
> forward-compat for it) or accept placements/day. This is **systemic** — every
> daily-count integrator (Showdown, CubeSkins, …) is in the same position.

There is **no passport tier**. Adding one later means a new contract and a fresh
whitelist request — integrators are immutable.

### Attestation format

EIP-712, byte-compatible with simple-kyc's `LivenessAttestationVerifier`:

```
domain:   name "LivenessVerifier", version "1", chainId, verifyingContract = integrator
typehash: LivenessAttestation(address wallet,bytes32 nullifier,uint256 limit,uint256 expiry)
sig:      65-byte secp256k1 (r + s + v), low-s only (EIP-2)
```

Register the integrator address as the tenant `contract_address` with the liveness
service. The per-(tenant, human) `nullifier` is single-use on-chain — derive it
from the verified human, not the wallet, or one person can claim from many wallets.

## Operational notes

- Sweep proceeds periodically with `sweepUsdc`; point `treasury` at a Base
  address you control (`setTreasury`).
- `livenessTierCap` / `dailyTxCountLimit` are owner-tunable (`setTierCap`,
  `setDailyTxCountLimit`) but can only be **lowered** — both are hard-bounded by
  the immutable `MAX_LIVENESS_TIER_CAP` (20 USDC) and `MAX_DAILY_TX_COUNT_LIMIT`
  (5) ceilings, fixed in bytecode. Any setter (or constructor arg) that would
  exceed a ceiling reverts `CapExceedsCeiling`, so the owner can never raise a
  limit past what P2P whitelisted. Changing a ceiling needs a new deployment.
- **`livenessAttestor` must be set before anything works.** While it is unset
  every user is `TIER_NONE` with a per-tx limit of 0 and `buyChallenge` reverts
  `AmountExceedsCap`. This is deliberate fail-closed behaviour.
- Gate the checkout UI on `effectiveLimit(user) >= amount` so users see a
  "verify to continue" screen instead of a revert.
- The Diamond callback is best-effort (try/catch). `onOrderComplete` only emits
  the grant event and finalizes bookkeeping — it makes no external calls, so it
  cannot strand a completion.

## Maintainer contact

dev@p2p.me · Investabl: engineering@investabl.ai
