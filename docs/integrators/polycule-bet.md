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
| `owner` | polycule.bet multisig | Rotates the `registrar`; calls `rescueStrandedUsdc` if a settlement-time `safeTransfer` reverted; blocks/unblocks wallets (`setBlocked`); repoints or switches off the ReputationManager check (`setReputationManager`). Cannot mutate user mappings. |
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

If `safeTransfer` in `onOrderComplete` reverts (e.g. the recipient is on USDC's blacklist or otherwise rejects the transfer), the Diamond's try/catch swallows the revert and finalises protocol state. USDC remains on the integrator contract.

The owner pulls those funds via `rescueStrandedUsdc(to, amount)` and re-routes manually. There is no per-order claimable mapping — the assumption is that USDC blacklist hits are rare enough to handle out-of-band rather than warranting on-chain bookkeeping.

The `NoBridgeRecipient` guard in `onOrderComplete` is defense-in-depth only: `setBridgeRecipient` rejects the zero address and the contract exposes no clearing path, so a mapped user's entry cannot revert to zero. The guard exists to fail loudly if the callback is ever invoked for a user that was never mapped (which `userPlaceOrder` prevents on the happy path).

## Blocking users

The Diamond checks the p2p.me user blacklist on consumer BUY orders but skips it on B2B orders, leaving the check to the integrator's `validateOrder`. This integrator refuses placement for a wallet when either:

- the p2p.me ReputationManager reports `rmusers(user).isBlacklisted` (the same flag that blocks consumer BUY orders, so a p2p.me blacklist or whitelist applies here immediately, with no sync step), or
- the owner has set `blocked[user]` via `setBlocked(user, true)`.

`userPlaceOrder` reverts with `UserIsBlocked()` before touching the Diamond, and `validateOrder` returns `false` so the Diamond rejects the order with `B2BIntegratorRejectedOrder()` on any path that reaches it. `isUserBlocked(user)` exposes the combined answer for off-chain pre-checks.

Only placement is gated. Registration (`setBridgeRecipient`) and settlement (`onOrderComplete`) ignore the blocklist, so a block never strands USDC for an order that was already placed and paid.

The ReputationManager read fails open: if the call reverts or returns an unexpected shape, the wallet is treated as not blacklisted, so an upgrade on the p2p.me side cannot halt every placement here. The owner's `blocked` list keeps working regardless. `setReputationManager(address(0))` switches the ReputationManager check off entirely.

## Limits

This integrator does not enforce its own per-tx / daily / RP limits — `validateOrder` only applies the block check above. The authorization gate is `userPlaceOrder` requiring a non-zero `bridgeRecipientOf` entry. Volume limits, if any, are enforced upstream by the Diamond's protocol-level RP curve and by polycule.bet's off-chain orchestration before the registrar maps the user.

## Widget compatibility

The polycule.bet flow is served by polycule.bet's own checkout UI, not the standard `@p2pdotme/checkout-widget`. The integrator does not emit `CheckoutOrderCreated` — the order ID is returned synchronously from `userPlaceOrder` and re-emitted as `PolyculeOrderPlaced`. Hosts that want to decode it from a receipt can fall back to the Diamond's `B2BOrderPlaced` event (see [`../INTEGRATORS.md`](../INTEGRATORS.md)).

## External dependencies

| Dependency | Base mainnet address |
|---|---|
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| p2p.me ReputationManager | `0xCF613e08EE1B4c2669DdCf06A7d22c9856f6Aa1D` |
| Polymarket bridge address (per user) | derived off-chain at onboarding |

The "Polymarket bridge address" is the Base-side deposit address Polymarket reads to credit the user's Polygon Safe. It is **per user**, not a single global bridge — pinning it on-chain per user is the whole point of `bridgeRecipientOf`.

## Deploy

```bash
DIAMOND_ADDRESS=0x... \
USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
OWNER_ADDRESS=0x... \
REGISTRAR_ADDRESS=0x... \
REPUTATION_MANAGER_ADDRESS=0xCF613e08EE1B4c2669DdCf06A7d22c9856f6Aa1D \
npx hardhat run scripts/deploy-polycule-bet.ts --network base
```

Then verify on Basescan and open a whitelist request per [`../WHITELISTING.md`](../WHITELISTING.md). The Diamond owner must register the integrator with `usdcThroughIntegrator = true` and the pinned `proxyImpl` returned by the constructor.

## Migrating to a new deployment

The contract is immutable, so adding a capability means deploying a new address and moving traffic to it. The Diamond supports this without downtime: several integrators can be active at once, and `deactivateIntegrator` only stops new placements. Existing orders still complete or cancel, because the Diamond's completion and cancel hooks route by the order's recorded integrator and do not check `isActive`.

1. **Deploy** with the same `REGISTRAR_ADDRESS` as the live deployment (read `registrar()` on the old address), so the host's registrar key can write the new mappings.
2. **Register** (Diamond super-admin): `registerIntegrator(new, true, new.proxyImpl())`. Both addresses are now active; users see no change.
3. **Re-map users.** `bridgeRecipientOf` starts empty on the new address. The registrar writes every existing user's mapping on the new contract before any traffic moves, or those users hit `NoBridgeRecipient()`.
4. **Switch the host** (backend relay and frontend together) to the new address. This is the only user-visible step.
5. **Re-map again** to catch users who signed up between steps 3 and 4 (they were only mapped on the old address). `setBridgeRecipient` simply overwrites, so re-running it over every user is safe.
6. **Deactivate the old address** (Diamond super-admin): `deactivateIntegrator(old)`. Before this, confirm `usdc.balanceOf(old) == 0` (otherwise `rescueStrandedUsdc` first). Leave the old contract's registrar and mappings untouched until `getIntegratorConfig(old).activeOrderCount` is 0, because its in-flight orders settle to the old mapping.
7. **Update** [`../INTEGRATORS.md`](../INTEGRATORS.md): old row `Deregistered`, new row `Production`.

Each user gets a fresh `UserProxy` on their first placement through the new address (clones are per integrator: the CREATE2 deployer is the integrator), which costs one extra deployment's gas per user and needs no migration.
