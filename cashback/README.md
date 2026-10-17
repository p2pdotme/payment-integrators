# cashback

Config-driven cashback for the P2P protocol.

Fill in five fields, a campaign goes live. Rewards are paid **instantly** to the user's wallet. Works for **every integrator** — the ones deployed today and every future one — **without modifying a single integrator contract.**

**Multi-tenant.** Each integrator has an owner who runs cashback for it, funded from their own wallet. One owner can run many campaigns across many integrators. Nobody can touch anyone else's campaigns or spend anyone else's tokens.

```
Integrator address   ·   Order type   ·   Currency   ·   Cashback token   ·   Cashback %
```

---

## How it works

```
Order completes on any integrator
      ↓
Protocol emits B2BOrderPlaced(orderId, integrator, user, amount)
      ↓
Watcher (off-chain) reports the completed order
      ↓
Registry verifies it against the Diamond
      ↓
Reward sent straight to the user's wallet — from that campaign's funding wallet
```

**Why no integrator changes are needed.** `B2BOrderPlaced` is emitted by the Diamond's B2B gateway on every order, for every integrator — integrators never emit it themselves. It already carries everything the reward calculation needs, so existing (immutable) integrators are covered immediately and new ones the day they are whitelisted.

**Why rewards are paid beside the payment, not inside it.** Integrators settle order funds to four different destinations — a user proxy, the user's own wallet, the integrator itself, or time-locked merchant custody — and one of them pays a merchant rather than a buyer. There is no common injection point, and for merchant custody, crediting settlement would break that contract's solvency accounting. Paying from a separate wallet after settlement completes works uniformly and can never disturb a payment.

## Who can do what

| Role | Can | Cannot |
|---|---|---|
| **Registry admin** | assign integrator owners, manage watchers, emergency-stop a campaign | create campaigns, change a rate, spend anyone's tokens |
| **Integrator owner** | create / activate / pause / retune / end campaigns for **their** integrator, funded from **their** wallet | touch another integrator's campaigns |
| **Watcher** | say WHICH order to look at | choose who is billed, which campaign pays, who receives, or how much |

An admin's `emergencyStop` can only **pause or end**. Stopping something abusive is a safety power; changing where an owner's money goes is not.

## Trust model

The watcher is **not trusted**. A report names an order id and nothing that matters: the registry re-reads the order from the Diamond and takes the **billed integrator**, the **recipient**, the **order type**, the **currency** and the **placement time** from that record. The report is a pointer, not a claim.

| If the watcher… | Result |
|---|---|
| reports a fake order | verification fails, nothing paid |
| inflates an amount | amount read from the Diamond, not the report |
| reports one order twice | `orderPaid` makes it a no-op |
| names the wrong user | recipient read from the Diamond |
| **bills the wrong tenant** | `getOrderIntegrator` binds the order to the integrator that placed it |
| **claims a different order type or currency** | both read from the record, so it cannot pick a richer campaign |
| crashes or stops | resumes from its cursor and backfills — **delayed, never lost** |

Its only real power is omission. Anyone can run a second watcher to backfill.

## Layout

```
contracts/cashback/CashbackRegistry.sol    the only contract deployed
contracts/interfaces/                      ICashbackRegistry, IOrderFlow
contracts/test/                            mocks (USDC, order source, hostile token)
test/cashback-registry.test.ts             104 tests
scripts/deploy-cashback.ts                 deploy (admin)
scripts/set-integrator-owner.ts            assign an integrator's owner (admin)
scripts/create-campaign.ts                 the five-field form, as a CLI (owner)
services/watcher/watcher.ts                the off-chain daemon
```

## Quick start

```bash
npm install
npx hardhat compile
npx hardhat test
```

### Deploy

```bash
DIAMOND_ADDRESS=0x… FUNDING_WALLET=0x… \
  npx hardhat run scripts/deploy-cashback.ts --network baseSepolia
```

Then, once:

1. From the funding wallet — `token.approve(<registry>, <allowance>)`
2. `registry.setAccruer(<watcherAddress>, true)`

### Create a campaign

