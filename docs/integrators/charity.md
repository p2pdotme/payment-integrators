# Charity integrator

Donation onramp: users pay local fiat (UPI, PIX, …) and the purchased USDC is delivered **directly to a single charity wallet**. The end-user never receives USDC.

Source: `contracts/integrators/charity/CharityCheckoutIntegrator.sol`.

## What it does

Every order is a donation. The user calls `donate(amount, currency, circleId, pubKey, preferredPaymentChannelConfigId, fiatAmountLimit)`, pays fiat off-chain, and on settlement the Diamond transfers the purchased USDC straight to the integrator's current `charityWallet`.

Because the fiat → USDC → user-wallet path is never opened, there is no KYC gate and no per-tx amount cap. The only limit is a per-wallet daily order count (see Limits below).

## Order lifecycle (user's POV)

1. User calls `donate(...)`. The integrator deploys (or reuses) the user's `UserProxy` and places a B2B BUY order with `recipientAddr = charityWallet`. Emits `DonationCreated(orderId, user, amount, currency, charityWallet)`.
2. User pays fiat through the normal P2P channel flow.
3. On completion the Diamond transfers the USDC to the charity wallet (`usdcThroughIntegrator = false`) and calls `onOrderComplete`, which updates `totalDonated` / `donatedBy` bookkeeping and emits `Donated(orderId, user, amount, charityWallet)`.
4. If the order is cancelled instead, `onOrderCancel` releases the user's daily-order slot (keyed to the placement day, so a day rollover can't corrupt another day's counter).

## Custody flow (non-standard)

- **The user never receives USDC.** Each order's `recipientAddr` is pinned to the `charityWallet` at placement time.
- The per-user canonical `UserProxy` is used only as the authenticated _caller_ of `placeB2BOrder` (the B2B gateway is proxy-only). It never holds USDC (`usdcAllowance = 0`).
- `usdc()` is exposed as a public getter because the canonical `UserProxy.sweepERC20` resolves the non-sweepable token via `IUsdcSource(integrator()).usdc()`.
- `charityWallet` is owner-updatable (`setCharityWallet`, emits `CharityWalletUpdated`). Updating it only affects orders placed **after** the change.

## Limits / RP behavior

Overrides the standard: **no per-tx amount cap and no RP adjustment**. Instead each wallet may place at most `MAX_ORDERS_PER_DAY = 1` donation order per UTC day. `validateOrder` reserves the slot authoritatively; `onOrderCancel` releases it, so a cancelled order doesn't burn the day. `getRemainingDailyOrders(user)` exposes the remaining quota.

The widget-optional `userTxLimit()` view is **not** exposed (there is no per-tx cap to preview). Hosts wanting to preview the daily quota should call `getRemainingDailyOrders(address)`.

## Widget compatibility

The integrator emits `DonationCreated` rather than the canonical 5-field `CheckoutOrderCreated`, so the checkout widget derives the order ID via the Diamond's `B2BOrderPlaced` fallback. Hosts that need donation-level metadata should index `DonationCreated` / `Donated` directly.

## External dependencies

None beyond the P2P Diamond and USDC. No third-party protocols.

| Dependency | Base mainnet address                         |
| ---------- | -------------------------------------------- |
| USDC       | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

## Operational notes

- The deployed integrator must be registered on the Diamond with **`usdcThroughIntegrator = false`** so completion transfers USDC straight to the order's `recipientAddr`.
- `owner` (the deployer) is the only address that can rotate `charityWallet`. Rotation is fully on-chain visible via `CharityWalletUpdated`.
- `totalDonated` and `donatedBy(address)` are public accumulators for reporting.

## Deploy

```bash
DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
CHARITY_WALLET=0x... \
npx hardhat run scripts/deploy-charity.ts --network base
```

Then verify on Basescan and open a whitelist request per [`../WHITELISTING.md`](../WHITELISTING.md).
