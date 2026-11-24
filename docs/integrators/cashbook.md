# CashbookRampIntegrator

Fiat in and out for **cashbook.app**, an app that makes someone a p2p.me merchant
without them touching crypto. They pay fiat to open a merchant account, tasks
arrive, and later they withdraw to their bank.

`contracts/integrators/cashbook/CashbookRampIntegrator.sol` · not deployed, not
whitelisted.

## What it does

|          |                                                                                                                                                                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deposit  | A B2B **BUY**. The USDC lands on this contract and is staked into the person's **own** merchant account on the Diamond: `registerFor` the first time, `stakeFor` after.                                                                         |
| Withdraw | A B2B **SELL** with `order.user` = the person, for any merchant account, opened here or not, in that account's currency, within the per-order and daily limits below. The Diamond pulls the USDC from the person's **wallet**, not their stake. |
| Rewards  | cashbook's own USDC, sent to this contract by a plain transfer, staked by the owner in batches into any merchant account, from the free balance only.                                                                                           |

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

⚠ **The Diamond must have contracts-v4 #518**: `registerFor(…, signature)`
opens a merchant account for anyone who brings that merchant's EIP-712
signature (any caller), `stakeFor` tops one up (active B2B integrators only),
and `registrationDigest` gives the digest to sign. Both pull the stake from the
caller. They are **not on the mainnet Diamond yet**. Until they are, a first
deposit reverts at `registrationDigest`, and a top-up can be placed and
delivered but `stakeDeposit` reverts and the USDC waits on this contract.

Also read from the Diamond: `getMerchantDetails` (stake, `isRegistered`,
currency), `getStakeConfig` (the stake floor),
`getMaxBuyTxLimit`, `getMaxSellTxLimit`, `isBlacklisted`, `getUnstakeRequested`,
`getOrdersById`, `getOrderIntegrator`, `registrationDigest`.

## Lifecycle (the person's view)

1. **Deposit.** `depositFiat(amount, currency, circleId, …)` places a BUY from
   the person's `UserProxy` with `user` = the person and `recipientAddr` = this
   contract. The person pays a merchant in fiat. For someone with no account
   the latest deposit picks the currency the account opens in, in that
   currency's circle (`circleOf`), and it must carry their **consent**: their
   signature over `diamond.registrationDigest(person, circleOf[currency],
currency, "")`, checked before any order is placed (`ConsentInvalid`).
   A smart account sends its inner ERC-1271 signature, never an ERC-6492
   wrapper (the Diamond does not unwrap one). The consent is kept with its
   circle (`consentOf`, `consentCircleOf`), so a later `setCircle` cannot void
   it. An existing account sends `0x`.
2. **Delivered.** The order completes; the Diamond sends the USDC here and calls
   `onOrderComplete`, which adds it to `pendingStake[person]` and emits
   `DepositDelivered`. If the hook never ran, anyone can call
   `reconcileDelivery(orderId)`.
