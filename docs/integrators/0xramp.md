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

## Compliance model

The integrator defines no independent compliance policy. Identity, ZKKYC, and
account limits are P2P.me's: every placement reads the account's native
BUY/SELL transaction limit from the Diamond
(`IP2PUserLimits.userTxLimit(user, currency)`) and fails closed —

- a zero or insufficient native limit reverts the placement
  (`P2PAccountLimitExceeded`) before any order is created;
- an unavailable or reverting limits facet reverts the placement
  (`P2PLimitsUnavailable`) instead of proceeding without a limit check.

Each placement also records a `PendingValidation` binding the account, amount,
currency, and direction (BUY/SELL). The Diamond's `validateOrder` callback
must match that exact tuple (proxies are resolved back to their users) and
consumes it exactly once; a placement whose validation is skipped or
mismatched reverts. App-side limits (below) can only tighten the native
P2P.me limit, never widen it.

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

Set a limit to `0` to disable that 0xramp-specific rule and inherit P2P.me account/KYC/transaction enforcement underneath. For example, `PER_TX_USDC_LIMIT=600000000` adds a 600 USDC app-side per-transaction ceiling. App-side limits are an intersection with the native P2P.me limit: the effective ceiling is always the lower of the two.

## Deployment status

An experimental pre-audit deployment of this exact source (fork commit
`13010d8`) exists on Base Sepolia for P2P.me review and integration testing:

| Contract           | Base Sepolia address                         |
| ------------------ | -------------------------------------------- |
| Integrator         | `0x1e14bbD7B86d5831a21FE46034881aCc199c9331` |
| Pinned `proxyImpl` | `0x273C28A640CA32d84aBBdFC26cfACCed3C3A4B53` |
| P2P.me Diamond     | `0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9` |
| USDC               | `0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d` |

Deployment transaction
[`0x8988...4fcf`](https://sepolia.basescan.org/tx/0x8988ed9d5b3aef2f15155753a5447f280623e839cdfbc79879f4f0c6134a4fcf),
owner `0x4d86534353C5FE30D7bf400560ffFe6e48225cdd`, app-side limits disabled
(`0/0/0`, inheriting P2P.me enforcement only).

The independent audit of this source is still pending; if the audited source
changes, this deployment is superseded by a redeploy of the audited bytecode.
Addresses mentioned in earlier revisions of this proposal contain the bytecode
of a previous contract revision and must not be treated as this contract. The
production whitelist request follows
[`../WHITELISTING.md`](../WHITELISTING.md) and targets the audited deployment.

## Testing

`test/0xramp-integrator.test.ts` covers the BUY/SELL happy paths,
`onOrderComplete`/`onOrderCancel` accounting, per-transaction and daily
limits, access-control negatives, callback replay/reentrancy, and the
fail-closed native-limit and `validateOrder` binding behavior described
above (mocks: `MockDiamond`, `MockValidationDiamond`, `ReentrantRampUser`).

## Deploy

```bash
DEPLOYER_PRIVATE_KEY=0x... \
OWNER_ADDRESS=0x... \
npx hardhat run scripts/deploy-0xramp.ts --network base
```

Default deploy target:

```bash
DIAMOND_ADDRESS=0x4cad6eC90e65baBec9335cAd728DDC610c316368
USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
OWNER_ADDRESS=<durable admin wallet or multisig>
PER_TX_USDC_LIMIT=0
DAILY_TX_COUNT_LIMIT=0
DAILY_USDC_VOLUME_LIMIT=0
```

Test networks (for example Base Sepolia, chain ID `84532`) require
`ALLOW_NON_BASE=1` plus explicit `DIAMOND_ADDRESS`/`USDC_ADDRESS` values; the
script refuses non-Base chains otherwise. `DRY_RUN=1` estimates without
submitting.

After deployment, verify on Basescan:

```bash
npx hardhat verify --network base <integrator> \
  0x4cad6eC90e65baBec9335cAd728DDC610c316368 \
  0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
  <owner-address> \
  0 0 0
```

## Whitelist values

Open a whitelist request per [`../WHITELISTING.md`](../WHITELISTING.md) with:

- `Integrator address`: deployment output
- `Pinned proxyImpl`: deployment output
- `usdcThroughIntegrator`: `false`
- `Expected circleId(s)`: the production Pix circle IDs used by the widget/backend
- `Constructor args`: Diamond, USDC, owner, per-tx limit, daily count limit, daily volume limit
