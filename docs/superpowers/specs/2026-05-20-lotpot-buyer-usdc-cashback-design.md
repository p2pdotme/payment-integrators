# LotPot Buyer USDC Cashback — Design

**Date:** 2026-05-20
**Status:** Draft (pending implementation plan)
**Repos touched:** `contracts-v4`, `payment-integrators`
**Repos not touched:** `subgraph` (event additions only, no schema migration), `user-app-spa` (display-only)

## 1. Goal

Run a growth campaign that nudges non-B2B P2P users into LotPot by issuing a **2% USDC cashback** on every completed non-B2B P2P BUY order. The cashback lands on the user's LotPot `UserProxy` so it can be consumed only as Megapot lottery tickets, mirroring how the existing LotPot credit-netting flow already works for skipped fulfillments.

**Non-goals:**
- Cashback for B2B BUY orders (already routed via an integrator — separate flow).
- Cashback for SELL or PAY orders (PAY already has its own cbBTC cashback; SELL is out of scope).
- A generic "user credit ledger" inside the Diamond — explicitly rejected to avoid coupling ReputationManager / Diamond to per-integrator semantics.

## 2. Why this shape

- **Symmetric to the cbBTC PAY cashback flow** (`OrderFlowHelper.handleCashback`) — same hook style, same paymaster (`ReputationManager.transferCashback`), same `orderCashback[orderId]` storage slot. Reviewers can apply the same mental model.
- **No quoter** — cashback token equals settlement token (both USDC), so the Uniswap V3 quoter branch is dropped. Cheaper gas, simpler error surface.
- **No ReputationManager changes** — RM is already whitelisted for `transferCashback` and is token-agnostic. The treasury pre-funds USDC on RM the same way it pre-funds cbBTC today.
- **Credit lives at the LotPot proxy address, not in a Diamond ledger.** The LotPot integrator's existing `_route` auto-nets `usdc.balanceOf(proxyAddress(user))` against new ticket purchases. By depositing cashback directly to that address, no LotPot-side redemption logic changes.
- **Mixing of cashback USDC with pre-paid stranded USDC on the proxy is intentional.** Both buckets share the same recovery primitive (a deployer-only `sweepStale` after 90 days of proxy inactivity), which handles three cases with a single mechanism:
  - Abandoned promotional cashback (user never engaged with LotPot).
  - Pre-paid USDC stranded by a skipped fulfillment that the user never returned to redeem.
  - **Fraud residue** — USDC minted from a fiat payment that was later reversed by the bank (chargebacks typically resolve in 60–90 days, so 90 is calibrated to this).

## 3. Architecture

```
P2P BUY order (non-B2B) completes
    │
    ▼
OrderFlowHelper.completeOrder
    ├─ existing: l.usdt.safeTransfer(order.recipientAddr, order.amount)
    └─ NEW: handleLotpotBuyerCashback(orderId)
              │
              ├─ read P2pConfigStorage.lotpotBuyerCashbackConfig
              │        { percentageBps, lotpotIntegrator }
              ├─ if disabled → return
              ├─ amount = order.amount * percentageBps / 10_000
              ├─ proxy = ILotpotProxyResolver(lotpotIntegrator).proxyAddress(user)
              ├─ try ReputationManager.transferCashback(usdt, proxy, amount)
              │      try ILotpotProxyNotifier(proxy).notifyCashbackCredit()
              │            → orderCashback[orderId] = { amount, token: usdt }
              │            → emit BuyerLotpotCashback(orderId, user, proxy, amount)
              │      catch  → emit CashbackTransferFailed(orderId, usdt, amount)
              └─ catch       → emit CashbackTransferFailed(orderId, usdt, amount)
```

