# TradeStars integrator

P2P fiat ↔ TradeStars Solana flow. Two directions:

1. **Onramp (BUY)** — user pays local fiat → integrator receives USDC on Base → TradeStars mints / credits the user on Solana. Recipient is a Solana pubkey (`bytes32`), not a Base EOA.
2. **Offramp (SELL) — voucher-attested, ONE Base tx (v2)** — user burns the TradeStars asset on Solana → the relayer/attester only **signs an EIP-712 `OfframpVoucher` off-chain** (it sends no transaction). The **user's single Base tx** (`userRedeemAndStartOfframp`) verifies the voucher, pulls USDC from a `RestrictedYieldVault` into the **user's own per-user proxy** (pooled with any prior balance), and places the SELL — atomically. The user then delivers the encrypted payout address and a Base merchant pays them fiat off-chain; retries/partial draws come from the pooled balance with no new voucher. Full spec: [`../OFFRAMP-V2.md`](../OFFRAMP-V2.md). (The legacy relayer-driven model lives in `TradeStarsCheckoutIntegrator.sol`; v2 is `TradeStarsCheckoutIntegratorV2.sol`.)

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

- `userPlaceOrder(solanaRecipient, amount, currency, circleId, pubKey, ...)` — BUY. Solana recipient is a `bytes32` pubkey instead of a Base EOA. (Unchanged from v1.)
- **Offramp v2 (SELL):**
  - `userRedeemAndStartOfframp(voucher, signature, principal, currency, fiatAmount, circleId, cfgId, userPubKey)` — **user-only, the ONE on-chain entry**. Verifies the attester-signed `OfframpVoucher(burnTx, solPubkey, user, amount, deadline)` (sig must recover to `offrampRelayer`; deadline-bounded; deduped on `solanaBurnTx` via `burnToAllocation`; redeemable only by `voucher.user`), releases `voucher.amount` from the vault into the user's per-user proxy (pooled), and places the SELL through that proxy (`order.user = proxy`) — atomic; a placement revert leaves the voucher unredeemed.
  - `userStartOfframp(principal, currency, fiatAmount, circleId, cfgId, userPubKey)` — **user-only**. Retry / subsequent partial draws: any `principal` ≤ the pooled proxy balance, no voucher. Repeatable, one in-flight at a time.
  - `userDeliverOfframpUpi(orderId, encUpi)` — **user-only**. Delivers the encrypted payout address → the Diamond pulls `principal + fee` from the proxy → PAID.
  - `syncOfframp(orderId)` — permissionless. Records the terminal status and frees the in-flight slot.
  - Views: `availableOfframp(user)` (= proxy USDC balance), `getAllocation`, `getUserAllocations`, `proxyAddress`, `hashOfframpVoucher` (EIP-712 digest cross-check for the off-chain signer).

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

> **Offramp v2 caveat.** The user-driven offramp (v2) does **not** call `returnFromOfframp` — a cancelled draw refunds to the user's proxy and is redrawn, never returned to the vault. So under v2 the `offrampWithdrawn` / `p2pOfframpAccrued` ledgers only ever ratchet up (on `releaseForOfframp` inside voucher redemption) and **overstate net offramp volume**. The biller should compute net offramp from **settled SELL orders** (the integrator's `OfframpSettled` events), not from these vault ledgers.

## Custody flow

