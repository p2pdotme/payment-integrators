// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { IOrderReader } from "./IOrderReader.sol";
import { IFiatTokenBlacklist } from "./IFiatTokenBlacklist.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { VendorEscrow } from "./VendorEscrow.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/**
 * @title LazoCheckoutIntegrator
 * @notice Fiat → USDC rail for payment links, with custody in an escrow PER
 *         VENDOR, a configurable retention and the commission charged on
 *         release. No refunds, no hold: disputes between vendor and buyer
 *         are theirs.
 *
 *         - Each vendor gets its own VendorEscrow clone, deployed before the
 *           first order for that vendor is placed (never inside the callback).
 *         - Orders are placed with `recipientAddr` = the vendor's escrow and
 *           registration `usdcThroughIntegrator = false`, so the Diamond pays
 *           the escrow directly. THIS contract never holds USDC.
 *         - `onOrderComplete` only writes the record on the vendor's escrow —
 *           one external bookkeeping call, no value transfer — with the fee
 *           in force (`feeBpsOf(vendor)` + `feeFixed`) and
 *           `unlockAt = now + retentionOf(vendor)`.
 *         - Payout: `VendorEscrow.release` is permissionless; Lazo's off-chain
 *           keeper calls it once orders unlock. The vendor, or anyone, can
 *           always call it too.
 *         - Fraud control acts on the way IN, never on funds already
 *           recorded: pause, blocked vendors, USDC-blacklisted vendors or
 *           escrows, per-tx / per-buyer / per-vendor limits.
 *
 *         Roles: `owner` (a Safe, passed in the constructor) sets config
 *         within immutable ceilings; `operator` (a hot backend key) can only
 *         pause new orders and block vendors — undoing either is the owner's.
 *         Nobody can move a vendor's money anywhere but to that vendor.
 *
 *         Residual risk this design keeps visible: if the callback is
 *         swallowed by the Diamond's try/catch, the USDC is already in the
 *         escrow but has no record. `reconcileCompletion` recovers that case
 *         from the Diamond's own order state, permissionlessly. Likewise a
 *         cancellation whose (opt-in) callback never arrives:
 *         `reconcileCancellation` frees its limits.
 *
 * @dev    Ownership is OpenZeppelin `Ownable2Step` plus a 7-day expiry on the
 *         pending proposal (as MerchantTerminal's super-admin handoff) and a
 *         `renounceOwnership` that always reverts (as Own).
 *
 *         UserProxy plumbing (`_ensureProxy` / `proxyAddress` / `_salt` /
 *         `_proxyArgs`) is identical to the other integrators — required by
 *         the Diamond's CREATE2 proxy authentication. The escrow clones use
 *         the same CREATE2 pattern; the Diamond never checks their derivation.
 */
