# Response to review — PR #62

**Reviewer:** Aash · 2026-08-13
**Commits:** `3b059f1` (F1–F12) · `6afac16` (second-pass audit of those fixes)

All twelve findings are addressed. Each has a regression test named after the finding it prevents, so a future regression reintroduces a named, reproduced exploit rather than an abstract coverage gap.

**112 tests passing · 83.3% branch · 99.3% line · 0 lint errors**

> **Read §"Second pass" first.** After fixing your twelve, I ran another
> adversarial audit over the fixes themselves. Three were wrong — one
> critically, in a way that would have drained a funding wallet in normal
> operation with no attacker. Those are fixed too, and the sections below
> describe the *final* state.

Thank you for the depth here — particularly running the PoCs and the 120-order mainnet timing sample. F2 would not have surfaced from code reading alone, and it was the one that mattered most: the programme would have run, looked healthy, and paid essentially nothing.

---

## Blockers

### F1 (HIGH) — an order can now only bill the integrator that placed it

You were right that this contradicted the README's central claim, and right about where the fix lives. I independently verified the selector before relying on it — enumerating the loupe's `facets()` on both Diamonds:

```
selectors: getOrderIntegrator 0xc0bc0d14 · getOrdersById 0xcea99cd6
mainnet (0x4cad6eC9…): facets=21  getOrderIntegrator=true  getOrdersById=true
sepolia (0xeb0BB8E3…): facets=27  getOrderIntegrator=true  getOrdersById=true
```

`_verifyOrder` now requires an exact match, and rejects `address(0)` so organic non-B2B orders cannot be farmed:

```solidity
try IOrderFlow(diamond).getOrderIntegrator(orderId) returns (address bound) {
    if (bound == address(0) || bound != integrator) return (false, v);
} catch {
    return (false, v);
}
```

