# CashbookRampIntegrator

Fiat in and out for **cashbook.app**, an app that makes someone a p2p.me merchant
without them touching crypto. They pay fiat to open a merchant account, tasks
arrive, and later they withdraw to their bank.

`contracts/integrators/cashbook/CashbookRampIntegrator.sol` · not deployed, not
whitelisted.

## What it does

|          |                                                                                                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deposit  | A B2B **BUY**. The USDC lands on this contract and is staked into the person's **own** merchant account on the Diamond: `registerFor` the first time, `stakeFor` after. |
| Withdraw | A B2B **SELL** with `order.user` = the person, for an account opened here. The Diamond pulls the USDC from the person's **wallet**, not their stake.                    |
| Bonus    | Optional, per currency: a fixed USDC amount set aside when an account opens here, staked into it once the account's volume reaches a set amount.                        |

The merchant account belongs to the person's address, not to a proxy and not to
this contract. Once staked, the money is theirs on the Diamond like any other
merchant's, **including the right to unstake it**: `requestUnstake`, then after
the currency's cooldown (15 days on mainnet) anyone can `approveUnstake` and the
Diamond pays the stake to the person's wallet. Bought USDC is not locked forever;
it is stake for as long as the account is open.

## External dependencies

|                                    | Base mainnet                                 | Base Sepolia  |
| ---------------------------------- | -------------------------------------------- | ------------- |
| p2p.me Diamond                     | `0x4cad6eC90e65baBec9335cAd728DDC610c316368` | `<TBD>`       |
| USDC                               | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | the Diamond's |
| ReputationManager (user blacklist) | `0xCF613e08EE1B4c2669DdCf06A7d22c9856f6Aa1D` | `0x0` (none)  |