```bash
REGISTRY_ADDRESS=0x… \
INTEGRATOR=0x… \
REWARD_TOKEN=0x… \
ORDER_TYPE=BUY CURRENCY=INR RATE_BPS=100 \
  npx hardhat run scripts/create-campaign.ts --network baseSepolia
```

Campaigns start as a **draft**. `activate(campaignId)` is a deliberate second step so a half-configured campaign can never pay out.

### Run the watcher

```bash
RPC_URL=… REGISTRY_ADDRESS=0x… DIAMOND_ADDRESS=0x… WATCHER_PRIVATE_KEY=0x… \
  npx ts-node services/watcher/watcher.ts
```

## Campaign lifecycle

| Status | Pays | Notes |
|---|---|---|
| `INACTIVE` | no | created but not started |
| `ACTIVE` | yes | running |
| `PAUSED` | no | stopped, resumable; frees the lookup slot |
| `ENDED` | no | terminal, cannot be reactivated |

The rate is changeable while running — `setRate` — which is the core experiment knob.

**Kill switches, fastest first:**

0. **`setAccruer(watcher, false)`** — one transaction, stops every payout everywhere
1. **Revoke the funding wallet's approval** — instant, halts that wallet's campaigns, no registry transaction
2. `pause(campaignId)` — the owner stops one campaign
3. `emergencyStop(campaignId, permanent)` — a registry admin stops an abusive campaign
4. Funding wallet runs empty — payouts log `PayFailed` and stop on their own

## Campaign resolution

Looked up by `(integrator, orderType, currency)`, most specific first:

```
integrator + BUY + INR   →   integrator + BUY + ANY   →   integrator + ANY + ANY
```

`ANY` is `bytes32(0)`. One row can cover a whole integrator, with a single cell overridden to run an experiment. At most one campaign is active per triple, so resolution is never ambiguous.

## Design notes

- **No `owed` ledger, no `claim()`.** Rewards are pushed on verification, so there is no balance to track.
- **`pay` returns 0 instead of reverting** when an order does not qualify. Reverting would let one bad row block an entire batch.
- **`orderPaid` is set before the transfer** and rolled back if it fails — so a reentrant token cannot collect twice, and a failed payout stays retryable.
- **Payout success follows the SafeERC20 rule**, not "did it return 32 bytes of true": a revert is failure, data decoding to `false` is failure, and **no return data is success**. Non-standard tokens (USDT-style) that move funds without returning anything therefore work. An earlier version required a 32-byte `true`, which read those tokens as failures and rolled back the replay guard *after* the tokens had already moved — a retrying watcher then drained the wallet. See `REVIEW-RESPONSE.md` §Second pass.
- **Both rate forms are bounded, with no setter.** `MAX_BPS` is 5% and `MAX_FLAT_AMOUNT` is 1e21; campaigns add per-order, per-day, per-user and lifetime budgets on top. A compromised key at any level cannot configure an unbounded payout.
- **The registry never custodies reward tokens.** They stay in each campaign's own funding wallet until a payout pulls them.
- **Funding wallets opt in explicitly, per token.** To fund a campaign from a wallet you do not control, that wallet must call `authorizeCampaignFunder(you, token, true)` itself — an ERC-20 allowance is not proof of control, since it names the wrong spender and is granted for unrelated reasons all the time. Authorisation is re-checked on every payout, so revoking stops payouts at once.
- **Ownership is registered, not read from the integrator.** Integrators do not share an ownership interface — some expose `owner()`, others are multi-owner with `isOwner()` and a super-admin. A registered mapping works uniformly and cannot be spoofed.
- **Percentage rewards are a share of USDC bought**, not of local fiat paid — `order.amount` on the Diamond is the USDC figure.

## PR #62 review fixes

An independent review (Aash, 2026-08-13) compiled the branch, wrote six
proof-of-concept exploits and verified behaviour against the live Base
mainnet Diamond. All twelve findings are addressed, each with a regression
test named after the finding.

