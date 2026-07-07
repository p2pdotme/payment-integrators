// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { IOrderFlow } from "../../interfaces/IOrderFlow.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

/**
 * @title ZeroXRampDirectSettlementIntegrator
 * @notice 0xramp integrator for P2P.me Base Diamond.
 *
 * BUY/onramp:
 *   - user calls userBuyAsset(... recipientAddr = NEAR 1Click Base deposit)
 *   - UserProxy places a B2B BUY order on the Diamond
 *   - register this integrator with usdcThroughIntegrator=false
 *   - on completion, the Diamond sends USDC directly to recipientAddr
 *
 * SELL/cashout:
 *   - user approves USDC to this integrator
 *   - userStartOfframp pulls principal into the user's proxy and places SELL
 *   - deliverOfframpUpi tops up the proxy with the final fee shortfall and lets
 *     the proxy call setSellOrderUpi so the Diamond can pull principal + fee
 */
contract ZeroXRampDirectSettlementIntegrator is IP2PIntegrator {
    using SafeERC20 for IERC20;

    enum SessionKind {
        Unknown,
        Checkout,
        Cashout
    }

    struct Session {
        address user;
        address recipientAddr;
        bytes32 intentHash;
        uint32 placementDay;
        uint256 amount;
        SessionKind kind;
        bool paymentDelivered;
        bool fulfilled;
        bool cancelled;
    }

    error OnlyDiamond();
    error OnlyOwner();
    error InvalidAddress();
    error InvalidAmount();
    error DailyTxCountExceeded();
    error DailyVolumeExceeded();
    error PerTxLimitExceeded();
    error UnknownOrder();
    error NotOrderUser();
    error OrderAlreadyFulfilled();
    error OrderAlreadyCancelled();
    error PaymentAlreadyDelivered();
    error CashoutAlreadyActive();
    error OrderNotTerminal();

    event UserProxyDeployed(address indexed user, address proxy);
    event ZeroXRampCheckoutOrderCreated(
        uint256 indexed orderId,
        address indexed user,
        address indexed recipientAddr,
        bytes32 intentHash,
        uint256 amount,
        bytes32 currency
    );
    event ZeroXRampCashoutStarted(
        uint256 indexed orderId,
        address indexed user,
        address indexed proxy,
        uint256 amount,
        bytes32 currency
    );
    event ZeroXRampCashoutPaymentDelivered(
        uint256 indexed orderId,
        address indexed user,
        uint256 actualUsdcAmount
    );
    event ZeroXRampOrderCompleted(uint256 indexed orderId, address indexed user);
    event ZeroXRampOrderCancelled(uint256 indexed orderId, address indexed user);
    event LimitsUpdated(
        uint256 perTxUsdcLimit,
        uint256 dailyTxCountLimit,
        uint256 dailyUsdcVolumeLimit
    );

    address public immutable diamond;
    IERC20 public immutable usdc;
    address public immutable owner;
    address public immutable proxyImpl;

    uint256 public perTxUsdcLimit;
    uint256 public dailyTxCountLimit;
    uint256 public dailyUsdcVolumeLimit;

    mapping(uint256 => Session) public sessions;
    mapping(address => address) public proxyToUser;
    mapping(address => bool) public activeCashout;
    mapping(address => mapping(uint256 => uint256)) public userDailyCount;
    mapping(address => mapping(uint256 => uint256)) public userDailyVolume;

    constructor(
        address _diamond,
        address _usdc,
        address _owner,
        uint256 _perTxUsdcLimit,
        uint256 _dailyTxCountLimit,
        uint256 _dailyUsdcVolumeLimit
    ) {
        if (_diamond == address(0) || _usdc == address(0) || _owner == address(0)) {
            revert InvalidAddress();
        }

        diamond = _diamond;
        usdc = IERC20(_usdc);
        owner = _owner;
        proxyImpl = address(new UserProxy());
        perTxUsdcLimit = _perTxUsdcLimit;
        dailyTxCountLimit = _dailyTxCountLimit;
        dailyUsdcVolumeLimit = _dailyUsdcVolumeLimit;
    }

    modifier onlyDiamond() {
        if (msg.sender != diamond) revert OnlyDiamond();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    function setLimits(
        uint256 _perTxUsdcLimit,
        uint256 _dailyTxCountLimit,
        uint256 _dailyUsdcVolumeLimit
    ) external onlyOwner {
        perTxUsdcLimit = _perTxUsdcLimit;
        dailyTxCountLimit = _dailyTxCountLimit;
        dailyUsdcVolumeLimit = _dailyUsdcVolumeLimit;
        emit LimitsUpdated(_perTxUsdcLimit, _dailyTxCountLimit, _dailyUsdcVolumeLimit);
    }

    function userTxLimit() external view returns (uint256) {
        return perTxUsdcLimit;
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

    function availableOfframp(address user) external view returns (uint256) {
        return usdc.balanceOf(proxyAddress(user));
    }

    function userBuyAsset(
        address recipientAddr,
        bytes32 intentHash,
        uint256 amount,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) external returns (uint256 orderId) {
        if (recipientAddr == address(0)) revert InvalidAddress();
        _precheckLimit(msg.sender, amount);

        address proxy = _ensureProxy(msg.sender);
        bytes memory data = abi.encodeCall(
            IB2BGateway.placeB2BOrder,
            (
                msg.sender,
                amount,
                currency,
                recipientAddr,
                pubKey,
                circleId,
                preferredPaymentChannelConfigId,
                fiatAmountLimit
            )
        );
        bytes memory result = UserProxy(proxy).execute(diamond, data, address(usdc), 0);
        orderId = abi.decode(result, (uint256));

        sessions[orderId] = Session({
            user: msg.sender,
            recipientAddr: recipientAddr,
            intentHash: intentHash,
            placementDay: uint32(block.timestamp / 1 days),
            amount: amount,
            kind: SessionKind.Checkout,
            paymentDelivered: false,
            fulfilled: false,
            cancelled: false
        });

        emit ZeroXRampCheckoutOrderCreated(
            orderId,
            msg.sender,
            recipientAddr,
            intentHash,
            amount,
            currency
        );
    }

    function userStartOfframp(
        uint256 amount,
        bytes32 currency,
        uint256 fiatAmountLimit,
        uint256 circleId,
        uint256 preferredPaymentChannelConfigId,
        string calldata userPubKey
    ) external returns (uint256 orderId) {
        if (activeCashout[msg.sender]) revert CashoutAlreadyActive();
        _precheckLimit(msg.sender, amount);

        address proxy = _ensureProxy(msg.sender);
        usdc.safeTransferFrom(msg.sender, proxy, amount);

        bytes memory data = abi.encodeCall(
            IB2BGateway.placeB2BSellOrder,
            (
                proxy,
                amount,
                currency,
                userPubKey,
                circleId,
                preferredPaymentChannelConfigId,
                fiatAmountLimit
            )
        );
        bytes memory result = UserProxy(proxy).execute(diamond, data, address(usdc), 0);
        orderId = abi.decode(result, (uint256));

        activeCashout[msg.sender] = true;
        sessions[orderId] = Session({
            user: msg.sender,
            recipientAddr: proxy,
            intentHash: bytes32(0),
            placementDay: uint32(block.timestamp / 1 days),
            amount: amount,
            kind: SessionKind.Cashout,
            paymentDelivered: false,
            fulfilled: false,
            cancelled: false
        });

        emit ZeroXRampCashoutStarted(orderId, msg.sender, proxy, amount, currency);
    }

    function deliverOfframpUpi(uint256 orderId, string calldata encUpi) external {
        Session storage session = _requireSession(orderId);
        if (session.kind != SessionKind.Cashout) revert UnknownOrder();
        if (session.user != msg.sender) revert NotOrderUser();
        if (session.fulfilled) revert OrderAlreadyFulfilled();
        if (session.cancelled) revert OrderAlreadyCancelled();
        if (session.paymentDelivered) revert PaymentAlreadyDelivered();

        address proxy = session.recipientAddr;
        IOrderFlow.AdditionalOrderDetailsView memory details = IOrderFlow(diamond)
            .getAdditionalOrderDetails(orderId);
        uint256 actualUsdcAmount = details.actualUsdtAmount == 0
            ? session.amount
            : details.actualUsdtAmount;

        uint256 proxyBalance = usdc.balanceOf(proxy);
        if (proxyBalance < actualUsdcAmount) {
            usdc.safeTransferFrom(msg.sender, proxy, actualUsdcAmount - proxyBalance);
        }

        bytes memory data = abi.encodeCall(
            IOrderFlow.setSellOrderUpi,
            (orderId, encUpi, uint256(0))
        );
        UserProxy(proxy).execute(diamond, data, address(usdc), actualUsdcAmount);
        session.paymentDelivered = true;

        emit ZeroXRampCashoutPaymentDelivered(orderId, msg.sender, actualUsdcAmount);
    }

    function syncOfframp(uint256 orderId, uint8 currentStatus) external {
        Session storage session = _requireSession(orderId);
        if (session.kind != SessionKind.Cashout) revert UnknownOrder();
        if (session.fulfilled || session.cancelled) {
            activeCashout[session.user] = false;
            return;
        }

        IOrderFlow.OrderView memory order = IOrderFlow(diamond).getOrdersById(orderId);
        uint8 status = order.status;
        if (status != 3 && status != 4) revert OrderNotTerminal();
        if (currentStatus != 0 && currentStatus != status) revert OrderNotTerminal();

        if (status == 3) {
            session.fulfilled = true;
            emit ZeroXRampOrderCompleted(orderId, session.user);
        } else {
            session.cancelled = true;
            _releaseDailySlot(session);
            emit ZeroXRampOrderCancelled(orderId, session.user);
        }

        activeCashout[session.user] = false;
        _sweepProxyUsdcToUser(session.user);
    }

    function validateOrder(
        address user,
        uint256 amount,
        bytes32
    ) external onlyDiamond returns (bool allowed) {
        address account = proxyToUser[user] == address(0) ? user : proxyToUser[user];
        if (account == address(0) || amount == 0) return false;
        if (perTxUsdcLimit != 0 && amount > perTxUsdcLimit) return false;

        uint256 day = block.timestamp / 1 days;
        if (dailyTxCountLimit != 0) {
            uint256 count = userDailyCount[account][day];
            if (count + 1 > dailyTxCountLimit) return false;
            userDailyCount[account][day] = count + 1;
        }

        if (dailyUsdcVolumeLimit != 0) {
            uint256 volume = userDailyVolume[account][day];
            if (volume + amount > dailyUsdcVolumeLimit) return false;
            userDailyVolume[account][day] = volume + amount;
        }

        return true;
    }

    function onOrderComplete(uint256 orderId, address, uint256, address) external onlyDiamond {
        Session storage session = sessions[orderId];
        if (session.user == address(0)) return;
        if (session.fulfilled || session.cancelled) return;

        session.fulfilled = true;
        if (session.kind == SessionKind.Cashout) {
            activeCashout[session.user] = false;
            _sweepProxyUsdcToUser(session.user);
        }

        emit ZeroXRampOrderCompleted(orderId, session.user);
    }

    function onOrderCancel(uint256 orderId) external onlyDiamond {
        Session storage session = sessions[orderId];
        if (session.user == address(0)) return;
        if (session.fulfilled || session.cancelled) return;

        session.cancelled = true;
        _releaseDailySlot(session);
        if (session.kind == SessionKind.Cashout) {
            activeCashout[session.user] = false;
            _sweepProxyUsdcToUser(session.user);
        }

        emit ZeroXRampOrderCancelled(orderId, session.user);
    }

    function _precheckLimit(address user, uint256 amount) internal view {
        if (amount == 0) revert InvalidAmount();
        if (perTxUsdcLimit != 0 && amount > perTxUsdcLimit) revert PerTxLimitExceeded();

        uint256 day = block.timestamp / 1 days;
        if (dailyTxCountLimit != 0 && userDailyCount[user][day] + 1 > dailyTxCountLimit) {
            revert DailyTxCountExceeded();
        }
        if (
            dailyUsdcVolumeLimit != 0 && userDailyVolume[user][day] + amount > dailyUsdcVolumeLimit
        ) {
            revert DailyVolumeExceeded();
        }
    }

    function _requireSession(uint256 orderId) internal view returns (Session storage session) {
        session = sessions[orderId];
        if (session.user == address(0)) revert UnknownOrder();
    }

    function _releaseDailySlot(Session storage session) internal {
        uint256 day = uint256(session.placementDay);

        uint256 count = userDailyCount[session.user][day];
        if (count > 0) userDailyCount[session.user][day] = count - 1;

        uint256 volume = userDailyVolume[session.user][day];
        userDailyVolume[session.user][day] = volume > session.amount ? volume - session.amount : 0;
    }

    function _sweepProxyUsdcToUser(address user) internal {
        address proxy = proxyAddress(user);
        uint256 balance = usdc.balanceOf(proxy);
        if (balance == 0) return;
        UserProxy(proxy).transferERC20ToIntegrator(address(usdc), balance);
        usdc.safeTransfer(user, balance);
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
        proxyToUser[proxy] = user;
    }

    function _salt(address user) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(user)));
    }

    function _proxyArgs(address user) internal view returns (bytes memory) {
        return abi.encodePacked(user, address(this));
    }
}
