// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

/**
 * @title CubeSkinsIntegrator
 * @notice P2P onramp integrator for CubeSkins marketplace purchases (PIX → USDC).
 *         Order prices and buyer wallets are registered off-chain by the
 *         integrator owner before `userPlaceOrder` — users cannot alter amounts.
 *         On fiat settlement USDC is routed to the company treasury; the
 *         backend indexer marks the marketplace order as paid.
 */
contract CubeSkinsIntegrator is IP2PIntegrator {
    using SafeERC20 for IERC20;
    using Clones for address;

    // ─── Errors ───────────────────────────────────────────────────────

    error OnlyDiamond();
    error OnlyOwner();
    error InvalidAddress();
    error InvalidAmount();
    error OrderNotRegistered();
    error OrderExpired();
    error OrderAlreadyPlaced();
    error OrderAlreadyFulfilled();
    error OrderAlreadyCancelled();
    error BuyerMismatch();
    error AmountMismatch();
    error ArrayLengthMismatch();

    // ─── Events ───────────────────────────────────────────────────────

    event OrderRegistered(
        uint256 indexed marketplaceOrderId,
        address indexed buyer,
        uint256 usdcAmount,
        uint64 expiresAt
    );
    event OrderRegistrationCancelled(uint256 indexed marketplaceOrderId);
    event CheckoutOrderCreated(
        uint256 indexed p2pOrderId,
        address indexed user,
        uint256 indexed marketplaceOrderId,
        uint256 usdcAmount
    );
    event CheckoutFulfilled(
        uint256 indexed p2pOrderId,
        address indexed user,
        uint256 indexed marketplaceOrderId,
        uint256 usdcAmount
    );
    event UserProxyDeployed(address indexed user, address proxy);
    event UserRPUpdated(address indexed user, uint256 rp);
    event RpRateUpdated(bytes32 indexed currency, uint256 usdcPerRp);
    event BaseTxLimitUpdated(uint256 limit);
    event MaxTxLimitUpdated(bytes32 indexed currency, uint256 cap);
    event DailyTxCountLimitUpdated(uint256 count);

    // ─── Immutables ───────────────────────────────────────────────────

    address public immutable diamond;
    IERC20 public immutable usdc;
    address public immutable treasury;
    address public immutable owner;
    address public immutable proxyImpl;

    // ─── Configurable limits ──────────────────────────────────────────

    uint256 public baseTxLimit;
    uint256 public dailyTxCountLimit;
    mapping(bytes32 => uint256) public rpToUsdc;
    mapping(bytes32 => uint256) public maxTxLimit;
    mapping(address => uint256) public userRP;

    // ─── State ────────────────────────────────────────────────────────

    struct OrderRegistration {
        address buyer;
        uint256 usdcAmount;
        uint64 expiresAt;
        bool placed;
        bool fulfilled;
    }

    struct CheckoutSession {
        address user;
        bool fulfilled;
        bool cancelled;
        uint32 placementDay;
        uint256 marketplaceOrderId;
        uint256 usdcAmount;
    }

    mapping(uint256 => OrderRegistration) public registrations;
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

    constructor(
        address _diamond,
        address _usdc,
        address _treasury,
        uint256 _baseTxLimit,
        uint256 _dailyTxCountLimit
    ) {
        if (_diamond == address(0) || _usdc == address(0) || _treasury == address(0)) {
            revert InvalidAddress();
        }
        diamond = _diamond;
        usdc = IERC20(_usdc);
        treasury = _treasury;
        owner = msg.sender;
        baseTxLimit = _baseTxLimit;
        dailyTxCountLimit = _dailyTxCountLimit;
        proxyImpl = address(new UserProxy());
    }

    // ─── Admin: order registration ────────────────────────────────────

    /// @notice Registers a marketplace order before the buyer can pay via P2P.
    ///         Only the owner (CubeSkins backend relayer) may set price + buyer.
    function registerOrder(
        uint256 marketplaceOrderId,
        address buyer,
        uint256 usdcAmount,
        uint64 expiresAt
    ) external onlyOwner {
        if (buyer == address(0) || usdcAmount == 0) revert InvalidAddress();
        if (expiresAt <= block.timestamp) revert OrderExpired();

        OrderRegistration storage reg = registrations[marketplaceOrderId];
        if (reg.fulfilled) revert OrderAlreadyFulfilled();

        reg.buyer = buyer;
        reg.usdcAmount = usdcAmount;
        reg.expiresAt = expiresAt;
        reg.placed = false;

        emit OrderRegistered(marketplaceOrderId, buyer, usdcAmount, expiresAt);
    }

    /// @notice Cancels a pending registration (e.g. order expired in backend).
    function cancelRegistration(uint256 marketplaceOrderId) external onlyOwner {
        OrderRegistration storage reg = registrations[marketplaceOrderId];
        if (reg.fulfilled) revert OrderAlreadyFulfilled();
        delete registrations[marketplaceOrderId];
        emit OrderRegistrationCancelled(marketplaceOrderId);
    }

    // ─── Admin: limits ────────────────────────────────────────────────

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

    // ─── User-facing placement ────────────────────────────────────────

    /// @notice Places a P2P buy order for a pre-registered marketplace order.
    ///         `marketplaceOrderId` is the CubeSkins DB order id; USDC amount
    ///         is read from the owner registration — never from user input.
    function userPlaceOrder(
        uint256 marketplaceOrderId,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) external returns (uint256 orderId) {
        OrderRegistration storage reg = registrations[marketplaceOrderId];
        if (reg.buyer == address(0) || reg.usdcAmount == 0) revert OrderNotRegistered();
        if (reg.buyer != msg.sender) revert BuyerMismatch();
        if (reg.placed || reg.fulfilled) revert OrderAlreadyPlaced();
        if (block.timestamp > reg.expiresAt) revert OrderExpired();

        uint256 totalPrice = reg.usdcAmount;
        reg.placed = true;

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
            marketplaceOrderId: marketplaceOrderId,
            usdcAmount: totalPrice,
            fulfilled: false,
            cancelled: false,
            placementDay: uint32(block.timestamp / 1 days)
        });

        emit CheckoutOrderCreated(orderId, msg.sender, marketplaceOrderId, totalPrice);
    }

    // ─── IP2PIntegrator callbacks ───────────────────────────────────────

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
        if (session.usdcAmount != amount) revert AmountMismatch();

        session.fulfilled = true;

        OrderRegistration storage reg = registrations[session.marketplaceOrderId];
        if (reg.usdcAmount != amount) revert AmountMismatch();
        reg.fulfilled = true;

        usdc.safeTransfer(treasury, amount);

        emit CheckoutFulfilled(orderId, session.user, session.marketplaceOrderId, amount);
    }

    function onOrderCancel(uint256 orderId) external onlyDiamond {
        CheckoutSession storage session = sessions[orderId];
        if (session.user == address(0)) return;
        if (session.fulfilled) revert OrderAlreadyFulfilled();
        if (session.cancelled) revert OrderAlreadyCancelled();
        session.cancelled = true;

        OrderRegistration storage reg = registrations[session.marketplaceOrderId];
        if (!reg.fulfilled) {
            reg.placed = false;
        }

        uint256 day = uint256(session.placementDay);
        uint256 count = userDailyCount[session.user][day];
        if (count > 0) {
            userDailyCount[session.user][day] = count - 1;
        }
    }

    // ─── Views ────────────────────────────────────────────────────────

    function getProductPrice(uint256 marketplaceOrderId) external view returns (uint256) {
        OrderRegistration storage reg = registrations[marketplaceOrderId];
        if (reg.fulfilled || reg.buyer == address(0)) return 0;
        return reg.usdcAmount;
    }

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

    function proxyAddress(address user) public view returns (address) {
        return
            Clones.predictDeterministicAddressWithImmutableArgs(
                proxyImpl,
                _proxyArgs(user),
                _salt(user),
                address(this)
            );
    }

    // ─── Internal ─────────────────────────────────────────────────────

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
