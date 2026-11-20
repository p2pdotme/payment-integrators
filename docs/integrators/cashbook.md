# CashbookRampIntegrator

Fiat in and out for **cashbook.app**, an app that makes someone a p2p.me merchant
without them touching crypto. They pay fiat to open a merchant account, tasks
arrive, and later they withdraw to their bank.

`contracts/integrators/cashbook/CashbookRampIntegrator.sol` · not deployed, not
whitelisted.

## What it does

| | |
|---|---|
| Deposit | A B2B **BUY**. The USDC lands on this contract and is staked into the person's **own** merchant account on the Diamond: `registerFor` the first time, `stakeFor` after. |
| Withdraw | A B2B **SELL** with `order.user` = the person. The Diamond pulls the USDC from the person's own account; this contract holds nothing on that side. |
| Bonus | Optional, per currency: a fixed USDC amount added to the stake that opens an account, paid from a pool anyone can fund. |

The merchant account belongs to the person's address, not to a proxy and not to
this contract. Once staked, the money is theirs on the Diamond like any other
merchant's.

## External dependencies

| | Base mainnet | Base Sepolia |
|---|---|---|
| p2p.me Diamond | `0x4cad6eC90e65baBec9335cAd728DDC610c316368` | `<TBD>` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | the Diamond's |
| ReputationManager (user blacklist) | `0xCF613e08EE1B4c2669DdCf06A7d22c9856f6Aa1D` | `0x0` (none) |

⚠ **The Diamond must have `registerFor` and `stakeFor`**: an active B2B integrator
opening or topping up a merchant account for someone else, pulling the stake
from the integrator. They are proposed in contracts-v4 ("feat(onboard): let
anyone register or stake for a merchant") and are **not on the mainnet Diamond
yet**. Until they are, deposits can be placed and delivered but `stakeDeposit`
reverts, and the USDC waits on this contract.

Also read from the Diamond: `getMerchantDetails`, `getStakeConfig` (the stake
floor), `getMaxBuyTxLimit`, `isBlacklisted`, `getUnstakeRequested`,
`getOrdersById`, `getOrderIntegrator`.

## Lifecycle (the person's view)

1. **Deposit.** `depositFiat(amount, currency, circleId, …)` places a BUY from
   the person's `UserProxy` with `user` = the person and `recipientAddr` = this
   contract. The person pays a merchant in fiat.
2. **Delivered.** The order completes; the Diamond sends the USDC here and calls
   `onOrderComplete`, which adds it to `pendingStake[person]` and emits
   `DepositDelivered`. If the hook never ran, anyone can call
   `reconcileDelivery(orderId)`.
3. **Staked.** `stakeDeposit(orderId)`, callable by anyone (normally the
   operator's keeper), stakes everything the person has pending into their own
   account. Every argument comes from the order and stored state, so a caller can
   trigger it but not steer it.
4. **Withdraw.** `withdrawFiat(amount, currency, circleId, …)` places a SELL for
   someone with a merchant account, opened here or anywhere else.

**Why steps 2 and 3 are separate transactions.** `completeOrder` holds the
Diamond's shared reentrancy lock while it calls the hook, and `registerFor` /
`stakeFor` take the same lock, so staking from inside the hook always reverts.
The mocks have no such lock; the two-transaction path is proven on a fork of a
Diamond that has both functions.

## Custody

USDC held here, and the only ways it leaves:

| Held as | Leaves only |
|---|---|
| `pendingStake[person]` | into the Diamond, as that person's stake |
| a reserved bonus (`openings[person]`) | into the stake that opens the account, or back to the pool |
| `bonusPool[currency]` | into a reservation, or to the owner (`withdrawBonus`) |

**No function sends USDC to a person.** Bought USDC is for use inside the Diamond
only. `UserProxy.sweepERC20` refuses the integrator's USDC as usual, though the
proxy never holds any here: deposits pay this contract, and withdrawals pull from
the person's merchant account.

## Limits and RP

- **Per deposit:** at most the Diamond's `getMaxBuyTxLimit(currency)`. B2B orders
  skip the Diamond's own per-order limits, so the integrator applies it; a max of
  0 closes the currency.
- **Opening floor:** an opening deposit reverts `BelowStakeFloor` unless what is
  pending, plus the deposit, plus the bonus reaches
  `getStakeConfig(currency).minMerchantUSDCStake`. A top-up has no floor.
- **Refused before any money moves:** the Diamond's merchant blacklist,
  ReputationManager's user blacklist, a different currency from the person's
  account or live opening, a pending unstake, an opening in a currency with no
  circle set. Each is a case where staking would fail after delivery.
- **Not enforced here:** no daily count and no per-person deposit total. The
  operator watches cancelled orders off-chain. No sell-side limit: withdrawing is
  the person's own merchant money, and the Diamond lets a blacklisted wallet sell.

## Operations

- **Registration:** `usdcThroughIntegrator = false`. `recipientAddr` is always
  this contract, so either value delivers here, but `false` keeps the routing
  explicit.
- **Owner** (Ownable2Step, a Safe on mainnet; `renounceOwnership` always reverts):
  - `setCircle(currency, circleId)`: the circle new accounts open in. 0 stops new
    accounts in that currency. Deposits are matched in whatever circle the caller
    names; only the account's circle is fixed.
  - `setBonus(currency, amount)` and `withdrawBonus(currency, amount)`
    (unreserved pool only).
  - The owner cannot touch `pendingStake`, a reservation, or any order.
- **Keeper:** watches `DepositDelivered` and calls `stakeDeposit(orderId)`. It
  needs gas and nothing else. Because the function is permissionless, the person
  never depends on it being up.
- **`releaseBonus(person)`:** anyone; returns a cancelled opening's bonus to its
  pool.

## Maintainer

`dev@p2p.me`
