# Cashback Service

Config-driven cashback for the P2P protocol.

Fill in five fields, a campaign goes live. Rewards are paid **instantly** to the user's wallet. Works for **every integrator** — the ones deployed today and every future one — **without modifying a single integrator contract.**

**Multi-tenant.** Each integrator has an owner who runs cashback for it, funded from their own wallet. One owner can run many campaigns across many integrators. Nobody can touch anyone else's campaigns or spend anyone else's tokens.

```
Integrator address · Order type · Currency · Cashback token · Cashback %
```

**Status:** 78 tests passing · 82.9% branch coverage · 0 lint errors · not yet deployed.

---

## Contents

- [How it works](#how-it-works)
- [Why no integrator is modified](#why-no-integrator-is-modified)
- [Why rewards are paid beside the payment](#why-rewards-are-paid-beside-the-payment)
- [Roles](#roles)
- [Trust model](#trust-model)
- [Campaign lifecycle](#campaign-lifecycle)
- [Campaign resolution](#campaign-resolution)
- [Quick start](#quick-start)
- [Design notes](#design-notes)
- [Audit fixes](#audit-fixes)
- [Notes for operators](#notes-for-operators)

---

## How it works

Two pieces: one contract, and one off-chain service.

```
                 ON-CHAIN — unchanged, we only read
┌──────────────────────────────────────────────────────────────┐
│  Protocol (Diamond)                                          │
│    B2BOrderPlaced(orderId, integrator, user, amount)         │
│    — emitted on EVERY order, for EVERY integrator            │
│  Integrators — immutable, never touched                      │
└──────────────────────────────────────────────────────────────┘
                            │ read logs
                            ▼
                 ┌──────────────────────┐
                 │ Watcher (off-chain)  │  tail · finality · batch
                 └──────────────────────┘
                            │ payBatch()
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  CashbackRegistry     ← the only contract deployed           │
│    campaigns · verify vs protocol · pay immediately          │
└──────────────────────────────────────────────────────────────┘
                            │ transferFrom(campaign wallet → user)
                            ▼
                 User's wallet — tokens arrive automatically
```

### A single order, step by step

```
1. User completes a BUY — pays fiat off-chain, receives 12 USDC

2. Protocol publishes:  orderId · integrator · user · amount

3. Watcher sees it (~1 min: it stays 30 confirmations behind the head
   so a chain reorg can never undo a payout that already happened)

4. Registry VERIFIES against the Diamond:
      · does the order exist?
      · is it COMPLETED?
      · do the reported user and amount match the record?

5. Registry RESOLVES the campaign:
      integrator + BUY + INR  →  1%

6. Reward = 1% of 12 USDC = 0.12 tokens

7. transferFrom(that campaign's funding wallet → the user's wallet)
```

The user does nothing — no claim, no button, no gas.

**Reward basis is USDC, not fiat.** `order.amount` on the Diamond is the USDC figure (6dp); `fiatAmount` is a separate field the registry never reads. A percentage is always a share of USDC bought, never of rupees or reais paid.

### Deployment count

| Thing | How many times |
|---|---|
| Deploy the registry | **once, total** |
| Run the watcher | **once, total** |
| Assign an integrator owner | once per integrator |
| Create a campaign | as often as you like — no deploy |
| Change a rate | anytime, one call |

Three integrators or three hundred: still one contract and one watcher.

---

## Why no integrator is modified

`B2BOrderPlaced` is emitted by the Diamond's B2B gateway on every order, for every integrator — **integrators never emit it themselves**. It already carries `(integrator, user, amount)`, which is everything the reward calculation needs.

So the watcher reads the protocol's own records instead of asking integrators for anything:

- **Existing integrators** — covered immediately. They are immutable by policy (`proxyImpl` is set-once on the Diamond; upgrade proxies are explicitly disallowed), so anything requiring a code change inside them would be a non-starter.
- **Future integrators** — covered automatically the day they are whitelisted, with zero cashback code inside them.

The watcher queries with **no integrator filter**, so it already sees integrators that do not exist yet. Filtering happens in the registry's campaign table — config, not code. That is why onboarding a new integrator is one transaction rather than a redeploy.

---

## Why rewards are paid beside the payment

Integrators settle order funds to four different destinations, and one pays a merchant rather than a buyer:

| Integrator type | Where order money settles | Reward recipient | Inject into settlement? |
|---|---|---|---|
| Ticket / product purchase | user's proxy, then spent on the product | buyer | only with new code |
| Marketplace purchase | user's proxy, then to the seller | buyer | only with new code |
| Direct token purchase | straight to the user's own wallet | buyer | **no** — nothing held |
| Off-chain service purchase | to the integrator, then its treasury | buyer | **no** — user holds nothing |
| Merchant terminal | custody, time-locked, strict accounting | **the shop** | **no** — breaks solvency |

Three are structurally impossible, not merely inconvenient. The merchant-terminal case is the clearest: merchant funds sit in time-locked buckets under `usdc.balanceOf(this) >= totalOwed`. Crediting a bucket raises `totalOwed` with no matching USDC arriving (breaks solvency); crediting without touching it corrupts the bucket accounting. Either way is wrong.

Paying from a separate funding wallet **after** settlement completes works uniformly for all of them, needs no integrator cooperation, and can never interfere with a payment.

---

## Roles

| Role | Can | Cannot |
|---|---|---|
| **Registry admin** | assign integrator owners, manage watchers, `emergencyStop` a campaign | create campaigns, change a rate, spend anyone's tokens |
| **Integrator owner** | create / activate / pause / retune / end campaigns for **their** integrator, funded from **their** wallet | touch another integrator's campaigns |
| **Watcher** | report completed orders | anything else — every report is re-verified on-chain |

`emergencyStop` can only **pause or end**. Stopping something abusive is a safety power; changing where an owner's money goes is not.

### Onboarding an integrator

One transaction from an admin:

```solidity
setIntegratorOwner(integratorAddress, ownerWallet)
```

After that the owner is fully self-service:

```solidity
token.approve(registry, amount)     // their tokens, their approval
createCampaign(...)                 // starts as a draft
activate(campaignId)                // live
```

---

## Trust model

The watcher is an off-chain service, and it is **not trusted**. Every report is re-read from the Diamond via `getOrdersById` and must match on order existence, COMPLETED status, user, and amount. The reward recipient is taken from the Diamond's record, never from the report.

| If the watcher… | Result |
|---|---|
| reports a fake order | verification fails → nothing paid |
| inflates an amount | amount read from the Diamond, not the report |
| reports one order twice | `orderPaid` makes it a no-op |
| names the wrong user | recipient read from the Diamond |
| crashes or stops | resumes from its cursor and backfills — **delayed, never lost** |

Its only real power is **omission** — it can delay reporting, not steal, inflate, or misdirect. Anyone can run a second watcher to backfill what a first one missed.

---

## Campaign lifecycle

| Status | Pays | Notes |
|---|---|---|
| `INACTIVE` | no | created but not started |
| `ACTIVE` | yes | running |
| `PAUSED` | no | stopped, resumable; frees the lookup slot |
| `ENDED` | no | terminal, cannot be reactivated |

A campaign starts as a **draft**. `activate` is a deliberate second step so a half-configured campaign can never pay out.

The rate is changeable while running via `setRate` — the core experiment knob:

```
Week 1   activate at 1%
Week 2   pause → setRate(200) → activate      // 2%
Week 3   compare order volume
Week 4   keep, retune, or end
```

**Kill switches, fastest first:**

1. **Revoke the funding wallet's token approval** — instant, halts that wallet's campaigns, no registry transaction
2. `pause(campaignId)` — the owner stops one campaign
3. `emergencyStop(campaignId, permanent)` — a registry admin stops an abusive campaign
4. Funding wallet runs empty — payouts emit `PayFailed` and stop on their own, retryable after top-up

---

## Campaign resolution

Looked up by `(integrator, orderType, currency)`, most specific first:

```
integrator + BUY + INR   →   integrator + BUY + ANY   →   integrator + ANY + ANY
```

`ANY` is `bytes32(0)`. One row can cover a whole integrator, with a single cell overridden to run an experiment. At most one campaign is active per triple, so resolution is never ambiguous.

Each tier is checked for **payability** before being resolved to, so a retired campaign cannot shadow a healthy broader one.

---

## Quick start

```bash
cd cashback
npm install
npx hardhat compile
npx hardhat test
```

### Deploy

```bash
DIAMOND_ADDRESS=0x… \
  npx hardhat run scripts/deploy-cashback.ts --network baseSepolia
```

Then per integrator (admin):

```bash
REGISTRY_ADDRESS=0x… INTEGRATOR=0x… OWNER=0x… \
  npx hardhat run scripts/set-integrator-owner.ts --network baseSepolia
```

### Create a campaign (integrator owner)

```bash
REGISTRY_ADDRESS=0x… \
INTEGRATOR=0x… \
REWARD_TOKEN=0x… \
ORDER_TYPE=BUY CURRENCY=INR RATE_BPS=100 \
  npx hardhat run scripts/create-campaign.ts --network baseSepolia
```

### Run the watcher

```bash
RPC_URL=… REGISTRY_ADDRESS=0x… DIAMOND_ADDRESS=0x… WATCHER_PRIVATE_KEY=0x… \
  npx ts-node services/watcher/watcher.ts
```

### Layout

```
contracts/cashback/CashbackRegistry.sol    the only contract deployed
contracts/interfaces/                      ICashbackRegistry, IOrderFlow
contracts/test/                            mocks (USDC, order source, hostile token)
test/cashback-registry.test.ts             78 tests
scripts/deploy-cashback.ts                 deploy (admin)
scripts/set-integrator-owner.ts            assign an integrator's owner (admin)
scripts/create-campaign.ts                 the five-field form, as a CLI (owner)
services/watcher/watcher.ts                the off-chain daemon
```

---

## Design notes

- **No `owed` ledger, no `claim()`.** Rewards are pushed on verification, so there is no balance to track and nothing for a user to collect later.
- **`pay` returns 0 instead of reverting** when an order does not qualify. Reverting would let one bad row block an entire batch — and a failure inside cashback must never surface as something the protocol has to handle.
- **`orderPaid` is set before the transfer** and rolled back if it fails — so a reentrant token cannot collect twice, and a failed payout stays retryable.
- **Both ERC-20 failure modes are handled**: a reverting `transferFrom` and one that returns `false` without reverting. The second is the subtle one — ignoring it would mark an order paid while no tokens moved.
- **Both rate forms are bounded.** `MAX_BPS` (20%) and `MAX_FLAT_AMOUNT`, neither with a setter. Nobody at any level can configure an unbounded payout.
- **The registry never custodies reward tokens.** They stay in each campaign's own funding wallet until a payout pulls them.
- **Funding wallets are opt-in, not inferred.** A wallet must call `authorizeCampaignFunder` itself, and that authorisation is re-checked on every payout — so revoking stops payouts immediately.
- **Ownership is registered, not read from the integrator.** Integrators do not share an ownership interface — some expose `owner()`, others are multi-owner with `isOwner()` and a super-admin. A registered mapping works uniformly and cannot be spoofed by a look-alike contract.
- **Percentage rewards are a share of USDC bought**, not of local fiat paid.

---

## Audit fixes

An adversarial audit of the multi-tenant logic found four issues, all fixed with a named regression test each.

**Critical — a new integrator owner could drain the previous owner's wallet.** `onlyCampaignOwner` read the owner mapping live, but `setRate` never re-checked the funding wallet, and `flatAmount` had no ceiling. After a handover, the incoming owner could set a huge flat reward and drain a wallet they never controlled — and since admins assign owners, an admin could grant themselves that power.

*Fixed* with an ownership **epoch**: a handover bumps it, retiring every campaign from an earlier epoch (unpayable and unoperable, even by the new owner). O(1), so a handover cannot run out of gas over a large portfolio. Plus `MAX_FLAT_AMOUNT`.

**High — a stray ERC-20 allowance counted as proof of wallet control.** The old check accepted `allowance(fundingWallet, msg.sender) > 0`. It tested the wrong spender (payouts pull as the registry, not the caller), 1 wei of unrelated dust passed it, and it was never re-checked. A third party's treasury that had ever approved you could be attached as your campaign's funding wallet.

*Fixed* with explicit opt-in via `authorizeCampaignFunder`, callable only by the wallet itself and re-verified on every payout.

**High — a retired campaign permanently shadowed a healthy one.** Resolution stopped at the first *occupied* slot regardless of status, so a stale narrow campaign blocked the integrator-wide fallback forever.

*Fixed* — each tier is checked for payability before resolving to it. Fixing this surfaced a follow-on: a retired campaign still held its lookup slot, bricking it for the new owner. Also fixed.

**Medium — enumeration accumulated duplicates** across repeated handovers. *Fixed* with a seen-set.

Verified as safe, not bugs: the `payBatch` self-call grants no privilege escalation (the only path producing `msg.sender == address(this)` is `payBatch`, which itself requires accruer); and the replay accounting has no path that pays without setting `orderPaid`, or sets it without moving tokens.

---

## Notes for operators

- **Merchant terminals pay the shop, not the customer.** Where the merchant's wallet places the order (as in payqr), the merchant is `order.user` — the customer pays fiat off-chain and has no wallet at all, so there is no customer address on-chain to pay. This is a merchant rebate.
- **Self-dealing on merchant terminals.** A merchant is both payer and reward recipient, so repeated self-sales could farm cashback cheaply. Mitigate off-chain with a per-merchant daily cap or a volume threshold before running a live campaign.
- **Integrator upgrades need a new campaign row.** Integrators are immutable and get replaced rather than upgraded; the old campaign stops earning by itself once orders stop flowing through the old address.
- **USDT cannot be used as a reward token.** It returns no data from `transferFrom`, so the decode fails and the payout lands in the catch branch — fail-closed, but it will never pay. Any standard ERC-20 is fine.
- **Reward token choice is still open.** `UserProxy.sweepERC20` restricts only the integrator's own `usdc()`; every other token is unrestricted. A points/partner token therefore carries no proxy complications. Paying USDC into a user wallet reaches the same end state the restriction exists to control (fiat → USDC → wallet), so it is worth confirming with whoever owns the fraud model before a USDC-denominated campaign.
