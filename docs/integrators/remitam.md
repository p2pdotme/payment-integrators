# Remitam

`RemitamIntegrator` is a P2P.me B2B integrator for
[Remitam](https://remitam.app), a fiat→fiat remittance app. Users send local
fiat and receive local fiat on the other side; they never see or hold USDC.
Every on-chain wallet is a **backend-controlled thirdweb server wallet**,
owner-whitelisted, that places both the BUY leg (fiat in → USDC) and one or
more concurrent SELL legs (USDC → fiat out) on a user's behalf. Large
remittances are split **off-chain** into several legs (e.g. a $500 remittance
becomes a $300 leg + a $200 leg) because a single merchant often lacks
liquidity for the full amount; `MAX_CONCURRENT_SELLS = 8` bounds that fan-out
per wallet.

**All buy/sell limits (per-tx, daily volume, daily order count) are enforced
server-side by the Remitam backend, before it ever signs and submits an
order.** The contract carries no limit state, ceilings, or admin function for
them. The only on-chain gate is the owner-managed whitelist of
backend-controlled server wallets — see [Limits model](#limits-model) below.

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

Order flow (whitelisted server wallets):

- `userPlaceBuyOrder(amount, currency, pubKey, circleId, preferredPaymentChannelConfigId, fiatAmountLimit) → orderId` — place a BUY leg (fiat → USDC). Deploys the wallet's `UserProxy` on first use. USDC settles straight to `msg.sender` (`recipientAddr` pinned to the caller).
- `userStartSell(principal, currency, userPubKey, circleId, preferredPaymentChannelConfigId, fiatAmountLimit) → orderId` — phase 1 of a SELL leg: places the order (`order.user` = the wallet's proxy) so the Diamond matches a merchant. No USDC moves yet. Reverts `TooManyActiveSells` past `MAX_CONCURRENT_SELLS`.
- `deliverPayout(orderId, string encPayout)` — phase 2 of a SELL leg: reads the Diamond's computed fee, pulls the shortfall (`principal + fee` less whatever already sits on the proxy) from the wallet **just-in-time, in this same transaction**, then calls `setSellOrderUpi` to deliver the encrypted payout handle and trigger the Diamond's USDC pull. The wallet only needs a standing `approve(integrator, ...)` — no pre-transfer to the proxy. Callable by the leg's wallet or the owner (keeper). Reverts `FeeNotReady` / `InsufficientFunding` (the wallet's balance or allowance can't cover the shortfall) / `SellLegNotFound` / `NotAuthorized`.
- `reconcile(orderId)` — permissionless settlement of a terminal (COMPLETED or CANCELLED) SELL leg: frees the wallet's concurrency slot and sweeps any USDC left on the proxy back to the wallet. On a CANCELLED leg that shows a raised or settled dispute, reverts `DisputedOrder` instead — a dispute means fiat may have been delivered despite the on-chain CANCELLED status, so that leg is left for manual/ops resolution rather than auto-released. Reverts `SellLegNotFound` / `NotTerminal` / `AlreadyReconciled` / `DisputedOrder`.

Diamond callbacks (`onlyDiamond`):

- `validateOrder(user, amount, currency) → bool` — the sole on-chain gate: resolves `user` to its accountable wallet (the wallet itself for BUYs, `proxyOwner[user]` for SELLs) and checks it against the whitelist. `amount` is accepted but not checked here — no volume/count accounting happens on-chain; sizing is entirely the backend's responsibility (see [Limits model](#limits-model)).
- `onOrderComplete(orderId, user, amount, recipientAddr)` — closes a BUY session and emits `LegCompleted`. Tolerates unknown/already-closed orderIds (SELL completions are observed via `reconcile`, not this callback).
- `onOrderCancel(orderId)` — closes a BUY session and emits `LegCancelled`. Tolerates unknown/already-closed orderIds.

Views:

- `proxyAddress(user)`, `whitelisted(account)`, `proxyOwner(proxy)`, `buySessions(orderId)`, `sellLegs(orderId)`, `activeSellCount(wallet)`, `proxyImpl()`, `diamond()`, `usdc()`, `owner()`.

## Limits model

**All buy/sell limits live in the Remitam backend, not on-chain.** The
backend enforces per-tx caps, daily volume caps, and daily order-count caps
against its own ledger _before_ it ever signs and submits an order through a
server wallet — the same wallet that must already be on the on-chain
whitelist to place anything at all. `RemitamIntegrator` carries no limit
state (no ceilings, no adjustable caps, no `setLimits`), and `validateOrder`
performs no volume or count accounting.

|                                              | Enforced in                                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Per-transaction / daily volume / daily count | Remitam backend (off-chain, before the order is ever signed)                             |
| Which wallets may transact at all            | `whitelisted` mapping — checked in `validateOrder`, `userPlaceBuyOrder`, `userStartSell` |
| Concurrent SELL legs (per wallet)            | `MAX_CONCURRENT_SELLS = 8` — enforced in `userStartSell`                                 |

Every order that reaches the contract can only ever have originated from a
backend-controlled key, so the whitelist doubles as the effective circuit
breaker: if a server wallet's signing key is ever compromised, `removeAccount`
immediately blocks it from placing further orders (in-flight legs still wind
down normally — see `removeAccount` above). There is deliberately no on-chain
per-tx or daily cap left to bypass or misconfigure; the tradeoff is that the
contract fully trusts the backend's own limit sizing and accounting.

**SELL fees are pulled on top of the principal, not out of it.**
`deliverPayout` pulls `principal + fee` in USDC from the wallet, so the actual
USDC outflow for a leg exceeds the SELL's stated principal by its fee. Since
limit sizing now lives entirely in the backend, the backend must account for
that fee headroom when sizing its per-tx / daily-volume budgets — treating the
principal alone as the full outflow will under-provision the wallet's funding
and can trip `InsufficientFunding` at `deliverPayout` time.

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
  griefed into freeing a concurrency slot or sweeping funds for a leg that
  is still in flight.

## Deploy

```bash
DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x... \
  npx hardhat run scripts/local/deploy-remitam.ts --network baseSepolia
```

Whitelist the **integrator** with `usdcThroughIntegrator = false`, alongside
the pinned `proxyImpl` (see [WHITELISTING.md](../WHITELISTING.md)).

## Maintainer contact

dev@p2p.me · Remitam: engineering@remitam.app