```
LotPot V2 (new deploy)
    ├─ LotPotCheckoutIntegrator (immutable, new deploy)
    │       + bool public deprecated
    │       + function deprecate() onlyOwner
    │       + event Deprecated()
    │       (unchanged: order placement, _route credit-netting, fulfillment)
    │
    └─ UserProxy (new impl, new clones via new integrator)
            + uint256 private _lastActivityTimestamp  // bumped in initialize, execute, notifyCashbackCredit, sweepStale
            + function notifyCashbackCredit() external onlyDeployerOrDiamond
            + function sweepStale(address to) external onlyDeployer
              guard: IDeprecatable(deployer).deprecated()
                  || block.timestamp >= _lastActivityTimestamp + 90 days
```

## 4. Storage & config additions

### 4.1 `P2pConfigStorage` (contracts-v4)

Append a new field to the `Layout` struct (preserves Diamond storage layout — last slot append is safe):

```solidity
struct LotpotBuyerCashbackConfig {
    uint16 percentageBps;       // 200 = 2%; 0 = feature disabled
    address lotpotIntegrator;   // V2 integrator address; 0 = feature disabled
}

// appended to Layout:
LotpotBuyerCashbackConfig lotpotBuyerCashbackConfig;
```

Sizing rationale: `uint16` covers 0–65535 bps (= 655%), with a setter-enforced ceiling of `MAX_BPS = 1000` (10%) matching the existing cbBTC `cashbackPercentage` ceiling. Two fields fit a single storage slot.

### 4.2 Reused, unchanged

- `OrderProcessorStorage.orderCashback[orderId]` — existing `CashbackInfo { uint128 amount; address token; }`. USDC and cbBTC cashbacks coexist; the `token` field disambiguates.
- `ReputationManager` USDC balance — funded by treasury, drawn down by `transferCashback`.

## 5. Component changes

### 5.1 contracts-v4 — Diamond

**`OrderFlowHelper.sol`**

In `completeOrder`, the existing BUY branch already splits on B2B-integrator presence. Add the cashback hook to the direct (non-B2B) BUY branch only:

```solidity
if (_order.orderType == OrderProcessorStorage.OrderType.BUY) {
    if (B2BGatewayStorage.layout().orderIntegrator[_orderId] != address(0)) {
        IB2BGateway(address(this)).onB2BOrderComplete(_orderId);
    } else {
        l.usdt.safeTransfer(_order.recipientAddr, _order.amount);
        handleLotpotBuyerCashback(_orderId);   // ← NEW
    }
}
```

New internal function (modelled on existing `handleCashback`):

```solidity
function handleLotpotBuyerCashback(uint256 _orderId) internal {
    OrderProcessorStorage.Layout storage l = OrderProcessorStorage.layout();
    OrderProcessorStorage.Order storage _order = l.orders[_orderId];
    P2pConfigStorage.LotpotBuyerCashbackConfig memory cfg =
        P2pConfigStorage.layout().lotpotBuyerCashbackConfig;

    if (cfg.percentageBps == 0 || cfg.lotpotIntegrator == address(0)) return;

    uint256 amount = (_order.amount * cfg.percentageBps)
                     / OrderProcessorStorage.BASIS_POINTS_DENOMINATOR;
    if (amount == 0) return;

    address proxy;
    try ILotpotProxyResolver(cfg.lotpotIntegrator).proxyAddress(_order.user)
        returns (address p) { proxy = p; }
    catch {
        // Pre-transfer failure → emit with 0, matching the cbBTC quoter
        // failure pattern in handleCashback.
        emit CashbackTransferFailed(_orderId, address(l.usdt), 0);
        return;
    }

    try l.reputationManager.transferCashback(address(l.usdt), proxy, amount) {
        // Notify proxy so the activity clock resets for sweep eligibility.
        // Wrapped in try/catch: if the proxy isn't deployed yet (CREATE2
        // address holds USDC without a contract), notify is a no-op and
        // we still record the cashback. Sweep semantics handle the
        // never-deployed case (see §5.2 initialization rule).
        try ILotpotProxyNotifier(proxy).notifyCashbackCredit() {} catch {}
        l.orderCashback[_orderId] = OrderProcessorStorage.CashbackInfo({
            amount: amount.toUint128(),
            token: address(l.usdt)
        });
        emit BuyerLotpotCashback(_orderId, _order.user, proxy, amount);
    } catch {
        emit CashbackTransferFailed(_orderId, address(l.usdt), amount);
    }
}
```

