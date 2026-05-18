# polycule.bet integrator

Fiat on-ramp for [polycule.bet](https://polycule.bet) — converts local fiat (UPI, PIX, SPEI, …) into USDC pinned to the user's Polymarket bridge deposit address on Base. Polymarket's off-chain bridge daemon then mints pUSD into the user's Polymarket Safe on Polygon, where they trade.

## What it does

- Places a B2B BUY order on the Diamond for `amount` USDC.
- After fiat settles, the Diamond transfers USDC to the integrator (registered with `usdcThroughIntegrator = true`).
- `onOrderComplete` forwards that USDC to the user's pre-registered bridge address.
- No client contract, no NFT receipt, no product/quantity model — the deliverable is "USDC at the user's Polymarket bridge address". Delivery into Polymarket happens off-chain via Polymarket's existing bridge.

## Why a pinned mapping instead of a free recipient

The Diamond accepts a `recipientAddr` parameter on `placeB2BOrder`. polycule.bet does not let the user supply this at order time — instead, the integrator stores a per-user `bridgeRecipientOf[user]` mapping and forwards settled USDC to it unconditionally.

Rationale:

- The user's Polymarket bridge address is derived once (during onboarding, after thirdweb JWT auth) and never changes for a given Polymarket Safe. Letting the user pass it on every order is just extra surface to spoof.
- Order placement is gated on the mapping being set, which means a fresh wallet cannot place an order without first passing off-chain auth. This is the integrator's authorization gate.
- The mapping is read at **settlement time**, not snapshotted at placement. See "Trust model" below.

## Trust model

| Role | Holder | Powers |
|---|---|---|
| `owner` | polycule.bet multisig | Rotates the `registrar`; calls `rescueStrandedUsdc` if a settlement-time `safeTransfer` reverted. Cannot mutate user mappings. |
| `registrar` | polycule.bet worker key (HSM/KMS-bound) | Writes `bridgeRecipientOf[user]` after the user passes off-chain auth and the Polymarket bridge address is derived. |
| User | end-user smart account (server-wallet) | Calls `userPlaceOrder` once the registrar has mapped them. |

If the registrar key is compromised: the attacker can re-map any user's bridge recipient. Because the mapping is read at settlement time, an attacker who re-maps a user between `userPlaceOrder` and `onOrderComplete` will divert that in-flight order's USDC to their own address. Mitigation is operational (registrar key is custodial, rotated; suspicious mapping writes are monitored), not on-chain.

## Custody flow

USDC routes:

1. `userPlaceOrder` → per-user `UserProxy` clone → `Diamond.placeB2BOrder` (no USDC moves yet — fiat leg is off-chain).
2. Fiat settles → Diamond transfers USDC **to the integrator** (not to the proxy) because the integrator is registered with `usdcThroughIntegrator = true`.
3. `onOrderComplete` calls `usdc.safeTransfer(bridgeRecipientOf[user], amount)`.
4. Polymarket's off-chain daemon observes the deposit on Base and mints pUSD into the user's Polymarket Safe on Polygon.

The `UserProxy` is used only at placement time, to satisfy the Diamond's CREATE2-auth path. It never holds USDC for this integrator.

## Stranded-USDC recovery

If `safeTransfer` in `onOrderComplete` reverts (e.g. the recipient is on USDC's blacklist, or the registrar cleared the mapping between placement and settlement), the Diamond's try/catch swallows the revert and finalises protocol state. USDC remains on the integrator contract.

The owner pulls those funds via `rescueStrandedUsdc(to, amount)` and re-routes manually. There is no per-order claimable mapping — the assumption is that mapping clears / USDC blacklist hits are rare enough to handle out-of-band rather than warranting on-chain bookkeeping.

## Limits

This integrator does not enforce its own per-tx / daily / RP limits — `validateOrder` returns `true` unconditionally. The authorization gate is `userPlaceOrder` requiring a non-zero `bridgeRecipientOf` entry. Volume limits, if any, are enforced upstream by the Diamond's protocol-level RP curve and by polycule.bet's off-chain orchestration before the registrar maps the user.

## Widget compatibility

The polycule.bet flow is served by polycule.bet's own checkout UI, not the standard `@p2pdotme/checkout-widget`. The integrator does not emit `CheckoutOrderCreated` — the order ID is returned synchronously from `userPlaceOrder` and re-emitted as `PolyculeOrderPlaced`. Hosts that want to decode it from a receipt can fall back to the Diamond's `B2BOrderPlaced` event (see [`../INTEGRATORS.md`](../INTEGRATORS.md)).

## External dependencies

| Dependency | Base mainnet address |
|---|---|
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Polymarket bridge address (per user) | derived off-chain at onboarding |

The "Polymarket bridge address" is the Base-side deposit address Polymarket reads to credit the user's Polygon Safe. It is **per user**, not a single global bridge — pinning it on-chain per user is the whole point of `bridgeRecipientOf`.

## Deploy

```bash
DIAMOND_ADDRESS=0x... \
USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
OWNER_ADDRESS=0x... \
REGISTRAR_ADDRESS=0x... \
SOURCE_TAG=polycule-bet \
npx hardhat run scripts/deploy-polycule-bet.ts --network base
```

Then verify on Basescan and open a whitelist request per [`../WHITELISTING.md`](../WHITELISTING.md). The Diamond owner must register the integrator with `usdcThroughIntegrator = true` and the pinned `proxyImpl` returned by the constructor.