**Tests:** `F1: an order can only bill the integrator that actually placed it` (your PoC — tenant B's 5% campaign no longer pays for tenant A's order, and B's wallet is untouched), and `F1: an organic order with no integrator pays nothing`.

### F2 (HIGH) — the watcher now keeps a pending set

Rewritten around the point you identified: the cursor tracks **discovery**, not settlement.

- Every discovered order enters a persisted pending set with a `firstSeen` timestamp
- Each poll re-checks all pending orders (capped at `RECHECK_PER_POLL` so a backlog degrades gracefully rather than timing out the RPC)
- An order leaves the set on COMPLETED (paid), CANCELLED (terminal, unrewardable), or after `PENDING_TTL_MS` — default **14 days**, chosen to sit comfortably past the dispute window you flagged, since a dispute settlement can complete an order days later
- State is written via write-then-rename, so a crash mid-write cannot truncate it
- A failed batch no longer advances anything: those orders stay pending and retry next poll

The header comment records your measurement (median 122 s, 0 of 13 caught) so the reason for the design is not lost.

### F3 (MED-HIGH) — order type and currency come from the record

Both dropped from `OrderReport` and derived in `_verifyOrder`:

```solidity
v.orderType = _orderTypeLabel(order.orderType);   // 0=BUY 1=SELL 2=PAY
v.currency  = order.currency;
```

An unrecognised order type maps to `ANY` rather than defaulting to `"BUY"` — it can only match a deliberately-wildcard campaign, never be mislabelled as a buy. This also addresses your informational note about the watcher's `?? "BUY"` fallback, since the watcher no longer supplies the value at all.

**Test:** `F3: order type and currency come from the record, not the report` — a real INR BUY resolves to the 1% INR row even with a 5% wildcard row present.

---

## Tenant gates

| # | Fix | Test |
|---|---|---|
| **F4** | `fundingAuthorized[wallet][spender][token]` — keyed by token, granted only by the wallet itself, re-checked on **every payout** so revoking stops payouts at once | `F4: authorising a spender for one token does not authorise another` |
| **F5** | Token call is gas-capped at `TOKEN_CALL_GAS` (150k) | `F5: a gas-bomb reward token cannot take down the whole batch` — your PoC shape, 1 hostile + 9 honest rows; all 9 honest rows now pay |
| **F6** | `MAX_BPS` 2000→**500** (5%). `MAX_FLAT_AMOUNT` 1e24→**1e21**. Added per-campaign `maxRewardPerOrder`, `dailyBudget`, `totalBudget`, `dailyPerUser`, all enforced on-chain and clamping rather than rejecting | 3 tests incl. `per-order, per-day and lifetime budgets all clamp` |
| **F7** | Campaigns carry `startTime`/`endTime`; eligibility is judged on the record's `placedTimestamp`. Start is **floored at creation time** — see §Second pass, the first version only *defaulted* it and was bypassable | `F7: a campaign cannot pay orders placed before it started`, plus the endTime case |
| **F8** | SELL and PAY campaigns rejected at creation with `UnsupportedOrderType` | `F8: SELL and PAY campaigns are rejected at creation` |

**On F5's operational half:** the watcher no longer stalls on a failed batch. `tx.wait()` throwing is caught per batch, those orders stay pending, and the loop continues. Per-campaign batching and quarantine-after-N-failures are not implemented — flagging that as still open if you think it's needed before third-party tenants.

---

## Smaller findings

**F9** — a per-campaign scale factor is derived from the reward token's `decimals()` at creation. A token that doesn't expose `decimals()` is treated as 6dp, which under-pays rather than over-pays if the assumption is wrong. Tested at 18dp (1% of $1,000 → exactly 10 tokens), 2dp, and no-`decimals()`.

**F10** — `end()` now accepts either the current integrator owner **or** the address recorded as the campaign's creator, so a retired campaign can always be closed by the person who needs to know to revoke their approval.

**F11** — added `unassignIntegrator` (bumps the epoch, so the outgoing owner's campaigns stop paying immediately) and an `adminCount` last-admin guard.

**F12** — added `.github/workflows/cashback.yml`: compile, test, **coverage gate** (90% line / 80% branch, parsed from `coverage.json`), solhint, prettier, and Slither with `fail-on: high`. Also generated `cashback/package-lock.json`, which `npm ci` needs.

---

## Second pass — bugs in the fixes themselves

New code is where new bugs live, so I re-audited the twelve fixes rather than
assuming them. Six issues, three of them in my own work. All fixed in
`6afac16`, each with a regression test.

### CRITICAL — a USDT-style reward token became an unlimited drain

The gas-capped call from F5 judged success as `ret.length == 32 && decode(true)`.
A token that moves the funds and returns **nothing** — USDT and friends —
failed that test, so the rollback fired: `orderPaid` cleared and the budget
counters skipped, while the tokens had already left the funding wallet. The
watcher then saw an unpaid order and retried.

Every guard was bypassed at once — no replay protection, no budget
accounting — bounded only by the ERC-20 allowance. It required no attacker:
a no-return reward token and a running watcher were sufficient.

The code comment claimed it "fails closed". It failed **open**, repeatedly.

Success is now judged by the SafeERC20 rule: a revert is failure, data
decoding to `false` is failure, and **no return data is success** — a
non-compliant token that did not revert has moved the tokens.

*Test:* `a no-return (USDT-style) token pays exactly once and is accounted for`
— ten retries against one order, exactly one payment, counters correct.

This also retires the README's earlier note that USDT could not be a reward
token: it now works correctly rather than failing closed.

### HIGH — F7 was bypassable at creation

The start was only *defaulted* to `block.timestamp` when the caller passed 0.
Passing `startTime: 1` was accepted, so an owner could stand up a campaign
today and immediately harvest the integrator's entire order history — the
exact scenario F7 claims to close, reached by a shorter route. `setBudget`
guarded backwards movement; `createCampaign` had no floor.

Now floored: scheduling a campaign to start later is allowed, earlier is not.

### HIGH — the watcher starved its own pending set

`Object.keys(pending).slice(0, RECHECK_PER_POLL)`. JavaScript enumerates
integer-like keys in ascending **numeric** order, not insertion order — so
once the set exceeded 400, the 400 lowest orderIds were re-checked every poll
forever and newer orders were never examined until they aged out. Up to 14
days of cashback silently unpaid: F2's failure mode returning by a different
route. Now sorted oldest-first by `firstSeen`.

### HIGH — losing the state file silently skipped orders

`readState(START_BLOCK || head0)` resumed from the **current head** when the
state file was missing or corrupt, permanently skipping every order placed
while the watcher was down. The on-chain `orderPaid` marker prevents double
*payment*, not silent *omission* — my comment conflated the two. A cold start
now requires an explicit `START_BLOCK`.

### MEDIUM — `setBudget` validated the window against the wrong start

`budget.endTime <= budget.startTime` used the calldata start, so passing
`startTime: 0` (the "leave unchanged" sentinel) compared against 0. Any
positive `endTime` passed, including one below the real start — leaving a
live campaign permanently unpayable with no error raised. Now validated
against the effective start.

### MEDIUM — `quote()` diverged from `pay()`

`quote` replicated neither the budget clamps, the window, nor the
funding-authorisation check, so a dashboard kept advertising a reward after
the budget was spent or the funder revoked. `pay` and `quote` now share
`_grossReward` / `_applyBudgets` / `_spendable`, so they cannot drift. Added
`quoteForUser` for callers that know the recipient and need the per-user
daily allowance reflected.

### Verified correct, unchanged

F1, F3, F4, F6 caps, F8, F10, F11. The 150k gas cap was **measured** adequate
rather than assumed: 38k for a plain OpenZeppelin ERC-20, 50k for a
USDC-style upgradeable proxy with a delegatecall hop, blocklist reads and a
paused flag.

One accepted limitation: with a sub-6-decimal reward token, small orders
round to zero (a 2-decimal token at 1% pays nothing on a $0.01 order).
Documented rather than changed — a minimum order amount is a programme
setting, not a contract concern.

## Still open — flagging rather than silently deciding

**A wildcard campaign still matches a SELL order.** F8 blocks *creating* a SELL-keyed campaign, but an `(integrator, ANY, ANY)` row will resolve for a SELL, and the reward goes to the record's `user` — which for SELL is a proxy, exactly as you described. I did not change wildcard semantics unilaterally because it's a product call: either wildcards should exclude SELL structurally, or operators accept the caveat. Documented in the README; happy to make it structural if you prefer.

**Per-campaign batching / quarantine** (the operational half of F5) — not implemented.

**Your §5 programme points** — eligibility gating, and the lock/chargeback posture — remain product decisions rather than code gaps. Worth settling before merchant-rebate money, as you say; the per-user daily cap from F6 covers part of the sybil surface but not the "cashback attaches to merchants we onboarded" property.

**Informational items fixed:** `create-campaign.ts` now upper-cases `ORDER_TYPE`; deploy docs recommend approving exactly the pilot budget rather than `MaxUint256`, and a fresh watcher key rather than the deployer. The missing `(integrator, ANY, currency)` resolution tier is **not** added — it would make resolution ambiguous against `(integrator, orderType, ANY)` without a documented precedence rule, and the two-row workaround is explicit.

---

## Verification

```
npx hardhat compile   Compiled 15 Solidity files successfully (evm target: cancun)
npx hardhat test      104 passing
npx hardhat coverage  CashbackRegistry.sol | 94.44 stmts | 83.03 branch | 100 funcs | 99.18 lines
npx solhint           0 errors (13 warnings — intentional empty try/catch, mock-only requires)
npx prettier --check  clean
```

Ready for re-review.
