// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

/**
 * @title PikerOnrampIntegrator
 * @notice On-ramp-only integrator for Piker (fantasy sports on Base): lets a
 *         user buy USDC with local fiat (INR via UPI) through the P2P protocol,
 *         delivered straight to the buyer's own wallet to fund contest play.
 *
 *         The Piker user is a first-class Base EOA. The integrator places a B2B
 *         BUY through the user's per-user UserProxy with `recipientAddr = user`
 *         and is registered `usdcThroughIntegrator = false`, so on completion
 *         the Diamond delivers USDC straight to the buyer's wallet. This
 *         integrator never pulls or custodies USDC — the buyer pays fiat
 *         off-chain to the assigned merchant.
 *
 *         Flow (driven by the p2pdotme/widgets Checkout host callback):
 *           1. userInitiateOnramp — place the BUY via the user's proxy
 *              (recipientAddr = user). Enforces per-tx + daily-count limits.
 *           2. onOrderComplete — Diamond's BUY-completion callback; USDC has
 *              already been delivered to the user, so we just mark fulfilled.
 *           3. onOrderCancel — release the daily-count slot reserved at
 *              placement.
 *
 *         Compiles against the canonical UserProxy (do NOT fork it) on
 *         solc 0.8.28 / cancun, matching the registered proxyImpl bytecode.
 */
