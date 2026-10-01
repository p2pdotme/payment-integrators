# LazoCheckoutIntegrator

Payment links for Latin America. A vendor creates a link for an amount in USDC; the
buyer opens it and pays in local fiat through P2P (Pix, bank transfer to an alias,
Yape / Plin, …); the vendor receives that USDC minus Lazo's fee, with no merchant bank
account. Proposal: [#109](https://github.com/p2pdotme/payment-integrators/issues/109).

**Status: deployed on Base Sepolia against the P2P Diamond, from `c47a088`; awaiting
registration. Not on mainnet yet.**

| | Base mainnet | Base Sepolia |
|---|---|---|
| integrator | `<TBD>` | [`0xd9d3615175EB6eA4002F3CaD584c06801f532e87`](https://sepolia.basescan.org/address/0xd9d3615175EB6eA4002F3CaD584c06801f532e87#code) |
| proxyImpl | `<TBD>` | `0x7d2310c71630499DF6063C110D262706ca3713Aa` |
| owner | a Safe | an EOA |
| fee wallet | a Safe | an EOA |

`contracts/integrators/lazo/LazoCheckoutIntegrator.sol` and
`contracts/integrators/lazo/VendorEscrow.sol`

## What makes it different

**One escrow per vendor.** Each vendor gets its own `VendorEscrow`, an EIP-1167 clone
with immutable args `[vendor][integrator][usdc]`. Orders are placed with
`recipientAddr` = that vendor's escrow, so the Diamond pays it directly and no balance
ever holds two vendors' money. The integrator itself never holds USDC.

**The escrow has one exit.** `release(orderIds)` is permissionless and pays `net` to
the clone's `vendor()` and the fee to the integrator's current fee wallet. There is no
owner, sweep, refund, `delegatecall` or upgrade on the escrow: nobody, including the
integrator's owner, can send a vendor's money anywhere but to that vendor.

**No refunds, no hold.** Disputes between buyer and vendor are theirs. A refund to the
payer would also hand the money back to the most common fraudster. What the contract
offers instead is a configurable retention (below) and fraud controls at the entrance.

## Registration: `usdcThroughIntegrator` MUST be false

With `false`, the Diamond pays `recipientAddr` — the vendor's escrow — on completion,
and `onOrderComplete` only writes the order's record there. With `true`, the USDC would
land on the integrator, which has no path to move it: the escrow's `recordCompletion`
then reverts `Unfunded` (the escrow does not hold the money) inside the Diamond's
try/catch, and the funds sit on the integrator unrecorded. A test covers this
("misconfigured Diamond").

**`cancelCallbackEnabled` should be true.** `onOrderCancel` frees the buyer's daily
slot and the vendor's daily volume. It is not what keeps this safe:
`reconcileCancellation(orderId)` frees the same limits from the Diamond's own order
state if the callback never arrives.

## Order lifecycle

From the buyer's side, on Lazo's pay page:

1. The buyer opens the link and picks a currency. The pay page quotes the fiat amount.
2. `userPlaceOrder(vendor, amount, currency, circleId, pubKey,
   preferredPaymentChannelConfigId, fiatAmountLimit)` from the buyer's own wallet
   (an embedded wallet, gas sponsored). The integrator checks the entrance, deploys
   the vendor's escrow if missing and the buyer's `UserProxy`, and places a B2B BUY
   through the proxy. `fiatAmountLimit` is the exact quote the buyer saw.
3. `validateOrder`: per-tx cap and the buyer's daily count.
4. An LP accepts; the buyer pays the fiat and calls `paidBuyOrder` on the Diamond.
5. The LP completes; the Diamond pays the escrow and calls `onOrderComplete`, which
   records `{gross, unlockAt, feeBps, feeFixed}` on the escrow. No token moves.
6. After `unlockAt`, Lazo's keeper calls `release`. The vendor, or anyone, can too.

## Fee

`fee = feeFixed + gross × feeBps / 10 000`, capped at `gross`; `net = gross − fee`. One
division per order and the net by subtraction, so `fee + net == gross` exactly and no
dust is left. The vendor pays it: the order is for the link amount.

| | Default | Immutable range | Setter (owner) |
|---|---|---|---|
| `feeFixed` | 0.1 USDC | 0.1 – 2 USDC | `setFeeFixed` |
| `feeBps` | 4.5% | 1% – 5% | `setFeeBps`, and `setVendorFeeBps` per vendor |

Hard caps in code: 20% and 5 USDC. Each record snapshots the fee in force at
completion, so a change is never retroactive. `userPlaceOrder` reverts
`AmountBelowFee` when the order would leave the vendor nothing.

## Retention

`unlockAt = completion + retentionOf(vendor)`: a global default plus a per-vendor
override, both capped at 30 days (`MAX_RETENTION`). It starts at 0. Each record keeps
its own `unlockAt`. Retention cannot claw anything back — nobody can stop or redirect
recorded money — it only buys off-chain reaction time to block a vendor.

## Limits and fraud controls

This integrator does not use RP. Every lever acts on new orders only, never on funds
already recorded:

| Lever | Where | Who |
|---|---|---|
| Pause new orders | `userPlaceOrder` | operator or owner pause; only the owner unpauses |
| Block a vendor | `userPlaceOrder` | operator or owner block; only the owner unblocks |
| USDC blacklist of the vendor and its escrow | `userPlaceOrder`, via `isBlacklisted` (skipped if the token has none) | automatic |
| Per-tx cap | `validateOrder` | owner, under `MAX_PER_TX_LIMIT` |
| Orders per buyer per UTC day | `validateOrder` | owner, under `MAX_DAILY_TX_COUNT_LIMIT` |
| Volume per vendor per UTC day | `userPlaceOrder` (`validateOrder` never sees the vendor) | owner, under `MAX_VENDOR_DAILY_VOLUME_LIMIT` |

The pause never stops `release`, the reconciliations, the callbacks or
`registerVendor`.

## Roles and keys

| Role | Can | Cannot |
|---|---|---|
| `owner` (a Safe, passed to the constructor) | config within the bounds, unpause, unblock, set the operator, propose the fee wallet | move vendor money, exceed a bound, renounce |
| `operator` (hot backend key) | pause new orders, block vendors | undo either, change config |
| fee wallet | accept a proposal to become the fee wallet (two steps) | — |
| anyone | `registerVendor`, `release`, `reconcileCompletion`, `reconcileCancellation` | choose where money goes |

Ownership is `Ownable2Step` with a 7-day expiry on the pending proposal;
`renounceOwnership` always reverts. A compromised backend (operator, keeper key) can
only pause and block — reversible by the Safe — and never reach funds.

## Recovery

- **Swallowed completion callback.** The USDC is on the escrow with no record.
  `reconcileCompletion(orderId)` (permissionless) reads the order from
  `getOrdersById` (BUY, COMPLETED, `recipientAddr` = the vendor's escrow) and writes
  the record; the escrow still refuses if its balance does not cover it.
- **Missing cancel callback.** `reconcileCancellation(orderId)` frees the limits once
  the Diamond reports CANCELLED, and checks the order's `user` against the recorded
  buyer. A cancelled order later reopened through a dispute and completed is recorded
  normally.

The escrow is deployed at sign-up or before the first order is placed, never inside
the callback, so `onOrderComplete` never calls an address without code. The callback's
execution is about 72k gas, measured on a local fork of Base Sepolia against the real
Diamond (`0xeb0B…beb9`). That Diamond forwards all remaining gas to `onOrderComplete`, with
no cap, and caps `onOrderCancel` at 250k (ours uses about 21k). The mainnet Diamond runs a
different build and has not been measured yet.

## Operations

- **Keeper.** Runs in Lazo's backend: indexes `OrderPlaced` / `OrderCompleted` /
  `OrderCancelled`, releases unlocked orders once a day (one `release` per escrow) and
  reconciles orders the callbacks missed. It holds no power over funds; if it stops,
  vendors or anyone can release.
- **Vendor sign-up** calls `registerVendor(vendor)`, so the first order does not pay
  for the escrow deploy.
- **Frontend.** Lazo's own pay page; the buyer signs `userPlaceOrder` and
  `paidBuyOrder` from an embedded wallet.

## External contracts

| | Base mainnet | Base Sepolia |
|---|---|---|
| P2P Diamond | `0x4cad6eC90e65baBec9335cAd728DDC610c316368` | `0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d` (GoofyGoober mock, 6 decimals) |

No other protocol is called. The Sepolia mock has no `isBlacklisted`; the integrator
treats a token without it as having no blacklist, and blocks only on an explicit `true`.

## Deploying

```bash
DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x... OWNER=0x... FEE_WALLET=0x... OPERATOR=0x... \
  npx hardhat run scripts/deploy-lazo.ts --network baseSepolia
```

Every other value has a testnet default, listed at the top of the script; on Base
mainnet the script refuses to run unless all of them are set explicitly. It prints the
Basescan verification command and the registration values.

## Tests

`test/lazo-integrator.test.ts`, against `MockDiamond` and a blacklistable mock USDC (plus
a plain one for tokens without a blacklist):
placement, completion, cancellation and its reconciliation, the fee and its snapshot,
retention, release batching and races, per-vendor segregation, the fee wallet handoff,
entrance controls, roles, ownership handoff, and reentrancy on `release`.

## Maintainers

- gbschell@proton.me
- anglabruna@proton.me