| # | Severity | Finding | Fix |
|---|---|---|---|
| F1 | HIGH | `pay()` never checked that an order belonged to the integrator being billed, so the accruer key could point any completed order — even an organic one — at any campaign and drain that tenant's wallet | `_verifyOrder` now calls the Diamond's `getOrderIntegrator` (selector `0xc0bc0d14`, live on mainnet and Sepolia) and requires an exact match |
| F2 | HIGH | The watcher checked each order once ~60 s after placement then advanced past it forever. Real orders complete at a median of 122 s — **0 of 13** sampled completions would have been caught | The cursor now tracks *discovery* only; every order enters a persisted pending set and is re-checked each poll until it completes, cancels, or ages out past the dispute window |
| F3 | MED-HIGH | `orderType` and `currency` came from the report, so the same key that reports orders chose which campaign paid | Both are read from the order record |
| F4 | MEDIUM | Funding authorisation was a blanket grant — sponsoring a points campaign also authorised a USDC one from the same wallet | Authorisation is keyed by token and re-checked on every payout |
| F5 | MEDIUM | A reward token that burns all forwarded gas took down the whole batch via the 63/64 rule | The token call is gas-capped (`TOKEN_CALL_GAS`) |
| F6 | MEDIUM | `MAX_BPS` was 20% and `MAX_FLAT_AMOUNT` (1e24) was no bound at all for a 6dp token; no per-order, per-day, per-user or lifetime budgets | `MAX_BPS` is 5%; the flat ceiling is `MAX_FLAT_TOKENS` (1,000) *whole tokens*, derived per campaign from the token's decimals (M2 — the 1e21 replacement was still no bound at 6dp); campaigns carry `maxRewardPerOrder`, `dailyBudget`, `totalBudget` and `dailyPerUser`, all enforced on-chain |
| F7 | MEDIUM | Campaigns had no validity window, so activating one paid every historical order and `setRate` re-priced orders already placed | Campaigns carry `startTime`/`endTime` (start defaults to creation) and eligibility is judged on the order's `placedTimestamp` |
| F8 | MEDIUM | SELL rewards land on a proxy — trapped if USDC, unattributable if the integrator's system proxy | SELL and PAY campaigns are rejected at creation, **and** `pay` refuses a SELL/PAY order whatever campaign resolved it. Rejecting only the campaign key left the `(ANY, ANY)` wildcard — the row a tenant creates once the keyed one is refused — still paying them |
| F9 | LOW | Rewards were computed in 6dp USDC units but paid in the reward token's units, so an 18dp token paid dust | A per-campaign scale factor is derived from the token's `decimals()`, defaulting to 6dp if absent |
| F10 | LOW | A retired campaign could be closed by nobody and sat reading ACTIVE forever | The recorded owner can always `end` it, so they know to revoke their approval |
| F11 | LOW | An integrator could never be un-assigned, and the last admin could remove themselves | `unassignIntegrator` (bumps the epoch) plus a last-admin guard |
| F12 | PROCESS | `cashback/` is a nested project, so root CI never compiled, linted, tested or Slither-scanned it | `.github/workflows/cashback.yml` runs compile, test, coverage gate, solhint, prettier and Slither |

Confirmed sound in the same review and unchanged: order verification against
the Diamond, the replay guard, both ERC-20 failure modes, ownership epochs,
fund isolation, narrow admin powers, and the fact that COMPLETED is terminal
on-chain so a push can never be paid against an order that later un-completes.

## Second-pass review fixes

A second review re-ran the twelve findings above and probed the new surface.
The character of what it found had changed: the first review found ways to
lose funds, the second found ways to **silently not pay** — which is the
harder class to notice, because nothing errors.