⚠ **The Diamond must have `registerFor` and `stakeFor`**: an active B2B integrator
opening or topping up a merchant account for someone else, pulling the stake
from the integrator. They are proposed in contracts-v4 ("feat(onboard): let
anyone register or stake for a merchant") and are **not on the mainnet Diamond
yet**. Until they are, deposits can be placed and delivered but `stakeDeposit`
reverts, and the USDC waits on this contract.

Also read from the Diamond: `getMerchantDetails` (stake, `totalVolume`,
`isRegistered`, currency), `getStakeConfig` (the stake floor),
`getMaxBuyTxLimit`, `getMaxSellTxLimit`, `isBlacklisted`, `getUnstakeRequested`,
`getOrdersById`, `getOrderIntegrator`.

## Lifecycle (the person's view)

1. **Deposit.** `depositFiat(amount, currency, circleId, …)` places a BUY from
   the person's `UserProxy` with `user` = the person and `recipientAddr` = this
   contract. The person pays a merchant in fiat. The first deposit with no
   account binds the person to its currency for good; the account opens in it.
2. **Delivered.** The order completes; the Diamond sends the USDC here and calls
   `onOrderComplete`, which adds it to `pendingStake[person]` and emits
   `DepositDelivered`. If the hook never ran, anyone can call
   `reconcileDelivery(orderId)`.
3. **Staked.** `stakeDeposit(orderId)`, callable by anyone (normally the
   operator's keeper), stakes everything the person has pending into their own
   account. Every argument comes from the order and stored state, so a caller can
   trigger it but not steer it. Opening an account here sets the bonus aside.
4. **Bonus vests.** Once the account's `totalVolume` reaches the vest volume
   set aside with the bonus, anyone calls `vestBonus(person)` and it is staked
   into the account.
5. **Withdraw.** Money reaches the person's wallet only through the Diamond:
   an approved unstake (a full exit; there is no partial unstake) or claimed
   rewards. `withdrawFiat(amount, currency, circleId, …)` then places a SELL,
   and the person's smart account approves USDC to the Diamond and calls
   `setSellOrderUpi`, which pulls it from their wallet.

**Why steps 2 and 3 are separate transactions.** `completeOrder` holds the
Diamond's shared reentrancy lock while it calls the hook, and `registerFor` /
`stakeFor` take the same lock, so staking from inside the hook always reverts.
The mocks have no such lock; the two-transaction path is proven on a fork of a
Diamond that has both functions.

## Custody

USDC held here, and the only ways it leaves:

| Held as                     | Leaves only                                                                  |
| --------------------------- | ---------------------------------------------------------------------------- |
| `pendingStake[person]`      | into the Diamond, as that person's stake                                     |
| a bonus (`vesting[person]`) | into that person's stake (`vestBonus`), or back to the pool (`forfeitBonus`) |
| `bonusPool[currency]`       | into a set-aside bonus, or to the owner (`withdrawBonus`)                    |

**No function sends USDC to a person.** `UserProxy.sweepERC20` refuses the
integrator's USDC as usual, though the proxy never holds any here: deposits pay
this contract, and withdrawals pull from the person's wallet.

**Money that can stay here.** `pendingStake` leaves only as stake, so a stake
the Diamond refuses after delivery leaves it waiting:

| Cause after delivery    | Recovery                           |
| ----------------------- | ---------------------------------- |
| circle paused or full   | the circle reopens, or `setCircle` |
| the floor raised        | the person deposits again          |
| an unstake requested    | the request is cancelled           |
| the account blacklisted | **none: it stays here**            |

## Limits and RP

B2B placement skips the Diamond's RP per-tx limit, daily and monthly counts,
yearly volume and blacklist (`OrderFlowFacet.placeOrderForB2B`), so these are the
only limits on either flow:

- **Per deposit:** at most `getMaxBuyTxLimit(currency)`; 0 closes the currency.
- **Per withdrawal:** at most `getMaxSellTxLimit(currency)`; 0 closes it.
- **Per day:** `MAX_DEPOSITS_PER_DAY` = 5 and `MAX_WITHDRAWALS_PER_DAY` = 5 per
  person, per UTC day. Every placed order counts, cancelled or not.
- **Stake floor:** every deposit reverts `BelowStakeFloor` unless the account's
  stake, plus what is pending, plus the deposit reaches
  `getStakeConfig(currency).minMerchantUSDCStake`. The Diamond's stake enforces
  the same floor on a top-up, so a smaller one would wait here. The bonus never
  counts toward it.
- **Refused before any money moves:** the merchant blacklist (both flows),
  ReputationManager's user blacklist (deposits), a currency other than the
  account's or the first deposit's, a pending unstake, an opening in a currency
  with no circle set, and a withdrawal by an account not opened here.
- **Not enforced here:** no per-person total, and nothing ties an address to a
  person, so the daily counts do not stop someone using many addresses.

## The bonus

- `setBonus(currency, amount, vestVolume)`: the bonus for accounts opened from
  now on and the Diamond `totalVolume` (USDC) it vests at. A bonus already set
  aside keeps its terms.
- The person always pays the full floor. When `stakeDeposit` opens an account
  here, the bonus is set aside from the pool, or none if the pool is short (the
  account still opens).
- `vestBonus(person)`: anyone, once `totalVolume` reaches the vest volume. The
  Diamond's stake rules still apply; a refused vest reverts and keeps the bonus.
- `forfeitBonus(person)`: anyone, once the account has asked to unstake or is
  blacklisted; the bonus goes back to the pool.
- A vested bonus is ordinary stake and leaves with the account on unstake. It
  costs real volume to earn, not nothing.

## Operations

- **Registration:** `usdcThroughIntegrator = false`. `recipientAddr` is always
  this contract, so either value delivers here, but `false` keeps the routing
  explicit. The cancel callback can stay off: `onOrderCancel` does nothing.
- **Owner** (Ownable2Step, a Safe on mainnet; `renounceOwnership` always reverts):
  - `setCircle(currency, circleId)`: the circle new accounts open in. 0 stops new
    accounts in that currency. Deposits are matched in whatever circle the caller
    names; only the account's circle is fixed.
  - `setBonus(currency, amount, vestVolume)` and `withdrawBonus(currency, amount)`
    (pool only).
  - The owner cannot touch `pendingStake`, a set-aside bonus, or any order.
- **Keeper:** watches `DepositDelivered` and calls `stakeDeposit(orderId)`, and
  calls `vestBonus` / `forfeitBonus` when they apply. It needs gas and nothing
  else. All three are permissionless, so the person never depends on it.
- Accounts opened here have an empty `telegramId`.

## Maintainer

`dev@p2p.me`
