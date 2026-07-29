// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { IOrderFlow } from "../../interfaces/IOrderFlow.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title RemitamIntegrator
 * @notice P2P.me B2B integrator for the Remitam remittance app. Backend-
 *         controlled server wallets (thirdweb) are whitelisted by the owner
 *         and place BUY legs (fiat -> USDC delivered to the server wallet;
 *         registered with usdcThroughIntegrator = false) and concurrent SELL
 *         legs (USDC -> fiat paid to the remittance recipient). Large
 *         remittances are split off-chain into multiple legs; this contract
 *         supports several in-flight SELL legs per wallet (bounded).
 *
 *         As a whitelisted integrator we bypass the protocol's RP/daily/
 *         monthly/yearly limits and enforce our own per-tx and daily limits
 *         here, owner-adjustable only up to immutable ceilings.
 */
contract RemitamIntegrator is IP2PIntegrator, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Errors ───────────────────────────────────────────────────────
    error OnlyDiamond();
    error OnlyOwner();
    error InvalidAddress();
    error NotWhitelisted();
    error LimitAboveCeiling();
    error TxLimitExceeded();
    error DailyVolumeExceeded();
    error DailyCountExceeded();

    // ─── Events ───────────────────────────────────────────────────────
    event AccountAdded(address indexed account);
    event AccountRemoved(address indexed account);
    event LimitsUpdated(uint256 txLimit, uint256 dailyVolumeLimit, uint256 dailyCountLimit);
    event UserProxyDeployed(address indexed user, address proxy);

    // ─── Immutables ───────────────────────────────────────────────────
    address public immutable diamond;
    /// @notice Public getter required: UserProxy.sweepERC20 blocks USDC via
    ///         IUsdcSource(integrator()).usdc().
    IERC20 public immutable usdc;
    address public immutable owner;
    /// @notice Pinned at deploy; submitted with the whitelist request.
    address public immutable proxyImpl;

    /// @notice Immutable ceilings — the owner can move limits below these,
    ///         never above. Reviewed at whitelisting time.
    uint256 public immutable txLimitCeiling;
    uint256 public immutable dailyVolumeCeiling;
    uint256 public immutable dailyCountCeiling;

    // ─── Adjustable limits ────────────────────────────────────────────
    uint256 public txLimit;
    uint256 public dailyVolumeLimit;
    uint256 public dailyCountLimit;

    // ─── Whitelist ────────────────────────────────────────────────────
    mapping(address => bool) public whitelisted;
    /// @notice proxy => whitelisted wallet that owns it. Lets validateOrder
    ///         recognize a SELL placed with order.user = the wallet's proxy.
    mapping(address => address) public proxyOwner;

    // ─── Modifiers ────────────────────────────────────────────────────
    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyDiamond() {
        if (msg.sender != diamond) revert OnlyDiamond();
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────
    constructor(
        address _diamond,
        address _usdc,
        uint256 _txLimitCeiling,
        uint256 _dailyVolumeCeiling,
        uint256 _dailyCountCeiling
    ) {
        if (_diamond == address(0) || _usdc == address(0)) revert InvalidAddress();
        diamond = _diamond;
        usdc = IERC20(_usdc);
        owner = msg.sender;
        proxyImpl = address(new UserProxy());

        txLimitCeiling = _txLimitCeiling;
        dailyVolumeCeiling = _dailyVolumeCeiling;
        dailyCountCeiling = _dailyCountCeiling;
        txLimit = _txLimitCeiling;
        dailyVolumeLimit = _dailyVolumeCeiling;
        dailyCountLimit = _dailyCountCeiling;
    }

    // ─── Whitelist admin ──────────────────────────────────────────────

    function addAccount(address account) external onlyOwner {
        if (account == address(0)) revert InvalidAddress();
        whitelisted[account] = true;
        emit AccountAdded(account);
    }

    function removeAccount(address account) external onlyOwner {
        whitelisted[account] = false;
        emit AccountRemoved(account);
    }

    // ─── Limits admin ─────────────────────────────────────────────────

    function setLimits(
        uint256 txLimit_,
        uint256 dailyVolumeLimit_,
        uint256 dailyCountLimit_
    ) external onlyOwner {
        if (
            txLimit_ > txLimitCeiling ||
            dailyVolumeLimit_ > dailyVolumeCeiling ||
            dailyCountLimit_ > dailyCountCeiling
        ) revert LimitAboveCeiling();
        txLimit = txLimit_;
        dailyVolumeLimit = dailyVolumeLimit_;
        dailyCountLimit = dailyCountLimit_;
        emit LimitsUpdated(txLimit_, dailyVolumeLimit_, dailyCountLimit_);
    }

    // ─── IP2PIntegrator (filled in over Tasks 3-4) ────────────────────

    function validateOrder(
        address /*user*/,
        uint256 /*amount*/,
        bytes32 /*currency*/
    ) external onlyDiamond returns (bool allowed) {
        return true;
    }

    function onOrderComplete(
        uint256 /*orderId*/,
        address /*user*/,
        uint256 /*amount*/,
        address /*recipientAddr*/
    ) external onlyDiamond {}

    function onOrderCancel(uint256 /*orderId*/) external onlyDiamond {}

    // ─── Proxy helpers (mirror contracts/templates/MyIntegrator.sol) ──

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

    /// @dev Immutable args layout [owner(20)][integrator(20)] — fixed by the
    ///      Diamond's CREATE2-auth derivation. DO NOT change.
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
            proxyOwner[proxy] = user;
            emit UserProxyDeployed(user, proxy);
        }
    }
}