| Step | Custody location |
|---|---|
| User pays fiat off-chain | n/a |
| BUY completes on Diamond | USDC moves to integrator → integrator deposits into vault → vault supplies to Aave |
| User burns on Solana | Solana side; no Base-side state yet. Attester signs the `OfframpVoucher` **off-chain** |
| User calls `userRedeemAndStartOfframp(voucher, sig, principal)` | ONE tx: `vault.releaseForOfframp(voucher.amount)` → integrator → USDC pooled into the **user's per-user proxy** AND the SELL placed through that proxy (`order.user = proxy`); no USDC pulled yet |
| (retry / next part) `userStartOfframp(principal)` | SELL placed from the pooled proxy balance — no voucher; no USDC pulled yet |
| User calls `userDeliverOfframpUpi` | merchant accepts → Diamond pulls `principal + fee` from the user's proxy → PAID → merchant pays user fiat |
| Cancel / expiry | a PLACED/ACCEPTED draw is fund-neutral (nothing pulled); a PAID draw refunds `principal+fee` back to the **user's proxy**. Either way funds stay in the proxy and the user redraws. Expired orders are swept to CANCELLED by the permissionless `autoCancelExpiredOrders` keeper. |

## Differences from BUY-only integrators

- **Solana-side identity (BUY)**: `userPlaceOrder` takes `bytes32 solanaRecipient` instead of using `msg.sender` as the delivery target; the integrator's `CheckoutFulfilled` event carries the Solana pubkey for the off-chain delivery service.
- **Per-user proxy for SELL (v2)**: offramp v2 assumes the user has a Base wallet (same EOA as onramp). The SELL is placed through the user's **own per-user proxy** (`order.user = proxy`), so the offramp is attributed to the user in P2P history — *not* a shared system proxy. (The legacy v1 `TradeStarsCheckoutIntegrator` used a per-integrator system proxy + relayer-driven SELL.)
- **Single-use vouchers**: redemption rejects a repeated `solanaBurnTx` with `BurnAlreadyProcessed`, an expired voucher with `VoucherExpired` (the attester just re-signs), a non-attester signature with `InvalidVoucherSignature`, and a caller other than `voucher.user` with `OnlyVoucherUser`. The attester key (`offrampRelayer`) signs off-chain only — it has no on-chain write.
- **Pooled, partial draws + fee-from-balance**: redeemed vouchers pool into the proxy; the user draws any amount up to the pooled balance, in parts. The small-order fee is funded from the proxy balance (never subsidised) — both draw paths revert `OfframpInsufficientBalance` unless the proxy holds `principal + fee`.
- **Per-voucher cap**: `maxUsdcPerOfframp` bounds a single **voucher** (not a single draw — pooled draws can exceed it). Defaults to 50 USDC; owner-configurable.

## External dependencies

- Aave V3 Pool (mainnet) — for yield on vault deposits.
- aUSDC token (Aave's interest-bearing receipt).
- An off-chain attester service (operated by the integrator owner; the `tradestars-relayer` repo) that watches Solana burns and **signs `OfframpVoucher`s** — it holds the `offrampRelayer` key but sends no Base transactions.
- The permissionless `autoCancelExpiredOrders` keeper (e.g. `p2pdotme/executor`) that sweeps expired SELL orders to CANCELLED so users can redraw a stuck draw.

On Base Sepolia: Aave V3 isn't deployed, so the deploy script uses `MockAavePool` + a mock aUSDC for testing. Production deploy passes the real Aave V3 Pool + aUSDC addresses via env vars.

## Limits

Standard `baseTxLimit` + per-currency `rpToUsdc` + `maxTxLimit` + `dailyTxCountLimit` (matches `ExampleIntegrator`). The offramp side has an additional `maxUsdcPerOfframp` cap.

## Configuration

Required wiring after deploy:

```solidity
integrator.setYieldVault(vault);          // BUY-completion deposits route here
vault.setOfframpOperator(integrator);     // grants full-balance offramp access to the integrator
integrator.setOfframpEnabled(true);
integrator.setOfframpRelayer(attesterEoa); // voucher-signing key (signs off-chain only)
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
npx hardhat run scripts/deploy-tradestars-v2.ts --network base
```

On Sepolia, omit `AAVE_POOL_ADDRESS` + `AUSDC_ADDRESS` to use the mock pool.

Then verify on Basescan and open a whitelist request per [`../WHITELISTING.md`](../WHITELISTING.md).
