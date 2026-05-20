# LotPot Buyer USDC Cashback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Issue 2% USDC cashback on completed non-B2B P2P BUY orders, depositing it to the buyer's LotPot V2 `UserProxy` address so it auto-nets against future LotPot ticket purchases via the existing `_route` credit flow.

**Architecture:** Symmetric to the existing cbBTC PAY cashback. On `OrderFlowHelper.completeOrder` for a non-B2B BUY, the Diamond calls `ReputationManager.transferCashback(usdc, proxyAddress(user), amount)`, then pokes the proxy via `notifyCashbackCredit()` to reset its activity clock. LotPot V2 ships a new immutable `LotPotCheckoutIntegratorV2` + new `UserProxyV2` impl (V1 is immutable; cannot be upgraded in-place). `UserProxyV2` adds a `_lastActivityTimestamp` clock bumped on `initialize`, `execute`, and `notifyCashbackCredit`, plus a deployer-only `sweepStale(to)` unlocked by either 90 days of inactivity or the integrator's `deprecate()` flag. ReputationManager is untouched; treasury pre-funds USDC the same way it funds cbBTC.

**Tech Stack:** Solidity 0.8.20+, Hardhat, ethers v6, Chai/Mocha, OpenZeppelin Contracts (Clones, SafeERC20), Diamond proxy (EIP-2535). Two repos: `contracts-v4` (Diamond) and `payment-integrators` (LotPot V2).

**Spec:** `/Users/bytesbuster/cypher/payment-integrators/docs/superpowers/specs/2026-05-20-lotpot-buyer-usdc-cashback-design.md`

---

## File Structure

### contracts-v4 (Diamond)

| File | Change | Responsibility |
|---|---|---|
| `contracts/storages/P2pConfigStorage.sol` | Modify | Append `LotpotBuyerCashbackConfig` struct + storage field |
| `contracts/interfaces/ILotpotProxyResolver.sol` | Create | Diamond-side narrow interface for `proxyAddress(user)` |
| `contracts/interfaces/ILotpotProxyNotifier.sol` | Create | Diamond-side narrow interface for `notifyCashbackCredit()` |
| `contracts/facets/OrderFlowHelper.sol` | Modify | Add `handleLotpotBuyerCashback` + event + hook in `completeOrder` |
| `contracts/facets/SetterFacet.sol` | Modify | Add `setLotpotBuyerCashback` + event |
| `contracts/facets/GetterFacet.sol` | Modify | Add `getLotpotBuyerCashbackConfig` |
| `contracts/test/MockLotpotIntegrator.sol` | Create | Test fixture implementing both interfaces |
| `test/LotpotBuyerCashback.ts` | Create | Hardhat test suite for the new feature |

### payment-integrators (LotPot V2)

| File | Change | Responsibility |
|---|---|---|
| `contracts/base/UserProxyV2.sol` | Create | UserProxy clone target with activity-clock + sweepStale |
| `contracts/integrators/lotpot/LotPotCheckoutIntegratorV2.sol` | Create | V1 + `deprecated` flag + `deprecate()` + `adminEnsureProxy` + `_ensureProxy` calls `initialize()` |
| `test/userproxyV2.test.ts` | Create | Hardhat tests for UserProxyV2 |
| `test/lotpot-integrator-v2.test.ts` | Create | Hardhat tests for V2 integrator + end-to-end cashback flow |

We **add new V2 files alongside V1** rather than modifying V1 source. V1 contracts are immutable on-chain; co-existing source keeps the historical implementation legible and prevents test churn in V1 / ExampleIntegrator suites.

---

## Task 1: Add `LotpotBuyerCashbackConfig` storage

**Files:**
- Modify: `/Users/bytesbuster/cypher/contracts-v4/contracts/storages/P2pConfigStorage.sol`

- [ ] **Step 1: Append the struct and storage field**

Open `P2pConfigStorage.sol`. After the existing `CashbackConfig` struct (line ~42), add:

```solidity
/**
 * @notice Configuration for non-B2B BUY-order USDC cashback to LotPot.
 *         When percentageBps == 0 or lotpotIntegrator == address(0), the
 *         feature is disabled.
 */
struct LotpotBuyerCashbackConfig {
    uint16 percentageBps;       // 200 = 2%; 0 = disabled. Setter caps at 1000 (10%).
    address lotpotIntegrator;   // V2 integrator address; 0 = disabled.
}
```

Then, inside `struct Layout { … }`, append (last position — required to preserve Diamond storage layout):

```solidity
/** @notice LotPot buyer-side USDC cashback configuration. */
LotpotBuyerCashbackConfig lotpotBuyerCashbackConfig;
```

- [ ] **Step 2: Compile**

Run:
```bash
cd /Users/bytesbuster/cypher/contracts-v4 && npx hardhat compile
```

Expected: clean compile, no warnings.

- [ ] **Step 3: Commit**

```bash
cd /Users/bytesbuster/cypher/contracts-v4
git add contracts/storages/P2pConfigStorage.sol
git commit -m "feat(p2p-config): add LotpotBuyerCashbackConfig storage slot"
```

---

## Task 2: Add `ILotpotProxyResolver` interface

**Files:**
- Create: `/Users/bytesbuster/cypher/contracts-v4/contracts/interfaces/ILotpotProxyResolver.sol`

- [ ] **Step 1: Create the interface**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ILotpotProxyResolver
 * @notice Narrow Diamond-side interface used by OrderFlowHelper to
 *         resolve a user's LotPot UserProxy CREATE2 address without
 *         importing types from the payment-integrators repo.
 */
interface ILotpotProxyResolver {
    function proxyAddress(address user) external view returns (address);
}
```

- [ ] **Step 2: Compile**

Run:
```bash
cd /Users/bytesbuster/cypher/contracts-v4 && npx hardhat compile
```

Expected: clean compile.

- [ ] **Step 3: Commit**

```bash
cd /Users/bytesbuster/cypher/contracts-v4
git add contracts/interfaces/ILotpotProxyResolver.sol
git commit -m "feat(interfaces): add ILotpotProxyResolver"
```

---

## Task 3: Add `ILotpotProxyNotifier` interface

**Files:**
- Create: `/Users/bytesbuster/cypher/contracts-v4/contracts/interfaces/ILotpotProxyNotifier.sol`

- [ ] **Step 1: Create the interface**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ILotpotProxyNotifier
 * @notice Narrow Diamond-side interface used by OrderFlowHelper to
 *         bump a LotPot UserProxy's activity clock after depositing
 *         cashback into it.
 */
interface ILotpotProxyNotifier {
    function notifyCashbackCredit() external;
}
```

- [ ] **Step 2: Compile**

Run:
```bash
cd /Users/bytesbuster/cypher/contracts-v4 && npx hardhat compile
```

Expected: clean compile.

- [ ] **Step 3: Commit**

```bash
cd /Users/bytesbuster/cypher/contracts-v4
git add contracts/interfaces/ILotpotProxyNotifier.sol
git commit -m "feat(interfaces): add ILotpotProxyNotifier"
```

---

## Task 4: Add `MockLotpotIntegrator` test fixture

**Files:**
- Create: `/Users/bytesbuster/cypher/contracts-v4/contracts/test/MockLotpotIntegrator.sol`

- [ ] **Step 1: Create the mock**

This contract implements both `ILotpotProxyResolver` and `ILotpotProxyNotifier`. It lets tests script per-user proxy addresses and observe `notifyCashbackCredit` calls. It also supports a "revert" mode for soft-fail tests.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ILotpotProxyResolver } from "../interfaces/ILotpotProxyResolver.sol";

/**
 * @title MockLotpotIntegrator
 * @notice Test fixture. Maps each user to a configurable proxy address,
 *         optionally reverting on lookup. Stores notify call counts so
 *         tests can assert that the Diamond poked the proxy after deposit.
 */