contract LazoCheckoutIntegrator is IP2PIntegrator, Ownable2Step, ReentrancyGuardTransient {
    // ─── Errors ───────────────────────────────────────────────────────

    error OnlyDiamond();
    error OnlyOperatorOrOwner();
    error InvalidAddress();
    error InvalidVendor();
    error InvalidAmount();
    error FeeTooHigh();
    error FeeTooLow();
    error InvalidFeeBounds();
    error AmountBelowFee();
    error RetentionTooLong();
    error LimitTooHigh();
    error OrdersPaused();
    error VendorBlocked();
    error VendorBlacklisted();
    error VendorDailyVolumeExceeded();
    error UnknownOrder();
    error OrderAlreadyFulfilled();
    error UnexpectedRecipient();
    error NotCompletedOnDiamond();
    error NotCancelledOnDiamond();
    error OrderAlreadyCancelled();
    error OrderMismatch();
    error InvalidFeeWallet();
    error NotPendingFeeWallet();
    error HandoffExpired();
    error RenounceDisabled();

    // ─── Events ───────────────────────────────────────────────────────

    event OrderPlaced(
        uint256 indexed orderId,
        address indexed placer,
        address indexed vendor,
        uint256 requestedAmount
    );
    /// @notice Emitted on every record, from the callback or from reconcile.
    ///         The keeper indexes pending orders from this event alone.
    event OrderCompleted(
        uint256 indexed orderId,
        address indexed vendor,
        address indexed escrow,
        address payer,
        uint256 amount,
        uint256 feeBps,
        uint256 feeFixed,
        uint256 unlockAt
    );
    event OrderReconciled(uint256 indexed orderId, address indexed vendor, uint256 amount);
    event OrderCancelled(uint256 indexed orderId, address indexed placer);
    /// @notice The cancel callback never arrived; the limits were freed from
    ///         the Diamond's state. Emitted alongside `OrderCancelled`.
    event OrderCancelReconciled(uint256 indexed orderId);
    event VendorEscrowDeployed(address indexed vendor, address escrow);
    event UserProxyDeployed(address indexed user, address proxy);

    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event VendorBlockedUpdated(address indexed vendor, bool blocked, address indexed by);
    event FeeWalletProposed(address indexed proposed);
    event FeeWalletUpdated(address indexed previousWallet, address indexed newWallet);
    event FeeBpsUpdated(uint256 feeBps);
    event FeeFixedUpdated(uint256 feeFixed);
    event VendorFeeBpsUpdated(address indexed vendor, bool custom, uint256 feeBps);
    event DefaultRetentionUpdated(uint256 retention);
    event VendorRetentionUpdated(address indexed vendor, bool custom, uint256 retention);
    event PerTxLimitUpdated(uint256 limit);
    event DailyTxCountLimitUpdated(uint256 count);
    event VendorDailyVolumeLimitUpdated(uint256 limit);

    // ─── Constructor input ────────────────────────────────────────────

    /// @notice Starting values of everything the owner can later change.
    struct InitialConfig {
        address operator; // may be 0: no operator until the owner sets one
        address feeWallet;
        uint256 feeBps; // default for every vendor without an override
        uint256 feeFixed; // USDC units (6 decimals), charged on every order
        uint256 defaultRetention;
        uint256 perTxLimit;
        uint256 dailyTxCountLimit;
        uint256 vendorDailyVolumeLimit;
    }

    /// @notice Immutable bounds: the ceilings, plus the floors of the fee.
    ///         Moving one needs a new integrator.
    struct Ceilings {
        uint256 minFeeBps;
        uint256 maxFeeBps;
        uint256 minFeeFixed;
        uint256 maxFeeFixed;
        uint256 maxPerTxLimit;
        uint256 maxDailyTxCountLimit;
        uint256 maxVendorDailyVolumeLimit;
    }

    // ─── Constants ────────────────────────────────────────────────────

    /// @notice Upper bound on any retention. Bounds the owner's power: raising
    ///         the retention can delay a vendor's future orders, never
    ///         indefinitely, and never the ones already recorded.
    uint256 public constant MAX_RETENTION = 30 days;

    /// @notice Hard bound on `MAX_FEE_BPS` itself, so no deploy can set a
    ///         ceiling above 20%.
    uint256 public constant FEE_BPS_HARD_CAP = 2000;

    /// @notice Hard bound on `MAX_FEE_FIXED` itself: 5 USDC.
    uint256 public constant FEE_FIXED_HARD_CAP = 5_000_000;

    /// @notice Lifetime of a pending ownership proposal.
    uint256 public constant OWNERSHIP_HANDOFF_TTL = 7 days;

    // ─── Immutables ───────────────────────────────────────────────────

    /// @notice The P2P Diamond: the only caller of the IP2PIntegrator callbacks.
    address public immutable diamond;

    /// @notice Public getter required by UserProxy's IUsdcSource(integrator()).usdc().
    IERC20 public immutable usdc;

    /// @notice Canonical UserProxy implementation, pinned on the Diamond at
    ///         `registerIntegrator`. Each buyer's proxy is a clone of it.
    address public immutable proxyImpl;

    /// @notice Implementation every VendorEscrow clone points at.
    address public immutable escrowImpl;

    /// @notice Floor of `feeBps` and of every per-vendor override.
    uint256 public immutable MIN_FEE_BPS;
    /// @notice Ceiling of `feeBps` and of every per-vendor override.
    uint256 public immutable MAX_FEE_BPS;
    /// @notice Floor of `feeFixed`, in USDC units.
    uint256 public immutable MIN_FEE_FIXED;
    /// @notice Ceiling of `feeFixed`, in USDC units.
    uint256 public immutable MAX_FEE_FIXED;
    /// @notice Ceiling of `perTxLimit`.
    uint256 public immutable MAX_PER_TX_LIMIT;
    /// @notice Ceiling of `dailyTxCountLimit`.
    uint256 public immutable MAX_DAILY_TX_COUNT_LIMIT;
    /// @notice Ceiling of `vendorDailyVolumeLimit`.
    uint256 public immutable MAX_VENDOR_DAILY_VOLUME_LIMIT;

    // ─── Config ───────────────────────────────────────────────────────

    /// @notice Hot backend key: pauses new orders and blocks vendors, nothing else.
    address public operator;

    /// @notice Stops `userPlaceOrder` only. Never release, reconcile or callbacks.
    bool public paused;

    /// @notice Where every escrow sends the fee on `release` (a Safe in
    ///         production). Read at release time, so changing it redirects
    ///         future fees only — never vendor money.
    address public feeWallet;

    /// @notice Default commission in basis points of gross, for vendors
    ///         without an override. Snapshotted into each record when the
    ///         order completes.
    uint16 public feeBps;

    /// @notice Fixed commission per order, in USDC units (6 decimals), on top
    ///         of the percentage. Covers the per-order costs that don't scale
    ///         with the amount. Snapshotted into each record.
    uint32 public feeFixed;

    /// @notice Seconds a recorded order stays locked before `release`, for
    ///         vendors without an override. Snapshotted into each record as
    ///         its `unlockAt`.
    uint32 public defaultRetention;

    /// @notice Fee wallet proposed by the owner and not yet accepted. 0 = none.
    address public pendingFeeWallet;

    /// @notice UNIX time after which the pending ownership proposal can no
    ///         longer be accepted. 0 = none pending.
    uint256 public pendingOwnerExpiry;

    /// @notice Max USDC per order, enforced in `validateOrder`.
    uint256 public perTxLimit;

    /// @notice Max orders a buyer can place per UTC day, enforced in
    ///         `validateOrder`.
    uint256 public dailyTxCountLimit;

    /// @notice Max gross a single vendor can be sold per UTC day.
    uint256 public vendorDailyVolumeLimit;

    /// @notice Per-vendor switches and overrides.
    struct VendorConfig {
        bool blocked;
        bool customRetention;
        uint32 retention;
        bool customFeeBps;
        uint16 feeBps;
    }

    /// @notice vendor => its block flag and its retention and fee overrides.
    mapping(address => VendorConfig) public vendorConfig;

    // ─── State ────────────────────────────────────────────────────────

    /// @notice Routing only — amounts and payout state live on each escrow.
    struct Order {
        address vendor;
        uint32 placementDay;
        bool completed;
        bool cancelled;
        address placer; // releases the daily-count slot on pre-completion cancel
        uint96 amount; // requested amount, releases the vendor's daily volume on cancel
    }

    /// @notice orderId => the order's routing, as placed through this integrator.
    mapping(uint256 => Order) public orders;

    /// @notice placer => UTC day index => orders placed that day.
    mapping(address => mapping(uint256 => uint256)) public dailyCount;

    /// @notice vendor => UTC day index => gross requested that day.
    mapping(address => mapping(uint256 => uint256)) public vendorDailyVolume;

    // ─── Modifiers ────────────────────────────────────────────────────

    modifier onlyDiamond() {
        if (msg.sender != diamond) revert OnlyDiamond();
        _;
    }

    modifier onlyOperatorOrOwner() {
        if (msg.sender != operator && msg.sender != owner()) revert OnlyOperatorOrOwner();
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────

    /**
     * @notice Validates every starting value against its bounds and deploys
     *         the UserProxy and VendorEscrow implementations.
     * @param _diamond   The P2P Diamond.
     * @param _usdc      The token the Diamond settles in: Circle's USDC on
     *                   mainnet. Its `isBlacklisted` is honoured if it has one.
     * @param _owner     The Safe in production, an EOA on testnets. Never
     *                   `msg.sender` implicitly: the deployer key is not the owner.
     * @param cfg        Starting values of everything the owner can change.
     * @param ceilings   Immutable bounds of that config.
     */
    constructor(
        address _diamond,
        address _usdc,
        address _owner,
        InitialConfig memory cfg,
        Ceilings memory ceilings
    ) Ownable(_owner) {
        if (_diamond == address(0) || _usdc == address(0)) revert InvalidAddress();
        if (ceilings.maxFeeBps > FEE_BPS_HARD_CAP) revert FeeTooHigh();
        if (ceilings.maxFeeFixed > FEE_FIXED_HARD_CAP) revert FeeTooHigh();
        if (ceilings.minFeeBps > ceilings.maxFeeBps || ceilings.minFeeFixed > ceilings.maxFeeFixed)
            revert InvalidFeeBounds();

        diamond = _diamond;
        usdc = IERC20(_usdc);

        MIN_FEE_BPS = ceilings.minFeeBps;
        MAX_FEE_BPS = ceilings.maxFeeBps;
        MIN_FEE_FIXED = ceilings.minFeeFixed;
        MAX_FEE_FIXED = ceilings.maxFeeFixed;
        MAX_PER_TX_LIMIT = ceilings.maxPerTxLimit;
        MAX_DAILY_TX_COUNT_LIMIT = ceilings.maxDailyTxCountLimit;
        MAX_VENDOR_DAILY_VOLUME_LIMIT = ceilings.maxVendorDailyVolumeLimit;

        _validateFeeWallet(cfg.feeWallet);
        if (cfg.feeBps > ceilings.maxFeeBps || cfg.feeFixed > ceilings.maxFeeFixed)
            revert FeeTooHigh();
        if (cfg.feeBps < ceilings.minFeeBps || cfg.feeFixed < ceilings.minFeeFixed)
            revert FeeTooLow();
        if (cfg.defaultRetention > MAX_RETENTION) revert RetentionTooLong();
        if (
            cfg.perTxLimit > ceilings.maxPerTxLimit ||
            cfg.dailyTxCountLimit > ceilings.maxDailyTxCountLimit ||
            cfg.vendorDailyVolumeLimit > ceilings.maxVendorDailyVolumeLimit
        ) revert LimitTooHigh();

        operator = cfg.operator;
        feeWallet = cfg.feeWallet;
        feeBps = uint16(cfg.feeBps);
        feeFixed = uint32(cfg.feeFixed);
        defaultRetention = uint32(cfg.defaultRetention);
        perTxLimit = cfg.perTxLimit;
        dailyTxCountLimit = cfg.dailyTxCountLimit;
        vendorDailyVolumeLimit = cfg.vendorDailyVolumeLimit;

        emit OperatorUpdated(address(0), cfg.operator);
        emit FeeWalletUpdated(address(0), cfg.feeWallet);

        proxyImpl = address(new UserProxy());
        escrowImpl = address(new VendorEscrow());
    }

    // ─── Ownership ────────────────────────────────────────────────────

    /// @notice Proposes `newOwner`; it must call `acceptOwnership` within
    ///         OWNERSHIP_HANDOFF_TTL. `address(0)` cancels a pending proposal.
    ///         Owner-only through `super` (Ownable2Step).
    /// @param newOwner  The proposed owner, or `address(0)` to cancel.
    function transferOwnership(address newOwner) public override {
        super.transferOwnership(newOwner);
        pendingOwnerExpiry = newOwner == address(0) ? 0 : block.timestamp + OWNERSHIP_HANDOFF_TTL;
    }

    /// @notice A stale proposal expires, so a key compromised long after a
    ///         forgotten handoff can never seize the contract. Callable only by
    ///         the pending owner, before `pendingOwnerExpiry`.
    function acceptOwnership() public override {
        if (msg.sender == pendingOwner() && block.timestamp > pendingOwnerExpiry)
            revert HandoffExpired();
        super.acceptOwnership();
    }

    function _transferOwnership(address newOwner) internal override {
        delete pendingOwnerExpiry;
        super._transferOwnership(newOwner);
    }

    /// @notice Always reverts: an ownerless integrator would lose every lever
    ///         for good.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    // ─── Roles ────────────────────────────────────────────────────────

    /// @notice Sets the hot key allowed to pause new orders and block vendors.
    /// @param newOperator  The new operator, or `address(0)` for none.
    function setOperator(address newOperator) external onlyOwner {
        emit OperatorUpdated(operator, newOperator);
        operator = newOperator;
    }

    /// @notice Stops new orders only. Recorded money keeps unlocking and
    ///         releasing: freezing payouts would be discretion over others' funds.
    ///         Operator or owner. A no-op if already paused.
    function pause() external onlyOperatorOrOwner {
        if (paused) return;
        paused = true;
        emit Paused(msg.sender);
    }

    /// @notice Lets new orders in again. Owner only: the operator can stop
    ///         the entrance but never reopen it. A no-op if not paused.
    function unpause() external onlyOwner {
        if (!paused) return;
        paused = false;
        emit Unpaused(msg.sender);
    }

    /// @notice Stops NEW orders to `vendor`. Never touches what the vendor
    ///         already has recorded: those keep unlocking and releasing.
    ///         Operator or owner.
    /// @param vendor  The vendor to block.
    function blockVendor(address vendor) external onlyOperatorOrOwner {
        vendorConfig[vendor].blocked = true;
        emit VendorBlockedUpdated(vendor, true, msg.sender);
    }

    /// @notice Lets `vendor` receive new orders again. Owner only.
    /// @param vendor  The vendor to unblock.
    function unblockVendor(address vendor) external onlyOwner {
        vendorConfig[vendor].blocked = false;
        emit VendorBlockedUpdated(vendor, false, msg.sender);
    }

    // ─── Fee wallet (two steps) ───────────────────────────────────────

    /// @notice Step 1: the owner names the new wallet. Nothing changes until
    ///         that wallet accepts, so a typo never sends fees to an address
    ///         nobody controls. Proposing again replaces the proposal.
    /// @param wallet  The new fee wallet. Not 0, this contract or the USDC token.
    function proposeFeeWallet(address wallet) external onlyOwner {
        _validateFeeWallet(wallet);
        pendingFeeWallet = wallet;
        emit FeeWalletProposed(wallet);
    }

    /// @notice Step 2: the proposed wallet proves it can sign. From then on,
    ///         every release sends the fee there.
    function acceptFeeWallet() external {
        address wallet = pendingFeeWallet;
        if (wallet == address(0) || msg.sender != wallet) revert NotPendingFeeWallet();
        emit FeeWalletUpdated(feeWallet, wallet);
        feeWallet = wallet;
        pendingFeeWallet = address(0);
    }

    function _validateFeeWallet(address wallet) internal view {
        if (wallet == address(0) || wallet == address(this) || wallet == address(usdc))
            revert InvalidFeeWallet();
    }

    // ─── Config within ceilings ───────────────────────────────────────

    /// @notice Default percentage for vendors without an override. Applies
    ///         to orders completed after the change; each record keeps the
    ///         `feeBps` it was written with.
    /// @param bps  Basis points, within [MIN_FEE_BPS, MAX_FEE_BPS].
    function setFeeBps(uint256 bps) external onlyOwner {
        _checkFeeBps(bps);
        feeBps = uint16(bps);
        emit FeeBpsUpdated(bps);
    }

    /// @notice Per-vendor override of the percentage, within the same
    ///         bounds. `custom = false` drops the override and the vendor
    ///         follows `feeBps` again.
    /// @param vendor  The vendor.
    /// @param custom  Whether the vendor gets its own percentage.
    /// @param bps     Basis points within [MIN_FEE_BPS, MAX_FEE_BPS]; ignored
    ///                when `custom` is false.
    function setVendorFeeBps(address vendor, bool custom, uint256 bps) external onlyOwner {
        if (custom) _checkFeeBps(bps);
        VendorConfig storage c = vendorConfig[vendor];
        c.customFeeBps = custom;
        c.feeBps = custom ? uint16(bps) : 0;
        emit VendorFeeBpsUpdated(vendor, custom, custom ? bps : 0);
    }

    /// @notice Applies to orders completed after the change; each record
    ///         keeps the `feeFixed` it was written with.
    /// @param fixedFee  USDC units, within [MIN_FEE_FIXED, MAX_FEE_FIXED].
    function setFeeFixed(uint256 fixedFee) external onlyOwner {
        if (fixedFee > MAX_FEE_FIXED) revert FeeTooHigh();
        if (fixedFee < MIN_FEE_FIXED) revert FeeTooLow();
        feeFixed = uint32(fixedFee);
        emit FeeFixedUpdated(fixedFee);
    }

    function _checkFeeBps(uint256 bps) internal view {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh();
        if (bps < MIN_FEE_BPS) revert FeeTooLow();
    }

    /// @notice Applies to orders completed after the change; each record
    ///         keeps its own `unlockAt`.
    /// @param retention  Seconds, at most MAX_RETENTION.
    function setDefaultRetention(uint256 retention) external onlyOwner {
        if (retention > MAX_RETENTION) revert RetentionTooLong();
        defaultRetention = uint32(retention);
        emit DefaultRetentionUpdated(retention);
    }

    /// @notice Per-vendor override of the retention. `custom = false` drops
    ///         the override and the vendor follows `defaultRetention` again.
    /// @param vendor     The vendor.
    /// @param custom     Whether the vendor gets its own retention.
    /// @param retention  Seconds, at most MAX_RETENTION; ignored when `custom`
    ///                   is false.
    function setVendorRetention(address vendor, bool custom, uint256 retention) external onlyOwner {
        if (retention > MAX_RETENTION) revert RetentionTooLong();
        VendorConfig storage c = vendorConfig[vendor];
        c.customRetention = custom;
        c.retention = custom ? uint32(retention) : 0;
        emit VendorRetentionUpdated(vendor, custom, custom ? retention : 0);
    }

    /// @notice Max USDC per order, checked in `validateOrder`.
    /// @param limit  USDC units, at most MAX_PER_TX_LIMIT.
    function setPerTxLimit(uint256 limit) external onlyOwner {
        if (limit > MAX_PER_TX_LIMIT) revert LimitTooHigh();
        perTxLimit = limit;
        emit PerTxLimitUpdated(limit);
    }

    /// @notice Max orders per buyer per UTC day, checked in `validateOrder`.
    /// @param count  At most MAX_DAILY_TX_COUNT_LIMIT.
    function setDailyTxCountLimit(uint256 count) external onlyOwner {
        if (count > MAX_DAILY_TX_COUNT_LIMIT) revert LimitTooHigh();
        dailyTxCountLimit = count;
        emit DailyTxCountLimitUpdated(count);
    }

    /// @notice Max gross a single vendor can be sold per UTC day, checked in
    ///         `userPlaceOrder`.
    /// @param limit  USDC units, at most MAX_VENDOR_DAILY_VOLUME_LIMIT.
    function setVendorDailyVolumeLimit(uint256 limit) external onlyOwner {
        if (limit > MAX_VENDOR_DAILY_VOLUME_LIMIT) revert LimitTooHigh();
        vendorDailyVolumeLimit = limit;
        emit VendorDailyVolumeLimitUpdated(limit);
    }

    // ─── Vendor onboarding ────────────────────────────────────────────

    /// @notice Deploys the vendor's escrow if missing. Permissionless and
    ///         idempotent — meant to be called at vendor sign-up, so the
    ///         first order doesn't pay for the deploy. `userPlaceOrder`
    ///         calls it too, as the enforcement point. Not gated by pause.
    /// @param vendor  The vendor's payout address (its embedded wallet).
    /// @return The vendor's escrow.
    function registerVendor(address vendor) external returns (address) {
        if (vendor == address(0)) revert InvalidVendor();
        return _ensureEscrow(vendor);
    }

    // ─── STEP 1 · user-facing entry point ─────────────────────────────

    /**
     * @notice The buyer (`msg.sender`) places a BUY order that pays
     *         `vendor`'s escrow. Checks the entrance (pause, fee, block,
     *         USDC blacklist, the vendor's daily volume), makes sure the
     *         escrow and the buyer's UserProxy exist, and places the order on
     *         the Diamond through that proxy.
     * @param vendor                           Who gets paid.
     * @param amount                           USDC units, as requested by the payment link.
     * @param currency                         The buyer's fiat currency, as the Diamond's bytes32 symbol.
     * @param circleId                         The merchant circle for that currency.
     * @param pubKey                           The buyer's public key, for the LP's encrypted payment details.
     * @param preferredPaymentChannelConfigId  Forwarded as is; 0 for none.
     * @param fiatAmountLimit                  The exact quote the buyer saw. Per P2P's docs
     *                                         the Diamond reverts above it and charges the
     *                                         whole limit otherwise, so 0 would leave the
     *                                         buyer unprotected. Forwarded as is.
     * @return orderId  The Diamond's id for the new order.
     */
    function userPlaceOrder(
        address vendor,
        uint256 amount,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) external nonReentrant returns (uint256 orderId) {
        if (paused) revert OrdersPaused();
        if (vendor == address(0)) revert InvalidVendor();
        if (amount == 0) revert InvalidAmount();
        // The order must leave the vendor something at today's fee. The
        // escrow still caps the fee at gross, in case it rises before
        // completion.
        if (feeFixed + (amount * feeBpsOf(vendor)) / 10_000 >= amount) revert AmountBelowFee();
        if (vendorConfig[vendor].blocked) revert VendorBlocked();

        // A blacklisted escrow would make the Diamond's payout revert; a
        // blacklisted vendor could never be paid. This only filters new
        // orders — a blacklist that lands later makes `release` fail until
        // it is lifted.
        address escrow = escrowAddress(vendor);
        if (_isBlacklisted(vendor) || _isBlacklisted(escrow)) {
            revert VendorBlacklisted();
        }

        // `validateOrder` never sees the vendor, so the per-vendor limit
        // lives here.
        uint32 day = uint32(block.timestamp / 1 days);
        uint256 volume = vendorDailyVolume[vendor][day] + amount;
        if (volume > vendorDailyVolumeLimit) revert VendorDailyVolumeExceeded();
        vendorDailyVolume[vendor][day] = volume;

        // The escrow must have code BEFORE the Diamond can ever complete an
        // order paying it: a record call to an address without code would
        // fail inside the callback, where the Diamond swallows it.
        _ensureEscrow(vendor);
        address proxy = _ensureProxy(msg.sender);

        bytes memory data = abi.encodeCall(
            IB2BGateway.placeB2BOrder,
            (
                msg.sender,
                amount,
                currency,
                escrow, // recipientAddr — the vendor's escrow, usdcThroughIntegrator = false
                pubKey,
                circleId,
                preferredPaymentChannelConfigId,
                fiatAmountLimit
            )
        );

        bytes memory result = UserProxy(proxy).execute(diamond, data, address(usdc), 0);
        orderId = abi.decode(result, (uint256));

        orders[orderId] = Order({
            vendor: vendor,
            placementDay: day,
            completed: false,
            cancelled: false,
            placer: msg.sender,
            amount: SafeCast.toUint96(amount)
        });

        emit OrderPlaced(orderId, msg.sender, vendor, amount);
    }

    /**
     * @dev Circle's USDC answers `isBlacklisted`; a settlement token without a
     *      blacklist (the GoofyGoober mock the Base Sepolia Diamond settles
     *      in) reverts on it. Only an explicit `true` blocks: a revert or a
     *      malformed answer means the token has no blacklist to enforce.
     */
    function _isBlacklisted(address account) internal view returns (bool) {
        (bool ok, bytes memory ret) = address(usdc).staticcall(
            abi.encodeCall(IFiatTokenBlacklist.isBlacklisted, (account))
        );
        return ok && ret.length == 32 && abi.decode(ret, (uint256)) == 1;
    }

    // ─── STEP 2 · the Diamond asks permission ─────────────────────────

    /**
     * @notice The Diamond asks whether to accept the order. Enforces the
     *         per-tx cap and the buyer's daily count, and takes the day's
     *         slot when it allows. Only the Diamond.
     * @param user    The buyer who placed the order.
     * @param amount  USDC units.
     * @return allowed  Whether the Diamond may place the order.
     */
    function validateOrder(
        address user,
        uint256 amount,
        bytes32 /* currency */
    ) external onlyDiamond returns (bool allowed) {
        if (amount > perTxLimit) return false;

        uint256 day = block.timestamp / 1 days;
        uint256 count = dailyCount[user][day];
        if (count + 1 > dailyTxCountLimit) return false;

        dailyCount[user][day] = count + 1;
        return true;
    }

    // ─── STEP 3a · the fiat settled ────────────────────────────────────

    /**
     * @notice The USDC is already on the vendor's escrow when this runs.
     *         Writes the record there; moves no tokens. Pausing, blocking or
     *         blacklisting the vendor after placement does not stop this:
     *         the buyer already paid, the record must exist. Only the Diamond.
     * @param orderId        The completed order.
     * @param user           The buyer, recorded as the payer.
     * @param amount         USDC units delivered to the escrow.
     * @param recipientAddr  Must be the vendor's escrow.
     */
    function onOrderComplete(
        uint256 orderId,
        address user,
        uint256 amount,
        address recipientAddr
    ) external onlyDiamond {
        Order storage o = orders[orderId];
        if (o.vendor == address(0)) revert UnknownOrder();
        if (o.completed) revert OrderAlreadyFulfilled();
        if (recipientAddr != escrowAddress(o.vendor)) revert UnexpectedRecipient();
        if (amount == 0) revert InvalidAmount();

        _record(orderId, o, recipientAddr, user, amount);
    }

    /**
     * @notice Recovery for a swallowed `onOrderComplete`: the Diamond marked
     *         the order COMPLETED and paid the escrow, but no record exists.
     *         Permissionless — every input comes from the Diamond's own
     *         order state, and the escrow refuses to record money it doesn't
     *         hold. The retention clock starts now, not at the original
     *         completion. Not gated by pause.
     * @param orderId  An order placed through this integrator, COMPLETED on
     *                 the Diamond and not yet recorded.
     */
    function reconcileCompletion(uint256 orderId) external {
        Order storage o = orders[orderId];
        if (o.vendor == address(0)) revert UnknownOrder();
        if (o.completed) revert OrderAlreadyFulfilled();

        IOrderReader.OrderView memory v = IOrderReader(diamond).getOrdersById(orderId);
        if (v.orderType != 0 || v.status != 3) revert NotCompletedOnDiamond(); // BUY, COMPLETED
        address escrow = escrowAddress(o.vendor);
        if (v.recipientAddr != escrow) revert UnexpectedRecipient();
        if (v.amount == 0) revert InvalidAmount();

        _record(orderId, o, escrow, v.user, v.amount);
        emit OrderReconciled(orderId, o.vendor, v.amount);
    }

    function _record(
        uint256 orderId,
        Order storage o,
        address escrow,
        address payer,
        uint256 amount
    ) internal {
        o.completed = true;
        address vendor = o.vendor;
        uint256 bps = feeBpsOf(vendor);
        uint256 fixedFee = feeFixed;
        uint256 unlockAt = block.timestamp + retentionOf(vendor);
        VendorEscrow(escrow).recordCompletion(orderId, amount, bps, fixedFee, unlockAt);
        emit OrderCompleted(orderId, vendor, escrow, payer, amount, bps, fixedFee, unlockAt);
    }

    // ─── STEP 3b · the order died before completing ───────────────────

    /// @notice Frees the buyer's daily slot and the vendor's daily volume,
    ///         once. Tolerates unknown, completed and repeated ids. Only the
    ///         Diamond.
    /// @param orderId  The cancelled order.
    function onOrderCancel(uint256 orderId) external onlyDiamond {
        Order storage o = orders[orderId];
        if (o.vendor == address(0)) return;
        if (o.completed) return;
        if (o.cancelled) return;

        _releaseLimits(orderId, o);
    }

    /**
     * @notice Recovery for a missing `onOrderCancel`. The Diamond's cancel
     *         callback is opt-in and best-effort, and about half of B2B BUY
     *         orders end CANCELLED: without this, their slot and volume would
     *         stay consumed for the day. Permissionless — it only frees what
     *         the Diamond itself reports as CANCELLED, once. Not gated by pause.
     *
     *         A CANCELLED BUY can still be re-opened through a dispute and
     *         completed; `onOrderComplete` / `reconcileCompletion` record it
     *         normally. Its limits just stay freed.
     * @param orderId  An order placed through this integrator, CANCELLED on
     *                 the Diamond and not yet freed.
     */
    function reconcileCancellation(uint256 orderId) external {
        Order storage o = orders[orderId];
        if (o.vendor == address(0)) revert UnknownOrder();
        if (o.completed) revert OrderAlreadyFulfilled();
        if (o.cancelled) revert OrderAlreadyCancelled();

        IOrderReader.OrderView memory v = IOrderReader(diamond).getOrdersById(orderId);
        if (v.orderType != 0 || v.status != 4) revert NotCancelledOnDiamond(); // BUY, CANCELLED
        // Self-check on the decoded layout: the Diamond's `user` is the
        // placer we passed to placeB2BOrder. A mismatch means the getter's
        // shape drifted, so refuse rather than free the wrong limits.
        if (v.user != o.placer) revert OrderMismatch();

        _releaseLimits(orderId, o);
        emit OrderCancelReconciled(orderId);
    }

    function _releaseLimits(uint256 orderId, Order storage o) internal {
        o.cancelled = true;
        uint256 day = uint256(o.placementDay);

        uint256 count = dailyCount[o.placer][day];
        if (count > 0) dailyCount[o.placer][day] = count - 1;

        uint256 volume = vendorDailyVolume[o.vendor][day];
        vendorDailyVolume[o.vendor][day] = volume > o.amount ? volume - o.amount : 0;

        emit OrderCancelled(orderId, o.placer);
    }

    // ─── Views ────────────────────────────────────────────────────────

    /// @notice Retention that new orders to `vendor` get: its override, or
    ///         `defaultRetention`.
    /// @param vendor  The vendor.
    /// @return Seconds.
    function retentionOf(address vendor) public view returns (uint256) {
        VendorConfig storage c = vendorConfig[vendor];
        return c.customRetention ? c.retention : defaultRetention;
    }

    /// @notice Percentage that new orders to `vendor` get: its override, or
    ///         `feeBps`. The fixed part is `feeFixed` for every vendor.
    /// @param vendor  The vendor.
    /// @return Basis points.
    function feeBpsOf(address vendor) public view returns (uint256) {
        VendorConfig storage c = vendorConfig[vendor];
        return c.customFeeBps ? c.feeBps : feeBps;
    }

    /// @notice The routing of an order placed through this integrator.
    /// @param orderId  The Diamond's order id.
    /// @return The order; `vendor == address(0)` if unknown.
    function getOrder(uint256 orderId) external view returns (Order memory) {
        return orders[orderId];
    }

    /// @notice Orders `user` can still place today (UTC).
    /// @param user  The buyer.
    /// @return Remaining count.
    function getRemainingDailyCount(address user) external view returns (uint256) {
        uint256 count = dailyCount[user][block.timestamp / 1 days];
        if (count >= dailyTxCountLimit) return 0;
        return dailyTxCountLimit - count;
    }

    /// @notice Gross `vendor` can still be sold today (UTC).
    /// @param vendor  The vendor.
    /// @return Remaining volume, in USDC units.
    function getRemainingVendorVolume(address vendor) external view returns (uint256) {
        uint256 volume = vendorDailyVolume[vendor][block.timestamp / 1 days];
        if (volume >= vendorDailyVolumeLimit) return 0;
        return vendorDailyVolumeLimit - volume;
    }

    // ─── VendorEscrow clones ──────────────────────────────────────────

    /// @notice The CREATE2 address of `vendor`'s escrow, deployed or not.
    /// @param vendor  The vendor.
    /// @return The escrow clone's address.
    function escrowAddress(address vendor) public view returns (address) {
        return
            Clones.predictDeterministicAddressWithImmutableArgs(
                escrowImpl,
                _escrowArgs(vendor),
                _salt(vendor),
                address(this)
            );
    }

    function _escrowArgs(address vendor) internal view returns (bytes memory) {
        return abi.encodePacked(vendor, address(this), address(usdc));
    }

    function _ensureEscrow(address vendor) internal returns (address escrow) {
        escrow = escrowAddress(vendor);
        if (escrow.code.length == 0) {
            address deployed = Clones.cloneDeterministicWithImmutableArgs(
                escrowImpl,
                _escrowArgs(vendor),
                _salt(vendor)
            );
            assert(deployed == escrow);
            emit VendorEscrowDeployed(vendor, escrow);
        }
    }

    // ─── UserProxy helpers — copy verbatim, do not improvise ──────────

    /// @notice The CREATE2 address of `user`'s UserProxy, the one the Diamond
    ///         re-derives to authenticate the order.
    /// @param user  The buyer.
    /// @return The proxy clone's address.
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
