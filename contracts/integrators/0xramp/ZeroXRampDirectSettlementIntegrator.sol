// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { IOrderFlow } from "../../interfaces/IOrderFlow.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

interface IP2PUserLimits {
    function userTxLimit(
        address user,
        bytes32 currency
    ) external view returns (uint256 buyLimit, uint256 sellLimit);
}

/**
 * @title ZeroXRampDirectSettlementIntegrator
 * @notice EXPERIMENTAL V2 candidate for the 0xramp P2P.me Base Diamond adapter.
 *         This source is not the bytecode deployed at the documented V1
 *         addresses and must not be deployed before issue #12 is complete.
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

    struct PendingValidation {
        uint256 amount;
        uint256 protocolLimit;
        bytes32 currency;
        bool isSell;
        bool active;
    }

    error OnlyDiamond();
    error OnlyOwner();
    error InvalidAddress();
    error InvalidAmount();
    error DailyTxCountExceeded();
    error DailyVolumeExceeded();
    error PerTxLimitExceeded();
    error P2PAccountLimitExceeded(uint256 amount, uint256 limit);
    error P2PLimitsUnavailable();
    error PendingValidationExists();
    error ValidationNotConsumed();
    error UnknownOrder();
    error NotOrderUser();
    error OrderAlreadyFulfilled();
    error OrderAlreadyCancelled();
    error PaymentAlreadyDelivered();
    error CashoutAlreadyActive();
    error OrderNotTerminal();
    error OrderNotPaid(uint8 status);

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
    mapping(address => PendingValidation) private pendingValidations;

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

    function effectiveUserTxLimit(
        address user,
        bytes32 currency,
        bool isSell
    ) external view returns (uint256) {
        uint256 protocolLimit = _protocolTxLimit(user, currency, isSell);
        uint256 appLimit = perTxUsdcLimit;
        return appLimit != 0 && appLimit < protocolLimit ? appLimit : protocolLimit;
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
        _prepareValidation(msg.sender, amount, currency, false);

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
        _assertValidationConsumed(msg.sender);
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
        _prepareValidation(msg.sender, amount, currency, true);

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
        _assertValidationConsumed(msg.sender);
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

        // The Diamond's setSellOrderUpi can auto-cancel the order and return
        // success instead of reverting; a delivery may only be recorded when
        // the order actually reached PAID (status 2) — any other outcome did
        // not survive the call and reverts atomically.
        uint8 statusAfter = IOrderFlow(diamond).getOrdersById(orderId).status;
        if (statusAfter != 2) revert OrderNotPaid(statusAfter);
        session.paymentDelivered = true;

        emit ZeroXRampCashoutPaymentDelivered(orderId, msg.sender, actualUsdcAmount);
    }

    function syncOfframp(uint256 orderId, uint8 currentStatus) external {
        Session storage session = _requireSession(orderId);
        if (session.kind != SessionKind.Cashout) revert UnknownOrder();
        // Every terminal transition already clears the cashout lock at
        // transition time (below and in onOrderComplete/onOrderCancel); a
        // replayed sync on an already-final session must not touch the lock,
        // which may belong to a newer in-flight cashout.
        if (session.fulfilled || session.cancelled) return;

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
        bytes32 currency
    ) external onlyDiamond returns (bool allowed) {
        address mappedUser = proxyToUser[user];
        bool isSell = mappedUser != address(0);
        address account = isSell ? mappedUser : user;
        if (account == address(0) || amount == 0) return false;

        PendingValidation memory pending = pendingValidations[account];
        if (
            !pending.active ||
            pending.amount != amount ||
            pending.currency != currency ||
            pending.isSell != isSell ||
            amount > pending.protocolLimit
        ) {
            return false;
        }
        delete pendingValidations[account];

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

    function _prepareValidation(
        address user,
        uint256 amount,
        bytes32 currency,
        bool isSell
    ) internal {
        _precheckAppLimit(user, amount);
        if (pendingValidations[user].active) revert PendingValidationExists();

        uint256 protocolLimit = _protocolTxLimit(user, currency, isSell);
        if (protocolLimit == 0 || amount > protocolLimit) {
            revert P2PAccountLimitExceeded(amount, protocolLimit);
        }

        pendingValidations[user] = PendingValidation({
            amount: amount,
            protocolLimit: protocolLimit,
            currency: currency,
            isSell: isSell,
            active: true
        });
    }

    function _assertValidationConsumed(address user) internal view {
        if (pendingValidations[user].active) revert ValidationNotConsumed();
    }

    function _protocolTxLimit(
        address user,
        bytes32 currency,
        bool isSell
    ) internal view returns (uint256) {
        try IP2PUserLimits(diamond).userTxLimit(user, currency) returns (
            uint256 buyLimit,
            uint256 sellLimit
        ) {
            return isSell ? sellLimit : buyLimit;
        } catch {
            revert P2PLimitsUnavailable();
        }
    }

    function _precheckAppLimit(address user, uint256 amount) internal view {
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