contract MockLotpotIntegrator is ILotpotProxyResolver {
    mapping(address => address) public proxyOf;
    bool public revertOnResolve;

    function setProxy(address user, address proxy) external {
        proxyOf[user] = proxy;
    }

    function setRevertOnResolve(bool v) external {
        revertOnResolve = v;
    }

    function proxyAddress(address user) external view returns (address) {
        if (revertOnResolve) revert("MockLotpotIntegrator: forced revert");
        return proxyOf[user];
    }
}

/**
 * @notice Standalone notifier mock. Counts notify calls so tests can
 *         assert the Diamond's cross-contract call landed.
 */
contract MockLotpotProxy {
    uint256 public notifyCount;
    bool public revertOnNotify;

    function setRevertOnNotify(bool v) external {
        revertOnNotify = v;
    }

    function notifyCashbackCredit() external {
        if (revertOnNotify) revert("MockLotpotProxy: forced revert");
        notifyCount += 1;
    }
}
```

- [ ] **Step 2: Compile**

Run:
```bash
cd /Users/bytesbuster/cypher/contracts-v4 && npx hardhat compile
```

Expected: clean compile.

- [ ] **Step 3: Commit**

```bash
cd /Users/bytesbuster/cypher/contracts-v4
git add contracts/test/MockLotpotIntegrator.sol
git commit -m "test(p2p): add MockLotpotIntegrator + MockLotpotProxy fixtures"
```

---

## Task 5: Add `setLotpotBuyerCashback` to `SetterFacet`

**Files:**
- Modify: `/Users/bytesbuster/cypher/contracts-v4/contracts/facets/SetterFacet.sol`
- Test: `/Users/bytesbuster/cypher/contracts-v4/test/LotpotBuyerCashback.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `test/LotpotBuyerCashback.ts` with the initial setter coverage. Use the existing CashbackOrderFlow harness as a reference for fixture wiring (`__setterGetter`, `admin`, etc.). Minimum first test:

```typescript
import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { deployDiamondForTest } from "./helpers";  // existing helper

describe("LotPot Buyer USDC Cashback — Setter", function () {
  let admin: SignerWithAddress;
  let nonAdmin: SignerWithAddress;
  let setterGetter: any;

  beforeEach(async function () {
    [admin, nonAdmin] = await ethers.getSigners();
    const fixture = await deployDiamondForTest(admin);
    setterGetter = fixture.setterGetter;
  });

  it("sets percentageBps and lotpotIntegrator and emits event", async function () {
    const mockIntegrator = await ethers.deployContract("MockLotpotIntegrator");
    const integratorAddr = await mockIntegrator.getAddress();

    await expect(
      setterGetter.connect(admin).setLotpotBuyerCashback(200, integratorAddr)
    )
      .to.emit(setterGetter, "LotpotBuyerCashbackConfigUpdated")
      .withArgs(200, integratorAddr);

    const cfg = await setterGetter.getLotpotBuyerCashbackConfig();
    expect(cfg.percentageBps).to.equal(200);
    expect(cfg.lotpotIntegrator).to.equal(integratorAddr);
  });

  it("reverts when caller is not super-admin", async function () {
    await expect(
      setterGetter.connect(nonAdmin).setLotpotBuyerCashback(200, ethers.ZeroAddress)
    ).to.be.reverted;
  });

  it("reverts when percentageBps exceeds 1000 (10%)", async function () {
    await expect(
      setterGetter.connect(admin).setLotpotBuyerCashback(1001, ethers.ZeroAddress)
    ).to.be.reverted;
  });

  it("allows percentageBps == 0 to disable the feature", async function () {
    await setterGetter.connect(admin).setLotpotBuyerCashback(0, ethers.ZeroAddress);
    const cfg = await setterGetter.getLotpotBuyerCashbackConfig();
    expect(cfg.percentageBps).to.equal(0);
  });
});
```

(If `deployDiamondForTest` does not exist with that exact name, the existing `CashbackOrderFlow.ts` fixture has a similar setup. Replicate its initial deploy block.)

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd /Users/bytesbuster/cypher/contracts-v4 && npx hardhat test test/LotpotBuyerCashback.ts
```

Expected: FAIL (either "setLotpotBuyerCashback is not a function" or compile error referencing the missing getter — both confirm the feature is not yet implemented).

- [ ] **Step 3: Add the setter, getter, and event**

In `SetterFacet.sol`, near the existing cashback setter (`setCashbackConfig`), add:

```solidity
event LotpotBuyerCashbackConfigUpdated(uint16 percentageBps, address indexed lotpotIntegrator);

uint16 internal constant MAX_BUYER_CASHBACK_BPS = 1000; // 10% ceiling

/**
 * @notice Configures the non-B2B BUY-order USDC cashback feature.
 * @param _percentageBps Basis points (200 = 2%). 0 disables the feature.
 * @param _lotpotIntegrator V2 LotPot integrator address. address(0) disables.
 */
function setLotpotBuyerCashback(uint16 _percentageBps, address _lotpotIntegrator)
    external onlySuperAdmin
{
    if (_percentageBps > MAX_BUYER_CASHBACK_BPS) revert Errors.InvalidPercentage();
    P2pConfigStorage.layout().lotpotBuyerCashbackConfig =
        P2pConfigStorage.LotpotBuyerCashbackConfig({
            percentageBps: _percentageBps,
            lotpotIntegrator: _lotpotIntegrator
        });
    emit LotpotBuyerCashbackConfigUpdated(_percentageBps, _lotpotIntegrator);
}
```

In `GetterFacet.sol`, add:

```solidity
/** @notice Returns the LotPot buyer cashback configuration. */
function getLotpotBuyerCashbackConfig()
    external view returns (P2pConfigStorage.LotpotBuyerCashbackConfig memory)
{
    return P2pConfigStorage.layout().lotpotBuyerCashbackConfig;
}
```

If `Errors.InvalidPercentage` does not yet exist in `contracts/libraries/Errors.sol`, add it:

```solidity
error InvalidPercentage();
```

- [ ] **Step 4: Wire selectors into the diamond test fixture**

Check the existing `deployDiamondForTest` (or equivalent) in `test/helpers.ts` — when it cuts SetterFacet/GetterFacet, the new selectors are picked up automatically by `getSelectors(...)` since the helper introspects the facet. No change needed unless selectors are hardcoded.

If the helper hardcodes selectors, append `"setLotpotBuyerCashback"` to the SetterFacet selector list and `"getLotpotBuyerCashbackConfig"` to the GetterFacet selector list.

- [ ] **Step 5: Run test to verify it passes**

Run:
```bash
cd /Users/bytesbuster/cypher/contracts-v4 && npx hardhat test test/LotpotBuyerCashback.ts
```

Expected: PASS — 4 passing.

- [ ] **Step 6: Commit**

```bash
cd /Users/bytesbuster/cypher/contracts-v4
git add contracts/facets/SetterFacet.sol contracts/facets/GetterFacet.sol contracts/libraries/Errors.sol test/LotpotBuyerCashback.ts
git commit -m "feat(diamond): add setLotpotBuyerCashback + getter with bps cap"
```

---

## Task 6: Add `handleLotpotBuyerCashback` + `BuyerLotpotCashback` event

**Files:**
- Modify: `/Users/bytesbuster/cypher/contracts-v4/contracts/facets/OrderFlowHelper.sol`
- Test: `/Users/bytesbuster/cypher/contracts-v4/test/LotpotBuyerCashback.ts`

- [ ] **Step 1: Write the failing test (happy path)**

Append to `test/LotpotBuyerCashback.ts`:

```typescript
describe("LotPot Buyer USDC Cashback — handleLotpotBuyerCashback", function () {
  let admin: SignerWithAddress;
  let merchant: SignerWithAddress;
  let user: SignerWithAddress;
  let setterGetter: any;
  let diamond: any;
  let usdc: any;
  let reputationManager: any;
  let mockIntegrator: any;
  let mockProxy: any;

  beforeEach(async function () {
    [admin, merchant, user] = await ethers.getSigners();
    const fixture = await deployDiamondForTest(admin);
    ({ setterGetter, diamond, usdc, reputationManager } = fixture);

    // Pre-fund ReputationManager with USDC (cashback pool).
    await usdc.connect(admin).transfer(
      await reputationManager.getAddress(),
      ethers.parseUnits("100000", 6)
    );

    // Deploy mocks.
    mockIntegrator = await ethers.deployContract("MockLotpotIntegrator");
    mockProxy = await ethers.deployContract("MockLotpotProxy");
    await mockIntegrator.setProxy(user.address, await mockProxy.getAddress());

    // Enable cashback at 2%.
    await setterGetter.connect(admin).setLotpotBuyerCashback(
      200,
      await mockIntegrator.getAddress()
    );
  });

  it("transfers 2% of order amount to the user's LotPot proxy on non-B2B BUY completion", async function () {
    const orderAmount = ethers.parseUnits("100", 6);  // 100 USDC
    const expectedCashback = (orderAmount * 200n) / 10000n;  // 2 USDC

    const proxyBalanceBefore = await usdc.balanceOf(await mockProxy.getAddress());

    // Place + accept + pay + complete a non-B2B BUY order for the user.
    // Use the existing test helper for order lifecycle:
    const orderId = await placeBuyOrderAndComplete(fixture, user, merchant, orderAmount);

    const proxyBalanceAfter = await usdc.balanceOf(await mockProxy.getAddress());
    expect(proxyBalanceAfter - proxyBalanceBefore).to.equal(expectedCashback);

    // notifyCashbackCredit must have been called exactly once.
    expect(await mockProxy.notifyCount()).to.equal(1);

    // orderCashback storage populated.
    const info = await diamond.orderCashback(orderId);  // existing public mapping accessor; if absent use diamond.getOrderCashback(orderId)
    expect(info.amount).to.equal(expectedCashback);
    expect(info.token.toLowerCase()).to.equal((await usdc.getAddress()).toLowerCase());
  });
});

