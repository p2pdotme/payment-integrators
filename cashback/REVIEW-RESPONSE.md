# Cashback — how every review finding was fixed

**PR:** [p2pdotme/payment-integrators#62](https://github.com/p2pdotme/payment-integrators/pull/62) · branch `cashback`
**Reviewer:** Aash · **Original review:** 2026-08-13

**Status: 119 tests · 83.5% branch · 99.3% line · 0 lint errors**

Aash raised twelve findings. All twelve are fixed. Fixing them, I then ran three further adversarial audits — and each one found real bugs *in the previous round's fixes*. Those are fixed too, and documented here, because a reviewer who only sees "F1–F12 done" would be reading a claim that was true twice and wrong in between.

Every finding below has a regression test named after it.

---

## Part 1 — Aash's twelve findings

### F1 (HIGH) — an order could bill an integrator that never placed it

**The problem.** `pay()` took `integrator` from the watcher's report and only checked it was non-zero. Nothing tied the order to the integrator being charged. Whoever held the accruer key could point *any* completed order — including plain organic orders that never touched an integrator — at *any* campaign, and make that tenant's wallet pay.

**The fix.** The Diamond already knows. `getOrderIntegrator(uint256)` is live on Base mainnet and Sepolia; I verified the selector myself before relying on it, by enumerating the diamond loupe's `facets()`:

```
selector 0xc0bc0d14
mainnet 0x4cad6eC9…  facets=21  present ✓
sepolia 0xeb0BB8E3…  facets=27  present ✓
```

`_verifyOrder` now requires an exact match and rejects `address(0)`:

```solidity
try IOrderFlow(diamond).getOrderIntegrator(orderId) returns (address bound) {
    if (bound == address(0) || bound != integrator) return (false, v);
} catch { return (false, v); }
```

**Tests.** `F1: an order can only bill the integrator that actually placed it` (the PoC shape — tenant B's 5% campaign no longer pays for tenant A's order) · `F1: an organic order with no integrator pays nothing`

---

### F2 (HIGH) — the watcher would have paid almost nothing

**The problem.** The watcher read each order's status once, ~60 s after placement, then advanced its cursor past that block range forever. Orders complete on fiat time. Aash measured 120 real mainnet orders: median completion **122 s**, and **0 of 13** completed orders would have been caught. The programme would have run, emitted no errors, shown healthy dashboards, and paid nothing.

**The fix.** The cursor now tracks *discovery* only. Every order found enters a persisted pending set and is re-checked each poll until it completes (paid), cancels (dropped), or ages out past the dispute window (14-day TTL — a dispute settlement can complete an order days later).

Raising the confirmation count was not the fix: it trades one silent cutoff for another.

---

### F3 (MED-HIGH) — the reporting key chose which campaign paid

**The problem.** `orderType` and `currency` came from the report, so the same key that reports orders picked *which* of a tenant's campaigns paid. An INR BUY could be reported as a SELL to catch a richer promo row. It also meant "onramp only" was a watcher convention rather than a structural property.

**The fix.** Both are read from the order record, which already carries them. An unrecognised order type maps to the `ANY` wildcard rather than defaulting to `"BUY"`, so it can only ever match a deliberately-wildcard campaign.

**Test.** `F3: order type and currency come from the record, not the report`

---

### F4 (MEDIUM) — funding authorisation was an unscoped blanket grant

A treasury that authorised a partner for a *points-token* campaign had also authorised them to create a **USDC** campaign funded by the same wallet.

**Fixed:** `fundingAuthorized[wallet][spender][token]` — keyed by token, grantable only by the wallet itself, and re-checked on **every payout**, so revoking stops payouts immediately rather than at the next campaign edit.

---

### F5 (MEDIUM) — one hostile token wedged the whole service

The 63/64 gas rule meant a reward token that burned all forwarded gas took down the entire batch. Reward tokens are tenant-chosen, so any tenant could do this to everyone.

**Fixed:** the token call is gas-capped (`TOKEN_CALL_GAS`). Measured adequate rather than assumed: 38k gas for a plain OpenZeppelin ERC-20, 50k for a USDC-style upgradeable proxy with a delegatecall hop, blocklist reads and a paused flag.

> This fix was later found to be **incomplete** — see Part 4, finding 1.

---

### F6 (MEDIUM) — no budget ceilings worth the name

`MAX_BPS` was 20% (a drain budget, not a cashback rate) and `MAX_FLAT_AMOUNT = 1e24` was no bound at all for a 6-decimal token — 10¹⁸ USDC. There were no per-order, per-day, per-user or lifetime budgets. The answer was "keep the allowance small": operator discipline, not a guarantee.

**Fixed:** `MAX_BPS` → **500** (5%), `MAX_FLAT_AMOUNT` → **1e21**, plus per-campaign `maxRewardPerOrder`, `dailyBudget`, `totalBudget` and `dailyPerUser`, all enforced on-chain. They clamp rather than reject, so a partly-affordable reward still pays what the budget allows.

---

### F7 (MEDIUM) — campaigns were retroactive and re-priced history

A campaign had no validity window, so activating one paid every historical completed order for that integrator, and `setRate` re-priced orders placed under the old rate. The README's own "week 1 at 1%, week 2 at 2%" workflow was not what the contract did.

**Fixed:** campaigns carry `startTime`/`endTime`, and eligibility is judged on the record's `placedTimestamp`.

> The first version of this fix was **bypassable** — see Part 2, finding 2.

---

### F8 (MEDIUM) — SELL rewards land on a proxy, not a person

For SELL flows `order.user` is a `UserProxy`: for some integrators the seller's own proxy — where a USDC reward is permanently trapped by the proxy's sweep block — and for others the integrator's shared system proxy, where every seller's reward piles up unattributable.

**Fixed:** SELL and PAY campaigns are rejected at creation with `UnsupportedOrderType`.

---

### F9 (LOW) — 18-decimal reward tokens paid dust

Rewards were computed in the order's 6-decimal USDC units and paid in the reward token's units, so 1% of a $1,000 order in an 18-decimal token paid 0.00000000001 tokens.

**Fixed:** a per-campaign scale factor derived from the token's `decimals()` at creation. A token that doesn't expose `decimals()` is treated as 6dp — the conservative choice, since it under-pays rather than over-pays if wrong. Tested at 18dp, 2dp, and no-`decimals()`.

---

### F10 (LOW) — retired campaigns could be closed by nobody

After a handover, `onlyCampaignOwner` rejected the old owner (no longer the integrator owner) and the new one (`CampaignRetired`). The campaign was unpayable but read `ACTIVE` forever, with the previous owner's token approval lingering and nothing telling them to revoke it.

**Fixed:** `end()` accepts the current integrator owner **or** the address recorded as the campaign's creator — exactly who needs to know to revoke.

---

### F11 (LOW) — two sharp edges on the admin surface

`setIntegratorOwner` rejected `address(0)`, so an integrator could only be handed on, never withdrawn. And `setAdmin(self, false)` could leave the registry with **no admin** — campaigns still paying, nobody able to rotate the accruer or emergency-stop again.

**Fixed:** added `unassignIntegrator` (bumps the epoch, so the outgoing owner's campaigns stop immediately) and an `adminCount` last-admin guard.

---

### F12 (PROCESS) — none of this code was covered by CI

`cashback/` is a separate hardhat project nested in the repo, so the root workflow never compiled, linted, tested, coverage-gated or Slither-scanned it. The "78 tests, 0 lint errors" in the original PR body was self-reported.

**Fixed — but not yet pushed.** `.github/workflows/cashback.yml` is written and runs compile, test, a coverage gate (90% line / 80% branch, parsed from `coverage.json`), solhint, prettier, and Slither with `fail-on: high`.

> **⚠ This file is not on the branch.** GitHub rejects pushes touching `.github/workflows/` from a token without the `workflow` scope. Until it lands, every metric in this document remains self-reported — which is the substance of what Aash flagged. Landing it needs a PAT with `workflow` scope.

---

## Part 2 — Second pass: bugs in those fixes

New code is where new bugs live, so I re-audited the twelve fixes rather than assuming them. Six issues, three in my own work.

### CRITICAL — a USDT-style token became an unlimited drain

The gas-capped call from F5 judged success as `ret.length == 32 && decode(true)`. A token that moves the funds and returns **nothing** — USDT and friends — failed that test, so the rollback fired: `orderPaid` cleared and the budget counters skipped, while the tokens had already left the funding wallet. The watcher, seeing an unpaid order, retried.

Every guard was bypassed at once — no replay protection, no budget accounting — bounded only by the ERC-20 allowance. **No attacker required:** a no-return reward token plus a running watcher was sufficient. My code comment claimed it "fails closed". It failed **open**, repeatedly.

**Fixed** to the SafeERC20 rule: a revert is failure, data decoding to `false` is failure, and **no return data is success** — a non-compliant token that did not revert has moved the tokens.

### HIGH — F7 was bypassable at creation

`startTime` was only *defaulted* to now when the caller passed 0. Passing `startTime: 1` was accepted, so an owner could stand up a campaign today and immediately harvest the integrator's entire order history — the exact scenario F7 claims to close.

**Fixed:** the start is now *floored* at `block.timestamp`. Scheduling later is allowed; earlier is not.

### HIGH — the watcher starved its own pending set

`Object.keys(pending).slice(0, N)`. JavaScript enumerates integer-like keys in ascending **numeric** order, so once the set exceeded 400 the same lowest orderIds were re-checked forever and newer orders were never examined until they aged out. F2's failure mode, returning by a different route.

### HIGH — losing the state file silently skipped orders

`readState(START_BLOCK || head0)` resumed from the **current head** when the state file was missing, permanently skipping every order placed while the watcher was down. The on-chain marker prevents double *payment*, not silent *omission* — my comment conflated the two.

**Fixed:** a cold start requires an explicit `START_BLOCK`.

### MEDIUM — `setBudget` validated the window against the wrong start

`budget.endTime <= budget.startTime` used the calldata start, so passing `startTime: 0` (the "leave unchanged" sentinel) compared against 0. Any positive `endTime` passed — including one below the real start, leaving a live campaign permanently unpayable with no error raised.

### MEDIUM — `quote()` diverged from `pay()`

`quote` replicated neither the budget clamps, the window, nor the funding-authorisation check, so a dashboard kept advertising rewards after the budget was spent or the funder revoked.

**Fixed:** `pay` and `quote` now share `_grossReward` / `_applyBudgets` / `_spendable`, so they cannot drift. Added `quoteForUser` for callers that know the recipient.

---

## Part 3 — Third pass

### HIGH — the starvation fix did not fix starvation

I had sorted the pending set by `firstSeen` and written that this made progress "monotonic regardless of set size." **That was wrong.** The sort is static, and an order only leaves the set when it completes, cancels, or ages out. Orders parked in PLACED/ACCEPTED — abandoned orders, which are routine — sit at the head permanently. Past 400 of them, nothing newer is examined for 14 days, then it ages out unpaid. Anyone could trigger it deliberately by placing ~400 orders and walking away, disabling cashback for every integrator at once.

**Fixed:** a rotating cursor sorted by `lastChecked`, stamped on every visit *before* any early `continue`, so a stuck order is seen once and moves to the back. Every entry is visited in bounded time however many are stuck.

### MEDIUM — phantom payouts against a codeless address

Empty returndata counts as success (the SafeERC20 rule, required for USDT). A low-level call to a **codeless** address also returns success with empty returndata — so a campaign pointed at an EOA would mark orders paid and emit `Paid` while nothing moved, permanently burning that order's one payout slot.

It happened to be unreachable, because `_decimalScale`'s `try … returns` emits an `extcodesize` check that reverts outside the catchable region. But that is a compiler detail, not an invariant.

**Fixed:** an explicit `rewardToken.code.length` check at creation, plus a delivered-amount check that rolls back rather than burning the slot when a contract token reports success but delivers nothing.

### MEDIUM — budget counters credited the requested amount

Counters used `reward`, never the delivered amount. With a fee-on-transfer or rebasing token the two differ, so budgets exhausted at up to 2× the tokens users actually received: a campaign stopping while its wallet still held funds, and `dailyPerUser` locking someone out early.

**Fixed:** counters use the recipient's measured balance delta.

### MEDIUM — the cold-start guard tested the wrong thing

It checked file *existence* while its own comment named "missing **or corrupt**". A corrupt file parsed to the fallback and silently resumed at the head — the exact hole it was added to close.

**Fixed:** `readState` distinguishes absent from unparseable and throws on the latter.

---

## Part 4 — Fourth pass

### CRITICAL — the delivered-amount fix reopened F5's gas hole

`TOKEN_CALL_GAS` capped `transferFrom`, but the third pass added two **uncapped** `balanceOf` calls to the payout path. `rewardToken` is tenant-chosen, so those are attacker code receiving 63/64 of the batch's remaining gas. A token whose `balanceOf` loops forever drained the batch before `transferFrom` was ever reached, starving every honest row — precisely the attack `TOKEN_CALL_GAS` exists to stop.

**Fixed:** a `_tryBalanceOf` helper using a gas-capped `staticcall`, returning `(false, 0)` on revert or malformed data so the caller degrades instead of bubbling.

**Test.** `a balanceOf gas bomb cannot starve the rest of the batch` — 1 hostile row + 9 honest; all nine still pay.

### HIGH — the delivered-amount subtraction could revert permanently

`balanceAfter - balanceBefore` is checked arithmetic. A rebasing token — or simply a hostile one — can leave the recipient's balance *lower* than before, panicking. Through `payBatch` that costs one row; called directly it reverts outright, and because the revert unwinds `orderPaid` the row then fails identically forever: a permanent poison pill.

**Fixed:** saturating subtraction, routing into the existing graceful rollback.

**Test.** `a token that lowers the recipient balance fails gracefully`

### LOW (watcher) — a parseable-but-invalid state entry wedged the loop

An entry whose `amount` was not numeric threw inside the loop every poll forever, never being removed. **Fixed** with a `sanitizePending` shape check on load that drops unusable entries loudly.

### LOW (watcher) — a reorg could drop orders as paid

Orders were retired from the pending set on transaction *inclusion*. `CONFIRMATIONS` protects discovery, but the payment tx is sent at head — a reorg un-mining it after retirement would leave those orders permanently unpaid. **Fixed:** orders are retired only after `PAYMENT_CONFIRMATIONS`.

---

## Verified correct across all passes

Order verification against the Diamond · the replay guard · both ERC-20 failure modes · ownership epochs · fund isolation · narrow admin powers · reentrancy (a malicious token re-entering `pay()` is blocked by `onlyAccruer`) · access control on all gated functions · `pay`/`quote` agreement · the `payBatch` self-call granting no privilege escalation · COMPLETED being terminal on-chain, so a push is never paid against an order that later un-completes.

---

## Still open — flagged, not silently decided

**A wildcard campaign still matches a SELL order.** F8 blocks *creating* SELL-keyed campaigns, but an `(integrator, ANY, ANY)` row resolves for a SELL and the reward lands on a proxy — exactly the F8 concern. Changing wildcard semantics is a product call, so it is documented rather than decided unilaterally.

**Per-campaign batch quarantine** (the operational half of F5) is not implemented. The watcher no longer stalls on a failed batch, but batching per campaign and quarantining after N failures is not there.

**`totalBudget` bounds credited spend, not wallet outflow** for fee-on-transfer tokens. Each order under-credits, so the wallet can empty before the budget does. Confined to the campaign owner's own wallet.

**Sub-6-decimal rounding.** A 2-decimal token at 1% pays nothing on a $0.01 order. A minimum order amount is a programme setting, not a contract concern.

**Aash's §5 programme questions** — eligibility gating, and the lock/chargeback posture — remain product decisions rather than code gaps.

**The reward token choice.** `UserProxy.sweepERC20` restricts only the integrator's own `usdc()`; every other token is unrestricted. A points token carries no proxy complications. Paying USDC into a user wallet reaches the end state that restriction exists to control, so it needs an answer from whoever owns the fraud model.

---

## Honest note on process

Four audit rounds, and rounds 2, 3 and 4 each found bugs introduced by the round before — twice in code whose comment asserted the opposite. The critical finding in Part 2 would have drained a funding wallet in normal operation with no attacker; the critical finding in Part 4 re-opened a hole an earlier round had closed.

I would not treat this as settled. A fifth independent pass before any live funds is warranted, and the CI workflow (F12) needs to land so the numbers here stop being self-reported.