New event:

```solidity
event BuyerLotpotCashback(
    uint256 indexed orderId,
    address indexed user,
    address indexed proxy,
    uint256 amount
);
```

The existing `CashbackTransferFailed` event is reused.

**New interfaces** (`contracts-v4/contracts/interfaces/`):

```solidity
interface ILotpotProxyResolver {
    function proxyAddress(address user) external view returns (address);
}

interface ILotpotProxyNotifier {
    function notifyCashbackCredit() external;
}
```

These are intentionally narrow — two single-function interfaces with no cross-imports from `payment-integrators`. Keeps the two repos decoupled.

**`SetterFacet.sol`** — add a super-admin setter:

```solidity
event LotpotBuyerCashbackConfigUpdated(uint16 percentageBps, address indexed lotpotIntegrator);

uint16 constant MAX_BUYER_CASHBACK_BPS = 1000; // 10% ceiling, mirrors cbBTC

function setLotpotBuyerCashback(uint16 _percentageBps, address _lotpotIntegrator)
    external onlySuperAdmin
{
    if (_percentageBps > MAX_BUYER_CASHBACK_BPS) revert Errors.InvalidPercentage();
    // _lotpotIntegrator == address(0) is allowed (disables the feature).
    P2pConfigStorage.layout().lotpotBuyerCashbackConfig =
        P2pConfigStorage.LotpotBuyerCashbackConfig({
            percentageBps: _percentageBps,
            lotpotIntegrator: _lotpotIntegrator
        });
    emit LotpotBuyerCashbackConfigUpdated(_percentageBps, _lotpotIntegrator);
}
```

**`GetterFacet.sol`** — add a getter:

```solidity
function getLotpotBuyerCashbackConfig()
    external view returns (P2pConfigStorage.LotpotBuyerCashbackConfig memory)
{
    return P2pConfigStorage.layout().lotpotBuyerCashbackConfig;
}
```

`orderCashback[orderId]` already has a getter — no change.

### 5.2 payment-integrators — LotPot V2

**`UserProxy.sol`** (new implementation, deployed fresh; existing V1 clones unaffected)

V1 `UserProxy` is built on OpenZeppelin's *immutable args* pattern (`cloneDeterministicWithImmutableArgs`) — there is no `initialize()` function today; per-clone state (`owner`, `integrator`) is encoded in the clone bytecode and read on demand via `Clones.fetchCloneArgs`. V2 keeps the immutable args pattern AND adds a one-shot `initialize()` for the new storage-backed activity clock. V2 integrator's `_ensureProxy` is updated to call it immediately after `Clones.cloneDeterministicWithImmutableArgs`.

