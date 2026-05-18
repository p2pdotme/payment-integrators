# Limits, RP, and circles

This document covers the **integrator-side** rate limits the reference implementations use. The Diamond enforces its own protocol-level limits independently — these docs describe the integrator layer only.

## Per-transaction USDC limit (RP-based)

`ExampleIntegrator` and `LotPotCheckoutIntegrator` cap the USDC value of any one order based on the user's reputation points (RP):

```
limit = userRP * rpToUsdc[currency]    (if RP > 0)
limit = baseTxLimit                    (if RP == 0)
limit = min(limit, maxTxLimit[currency])
```

- **`baseTxLimit`**: the cap for a brand-new user with zero RP. Default 50 USDC.
- **`rpToUsdc[currency]`**: per-currency conversion rate (different currencies have different fraud profiles).
- **`maxTxLimit[currency]`**: hard cap that even a high-RP user can't exceed without governance.

RP grows as the user completes orders without disputes. The exact growth curve is integrator-private — `ExampleIntegrator` increments RP by 1 per completed order; LotPot uses the same.

## Daily transaction count limit

`dailyTxCountLimit` (default 10) — maximum number of placed orders per user per UTC day. Counted on `validateOrder`, decremented on `onOrderCancel` so a cancelled order doesn't burn a slot.

The "day" rolls at UTC midnight. Storage: `mapping(address user => mapping(uint256 day => uint256 count))`.

## Currency selection

The integrator does not authoritatively map currency → circle. The Diamond does. The integrator receives `currency` in `userPlaceOrder` and forwards it; the Diamond cross-checks `currency` against the `circleId` and reverts with `CurrencyMismatch()` if they disagree.

Practical implication: the caller (your frontend / SDK) must pass a `(currency, circleId)` pair that matches what the Diamond has configured. The `circleId` for each currency is the operational thing you'll need to know — it's listed in the Diamond's documentation for each network.

## Quantity orders

Both reference integrators support `quantity > 1`:

- `userPlaceOrder(client, productId, quantity, ...)` multiplies `unitPrice * quantity` and submits the total to the Diamond.
- `onOrderComplete` delivers `quantity` units to the user on settlement.

The RP-based per-tx limit applies to the *total* (unitPrice × quantity), not per-unit.

## Overriding limits in a custom integrator

Two patterns:

1. **Replace the RP curve entirely**: override `validateOrder` and apply your own logic (e.g. tier-based limits, KYC-bound caps).
2. **Disable RP, rely only on absolute caps**: skip RP tracking and have `validateOrder` enforce a simple `amount <= maxTxLimit[currency]`.

Either is acceptable, but document the choice clearly in your `docs/integrators/<name>.md` so reviewers understand the rate-limit shape.

## Don't bypass `validateOrder`

The Diamond calls `validateOrder` synchronously inside `placeB2BOrder`. If your integrator hooks into the order flow elsewhere (e.g. a custom entry point that doesn't go through `placeB2BOrder`), you are responsible for re-running the same limit checks. The reference integrators have a single entry point for exactly this reason — fewer places to forget a check.
