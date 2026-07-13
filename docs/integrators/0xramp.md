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

## Deployments

| Network       | Integrator                                   | Pinned `proxyImpl`                           | P2P.me Diamond                               | USDC                                         |
| ------------- | -------------------------------------------- | -------------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| Base Sepolia  | `0x314017b99E60B1f76Fb743F41a6aA35325066177` | `0x7eC210586BEd117F2C45e182E971750cB3887FA9` | `0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9` | `0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d` |
| Base mainnet  | `0x314017b99E60B1f76Fb743F41a6aA35325066177` | `0x7eC210586BEd117F2C45e182E971750cB3887FA9` | `0x4cad6eC90e65baBec9335cAd728DDC610c316368` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

The Base Sepolia deployment uses chain ID `84532`, owner
`0x4d86534353C5FE30D7bf400560ffFe6e48225cdd`, and disabled app-specific
limits. Its deployment transaction is
[`0x45e1...e57b`](https://sepolia.basescan.org/tx/0x45e1c29f99b0b96a209d4cdf1f308a5370f321cc9d76702cb55ea7794eb9e57b).
The source has an exact creation and runtime bytecode match on
[Sourcify](https://sourcify.dev/server/v2/contract/84532/0x314017b99E60B1f76Fb743F41a6aA35325066177)
and is published on
[Blockscout](https://base-sepolia.blockscout.com/address/0x314017b99E60B1f76Fb743F41a6aA35325066177?tab=contract).

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

For Base Sepolia, register:

```solidity
registerIntegrator(
    0x314017b99E60B1f76Fb743F41a6aA35325066177,
    false,
    0x7eC210586BEd117F2C45e182E971750cB3887FA9
);
```