```solidity
uint256 private _lastActivityTimestamp;

/// @notice One-shot init called by the V2 integrator right after the
///         clone is deployed. Sets the activity clock anchor.
function initialize() external {
    if (msg.sender != _getDeployer()) revert NotAuthorized();
    if (_lastActivityTimestamp != 0) revert AlreadyInitialized();
    _lastActivityTimestamp = block.timestamp;
}

function execute(...) external onlyDeployer {
    _lastActivityTimestamp = block.timestamp;   // ← NEW (bump on outbound)
    // existing execute body...
}

/// @notice Bumps the activity clock to acknowledge cashback inbound.
///         Callable by the deploying integrator OR by a Diamond address
///         configured at construction. ACL covers the case where the
///         Diamond calls directly (cheaper, simpler) without round-tripping
///         through the integrator.
function notifyCashbackCredit() external {
    // ACL is resolved at call time — V1/V2 UserProxy clones only carry
    // [owner(20)][integrator(20)] in their immutable args (a 40-byte layout
    // that B2BGatewayFacet._predictCloneAddress also hardcodes). The
    // Diamond address is read on demand from the integrator via the
    // IDiamondHolder interface, so it can never disagree with whatever
    // the integrator was deployed against.
    address ig = integrator();
    if (msg.sender != ig && msg.sender != IDiamondHolder(ig).diamond()) {
        revert OnlyIntegrator();
    }
    _lastActivityTimestamp = block.timestamp;
    emit CashbackCredited(block.timestamp);
}

// Existing execute(...) gains one line:
function execute(address target, uint256 value, bytes calldata data)
    external returns (bytes memory)
{
    // ... existing ACL + target-allowlist checks unchanged ...
    _lastActivityTimestamp = block.timestamp;   // ← NEW: bump on outbound activity
    // ... existing low-level call body + return data unchanged ...
}

/// @notice Recovers proxy USDC after 90 days of inactivity OR when the
///         deploying integrator has been deprecated. Destination is at the
///         deployer's discretion (treasury, fraud-recovery wallet, etc.).
function sweepStale(address to) external onlyDeployer {
    if (to == address(0)) revert InvalidAddress();
    bool unlocked = IDeprecatable(deployer).deprecated()
                    || block.timestamp >= _lastActivityTimestamp + 90 days;
    if (!unlocked) revert SweepLocked();
    uint256 bal = IERC20(_usdc).balanceOf(address(this));
    if (bal == 0) revert NothingToSweep();
    _lastActivityTimestamp = block.timestamp;
    IERC20(_usdc).safeTransfer(to, bal);
    emit SweepStale(to, bal);
}
```

**Initialization rule for never-deployed proxies:** if cashback arrives at the CREATE2 address before the proxy is deployed, `notifyCashbackCredit` is silently no-op (Solidity external call to a code-less address returns success without invoking anything). Sweep eligibility for such a proxy starts when the proxy is eventually deployed (which sets `_lastActivityTimestamp = block.timestamp` in `initialize`). Two deployment paths:

- **Organic:** the user places their first LotPot order. V2's `_ensureProxy` deploys the clone and calls `initialize()`. The user's `execute()` in the same tx bumps the clock again (no-op since same block). User has a fresh 90 days to keep engaging.
- **Admin reclaim:** the deployer calls a new owner-gated entrypoint on the V2 integrator (`adminEnsureProxy(user)`, see below) to materialize the proxy without placing an order. Clock starts at the moment of admin deployment. Deployer then waits 90 days and calls `sweepStale(to)`.

**Operational caveat:** the deployer's pre-deployment patience (e.g., watching `BuyerLotpotCashback` events accumulate for months at a never-touched CREATE2 address) does not count toward the 90-day clock — the clock can only start once the proxy contract exists. For marketing-dollar reclaim this lag is acceptable; a fully-precise version would require either backdated `initialize(anchorTimestamp)` (rejected as added complexity) or Diamond-side first-cashback timestamp storage (rejected as added coupling). Documented in §12.

**`LotPotCheckoutIntegrator.sol` V2** (new immutable deploy)

```solidity
bool public deprecated;
event Deprecated();

function deprecate() external onlyOwner {
    deprecated = true;
    emit Deprecated();
}

/// @notice Materialize a user's proxy without placing an order. Used by
///         ops to start the 90-day sweep clock on a CREATE2 address that
///         has accumulated cashback but the user has never engaged.
function adminEnsureProxy(address user) external onlyOwner returns (address) {
    return _ensureProxy(user);  // existing internal — deploys + initializes
}
```

`_ensureProxy` is updated to call `UserProxy(deployed).initialize()` immediately after `Clones.cloneDeterministicWithImmutableArgs`. The change is one new line; existing order-placement paths flow through the same `_ensureProxy` and so get correct initialization for free.

