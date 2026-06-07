# PikerOfframpIntegrator

Off-ramp integrator for [Piker](https://piker.io) — a fantasy-sports app on Base.
Lets a user convert USDC they already hold into local fiat (**INR via UPI**)
through the P2P protocol. SELL-only; no BUY/checkout flow.

Maintainer: Piker team. Network: Base mainnet (`usdcThroughIntegrator = false`).

## What it shows

A minimal, **self-funded** off-ramp where the end user is a first-class Base
EOA cashing out their own funds:

- One `UserProxy` per user EOA (`salt = user`). `order.user` is that proxy, so
  the Diamond pulls from — and refunds to — a per-user address.
- The user pays the protocol's small-order SELL fee themselves. The integrator
  fronts **no capital** and exposes **no owner USDC-withdrawal path**; it only
  ever custodies a single order's funds in-flight, which always resolve to the
  merchant (completion) or back to the user (cancellation).
- Per-tx principal cap + per-user daily cash-out count, enforced at the entry
  point and re-asserted Diamond-side in `validateOrder`.

## Flow

Driven by the `@p2pdotme/widgets` `<Cashout>` host callbacks:

1. **`userInitiateOfframp(principal, currency, fiatAmountLimit, circleId, ppccId, userPubKey)`**
   — pulls `principal` USDC from the caller, then routes
   `placeB2BSellOrder` through the caller's proxy (`order.user = proxy`).
   Returns the `orderId`.
2. **`deliverOfframpUpi(orderId, encUpi)`** — once the order is `ACCEPTED`,
   reads the Diamond's authoritative `actualUsdtAmount` (`= principal + fee`),
   pulls the `fee` remainder from the user (allowance from the up-front
   approval), funds the proxy with the exact total, and has the proxy call
   `setSellOrderUpi`. Exact funding ⇒ no residue on the proxy. Order-owner-only;
   replay-guarded.
3. **`reconcile(orderId)`** — permissionless. Reads the authoritative terminal
   status from the Diamond (never a caller argument). On `CANCELLED`, sweeps the
   proxy via `transferERC20ToIntegrator` and refunds everything the user
   deposited; on `COMPLETED`, records the status.

## When to fork this

If your integrator is a **SELL/off-ramp** where the user holds USDC on Base and
cashes out their own funds, and you don't need a yield vault or a relayer-driven
(no-Base-identity) flow — fork this instead of `TradeStarsCheckoutIntegrator`
(vault-backed, Solana-burn-driven).

## When not to fork this

- BUY/checkout flows → `ExampleIntegrator` / `LotPotCheckoutIntegrator`.
- Off-ramp for users with no Base address, or yield-bearing pooled liquidity →
  `TradeStarsCheckoutIntegrator`.

## Deploy

```bash
DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
  BASE_TX_LIMIT=2000000000 DAILY_TX_COUNT_LIMIT=10 \
  npx hardhat run scripts/deploy-piker.ts --network base
```

Then verify on Basescan and file a whitelist request with the integrator
address + pinned `proxyImpl`. No USDC pool top-up is required.