| # | Severity | Finding | Fix |
|---|---|---|---|
| N1 | MEDIUM | The watcher deleted every row of a batch on inclusion, regardless of outcome. The registry deliberately leaves declined orders retryable, but the discovery cursor was long past — so an empty funding wallet, a revoked approval or simply hitting the daily budget meant those orders were never paid, with no error to look at | `pay` emits `PayDeclined(orderId, reason)` on every decline; the watcher retires a row only if the receipt shows `Paid` or a reason that can never change, and holds the rest for retry |
| N2 | LOW-MED | Cancelled orders were dropped on sight, but CANCELLED is not terminal for a BUY — a dispute settled in the user's favour completes the order days later, which is exactly what the 14-day TTL exists for | Cancelled orders are held to the TTL and re-checked on a slow cadence (`CANCELLED_RECHECK_MS`, default 6 h), filtered out of the hot rotation so they cannot crowd out live orders |
| N3 | MEDIUM | `_payable` checked status and epoch but not the validity window, so a campaign scheduled to start next week shadowed the integrator-wide row beneath it and paid nothing meanwhile | Resolution is judged at the order's own `placedTimestamp` (`_payableAt`), so an out-of-window campaign falls through — while an order reported late still resolves to the campaign that governed it |
| N4 | LOW-MED | `createCampaign` validated `endTime` against the raw `startTime`, then stored a start floored at `block.timestamp` — so `startTime: 0, endTime: <past>` produced an inside-out window: permanently unpayable, reads ACTIVE, holds its slot | The start is floored first and the end validated against the floored value. This was the same bug the second pass had already fixed one function down in `setBudget` |
| N5 | LOW-MED | `quote` / `quoteForUser` ignored the window, advertising 3% for a campaign `pay` would pay 0 on | Both resolve at `block.timestamp`, so they quote the campaign that would actually pay. They also report 0 rather than a partial amount when the funding wallet is short, because `pay` never transfers a partial reward |
| N6 | LOW | A budget-boundary order was paid dust — $0.000001 instead of $10 — and `orderPaid` burned its one payout slot forever | Budgets now defer rather than shave, but only where deferring can help: a daily cap refills, so the order waits and pays in full; a lifetime cap never refills, so its remainder is paid out; a reward exceeding the whole cap is still clamped, because a flat all-or-nothing rule would deadlock it into silent non-payment |
| N7 | LOW | `PAYMENT_CONFIRMATIONS` was declared, documented as the confirmation depth before retiring orders, and never referenced — `tx.wait()` waits one. The reorg it was introduced to close was still open | `tx.wait(PAYMENT_CONFIRMATIONS)` |
| N8 | LOW (blocking) | `createCampaign` gained a required `Budget` argument and `scripts/create-campaign.ts` still passed the old seven, so it threw. There was no CLI path to set budgets at all, and the help text advertised `ORDER_TYPE=SELL`, which the contract rejects | The script passes a `Budget`, exposes every dial as an env var, requires `MAX_REWARD_PER_ORDER` unless `UNLIMITED=true` is typed out, and no longer advertises SELL. Added `scripts/authorize-funder.ts`, which had no script at all |
| N9 | INFO | README quoted stale test and coverage numbers and claimed CI ran | Figures are no longer transcribed here; see the Status section |
| M1 | LOW-MED | `setBudget` had a "leave unchanged" sentinel for `startTime` but not for `endTime` immediately below it, so an operator bumping one dial from a fresh struct silently converted a time-boxed campaign into a perpetual one | An existing `endTime` cannot be cleared through `setBudget` — that is what `end()` is for — and the event now carries every resulting value |
| M2 | LOW-MED | The flat ceiling of `1e21` base units was 10^15 USDC for a 6dp token: no bound in practice, leaving an authorised third-party funder's approved balance limited only by its ERC-20 allowance | The ceiling is 1,000 *whole tokens* at any precision, derived from the token's own `decimals()` and enforced on `setRate` as well as creation. Readable via `maxFlatAmountFor(token)` |
| M3 | LOW | `_spendable` and `campaignView` made uncapped high-level calls into tenant-chosen token code — the exact hazard `TOKEN_CALL_GAS` closed on the payout path, left open on the view path | Both go through gas-capped helpers and fail closed to 0 |
| M4 | INFO | `@param orderType` still documented SELL as accepted | Corrected |
| F12 | PROCESS | Still open at the second pass — the workflow was not on the branch | `.github/workflows/cashback.yml` now runs compile, test, a coverage gate, solhint, prettier and Slither on every PR touching `cashback/` |

### Launch checklist

Budgets are the primary spend control and the contract accepts `0` as
"unlimited", so this is a discipline the code cannot enforce for you:

1. **Set `maxRewardPerOrder` on every campaign.** `scripts/create-campaign.ts`
   requires it unless you pass `UNLIMITED=true`. Without it the campaign is
   bounded only by the funding wallet's ERC-20 allowance.
2. **Set `dailyBudget`.** It is what turns a mispriced campaign into a
   one-day loss rather than an open-ended one.
3. **Remember `setBudget` replaces all four dials.** Read the current budget
   first and restate what you mean to keep.
