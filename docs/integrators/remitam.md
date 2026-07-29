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

| | Base Mainnet | Base Sepolia |
|---|---|---|
| P2P Diamond | `<TBD>` | `<TBD>` |
| USDC | `<TBD>` | `<TBD>` |
| Integrator | `<TBD after deploy>` | `<TBD after deploy>` |

## Contract surface

Whitelist admin (owner-only):

- `addAccount(address account)` — whitelist a server wallet. Reverts `InvalidAddress` on the zero address.
- `removeAccount(address account)` — de-whitelist a server wallet (no-op if it was never whitelisted).

Limits admin (owner-only):

- `setLimits(uint256 txLimit, uint256 dailyVolumeLimit, uint256 dailyCountLimit)` — lower (never raise past the immutable ceilings) the per-tx cap, daily volume cap, and daily order-count cap.

Order flow (whitelisted server wallets):

- `userPlaceBuyOrder(amount, currency, pubKey, circleId, preferredPaymentChannelConfigId, fiatAmountLimit) → orderId` — place a BUY leg (fiat → USDC). Deploys the wallet's `UserProxy` on first use. USDC settles straight to `msg.sender` (`recipientAddr` pinned to the caller).
- `userStartSell(principal, currency, userPubKey, circleId, preferredPaymentChannelConfigId, fiatAmountLimit) → orderId` — phase 1 of a SELL leg: places the order (`order.user` = the wallet's proxy) so the Diamond matches a merchant. No USDC moves yet. Reverts `TooManyActiveSells` past `MAX_CONCURRENT_SELLS`.
- `deliverPayout(orderId, string encPayout)` — phase 2 of a SELL leg: reads the Diamond's computed fee, requires the wallet's proxy to already hold `principal + fee`, then calls `setSellOrderUpi` to deliver the encrypted payout handle and trigger the Diamond's USDC pull. Callable by the leg's wallet or the owner (keeper). Reverts `FeeNotReady` / `ProxyUnderfunded` / `SellLegNotFound` / `NotAuthorized`.
- `reconcile(orderId)` — permissionless settlement of a terminal (COMPLETED or CANCELLED) SELL leg: frees the wallet's concurrency slot, releases the daily-limit debit on cancellation, and sweeps any USDC left on the proxy back to the wallet. Reverts `SellLegNotFound` / `NotTerminal` / `AlreadyReconciled`.

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

| | Ceiling (immutable) | Adjustable | Enforced in |
|---|---|---|---|
| Per-transaction | `txLimitCeiling` | `txLimit` | `validateOrder` |
| Daily volume (per wallet, UTC day) | `dailyVolumeCeiling` | `dailyVolumeLimit` | `validateOrder` |
| Daily order count (per wallet, UTC day) | `dailyCountCeiling` | `dailyCountLimit` | `validateOrder` |
| Concurrent SELL legs (per wallet) | `MAX_CONCURRENT_SELLS = 8` | not adjustable | `userStartSell` |

Both BUY and SELL legs debit the same per-wallet daily volume/count buckets at
`validateOrder` time (a SELL resolves `order.user` — the wallet's proxy — back
to the owning wallet via `proxyOwner`). A cancelled BUY (`onOrderCancel`) or a
CANCELLED SELL (`reconcile`) releases its debit; a COMPLETED SELL keeps it,
since it consumed real merchant capacity.

## Funding model

BUY legs need no pre-funding: the Diamond assigns a merchant and settles USDC
straight to the calling wallet. SELL legs are funded **just-in-time**:

1. `userStartSell` places the order with no USDC movement.
2. Once the Diamond accepts and computes its fee, the server wallet transfers
   `actualUsdtAmount` (principal + fee, read from
   `getAdditionalOrderDetails`) of USDC to its own proxy — a plain ERC-20
   transfer, immediately before calling `deliverPayout`.
3. `deliverPayout` requires the proxy already hold that exact amount, then
   pulls it via `setSellOrderUpi`.

**Fund-and-deliver one leg at a time, and reconcile cancelled legs before
funding the next.** All of a wallet's SELL legs share a single proxy, and
`reconcile`'s sweep takes the *whole* USDC balance sitting on that proxy —
funding for a sibling leg would be swept up in a sibling leg's reconciliation.
This is not a loss (the swept funds return to the same wallet), but it breaks
the 1:1 funding-to-leg accounting the keeper depends on, so the backend must
serialize funding per wallet: fund leg N, deliver leg N, and — if leg N was
cancelled — reconcile it before funding leg N+1.

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