3. **Staked.** `stakeDeposit(orderId)`, callable by anyone (normally the
   operator's keeper), stakes everything the person has pending into their own
   account: `registerFor` with the stored consent the first time, `stakeFor`
   in the account's own currency after that, then clears the stored consent.
   Every argument comes from the order and stored state, so a caller can
   trigger it but not steer it. A consent is public once sent, so someone may
   open the account with it first; the pending USDC then stakes as a top-up.
4. **Rewarded (optional).** cashbook's backend decides who earns a reward and
   when; the owner calls `rewardStake(people, amounts)`, which stakes each
   amount of free USDC into that person's account. It is ordinary stake from
   then on.
5. **Withdraw.** Money reaches the person's wallet only through the Diamond:
   an approved unstake (a full exit; there is no partial unstake) or claimed
   merchant rewards (the Diamond's per-task earnings, not this contract's
   rewards, which are only ever staked). Then
   `withdrawFiat(amount, currency, circleId, …)` places a SELL, and the
   person's smart account approves USDC to the Diamond and calls
   `setSellOrderUpi`, which pulls it from their wallet.

**Why steps 2 and 3 are separate transactions.** `completeOrder` holds the
Diamond's shared reentrancy lock while it calls the hook, and `registerFor` /
`stakeFor` take the same lock, so staking from inside the hook always reverts.
The mocks have no such lock; the two-transaction path is proven on a fork of a
Diamond that has both functions.

## Custody

Money held here, and the only ways it leaves:

| Held as                                                                                          | Leaves only                                                                             |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `pendingStake[person]` (`totalPending` in all)                                                   | into the Diamond, as that person's stake                                                |
| everything else, the free balance: any token, and USDC above `totalPending` (`available(token)`) | to anyone the owner names (`withdraw`), or USDC into an account's stake (`rewardStake`) |

There is no pool to fund: rewards are a plain USDC transfer to this contract,
and anything sent here by mistake is free too. `available(usdc)` is the USDC
balance minus `totalPending`, floored at 0.

⚠ A delivery whose completion hook did not run is not in `totalPending` until
`reconcileDelivery` credits it, so until then it reads as free. Credit every
delivery before the owner withdraws or rewards.

**No function sends a person's pending USDC anywhere but into their stake.**
The owner's `withdraw` reaches only the free balance. `UserProxy.sweepERC20`
refuses the integrator's USDC as usual, though the proxy never holds any here:
deposits pay this contract, and withdrawals pull from the person's wallet.

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
only limits that apply. Withdrawals need them as much as deposits: every SELL
sells USDC already in the seller's wallet, a merchant account is permanent, and
opening one costs only a refundable floor, so without them `withdrawFiat` would
be an uncapped offramp for USDC from any source.

- **Per deposit:** at most `getMaxBuyTxLimit(currency)`; 0 closes the currency.
- **Per withdrawal:** at most `getMaxSellTxLimit(currency)`, in the account's
  own currency only (so the cap cannot be shopped); 0 closes the currency.
- **Per day:** `MAX_DEPOSITS_PER_DAY` = 5 deposits and, counted apart,
  `MAX_WITHDRAWALS_PER_DAY` = 5 withdrawals per person, per UTC day (the
  Diamond's `getDayKey`). Every placed order counts, cancelled or not.
- **Stake floor:** every deposit reverts `BelowStakeFloor` unless the account's
  stake, plus what is pending, plus the deposit reaches
  `getStakeConfig(currency).minMerchantUSDCStake`. The Diamond's stake enforces
  the same floor on a top-up, so a smaller one would wait here. Free USDC here
  never counts toward it.
- **Refused before any money moves:** the merchant blacklist (both flows),
  ReputationManager's user blacklist (deposits), a currency other than the
  account's or that of the deposits pending here, a pending unstake, an opening in a currency
  with no circle set, and a withdrawal by someone with no merchant account.
- **Not enforced here:** no per-person total, and nothing ties an address to a
  person, so the daily counts do not stop someone using many addresses.

## Rewards

- Funding: transfer USDC to this contract. Nothing records it; it is simply
  part of the free balance.
- `rewardStake(people[], amounts[])` (owner only, a batch): stakes each
  `amounts[i]` of free USDC into `people[i]`'s account with `stakeFor`, in that
  account's own currency. One exact allowance for the batch total, reset to 0
  after.
- Refused as a whole: an empty batch or lists of different lengths
  (`LengthMismatch`), a total over `available(usdc)` (`InsufficientFree`,
  checked before any item), so a batch can never spend people's pending stake.
  Per item: a zero amount (`InvalidAmount`), or an account that is not a
  registered merchant (`NoSeat`), which includes someone whose deposit is
  delivered but not yet staked. Any registered merchant qualifies, opened here
  or not. No per-account cap.
- All or nothing: any refusal, including the Diamond's stake rules (blacklist,
  pending unstake, floor) on any one account, reverts the whole batch and
  nothing moves.
- Who earns a reward, how much and when is decided off chain. The owner can pay
  only into a merchant account's stake, never to a wallet.
- The contract keeps no record of either. Who opened an account through cashbook
  is `DepositStaked(…, opened = true)`; what each account was paid is the sum of
  its `Rewarded(user, amount)` events.
- A reward is ordinary stake and leaves with the account on unstake.

## Operations

- **Registration:** `usdcThroughIntegrator = false`. `recipientAddr` is always
  this contract, so either value delivers here, but `false` keeps the routing
  explicit. The cancel callback can stay off: `onOrderCancel` does nothing.
- **Owner** (Ownable2Step, a Safe on mainnet; `renounceOwnership` always reverts):
  - `setCircle(currency, circleId)`: the circle new accounts open in. 0 stops new
    accounts in that currency. Deposits are matched in whatever circle the caller
    names; only the account's circle is fixed.
  - `rewardStake(people, amounts)` (see Rewards).
  - `withdraw(token, to, amount)`: sends up to `available(token)` to `to`. All
    of any other token; USDC only above `totalPending`. Refused for 0
    (`InvalidAmount`), `to` = 0 (`InvalidAddress`), or more than available
    (`InsufficientFree`). Emits `Withdrawn(token, to, amount)`.
  - The owner cannot touch `pendingStake` or any order.
- **Keeper:** watches `DepositDelivered` and calls `stakeDeposit(orderId)`. It
  needs gas and nothing else. `stakeDeposit` is permissionless, so the person
  never depends on it.
- Accounts opened here have an empty `telegramId`.

## Maintainer

`dev@p2p.me`
