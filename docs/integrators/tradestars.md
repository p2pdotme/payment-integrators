# TradeStars integrator

P2P fiat ↔ TradeStars Solana flow. Two directions:

1. **Onramp (BUY)** — user pays local fiat → integrator receives USDC on Base → TradeStars mints / credits the user on Solana. Recipient is a Solana pubkey (`bytes32`), not a Base EOA.
2. **Offramp (SELL)** — user burns TradeStars asset on Solana → relayer relays the burn → integrator pulls USDC from a `RestrictedYieldVault` and routes it to a Base merchant via a SELL order on the Diamond. The merchant pays the user fiat off-chain.

## Architecture

```
        ┌──────────────────────┐
fiat →  │  P2P Diamond (Base)  │  ←─ USDC settlement
        └──────────┬───────────┘
                   │
        ┌──────────┴────────────┐         ┌───────────────────────┐
        │ TradeStarsIntegrator  │◀───────▶│ RestrictedYieldVault  │──▶ Aave V3 (yield)
        └──────────┬────────────┘         └───────────────────────┘
                   │
                   │ Solana pubkey (bytes32)
                   ▼
              TradeStars (Solana)
```

## Order entry points

- `userPlaceOrder(solanaRecipient, amount, currency, circleId, pubKey, ...)` — BUY. Solana recipient is a `bytes32` pubkey instead of a Base EOA.
- `placeSellOrderForBurn(solanaBurnTx, solanaUserPubkey, amount, ...)` — SELL. Relayer-only. Idempotent on `solanaBurnTx` (deduped via `solanaBurnToOrderId` mapping). Pulls USDC from the vault for the offramp side of the trade.

## RestrictedYieldVault

Custodies USDC for the integrator. Two withdrawer roles:

- **Owner** can pull up to **40% of principal** plus **100% of accrued yield**.
- **Operator** (the offramp integrator) can pull from the remaining **60%** for offramp orders.

Deposited USDC is supplied to Aave V3 to earn yield. The vault tracks `totalPrincipal` (deposit accounting) and reads `aUsdc.balanceOf` for the current yield-bearing balance.

This split is the safety mechanism: the offramp can't drain owner reserves, the owner can't grief the offramp pool below 60%. Both roles share the same Aave-backed pool but consume from independent quotas.

## Custody flow

| Step | Custody location |
|---|---|
| User pays fiat off-chain | n/a |
| BUY completes on Diamond | USDC moves to integrator → integrator deposits into vault → vault supplies to Aave |
| User burns on Solana | Solana side; no Base-side state yet |
| Relayer triggers `placeSellOrderForBurn` | Vault.releaseForOfframp(amount) → integrator → SELL placed on Diamond |
| `deliverOfframpUpi` | Diamond pulls USDC from integrator's system proxy → merchant accepts → pays user fiat |
| Cancel-while-PAID | USDC returns from system proxy → integrator → vault.returnFromOfframp(amount) |

## Differences from BUY-only integrators

- **Solana-side identity**: `userPlaceOrder` takes `bytes32 solanaRecipient` instead of using `msg.sender` as the delivery target. Diamond's `placeB2BOrder` still uses `msg.sender` (the proxy) for accounting, but the integrator's `CheckoutFulfilled` event carries the Solana pubkey for the off-chain delivery service.
- **System proxy** for sell orders: Solana users have no Base identity, so the integrator uses a single per-integrator "system proxy" as the on-chain `user` field of SELL orders. See `systemProxy()`.
- **Idempotent burn handling**: `placeSellOrderForBurn` rejects a repeated `solanaBurnTx` with `BurnAlreadyProcessed`. The relayer can safely retry.
- **Per-call offramp cap**: `maxUsdcPerOfframp` limits one sell order's size independently of the vault's 60% quota. Defaults to 50 USDC; configurable by owner.

## External dependencies

- Aave V3 Pool (mainnet) — for yield on vault deposits.
- aUSDC token (Aave's interest-bearing receipt).
- An off-chain Solana ↔ Base relayer service (operated by the integrator owner) that watches Solana burns and triggers `placeSellOrderForBurn`.

On Base Sepolia: Aave V3 isn't deployed, so the deploy script uses `MockAavePool` + a mock aUSDC for testing. Production deploy passes the real Aave V3 Pool + aUSDC addresses via env vars.

## Limits

Standard `baseTxLimit` + per-currency `rpToUsdc` + `maxTxLimit` + `dailyTxCountLimit` (matches `ExampleIntegrator`). The offramp side has an additional `maxUsdcPerOfframp` cap.

## Configuration

Required wiring after deploy:

```solidity
integrator.setYieldVault(vault);          // BUY-completion deposits route here
vault.setOfframpOperator(integrator);     // grants the 60% quota to the integrator
integrator.setOfframpEnabled(true);
integrator.setOfframpRelayer(relayerEoa); // off-chain service address
integrator.setMaxUsdcPerOfframp(USDC(50));
```

Without these, BUY works but USDC accumulates on the integrator (no deposit) and SELL is disabled.

## Deploy

```bash
DIAMOND_ADDRESS=0x... \
USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
AAVE_POOL_ADDRESS=<base Aave V3 Pool> \
AUSDC_ADDRESS=<base aUSDC> \
OFFRAMP_RELAYER=0x<your-relayer> \
npx hardhat run scripts/deploy-tradestars.ts --network base
```

On Sepolia, omit `AAVE_POOL_ADDRESS` + `AUSDC_ADDRESS` to use the mock pool.

Then verify on Basescan and open a whitelist request per [`../WHITELISTING.md`](../WHITELISTING.md).
