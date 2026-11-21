// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title OrwizIntegrator
 * @notice Immutable P2P B2B integrator for Orwiz SaaS subscriptions on Base.
 *         End-users pay in local fiat (e.g., VES / Pago Movil) and the P2P
 *         Diamond settles USDC directly to Orwiz's configurable cold treasury
 *         wallet via `onOrderComplete`.
 *
 *         Registration on B2BGatewayFacet MUST set `usdcThroughIntegrator = true`
 *         and `proxyImpl = integrator.proxyImpl()`. In addition, `placeB2BOrder`
 *         pins `recipientAddr = address(this)` so settlement USDC always lands
 *         on this contract before being forwarded 100% to `treasury`.
 */
contract OrwizIntegrator is IP2PIntegrator, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Errors ───────────────────────────────────────────────────────

    error OnlyDiamond();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidIntentHash();
    error InvalidLimit();
    error LimitExceedsCeiling();
    error IntentAlreadyActive();
    error IntentAlreadySettled();
    error TxLimitExceeded();
    error DailyLimitExceeded();
    error OrderNotFound();
    error OrderAlreadySettled();
    error OrderAlreadyCancelled();
    error OrderIdAlreadyUsed();
    error RenounceDisabled();

    // ─── Events ───────────────────────────────────────────────────────

    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event MaxTxLimitUpdated(uint256 newLimit);
    event DailyTxCountLimitUpdated(uint256 newLimit);
    event UserProxyDeployed(address indexed user, address proxy);

    event SubscriptionOrderCreated(
        bytes32 indexed intentHash,
        uint256 indexed orderId,
        address indexed payer,
        uint256 usdcAmount,
        bytes32 currency
    );

    event SubscriptionSettled(
        bytes32 indexed intentHash,
        uint256 indexed orderId,
        address indexed payer,
        uint256 usdcAmount,
        address treasury
    );

    event SubscriptionOrderCancelled(bytes32 indexed intentHash, uint256 indexed orderId);

    // ─── Immutable Policy Ceilings ────────────────────────────────────

    uint256 public constant MAX_TX_LIMIT = 500e6;
    uint256 public constant MAX_DAILY_TX_COUNT_LIMIT = 20;

    // ─── Immutables ───────────────────────────────────────────────────

    address public immutable diamond;
    /// @notice Exposed as `usdc()` for canonical UserProxy.sweepERC20 checks.
    IERC20 public immutable usdc;
    /// @notice Canonical UserProxy implementation pinned in Diamond at registration.
    address public immutable proxyImpl;

    // ─── Configurable State ───────────────────────────────────────────

    address public treasury;
    uint256 public maxTxLimit;
    uint256 public dailyTxCountLimit;

    // ─── Order & Limit State ──────────────────────────────────────────

    struct SubscriptionOrder {
        address payer;
        uint32 placementDay;
        bool settled;
        bool cancelled;
        uint256 usdcAmount;
    }

    mapping(uint256 => SubscriptionOrder) public orders;
    mapping(uint256 => bytes32) public orderToIntent;
    mapping(bytes32 => uint256) public intentToOrder;
    mapping(bytes32 => bool) public settledIntents;
    mapping(address => mapping(uint256 => uint256)) public userDailyCount;

    // ─── Modifiers ────────────────────────────────────────────────────

    modifier onlyDiamond() {
        if (msg.sender != diamond) revert OnlyDiamond();
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────

    constructor(
        address _diamond,
        address _usdc,
        address _treasury,
        uint256 _maxTxLimit,
        uint256 _dailyTxCountLimit
    ) Ownable(msg.sender) {
        if (_diamond == address(0) || _usdc == address(0) || _treasury == address(0)) {
            revert InvalidAddress();
        }
        if (_maxTxLimit == 0 || _dailyTxCountLimit == 0) revert InvalidLimit();
        if (_maxTxLimit > MAX_TX_LIMIT || _dailyTxCountLimit > MAX_DAILY_TX_COUNT_LIMIT) {
            revert LimitExceedsCeiling();
        }

        diamond = _diamond;
        usdc = IERC20(_usdc);
        treasury = _treasury;
        maxTxLimit = _maxTxLimit;
        dailyTxCountLimit = _dailyTxCountLimit;
        proxyImpl = address(new UserProxy());

        emit TreasuryUpdated(address(0), _treasury);
        emit MaxTxLimitUpdated(_maxTxLimit);
        emit DailyTxCountLimitUpdated(_dailyTxCountLimit);
    }

    // ─── Admin ────────────────────────────────────────────────────────

    /**
     * @notice Rotates the cold treasury wallet that receives settled USDC.
     */
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert InvalidAddress();
        address oldTreasury = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(oldTreasury, newTreasury);
    }

    function setMaxTxLimit(uint256 newLimit) external onlyOwner {
        if (newLimit == 0) revert InvalidLimit();
        if (newLimit > MAX_TX_LIMIT) revert LimitExceedsCeiling();
        maxTxLimit = newLimit;
        emit MaxTxLimitUpdated(newLimit);
    }

    function setDailyTxCountLimit(uint256 newLimit) external onlyOwner {
        if (newLimit == 0) revert InvalidLimit();
        if (newLimit > MAX_DAILY_TX_COUNT_LIMIT) revert LimitExceedsCeiling();
        dailyTxCountLimit = newLimit;
        emit DailyTxCountLimitUpdated(newLimit);
    }

    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    // ─── Order Entry Point ────────────────────────────────────────────

    /**
     * @notice Places a P2P B2B order for an Orwiz subscription payment intent.
     * @param intentHash Deterministic hash generated by the Orwiz backend.
     * @param usdcAmount Subscription price in USDC (6 decimals).
     * @param currency Local fiat currency code (e.g., bytes32("VES")).
     * @param circleId P2P liquidity circle ID.
     * @param pubKey User's encrypted pubkey for P2P fiat coordination.
     * @param preferredPaymentChannelConfigId Preferred fiat payment channel ID (0 if any).
     * @param fiatAmountLimit Max fiat amount user is willing to pay (0 if unpinned).
     */
    function createSubscriptionOrder(
        bytes32 intentHash,
        uint256 usdcAmount,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) external nonReentrant returns (uint256 orderId) {
        if (intentHash == bytes32(0)) revert InvalidIntentHash();
        if (usdcAmount == 0) revert InvalidAmount();
        if (settledIntents[intentHash]) revert IntentAlreadySettled();
        if (intentToOrder[intentHash] != 0) revert IntentAlreadyActive();
        if (usdcAmount > maxTxLimit) revert TxLimitExceeded();

        uint256 dayIndex = block.timestamp / 1 days;
        if (userDailyCount[msg.sender][dayIndex] + 1 > dailyTxCountLimit) {
            revert DailyLimitExceeded();
        }

        address proxy = _ensureProxy(msg.sender);
        bytes memory data = abi.encodeCall(
            IB2BGateway.placeB2BOrder,
            (
                msg.sender,
                usdcAmount,
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

        if (orders[orderId].payer != address(0)) revert OrderIdAlreadyUsed();

        orders[orderId] = SubscriptionOrder({
            payer: msg.sender,
            placementDay: uint32(dayIndex),
            settled: false,
            cancelled: false,
            usdcAmount: usdcAmount
        });
        orderToIntent[orderId] = intentHash;
        intentToOrder[intentHash] = orderId;

        emit SubscriptionOrderCreated(intentHash, orderId, msg.sender, usdcAmount, currency);
    }

    // ─── IP2PIntegrator Callbacks ─────────────────────────────────────

    function validateOrder(
        address user,
        uint256 amount,
        bytes32 /* currency */
    ) external onlyDiamond returns (bool allowed) {
        if (amount == 0 || amount > maxTxLimit) return false;

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
    ) external onlyDiamond nonReentrant {
        SubscriptionOrder storage order = orders[orderId];
        if (order.payer == address(0)) revert OrderNotFound();
        if (order.settled) revert OrderAlreadySettled();
        if (order.cancelled) revert OrderAlreadyCancelled();

        order.settled = true;
        bytes32 intentHash = orderToIntent[orderId];
        settledIntents[intentHash] = true;

        address currentTreasury = treasury;
        usdc.safeTransfer(currentTreasury, amount);

        emit SubscriptionSettled(intentHash, orderId, order.payer, amount, currentTreasury);
    }

    function onOrderCancel(uint256 orderId) external onlyDiamond {
        SubscriptionOrder storage order = orders[orderId];
        if (order.payer == address(0) || order.cancelled || order.settled) {
            return;
        }

        order.cancelled = true;

        uint256 day = uint256(order.placementDay);
        uint256 count = userDailyCount[order.payer][day];
        if (count > 0) {
            userDailyCount[order.payer][day] = count - 1;
        }

        bytes32 intentHash = orderToIntent[orderId];
        if (intentToOrder[intentHash] == orderId) {
            delete intentToOrder[intentHash];
        }

        emit SubscriptionOrderCancelled(intentHash, orderId);
    }

    // ─── Views & Proxy Helpers ────────────────────────────────────────

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