// Helper (place this above the describe block):
const CURRENCY = ethers.encodeBytes32String("INR");  // any currency configured in the fixture
const OrderType = { BUY: 0, SELL: 1, PAY: 2 } as const;

async function placeBuyOrderAndComplete(
  fixture: any,
  user: SignerWithAddress,
  merchant: SignerWithAddress,
  amount: bigint
): Promise<bigint> {
  const { diamond, orderProcessor } = fixture;

  // 1. User places a BUY order.
  const placeTx = await diamond.connect(user).placeOrder(
    OrderType.BUY,
    amount,
    CURRENCY,
    user.address,   // recipientAddr
    0,              // preferredPaymentChannelConfigId (0 = any)
    "user-pubkey"
  );
  const placeReceipt = await placeTx.wait();
  // Extract orderId from the OrderPlaced event. Adapt the topic name if the
  // event differs in your fixture; CashbackOrderFlow.ts uses the same pattern.
  const event = placeReceipt!.logs.find(
    (l: any) => l.fragment?.name === "OrderPlaced"
  );
  const orderId = event!.args.orderId as bigint;

  // 2. Merchant accepts the order. Encrypted UPI is dummy for tests.
  await diamond.connect(merchant).acceptOrder(orderId, "user-enc-upi", "");

  // 3. Mark paid. For BUY orders, paidBuyOrder is the user's gesture that
  //    they've completed the fiat leg.
  await diamond.connect(user).paidBuyOrder(orderId);

  // 4. Merchant completes the order; this is the moment cashback fires.
  await diamond.connect(merchant).completeOrder(orderId, "merchant-enc-upi");

  return orderId;
}
```

If the exact placeOrder signature, OrderType enum, or event name in this codebase differs, reference lines 250–330 of `test/CashbackOrderFlow.ts` — that file already exercises the same place→accept→pay→complete flow for PAY orders. Adapt only the `orderType` argument; the rest of the call shape transfers.

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd /Users/bytesbuster/cypher/contracts-v4 && npx hardhat test test/LotpotBuyerCashback.ts --grep "handleLotpotBuyerCashback"
```

Expected: FAIL — proxy balance does not increase because the hook isn't wired yet.

- [ ] **Step 3: Add the event, internal function, and event symbol**

In `OrderFlowHelper.sol`, near the existing `CashbackTransferFailed` event (~line 86), add:

```solidity
/** @notice Emitted when LotPot buyer USDC cashback is successfully transferred */
event BuyerLotpotCashback(
    uint256 indexed orderId,
    address indexed user,
    address indexed proxy,
    uint256 amount
);
```

Add the imports at the top of `OrderFlowHelper.sol`:

```solidity
import { ILotpotProxyResolver } from "../interfaces/ILotpotProxyResolver.sol";
import { ILotpotProxyNotifier } from "../interfaces/ILotpotProxyNotifier.sol";
```

Add the internal function near the existing `handleCashback` (~line 348):

```solidity
/**
 * @notice Handles 2% USDC cashback distribution for completed non-B2B BUY
 *         orders, depositing the cashback to the user's LotPot UserProxy.
 *         All external calls are wrapped in try/catch — a failure here
 *         must never block order completion.
 * @param _orderId The completed order ID
 */
function handleLotpotBuyerCashback(uint256 _orderId) internal {
    OrderProcessorStorage.Layout storage l = OrderProcessorStorage.layout();
    OrderProcessorStorage.Order storage _order = l.orders[_orderId];
    P2pConfigStorage.LotpotBuyerCashbackConfig memory cfg =
        P2pConfigStorage.layout().lotpotBuyerCashbackConfig;

    if (cfg.percentageBps == 0 || cfg.lotpotIntegrator == address(0)) return;

    uint256 amount = (_order.amount * cfg.percentageBps) /
                     OrderProcessorStorage.BASIS_POINTS_DENOMINATOR;
    if (amount == 0) return;

    address proxy;
    try ILotpotProxyResolver(cfg.lotpotIntegrator).proxyAddress(_order.user)
        returns (address p) { proxy = p; }
    catch {
        // Pre-transfer failure -> emit with 0, matching the cbBTC quoter
        // failure pattern in handleCashback.
        emit CashbackTransferFailed(_orderId, address(l.usdt), 0);
        return;
    }

    try l.reputationManager.transferCashback(address(l.usdt), proxy, amount) {
        // Bump the proxy's activity clock for sweep eligibility.
        // If the proxy isn't deployed yet, this external call is a silent
        // no-op (Solidity calls to a code-less address succeed without
        // invoking anything). Wrapped in try/catch defensively.
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

- [ ] **Step 4: Run test to verify it still fails (function exists but not yet hooked)**

Run:
```bash
cd /Users/bytesbuster/cypher/contracts-v4 && npx hardhat test test/LotpotBuyerCashback.ts --grep "handleLotpotBuyerCashback"
```

Expected: FAIL — the function exists but `completeOrder` doesn't call it yet (next task).

- [ ] **Step 5: Commit**

```bash
cd /Users/bytesbuster/cypher/contracts-v4
git add contracts/facets/OrderFlowHelper.sol test/LotpotBuyerCashback.ts
git commit -m "feat(diamond): add handleLotpotBuyerCashback internal function"
```

---

## Task 7: Hook `handleLotpotBuyerCashback` into `completeOrder`

**Files:**
- Modify: `/Users/bytesbuster/cypher/contracts-v4/contracts/facets/OrderFlowHelper.sol`

- [ ] **Step 1: Wire the hook**

In `OrderFlowHelper.completeOrder` (~line 333), the existing BUY-branch USDC transfer looks like:

```solidity
if (_order.orderType == OrderProcessorStorage.OrderType.BUY) {
    if (B2BGatewayStorage.layout().orderIntegrator[_orderId] != address(0)) {
        IB2BGateway(address(this)).onB2BOrderComplete(_orderId);
    } else {
        l.usdt.safeTransfer(_order.recipientAddr, _order.amount);
    }
}
```

Add the hook call inside the `else` branch (direct, non-B2B BUY):

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

- [ ] **Step 2: Run the existing happy-path test**

Run:
```bash
cd /Users/bytesbuster/cypher/contracts-v4 && npx hardhat test test/LotpotBuyerCashback.ts --grep "handleLotpotBuyerCashback"
```

Expected: PASS — proxy balance increased by 2 USDC, notifyCount == 1, orderCashback populated.

- [ ] **Step 3: Add exclusion tests**

Append to `test/LotpotBuyerCashback.ts`:

```typescript
it("does NOT issue cashback on B2B BUY orders (integrator set)", async function () {
  // Simulate a B2B order by setting B2BGatewayStorage.orderIntegrator[orderId]
  // before completion. Easiest path: place an order via the B2B placement flow
  // (if the test fixture exposes one), OR set the storage slot directly via
  // a test-only setter facet. Reference CashbackOrderFlow.ts for the pattern.
  const orderAmount = ethers.parseUnits("100", 6);
  const orderId = await placeB2BBuyOrderAndComplete(fixture, user, merchant, orderAmount);

  expect(await usdc.balanceOf(await mockProxy.getAddress())).to.equal(0n);
  expect(await mockProxy.notifyCount()).to.equal(0);
});

