# Response to the second review (`d878067`)

Every finding is addressed. This document explains, for each one, **what the
bug actually was**, **why it mattered**, and **what changed**. It is the
companion to `REVIEW-RESPONSE.md`, which covers the first round.

Two things up front, because they change how the rest should be read:

**The verdict was right about the character of what was left.** The first
review found ways to lose funds; this one found ways to silently not pay.
That distinction drove the fixes. A payout that reverts gets noticed. A
payout that quietly resolves to zero does not — there is no error, no alert,
and the user simply never receives cashback they earned. Several fixes below
deliberately trade a smaller loss of efficiency for a louder failure.

**Two fixes revealed further bugs in themselves, and one of the review's own
suggestions could not be implemented as written.** Those are documented in
place rather than smoothed over — that pattern ("a fix asserting the opposite
of what it does") is what the review called out, and hiding a third instance
of it would repeat the mistake.

---

## The two that mattered most

### N1 — the watcher forgot every order the registry declined to pay

**The bug.** After a batch landed, the watcher deleted every row in the chunk
regardless of outcome. But `payBatch` isolates each row and returns nothing,
so a landed transaction says nothing about whether any individual reward was
paid. Meanwhile the registry deliberately keeps declined orders payable:
`PayFailed` rolls `orderPaid` back, and a budget-throttled order returns 0
with no state change at all.

So the two halves disagreed. The registry said "try this again later"; the
watcher discarded the row, and the discovery cursor was long past. An empty
funding wallet, a revoked approval, or simply hitting the new `dailyBudget`
meant those rewards were **never paid, with no error to look at**.

The review named this exactly right: F6 and F2 colliding — the caps defer
orders, the pending set drops them.

**Why the suggested fix needed extending.** The review proposed deleting only
rows whose `orderPaid` is now true, or parsing `Paid` from the receipt. Both
work for the paid case, but neither distinguishes *"this will never pay"*
from *"not yet"*. Keeping everything unpaid would be safe for the user and
unbounded for the operator: on a Diamond whose integrators mostly run no
cashback, every completed order would linger in the pending set for the full
14-day TTL.

**The fix.** `pay` now says *why* it declined. A new
`PayDeclined(orderId, reason)` event fires on every return-0 path, with
reasons typed terminal or retryable:

| Terminal (retire the order) | Retryable (keep it) |
|---|---|
| 1 `ALREADY_PAID` | 5 `CAMPAIGN_INACTIVE` — may resume |
| 2 `UNVERIFIED` | 8 `FUNDER_UNAUTHORIZED` — may be re-authorised |
| 3 `ORDER_TYPE` | 10 `BUDGET_EXHAUSTED` — daily caps reset |
| 4 `NO_CAMPAIGN` | |
| 6 `CAMPAIGN_RETIRED` | |
| 7 `OUT_OF_WINDOW` | |
| 9 `ZERO_REWARD` | |

The watcher parses the receipt and retires a row only on `Paid` or a terminal
reason (`settledFromReceipt`, `watcher.ts:255`). Everything else stays
pending. The batch log now reports `N paid · N closed · N held for retry`,
because a persistent non-zero `held` is how an operator learns a wallet is
dry.

**The bug this fix introduced, and how it was closed.** `pause()` called
`_releaseSlot`, clearing `activeFor` outright. That erased the only on-chain
trace a campaign existed for the triple — so an order arriving mid-pause
looked identical to one for an integrator running no cashback, and would have
been retired as `NO_CAMPAIGN` (terminal). Resuming the campaign would then
pay nothing, because the order was already gone. The same silent
non-payment, one level down.

`pause` and non-permanent `emergencyStop` now keep the slot; only `end()`
gives it up. This is only safe *because* of N3 below: a paused holder no
longer shadows a broader campaign. A new `_declineReason`
(`CashbackRegistry.sol:1157`) inspects the three tiers and reports the most
recoverable explanation, so a paused campaign reads as retryable.

---

### N6 — budget-boundary orders were paid dust and burned their payout slot

**The bug.** `_applyBudgets` clamped a reward down to whatever headroom
remained. With one micro-unit of daily budget left, an order that had earned
$10 was paid $0.000001 — and because `orderPaid` is set on any non-zero
payout, that burned the order's one payout slot forever. The user received
dust instead of cashback, permanently, and the event log recorded it as a
successful payment.

**Why the suggested fix could not be taken as written.** The review suggested
skipping below a floor so the order pays in full tomorrow. Implemented as a
flat all-or-nothing rule, that deadlocks: a `dailyPerUser` cap smaller than a
single order's reward would decline that order **every day until the TTL
dropped it**. That converts dust into total non-payment — a worse version of
the same bug. The first implementation of this fix had exactly that defect
and was rewritten.

**The fix.** Defer only when deferring can change the outcome
(`_applyBudgets`, `CashbackRegistry.sol:1383`):

- **Daily and per-user caps refill at UTC midnight** → an order that would fit
  a fresh day is declined today and paid in full tomorrow.
- **A lifetime cap never refills** → its remainder is paid out rather than
  withheld forever.
- **A reward exceeding the whole cap** — a misconfigured campaign, or an
  outsized order under an unlimited `maxRewardPerOrder` — is still clamped,
  because waiting could never help and best effort beats never paying.

A useful signal that this is the right rule: both existing F6 budget tests
pass unchanged, while the review's V5 scenario now defers and pays in full the
next day.

Deferral only works if somebody retries, so this fix is inseparable from N1.
Without a watcher that keeps declined orders, deferring is just a slower way
to never pay.

---

## The resolution-window family (N3, N4, N5)

These are three faces of one omission: the campaign validity window was
enforced at payout but not at *resolution*.

### N3 — an out-of-window campaign held the resolution slot

**The bug.** `_payable` checked status and epoch but not the window. A
campaign scheduled to start next week — activated now, which is allowed —
occupied its tier, shadowed the healthy integrator-wide row beneath it, and
paid nothing in the meantime. The same shadowing class as the retired-campaign
bug already fixed once.

**The fix, and the regression it nearly caused.** Resolution is now judged by
`_payableAt` (`CashbackRegistry.sol:1205`), which adds the window check, and
`_resolve` takes an `atTime` parameter.

The important detail is **which** time. Judging against `block.timestamp`
would have been a regression dressed as a fix: orders are routinely reported
late — the watcher holds them for up to a 14-day dispute TTL — so an order
genuinely placed inside the window but reported after `endTime` would stop
resolving to its own campaign and fall through to a broader one, or to
nothing. Resolution asks *"which campaign governed THIS order"*, which is a
question about when the order was **placed**. So `pay` resolves at
`v.placedAt`, and `quote` — a forward-looking preview — resolves at
`block.timestamp`.

There is a test guarding precisely that regression.

### N4 — `createCampaign` validated `endTime` against the raw start

**The bug.** The check compared `endTime` against `budget.startTime`, but the
start actually stored is floored at `block.timestamp` twenty lines later. So
`startTime: 0, endTime: 1000` passed — 1000 > 0 — and then stored a start of
"now", producing an inside-out window: a campaign that reads ACTIVE, can never
pay a single order, and occupies its lookup slot.

As the review noted, this is the same bug the second pass fixed in
`setBudget`, left in place one function up.

**The fix.** Floor first, validate against the floored value, store that
(`CashbackRegistry.sol:502`).

### N5 — `quote()` / `quoteForUser()` ignored the window

**The bug.** They advertised 3% for a campaign that had not started while
`pay()` returned 0. The response doc listed the window among the three things
`quote` was fixed to model; the budget clamps and the funder check landed, the
window did not.

**The fix.** Both resolve at `block.timestamp`, so they quote the campaign
that would actually pay — falling through to a live wildcard rather than
returning zero, which is strictly more useful.

**A second divergence found while fixing this.** `quote` clamped its answer to
`_spendable` and reported the remainder. But `pay` never transfers a partial
reward — it asks for the full amount, the transfer fails on the shortfall, and
`PayFailed` leaves the order unpaid. So an under-funded campaign was quoting a
number no code path would ever pay. Both now return 0 instead. Same class as
N6: do not advertise a partial payment that cannot happen.

---

## N2 — CANCELLED is not terminal for a BUY

**The bug.** Cancelled orders were dropped on sight. But a dispute settled in
the user's favour runs the normal completion path and the order reaches
COMPLETED days later — which is exactly what the 14-day TTL exists for. The
file argued against itself.

**The fix.** Cancelled orders are held to the TTL and re-checked on a slow
cadence (`CANCELLED_RECHECK_MS`, default 6 h). Leaving CANCELLED clears the
mark and restores the normal cadence.

The review's sizing — 24 of 81 orders cancelled, 1 carrying any dispute —
shaped the implementation rather than being ignored: this is a thin tail, so
it must not cost full rotation. The filter therefore runs **before** the
`RECHECK_PER_POLL` slice (`selectForRecheck`, `watcher.ts:293`). Left inside
it, a large cancelled backlog would consume the per-poll budget and starve
live orders — a different route to the same silent non-payment.

---

## N7 — `PAYMENT_CONFIRMATIONS` was dead code

**The bug, and why it was worse than "dead code".** The constant was declared
and documented as the confirmation depth before retiring orders, and never
referenced — `tx.wait()` waits one. But `REVIEW-RESPONSE.md` §232 states this
was a fix for a *reorg* hazard: retiring orders on inclusion means a reorg
un-mining the payment tx leaves them permanently unpaid. That fix was never
written, so the hazard was still open, and the document asserted otherwise.

This is the same locus as N1 — the same line retired the same rows — so the
two belong together rather than in separate severity buckets.

**The fix.** `tx.wait(PAYMENT_CONFIRMATIONS)` (`watcher.ts:480`).

---

## N8 — the scripts were not updated

**The bug.** `createCampaign` gained a required `Budget` argument and
`scripts/create-campaign.ts` still passed the old seven, so it threw on
argument count. There was no CLI path to set budgets — now the primary spend
control — and the help text still advertised `ORDER_TYPE=SELL`, which the
contract rejects.

**The fix.** The script passes a `Budget`, exposes every dial as an env var,
and **requires `MAX_REWARD_PER_ORDER`** unless `UNLIMITED=true` is typed out
explicitly. It also rejects an `END_TIME` already in the past, and no longer
advertises SELL.

`authorizeCampaignFunder` had no script at all, not a stale one — added as
`scripts/authorize-funder.ts`, which also documents that the ERC-20 approval
is a separate, independent kill switch.

---

## N9 — docs drift

**The bug.** The README quoted "70 tests, 82.5% branch" against a suite that
had grown well past it, and its F12 row claimed CI ran.

**The fix.** The figures are no longer transcribed into the README at all —
transcribed numbers drift, and nothing could catch it while no CI job ran this
directory. They now come from the coverage gate in
`.github/workflows/cashback.yml`, where they are produced.

---

## Still open from the original twelve

### F12 — the CI workflow

`.github/workflows/cashback.yml` now runs compile, test, a coverage gate
(line ≥ 90%, branch ≥ 80%), solhint, prettier and Slither, path-filtered to
`cashback/**` with the working directory set to `cashback`.

This was the load-bearing gap: the root workflows compile `./contracts`, test
`./test`, lint `contracts/**/*.sol` and filter Slither on `paths: contracts/**`
— none of which reach a nested project. Until this lands, every number about
this branch stays self-reported, including the ones in this document.

### F8 — the wildcard hole, and the product call

**The bug.** `createCampaign` refused a campaign *keyed* to SELL/PAY, but that
guard never reached the `(ANY, ANY)` wildcard row — the very row a tenant
creates once the keyed one is refused. A SELL order misses tiers 1 and 2,
falls through to the wildcard, and pushes the reward to a UserProxy: trapped
by the sweep block on a seller's own proxy, or pooled unattributably on an
integrator's shared system proxy.

**The decision.** The review was right that this is a product call, but left
undecided it defaults to the unsafe answer. It is now decided conservatively:
`pay` refuses SELL/PAY on the **verified order type** — the Diamond's record,
not the campaign key — which is the only placement covering every resolution
path (`CashbackRegistry.sol:768`). The creation-time revert is kept as the
legible early failure for the operator. Reversing this needs a delivery story
for offramp rewards, not a config change.

### F6 — budgets optional, `setBudget` lossy

Taking the second of the two options offered ("require them at creation or
make the launch checklist carry them"), because making
`maxRewardPerOrder` mandatory on-chain would invalidate the fixture in every
existing test at once.

- A **launch checklist** is now in the README.
- The **script requires** a per-order cap unless opted out explicitly.
- **M2 below** gives a real contract-level ceiling regardless.

---

## Additional findings from this pass

Four issues found while working through the above. Two are in the same family
as the review's own findings.

### M1 — `setBudget` silently converted a bounded campaign into a perpetual one

`startTime` had a "leave unchanged" sentinel; `endTime`, immediately below it,
did not. Two adjacent fields, two conventions. An operator bumping
`dailyBudget` from a freshly-built struct and not restating `endTime` did not
merely lose a cap — they removed the campaign's end date, with no event field
to notice it by.

An existing `endTime` can no longer be cleared through `setBudget`
(`CashbackRegistry.sol:594`); closing a campaign is what `end()` is for. The
event now carries all six resulting values so an indexer can see what a
partial update dropped.

### M2 — the flat-reward ceiling was vacuous for a 6-decimal token

`MAX_FLAT_AMOUNT` was `1e21` base units, and its own comment gave it away:
"1e15 USDC at 6dp and 1,000 tokens at 18dp". Only the second half is a bound.
For the token this actually ships with, `1e21` base units is 10^15 USDC — no
ceiling at all, leaving the funding wallet's balance as the only real limit.

That matters because an authorised third-party funder can set the rate. F4
scoped that grant to one token, but nothing bounded the per-order draw against
it, and `setRate` can retune a flat reward mid-flight.

The ceiling is now `MAX_FLAT_TOKENS` (1,000) **whole tokens**, derived per
campaign from the token's own `decimals()` — 1,000 USDC at 6dp, 1,000 tokens
at 18dp, 1,000 tokens at 2dp. The same programme-shaped bound at every
precision, which is what the old comment claimed it already did. Enforced on
`setRate` as well as creation, and readable via `maxFlatAmountFor(token)`.

### M3 — the view path was not gas-capped

`_spendable` and `campaignView` made uncapped high-level calls into
tenant-chosen token code — the exact hazard `TOKEN_CALL_GAS` and
`_tryBalanceOf` exist to contain on the payout path, left open on the view
path. A token whose `balanceOf` loops forever made `quote`, `quoteForUser` and
`campaignView` revert for that campaign, so the F5 fix had moved the griefing
surface to the dashboard rather than closing it.

Both now go through gas-capped helpers and fail closed to 0
(`_tryAllowance`, `CashbackRegistry.sol:1450`).

### M4 — `@param orderType` still documented SELL as accepted

Corrected.

---

## Testing

**119 → 157 tests** (141 registry + 16 end-to-end), plus a full-process
end-to-end script (`scripts/e2e-full.ts`, 17 checks) that runs the real watcher
binary against a real chain.

The registry suite gained a second-pass regression block covering every
finding above, including two adversarial guards: a late-reported order still
resolves to its own campaign (the N3 regression), and an oversized reward is
clamped rather than deadlocked (the N6 one).

**A new `test/cashback-e2e.test.ts` covers the two halves together.** This is
the significant addition, because the watcher previously had **no tests of any
kind** — and N1 was invisible to any test that exercised only one side. Both
halves can be individually correct while the system never pays: the registry
defers an order and the watcher discards it.

To make that testable, `settledFromReceipt` and `selectForRecheck` were
extracted from `main()`'s `while (true)` loop and exported; `main()` calls
them, so the tested code is the code that runs, and it is guarded behind
`require.main === module` so importing the module cannot start a live watcher.
The e2e tests drive real `payBatch` transactions and feed the **real receipts**
into those functions.

The suite also adds the review's **V6 batch-gas** measurement, which needed
re-checking rather than inheriting: the N1 fix added per-row cost on exactly
the paths a large batch is most likely to take. Every decline now emits an
event, and a no-campaign decline additionally runs `_declineReason` over three
tiers — so a 50-row batch for an integrator running no cashback went from
nearly free to three SLOADs and an event apiece. Three tests assert block
headroom and log the measured figures.

**Not covered:** the RPC layer — `queryFilter`, `tx.wait`, the state file, the
discovery cursor. Those need a live node.

### Verified results

Run against Node 24.19.0, solc 0.8.28, evm cancun, viaIR:

```
157 passing               0 failing
scripts/e2e-full.ts       17 checks, ALL PASSED (real watcher process)
CashbackRegistry.sol       92.48% stmts · 82.76% branch · 100% funcs · 97.01% lines
solhint                    0 errors
prettier                   clean
```

Measured batch gas, at the default `BATCH_SIZE` of 50:

| batch | gas used | per row |
|---|---|---|
| 50 paying rows | 3,295,158 | 65,903 |
| 50 rows that all decline | 1,632,458 | 32,649 |
| 50 rows on a gas-burning token | 9,335,058 | 186,701 |

The declining case is the one worth noting: it is the *cheapest*, at half the
cost of a paying row, so the `PayDeclined` diagnostics the N1 fix added did
not make the common case expensive.

### M5 — the watcher must set its own gas limit

Found by measuring rather than reading, and the reason the figures above are
`gasUsed` under a fixed limit rather than `estimateGas`.

A reward token that burns everything it is handed consumes whatever it is
given, up to `TOKEN_CALL_GAS`. Gas estimation is therefore self-defeating on
such a batch: offering more gas causes more to be burned, and the search
converges far above real usage. For 50 hostile rows, `eth_estimateGas`
returns **28.0M** for a batch that in fact uses **9.34M** and needs a ~12M
limit to run.

The watcher submitted `payBatch` with no gas limit, so ethers called the
estimator. On Base that 28M figure is at or beyond a block, so one hostile
tenant could have made every batch containing their rows unsendable —
griefing every honest row alongside them, which is precisely the hole F5's
per-call cap was meant to close.

The watcher now sets the limit explicitly: `GAS_OVERHEAD + GAS_PER_ROW * rows`
(300k + 250k/row → 12.8M at 50 rows). Unused gas is not charged, so
over-providing costs nothing but block space. The V6 tests assert that all 50
rows still reach a verdict under exactly that budget.

Two further defects in the CI job itself, both found by running it rather
than reading it:

- `cashback/` had no `.solcover.js`, so the `json-summary` reporter never ran
  and `coverage/coverage-summary.json` — the file the threshold gate reads —
  was never written. The coverage job would have failed on a missing module.
- Without `skipFiles`, the deliberately pathological mock tokens counted
  towards the gate and held total branch coverage at 80.19% against an 80%
  threshold. It was passing by 0.19 points for reasons unrelated to the
  contract being shipped. Scoped to the real contracts, it is 82.76%.

### M6 — holding a declined order turned the loop into a busy-wait

The most serious finding of this pass, and a regression **the N1 fix itself
introduced**. It was invisible to every test until the watcher was run as a
process.

The poll loop ended with:

```ts
if (safeHead < state.lastProcessedBlock + 1 && ready.length === 0) {
  await sleep(POLL_MS);
}
```

That was correct while a declined order was *dropped*: `ready` emptied and the
loop rested. Once declined orders are **held** and re-reported — which is the
entire point of N1 — `ready` is never empty while one is deferred, so the loop
stopped sleeping. It spun as fast as the RPC would answer, sending a `payBatch`
on every pass.

Measured in `scripts/e2e-full.ts` before the fix: **39 batches and 19 nonce
collisions in a twenty-second run**, off a single budget-throttled order. On a
real chain that is the funding wallet's gas burned continuously until the
14-day TTL expires. The deferral that N1 exists to make safe had become the
most expensive thing the watcher can do.

Two changes:

- the loop now sleeps unless there is genuine **discovery** backlog to catch up
  on. Re-reporting the same held rows is not progress;
- a row the registry declined to settle gets `retryAfter` (`RETRY_BACKOFF_MS`,
  default 5 minutes) and is not re-reported until it elapses. Every reason a
  row is held — a daily budget rolling over, a wallet being topped up, a
  campaign resumed, an approval re-granted — resolves on a human timescale, so
  retrying every poll buys nothing and costs a transaction each time.

After: **5 batches, 0 nonce collisions**, and the row stays pending throughout
(12 of 12 samples of the state file).

---

## Full end-to-end — the watcher as a process

`test/cashback-e2e.test.ts` drives the watcher's decision functions with real
receipts, which is what caught N1. It stops at the RPC boundary, and the file
said so: `queryFilter`, the block cursor, `tx.wait` and the state file were
unexercised. Those are not incidental — the cursor **is** the F2 fix, and the
state file is the only thing that makes a restart safe.

`scripts/e2e-full.ts` closes that gap. It spawns `services/watcher/watcher.ts`
as a child process, exactly as an operator would, and talks to it only through
the chain and its own state file. Nothing is stubbed.

```
npx hardhat node                                     # in another terminal
npx hardhat run scripts/e2e-full.ts --network localhost
```

It proves, in order: an order the watcher never saw placed is not paid;
placement → completion → discovery → payment → retirement; an order that
completes later is still paid (the F2 pending set); a budget-throttled order is
held rather than dropped and pays in full the next day, without a batch on
every poll (N1 + N6); and the state file survives a restart with nothing
double-paid.

`MockOrderSource` gained the `B2BOrderPlaced` event and a `placeB2BOrder`
helper for this — the `setOrder*` helpers deliberately still do not emit, so
existing contract tests are untouched.

**One caveat, recorded because it cost an hour.** The first version of the
harness spawned the watcher through `npx` with `shell: true`, and on Windows
`child.kill()` then terminates the wrapper while the ts-node grandchild keeps
running. Every run leaked a watcher, and they accumulated — several processes
sharing one state file and one relayer EOA, overwriting each other's pending
set. The symptom was an order vanishing from the pending set, which looked
exactly like a product bug and was entirely the harness's fault. It now spawns
node directly, so the pid it holds is the pid it kills.

Gas measurements are skipped under `solidity-coverage`: instrumentation
inflates every figure (~98k/row instead of ~66k) and turns the gas-bomb token
into a case that exhausts the coverage runner's heap.

---

## Where this leaves the gates

**Sepolia dry run** — N8, N1 and N2 are fixed, and F12 has landed so the dry
run's own numbers will not be self-reported. N7 was folded in with N1, since a
reorg on the same line produces the same permanent non-payment.

**Mainnet** — N3–N5 are fixed, the wildcard-SELL call is made, and budgets are
carried by the launch checklist plus a real per-order ceiling. What remains is
not code:

1. **Eligibility gating** — anyone whose order completes is paid. No
   allowlist, no KYC tier, no per-address history.
2. **Chargeback posture** — a reward is an instant, irreversible push. If an
   order is reversed off-chain the reward is gone, and there is no clawback.
3. **USDC vs a points token** — a points token makes (1) and (2) far less
   costly to get wrong, and `_decimalScale` already supports any precision.

These are recorded in the README under **Open decisions** so they are settled
deliberately rather than by default.

**The fifth independent pass is still owed, and the closing caveat still
stands in full: none of this has run against a real Diamond — only against
`MockOrderSource`.**
