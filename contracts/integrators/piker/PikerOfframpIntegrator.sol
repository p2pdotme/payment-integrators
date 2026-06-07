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
 * @title PikerOfframpIntegrator
 * @notice Off-ramp-only integrator for Piker: lets a user convert USDC they
 *         already hold on Base into local fiat (INR via UPI) through the P2P
 *         protocol. Unlike TradeStars (Solana burn → relayer-driven, vault-
 *         backed) the Piker user is a first-class Base EOA cashing out their
 *         OWN funds, so the model is simpler:
 *
 *           - One UserProxy per user EOA (salt = user). `order.user` = that
 *             proxy, so the Diamond pulls funds from — and refunds to — a
 *             per-user address. No shared system proxy, no vault.
 *           - The user pays the protocol's small-order SELL fee themselves;
 *             the integrator fronts no capital and holds no withdrawable
 *             pool. It only ever custodies a single order's funds in-flight,
 *             which always resolve to the merchant (on completion) or back to
 *             the user (on cancellation). The owner cannot move user funds —
 *             there is deliberately no owner USDC-withdrawal path.
 *
 *         Flow (driven by the p2pdotme/widgets Cashout host callbacks):
 *           1. userInitiateOfframp — pull `principal` USDC from the user, place
 *              the SELL on the Diamond via the user's proxy (order.user=proxy).
 *           2. deliverOfframpUpi — once ACCEPTED, read the Diamond's authoritative
 *              `actualUsdtAmount` (= principal + fee), pull the `fee` remainder
 *              from the user, fund the proxy with the total, and have the proxy
 *              call setSellOrderUpi (Diamond pulls it, merchant pays fiat).
 *           3. reconcile — at a terminal status, sweep the proxy and (on
 *              CANCELLED) refund everything the user deposited.
 *
 *         Compiles against the canonical UserProxy (do NOT fork it) on
 *         solc 0.8.28 / cancun, matching the registered proxyImpl bytecode.
 */