it("does NOT issue cashback on SELL orders", async function () {
  const orderAmount = ethers.parseUnits("100", 6);
  await placeSellOrderAndComplete(fixture, user, merchant, orderAmount);
  expect(await mockProxy.notifyCount()).to.equal(0);
});

it("does NOT issue cashback on PAY orders (those use cbBTC path)", async function () {
  // PAY-order path triggers the existing cbBTC handleCashback, not our new
  // handleLotpotBuyerCashback. Assert no USDC cashback was sent to mockProxy.
  const orderAmount = ethers.parseUnits("100", 6);
  await placePayOrderAndComplete(fixture, user, merchant, orderAmount);
  expect(await usdc.balanceOf(await mockProxy.getAddress())).to.equal(0n);
});

it("does NOT issue cashback when feature is disabled (bps==0)", async function () {
  await setterGetter.connect(admin).setLotpotBuyerCashback(0, await mockIntegrator.getAddress());
  const orderAmount = ethers.parseUnits("100", 6);
  await placeBuyOrderAndComplete(fixture, user, merchant, orderAmount);
  expect(await usdc.balanceOf(await mockProxy.getAddress())).to.equal(0n);
});

it("does NOT issue cashback when integrator is unset", async function () {
  await setterGetter.connect(admin).setLotpotBuyerCashback(200, ethers.ZeroAddress);
  const orderAmount = ethers.parseUnits("100", 6);
  await placeBuyOrderAndComplete(fixture, user, merchant, orderAmount);
  expect(await usdc.balanceOf(await mockProxy.getAddress())).to.equal(0n);
});

it("skips cashback when amount rounds to 0 (dust order)", async function () {
  // 200 bps * 0 USDC = 0; pick the smallest representable USDC amount such
  // that floor(amount * 200 / 10000) == 0. With 6-decimal USDC and 200 bps,
  // any amount < 50 (= 0.00005 USDC) rounds to 0.
  const orderAmount = 49n; // raw units (0.000049 USDC)
  await placeBuyOrderAndComplete(fixture, user, merchant, orderAmount);
  expect(await usdc.balanceOf(await mockProxy.getAddress())).to.equal(0n);
});
```

The helpers `placeB2BBuyOrderAndComplete`, `placeSellOrderAndComplete`, and `placePayOrderAndComplete` should adapt the patterns from `test/CashbackOrderFlow.ts` (SELL/PAY) and `test/B2BGatewayFacet.ts` or similar (B2B placement).

- [ ] **Step 4: Run all exclusion tests**

Run:
```bash
cd /Users/bytesbuster/cypher/contracts-v4 && npx hardhat test test/LotpotBuyerCashback.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/bytesbuster/cypher/contracts-v4
git add contracts/facets/OrderFlowHelper.sol test/LotpotBuyerCashback.ts
git commit -m "feat(diamond): wire LotPot buyer cashback hook into completeOrder"
```

---

## Task 8: Soft-fail tests for the cashback hook

**Files:**
- Modify: `/Users/bytesbuster/cypher/contracts-v4/test/LotpotBuyerCashback.ts`

- [ ] **Step 1: Write the soft-fail tests**

Append:

```typescript
describe("LotPot Buyer USDC Cashback — soft-fail behavior", function () {
  // (Reuse the beforeEach from the happy-path describe; copy or restructure.)

  it("emits CashbackTransferFailed(0) and does not revert when proxyAddress reverts", async function () {
    await mockIntegrator.setRevertOnResolve(true);
    const orderAmount = ethers.parseUnits("100", 6);

    const tx = await placeBuyOrderAndCompleteAndReturnTx(fixture, user, merchant, orderAmount);
    await expect(tx)
      .to.emit(diamond, "CashbackTransferFailed")
      .withArgs(anyOrderId, await usdc.getAddress(), 0);

    expect(await usdc.balanceOf(await mockProxy.getAddress())).to.equal(0n);
  });

  it("emits CashbackTransferFailed(amount) when RM has insufficient USDC", async function () {
    // Underfund RM: drain it down to less than the expected cashback by
    // running a few cashback-earning orders first, OR (preferred) re-deploy
    // the fixture with a tiny RM balance. We use the latter for determinism.
    const tinyFixture = await deployDiamondForTest(admin, {
      reputationManagerUsdcBalance: ethers.parseUnits("0.5", 6),   // 0.5 USDC
    });
    const localUsdc = tinyFixture.usdc;
    const localDiamond = tinyFixture.diamond;
    const localSetter = tinyFixture.setterGetter;
    const localProxy = await ethers.deployContract("MockLotpotProxy");
    const localIntegrator = await ethers.deployContract("MockLotpotIntegrator");
    await localIntegrator.setProxy(user.address, await localProxy.getAddress());
    await localSetter.connect(admin).setLotpotBuyerCashback(
      200,
      await localIntegrator.getAddress()
    );

    const orderAmount = ethers.parseUnits("100", 6);            // cashback = 2 USDC
    const expectedCashback = (orderAmount * 200n) / 10000n;

    const tx = await placeBuyOrderAndCompleteAndReturnTx(
      tinyFixture, user, merchant, orderAmount
    );
    await expect(tx)
      .to.emit(localDiamond, "CashbackTransferFailed")
      .withArgs(anyOrderId, await localUsdc.getAddress(), expectedCashback);

    // No USDC delivered to the proxy.
    expect(await localUsdc.balanceOf(await localProxy.getAddress())).to.equal(0n);
  });

  it("records cashback even when notifyCashbackCredit reverts", async function () {
    await mockProxy.setRevertOnNotify(true);
    const orderAmount = ethers.parseUnits("100", 6);
    const expectedCashback = (orderAmount * 200n) / 10000n;

    const orderId = await placeBuyOrderAndComplete(fixture, user, merchant, orderAmount);

    // Cashback amount still transferred and recorded; notify failure swallowed.
    expect(await usdc.balanceOf(await mockProxy.getAddress())).to.equal(expectedCashback);
    expect(await mockProxy.notifyCount()).to.equal(0);  // revert prevented increment
    const info = await diamond.orderCashback(orderId);
    expect(info.amount).to.equal(expectedCashback);
  });

  it("records cashback when proxy is not yet deployed (notify is silent no-op)", async function () {
    // Point the resolver at a random address that has no code.
    const undeployedProxy = ethers.Wallet.createRandom().address;
    await mockIntegrator.setProxy(user.address, undeployedProxy);

    const orderAmount = ethers.parseUnits("100", 6);
    const expectedCashback = (orderAmount * 200n) / 10000n;

    const orderId = await placeBuyOrderAndComplete(fixture, user, merchant, orderAmount);

    // USDC physically present at the undeployed address (just balance, no code).
    expect(await usdc.balanceOf(undeployedProxy)).to.equal(expectedCashback);
    const info = await diamond.orderCashback(orderId);
    expect(info.amount).to.equal(expectedCashback);
  });
});
```

- [ ] **Step 2: Run the soft-fail tests**

Run:
```bash
cd /Users/bytesbuster/cypher/contracts-v4 && npx hardhat test test/LotpotBuyerCashback.ts --grep "soft-fail"
```

Expected: all PASS (some may already pass if happy-path code handles failures correctly; if any fail, the issue is in the try/catch wiring of `handleLotpotBuyerCashback`).

- [ ] **Step 3: Commit**

```bash
cd /Users/bytesbuster/cypher/contracts-v4
git add test/LotpotBuyerCashback.ts
git commit -m "test(diamond): add soft-fail coverage for LotPot buyer cashback"
```

---

## Task 9: Create `UserProxyV2` with activity clock

**Files:**
- Create: `/Users/bytesbuster/cypher/payment-integrators/contracts/base/UserProxyV2.sol`
- Test: `/Users/bytesbuster/cypher/payment-integrators/test/userproxyV2.test.ts` (create)

- [ ] **Step 1: Write the failing tests for initialize + execute bumping**

Create `test/userproxyV2.test.ts`:

```typescript
import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("UserProxyV2", function () {
  let deployer: SignerWithAddress;  // simulates the integrator
  let user: SignerWithAddress;
  let stranger: SignerWithAddress;
  let proxy: any;
  let mockUsdc: any;
  let diamondAddr: string;

  beforeEach(async function () {
    [deployer, user, stranger] = await ethers.getSigners();
    diamondAddr = ethers.Wallet.createRandom().address;

    // Deploy a small "integrator shim" so UserProxyV2 can read .usdc() and .diamond()
    // The shim exposes both as immutable getters mimicking LotPotCheckoutIntegratorV2.
    const Shim = await ethers.getContractFactory("MockV2IntegratorShim");
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUsdc = await MockUSDC.deploy();
    const shim = await Shim.deploy(await mockUsdc.getAddress(), diamondAddr);

    // Deploy the UserProxyV2 implementation.
    const ImplFactory = await ethers.getContractFactory("UserProxyV2");
    const impl = await ImplFactory.deploy();

    // Clone via OZ Clones.cloneDeterministicWithImmutableArgs.
    // For unit-testing purposes, deploy via a small helper that wraps Clones.
    // Args layout: [owner(20)][integrator(20)] — same as V1.
    const Cloner = await ethers.getContractFactory("MockV2Cloner");
    const cloner = await Cloner.deploy();
    // The cloner needs the integrator-shim address as the "integrator" since that's
    // what UserProxyV2 will fetch via its immutable arg.
    const cloneTx = await cloner.clone(
      await impl.getAddress(),
      user.address,
      await shim.getAddress(),
      ethers.id("salt-for-test")
    );
    const receipt = await cloneTx.wait();
    // Extract the cloned address from an event the cloner emits.
    const cloneAddr = receipt!.logs[0].args![0];
    proxy = await ethers.getContractAt("UserProxyV2", cloneAddr);

    // Simulate the integrator's post-clone initialize() call.
    // For the test, deployer signer impersonates the shim's owner; the
    // shim has a passthrough `callInitialize(proxy)` for tests.
    await shim.callInitialize(cloneAddr);
  });

  it("sets _lastActivityTimestamp on initialize", async function () {
    const ts = await proxy.lastActivityTimestamp();
    expect(ts).to.be.greaterThan(0);
  });

  it("reverts AlreadyInitialized on second initialize", async function () {
    // Try to call initialize again via the shim.
    await expect(shim.callInitialize(await proxy.getAddress()))
      .to.be.revertedWithCustomError(proxy, "AlreadyInitialized");
  });

  it("execute bumps _lastActivityTimestamp", async function () {
    const before = await proxy.lastActivityTimestamp();
    await time.increase(60);
    // execute() is called by the integrator (shim).
    await shim.callExecute(await proxy.getAddress(), ethers.ZeroAddress, 0, "0x");
    const after = await proxy.lastActivityTimestamp();
    expect(after).to.be.greaterThan(before);
  });
});
```

You will need two small test fixtures: `MockV2IntegratorShim` and `MockV2Cloner`. Add them under `contracts/test/`:

```solidity
// contracts/test/MockV2IntegratorShim.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { UserProxyV2 } from "../base/UserProxyV2.sol";

