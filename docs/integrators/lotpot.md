# LotPot integrator

Sells [Megapot](https://megapot.io) lottery tickets through the P2P fiat checkout flow.

## What it does

A user pays local fiat (UPI, PIX, …) for one or more Megapot tickets. The integrator handles the on-chain leg:

- Places a B2B order on the Diamond for `unitPrice * quantity` USDC.
- After fiat settles, calls Megapot's `buyTickets` (or `createBatchOrder` for >10 tickets) to mint NFT tickets **directly to the user EOA**.
- Optionally consumes stranded USDC from a prior skipped fulfillment as a "credit" against new orders.

## Order entry points

Two flavors:

- `userPlaceOrder(quantity, currency, circleId, pubKey, ...)` — auto-random ticket numbers, generated on-chain at fulfillment time. Used by the standard widget.
- `userPlaceOrderWithPicks(tickets[], currency, circleId, pubKey, ...)` — user supplies their picks. Validated against the current drawing's `ballMax` and `bonusballMax`.

## Custody flow

USDC routes through a per-user `UserProxy` clone. The proxy is the on-chain caller of the Diamond and the temporary USDC holder until fulfillment. Both `buyTickets(_, recipient, …)` and `createBatchOrder(recipient, …)` take an explicit recipient parameter, so the proxy never receives NFTs — they go straight to the user EOA.

## Credit redemption

USDC stranded on a user's proxy (from a previously skipped Megapot fulfillment, e.g. due to a transient revert) is treated as a credit balance. Subsequent placements auto-net against it:

- If the new order's total exceeds the credit: Diamond order is placed for the **delta** only.
- If credit covers the total: order skips the Diamond entirely and the integrator buys tickets straight from the proxy's USDC.

Credit can only exit as Megapot tickets — `UserProxy` disables both user-initiated USDC sweep and auto-refund of remainder in `execute`, so any USDC on the proxy must be consumed via this credit-redemption path. That closes a fraud-bypass surface where B2B-mediated fiat-to-USDC conversion would otherwise evade consumer-side fraud checks.

## External dependencies

| Dependency | Base mainnet address |
|---|---|
| Megapot `Jackpot` | `0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2` |
| Megapot `BatchPurchaseFacilitator` | `0x01774B531591b286b9f02C6Bc02ab3fD9526Aa76` |
| Megapot `JackpotTicketNFT` | `0x48FfE35AbB9f4780a4f1775C2Ce1c46185b366e4` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

**Allowlist**: `BatchPurchaseFacilitator.createBatchOrder` is permissioned via an `isAllowed(msg.sender)` allowlist managed by Megapot's owner. The deployed integrator address must be added to this allowlist before any >10-ticket order can fulfill. Coordinate with Megapot before requesting whitelisting on the Diamond.

## Pricing

The integrator does not configure ticket price — it reads from Megapot's active drawing at placement time (`getDrawingState(currentDrawingId())`). Megapot is the single source of truth for price and ball ranges. The integrator's tx-amount validation uses whatever the drawing has *now*; if the drawing rolls between `userPlaceOrder` and `onOrderComplete`, the integrator uses the new drawing's price for fulfillment.

## Limits

Standard `baseTxLimit` + per-currency `rpToUsdc` + `maxTxLimit` + `dailyTxCountLimit`. See [`../LIMITS-AND-RP.md`](../LIMITS-AND-RP.md).

## Deploy

```bash
DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
MEGAPOT_ADDRESS=0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2 \
BATCH_FACILITATOR_ADDRESS=0x01774B531591b286b9f02C6Bc02ab3fD9526Aa76 \
JACKPOT_NFT_ADDRESS=0x48FfE35AbB9f4780a4f1775C2Ce1c46185b366e4 \
SOURCE_TAG=lotpot \
npx hardhat run scripts/deploy-lotpot.ts --network base
```

Then verify on Basescan and open a whitelist request per [`../WHITELISTING.md`](../WHITELISTING.md).

## V2 — Buyer USDC Cashback (2026)

`LotPotCheckoutIntegratorV2` extends V1 with on-chain credit accounting
to support a protocol-side growth campaign: USDC cashback (super-admin tunable, capped at 10%) on every
completed non-B2B P2P BUY order is registered as **credit on the
integrator's ledger** and redeemed for Megapot tickets later. USDC
itself is held in two vaults (Megapot-funded primary, P2P-funded
fallback) and pulled to the user's proxy at ticket-purchase time.

**New surface vs V1:**
- `issueCredit(address user, uint256 amount)` — gated to a whitelisted
  `creditIssuer` (the P2P Diamond on day one). Increments the per-user
  accumulating ledger; no USDC moves until redeemed.
- `setCreditIssuer(address, bool)`, `setVaults(grant, fallback_)` —
  owner-managed configuration.
- `previewAvailableCredit(user) -> (onProxy, issued, grantAvail, fallbackAvail)`
  — frontend helper.
- `GrantVault` (`contracts/base/GrantVault.sol`) — minimal USDC holding
  contract. Owner can `withdraw` anytime; whitelisted spenders (the
  integrator) can call `release(to, amount)`. Same source is deployed
  twice for the campaign — both P2P-owned. The primary "grant" vault is
  funded by Megapot via plain `usdc.transfer`; the fallback is funded by
  P2P treasury.

**Behavior at ticket purchase:** the V2 `_route` first reads the user's
`issuedCredit` ledger, then pulls up to that amount from the grant
vault (fallback if grant is dry) into the user's proxy. Decrement is
exactly the amount actually pulled — partial fulfillment is graceful:
if both vaults are dry, the order proceeds for the full delta and the
credit stays for the next attempt.

**Migration from V1:** V1 stays operational. V2 is a fresh deployment
with new proxy addresses (different CREATE2 deployer → different
addresses). Existing V1-stranded credits remain redeemable via V1's
`_route`. No on-contract migration.

Deploy:

```bash
DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
MEGAPOT_ADDRESS=0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2 \
BATCH_FACILITATOR_ADDRESS=0x01774B531591b286b9f02C6Bc02ab3fD9526Aa76 \
JACKPOT_NFT_ADDRESS=0x48FfE35AbB9f4780a4f1775C2Ce1c46185b366e4 \
SOURCE_TAG=lotpot-v2 \
npx hardhat run scripts/deploy-lotpot-v2.ts --network base
```

Source of truth lives in the contracts themselves
(`contracts/base/GrantVault.sol` and
`contracts/integrators/lotpot/LotPotCheckoutIntegratorV2.sol`).
