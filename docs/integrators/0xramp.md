# 0xramp integrator

Routes 0xramp checkout/cashout intents through the P2P.me B2B Diamond on Base.

## What it does

BUY/onramp:

- User completes P2P.me checkout through the widget.
- The integrator places a B2B BUY order through the user's `UserProxy`.
- On off-chain settlement, the Diamond sends USDC directly to the requested Base recipient address, normally the NEAR 1-Click deposit address for that user intent.

SELL/cashout:

- User approves Base USDC to the integrator.
- The integrator moves the principal into the user's `UserProxy` and places a B2B SELL order.
- User submits encrypted Pix/payment details after merchant acceptance.
- The proxy lets the Diamond pull the final USDC amount, and P2P.me handles local fiat payout.

## Custody flow

The integrator is not an escrow. BUY settlement uses `usdcThroughIntegrator=false`, so USDC goes from the Diamond directly to the `recipientAddr` provided in the order. SELL uses the user's per-user `UserProxy` only as the protocol-compatible USDC holder while the B2B sell order is active. Any proxy USDC left after a terminal SELL status is swept back to the user.

## External dependencies

| Dependency     | Base mainnet address                         |
| -------------- | -------------------------------------------- |
| P2P.me Diamond | `0x4cad6eC90e65baBec9335cAd728DDC610c316368` |
| USDC           | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

## Limits

Constructor limits are optional app-side guardrails:

- `perTxUsdcLimit`
- `dailyTxCountLimit`
- `dailyUsdcVolumeLimit`

Set a limit to `0` to disable that 0xramp-specific rule and inherit P2P.me account/KYC/transaction enforcement underneath. For example, `PER_TX_USDC_LIMIT=600000000` adds a 600 USDC app-side per-transaction ceiling.

## Whitelist values

Open a whitelist request per [`../WHITELISTING.md`](../WHITELISTING.md) with:

- `Integrator address`: deployment output
- `Pinned proxyImpl`: deployment output
- `usdcThroughIntegrator`: `false`
- `Expected circleId(s)`: the production Pix circle IDs used by the widget/backend
- `Constructor args`: Diamond, USDC, owner, per-tx limit, daily count limit, daily volume limit
