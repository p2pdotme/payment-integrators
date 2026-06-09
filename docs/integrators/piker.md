# PikerOnrampIntegrator

On-ramp integrator for [Piker](https://piker.io) — a fantasy-sports app on Base.
Lets a user buy USDC with local fiat (**INR via UPI**) through the P2P protocol,
delivered straight to their own wallet to fund contest play. BUY-only.

Maintainer: Piker team. Network: Base mainnet (`usdcThroughIntegrator = false`).

## What it shows

A minimal on-ramp where the end user is a first-class Base EOA and the purchased
USDC lands directly in their wallet:

- One `UserProxy` per user EOA (`salt = user`) is the on-chain actor that places
  the order; the Diamond resolves the integrator from it via CREATE2-auth.
- The BUY is placed with **`recipientAddr = user`** and the integrator is
  registered **`usdcThroughIntegrator = false`**, so on completion the Diamond
  delivers USDC straight to the buyer's wallet. The integrator **never pulls or
  custodies USDC** — the buyer pays fiat off-chain to the assigned merchant.
- Per-tx cap + per-user daily onramp count, enforced at the entry point and
  re-asserted Diamond-side in `validateOrder`.

## Flow

Driven by the `@p2pdotme/widgets` `<Checkout>` host callback:

1. **`userInitiateOnramp(amount, currency, fiatAmountLimit, circleId, ppccId, userPubKey)`**
   — places `placeB2BOrder` through the caller's proxy with
   `recipientAddr = caller`. A BUY pulls no USDC at placement. Returns the
   `orderId`.
2. **`onOrderComplete`** (Diamond → integrator, BUY-only) — the Diamond has
   already delivered USDC to the buyer's wallet; the hook just marks the onramp
   fulfilled (defense-in-depth guards against double/cancelled).
3. **`onOrderCancel`** — releases the daily-count slot reserved at placement
   (keyed on the pinned `placementDay`). Best-effort.

## When to fork this

If your integrator is a **BUY/on-ramp** where the user buys USDC with fiat and
wants it delivered straight to their own Base wallet (no upstream product to
consume the proceeds into), fork this. If instead the proceeds must be consumed
into a deliverable (NFT, ticket, credit), look at `ExampleIntegrator` /
`LotPotCheckoutIntegrator` (which set `recipientAddr = proxy` +
`usdcThroughIntegrator = true`).

## Deploy

```bash
DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
  BASE_TX_LIMIT=2000000000 DAILY_TX_COUNT_LIMIT=10 \
  npx hardhat run scripts/deploy-piker.ts --network base
```

Then verify on Basescan and file a whitelist request with the integrator address
+ pinned `proxyImpl`, registered `usdcThroughIntegrator = false`.
