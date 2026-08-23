// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { IP2PIntegrator } from "../interfaces/IP2PIntegrator.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

interface IUserProxyView {
    function owner() external view returns (address);
    function integrator() external view returns (address);
}

/**
 * @title MockDiamond
 * @notice Simulates the P2P Diamond for testing.
 *         - B2BGatewayFacet.placeB2BOrder + onB2BOrderComplete callback (BUY)
 *         - B2BGatewayFacet.placeB2BSellOrder (SELL via the gateway; no
 *           integrator completion callback — integrators reconcile via
 *           polling, matching real Diamond behaviour)
 *         - OrderFlowFacet.placeOrder/acceptOrder/setSellOrderUpi/completeOrder
 *           kept for legacy tests that bypass the gateway.
 *
 *         Sell orders share the same `nextOrderId` counter as buy orders to
 *         match real Diamond behavior; different data shapes live in
 *         separate mappings.
 */
contract MockDiamond {
    using SafeERC20 for IERC20;

    enum SellStatus {
        PLACED,
        ACCEPTED,
        PAID,
        COMPLETED,
        CANCELLED
    }

    IERC20 public usdc;
    uint256 public nextOrderId = 1;

    struct Order {
        address integrator;
        address user;
        uint256 amount;
        bytes32 currency;
        address recipientAddr;
        bool completed;
        bool cancelled;
        bool paid; // set by paidBuyOrder — a claim, not a settlement
        bool accepted; // an LP has taken the order; required before PAID
    }

    struct SellOrder {
        address user; // = order.user (integrator address in our flow)
        uint256 amount;
        bytes32 currency;
        SellStatus status;
        string encUpi; // user's UPI encrypted to merchant
        string merchantPubkey;
        address acceptedMerchant; // set on accept; surfaced via getOrdersById
        uint8 disputeRaisedBy; // test-only: mirror Diamond's Dispute.raisedBy
        uint8 disputeStatus; // test-only: mirror Diamond's Dispute.status
    }

    /// @notice SELL fee in bps, charged on top of principal (real Diamond charges
    ///         a fee; the base mock charged zero, masking the #44 strand). 0 =
    ///         legacy fee-free behaviour, so existing tests are unaffected.
    uint256 public sellFeeBps;

    function setSellFeeBps(uint256 bps) external {
        sellFeeBps = bps;
    }

    /// @dev Integration resolution (#35 -> main): `main` charges a FLAT `sellFee`,
    ///      the Showdown branch added a PROPORTIONAL `sellFeeBps`. Both are
    ///      honoured so either suite's fixtures work unchanged.
    function _sellFee(uint256 amount) internal view returns (uint256) {
        return sellFee + (amount * sellFeeBps) / 10_000;
    }

    mapping(address => bool) public activeIntegrators;
    mapping(address => address) public integratorProxyImpl;
    mapping(uint256 => Order) public orders;
    mapping(uint256 => SellOrder) public sellOrders;

    event MockOrderPlaced(uint256 orderId, address integrator, address user, uint256 amount);
    event MockOrderCompleted(uint256 orderId);
    event MockOrderCancelled(uint256 orderId);
    /// @notice Mirrors B2BGatewayFacet.B2BIntegratorCallbackFailed: protocol-side
    ///         completion / cancellation is best-effort vs the integrator
    ///         callback. Protocol state finalises even if onOrderComplete /
    ///         onOrderCancel reverts.
    event MockIntegratorCallbackFailed(uint256 orderId, address integrator, bytes reason);
    event MockSellOrderPlaced(uint256 orderId, address user, uint256 amount, bytes32 currency);
    event MockSellOrderAccepted(uint256 orderId);
    event MockSellOrderPaid(uint256 orderId);
    event MockSellOrderCompleted(uint256 orderId);
    event MockSellOrderCancelled(uint256 orderId, uint256 refundedAmount);

    constructor(address _usdc) {
        usdc = IERC20(_usdc);
    }

    function registerIntegrator(address integrator, address proxyImpl) external {
        activeIntegrators[integrator] = true;
        integratorProxyImpl[integrator] = proxyImpl;
    }

    /**
     * @notice Simulates B2BGatewayFacet.placeB2BOrder. Proxy-only: the caller MUST
     *         be a UserProxy whose integrator() points to a registered integrator,
     *         and whose address re-derives correctly under CREATE2 against that
     *         integrator's pinned proxyImpl. Mirrors the real
     *         B2BGatewayFacet._resolveIntegrator (no isAuthorizedProxy callback).
     */
    /* ── Adversarial modes ────────────────────────────────────────────────
     *
     * An integrator's own defences against a misbehaving Diamond cannot be
     * tested by a Diamond that always behaves. These switches let a test drive
     * the gateway off the happy path deliberately. All default false, so
     * existing suites are unaffected.
     */

    /// @notice Mirrors `B2BGatewayStorage.IntegratorConfig.usdcThroughIntegrator`.
    ///         The real gateway routes settlement on this but passes
    ///         `recipientAddr` to `onOrderComplete` in BOTH branches — the
    ///         asymmetry an integrator's routing alarm has to survive.
    bool public usdcThroughIntegrator;
    /// @notice Place without ever calling `validateOrder`.
    bool public skipValidation;
    /// @notice Call `validateOrder` twice for one placement.
    bool public doubleValidate;
    /// @notice Call `validateOrder` with an amount the integrator did not ask for.
    bool public tamperValidationAmount;
    /// @notice Hand back an order id that has already been used.
    uint256 public forceOrderId;

    function setUsdcThroughIntegrator(bool v) external {
        usdcThroughIntegrator = v;
    }

    /**
     * @notice Mirrors `B2BGatewayFacet.getIntegratorConfig`, including the
     *         field ORDER of the deployed struct — five words, with the
     *         routing flag at word 1 and `proxyImpl` last.
     * @dev    The order is the point. `cancelCallbackEnabled` was inserted in
     *         the middle, which is what makes a stale typed decode read
     *         `proxyImpl` as zero. An integrator that reads word 1 raw is
     *         unaffected, and this mock has to have the same shape for that to
     *         mean anything in a test.
     */
    struct IntegratorConfigView {
        bool isActive;
        bool usdcThroughIntegrator;
        bool cancelCallbackEnabled;
        uint256 activeOrderCount;
        address proxyImpl;
    }

    /// @notice Set false to simulate a Diamond whose config cannot be read.
    bool public configReadable = true;

    function setConfigReadable(bool v) external {
        configReadable = v;
    }

    function getIntegratorConfig(
        address integrator
    ) external view returns (IntegratorConfigView memory cfg) {
        require(configReadable, "config unreadable");
        cfg.isActive = true;
        cfg.usdcThroughIntegrator = usdcThroughIntegrator;
        cfg.cancelCallbackEnabled = false;
        cfg.activeOrderCount = 0;
        cfg.proxyImpl = integratorProxyImpl[integrator];
    }

    function setSkipValidation(bool v) external {
        skipValidation = v;
    }

    function setDoubleValidate(bool v) external {
        doubleValidate = v;
    }

    function setTamperValidationAmount(bool v) external {
        tamperValidationAmount = v;
    }

    function setForceOrderId(uint256 id) external {
        forceOrderId = id;
    }

    function placeB2BOrder(
        address user,
        uint256 amount,
        bytes32 currency,
        address recipientAddr,
        string calldata /* pubKey */,
        uint256 /* circleId */,
        uint256 /* preferredPaymentChannelConfigId */,
        uint256 /* fiatAmountLimit */
    ) external returns (uint256 orderId) {
        address effectiveIntegrator = _resolveIntegrator();

        if (!skipValidation) {
            bool allowed = IP2PIntegrator(effectiveIntegrator).validateOrder(
                user,
                tamperValidationAmount ? amount + 1 : amount,
                currency
            );
            require(allowed, "Validation failed");
            if (doubleValidate) {
                IP2PIntegrator(effectiveIntegrator).validateOrder(user, amount, currency);
            }
        }

        orderId = forceOrderId != 0 ? forceOrderId : nextOrderId++;
        orders[orderId] = Order({
            integrator: effectiveIntegrator,
            user: user,
            amount: amount,
            currency: currency,
            recipientAddr: recipientAddr,
            completed: false,
            cancelled: false,
            paid: false,
            accepted: false
        });

        emit MockOrderPlaced(orderId, effectiveIntegrator, user, amount);
    }

    /**
     * @notice Simulates B2BGatewayFacet.placeB2BSellOrder.
     */
    function placeB2BSellOrder(
        address user,
        uint256 amount,
        bytes32 currency,
        string calldata /* userPubKey */,
        uint256 circleId,
        uint256 /* preferredPaymentChannelConfigId */,
        uint256 /* fiatAmountLimit */
    ) external returns (uint256 orderId) {
        // The real Diamond rejects circleId 0 (no such circle). Mirror that so
        // tests catch integrators that forget to pass a valid circle.
        require(circleId != 0, "InvalidCircle");

        address effectiveIntegrator = _resolveIntegrator();

        bool allowed = IP2PIntegrator(effectiveIntegrator).validateOrder(user, amount, currency);
        require(allowed, "Validation failed");

        orderId = nextOrderId++;
        sellOrders[orderId] = SellOrder({
            user: user,
            amount: amount,
            currency: currency,
            status: SellStatus.PLACED,
            encUpi: "",
            merchantPubkey: "",
            acceptedMerchant: address(0),
            disputeRaisedBy: 0,
            disputeStatus: 0
        });
        emit MockSellOrderPlaced(orderId, user, amount, currency);
    }

    /// Mirrors the real B2BGatewayFacet._resolveIntegrator: proxy-only,
    /// facet-side CREATE2 derivation. The integrator only commits to a
    /// proxyImpl at registration; the gateway re-derives clone addresses
    /// itself (no runtime trust on the integrator).
    function _resolveIntegrator() internal view returns (address) {
        if (msg.sender.code.length == 0) revert("Not active integrator");

        address integrator;
        try IUserProxyView(msg.sender).integrator() returns (address ig) {
            integrator = ig;
        } catch {
            revert("Not active integrator");
        }
        if (!activeIntegrators[integrator]) revert("Not active integrator");
        address proxyImpl = integratorProxyImpl[integrator];
        if (proxyImpl == address(0)) revert("Not active integrator");

        address ownerAddr;
        try IUserProxyView(msg.sender).owner() returns (address o) {
            ownerAddr = o;
        } catch {
            revert("Not active integrator");
        }
        if (ownerAddr == address(0)) revert("Not active integrator");

        address expected = Clones.predictDeterministicAddressWithImmutableArgs(
            proxyImpl,
            abi.encodePacked(ownerAddr, integrator),
            bytes32(uint256(uint160(ownerAddr))),
            integrator
        );
        if (expected != msg.sender) revert("Not active integrator");
        return integrator;
    }

    /**
     * @notice Simulates order completion: transfers USDC to recipientAddr and
     *         calls onOrderComplete. Mirrors B2BGatewayFacet.onB2BOrderComplete:
     *         the integrator callback is wrapped in try/catch — protocol-side
     *         completion (USDC routing, status update) finalizes regardless of
     *         whether the integrator's hook succeeds. Caller must fund this
     *         contract with USDC first.
     */
    function simulateOrderComplete(uint256 orderId) external {
        Order storage order = orders[orderId];
        require(!order.completed, "Already completed");
        // A CANCELLED BUY is NOT terminal on the real Diamond: OrderFlowHelper
        // lets an admin re-open a CANCELLED BUY to PAID and complete from there
        // (the dispute path). `orders` here is the BUY mapping, so completing a
        // cancelled order is a faithful transition to model, not an impossible
        // one — the prior `require(!cancelled)` was stricter than the protocol.
        // See #56 (mirror of #41: a mock encoding a belief about the Diamond
        // rather than the Diamond's code).
        order.completed = true;

        // Routing follows the flag, exactly as B2BGatewayFacet does.
        if (usdcThroughIntegrator) {
            usdc.safeTransfer(order.integrator, order.amount);
        } else {
            usdc.safeTransfer(order.recipientAddr, order.amount);
        }

        // ...but the callback carries `recipientAddr` in BOTH branches. This
        // is not an oversight in the mock; it is what the real gateway does,
        // and it is the reason an integrator cannot detect a mis-registration
        // from this argument.
        try
            IP2PIntegrator(order.integrator).onOrderComplete(
                orderId,
                order.user,
                order.amount,
                order.recipientAddr
            )
        {
            // ok
        } catch (bytes memory reason) {
            emit MockIntegratorCallbackFailed(orderId, order.integrator, reason);
        }

        emit MockOrderCompleted(orderId);
    }

    // ─── Buyer-driven transitions (the REAL order.user gate) ──────────
    //
    // These mirror the live Diamond, which authorises `paidBuyOrder` and
    // `cancelOrder` against `order.user` — NOT against the placer, and NOT
    // against `recipientAddr`. Verified by eth_call on both the Base mainnet
    // Diamond (0x4cad6eC90e65baBec9335cAd728DDC610c316368) and the Base Sepolia
    // Diamond (0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9): from `order.user`
    // the call clears the ACL and fails only on a status/expiry check, while
    // every other caller — including the order's own `recipientAddr` — reverts
    // NotAuthorized() (0xea8e4eb5).
    //
    // Their ABSENCE from this mock is why a payment link could be placed and
    // never paid, with the entire test suite green: nothing here could refuse
    // the relayer, so nothing here noticed that the real Diamond does.

    error NotAuthorized();
    error OrderStatusInvalid();

    /// @notice An LP takes the order. Required before it can be marked paid,
    ///         because there is no one to have sent fiat to until then.
    function simulateOrderAccepted(uint256 orderId) external {
        Order storage order = orders[orderId];
        require(order.integrator != address(0), "Unknown order");
        require(!order.completed && !order.cancelled, "Terminal");
        order.accepted = true;
    }

    event MockOrderPaid(uint256 orderId, address caller);
    event MockOrderCancelledBy(uint256 orderId, address caller);

    /// @notice Marks a BUY order's fiat leg as sent. PAID is a CLAIM: it moves
    ///         no USDC. Settlement is `simulateOrderComplete`, which on the real
    ///         Diamond only the accepting LP can trigger.
    /// @dev Requires ACCEPTED, matching the live Diamond. A PLACED order has no
    ///      LP yet, so there is nobody the fiat could have been sent to — the
    ///      earlier version of this mock allowed PLACED and let tests exercise
    ///      a transition production would reject.
    function paidBuyOrder(uint256 orderId) external {
        Order storage order = orders[orderId];
        if (order.integrator == address(0)) revert OrderStatusInvalid();
        if (msg.sender != order.user) revert NotAuthorized();
        if (order.completed || order.cancelled || order.paid) revert OrderStatusInvalid();
        if (!order.accepted) revert OrderStatusInvalid();

        order.paid = true;
        emit MockOrderPaid(orderId, msg.sender);
    }

    /// @notice Buyer-driven cancellation, under the same `order.user` gate.
    /// @dev A BUY is user-cancellable in PLACED and ACCEPTED only. Once PAID it
    ///      is out of the buyer's hands — the live Diamond allows that transition
    ///      to self/admin, not to `order.user`, and the refund branch belongs to
    ///      SELL/PAY rather than BUY. Modelling it here let the strike tests
    ///      exercise a path the relayer cannot take in production; the real
    ///      sources of a strike are the keeper's TTL cancel and admin/dispute.
    function cancelOrder(uint256 orderId) external {
        Order storage order = orders[orderId];
        if (order.integrator == address(0)) revert OrderStatusInvalid();
        if (msg.sender != order.user) revert NotAuthorized();
        if (order.completed || order.cancelled) revert OrderStatusInvalid();
        if (order.paid) revert OrderStatusInvalid();

        order.cancelled = true;
        try IP2PIntegrator(order.integrator).onOrderCancel(orderId) {
            // ok
        } catch (bytes memory reason) {
            emit MockIntegratorCallbackFailed(orderId, order.integrator, reason);
        }
        emit MockOrderCancelledBy(orderId, msg.sender);
    }

    /**
     * @notice Simulates B2BGatewayFacet.onB2BOrderCancelled: gateway-side
     *         cancellation calls the integrator's onOrderCancel under
     *         try/catch (best-effort). Used in tests to verify the
     *         integrator's daily-count slot is released on cancellation.
     */
    function simulateOrderCancelled(uint256 orderId) external {
        Order storage order = orders[orderId];
        require(!order.completed, "Already completed");
        require(!order.cancelled, "Already cancelled");
        order.cancelled = true;

        try IP2PIntegrator(order.integrator).onOrderCancel(orderId) {
            // ok
        } catch (bytes memory reason) {
            emit MockIntegratorCallbackFailed(orderId, order.integrator, reason);
        }

        emit MockOrderCancelled(orderId);
    }

    // ─── SELL: OrderFlowFacet ────────────────────────────────────────

    /**
     * @notice Mocks OrderFlowFacet.placeOrder. Only SELL (orderType=1)
     *         supported — buy/pay flows go through placeB2BOrder above.
     */
    function placeOrder(
        string calldata /* pubKey */,
        uint256 amount,
        address /* recipientAddr */,
        uint8 orderType,
        string calldata /* userUpi */,
        string calldata /* userPubKey */,
        bytes32 currency,
        uint256 /* preferredPaymentChannelConfigId */,
        uint256 /* circleId */,
        uint256 /* fiatAmountLimit */
    ) external returns (uint256 orderId) {
        require(orderType == 1, "MockDiamond: only SELL");
        orderId = nextOrderId++;
        sellOrders[orderId] = SellOrder({
            user: msg.sender,
            amount: amount,
            currency: currency,
            status: SellStatus.PLACED,
            encUpi: "",
            merchantPubkey: "",
            acceptedMerchant: address(0),
            disputeRaisedBy: 0,
            disputeStatus: 0
        });
        emit MockSellOrderPlaced(orderId, msg.sender, amount, currency);
    }

    /// @notice Test-driven merchant accept. Real Diamond restricts to
    ///         registered merchants; mock skips that check.
    function acceptSellOrder(uint256 orderId, string calldata merchantPubkey) external {
        SellOrder storage o = sellOrders[orderId];
        require(o.status == SellStatus.PLACED, "Bad state");
        o.status = SellStatus.ACCEPTED;
        o.merchantPubkey = merchantPubkey;
        o.acceptedMerchant = msg.sender;
        emit MockSellOrderAccepted(orderId);
    }

    /**
     * @notice Mocks OrderFlowFacet.setSellOrderUpi. The LIVE facet wraps its USDC
     *         pull in try/catch and, on a failed pull, AUTO-CANCELS the order and
     *         returns success (it does NOT revert) — so a successful call is not
     *         proof of delivery. This mock mirrors that: it try/catches the pull
     *         via the external `_pullFor` shim, moving to PAID on success and to
     *         CANCELLED (returning normally) on failure. (audit #3)
     */
    function setSellOrderUpi(
        uint256 orderId,
        string calldata encUpi,
        uint256 /* updatedAmount */
    ) external {
        SellOrder storage o = sellOrders[orderId];
        require(o.status == SellStatus.ACCEPTED, "Bad state");
        require(msg.sender == o.user, "Only order.user");
        o.encUpi = encUpi;
        uint256 needed = o.amount + _sellFee(o.amount); // actualUsdtAmount (principal + fee)
        // Test hook: force the live facet's "pull failed → auto-cancel, return
        // success (no revert)" branch even when the proxy is fully funded, so the
        // integrator's deliverFiatPayout status-read-back (#2) can be exercised
        // deterministically without contriving an underfunding.
        if (forceSellUpiAutoCancel) {
            o.status = SellStatus.CANCELLED;
            emit MockSellOrderCancelled(orderId, 0);
            return;
        }
        // Test hook (#96): return success while neither pulling nor changing
        // status — the "neither PAID nor CANCELLED" post-state the integrator's
        // Unsettled branch exists for.
        if (forceSellUpiNoOp) {
            return;
        }
        // try/catch the pull exactly like the live facet. `_pullFor` is external so
        // the failure is caught here instead of bubbling up as a revert.
        try this._pullFor(o.user, needed) {
            o.status = SellStatus.PAID;
            emit MockSellOrderPaid(orderId);
        } catch {
            // Underfunded / failed pull → auto-cancel, return success. Nothing was
            // pulled, so there is nothing to refund; the principal the integrator
            // parked on the proxy stays there for reconcileWithdrawal to recover.
            o.status = SellStatus.CANCELLED;
            emit MockSellOrderCancelled(orderId, 0);
        }
    }

    /// @notice Test-only: when set, setSellOrderUpi takes the live Diamond's
    ///         auto-cancel-and-return-success branch (see #2/#3) regardless of
    ///         proxy funding, so the integrator's post-execute status check can be
    ///         tested directly.
    bool public forceSellUpiAutoCancel;

    function setForceSellUpiAutoCancel(bool v) external {
        forceSellUpiAutoCancel = v;
    }

    /// @notice Test-only (#96): setSellOrderUpi returns success without pulling
    ///         or moving status off ACCEPTED.
    bool public forceSellUpiNoOp;

    function setForceSellUpiNoOp(bool v) external {
        forceSellUpiNoOp = v;
    }

    /// @dev External so setSellOrderUpi can try/catch it (Solidity only catches
    ///      external calls). Reverts if the integrator underfunded/underapproved.
    function _pullFor(address from, uint256 amount) external {
        require(msg.sender == address(this), "internal");
        usdc.safeTransferFrom(from, address(this), amount);
    }

    function completeSellOrder(uint256 orderId) external {
        SellOrder storage o = sellOrders[orderId];
        require(o.status == SellStatus.PAID, "Bad state");
        o.status = SellStatus.COMPLETED;
        emit MockSellOrderCompleted(orderId);
    }

    /**
     * @notice Mocks cancellation. If cancelled while PAID, USDC refunded
     *         to order.user (= integrator).
     */
    function cancelSellOrder(uint256 orderId) external {
        SellOrder storage o = sellOrders[orderId];
        require(o.status != SellStatus.COMPLETED && o.status != SellStatus.CANCELLED, "Bad state");
        bool wasPaid = (o.status == SellStatus.PAID);
        o.status = SellStatus.CANCELLED;
        uint256 refund = 0;
        if (wasPaid) {
            // Refund what was pulled (principal + fee).
            refund = o.amount + _sellFee(o.amount);
            usdc.safeTransfer(o.user, refund);
        }
        emit MockSellOrderCancelled(orderId, refund);
    }

    function getSellOrder(uint256 orderId) external view returns (SellOrder memory) {
        return sellOrders[orderId];
    }

    /// @notice Mocks GetterFacet.getNextOrderId — the integrator reads this
    ///         before placeOrder to capture the orderId Diamond will use.
    function getNextOrderId() external view returns (uint256) {
        return nextOrderId;
    }

    /// @notice Mock of GetterFacet.getAdditionalOrderDetails. The mock has no
    ///         fees, so actualUsdtAmount == sell amount. Real Diamond returns
    ///         principal + fee here for SELL.
    struct AdditionalOrderDetailsView {
        uint64 fixedFeePaid;
        uint64 tipsPaid;
        uint128 acceptedTimestamp;
        uint128 paidTimestamp;
        uint128 reserved2;
        uint256 actualUsdtAmount;
        uint256 actualFiatAmount;
    }
    /// @notice Per-order SELL fee the Diamond pulls ON TOP of principal during
    ///         setSellOrderUpi (so actualUsdtAmount = principal + fee). Lets
    ///         tests exercise the integrator's fee top-up + allowance path.
    uint256 public sellFee;

    function setSellFee(uint256 fee) external {
        sellFee = fee;
    }

    /// @notice Test-only: stamp a dispute onto a SELL order so the integrator's
    ///         reconcile dispute guard (and the disputed-clawback recovery path)
    ///         can be exercised. Real Diamond sets these during dispute flow.
    function setSellDispute(uint256 orderId, uint8 raisedBy, uint8 status) external {
        sellOrders[orderId].disputeRaisedBy = raisedBy;
        sellOrders[orderId].disputeStatus = status;
    }

    function getAdditionalOrderDetails(
        uint256 orderId
    ) external view returns (AdditionalOrderDetailsView memory) {
        return
            AdditionalOrderDetailsView({
                fixedFeePaid: uint64(_sellFee(sellOrders[orderId].amount)),
                tipsPaid: 0,
                acceptedTimestamp: 0,
                paidTimestamp: 0,
                reserved2: 0,
                actualUsdtAmount: additionalOrderDetailsFeeUnready
                    ? 0
                    : actualUsdtAmountOverride[orderId] != 0
                        ? actualUsdtAmountOverride[orderId]
                        : sellOrders[orderId].amount + _sellFee(sellOrders[orderId].amount),
                actualFiatAmount: 0
            });
    }

    /// @notice When set, `getAdditionalOrderDetails` returns 0 for
    ///         actualUsdtAmount. Showdown's `deliverOfframpUpi` now REVERTS
    ///         `OfframpFeeNotReady` on this rather than falling back to the
    ///         principal — the fallback read as a safety net but is unreachable
    ///         for an ACCEPTED order, since the real Diamond writes
    ///         actualUsdtAmount at placement and only zeroes it on cancel. (#72)
    bool public additionalOrderDetailsFeeUnready;

    function setAdditionalOrderDetailsFeeUnready(bool v) external {
        additionalOrderDetailsFeeUnready = v;
    }

    /// @notice Force a specific `actualUsdtAmount` for one order, so tests can
    ///         express a Diamond that re-prices, partially fills or changes its
    ///         fee model — values the bps fee alone cannot produce (notably any
    ///         amount BELOW the escrowed principal). 0 = use the computed value.
    mapping(uint256 => uint256) public actualUsdtAmountOverride;

    function setActualUsdtAmountOverride(uint256 orderId, uint256 amount) external {
        actualUsdtAmountOverride[orderId] = amount;
    }

    /// @notice Mock of GetterFacet.getOrdersById. Only the `status`,
    ///         `orderType`, and `amount` fields are meaningful for the
    ///         tests that consume this — the integrator's reconcile reads
    ///         only `status`. All other fields are zero-filled.
    ///
    ///         Tests drive a sell order through the mock state machine
    ///         (acceptSellOrder / setSellOrderUpi / completeSellOrder /
    ///         cancelSellOrder) and this getter exposes the resulting
    ///         status so the integrator's reconcile sees the authoritative
    ///         terminal state.
    struct OrderView {
        uint256 amount;
        uint256 fiatAmount;
        uint256 placedTimestamp;
        uint256 completedTimestamp;
        uint256 userCompletedTimestamp;
        address acceptedMerchant;
        address user;
        address recipientAddr;
        string pubkey;
        string encUpi;
        bool userCompleted;
        uint8 status;
        uint8 orderType;
        Dispute disputeInfo;
        uint256 id;
        string userPubKey;
        string encMerchantUpi;
        uint256 acceptedAccountNo;
        uint256[] assignedAccountNos;
        bytes32 currency;
        uint256 preferredPaymentChannelConfigId;
        uint256 circleId;
    }

    struct Dispute {
        uint8 raisedBy;
        uint8 status;
        uint256 redactTransId;
        uint256 accountNumber;
    }

    /// @notice Test-only helper: directly invokes
    ///         `IP2PIntegrator.onOrderComplete` on `integrator_` with the
    ///         supplied arguments. Lets tests exercise the integrator's
    ///         onOrderComplete guards (UnexpectedRecipient / OrderAlreadyFulfilled
    ///         / the delivered-amount re-pin) without manipulating the mock's
    ///         internal `orders` mapping. (Showdown has no `AmountMismatch` guard —
    ///         that is LotPot's; Showdown re-pins instead. #55)
    function adminCallOnOrderComplete(
        address integrator_,
        uint256 orderId,
        address user_,
        uint256 amount,
        address recipientAddr
    ) external {
        IP2PIntegrator(integrator_).onOrderComplete(orderId, user_, amount, recipientAddr);
    }

    function getOrdersById(uint256 orderId) external view returns (OrderView memory o) {
        // BUY orders live in `orders`; SELL orders in `sellOrders`. A BUY id is
        // served as a BUY OrderView (so the integrator's BUY-side reads —
        // sweepStrandedBuy's status/amount/recipientAddr — resolve correctly);
        // otherwise fall through to the SELL view (reconcile/finalize/etc.).
        Order storage b = orders[orderId];
        if (b.integrator != address(0)) {
            // Map the BUY flags to the Diamond's OrderStatus codes (COMPLETED=3,
            // CANCELLED=4, else PLACED=0). Mirrors how a real completed BUY reads.
            o.status = b.completed ? 3 : (b.cancelled ? 4 : 0);
            o.orderType = 0; // BUY
            o.amount = b.amount;
            o.user = b.user;
            o.recipientAddr = b.recipientAddr;
            o.currency = b.currency;
            o.id = orderId;
            return o;
        }
        SellOrder storage s = sellOrders[orderId];
        // SellStatus enum mirrors Diamond's OrderStatus (0..4) so the cast
        // is a no-op semantically.
        o.status = uint8(s.status);
        o.orderType = 1; // SELL
        o.amount = s.amount;
        o.user = s.user;
        o.currency = s.currency;
        o.acceptedMerchant = s.acceptedMerchant; // 0 until a merchant accepts
        o.id = orderId;
        o.disputeInfo.raisedBy = s.disputeRaisedBy;
        o.disputeInfo.status = s.disputeStatus;
        // Remaining strings / arrays default-init to empty.
    }

    /**
     * @notice TEST-ONLY: reproduce the exact end-state of a BUY whose
     *         onOrderComplete callback reverted and was swallowed by the
     *         try/catch in simulateOrderComplete — the USDC is routed to the
     *         proxy and the order is marked COMPLETED protocol-side, but the
     *         integrator callback NEVER runs (so the merchant is never credited
     *         and the funds sit stranded on the proxy). This is the precise
     *         scenario sweepStrandedBuy recovers, without needing to force a
     *         contrived revert inside the real callback.
     */
    function simulateOrderCompleteNoCallback(uint256 orderId) external {
        Order storage order = orders[orderId];
        require(!order.completed, "Already completed");
        // A CANCELLED BUY is not terminal — see simulateOrderComplete / #56.
        order.completed = true;
        // Route USDC to the proxy exactly like a real completion, but skip the
        // integrator callback (the swallowed-revert end state).
        usdc.safeTransfer(order.recipientAddr, order.amount);
        emit MockOrderCompleted(orderId);
    }
}