No constructor changes are needed beyond the existing V1 immutable args (`diamond`, `usdc`, `owner`, `proxyImpl`, `megapot`, `batchFacilitator`, `jackpotNft`). The V2 `UserProxy` does **not** carry the Diamond address in its own immutable args — the clone layout stays `[owner(20)][integrator(20)]` to preserve compatibility with `B2BGatewayFacet._predictCloneAddress` which hardcodes that 40-byte layout. Instead, `notifyCashbackCredit`'s ACL resolves the Diamond at call time via `IDiamondHolder(integrator()).diamond()` — same trust anchor (the integrator's immutable `diamond` getter), zero new state.

**V1 parity — limits and RP gating carried forward unchanged.** V2 inherits V1's `dailyTxCountLimit`, RP-based per-tx USDC ceiling, ball/bonus ranges, ticket price source, and referrer split semantics with identical values and identical enforcement points. The only intentional behavioral additions in V2 are the three listed above (`deprecated` flag + `deprecate()` + the new `UserProxy` features). Any V1 limit or validation that does not appear in this spec is required to be byte-equivalent in V2 — covered by the regression suite in §10.2.

**`IDeprecatable`** — single-function interface, used by UserProxy to read the deprecated flag without importing the integrator type:

```solidity
interface IDeprecatable {
    function deprecated() external view returns (bool);
}
```

## 6. Data flow walkthrough

### 6.1 Happy path

1. User Alice places a P2P BUY order for 100 USDC (non-B2B).
2. Merchant accepts, Alice pays fiat off-chain, merchant marks paid.
3. `completeOrder(orderId)` runs:
   - 100 USDC transferred to Alice's `recipientAddr`.
   - `handleLotpotBuyerCashback(orderId)`:
     - cfg = `{ 200 bps, v2Integrator }`
     - amount = 2 USDC
     - proxy = `v2Integrator.proxyAddress(alice)` — say `0xA…`
     - `RM.transferCashback(usdc, 0xA…, 2e6)` — 2 USDC lands at Alice's V2 proxy address (deployed or not)
     - if proxy is already deployed: `notifyCashbackCredit()` bumps its clock
     - `orderCashback[orderId] = { 2e6, usdc }`
     - `emit BuyerLotpotCashback(orderId, alice, 0xA…, 2e6)`