contract MockV2IntegratorShim {
    address public immutable usdc;
    address public immutable diamond;

    constructor(address _usdc, address _diamond) {
        usdc = _usdc;
        diamond = _diamond;
    }

    function callInitialize(address proxy) external {
        UserProxyV2(payable(proxy)).initialize();
    }

    function callExecute(address proxy, address target, uint256 value, bytes calldata data) external {
        UserProxyV2(payable(proxy)).execute(target, value, data);
    }
}
```

```solidity
// contracts/test/MockV2Cloner.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

contract MockV2Cloner {
    event Cloned(address indexed clone);

    function clone(
        address impl,
        address owner,
        address integrator,
        bytes32 salt
    ) external returns (address) {
        bytes memory args = abi.encodePacked(owner, integrator);
        address c = Clones.cloneDeterministicWithImmutableArgs(impl, args, salt);
        emit Cloned(c);
        return c;
    }
}
```

- [ ] **Step 2: Run test to verify failure**

Run:
```bash
cd /Users/bytesbuster/cypher/payment-integrators && npx hardhat test test/userproxyV2.test.ts
```

Expected: FAIL — `UserProxyV2` artifact does not exist yet.

- [ ] **Step 3: Create `UserProxyV2.sol`**

Path: `/Users/bytesbuster/cypher/payment-integrators/contracts/base/UserProxyV2.sol`.

Base it on the existing `UserProxy.sol`. Copy it verbatim, then add:

```solidity
// Inside the contract body (after existing state and below the integrator() helper):

uint256 private _lastActivityTimestamp;

error AlreadyInitialized();
error InvalidAnchor();
error SweepLocked();
error NothingToSweep();
error InvalidAddress();

event CashbackCredited(uint256 timestamp);
event SweepStale(address indexed to, uint256 amount);

modifier onlyIntegratorOrDiamond() {
    address ig = integrator();
    if (msg.sender != ig && msg.sender != IDiamondHolder(ig).diamond()) {
        revert OnlyIntegrator();  // reuse existing error from V1 UserProxy
    }
    _;
}

/// @notice One-shot init by the V2 integrator immediately after the
///         clone is deployed. Anchors the activity clock.
function initialize() external {
    if (msg.sender != integrator()) revert OnlyIntegrator();
    if (_lastActivityTimestamp != 0) revert AlreadyInitialized();
    _lastActivityTimestamp = block.timestamp;
}

/// @notice Bumps the activity clock after the Diamond deposits cashback
///         to this proxy. Callable by the deploying integrator or by the
///         Diamond address that the integrator exposes via diamond().
function notifyCashbackCredit() external onlyIntegratorOrDiamond {
    _lastActivityTimestamp = block.timestamp;
    emit CashbackCredited(block.timestamp);
}

/// @notice Recovers proxy USDC after 90 days of inactivity OR when the
///         deploying integrator has been deprecated. Destination is at
///         the deployer's discretion (treasury, fraud-recovery wallet,
///         etc.).
function sweepStale(address to) external {
    if (msg.sender != integrator()) revert OnlyIntegrator();
    if (to == address(0)) revert InvalidAddress();
    bool unlocked = IDeprecatable(integrator()).deprecated()
                    || block.timestamp >= _lastActivityTimestamp + 90 days;
    if (!unlocked) revert SweepLocked();

    address usdcAddr = address(IUsdcSource(integrator()).usdc());
    uint256 bal = IERC20(usdcAddr).balanceOf(address(this));
    if (bal == 0) revert NothingToSweep();

    _lastActivityTimestamp = block.timestamp;
    IERC20(usdcAddr).safeTransfer(to, bal);
    emit SweepStale(to, bal);
}