contract PikerOnrampIntegrator is IP2PIntegrator {
    // ─── Errors ───────────────────────────────────────────────────────
    error OnlyDiamond();
    error OnlyOwner();
    error InvalidAddress();
    error InvalidAmount();
    error TxLimitExceeded();
    error DailyCountExceeded();
    error OrderAlreadyFulfilled();
    error OrderAlreadyCancelled();
    error UnknownOrder();

    // ─── Events ───────────────────────────────────────────────────────
    event OnrampInitiated(uint256 indexed orderId, address indexed user, uint256 amount);
    event OnrampFulfilled(uint256 indexed orderId, address indexed user, uint256 amount);
    event OnrampCancelled(uint256 indexed orderId, address indexed user);
    event UserProxyDeployed(address indexed user, address proxy);
    event BaseTxLimitUpdated(uint256 limit);
    event DailyTxCountLimitUpdated(uint256 count);

    // ─── Immutables ───────────────────────────────────────────────────
    address public immutable diamond;
    /// @notice Public getter required by the canonical UserProxy —
    ///         UserProxy.sweepERC20 calls `IUsdcSource(integrator()).usdc()`
    ///         to block user-initiated USDC sweeps.
    IERC20 public immutable usdc;
    address public immutable owner;
    /// @notice Pinned at deploy. Submit alongside the integrator address in the
    ///         whitelist request; the Diamond records it for the CREATE2-auth
    ///         path that authorizes proxy calls.
    address public immutable proxyImpl;

    // ─── Configurable limits ──────────────────────────────────────────
    /// @notice Max USDC per onramp (6-decimal). 0 = unlimited.
    uint256 public baseTxLimit;
    /// @notice Max onramps per user per UTC day. 0 = unlimited.
    uint256 public dailyTxCountLimit;
    mapping(address => mapping(uint256 => uint256)) public userDailyCount;

    // ─── Onramp records (BUY: fiat→USDC) ──────────────────────────────
    struct OnrampRecord {
        address user; // the buyer (== recipient of the USDC)
        uint64 placementDay; // block.timestamp/1 days at placement — releases the right daily bucket on cancel
        bool fulfilled;
        bool cancelled;
        bool initialized;
    }

    mapping(uint256 => OnrampRecord) public onramps;

    // ─── Modifiers ────────────────────────────────────────────────────
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

    // ─── Admin: limits ────────────────────────────────────────────────
    function setBaseTxLimit(uint256 limit) external onlyOwner {
        baseTxLimit = limit;
        emit BaseTxLimitUpdated(limit);
    }

    function setDailyTxCountLimit(uint256 count) external onlyOwner {
        dailyTxCountLimit = count;
        emit DailyTxCountLimitUpdated(count);
    }

    // ─── IP2PIntegrator callbacks ─────────────────────────────────────

    /**
     * @notice Diamond-side gate, invoked during placeB2BOrder. Identity-keyed
     *         limits are enforced at the userInitiateOnramp entry point; here we
     *         re-assert the per-tx cap as defense-in-depth.
     */
    function validateOrder(
        address /* user */,
        uint256 amount,
        bytes32 /* currency */
    ) external view returns (bool allowed) {
        if (msg.sender != diamond) revert OnlyDiamond();
        if (baseTxLimit != 0 && amount > baseTxLimit) return false;
        return true;
    }

    /**
     * @notice Diamond's BUY-completion callback (fires when an onramp's fiat
     *         settles). With usdcThroughIntegrator=false and recipientAddr=user,
     *         the Diamond delivers USDC straight to the user's wallet — this
     *         integrator never custodies it. We only mark the onramp fulfilled;
     *         defense-in-depth guards make any gateway divergence loud.
     */
    function onOrderComplete(
        uint256 orderId,
        address /* user */,
        uint256 amount,
        address /* recipientAddr */
    ) external {
        if (msg.sender != diamond) revert OnlyDiamond();
        OnrampRecord storage o = onramps[orderId];
        if (!o.initialized) revert UnknownOrder();
        if (o.cancelled) revert OrderAlreadyCancelled();
        if (o.fulfilled) revert OrderAlreadyFulfilled();
        o.fulfilled = true;
        emit OnrampFulfilled(orderId, o.user, amount);
    }

    /**
     * @notice Order-cancellation hook. Releases the daily-count slot reserved at
     *         placement (keyed on the pinned placementDay so it lands in the
     *         right bucket across a UTC boundary). Best-effort: tolerates an
     *         unknown orderId or a repeat call.
     */
    function onOrderCancel(uint256 orderId) external {
        if (msg.sender != diamond) revert OnlyDiamond();
        OnrampRecord storage o = onramps[orderId];
        if (!o.initialized) return; // unknown — nothing to release
        if (o.fulfilled || o.cancelled) return; // already terminal — idempotent
        o.cancelled = true;
        uint256 c = userDailyCount[o.user][o.placementDay];
        if (c != 0) userDailyCount[o.user][o.placementDay] = c - 1;
        emit OnrampCancelled(orderId, o.user);
    }

    // ─── On-ramp lifecycle (driven by the <Checkout> widget) ──────────

    /**
     * @notice Place a BUY on the Diamond for the caller buying USDC with fiat.
     *         Routes placeB2BOrder through the caller's per-user proxy with
     *         `recipientAddr = caller`, so on completion the Diamond delivers
     *         USDC straight to the buyer's wallet (the integrator is registered
     *         `usdcThroughIntegrator = false`). The buyer pays fiat off-chain to
     *         the assigned merchant; this integrator never pulls or custodies
     *         USDC. Enforces per-tx + daily-count limits keyed on the caller.
     *
     * @dev    `usdcAllowance = 0` on the proxy execute: a BUY pulls no USDC at
     *         placement (the merchant's USDC is escrowed protocol-side).
     */
    function userInitiateOnramp(
        uint256 amount,
        bytes32 currency,
        uint256 fiatAmountLimit,
        uint256 circleId,
        uint256 preferredPaymentChannelConfigId,
        string calldata userPubKey
    ) external returns (uint256 orderId) {
        if (amount == 0) revert InvalidAmount();
        if (baseTxLimit != 0 && amount > baseTxLimit) revert TxLimitExceeded();

        uint256 dayIndex = block.timestamp / 1 days;
        if (dailyTxCountLimit != 0) {
            uint256 count = userDailyCount[msg.sender][dayIndex];
            if (count + 1 > dailyTxCountLimit) revert DailyCountExceeded();
            userDailyCount[msg.sender][dayIndex] = count + 1;
        }

        address proxy = _ensureProxy(msg.sender);
        bytes memory data = abi.encodeCall(
            IB2BGateway.placeB2BOrder,
            (
                msg.sender, // order.user (proxy owner)
                amount,
                currency,
                msg.sender, // recipientAddr — USDC delivered to the buyer's wallet
                userPubKey,
                circleId,
                preferredPaymentChannelConfigId,
                fiatAmountLimit
            )
        );
        bytes memory result = UserProxy(proxy).execute(diamond, data, address(usdc), 0);
        orderId = abi.decode(result, (uint256));

        onramps[orderId] = OnrampRecord({
            user: msg.sender,
            placementDay: uint64(dayIndex),
            fulfilled: false,
            cancelled: false,
            initialized: true
        });

        emit OnrampInitiated(orderId, msg.sender, amount);
    }

    // ─── Views ────────────────────────────────────────────────────────
    function getTodayCount(address user) external view returns (uint256) {
        return userDailyCount[user][block.timestamp / 1 days];
    }

    function getRemainingDailyCount(address user) external view returns (uint256) {
        if (dailyTxCountLimit == 0) return type(uint256).max;
        uint256 count = userDailyCount[user][block.timestamp / 1 days];
        return count >= dailyTxCountLimit ? 0 : dailyTxCountLimit - count;
    }

    function getOnramp(uint256 orderId) external view returns (OnrampRecord memory) {
        return onramps[orderId];
    }

    // ─── Proxy helpers (mirror ExampleIntegrator / the template exactly) ─

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

    /// @dev Salt is the user EOA only; the CREATE2 "deployer" component is this
    ///      integrator, so (integrator, user) maps to exactly one proxy.
    function _salt(address user) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(user)));
    }

    /// @dev Immutable args layout: [owner(20)][integrator(20)]. Must match what
    ///      the Diamond's CREATE2-auth path reconstructs — do not change.
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
