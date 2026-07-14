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
    }

    struct SellOrder {
        address user; // = order.user (integrator address in our flow)
        uint256 amount;
        bytes32 currency;
        SellStatus status;
        string encUpi; // user's UPI encrypted to merchant
        string merchantPubkey;
        uint8 disputeRaisedBy; // test-only: mirror Diamond's Dispute.raisedBy
        uint8 disputeStatus;   // test-only: mirror Diamond's Dispute.status
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

        bool allowed = IP2PIntegrator(effectiveIntegrator).validateOrder(user, amount, currency);
        require(allowed, "Validation failed");

        orderId = nextOrderId++;
        orders[orderId] = Order({
            integrator: effectiveIntegrator,
            user: user,
            amount: amount,
            currency: currency,
            recipientAddr: recipientAddr,
            completed: false,
            cancelled: false
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
        order.completed = true;

        // Transfer USDC to recipientAddr (mirrors usdcThroughIntegrator = false)
        usdc.safeTransfer(order.recipientAddr, order.amount);

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
        emit MockSellOrderAccepted(orderId);
    }

    /**
     * @notice Mocks OrderFlowFacet.setSellOrderUpi: pulls USDC from order.user
     *         (= integrator) into the Diamond and transitions to PAID.
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
        o.status = SellStatus.PAID;
        // Pull principal + fee (actualUsdtAmount), exactly as the live Diamond.
        // If the integrator only funded/approved principal, this reverts —
        // catching the "fee bug" the unit suite previously missed.
        usdc.safeTransferFrom(o.user, address(this), o.amount + sellFee);
        emit MockSellOrderPaid(orderId);
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
            refund = o.amount + sellFee;
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
                fixedFeePaid: uint64(sellFee),
                tipsPaid: 0,
                acceptedTimestamp: 0,
                paidTimestamp: 0,
                reserved2: 0,
                actualUsdtAmount: additionalOrderDetailsFeeUnready
                    ? 0
                    : sellOrders[orderId].amount + sellFee,
                actualFiatAmount: 0
            });
    }

    /// @notice When set, `getAdditionalOrderDetails` returns 0 for
    ///         actualUsdtAmount instead of the order amount. Used by tests
    ///         to exercise the `OfframpFeeNotReady` revert path in
    ///         deliverOfframpUpi without having to mutate sellOrders.amount.
    bool public additionalOrderDetailsFeeUnready;

    function setAdditionalOrderDetailsFeeUnready(bool v) external {
        additionalOrderDetailsFeeUnready = v;
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
    ///         defense-in-depth guards (AmountMismatch / UnknownOrder /
    ///         OrderAlreadyCancelled) without having to manipulate the
    ///         mock's internal `orders` mapping.
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
        SellOrder storage s = sellOrders[orderId];
        // SellStatus enum mirrors Diamond's OrderStatus (0..4) so the cast
        // is a no-op semantically.
        o.status = uint8(s.status);
        o.orderType = 1; // SELL
        o.amount = s.amount;
        o.user = s.user;
        o.currency = s.currency;
        o.id = orderId;
        o.disputeInfo.raisedBy = s.disputeRaisedBy;
        o.disputeInfo.status = s.disputeStatus;
        // Remaining strings / arrays default-init to empty.
    }
}