/// @notice Returns the activity-clock anchor.
function lastActivityTimestamp() external view returns (uint256) {
    return _lastActivityTimestamp;
}
```

Also modify the existing `execute(...)` body to bump on every successful invocation:

```solidity
function execute(
    address target,
    uint256 value,
    bytes calldata data
) external returns (bytes memory) {
    // ... existing ACL + target checks ...

    _lastActivityTimestamp = block.timestamp;   // ← NEW, before the call
    // ... existing low-level call body, return data, etc. ...
}
```

Add these interface declarations at the top of the file (or in a sibling interfaces file):

```solidity
interface IDiamondHolder {
    function diamond() external view returns (address);
}

interface IDeprecatable {
    function deprecated() external view returns (bool);
}
```

`IUsdcSource` already exists in the V1 UserProxy source — reuse.

- [ ] **Step 4: Run the tests**

Run:
```bash
cd /Users/bytesbuster/cypher/payment-integrators && npx hardhat test test/userproxyV2.test.ts
```

Expected: 3 passing (initialize sets ts, second init reverts, execute bumps).

- [ ] **Step 5: Commit**

```bash
cd /Users/bytesbuster/cypher/payment-integrators
git add contracts/base/UserProxyV2.sol contracts/test/MockV2IntegratorShim.sol contracts/test/MockV2Cloner.sol test/userproxyV2.test.ts
git commit -m "feat(userproxy-v2): add activity-clock with initialize + execute bump"
```

---

## Task 10: `notifyCashbackCredit` ACL + behavior

**Files:**
- Modify: `/Users/bytesbuster/cypher/payment-integrators/test/userproxyV2.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/userproxyV2.test.ts`:

```typescript
describe("UserProxyV2 — notifyCashbackCredit", function () {
  // beforeEach as above

  it("bumps timestamp when called by integrator", async function () {
    const before = await proxy.lastActivityTimestamp();
    await time.increase(60);
    await shim.callNotifyCashbackCredit(await proxy.getAddress());
    const after = await proxy.lastActivityTimestamp();
    expect(after).to.be.greaterThan(before);
  });

  it("bumps timestamp when called by configured Diamond address", async function () {
    // Impersonate the diamond address (random EOA we configured in beforeEach).
    // Use hardhat's setBalance + impersonateAccount to send as diamondAddr.
    await ethers.provider.send("hardhat_impersonateAccount", [diamondAddr]);
    await ethers.provider.send("hardhat_setBalance", [diamondAddr, "0x100000000000000000"]);
    const diamondSigner = await ethers.getSigner(diamondAddr);

    const before = await proxy.lastActivityTimestamp();
    await time.increase(60);
    await proxy.connect(diamondSigner).notifyCashbackCredit();
    const after = await proxy.lastActivityTimestamp();
    expect(after).to.be.greaterThan(before);
  });

  it("reverts OnlyIntegrator when called by a stranger", async function () {
    await expect(proxy.connect(stranger).notifyCashbackCredit())
      .to.be.revertedWithCustomError(proxy, "OnlyIntegrator");
  });

  it("emits CashbackCredited event", async function () {
    await expect(shim.callNotifyCashbackCredit(await proxy.getAddress()))
      .to.emit(proxy, "CashbackCredited");
  });
});
```

Add a passthrough to the shim:

```solidity
// contracts/test/MockV2IntegratorShim.sol — add:
function callNotifyCashbackCredit(address proxy) external {
    UserProxyV2(payable(proxy)).notifyCashbackCredit();
}
```

- [ ] **Step 2: Run the tests**

Run:
```bash
cd /Users/bytesbuster/cypher/payment-integrators && npx hardhat test test/userproxyV2.test.ts --grep "notifyCashbackCredit"
```

Expected: all PASS (the UserProxyV2 from Task 9 already includes the function).

- [ ] **Step 3: Commit**

```bash
cd /Users/bytesbuster/cypher/payment-integrators
git add contracts/test/MockV2IntegratorShim.sol test/userproxyV2.test.ts
git commit -m "test(userproxy-v2): cover notifyCashbackCredit ACL and bump"
```

---

## Task 11: `sweepStale` timelock + deprecate escape

**Files:**
- Modify: `/Users/bytesbuster/cypher/payment-integrators/test/userproxyV2.test.ts`
- Modify: `/Users/bytesbuster/cypher/payment-integrators/contracts/test/MockV2IntegratorShim.sol`

- [ ] **Step 1: Add a deprecate flag to the shim and a sweep passthrough**

```solidity
// contracts/test/MockV2IntegratorShim.sol — add at the bottom:
bool private _deprecated;

function deprecated() external view returns (bool) {
    return _deprecated;
}

function setDeprecated(bool v) external {
    _deprecated = v;
}

function callSweepStale(address proxy, address to) external {
    UserProxyV2(payable(proxy)).sweepStale(to);
}
```

- [ ] **Step 2: Write the failing tests**

Append:

```typescript
describe("UserProxyV2 — sweepStale", function () {
  // beforeEach as above; in addition, mint some USDC to the proxy.
  beforeEach(async function () {
    await mockUsdc.mint(await proxy.getAddress(), ethers.parseUnits("10", 6));
  });

  it("reverts SweepLocked before 90 days", async function () {
    await expect(shim.callSweepStale(await proxy.getAddress(), user.address))
      .to.be.revertedWithCustomError(proxy, "SweepLocked");
  });

  it("succeeds after 90 days of inactivity", async function () {
    await time.increase(90 * 24 * 60 * 60 + 1);
    const userBalBefore = await mockUsdc.balanceOf(user.address);
    await shim.callSweepStale(await proxy.getAddress(), user.address);
    const userBalAfter = await mockUsdc.balanceOf(user.address);
    expect(userBalAfter - userBalBefore).to.equal(ethers.parseUnits("10", 6));
  });

  it("succeeds immediately when deprecate flag is set", async function () {
    await shim.setDeprecated(true);
    await expect(shim.callSweepStale(await proxy.getAddress(), user.address))
      .to.emit(proxy, "SweepStale");
  });

  it("reverts when called by non-integrator", async function () {
    await time.increase(90 * 24 * 60 * 60 + 1);
    await expect(proxy.connect(stranger).sweepStale(user.address))
      .to.be.revertedWithCustomError(proxy, "OnlyIntegrator");
  });

  it("reverts InvalidAddress when to is zero", async function () {
    await time.increase(90 * 24 * 60 * 60 + 1);
    await expect(shim.callSweepStale(await proxy.getAddress(), ethers.ZeroAddress))
      .to.be.revertedWithCustomError(proxy, "InvalidAddress");
  });

  it("reverts NothingToSweep on empty proxy", async function () {
    // Sweep once to drain.
    await time.increase(90 * 24 * 60 * 60 + 1);
    await shim.callSweepStale(await proxy.getAddress(), user.address);
    // Second sweep on empty balance.
    await expect(shim.callSweepStale(await proxy.getAddress(), user.address))
      .to.be.revertedWithCustomError(proxy, "NothingToSweep");
  });
});
```

- [ ] **Step 3: Run the tests**

Run:
```bash
cd /Users/bytesbuster/cypher/payment-integrators && npx hardhat test test/userproxyV2.test.ts --grep "sweepStale"
```

Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/bytesbuster/cypher/payment-integrators
git add contracts/test/MockV2IntegratorShim.sol test/userproxyV2.test.ts
git commit -m "test(userproxy-v2): cover sweepStale timelock and deprecate escape"
```