4. Later, Alice opens LotPot and buys 5 tickets at 1 USDC each (= 5 USDC).
   - LotPot's existing `_route` reads `usdc.balanceOf(alice's V2 proxy) = 2 USDC`.
   - Credit < total → Diamond order placed for delta = 3 USDC.
   - At fulfillment, integrator drives `proxy.execute(megapot, buyTickets, …)` which spends all 5 USDC from the proxy → bumps `_lastActivityTimestamp`.

### 6.2 Abandoned cashback (sweep) — user did engage at least once

1. Alice bought one LotPot ticket on day 0; her proxy is deployed and `_lastActivityTimestamp = day 0`.
2. Day 30: she earns 2 USDC cashback from a P2P BUY. `notifyCashbackCredit` bumps `_lastActivityTimestamp = day 30`.
3. Days 30–120: no further activity.
4. Day 120: deployer calls `proxy.sweepStale(treasuryWallet)`. Guard passes (120 ≥ 30 + 90). 2 USDC → treasury.

### 6.2b Abandoned cashback (sweep) — user never engaged

1. Bob earns 2 USDC cashback on day 0. His CREATE2 proxy address has no contract. USDC sits idle.
2. `notifyCashbackCredit` was silently no-op when the Diamond tried it (no code at the address).
3. Days 0–N: deployer monitors `BuyerLotpotCashback` events. Bob remains inactive.
4. Day N: deployer decides to reclaim. Calls `v2Integrator.adminEnsureProxy(bob)`.
   - V2 `_ensureProxy` deploys the clone and calls `initialize()`. `_lastActivityTimestamp = day N`.
5. Day N + 90: deployer calls `proxy.sweepStale(treasuryWallet)`. Guard passes. 2 USDC → treasury.

Note: deployer's wait *before* day N (steps 3) does not count toward the 90-day clock — see §5.2 operational caveat.

### 6.3 Fraud reversal (sweep)

1. Mallory does a fraudulent fiat payment for a BUY order. 100 USDC transferred to Mallory's `recipientAddr` (her own EOA). Cashback = 2 USDC to her V2 proxy.
2. Mallory uses her 100 USDC for any purpose (LotPot or elsewhere). 2 USDC cashback sits on proxy.
3. Day 30: bank reverses the fiat. Protocol has a 100 USDC loss on the order itself (out of scope for this design — handled by existing dispute/reversal flow). The 2 USDC cashback also represents protocol loss.
4. Day 90+ since `_lastActivityTimestamp`: deployer sweeps the 2 USDC to a fraud-recovery wallet.

Note: this only recovers the **cashback portion**. The 100 USDC payout itself is on Mallory's EOA and outside this design's recovery surface.

### 6.4 V1 user earning cashback for the first time

1. Bob has 5 USDC stranded on his **V1** UserProxy from a skipped fulfillment last quarter.
2. Bob places a non-B2B P2P BUY for 50 USDC. Cashback = 1 USDC.
3. Cashback resolves via `v2Integrator.proxyAddress(bob)` = a **different** address (call it Bob_V2). 1 USDC lands at Bob_V2.
4. Bob now has two pots: 5 USDC at Bob_V1, 1 USDC at Bob_V2. He cannot combine them in a single LotPot purchase.
5. Bob's options:
   - Buy a small ticket via V1 to drain Bob_V1 (V1 `_route` works as before).
   - Buy via V2 to consume Bob_V2 credit.
   - Eventually V1 may be `deprecate()`d and Bob_V1's balance swept to treasury (90 days post-cutover if V2-and-only-V2 is the policy).

Accepted side effect of the immutable redeploy. Documented in the user-facing LotPot release notes.

## 7. Error handling

| Failure | Behavior |
|---|---|
| Config disabled (`percentageBps == 0` or `lotpotIntegrator == 0`) | Silent return, no event. Feature simply off. |
| `cashbackAmount == 0` (dust order) | Silent return, no event. |
| `proxyAddress(user)` reverts (bad integrator address) | `emit CashbackTransferFailed`, order completion succeeds. |
| `RM.transferCashback` reverts (RM underfunded, paused, etc.) | `emit CashbackTransferFailed`, order completion succeeds. |
| `notifyCashbackCredit` reverts (proxy not deployed) | Caught; cashback still recorded; no failure event. |
| `notifyCashbackCredit` reverts (proxy deployed but other reason) | Caught; cashback still recorded. Risk: future sweep window may be unexpectedly short. Acceptable tradeoff — `notifyCashbackCredit` failure is a config bug we'll catch in monitoring. |
| `sweepStale` called before unlock | Revert `SweepLocked()`. |
| `sweepStale` called on empty proxy | Revert `NothingToSweep()`. |

Soft-fail philosophy matches the existing cbBTC flow: a cashback transfer hiccup must never block order completion (which has already moved real fiat).

## 8. Events for indexers

New (Diamond):
- `BuyerLotpotCashback(uint256 indexed orderId, address indexed user, address indexed proxy, uint256 amount)`
- `LotpotBuyerCashbackConfigUpdated(uint16 percentageBps, address indexed lotpotIntegrator)`

Reused (Diamond):
- `CashbackTransferFailed(uint256 indexed orderId, address cashbackToken, uint256 tokenAmount)`

New (LotPot UserProxy):
- `CashbackCredited(uint256 timestamp)`
- `SweepStale(address indexed to, uint256 amount)`

New (LotPot Integrator V2):
- `Deprecated()`

Subgraph: add handlers for `BuyerLotpotCashback` and `LotpotBuyerCashbackConfigUpdated`. No new entities required — extend the existing cashback entity with a `kind` enum (`CBBTC_PAY | USDC_BUY`) discriminated by event source.

## 9. Admin & ops surface

| Operation | Caller | Function | Notes |
|---|---|---|---|
| Enable / disable cashback | super-admin | `Diamond.setLotpotBuyerCashback(bps, integrator)` | Set bps=0 or integrator=0 to disable. |
| Change cashback rate | super-admin | same | Capped at 1000 bps (10%). |
| Re-target to a new LotPot integrator | super-admin | same | Cashbacks for new orders flow to new integrator immediately. |
| Fund cashback pool | treasury | ERC20 transfer to `ReputationManager` | Same procedure as cbBTC top-up. |
| Recover stale USDC from a proxy | LotPot deployer | `userProxy.sweepStale(to)` | After 90d inactivity OR `deprecate()`. |
| Materialize a never-engaged user's proxy to start its sweep clock | LotPot owner | `integrator.adminEnsureProxy(user)` | One-shot per user; deploys + initializes clone. |
| Sunset an integrator version | LotPot owner | `integrator.deprecate()` | Unlocks sweep immediately for all proxies under that integrator. |

## 10. Testing strategy

### 10.1 contracts-v4 (Hardhat)

Unit tests (extend existing `OrderFlowHelper` / cashback suites):
- Cashback fires on non-B2B BUY completion, correct amount, correct destination.
- Cashback skipped on B2B BUY (integrator set).
- Cashback skipped on SELL.
- Cashback skipped on PAY (which still uses existing cbBTC path).
- Cashback skipped when config disabled (each disable variant).
- Cashback skipped when amount rounds to 0.
- Soft-fail when RM is underfunded — order completes, event emitted.
- Soft-fail when `proxyAddress` reverts.
- `notifyCashbackCredit` no-op tolerated (proxy not deployed) — cashback recorded.
- `orderCashback[orderId]` populated with correct `{amount, token=usdc}`.
- `setLotpotBuyerCashback` access control + bps ceiling + event.
- Integration test: cbBTC PAY cashback and USDC BUY cashback coexist for the same user without interfering.

Mocks:
- `MockLotpotProxyResolver` returns a configurable address (or reverts).
- `MockLotpotProxyNotifier` reverts/succeeds on `notifyCashbackCredit`.

### 10.2 payment-integrators (Hardhat)

Unit tests on `UserProxy`:
- `_lastActivityTimestamp` set on `initialize`.
- `execute` bumps timestamp.
- `notifyCashbackCredit` bumps timestamp; ACL enforced (only deployer / configured diamond).
- `sweepStale` reverts before 90 days, succeeds after.
- `sweepStale` succeeds immediately when `deprecate()` flag is set.
- `sweepStale` transfers full proxy USDC balance to specified `to`.
- `sweepStale` ACL: only deployer.
- `sweepStale` rejects `to == address(0)` and empty-balance proxies.

Unit tests on V2 integrator:
- `deprecate()` access control, idempotent, event.
- `proxyAddress(user)` deterministic and matches `Clones.predictDeterministicAddress`.
- Existing V1 test suite re-runs green on V2 (no regressions in order placement / fulfillment / credit netting).

End-to-end test:
- Place P2P BUY → complete → cashback lands at V2 proxy → place LotPot ticket → `_route` consumes cashback as credit, Diamond order placed for delta.

## 11. Deployment & rollout

Sequence (Base mainnet):

1. **contracts-v4 Diamond upgrade**
   - Deploy new `OrderFlowHelper`, `SetterFacet`, `GetterFacet` facets.
   - Cut new selectors via Diamond cut: add `setLotpotBuyerCashback`, `getLotpotBuyerCashbackConfig`; replace `completeOrder` selector (now calls `handleLotpotBuyerCashback`).
   - **Feature stays dormant** until step 5 — `lotpotBuyerCashbackConfig` defaults to zero values.

2. **payment-integrators**
   - Deploy new `UserProxy` implementation.
   - Deploy `LotPotCheckoutIntegrator` V2 wired to: new `UserProxy` impl, current Diamond, current Megapot, current Batch Facilitator.
   - V2 starts with `deprecated == false`.

3. **Frontend cutover** (LotPot SPA / mini-app)
   - Switch ticket placement to V2 integrator address.
   - Add UI surface for "LotPot credit available" reading `v2Integrator.proxyAddress(user)` balance (LotPot already exposes `availableCredit`; will read V2 once frontend points at V2).

4. **Treasury funding**
   - Transfer initial USDC budget to `ReputationManager`.
   - Recommend a starting balance sized for ~2 weeks of expected BUY volume × 2% × safety margin; top up on a recurring cadence.

5. **Activate cashback**
   - Super-admin calls `Diamond.setLotpotBuyerCashback(200, v2IntegratorAddress)`.
   - Monitor `BuyerLotpotCashback` and `CashbackTransferFailed` events for the first 24h.

6. **Subgraph deploy**
   - Ship updated subgraph with new event handlers in parallel with step 1.

V1 stays operational indefinitely as a redemption-only endpoint for users with stranded V1 credit. Optional future cleanup: call `v1Integrator.deprecate()` and sweep all V1 proxies.

**Sunset communication policy (when calling `deprecate()` on V2 some day):** `deprecate()` instantly unlocks `sweepStale` on every V2 proxy. A user mid-placement can race the sweep — if the sweep tx lands before their `_route` reads `usdc.balanceOf(proxy)`, they lose their credit. Recommended ops practice: announce sunset publicly with ≥7 days lead time so credit-holding users can drain their balances by buying tickets. The contract has no on-chain timelock on `deprecate()`; the policy is operational.

## 12. Open questions / explicit non-decisions

- **V1 stranded credit migration:** explicitly **not** addressed in this design. V1's immutability blocks an on-contract migration. If material balances exist, a separate plan can offer V1 users a one-time "burn-and-credit" UX via an off-chain attestation, but it's out of scope here.
- **Cashback to recipient vs. order user:** the design credits `order.user`, not `order.recipientAddr`. Rationale: the *buyer* is the user the campaign is targeting; recipient may be a third-party wallet the user wanted USDC sent to. If product wants the opposite, change one line.
- **Per-user lifetime cap:** explicitly rejected (Q3 in brainstorming). Add later if abuse patterns emerge.
- **Global budget cap:** explicitly rejected (Q3). Soft cap is RM USDC balance — when RM runs dry, cashback soft-fails until refunded.
- **Backdated initialize anchor for never-engaged sweep:** considered and rejected. Would let the deployer pass an `anchorTimestamp` to `initialize()` matching the first cashback's arrival time, eliminating the 90-day double-wait for never-engaged proxies. Rejected because (i) the deployer is already a fully-trusted role (sweep destination unrestricted, `deprecate()` available), so the savings are operational, not security, and (ii) keeping `initialize()` parameter-less keeps the V2 surface minimal. Revisit if the operational lag becomes painful.
- **No backfill for soft-failed cashbacks:** if `RM.transferCashback` reverts (RM underfunded, paused, etc.), the user's order completes successfully but their cashback is lost. Topping up RM later does not retroactively compensate the affected user. This mirrors the existing cbBTC behavior in `handleCashback`. Operationally, monitor `CashbackTransferFailed` events and refill RM before they accrue.
- **Cancel-and-recover order flow:** `OrderFlowHelper.completeOrder` retains a CANCELLED-BUY → admin-reopen-to-PAID branch from V1. In theory a re-completion through this path would re-fire cashback (no `orderCashback[orderId].amount != 0` guard). This is **not addressed** in the new handler because the cancel-recover admin path is operationally deprecated — admins do not exercise it. The same exposure pre-exists in `handleCashback` (cbBTC) and is treated the same way.