contract PikerOfframpIntegrator is IP2PIntegrator {
    using SafeERC20 for IERC20;

    // ─── Errors ───────────────────────────────────────────────────────
    error OnlyDiamond();
    error OnlyOwner();
    error InvalidAddress();
    error InvalidAmount();
    error TxLimitExceeded();
    error DailyCountExceeded();
    error NotOrderOwner();
    error OfframpRecordNotFound();
    error OfframpAlreadyDelivered();
    error OfframpAlreadyReconciled();
    error OfframpFeeNotReady();
    error StatusNotTerminal();

    // ─── Events ───────────────────────────────────────────────────────
    event OfframpInitiated(uint256 indexed orderId, address indexed user, uint256 principal);
    event OfframpUpiDelivered(uint256 indexed orderId, uint256 totalCharged);
    event OfframpReconciled(uint256 indexed orderId, uint8 status, uint256 refundedToUser);
    event UserProxyDeployed(address indexed user, address proxy);
    event BaseTxLimitUpdated(uint256 limit);
    event DailyTxCountLimitUpdated(uint256 count);

    // ─── Constants ────────────────────────────────────────────────────
    /// @notice Mirrors OrderProcessorStorage.OrderStatus on the P2P Diamond.
    ///         0=PLACED 1=ACCEPTED 2=PAID 3=COMPLETED 4=CANCELLED.
    uint8 internal constant STATUS_COMPLETED = 3;
    uint8 internal constant STATUS_CANCELLED = 4;

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
    /// @notice Max principal (6-decimal USDC) per cash-out. 0 = unlimited.
    uint256 public baseTxLimit;
    /// @notice Max cash-outs per user per UTC day. 0 = unlimited.
    uint256 public dailyTxCountLimit;
    mapping(address => mapping(uint256 => uint256)) public userDailyCount;

    // ─── Offramp records ──────────────────────────────────────────────
    struct OfframpRecord {
        address user; // the cashing-out EOA (== proxy owner)
        uint256 deposited; // total USDC pulled from the user so far (principal, +fee at deliver)
        uint256 principal; // SELL principal placed on the Diamond
        uint8 lastStatus; // last reconciled terminal status (0 until reconciled)
        bool initialized;
        bool delivered; // deliverOfframpUpi replay guard
    }

    mapping(uint256 => OfframpRecord) public offramps;

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
     * @notice Diamond-side gate, invoked during placeB2BSellOrder. `user` is
     *         the per-user proxy (order.user), so identity-keyed limits are
     *         enforced at the userInitiateOfframp entry point instead; here we
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

    /// @notice Off-ramp SELL orders never use the BUY completion callback; the
    ///         SELL lifecycle is driven by setSellOrderUpi + reconcile. Present
    ///         only to satisfy IP2PIntegrator. No-op beyond access control.
    function onOrderComplete(
        uint256 /* orderId */,
        address /* user */,
        uint256 /* amount */,
        address /* recipientAddr */
    ) external view {
        if (msg.sender != diamond) revert OnlyDiamond();
    }

    /// @notice SELL cancellations are settled in `reconcile` (which refunds the
    ///         user from the swept proxy balance). This hook consumes no per-
    ///         user accounting, so it is a no-op beyond access control.
    function onOrderCancel(uint256 /* orderId */) external view {
        if (msg.sender != diamond) revert OnlyDiamond();
    }

    // ─── Off-ramp lifecycle (driven by the <Cashout> widget) ──────────

    /**
     * @notice Step 1 — place a SELL on the Diamond for the caller cashing out
     *         their own USDC. Pulls `principal` from the caller into this
     *         integrator (held until deliver), then routes placeB2BSellOrder
     *         through the caller's per-user proxy so `order.user` is the proxy.
     *
     * @dev    The caller must have approved at least `principal + fee` USDC to
     *         this contract (the widget approves the total up-front); the `fee`
     *         remainder is pulled at deliver time. `usdcAllowance = 0` on the
     *         proxy execute because the Diamond pulls nothing at placement.
     */
    function userInitiateOfframp(
        uint256 principal,
        bytes32 currency,
        uint256 fiatAmountLimit,
        uint256 circleId,
        uint256 preferredPaymentChannelConfigId,
        string calldata userPubKey
    ) external returns (uint256 orderId) {
        if (principal == 0) revert InvalidAmount();
        if (baseTxLimit != 0 && principal > baseTxLimit) revert TxLimitExceeded();

        if (dailyTxCountLimit != 0) {
            uint256 dayIndex = block.timestamp / 1 days;
            uint256 count = userDailyCount[msg.sender][dayIndex];
            if (count + 1 > dailyTxCountLimit) revert DailyCountExceeded();
            userDailyCount[msg.sender][dayIndex] = count + 1;
        }

        // Commit the user's principal up-front; funds the proxy at deliver.
        usdc.safeTransferFrom(msg.sender, address(this), principal);

        address proxy = _ensureProxy(msg.sender);
        bytes memory data = abi.encodeCall(
            IB2BGateway.placeB2BSellOrder,
            (
                proxy,
                principal,
                currency,
                userPubKey,
                circleId,
                preferredPaymentChannelConfigId,
                fiatAmountLimit
            )
        );
        bytes memory result = UserProxy(proxy).execute(diamond, data, address(usdc), 0);
        orderId = abi.decode(result, (uint256));

        offramps[orderId] = OfframpRecord({
            user: msg.sender,
            deposited: principal,
            principal: principal,
            lastStatus: 0,
            initialized: true,
            delivered: false
        });

        emit OfframpInitiated(orderId, msg.sender, principal);
    }

    /**
     * @notice Step 2 — forward the merchant-encrypted UPI handle to the Diamond
     *         (the PAID transition). Reads the authoritative
     *         `actualUsdtAmount` (= principal + fee) from the Diamond, pulls the
     *         `fee` remainder from the user, funds the proxy with the exact
     *         total, then has the proxy call setSellOrderUpi. The Diamond pulls
     *         the total from the proxy; with exact funding there is no residue.
     *
     * @dev    Callable only by the order's user — the widget submits this from
     *         the same wallet that initiated. CEI: the replay guard flips before
     *         any external call so a true revert rolls it back for a clean retry.
     */
    function deliverOfframpUpi(uint256 orderId, string calldata encUpi) external {
        OfframpRecord storage r = offramps[orderId];
        if (!r.initialized) revert OfframpRecordNotFound();
        if (msg.sender != r.user) revert NotOrderOwner();
        if (r.delivered) revert OfframpAlreadyDelivered();
        r.delivered = true;

        uint256 needed = IOrderFlow(diamond).getAdditionalOrderDetails(orderId).actualUsdtAmount;
        // No principal-only fallback: funding short of principal+fee makes the
        // Diamond's transferFrom underflow and auto-cancel. Force a retry once
        // the Diamond has populated actualUsdtAmount.
        if (needed == 0) revert OfframpFeeNotReady();

        // Pull the fee remainder from the user (allowance from the up-front
        // approval). principal was already pulled at initiate.
        if (needed > r.deposited) {
            uint256 fee = needed - r.deposited;
            usdc.safeTransferFrom(r.user, address(this), fee);
            r.deposited = needed;
        }

        address proxy = proxyAddress(r.user);
        usdc.safeTransfer(proxy, needed);
        bytes memory data = abi.encodeCall(IOrderFlow.setSellOrderUpi, (orderId, encUpi, 0));
        UserProxy(proxy).execute(diamond, data, address(usdc), needed);

        emit OfframpUpiDelivered(orderId, needed);
    }

    /**
     * @notice Step 3 — settle a terminal order. Permissionless: the widget
     *         pokes on completion, and anyone can close out a cancellation —
     *         security comes from reading the authoritative status from the
     *         Diamond (never a caller argument) and rejecting non-terminal
     *         states. On CANCELLED the Diamond refunded USDC to the user's
     *         proxy; we sweep it back and return everything the user deposited.
     */
    function reconcile(uint256 orderId) external {
        OfframpRecord storage r = offramps[orderId];
        if (!r.initialized) revert OfframpRecordNotFound();
        if (r.lastStatus == STATUS_COMPLETED || r.lastStatus == STATUS_CANCELLED)
            revert OfframpAlreadyReconciled();

        uint8 status = IOrderFlow(diamond).getOrdersById(orderId).status;
        if (status != STATUS_COMPLETED && status != STATUS_CANCELLED) revert StatusNotTerminal();

        r.lastStatus = status;

        uint256 refunded = 0;
        if (status == STATUS_CANCELLED) {
            // Pull back anything the Diamond refunded to the proxy (post-deliver
            // cancels refund principal+fee there). UserProxy blocks user-
            // initiated USDC sweeps, so transferERC20ToIntegrator is the path.
            address proxy = proxyAddress(r.user);
            if (proxy.code.length != 0) {
                uint256 proxyBal = usdc.balanceOf(proxy);
                if (proxyBal != 0)
                    UserProxy(proxy).transferERC20ToIntegrator(address(usdc), proxyBal);
            }
            // Return everything the user put in. Pre-deliver cancels never
            // funded the proxy, so the principal is still held here; either way
            // this contract now holds at least `deposited`.
            refunded = r.deposited;
            if (refunded != 0) usdc.safeTransfer(r.user, refunded);
        }

        emit OfframpReconciled(orderId, status, refunded);
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

    function getOfframp(uint256 orderId) external view returns (OfframpRecord memory) {
        return offramps[orderId];
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