---

## Task 12: Create `LotPotCheckoutIntegratorV2`

**Files:**
- Create: `/Users/bytesbuster/cypher/payment-integrators/contracts/integrators/lotpot/LotPotCheckoutIntegratorV2.sol`
- Create: `/Users/bytesbuster/cypher/payment-integrators/test/lotpot-integrator-v2.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/lotpot-integrator-v2.test.ts`:

```typescript
import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("LotPotCheckoutIntegratorV2", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let stranger: SignerWithAddress;
  let integratorV2: any;
  let proxyImpl: any;
  let mockUsdc: any;
  let mockMegapot: any;
  let mockBatchFacilitator: any;
  let mockNft: any;

  beforeEach(async function () {
    [owner, user, stranger] = await ethers.getSigners();

    proxyImpl = await ethers.deployContract("UserProxyV2");
    mockUsdc = await ethers.deployContract("MockUSDC");
    mockMegapot = await ethers.deployContract("MockMegapot");
    mockBatchFacilitator = await ethers.deployContract("MockBatchPurchaseFacilitator");
    mockNft = await ethers.deployContract("MockJackpotNft");

    integratorV2 = await ethers.deployContract("LotPotCheckoutIntegratorV2", [
      ethers.Wallet.createRandom().address,    // diamond (random for integrator-V2 tests; B2B not exercised here)
      await mockUsdc.getAddress(),
      owner.address,                            // owner
      await proxyImpl.getAddress(),
      await mockMegapot.getAddress(),
      await mockBatchFacilitator.getAddress(),
      await mockNft.getAddress()
    ]);
  });

  it("starts with deprecated = false", async function () {
    expect(await integratorV2.deprecated()).to.equal(false);
  });

  it("deprecate() flips the flag and emits event (owner only)", async function () {
    await expect(integratorV2.connect(owner).deprecate())
      .to.emit(integratorV2, "Deprecated");
    expect(await integratorV2.deprecated()).to.equal(true);
  });

  it("deprecate() reverts when called by non-owner", async function () {
    await expect(integratorV2.connect(stranger).deprecate()).to.be.reverted;
  });

  it("adminEnsureProxy deploys + initializes a user's proxy (owner only)", async function () {
    const predicted = await integratorV2.proxyAddress(user.address);
    expect((await ethers.provider.getCode(predicted))).to.equal("0x");

    await integratorV2.connect(owner).adminEnsureProxy(user.address);

    const codeAfter = await ethers.provider.getCode(predicted);
    expect(codeAfter).to.not.equal("0x");

    const proxyContract = await ethers.getContractAt("UserProxyV2", predicted);
    expect(await proxyContract.lastActivityTimestamp()).to.be.greaterThan(0);
  });

  it("adminEnsureProxy is idempotent (no-op if proxy already deployed)", async function () {
    await integratorV2.connect(owner).adminEnsureProxy(user.address);
    // Second call must not revert.
    await integratorV2.connect(owner).adminEnsureProxy(user.address);
  });

  it("adminEnsureProxy reverts when called by non-owner", async function () {
    await expect(integratorV2.connect(stranger).adminEnsureProxy(user.address))
      .to.be.reverted;
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run:
```bash
cd /Users/bytesbuster/cypher/payment-integrators && npx hardhat test test/lotpot-integrator-v2.test.ts
```

Expected: FAIL — `LotPotCheckoutIntegratorV2` artifact does not exist.

- [ ] **Step 3: Create `LotPotCheckoutIntegratorV2.sol`**

Copy the entire file `contracts/integrators/lotpot/LotPotCheckoutIntegrator.sol` to `LotPotCheckoutIntegratorV2.sol`. Rename the contract to `LotPotCheckoutIntegratorV2`.

In the new file:

a. Replace the `UserProxy` import:
```solidity
// old:
import { UserProxy } from "../../base/UserProxy.sol";
// new:
import { UserProxyV2 } from "../../base/UserProxyV2.sol";
```

b. Add deprecated state + function (near the top of the contract body, after the immutables):
```solidity
bool public deprecated;
event Deprecated();

modifier onlyOwner() {
    if (msg.sender != owner) revert OnlyOwner();
    _;
}

function deprecate() external onlyOwner {
    deprecated = true;
    emit Deprecated();
}
```

(If `OnlyOwner` already exists in the V1 errors, reuse; otherwise add `error OnlyOwner();`.)

c. Update `_ensureProxy` to call `initialize` after the clone:
```solidity
function _ensureProxy(address user) internal returns (address proxy) {
    proxy = proxyAddress(user);
    if (proxy.code.length == 0) {
        address deployed = Clones.cloneDeterministicWithImmutableArgs(
            proxyImpl,
            _proxyArgs(user),
            _salt(user)
        );
        assert(deployed == proxy);
        UserProxyV2(payable(deployed)).initialize();   // ← NEW
        emit UserProxyDeployed(user, proxy);
    }
}
```

d. Add `adminEnsureProxy`:
```solidity
/// @notice Materializes a user's proxy without placing an order, so the
///         90-day sweep clock can start. Used to recover cashback
///         deposited at a never-engaged user's CREATE2 address.
function adminEnsureProxy(address user) external onlyOwner returns (address) {
    return _ensureProxy(user);
}
```

- [ ] **Step 4: Run tests**

Run:
```bash
cd /Users/bytesbuster/cypher/payment-integrators && npx hardhat test test/lotpot-integrator-v2.test.ts
```

Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
cd /Users/bytesbuster/cypher/payment-integrators
git add contracts/integrators/lotpot/LotPotCheckoutIntegratorV2.sol test/lotpot-integrator-v2.test.ts
git commit -m "feat(lotpot-v2): add LotPotCheckoutIntegratorV2 with deprecate + adminEnsureProxy"
```

---

## Task 13: End-to-end test — V2 proxy receives cashback and consumes it

**Files:**
- Modify: `/Users/bytesbuster/cypher/payment-integrators/test/lotpot-integrator-v2.test.ts`

