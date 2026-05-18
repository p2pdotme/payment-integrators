// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { IP2PIntegrator } from "../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../interfaces/IB2BGateway.sol";
import { ICheckoutClient } from "../interfaces/ICheckoutClient.sol";
import { UserProxy } from "../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

/**
 * @title ExampleIntegrator
 * @notice Reference implementation of `IP2PIntegrator` shipped as a
 *         starting point for new integrators. Not deployed in production.
 *         Demonstrates the full lifecycle a real integrator must support:
 *
 *           1. Client registration + per-product pricing
 *           2. Per-tx USDC limits (RP-based, per-currency)
 *           3. Daily transaction count limit per user
 *           4. Quantity-based orders (unitPrice × quantity)
 *           5. Order placement via a per-user `UserProxy` clone (CREATE2)
 *           6. `onOrderComplete` callback from the Diamond -> client.onCheckoutPayment
 *           7. `onOrderCancel` reversal of consumed daily-count debits
 *
 *         See `docs/ARCHITECTURE.md` and `docs/PROXY-PATTERN.md` for the
 *         conceptual model, and `templates/MyIntegrator.sol` for a
 *         stripped-down starter you can fork.
 */
contract ExampleIntegrator is IP2PIntegrator {
    using SafeERC20 for IERC20;

    // ─── Errors ───────────────────────────────────────────────────────

    error OnlyDiamond();
    error OnlyOwner();
    error ClientNotRegistered();
    error ProductNotFound();
    error OrderAlreadyFulfilled();
    error OrderAlreadyCancelled();
    error InvalidAddress();
    error InvalidQuantity();
    error ArrayLengthMismatch();

    // ─── Events ───────────────────────────────────────────────────────

    event CheckoutOrderCreated(
        uint256 indexed orderId,
        address indexed user,
        address indexed client,
        uint256 productId,
        uint256 quantity,
        uint256 totalUsdcAmount
    );
    event CheckoutFulfilled(
        uint256 indexed orderId,
        address indexed user,
        address indexed client,
        uint256 productId,
        uint256 quantity
    );
    event ClientRegistered(address indexed client);
    event ClientRemoved(address indexed client);
    event UserProxyDeployed(address indexed user, address proxy);

    event UserRPUpdated(address indexed user, uint256 rp);
    event RpRateUpdated(bytes32 indexed currency, uint256 usdcPerRp);
    event BaseTxLimitUpdated(uint256 limit);
    event MaxTxLimitUpdated(bytes32 indexed currency, uint256 cap);
    event DailyTxCountLimitUpdated(uint256 count);

    // ─── Immutables ───────────────────────────────────────────────────

    address public immutable diamond;
    IERC20 public immutable usdc;
    address public immutable owner;
    /// @notice The UserProxy implementation that all per-user clones delegate to.
    ///         Pinned in the Diamond's IntegratorConfig at registerIntegrator time.
    address public immutable proxyImpl;

    // ─── Configurable Limits ──────────────────────────────────────────

    uint256 public baseTxLimit;
    uint256 public dailyTxCountLimit;
    mapping(bytes32 => uint256) public rpToUsdc;
    mapping(bytes32 => uint256) public maxTxLimit;
    mapping(address => uint256) public userRP;

    // ─── State ────────────────────────────────────────────────────────

    struct ClientConfig {
        bool isRegistered;
    }

    struct CheckoutSession {
        address user; // 20 bytes
        bool fulfilled; //  1 byte  — packs with user
        bool cancelled; //  1 byte  — packs with user (PLACED → fulfilled XOR cancelled)
        uint32 placementDay; //  4 bytes — pinned for onOrderCancel decrement keying
        address client;
        uint256 productId;
        uint256 quantity;
        uint256 usdcAmount;
    }

    mapping(address => ClientConfig) public clients;
    mapping(uint256 => CheckoutSession) public sessions;
    mapping(address => mapping(uint256 => uint256)) public userDailyCount;

    // ─── Modifiers ────────────────────────────────────────────────────

    modifier onlyDiamond() {
        if (msg.sender != diamond) revert OnlyDiamond();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────

    constructor(address _diamond, address _usdc, uint256 _baseTxLimit, uint256 _dailyTxCountLimit) {
        if (_diamond == address(0) || _usdc == address(0)) revert InvalidAddress();
        diamond = _diamond;
        usdc = IERC20(_usdc);
        owner = msg.sender;
        baseTxLimit = _baseTxLimit;
        dailyTxCountLimit = _dailyTxCountLimit;
        proxyImpl = address(new UserProxy());
    }

    // ─── Admin: Limits ────────────────────────────────────────────────

    function setBaseTxLimit(uint256 limit) external onlyOwner {
        baseTxLimit = limit;
        emit BaseTxLimitUpdated(limit);
    }

    function setDailyTxCountLimit(uint256 count) external onlyOwner {
        dailyTxCountLimit = count;
        emit DailyTxCountLimitUpdated(count);
    }

    function setRpToUsdc(bytes32 currency, uint256 usdcPerRp) external onlyOwner {
        rpToUsdc[currency] = usdcPerRp;
        emit RpRateUpdated(currency, usdcPerRp);
    }

    function setMaxTxLimit(bytes32 currency, uint256 cap) external onlyOwner {
        maxTxLimit[currency] = cap;
        emit MaxTxLimitUpdated(currency, cap);
    }

    // ─── Admin: User RP ───────────────────────────────────────────────

    function setUserRP(address user, uint256 rp) external onlyOwner {
        userRP[user] = rp;
        emit UserRPUpdated(user, rp);
    }

    function batchSetUserRP(address[] calldata users, uint256[] calldata rps) external onlyOwner {
        if (users.length != rps.length) revert ArrayLengthMismatch();
        for (uint256 i = 0; i < users.length; i++) {
            userRP[users[i]] = rps[i];
            emit UserRPUpdated(users[i], rps[i]);
        }
    }

    // ─── Admin: Clients ───────────────────────────────────────────────

    function registerClient(address client) external onlyOwner {
        if (client == address(0)) revert InvalidAddress();
        clients[client].isRegistered = true;
        emit ClientRegistered(client);
    }

    function removeClient(address client) external onlyOwner {
        clients[client].isRegistered = false;
        emit ClientRemoved(client);
    }

    // ─── User-Facing Order Placement ──────────────────────────────────

    /**
     * @notice End-user places a checkout order for `quantity` units of a product.
     *         Total cost = unitPrice × quantity.
     */
    function userPlaceOrder(
        address client,
        uint256 productId,
        uint256 quantity,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) external returns (uint256 orderId) {
        if (!clients[client].isRegistered) revert ClientNotRegistered();
        if (quantity == 0) revert InvalidQuantity();

        uint256 unitPrice = ICheckoutClient(client).getProductPrice(productId);
        if (unitPrice == 0) revert ProductNotFound();

        uint256 totalPrice = unitPrice * quantity;

        // Proxy-as-placer: B2BGatewayFacet is proxy-only — it rejects direct
        // integrator calls. The user's UserProxy is the msg.sender that invokes
        // placeB2BOrder; the gateway resolves msg.sender → integrator by
        // reading proxy.integrator() and re-deriving the CREATE2 clone address
        // against the integrator's pinned proxyImpl.
        // recipientAddr stays as `address(this)` and the integrator is
        // registered with usdcThroughIntegrator = true, so completion routes
        // USDC back here for the existing onOrderComplete → client hand-off
        // (the proxy is a thin placement vehicle, not a USDC router).
        address proxy = _ensureProxy(msg.sender);
        bytes memory data = abi.encodeCall(
            IB2BGateway.placeB2BOrder,
            (
                msg.sender,
                totalPrice,
                currency,
                address(this),
                pubKey,
                circleId,
                preferredPaymentChannelConfigId,
                fiatAmountLimit
            )
        );
        bytes memory result = UserProxy(proxy).execute(diamond, data, address(usdc), 0);
        orderId = abi.decode(result, (uint256));

        sessions[orderId] = CheckoutSession({
            user: msg.sender,
            client: client,
            productId: productId,
            quantity: quantity,
            usdcAmount: totalPrice,
            fulfilled: false,
            cancelled: false,
            placementDay: uint32(block.timestamp / 1 days)
        });

        emit CheckoutOrderCreated(orderId, msg.sender, client, productId, quantity, totalPrice);
    }

    // ─── IP2PIntegrator Callbacks ─────────────────────────────────────

    function validateOrder(
        address user,
        uint256 amount,
        bytes32 currency
    ) external onlyDiamond returns (bool allowed) {
        uint256 txLimit = getUserTxLimit(user, currency);
        if (amount > txLimit) return false;

        uint256 dayIndex = block.timestamp / 1 days;
        uint256 count = userDailyCount[user][dayIndex];
        if (count + 1 > dailyTxCountLimit) return false;

        userDailyCount[user][dayIndex] = count + 1;
        return true;
    }

    function onOrderComplete(
        uint256 orderId,
        address /* user */,
        uint256 amount,
        address /* recipientAddr */
    ) external onlyDiamond {
        CheckoutSession storage session = sessions[orderId];
        if (session.fulfilled) revert OrderAlreadyFulfilled();

        session.fulfilled = true;

        usdc.safeTransfer(session.client, amount);
        ICheckoutClient(session.client).onCheckoutPayment(
            session.user,
            amount,
            session.productId,
            session.quantity
        );

        emit CheckoutFulfilled(
            orderId,
            session.user,
            session.client,
            session.productId,
            session.quantity
        );
    }

    /// @notice Cancellation hook — releases the userDailyCount slot reserved
    ///         at validateOrder, keyed on the placement-day snapshot so the
    ///         decrement lands in the bucket validateOrder bumped (rather
    ///         than in today's bucket, which may differ).
    function onOrderCancel(uint256 orderId) external onlyDiamond {
        CheckoutSession storage session = sessions[orderId];
        if (session.user == address(0)) return;
        if (session.fulfilled) revert OrderAlreadyFulfilled();
        if (session.cancelled) revert OrderAlreadyCancelled();
        session.cancelled = true;

        uint256 day = uint256(session.placementDay);
        uint256 count = userDailyCount[session.user][day];
        if (count > 0) {
            userDailyCount[session.user][day] = count - 1;
        }
    }

    // ─── View Functions ───────────────────────────────────────────────

    function getUserTxLimit(address user, bytes32 currency) public view returns (uint256) {
        uint256 rp = userRP[user];
        if (rp == 0) return baseTxLimit;

        uint256 rate = rpToUsdc[currency];
        if (rate == 0) rate = 1e6;
        uint256 limit = rp * rate;

        uint256 cap = maxTxLimit[currency];
        if (cap > 0 && limit > cap) return cap;
        return limit;
    }

    function getRemainingDailyCount(address user) external view returns (uint256) {
        uint256 dayIndex = block.timestamp / 1 days;
        uint256 count = userDailyCount[user][dayIndex];
        if (count >= dailyTxCountLimit) return 0;
        return dailyTxCountLimit - count;
    }

    function getTodayCount(address user) external view returns (uint256) {
        return userDailyCount[user][block.timestamp / 1 days];
    }

    function getSession(uint256 orderId) external view returns (CheckoutSession memory) {
        return sessions[orderId];
    }

    /// @notice Predicts the deterministic UserProxy address for `user`. The
    ///         clone may not be deployed yet — check `code.length` if needed.
    function proxyAddress(address user) public view returns (address) {
        return
            Clones.predictDeterministicAddressWithImmutableArgs(
                proxyImpl,
                _proxyArgs(user),
                _salt(user),
                address(this)
            );
    }

    // ─── Internal: proxy helpers ──────────────────────────────────────

    function _salt(address user) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(user)));
    }

    function _proxyArgs(address user) internal view returns (bytes memory) {
        return abi.encodePacked(user, address(this));
    }

    function _ensureProxy(address user) internal returns (address proxy) {
        proxy = proxyAddress(user);
        if (proxy.code.length == 0) {
            address deployed = Clones.cloneDeterministicWithImmutableArgs(
                proxyImpl,
                _proxyArgs(user),
                _salt(user)
            );
            assert(deployed == proxy);
            emit UserProxyDeployed(user, proxy);
        }
    }
}
