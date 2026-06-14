# Merchant Terminal Integrator

`contracts/integrators/merchant-terminal/MerchantTerminalIntegrator.sol`

## What it serves

A point-of-sale terminal for merchants. A customer pays the merchant in fiat
(INR via UPI) through the P2P network; the merchant receives USDC on Base held
under a **30-day settlement lock**, then withdraws either as **INR to their
saved UPI** (a SELL offramp) or as **USDC to their wallet**.

It differs from the existing integrators as follows:

- **ExampleIntegrator** delivers a product (mints an NFT) on completion. The
  merchant terminal instead **custodies** the USDC in per-merchant settlement
  buckets and releases it after a lock period — there is no product delivery.
- **TradeStars / Marketplace** use the system-proxy SELL offramp for a
  Solana/NFT sell-back. The merchant terminal reuses that same offramp pattern
  for the merchant's **INR withdrawal**, including a `reconcileWithdrawal`
  recovery path for cancelled SELL orders.

## Flow

### BUY (customer pays the merchant)

1. Merchant calls `userPlaceOrder(client, productId, quantity, currency, circleId, pubKey)`.
2. The order routes through the merchant's `UserProxy` clone; `recipientAddr` is
   set to that proxy and the integrator is registered with
   `usdcThroughIntegrator = false`, so the Diamond pays USDC to the proxy at
   completion.
3. On `onOrderComplete`, the integrator pulls the USDC off the proxy via
   `transferERC20ToIntegrator` and records a `SettlementBucket
   {amount, unlockTimestamp = now + 30 days}`.

### SELL (merchant withdraws INR)

1. Merchant calls `withdrawINR(amount)` against unlocked buckets.
2. The integrator funds its **system proxy** (`_ensureProxy(address(this))`) and
   places `placeB2BSellOrder` with the merchant's saved `upiId` as `userPubKey`;
   `order.user = system proxy`.
3. If the Diamond cancels the SELL order, `reconcileWithdrawal(orderId)` reads
   the authoritative status from the Diamond, sweeps the refunded USDC back off
   the system proxy (exactly the recorded amount), and re-credits the merchant.

`withdrawUSDC(amount)` sends unlocked USDC straight to the merchant wallet from
the integrator's balance.

## Limits (enforced in `validateOrder`)

| Limit | Value |
| --- | --- |
| Per-transaction cap | 50 USDC |
| Daily transaction count | 4 per merchant per UTC day |
| Settlement period | 30 days |

The system proxy is carved out of `validateOrder` so SELL/withdrawal placements
do not hit merchant buy-side limits. The daily counter resets when the UTC day
(`block.timestamp / 86400`) changes; `onOrderCancel` releases a consumed slot.

## Custody & safety

- USDC custody during the lock sits on the **integrator** (pulled at
  `onOrderComplete`); INR-withdrawal funds transit the **system proxy**.
- All USDC movements use `SafeERC20`. No upgradeability, no `delegatecall`, no
  `selfdestruct`. Uses the canonical `UserProxy` (not forked).
- `validateOrder` / `onOrderComplete` / `onOrderCancel` are `onlyDiamond`;
  freeze/unfreeze are `onlyOwner`.
- Settlement buckets are compacted (spent buckets dropped) and bounded by
  `MAX_BUCKETS` to keep withdrawal gas bounded.
- A `nonReentrant` guard wraps `userPlaceOrder` and all withdrawal/reconcile
  functions.

## Deploy

```bash
DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x... \
  npx hardhat run scripts/deploy-merchant-terminal.ts --network baseSepolia
```

Register with `usdcThroughIntegrator = false`.