This test is in the `payment-integrators` repo and proves that USDC sent directly to the V2 proxy address (simulating the Diamond's cashback transfer) flows through the existing `_route` credit-netting on the next ticket order.

- [ ] **Step 1: Write the failing test**

```typescript
describe("LotPotCheckoutIntegratorV2 — cashback consumption", function () {
  // Reuse fixtures from the above describe.

  it("auto-nets cashback USDC sitting at the proxy on the next ticket order", async function () {
    // 1. Simulate Diamond cashback: mint 2 USDC directly to the user's
    //    not-yet-deployed proxy address. Picks the credit-netting branch
    //    in V2._route (same as V1 — see _route at LotPotCheckoutIntegrator
    //    lines 512–540).
    const proxyAddr = await integratorV2.proxyAddress(user.address);
    const cashback = ethers.parseUnits("2", 6);
    await mockUsdc.mint(proxyAddr, cashback);
    expect(await mockUsdc.balanceOf(proxyAddr)).to.equal(cashback);

    // 2. Configure mockMegapot ticket price to 1 USDC each (so 5 tickets
    //    = 5 USDC total; credit 2 → Diamond delta 3 USDC).
    await mockMegapot.setTicketPrice(ethers.parseUnits("1", 6));

    // 3. User places a 5-ticket order.
    const placeTx = await integratorV2.connect(user).userPlaceOrder(
      5n,
      ethers.encodeBytes32String("USD"),
      0,
      "test-pubkey",
      0,
      0,
      [],
      []
    );

    // 4. Assertions:
    //    a. LotPotCreditRedeemed event emitted with creditUsed = 2 USDC.
    await expect(placeTx)
      .to.emit(integratorV2, "LotPotCreditRedeemed")
      .withArgs(
        (orderId: bigint) => orderId > 0n,    // any orderId
        user.address,
        proxyAddr,
        cashback
      );

    //    b. The Diamond order amount = 3 USDC (delta). Assert via the
    //       Diamond mock's B2BOrderPlaced event if your mockDiamond emits
    //       one, otherwise read the call args off the mockDiamond fixture.
    //       Reference lotpot-integrator.test.ts (V1) for the exact assertion
    //       shape — the V2 _route is byte-equivalent to V1 here.

    //    c. notifyCashbackCredit was NOT called by this flow (only the
    //       Diamond's cashback path calls it; user-driven placement does
    //       not). The proxy was lazy-deployed and initialized to now by
    //       _ensureProxy; lastActivityTimestamp > 0 from initialize +
    //       execute, but no CashbackCredited event was emitted.
    const proxyContract = await ethers.getContractAt("UserProxyV2", proxyAddr);
    expect(await proxyContract.lastActivityTimestamp()).to.be.greaterThan(0);
  });

  it("proxy gets initialized on first user-driven order placement", async function () {
    // Confirm Task 12's hook: when the user places their first ticket order,
    // _ensureProxy runs initialize() and lastActivityTimestamp > 0.
    const proxyAddr = await integratorV2.proxyAddress(user.address);
    expect(await ethers.provider.getCode(proxyAddr)).to.equal("0x");

    // Place a small order through the existing userPlaceOrder flow.
    await integratorV2.connect(user).userPlaceOrder(
      1n,                                       // quantity
      ethers.encodeBytes32String("USD"),        // currency
      0,                                        // circleId
      "test-pubkey",                            // pubKey
      0,                                        // preferredPaymentChannelConfigId
      0,                                        // fiatAmountLimit (0 = unlimited)
      [],                                       // referrers
      []                                        // referralSplit
    );

    expect(await ethers.provider.getCode(proxyAddr)).to.not.equal("0x");
    const proxyContract = await ethers.getContractAt("UserProxyV2", proxyAddr);
    expect(await proxyContract.lastActivityTimestamp()).to.be.greaterThan(0);
  });
});
```

The exact assertions in the first test depend on how V1's lotpot-integrator tests already script the Diamond-mock behavior. Copy the closest analogue from `test/lotpot-integrator.test.ts` (the file already covers credit-netting in `_route` for V1 — replicate that test with V2 and assert the credit came from cashback, not from a previously-skipped fulfillment).

- [ ] **Step 2: Run the tests**

Run:
```bash
cd /Users/bytesbuster/cypher/payment-integrators && npx hardhat test test/lotpot-integrator-v2.test.ts
```

Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
cd /Users/bytesbuster/cypher/payment-integrators
git add test/lotpot-integrator-v2.test.ts
git commit -m "test(lotpot-v2): end-to-end cashback-credit consumption via _route"
```

---

## Task 14: Update `INTEGRATORS.md` doc with V2 + cashback behavior

**Files:**
- Modify: `/Users/bytesbuster/cypher/payment-integrators/docs/integrators/lotpot.md`

- [ ] **Step 1: Append a "V2 + Buyer Cashback" section**

Add a new section at the end of `docs/integrators/lotpot.md`:

```markdown
## V2 — Buyer USDC Cashback (2026)

`LotPotCheckoutIntegratorV2` extends V1 with three additions to support a
protocol-side growth campaign: 2% USDC cashback for non-B2B P2P BUY orders,
deposited directly to the buyer's V2 `UserProxy` for use on future LotPot
ticket purchases.

**New in V2:**
- `deprecate()` — owner-callable sunset flag; unlocks `sweepStale` on all
  V2 proxies immediately.
- `adminEnsureProxy(user)` — owner-callable; materializes a never-engaged
  user's proxy to start the 90-day sweep clock.
- `UserProxyV2.notifyCashbackCredit()` — Diamond/integrator-callable; bumps
  the proxy's activity clock after a cashback inbound.
- `UserProxyV2.sweepStale(to)` — integrator-callable; recovers proxy USDC
  after 90 days of inactivity OR when the integrator is deprecated.

**Migration from V1:** V1 stays operational. V2 is a fresh deployment with
new proxy addresses (different CREATE2 deployer → different addresses).
Existing V1-stranded credits remain redeemable via V1's `_route`. No
on-contract migration.

See the design spec at `docs/superpowers/specs/2026-05-20-lotpot-buyer-usdc-cashback-design.md`.
```

- [ ] **Step 2: Commit**

```bash
cd /Users/bytesbuster/cypher/payment-integrators
git add docs/integrators/lotpot.md
git commit -m "docs(lotpot): document V2 + buyer USDC cashback"
```

---

## Task 15: Smoke-test scripts (optional but recommended)

**Files:**
- Create: `/Users/bytesbuster/cypher/payment-integrators/scripts/deploy-lotpot-v2.ts`

- [ ] **Step 1: Create deployment script**

Copy `scripts/deploy-lotpot.ts` as a starting point; rename to `deploy-lotpot-v2.ts`. Change the integrator factory from `LotPotCheckoutIntegrator` to `LotPotCheckoutIntegratorV2` and `UserProxy` to `UserProxyV2`. Print the deployed V2 integrator address and the new `UserProxyV2` impl address so they can be fed into the Diamond's `setLotpotBuyerCashback(200, v2IntegratorAddr)` call.

- [ ] **Step 2: Dry-run the script against a local Hardhat fork (optional)**

Run:
```bash
cd /Users/bytesbuster/cypher/payment-integrators && npx hardhat run scripts/deploy-lotpot-v2.ts --network hardhat
```

Expected: prints addresses; no revert.

- [ ] **Step 3: Commit**

```bash
cd /Users/bytesbuster/cypher/payment-integrators
git add scripts/deploy-lotpot-v2.ts
git commit -m "chore(lotpot-v2): add V2 deploy script"
```

---

## Self-Review Notes

After running this plan, verify against the spec (`docs/superpowers/specs/2026-05-20-lotpot-buyer-usdc-cashback-design.md`):

- §3 Architecture diagram: completeOrder hook ✓ (Task 7), handleLotpotBuyerCashback flow ✓ (Task 6), V2 UserProxy additions ✓ (Tasks 9–11), V2 integrator additions ✓ (Task 12).
- §4 Storage: `LotpotBuyerCashbackConfig` field ✓ (Task 1).
- §5.1 Diamond changes: setter ✓ (Task 5), getter ✓ (Task 5), interfaces ✓ (Tasks 2–3), event + handler ✓ (Task 6), hook ✓ (Task 7).
- §5.2 LotPot changes: UserProxyV2 ✓ (Tasks 9–11), V2 integrator ✓ (Task 12), `_ensureProxy` calls `initialize` ✓ (Task 12 step 3c), `adminEnsureProxy` ✓ (Task 12 step 3d).
- §6 Walkthroughs: happy path ✓ (Task 6), engaged-then-quiet sweep ✓ (Task 11), never-engaged sweep ✓ (Task 12 + Task 11 deprecate escape), V1 user dual-pot (no on-chain task; documented).
- §7 Error handling: 8 failure modes — covered by Tasks 6, 7, 8, 11.
- §8 Events: all 5 new events emitted from their respective tasks; subgraph work is downstream and out of this plan's scope.
- §9 Admin/ops surface: setter (Task 5), sweepStale (Task 11), adminEnsureProxy (Task 12), deprecate (Task 12) — all covered.
- §10 Test plan: contracts-v4 suite (Tasks 5–8), payment-integrators suite (Tasks 9–13).
- §11 Rollout: deployment ordering documented in the spec; scripts produced in Task 15 — actual on-chain rollout is operational, outside this plan.
- §12 Non-decisions: respected (no per-user cap, no budget cap, no backdated anchor, no V1 migration).

V1 parity for V2 (limits / RP gating): the file-level copy in Task 12 preserves everything not explicitly changed; the existing V1 test suite for `LotPotCheckoutIntegrator` can be duplicated into a V2 variant if regression confidence is needed beyond what Tasks 12–13 cover.