4. **Keep the ERC-20 allowance tight.** It is the outermost bound on every
   campaign funded by that wallet, and revoking it is the fastest kill switch.
5. **Watch the `held` count in the watcher's batch log.** A non-zero number
   is the deferral path working, but a persistent one means a wallet is dry
   or a budget is spent.

### Open decisions

Both review passes flagged questions that code cannot settle. They are
recorded here so they are decided deliberately rather than by default.

**Decided in this pass — SELL/PAY orders never pay, including under a
wildcard.** The reviewer called this a product call and was right, but left
undecided it defaults to the unsafe answer: a tenant refused a SELL-keyed
campaign creates an `(ANY, ANY)` one instead, and the reward lands on a
UserProxy — trapped by the sweep block on a seller's own proxy, or pooled
unattributably on an integrator's shared system proxy. `pay` now refuses them
on the verified order type. Reversing this needs a delivery story for offramp
rewards first, not a config change.

**Still open, and blocking mainnet:**

1. **Eligibility gating.** Anyone whose order completes is paid. There is no
   allowlist, no KYC tier, no per-address history check. Whether that is
   acceptable depends on who is expected to earn cashback.
2. **Chargeback posture.** A reward is an instant, irreversible push. If an
   order is later reversed off-chain, the reward is already gone and there is
   no clawback. The 14-day pending TTL bounds how late an order can *start*
   paying, not how late it can be disputed.
3. **USDC vs a points token.** A points token makes 1 and 2 far less costly
   to get wrong, and `_decimalScale` already supports any precision. USDC is
   the higher-stakes choice and the one the current defaults assume.

The reviewer also asked for a fifth independent pass before live funds, and
noted that none of this has run against a real Diamond — only against
`MockOrderSource`. A Sepolia dry run is the next gate.

## Notes for operators

- **Merchant terminals pay the shop, not the customer.** Where the merchant's wallet places the order (as in payqr), the merchant is `order.user` — the customer pays fiat off-chain and has no wallet. This is a merchant rebate.
- **Self-dealing on merchant terminals.** A merchant is both payer and recipient, so repeated self-sales could farm cashback cheaply. Mitigate off-chain with a per-merchant daily cap or a volume threshold before running a live campaign.
- **Integrator upgrades need a new campaign row.** Integrators are immutable and get replaced rather than upgraded; the old campaign stops earning by itself once orders stop flowing through the old address.

## Dashboard surface

Built for a UI over many campaigns:

| Call | Returns |
|---|---|
| `campaignsOfOwner(owner)` | every campaign that owner runs, across all their integrators |
| `campaignsOfIntegrator(integrator)` | that integrator's campaigns |
| `integratorsOfOwner(owner)` | integrators assigned to an owner |
| `campaignView(id)` | config + totals + **spendable** in one call |
| `campaignsPaged(offset, limit)` | paginated global list for an admin view |
| `stats(id)` | total paid, orders rewarded |

`spendable` is `min(wallet balance, allowance)` — zero means the next payout will fail even though the campaign reads ACTIVE. It is the most useful health signal in a UI.

## Status

Contract, tests, scripts and watcher are complete. Not yet deployed.

Test and coverage figures are deliberately **not** quoted here. The README
previously read "70 tests passing; 82.5% branch / 98% line coverage" against
a suite that had grown well past that, and nothing could catch the drift
because no CI job ran this directory (F12). The numbers now come from
`.github/workflows/cashback.yml`, which gates every PR touching `cashback/`
on line >= 90% and branch >= 80% and publishes the coverage report as a build
artifact. Read them there, where they are produced rather than transcribed.

Run the suite locally with `npm ci && npx hardhat test` from `cashback/`.

`test/cashback-e2e.test.ts` covers the two halves **together**: it drives real
`payBatch` transactions and feeds the resulting receipts into the watcher's
own `settledFromReceipt` / `selectForRecheck`. That pairing is where N1 lived
— the registry deferring an order while the watcher discarded it — and it is
invisible to any test that exercises only one side. The RPC layer
(`queryFilter`, `tx.wait`, the state file) is deliberately out of scope; the
lifecycle logic is the part that loses money when it is wrong.
