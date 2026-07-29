# Remitam

`RemitamIntegrator` is a P2P.me B2B integrator for
[Remitam](https://remitam.app), a fiat→fiat remittance app. Users send local
fiat and receive local fiat on the other side; they never see or hold USDC.
Every on-chain wallet is a **backend-controlled thirdweb server wallet**,
owner-whitelisted (option-A style — see [LIMITS-AND-RP.md](../LIMITS-AND-RP.md)),
that places both the BUY leg (fiat in → USDC) and one or more concurrent SELL
legs (USDC → fiat out) on a user's behalf. Large remittances are split
**off-chain** into several legs (e.g. a $500 remittance becomes a $300 leg +
a $200 leg) because a single merchant often lacks liquidity for the full
amount; `MAX_CONCURRENT_SELLS = 8` bounds that fan-out per wallet.

## External protocols + addresses

No upstream protocol beyond the P2P Diamond.

|             | Base Mainnet         | Base Sepolia         |
| ----------- | -------------------- | -------------------- |
| P2P Diamond | `<TBD>`              | `<TBD>`              |
| USDC        | `<TBD>`              | `<TBD>`              |
| Integrator  | `<TBD after deploy>` | `<TBD after deploy>` |

## Contract surface

Whitelist admin (owner-only):

- `addAccount(address account)` — whitelist a server wallet. Reverts `InvalidAddress` on the zero address.
- `removeAccount(address account)` — de-whitelist a server wallet (no-op if it was never whitelisted). **This blocks new placements only** (`userPlaceBuyOrder` / `userStartSell`, both gated on `whitelisted[msg.sender]`). It does not touch in-flight legs: a removed wallet's existing `SellLeg`s are untouched, and `deliverPayout` (wallet-or-owner) / `reconcile` (permissionless) place no whitelist check on the leg's `user`, so a removed wallet can still deliver and reconcile its own in-flight legs to completion. This is an orderly-wind-down design, not an oversight — it lets ops pull a compromised or offboarded wallet from _new_ volume immediately while letting already-placed remittances settle cleanly instead of getting stuck mid-flight.

Limits admin (owner-only):

- `setLimits(uint256 txLimit, uint256 dailyVolumeLimit, uint256 dailyCountLimit)` — lower (never raise past the immutable ceilings) the per-tx cap, daily volume cap, and daily order-count cap.

Order flow (whitelisted server wallets):

- `userPlaceBuyOrder(amount, currency, pubKey, circleId, preferredPaymentChannelConfigId, fiatAmountLimit) → orderId` — place a BUY leg (fiat → USDC). Deploys the wallet's `UserProxy` on first use. USDC settles straight to `msg.sender` (`recipientAddr` pinned to the caller).
- `userStartSell(principal, currency, userPubKey, circleId, preferredPaymentChannelConfigId, fiatAmountLimit) → orderId` — phase 1 of a SELL leg: places the order (`order.user` = the wallet's proxy) so the Diamond matches a merchant. No USDC moves yet. Reverts `TooManyActiveSells` past `MAX_CONCURRENT_SELLS`.
- `deliverPayout(orderId, string encPayout)` — phase 2 of a SELL leg: reads the Diamond's computed fee, pulls the shortfall (`principal + fee` less whatever already sits on the proxy) from the wallet **just-in-time, in this same transaction**, then calls `setSellOrderUpi` to deliver the encrypted payout handle and trigger the Diamond's USDC pull. The wallet only needs a standing `approve(integrator, ...)` — no pre-transfer to the proxy. Callable by the leg's wallet or the owner (keeper). Reverts `FeeNotReady` / `InsufficientFunding` (the wallet's balance or allowance can't cover the shortfall) / `SellLegNotFound` / `NotAuthorized`.
- `reconcile(orderId)` — permissionless settlement of a terminal (COMPLETED or CANCELLED) SELL leg: frees the wallet's concurrency slot, releases the daily-limit debit on cancellation, and sweeps any USDC left on the proxy back to the wallet. On a CANCELLED leg that shows a raised or settled dispute, reverts `DisputedOrder` instead — a dispute means fiat may have been delivered despite the on-chain CANCELLED status, so that leg is left for manual/ops resolution rather than auto-released. Reverts `SellLegNotFound` / `NotTerminal` / `AlreadyReconciled` / `DisputedOrder`.

Diamond callbacks (`onlyDiamond`):

- `validateOrder(user, amount, currency) → bool` — enforces per-tx / daily-volume / daily-count limits against the resolved wallet (the wallet itself for BUYs, `proxyOwner[user]` for SELLs) and debits the daily buckets.
- `onOrderComplete(orderId, user, amount, recipientAddr)` — closes a BUY session and emits `LegCompleted`. Tolerates unknown/already-closed orderIds (SELL completions are observed via `reconcile`, not this callback).
- `onOrderCancel(orderId)` — releases a BUY leg's daily-limit debit and emits `LegCancelled`. Tolerates unknown/already-closed orderIds.

Views:

- `proxyAddress(user)`, `whitelisted(account)`, `proxyOwner(proxy)`, `dailyVolume(wallet, day)`, `dailyCount(wallet, day)`, `buySessions(orderId)`, `sellLegs(orderId)`, `activeSellCount(wallet)`, `txLimit()` / `dailyVolumeLimit()` / `dailyCountLimit()` and their `*Ceiling()` counterparts, `proxyImpl()`, `diamond()`, `usdc()`, `owner()`.

## Limits model

Ceilings are immutable, set at construction, and reviewed at whitelisting time.
The owner may lower the corresponding adjustable limit at any time via
`setLimits`, but any value above its ceiling reverts `LimitAboveCeiling` — so a
compromised owner key can never authorize more exposure than P2P approved.

|                                         | Ceiling (immutable)        | Adjustable         | Enforced in     |
| --------------------------------------- | -------------------------- | ------------------ | --------------- |
| Per-transaction                         | `txLimitCeiling`           | `txLimit`          | `validateOrder` |
| Daily volume (per wallet, UTC day)      | `dailyVolumeCeiling`       | `dailyVolumeLimit` | `validateOrder` |
| Daily order count (per wallet, UTC day) | `dailyCountCeiling`        | `dailyCountLimit`  | `validateOrder` |
| Concurrent SELL legs (per wallet)       | `MAX_CONCURRENT_SELLS = 8` | not adjustable     | `userStartSell` |

Both BUY and SELL legs debit the same per-wallet daily volume/count buckets at
`validateOrder` time (a SELL resolves `order.user` — the wallet's proxy — back
to the owning wallet via `proxyOwner`). A cancelled BUY (`onOrderCancel`) or a
CANCELLED SELL (`reconcile`) releases its debit; a COMPLETED SELL keeps it,
since it consumed real merchant capacity.

**SELL fees are pulled on top of the principal, not out of it.** `validateOrder`
debits `dailyVolumeLimit` against the SELL _principal_ only (the fee isn't
known until the Diamond accepts the order), but `deliverPayout` pulls
`principal + fee` in USDC. So the actual daily USDC outflow for a wallet can
exceed `dailyVolumeLimit` by the sum of that day's per-leg fees. Size
`dailyVolumeLimit` (and any downstream treasury/liquidity ceilings) with that
headroom in mind rather than treating it as a hard outflow cap.

## Funding model

BUY legs need no pre-funding: the Diamond assigns a merchant and settles USDC
straight to the calling wallet. SELL legs are funded **just-in-time, inside
`deliverPayout` itself**:

1. `userStartSell` places the order with no USDC movement.
2. Once the Diamond accepts and computes its fee, the backend calls
   `deliverPayout(orderId, encPayout)` directly — no pre-transfer step.
   `deliverPayout` reads `actualUsdtAmount` (principal + fee) from
   `getAdditionalOrderDetails`, computes the shortfall against whatever USDC
   already sits on the wallet's proxy (e.g. an unswept refund from a prior
   cancelled leg counts toward funding), and pulls exactly that shortfall from
   the wallet via `safeTransferFrom` in the same transaction — then calls
   `setSellOrderUpi` to complete the pull into the Diamond.
3. The only prerequisite is a standing `usdc.approve(integrator, amount)`
   from the wallet, done once (off the critical path), for at least the
   largest single leg the wallet expects to deliver — not before every leg.

**No pre-transfer, no serialization constraint.** Earlier revisions required
the wallet to transfer `principal + fee` to its proxy before calling
`deliverPayout`, and `reconcile` swept the _whole_ proxy balance on
settlement — since all of a wallet's SELL legs share one proxy, a
permissionless `reconcile` on a cancelled leg A could front-run and sweep
funding parked on the proxy for a not-yet-delivered leg B, forcing the
backend to fund-and-deliver strictly one leg at a time
(precedent: the M-1 fix in `MerchantTerminalIntegrator.sol` rejects the same
whole-balance-absorption pattern). Pulling funds JIT inside `deliverPayout`
removes the parking window entirely: nothing is ever held on the proxy
awaiting a delivery, so `reconcile`'s whole-balance sweep is safe — only
refunds and dust ever land there — and multiple in-flight legs for the same
wallet can be delivered and reconciled in any order, concurrently.

## Registration flags

Register with **`usdcThroughIntegrator = false`**. BUY legs pin
`recipientAddr = msg.sender` (the calling wallet), so settlement USDC already
routes to the wallet without the flag; SELL legs never move USDC to the
integrator either (proxy → Diamond → merchant, and back to the wallet on
reconcile). USDC never accrues on the integrator contract itself.

## Ops runbook (keeper)

A keeper process drives `deliverPayout` and `reconcile` for every wallet:

- **`FeeNotReady`** from `deliverPayout` — the Diamond hasn't computed the
  fee yet (order not yet ACCEPTED / fee not yet set). Retry later; do not
  fund principal-only in the meantime (an underfunded pull auto-cancels the
  order — see below).
- **`PayoutDelivered(orderId, statusAfter)` with `statusAfter == 4`
  (CANCELLED)** — the Diamond's `setSellOrderUpi` silently auto-cancelled
  the pull instead of reverting (it wraps the pull in try/catch). This is
  not surfaced as a revert, so the keeper must watch the emitted status:
  on `4`, call `reconcile(orderId)` to sweep the refund and free the
  concurrency slot, then re-place the leg with `userStartSell` if the
  remittance still needs to go out.
- **Protocol expiry timers** — PLACED expires after **3 min**, ACCEPTED
  after **5 min**, PAID after **10 min** if not advanced. The keeper should
  poll order status and drive `deliverPayout` well inside these windows,
  and treat an expiry the same as any other terminal CANCELLED status:
  `reconcile` then re-place.
- **General loop**: for every active `SellLeg`, once `getOrdersById(orderId).status`
  is terminal (3 = COMPLETED or 4 = CANCELLED), call `reconcile(orderId)` —
  it is permissionless and idempotent-safe (`AlreadyReconciled` guards a
  double call).

## Security notes

- All USDC movements use `SafeERC20`. No upgradeability, no `delegatecall`,
  no `selfdestruct`. Uses the canonical `UserProxy` (not forked) —
  `sweepERC20` blocks the integrator's own USDC; `execute` /
  `transferERC20ToIntegrator` are integrator-only.
- `validateOrder` / `onOrderComplete` / `onOrderCancel` are `onlyDiamond`;
  every user-facing entry point is `nonReentrant`.
- **Accepted deviation (ruled by the owner):** the ECIES-encrypted payout
  handle (`encPayout` — CBU/PIX/Nequi/UPI, etc.) is passed as a calldata
  argument to `deliverPayout` and therefore appears, still ciphertext, in
  `UserProxy.Executed` calldata and event logs when the integrator forwards
  it to the Diamond. This is protocol-standard behavior (every P2P.me SELL
  offramp integrator does the same) — plaintext payout data is never placed
  on-chain, only the encrypted blob, which is unreadable without the
  merchant's relay private key. Not a defect; documented here per the
  owner's review sign-off.
- `reconcile` never trusts a caller-supplied status: it reads
  `getOrdersById(orderId).status` from the Diamond directly, so it cannot be
  griefed into releasing a debit or freeing a slot for a leg that is still
  in flight.

## Deploy

```bash
DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x... \
TX_LIMIT_CEILING=... DAILY_VOLUME_CEILING=... DAILY_COUNT_CEILING=... \
  npx hardhat run scripts/local/deploy-remitam.ts --network baseSepolia
```

Whitelist the **integrator** with `usdcThroughIntegrator = false`, alongside
the pinned `proxyImpl` (see [WHITELISTING.md](../WHITELISTING.md)).

## Maintainer contact

dev@p2p.me · Remitam: engineering@remitam.app
