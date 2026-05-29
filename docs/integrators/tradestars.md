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

- **Owner** can pull up to **40% of principal** plus **100% of accrued yield**, bounded by the actual aUSDC balance.
- **Operator** (the offramp integrator) can pull up to the **vault's full balance** for offramp orders — there is **no cumulative cap**, so offramp volume may exceed onramp when backed by Aave yield or owner-supplied liquidity.

Deposited USDC is supplied to Aave V3 to earn yield. The vault tracks `totalPrincipal` (deposit accounting) and reads `aUsdc.balanceOf` for the current yield-bearing balance.

The owner's 40% is a *cap on cumulative withdrawals*, not a reservation: the operator may legitimately drain the pool, in which case `ownerWithdraw` reverts with `InsufficientFunds` until new principal is deposited via onramp. This is deliberate — the offramp side needs the full pool to service SELL orders, and the owner's 40% governs total exposure rather than instantaneous availability.

Offramp itself has **no cumulative cap** — it is bounded only by the live aUSDC balance, so it can draw Aave yield and any owner-supplied liquidity. This lets **offramp volume exceed onramp** (e.g. when users won more than they onramped). To back that, the owner can inject liquidity via **`fund(amount)`**: it supplies USDC to Aave *without* accruing the P2P onramp fee and *without* increasing `totalPrincipal`, so it surfaces as yield — fully available to the operator for offramps, and any unused portion is recoverable by the owner via `ownerWithdraw` (yield is paid out before principal).

### P2P fee accounting (on-chain ledger, off-chain settlement)

The vault accrues a **P2P fee** on onramp and offramp volume into two separate ledgers, at **independently owner-configurable rates** (`p2pOnrampBps` / `p2pOfframpBps`, both default **2.5%**):

- `deposit` (BUY completion) credits `p2pOnrampAccrued` by `p2pOnrampBps` of the amount.
- `releaseForOfframp` (SELL funding) credits `p2pOfframpAccrued` by `p2pOfframpBps`.
- `returnFromOfframp` (cancelled offramp refund) debits `p2pOfframpAccrued`, so the offramp ledger reflects **net completed volume**.

Each move emits `P2PFeeAccrued(volume, fee, isCredit, isOfframp)`. The owner adjusts rates via `setP2PFeeBps(onrampBps, offrampBps)` (each ≤ `MAX_P2P_BPS` = 100%), which emits `P2PFeeBpsUpdated`. Rate changes apply to volume accrued after the call; an in-flight offramp reverses at the rate in force at refund time, so prefer changing rates during quiet windows (the event stream still records the exact per-move fee).

This is **accounting only**. There is no beneficiary, no `p2pWithdraw`, and no on-chain payout — the vault never moves the fee. The ledgers do **not** reduce the owner's 40% bucket or any other quota; they are independent liability counters. `p2pAccrued()` returns the running total (onramp + offramp). An off-chain billing UI reads the ledgers (and the `P2PFeeAccrued` event stream) to produce a monthly invoice, and the TradeStars owner settles that bill **off-chain**. Note the ledgers are per-vault and reset to 0 on a vault migration (the migrated principal re-accrues on re-deposit), so the biller must treat each vault's counters as cumulative-from-zero.

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
- **Per-call offramp cap**: `maxUsdcPerOfframp` limits one sell order's size independently of the vault's available balance. Defaults to 50 USDC; configurable by owner.

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
vault.setOfframpOperator(integrator);     // grants full-balance offramp access to the integrator
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
