# CubeSkins integrator

## Product

Onramp (PIX → USDC) for the [CubeSkins](https://cubeskins.club) CS2 skin marketplace.
Users pay in BRL via PIX; USDC settles on Base to the company treasury; the CubeSkins
backend marks the marketplace order as `paid` after indexing `CheckoutFulfilled`.

## External dependencies

| Network | Diamond | USDC |
|---|---|---|
| Base Sepolia (84532) | `0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9` | `0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d` |
| Base mainnet (8453) | TBD after Sepolia sign-off | Base USDC |

## Order lifecycle

1. User creates a marketplace order on CubeSkins (Steam auth + trade URL).
2. User completes the **liveness check** and submits the attestation on-chain
   (`submitLivenessAttestation`). One-time per wallet.
3. Backend relayer (`onlyOwner`) calls `registerOrder(marketplaceOrderId, buyerWallet, usdcAmount, expiresAt)`.
4. User connects Privy embedded wallet and calls `userPlaceOrder` via the P2P Checkout widget.
5. User pays PIX off-chain; merchant network settles.
6. Diamond calls `onOrderComplete` → USDC transferred to `treasury` → `CheckoutFulfilled` emitted.
7. CubeSkins indexer verifies the event on-chain and sets `marketplace_orders.status = paid`.
8. Ops buys the skin on C5 and sends the Steam trade manually.

## Custody and settlement routing

- Register with **`usdcThroughIntegrator = false`**, matching every other integrator.
- `userPlaceOrder` pins `recipientAddr = address(this)`, so the Diamond delivers
  completion USDC straight to the integrator. This is the same shape
  [Showdown](./showdown.md) uses.
- `onOrderComplete` then `safeTransfer`s the amount to the immutable `treasury`.
- USDC never returns to the user EOA.

> For this contract the flag is in fact behaviourally inert: the gateway sends to
> `recipientAddr` when `false` and to the integrator when `true`, and the recipient
> pin makes those the same address. Earlier drafts of this doc claimed `true` would
> "double-route" — it would not. `false` is still the correct registration.

## Limits — liveness-gated, bounded by immutable ceilings

Per-tx ceilings are gated on a **liveness** attestation, not on RP:

| Tier | Requirement | Per-tx cap |
|---|---|---|
| `TIER_NONE` (0) | none | **0 — cannot transact** |
| `TIER_LIVENESS` (1) | liveness check | `min(attested limit, livenessTierCap)`, deployed at **200 USDC** |

Effective cap is `min(attested limit, livenessTierCap)`: the liveness service signs
a dollar limit into the attestation, and the contract additionally clamps it on-chain.
A compromised attestor key therefore cannot authorize more than 200 USDC per transaction.

Both limits are bounded by **immutable ceilings** committed to the bytecode:

| Constant | Value |
|---|---|
| `MAX_LIVENESS_TIER_CAP` | `200e6` (200 USDC) |
| `MAX_DAILY_TX_COUNT_LIMIT` | `5` |

`setLivenessTierCap` and `setDailyTxCountLimit` revert `CapExceedsCeiling` above
these, and so does the constructor — the owner may tighten policy, never loosen it
past what was reviewed. `dailyTxCountLimit = 0` ("unlimited") is rejected outright.
This matters because a whitelisted integrator **bypasses the protocol's own RP /
daily / monthly / yearly volume limits** and is trusted to enforce its own in
`validateOrder`; without a ceiling, a compromised owner key could re-point the
attestor at itself, self-attest an arbitrary limit, raise the cap and route
unbounded fiat→USDC through P2P's LP network.

`livenessTierCap = 0` is permitted and pauses new orders — a deliberate owner-side
kill switch. The legacy `tierCap(uint8)` view is kept for existing frontends.

Passport-tier KYC is deliberately **not** implemented — CubeSkins' approved policy
is liveness-only. Adding a higher tier later means a new contract and a fresh
whitelist request (integrators are immutable).

Daily count: **5 orders / user / UTC day**, refunded on cancellation so a cancelled
order doesn't burn a slot.

> The refund rides on the `onOrderCancel` hook, which the live Diamond does **not**
> yet call — the call site lands with contracts-v4 `603b16f`. Until that facet
> upgrade is deployed, the daily count effectively counts *placements* and a
> cancelled order's `placed` flag is never released, so its `marketplaceOrderId`
> cannot be retried. Do not deploy to mainnet ahead of that upgrade.

### Recovering stray USDC

Settlement USDC never rests in the contract — `onOrderComplete` forwards it to
`treasury` in the same call. `sweepUsdc(to, amount)` (`onlyOwner`) exists only for
money that arrives outside the order flow, e.g. a mistaken direct transfer. Without
it such funds would be locked forever, since the contract cannot be upgraded.

### Settlement never reverts

Neither protocol callback reverts. The gateway transfers the USDC *before* calling
`onOrderComplete`, wraps the call in `try/catch`, and finalises the order either
way — so a revert cannot undo the transfer, it can only strand the USDC. The hook
therefore forwards first (capped by the balance actually held) and reports
disagreements as `SettlementAnomaly(orderId, reason, expected, actual, forwarded)`:

| Code | Reason |
|---|---|
| 1 | `ANOMALY_UNKNOWN_ORDER` — settled an order with no session here |
| 2 | `ANOMALY_ALREADY_FULFILLED` — settled twice |
| 3 | `ANOMALY_SESSION_CANCELLED` — settled after cancellation |
| 4 | `ANOMALY_AMOUNT_MISMATCH` — gateway amount ≠ amount pinned at placement |
| 5 | `ANOMALY_SHORT_BALANCE` — held less than the gateway said it settled |

`CheckoutFulfilled` carries what actually reached the treasury, not what the gateway
claimed. **Make the indexer idempotent on `p2pOrderId`** — a cancelled-then-replaced
marketplace order can legitimately emit `CheckoutFulfilled` twice for the same
`marketplaceOrderId` under different `p2pOrderId`s.

### Attestation format

EIP-712, byte-compatible with simple-kyc's reference `LivenessAttestationVerifier`:

- typehash `LivenessAttestation(address wallet,bytes32 nullifier,uint256 limit,uint256 expiry)`
- domain name `LivenessVerifier`, version `1`, `chainId`, `verifyingContract` = the integrator
- 65-byte secp256k1 signature (`r ‖ s ‖ v`), low-`s` only (EIP-2)

Register the integrator address as the tenant `contract_address` with the liveness
service so attestations are bound to it. The per-(tenant, human) `nullifier` is
single-use on-chain, which is what stops one human claiming from many wallets.

## Security

- Price and buyer wallet are set only by `registerOrder` (`onlyOwner`).
- `userPlaceOrder` reads `usdcAmount` from registration — not from calldata.
- `onOrderComplete` validates against the **session**, which is immutable once
  written. It deliberately does not re-read the owner-mutable registration: doing
  so would let an admin action make a settled order permanently unfinalisable.
- `registerOrder` / `cancelRegistration` both refuse to touch a registration with
  a live P2P session (`placed`), so an admin cannot desynchronise or double-place
  an in-flight order.
- Backend marks paid only after confirming `CheckoutFulfilled` from the pinned
  integrator address.

## Operational notes

- `owner` is set explicitly in the constructor (not `msg.sender`), so P2P can deploy
  on CubeSkins' behalf while CubeSkins' relayer holds the admin key.
- `livenessAttestor` starts unset if not passed at deploy; **no order can be placed
  until it is set** — an unset attestor leaves every user at `TIER_NONE` (limit 0).
- Backend must call `cancelRegistration` when marketplace orders expire — but only
  before the buyer places, or after the P2P order is cancelled.
- Link Privy wallet to Steam user (EIP-191) before allowing P2P checkout.
- Request subgraph URL from P2P for widget circle routing (`subgraphUrl`).
