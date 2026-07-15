// SPDX-License-Identifier: Apache-2.0
// ^0.8.28 (not .20): this contract deploys UserProxy, which uses `transient`
// storage — requires solc >= 0.8.28 and evmVersion cancun (see hardhat.config).
pragma solidity ^0.8.28;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { IOrderFlow } from "../../interfaces/IOrderFlow.sol";
import { ICheckoutClient } from "../../interfaces/ICheckoutClient.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

/**
 * @title MerchantTerminalIntegrator
 * @notice P2P merchant terminal: merchants accept local-currency payments from
 *         customers and receive USDC on Base under a settlement lock, then
 *         withdraw either as local fiat to their saved payout id (SELL offramp
 *         via the merchant proxy, TradeStars/Marketplace pattern) or as USDC to
 *         their wallet. The offramp currency is chosen per merchant at
 *         registration, so any country (INR/UPI, BRL/PIX, ARS, …) is supported
 *         — adding a new one needs only a funded circle, no contract change.
 *
 *         BUY flow: the merchant places the order (msg.sender), the order is
 *         routed through the merchant's UserProxy clone (B2BGatewayFacet is
 *         proxy-only), recipientAddr = the merchant's proxy and the
 *         integrator registers with usdcThroughIntegrator = false — the
 *         Diamond sends USDC to the proxy at completion and onOrderComplete
 *         pulls it into this contract, where it sits in settlement buckets
 *         (SETTLEMENT_PERIOD).
 *
 *         SELL flow (fiat withdrawal): the merchant's own proxy places the sell
 *         order; this contract funds that proxy with the USDC at placement and
 *         passes the merchant's RELAY PUBKEY (secp256k1, the same identity used
 *         for BUY) as userPubKey, in the merchant's own currency. The actual
 *         payout handle (UPI/PIX) is NOT placed on-chain here — it is delivered
 *         later, encrypted to that pubkey, via `deliverFiatPayout` →
 *         `setSellOrderUpi`. If a sell order is cancelled on the Diamond, the
 *         USDC is refunded to the proxy; `reconcileWithdrawal` sweeps it back and
 *         re-credits the merchant so no funds are stranded.
 *
 *         Limits enforced in validateOrder: a per-transaction cap of 50 USDC for
 *         INR merchants / 100 USDC default (perTxCap, admin-tunable via setPerTxCap)
 *         and DAILY_TX_LIMIT = 25 orders per merchant per UTC day (admin-tunable via
 *         setDailyLimit). The system proxy is carved out so withdrawals never hit
 *         merchant buy-side limits.
 */
contract MerchantTerminalIntegrator is IP2PIntegrator {
    using SafeERC20 for IERC20;

    // ─── Errors ───────────────────────────────────────────────────────
    error OnlyDiamond();
    error OnlyOwner();
    /// @dev A super-admin-only action was called by someone who isn't the super-admin.
    error OnlySuperAdmin();
    /// @dev The super-admin is the single unremovable root of access control — it
    ///      can be neither removed as an owner nor demoted below FINANCE by anyone.
    error CannotRemoveSuperAdmin();
    /// @dev The last remaining owner can't be removed (never orphan the contract).
    error LastOwner();
    /// @dev Raised when the caller's role tier is below what an action requires.
    ///      Carries (required, actual) tier values so the admin panel can show
    ///      exactly which role is needed. required/actual are the Role enum uint8.
    error NotAuthorized(uint8 required, uint8 actual);
    error InvalidAddress();
    error AlreadyRegistered();
    error NotRegistered();
    /// @dev Named MerchantIsFrozen because events and errors share one
    ///      identifier namespace and the event MerchantFrozen keeps the
    ///      canonical name (the backend indexes events).
    error MerchantIsFrozen();
    error ExceedsPerTxCap();
    error DailyLimitReached();
    error InsufficientAvailableBalance();
    error NothingToWithdraw();
    error InvalidQuantity();
    error ProductNotFound();
    error Reentrancy();
    error UnknownWithdrawal();
    error WithdrawalNotCancellable();
    error WithdrawalAlreadySettled();
    error InvalidCircle();
    error OfframpFeeNotReady();
    error OfframpInsufficientPool();
    error WithdrawalNotFound();
    error InvalidCurrency();
    error WithdrawalInFlight();
    error FiatAlreadyDelivered();
    /// @dev deliverFiatPayout called on an order the Diamond no longer holds in
    ///      ACCEPTED — e.g. a retry after an auto-cancel. Blocks the retry window
    ///      where the fee could be debited a second time (feeAdvanced overwrite).
    error WithdrawalNotDeliverable();
    /// @dev An admin-set settlement lock fell outside [MIN,MAX]_SETTLEMENT_PERIOD.
    error InvalidLockPeriod();
    /// @dev A new-activity action (place order / withdraw) was attempted while the
    ///      integrator is paused (break-glass). Recovery/admin paths are exempt.
    error Paused();
    /// @dev pause()/unpause() called when already in that state (no-op guard).
    error PauseUnchanged();
    /// @dev adminEscheat called on a merchant that is NOT frozen, or that has not
    ///      been continuously frozen for the full ESCHEAT_PERIOD (90 days) yet.
    error NotEscheatable();
    /// @dev adminEscheat called for a merchant with a zero balance (nothing to move).
    error NothingToEscheat();
    /// @dev An admin recovery action that only applies to FROZEN merchants was
    ///      called for a merchant who is not frozen.
    error MerchantNotFrozen();
    /// @dev skimExcess called when the contract holds no USDC above totalOwed.
    error NothingToSkim();
    /// @dev acceptSuperAdmin called after the pending handoff's TTL elapsed — the
    ///      proposal must be re-issued by the current super-admin.
    error HandoffExpired();

    // ─── Events ───────────────────────────────────────────────────────
    event OrderPlaced(uint256 indexed orderId, address indexed user, uint256 amount);
    event UserProxyDeployed(address indexed user, address proxy);
    // NOTE: the payout handle is intentionally NOT in these events. It is PII
    // (a real UPI/PIX/bank id); emitting it — even encrypted — would bloat logs
    // and, if ever plaintext, permanently leak it. The app already knows the
    // handle it just set; indexers key off `merchant`.
    event MerchantRegistered(address indexed merchant, string shopName, bytes32 currency);
    event MerchantProfileUpdated(address indexed merchant, string shopName);
    event OrderCompleted(
        uint256 indexed orderId,
        address indexed merchant,
        uint256 amount,
        uint256 unlockTimestamp
    );
    event OrderCancelled(uint256 indexed orderId, address indexed merchant);
    event WithdrawalFiat(
        address indexed merchant,
        uint256 indexed orderId,
        bytes32 currency,
        uint256 amount
    );
    event WithdrawalUpiDelivered(uint256 indexed orderId, uint256 actualUsdtAmount);
    event WithdrawalUSDC(address indexed merchant, uint256 amount);
    event WithdrawalReconciled(address indexed merchant, uint256 indexed orderId, uint256 amount);
    /// @dev Emitted when a COMPLETED SELL withdrawal is finalised and its in-flight
    ///      slot freed. `recredit` is any proxy leftover swept back (0 on the clean
    ///      path). Emitted unconditionally so the freed slot is observable off-chain.
    event WithdrawalFinalized(address indexed merchant, uint256 indexed orderId, uint256 recredit);
    /// @notice A COMPLETED BUY whose onOrderComplete callback had reverted (leaving
    ///         the merchant's USDC stranded on their proxy, uncredited) was recovered
    ///         by an owner via sweepStrandedBuy: the proxy balance was swept into
    ///         custody and credited to the merchant. `amount` is what was credited.
    event StrandedBuyRecovered(uint256 indexed orderId, address indexed merchant, uint256 amount);
    event MerchantFrozen(address indexed merchant);
    event MerchantUnfrozen(address indexed merchant);
    /// @notice A dormant (90-day continuously-frozen) merchant's entire remaining
    ///         balance was withdrawn by the super-admin to `to`. `amount` is the full
    ///         balance moved; totalOwed drops by exactly this and the merchant's
    ///         buckets are zeroed so the funds can never be double-claimed.
    event MerchantEscheated(address indexed merchant, address indexed to, uint256 amount);
    /// @notice USDC held ABOVE totalOwed (donations, Diamond over-refunds, capped
    ///         reconcile remainders) was skimmed by the super-admin to `to`. This can
    ///         never touch merchant-owed funds: the amount is bounded by
    ///         `balanceOf(this) - totalOwed`, so the solvency invariant is preserved
    ///         by construction.
    event ExcessSkimmed(address indexed to, uint256 amount);
    event PerTxCapSet(bytes32 indexed currency, uint256 cap);
    event DailyLimitSet(uint256 newLimit);
    /// @notice The GLOBAL settlement lock (default for currencies with no override)
    ///         was changed. `newPeriod` is in seconds.
    event SettlementPeriodSet(uint256 newPeriod);
    /// @notice A per-currency settlement-lock override was set (or cleared with
    ///         period==0, falling back to the global default). `period` is seconds.
    event LockPeriodSet(bytes32 indexed currency, uint256 period);
    event TrustedRelayerSet(address indexed relayer);
    event AdminAdded(address indexed admin);
    event AdminRemoved(address indexed admin);
    /// @notice Emitted whenever an admin's role changes (including to NONE on
    ///         removal). `role` is the Role enum value
    ///         (0=NONE,1=VIEWER,2=SUPPORT,3=MANAGER,4=FINANCE).
    event AdminRoleSet(address indexed admin, uint8 role);
    /// @dev DEPRECATED / never emitted (audit #6). This multi-owner integrator has
    ///      no single-owner "transfer": ownership changes go through OwnerAdded /
    ///      OwnerRemoved, and ROOT changes through SuperAdminTransferred. Kept only
    ///      for ABI stability with legacy indexers; it will never fire.
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OwnerAdded(address indexed owner);
    event OwnerRemoved(address indexed owner);
    /// @notice The super-admin (the single unremovable root of access control) was
    ///         handed off from `previous` to `next`.
    event SuperAdminTransferred(address indexed previous, address indexed next);
    /// @notice AUDIT FIX B: a two-step super-admin handoff was PROPOSED (`next`
    ///         must call acceptSuperAdmin to complete it). `next`==0 cancels.
    event SuperAdminTransferStarted(address indexed current, address indexed next);
    /// @notice Break-glass: new BUY orders and all withdrawals are halted (`by` =
    ///         the owner who flipped it). In-flight order completion, reconciliation,
    ///         and admin recovery paths keep working — this stops NEW activity, it
    ///         does not freeze existing custody.
    event PausedSet(address indexed by);
    event UnpausedSet(address indexed by);

    // ─── Immutables ───────────────────────────────────────────────────
    address public immutable diamond;
    /// @notice Exposed as a public getter so the canonical UserProxy can
    ///         resolve which token to block from user-initiated sweep —
    ///         UserProxy.sweepERC20 calls `IUsdcSource(integrator()).usdc()`.
    IERC20 public immutable usdc;
    /// @notice MULTI-OWNER root admins. Each owner has FULL access (top tier —
    ///         manages the admin set, ownership, everything). The
    ///         deployer is the first owner; more can be seeded at construction and
    ///         added/removed later. The last owner can never be removed (so the
    ///         contract can't be orphaned). Sits ABOVE the 5-tier role system.
    mapping(address => bool) public isOwner;
    uint256 public ownerCount;
    /// @notice THE SUPER-ADMIN: the single unremovable root of access control.
    ///         It is always ALSO an owner (so it keeps full FINANCE-tier powers),
    ///         but sits strictly above every owner: only the super-admin can add or
    ///         remove owners and assign/revoke roles. Crucially, NO ONE can remove
    ///         or demote the super-admin — not another owner, not itself via the
    ///         owner path. The role only ever moves via `transferSuperAdmin`, an
    ///         explicit self-initiated handoff. Seeded to the deployer at construction.
    address public superAdmin;
    /// @notice AUDIT FIX B: the proposed next super-admin in a two-step handoff.
    ///         transferSuperAdmin sets this; the role only moves when this address
    ///         calls acceptSuperAdmin (proving key control). address(0) = none pending.
    address public pendingSuperAdmin;
    /// @notice UNIX time the pending handoff expires (transferSuperAdmin sets it to
    ///         now + SUPER_ADMIN_HANDOFF_TTL). A stale, forgotten proposal must not
    ///         remain acceptable forever — the pending key could be compromised long
    ///         after the operator forgot the handoff was open. 0 = none pending.
    uint256 public pendingSuperAdminExpiry;
    /// @notice Pinned at deploy. Submit this address alongside the integrator
    ///         address when filing the whitelist request — the Diamond's
    ///         `registerIntegrator(integrator, proxyImpl, source)` records it
    ///         for the CREATE2-auth path that authorizes proxy calls.
    address public immutable proxyImpl;

    // ─── Constants ────────────────────────────────────────────────────
    /// @dev Per-transaction cap depends on the sale currency: India (INR) is
    ///      capped lower than other markets. `perTxCap(currency)` resolves it.
    ///      PER_TX_CAP is kept as the INR cap for source/ABI compatibility.
    uint256 public constant PER_TX_CAP = 50 * 1e6; // INR: 50 USDC
    uint256 public constant PER_TX_CAP_INR = 50 * 1e6; // India: 50 USDC
    uint256 public constant PER_TX_CAP_DEFAULT = 100 * 1e6; // other markets: 100 USDC
    /// @dev Default daily order limit. The LIVE limit is the mutable `dailyLimit`
    ///      below (admin-settable via setDailyLimit), initialised to this. The
    ///      constant is kept for source/ABI reference.
    uint256 public constant DAILY_TX_LIMIT = 25;
    /// @dev DEFAULT settlement lock. The LIVE lock is the mutable `settlementPeriod`
    ///      (super-admin-settable via setSettlementPeriod), optionally overridden
    ///      per-currency via setLockPeriod — so hold times are tunable per country
    ///      from the dashboard with NO redeploy. This constant is the initial global
    ///      default and is kept for source/ABI reference.
    uint256 public constant SETTLEMENT_PERIOD = 10 minutes;
    /// @dev Safety bounds on any admin-set settlement lock. The lock is the
    ///      solvency/fraud window: too short collapses it (funds unlock before a
    ///      dispute can surface), too long strands merchants' funds. Any value set
    ///      via setSettlementPeriod / setLockPeriod must fall within [MIN,MAX].
    uint256 public constant MIN_SETTLEMENT_PERIOD = 1 minutes;
    uint256 public constant MAX_SETTLEMENT_PERIOD = 30 days;
    /// @dev Hard ceiling on a merchant's stored buckets. Withdrawals compact
    ///      spent buckets, so this bounds the per-call loop cost and prevents
    ///      an unbounded-array gas-griefing / self-DoS surface.
    uint256 public constant MAX_BUCKETS = 256;

    /// @dev Dormant-account escheat window. A merchant frozen CONTINUOUSLY for at
    ///      least this long (see Merchant.frozenAt, reset on any unfreeze) can have
    ///      their remaining balance withdrawn by the super-admin via adminEscheat,
    ///      so funds behind a permanently-abandoned/blocked account are never lost.
    ///      90 days gives ample time for a legitimate merchant to be unfrozen first.
    uint256 public constant ESCHEAT_PERIOD = 90 days;

    /// @dev How long a proposed super-admin handoff stays acceptable. Long enough
    ///      for any real multisig/HSM ceremony, short enough that a forgotten
    ///      proposal can't be redeemed months later by a since-compromised key.
    uint256 public constant SUPER_ADMIN_HANDOFF_TTL = 7 days;

    /// @dev Mirrors OrderProcessorStorage.OrderStatus on the Diamond — used
    ///      by reconcileWithdrawal to read the authoritative terminal state.
    ///      Enum order: PLACED=0, ACCEPTED=1, PAID=2, COMPLETED=3, CANCELLED=4.
    uint8 internal constant STATUS_ACCEPTED = 1;
    uint8 internal constant STATUS_PAID = 2;
    uint8 internal constant STATUS_COMPLETED = 3;
    uint8 internal constant STATUS_CANCELLED = 4;

    // ─── State ────────────────────────────────────────────────────────

    struct SettlementBucket {
        uint256 amount;
        uint256 unlockTimestamp;
    }

    struct Merchant {
        address merchantAddr;
        // ENCRYPTED payout handle. The raw UPI / PIX / CBU / alias must NEVER be
        // stored on-chain in plaintext (public-chain PII leak). The app encrypts
        // the handle CLIENT-SIDE to the merchant's relay pubkey before sending it
        // here; the contract treats it as an opaque, non-empty blob it never
        // decodes. The LP/app decrypts off-chain when building the payout.
        bytes encPayoutId;
        string shopName;
        bytes32 currency; // offramp currency, e.g. bytes32("INR"|"BRL"|"ARS") — set once at registration
        uint256 totalDeposited;
        bool isFrozen;
        uint256 dailyTxCount;
        uint256 lastTxDate;
        uint256 inFlightWithdrawals; // count of this merchant's unsettled SELL withdrawals
        // UNIX time this merchant was CONTINUOUSLY frozen since (set on freeze,
        // cleared to 0 on unfreeze). Drives the 90-day dormant-account escheat:
        // adminEscheat is only reachable once (now - frozenAt) >= ESCHEAT_PERIOD.
        // Placed AFTER inFlightWithdrawals (index 9) so the public `merchants`
        // getter's earlier positional fields (0..8, which the frontend ABI reads)
        // are unchanged; the trailing `buckets` array is omitted by the getter.
        uint256 frozenAt;
        SettlementBucket[] buckets;
    }

    /// @dev Tracks an in-flight INR withdrawal (SELL order) so a Diamond-side
    ///      cancellation can be reconciled: USDC refunded to the system proxy
    ///      is swept back and re-credited to the merchant as a fresh unlocked
    ///      bucket. `settled` is a replay guard.
    struct PendingWithdrawal {
        address merchant;
        uint256 amount; // principal escrowed for THIS order (excludes fee)
        bool settled;
        bool upiDelivered; // setSellOrderUpi (fund+approve) has run for this SELL
        uint256 feeAdvanced; // fee topped up from the pool for THIS order (for exact recovery)
        // AUDIT FIX #10/#11: whether this withdrawal's in-flight slot has been
        // RELEASED (inFlightWithdrawals decremented). Tracked as its own flag so the
        // decrement is IDEMPOTENT across every settle/recovery path (_releaseSlot no-
        // ops if already freed) — the slot is released exactly once no matter which
        // of reconcile / finalize / adminAbort / adminForceSettle / adminForceUnwedge
        // / adminForceAbandonWedge runs. In the current paths slotFreed and `settled`
        // always move together; the separate flag also leaves room to free the slot
        // without settling (a capability the recovery design keeps available) while
        // never risking a double-decrement.
        bool slotFreed;
    }

    /// @notice Running sum of every merchant's bucket balance. The contract's
    ///         hard solvency invariant is `usdc.balanceOf(this) >= totalOwed`
    ///         at all times: protocol fees are charged to the withdrawing
    ///         merchant, never sourced from the commingled pool, so the pool
    ///         can never go under-collateralized against what merchants are owed.
    uint256 public totalOwed;

    mapping(address => Merchant) public merchants;
    mapping(address => bool) public registered;
    mapping(uint256 => address) public orderToMerchant;
    /// @notice BUY order id => whether onOrderComplete has ALREADY credited it.
    ///         Defense-in-depth idempotency (audit Finding 2): the Diamond
    ///         guarantees a B2B order completes exactly once, but this makes a
    ///         double completion a no-op regardless — a second onOrderComplete for
    ///         the same id reverts instead of double-crediting. It ALSO doubles as
    ///         the "was this BUY ever processed?" flag for sweepStrandedBuy: if the
    ///         completion callback reverted (funds stranded on the proxy), this
    ///         stayed false, so the stranded-recovery path knows the credit is owed.
    mapping(uint256 => bool) public orderCompleted;
    /// @notice BUY order id => the UTC day it was placed, so onOrderCancel only
    ///         releases a daily-count slot for the CURRENT day (a stale cross-day
    ///         cancel must not decrement a freshly-rolled counter).
    mapping(uint256 => uint256) public orderPlacementDay;
    mapping(uint256 => PendingWithdrawal) public withdrawals;
    /// @notice proxy address => the EOA it was deployed for. Set in
    ///         _ensureProxy. Lets validateOrder recognize a SELL placed by one
    ///         of our own merchant proxies (the carve-out) without trusting a
    ///         caller-supplied address.
    mapping(address => address) public proxyMerchant;

    /// @notice Optional per-currency per-tx cap override set by the owner. 0 =
    ///         no override (fall back to the INR/default rule). This lets a NEW
    ///         country get any cap on-chain from the admin dashboard WITHOUT a
    ///         contract change or redeploy — adding a country never touches code.
    mapping(bytes32 => uint256) public perTxCapOverride;

    /// @notice Live GLOBAL settlement lock (super-admin-settable via
    ///         setSettlementPeriod — no redeploy). Initialised to SETTLEMENT_PERIOD
    ///         (10 min). Used for any currency without a per-currency override.
    uint256 public settlementPeriod;

    /// @notice Optional per-currency settlement-lock override (super-admin-settable
    ///         via setLockPeriod). 0 = no override (fall back to the global
    ///         `settlementPeriod`). Lets each country hold funds for a different
    ///         duration (e.g. INR 10 min, BRL 30 min) entirely from the dashboard —
    ///         onboarding or re-tuning a country never needs a contract change.
    ///         Resolved per merchant via `lockPeriod(currency)`.
    mapping(bytes32 => uint256) public lockPeriodOverride;

    /// @notice Live daily order limit per merchant (admin-settable via
    ///         setDailyLimit — no redeploy). Initialised to DAILY_TX_LIMIT (25).
    uint256 public dailyLimit;

    /// @notice Optional admin-set keeper allowed to call deliverFiatPayout on
    ///         behalf of merchants (e.g. a backend that watches for ACCEPTED
    ///         SELL orders and delivers the encrypted payout). address(0) = none.
    ///         The merchant and owner can always deliver; this just adds a keeper.
    ///         Set via setTrustedRelayer (MANAGER tier or higher).
    address public trustedRelayer;

    /// @notice Admin set for the admin dashboard. Kept as a plain bool for
    ///         backwards compatibility (isAdmin / ABI): true whenever the wallet
    ///         holds ANY non-NONE role. The role tier is in `adminRole` below.
    mapping(address => bool) public admins;

    /// @notice ROLE-BASED ACCESS CONTROL. Roles are HIERARCHICAL by value: a
    ///         higher tier can do everything a lower tier can, PLUS its own
    ///         actions. Five tiers, least-privilege:
    ///         • NONE    (0): not an admin.
    ///         • VIEWER  (1): read-only — all views, no writes. For auditors /
    ///                        support staff who only need to SEE merchant activity.
    ///         • SUPPORT (2): + freeze / unfreeze a merchant (the safety switch).
    ///         • MANAGER (3): + config — setPerTxCap, setDailyLimit, setTrustedRelayer.
    ///         • FINANCE (4): + money recovery — adminAbortWithdrawal, adminForceSettle.
    ///         The OWNER sits above all tiers (implicitly FINANCE) and is the ONLY
    ///         one who can assign roles, add/remove admins, or transfer ownership.
    enum Role {
        NONE,
        VIEWER,
        SUPPORT,
        MANAGER,
        FINANCE
    }
    mapping(address => Role) public adminRole;

    // ─── Reentrancy guard ─────────────────────────────────────────────
    uint256 private _locked = 1;

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    // ─── Break-glass pause ────────────────────────────────────────────
    /// @notice When true, NEW activity (place order, all withdrawals) is halted.
    ///         It does NOT freeze funds or block recovery — in-flight order
    ///         completion (Diamond callbacks), reconciliation, and admin recovery
    ///         paths keep working so a paused system can still be safely wound down.
    ///         This is the "stop taking new orders/withdrawals" switch. Flippable by
    ///         any owner so the break-glass is fast and never bottlenecked on one key.
    bool public paused;

    /// @dev Gate NEW-activity entry points. Recovery/admin/Diamond-callback paths
    ///      are deliberately NOT gated (see `paused`).
    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    // ─── Access modifiers ─────────────────────────────────────────────

    modifier onlyDiamond() {
        if (msg.sender != diamond) revert OnlyDiamond();
        _;
    }

    modifier onlyOwner() {
        if (!isOwner[msg.sender]) revert OnlyOwner();
        _;
    }

    /// @dev Restricts an action to the single super-admin. Used for the root of
    ///      access control: owner-set management (add/remove owners) and role
    ///      assignment. Owners below the super-admin cannot perform these.
    modifier onlySuperAdmin() {
        if (msg.sender != superAdmin) revert OnlySuperAdmin();
        _;
    }

    /// @dev Any owner's EFFECTIVE tier is FINANCE (the top admin tier), so a
    ///      single hierarchy check covers both owners and any assigned admin.
    function _tier(address who) internal view returns (Role) {
        return isOwner[who] ? Role.FINANCE : adminRole[who];
    }

    /// @dev Require caller's tier >= `min`. Roles are hierarchical, so gating an
    ///      action at MANAGER also admits FINANCE and the owner. Reverts
    ///      NotAuthorized with the required and actual tiers for a clear panel msg.
    modifier onlyRole(Role min) {
        Role have = _tier(msg.sender);
        if (uint8(have) < uint8(min)) revert NotAuthorized(uint8(min), uint8(have));
        _;
    }

    /// @notice True if `who` can perform ANY admin action (an owner or any role).
    function isAdmin(address who) public view returns (bool) {
        return isOwner[who] || adminRole[who] != Role.NONE;
    }

    /// @notice True if `who` can perform MANAGER (config) actions or higher.
    function isManager(address who) public view returns (bool) {
        return uint8(_tier(who)) >= uint8(Role.MANAGER);
    }

    /// @notice True if `who` can perform FINANCE (money-recovery) actions.
    function isFinance(address who) public view returns (bool) {
        return uint8(_tier(who)) >= uint8(Role.FINANCE);
    }

    /// @notice The role tier of `who` as a uint8 (0=NONE,1=VIEWER,2=SUPPORT,
    ///         3=MANAGER,4=FINANCE). The owner reads as 4 (FINANCE) so a panel can
    ///         render it uniformly, even though ownership is a higher capability.
    function roleOf(address who) external view returns (uint8) {
        return uint8(_tier(who));
    }

    // ─── Constructor ──────────────────────────────────────────────────

    /**
     * @param _diamond   the p2p Diamond.
     * @param _usdc      USDC token. This contract custodies all merchant USDC
     *                   itself (internal custody) — there is no external vault.
     * @param _owners    additional owners (each full access). The deployer is
     *                   always the first owner.
     */
    constructor(address _diamond, address _usdc, address[] memory _owners) {
        if (_diamond == address(0) || _usdc == address(0)) revert InvalidAddress();
        diamond = _diamond;
        usdc = IERC20(_usdc);
        // Seed the deployer + any extra owners (each with full access). The
        // deployer is ALSO the super-admin — the single unremovable root that
        // alone manages the owner set and role assignments. Hand it off later
        // via transferSuperAdmin (e.g. to a multisig) once deployment settles.
        _addOwner(msg.sender);
        superAdmin = msg.sender;
        emit SuperAdminTransferred(address(0), msg.sender);
        for (uint256 i = 0; i < _owners.length; i++) {
            if (_owners[i] != address(0) && !isOwner[_owners[i]]) _addOwner(_owners[i]);
        }
        dailyLimit = DAILY_TX_LIMIT; // live limit starts at the default (25)
        settlementPeriod = SETTLEMENT_PERIOD; // live lock starts at the default (10 min)
        // Deploy the canonical UserProxy implementation. Every per-user clone
        // is a `cloneDeterministicWithImmutableArgs` of this address, with
        // `(user, address(this))` packed as the immutable args.
        proxyImpl = address(new UserProxy());
    }

    // ─── Currency naming (string ⇄ bytes32) ──────────────────────────
    //
    // The offramp currency is stored as a `bytes32` because that's what the p2p
    // Diamond expects on every order. But a bytes32 like
    // 0x494e520000…00 is unreadable, so this contract speaks plain ISO-4217
    // currency CODES ("INR", "BRL", "ARS", "MXN", "NGN", …):
    //
    //   • `registerMerchant(encPayoutId, shopName, "BRL")`  ← currency as a string
    //   • `getMerchantCurrency(addr)` → "BRL"            ← read it back as text
    //
    // Any country is supported as long as the p2p protocol has a circle for that
    // currency code — adding one needs NO contract change.

    /// @notice Pack a currency code string ("INR") into the bytes32 the Diamond
    ///         uses. Reverts on empty / >31 chars. Pure, so anyone can preview it.
    function toCurrency(string memory code) public pure returns (bytes32 out) {
        bytes memory b = bytes(code);
        if (b.length == 0 || b.length > 31) revert InvalidCurrency();
        // Reject interior NUL bytes so the value always round-trips through
        // fromCurrency (which truncates at the first NUL). Otherwise "IN\0R"
        // would store distinctly yet display as "IN", and two merchants could
        // register codes that render identically but route to different circles.
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] == 0) revert InvalidCurrency();
        }
        assembly {
            out := mload(add(b, 32))
        }
    }

    /// @notice Unpack a bytes32 currency back to its readable code string.
    function fromCurrency(bytes32 cur) public pure returns (string memory) {
        uint256 len = 0;
        while (len < 32 && cur[len] != 0) {
            len++;
        }
        bytes memory out = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            out[i] = cur[i];
        }
        return string(out);
    }

    // ─── Merchant registration ────────────────────────────────────────

    /// @notice Register the calling merchant with a human-readable currency
    ///         CODE ("INR", "BRL", "ARS", …). This is the recommended entry
    ///         point — any country picks its ISO currency code and is supported
    ///         as long as the protocol has a circle for it.
    /// @param encPayoutId  The merchant's payout handle (UPI/PIX/CBU/…),
    ///        ENCRYPTED CLIENT-SIDE to the merchant's relay pubkey. The contract
    ///        stores it as an opaque, non-empty blob and NEVER decodes it — the
    ///        raw handle must never be sent here in plaintext (public-chain PII).
    /// @param shopName  Display name.
    /// @param currencyCode ISO-4217-style code, e.g. "INR", "BRL". Non-empty.
    function registerMerchant(
        bytes calldata encPayoutId,
        string calldata shopName,
        string calldata currencyCode
    ) external {
        _register(encPayoutId, shopName, toCurrency(currencyCode));
    }

    /// @notice Same as above but takes the packed bytes32 currency directly, for
    ///         callers that already have it (e.g. tooling). Most integrations
    ///         should use the string overload above.
    /// @param currency bytes32 offramp currency, e.g. bytes32("INR"). Non-zero.
    function registerMerchantRaw(
        bytes calldata encPayoutId,
        string calldata shopName,
        bytes32 currency
    ) external {
        _register(encPayoutId, shopName, currency);
    }

    /// @notice Update the caller's editable profile fields — the encrypted payout
    ///         handle and shop name. The offramp CURRENCY is intentionally NOT
    ///         editable: it's locked at registration because funds and in-flight
    ///         orders are denominated in it, and changing it mid-flight could
    ///         route a settlement to the wrong circle. To change currency, a
    ///         merchant uses a fresh wallet/registration.
    /// @param encPayoutId New payout handle, client-side ENCRYPTED (non-empty).
    /// @param shopName New display name.
    function updateProfile(bytes calldata encPayoutId, string calldata shopName) external {
        if (!registered[msg.sender]) revert NotRegistered();
        if (encPayoutId.length == 0) revert InvalidAddress();
        Merchant storage m = merchants[msg.sender];
        if (m.isFrozen) revert MerchantIsFrozen(); // a frozen merchant can't edit
        m.encPayoutId = encPayoutId;
        m.shopName = shopName;
        emit MerchantProfileUpdated(msg.sender, shopName);
    }

    function _register(
        bytes calldata encPayoutId,
        string calldata shopName,
        bytes32 currency
    ) internal {
        if (registered[msg.sender]) revert AlreadyRegistered();
        if (currency == bytes32(0)) revert InvalidCurrency();
        // A payout target is required — without it fiat withdrawals have nowhere
        // to land (same rule updateProfile enforces). Opaque, non-empty blob.
        if (encPayoutId.length == 0) revert InvalidAddress();
        // AUDIT (MED): enforce CANONICAL bytes32 form on BOTH entry points —
        // left-aligned code, zero-padded, no non-zero byte after the first NUL.
        // registerMerchant's toCurrency already guarantees this; without the same
        // check here, registerMerchantRaw could smuggle "INR\0<junk>": it displays
        // as "INR" via fromCurrency but fails the `== bytes32("INR")` compare in
        // perTxCap, self-granting the 100 USDC default cap instead of INR's 50
        // (and dodging any admin setPerTxCap("INR") override).
        bool seenNul = false;
        for (uint256 i = 0; i < 32; i++) {
            if (currency[i] == 0) {
                seenNul = true;
            } else if (seenNul) {
                revert InvalidCurrency();
            }
        }
        Merchant storage m = merchants[msg.sender];
        m.merchantAddr = msg.sender;
        m.encPayoutId = encPayoutId;
        m.shopName = shopName;
        m.currency = currency;
        registered[msg.sender] = true;
        emit MerchantRegistered(msg.sender, shopName, currency);
    }

    // ─── IP2PIntegrator ───────────────────────────────────────────────

    /// @notice Per-transaction USDC cap for a given sale currency. If the owner
    ///         has set an override for this currency, that wins; otherwise India
    ///         (INR) is 50 USDC and every other market is 100 USDC. This means a
    ///         NEW country works with no contract change: it gets 100 USDC by
    ///         default, or any owner-set amount via setPerTxCap — never a redeploy.
    ///         View (reads the override mapping), so the UI can preview it.
    function perTxCap(bytes32 currency) public view returns (uint256) {
        uint256 ov = perTxCapOverride[currency];
        if (ov != 0) return ov;
        return currency == bytes32("INR") ? PER_TX_CAP_INR : PER_TX_CAP_DEFAULT;
    }

    /// @notice Settlement lock (seconds) for a given currency. A per-currency
    ///         override wins; otherwise the global `settlementPeriod` applies. This
    ///         is how funds' hold time is tuned per country from the dashboard with
    ///         no redeploy. View, so the UI can preview the exact hold. A merchant's
    ///         lock keys off their REGISTERED currency (see _lockFor).
    function lockPeriod(bytes32 currency) public view returns (uint256) {
        uint256 ov = lockPeriodOverride[currency];
        return ov != 0 ? ov : settlementPeriod;
    }

    /// @dev Resolve the settlement lock for a specific merchant from their
    ///      registered currency. Single source of truth for every credit site so
    ///      the per-currency hold is applied uniformly (deposits AND re-credits).
    function _lockFor(Merchant storage m) internal view returns (uint256) {
        return lockPeriod(m.currency);
    }

    function validateOrder(
        address user,
        uint256 amount,
        bytes32 /* currency */ // cap keys off the merchant's REGISTERED currency, not this (audit MED)
    ) external onlyDiamond returns (bool allowed) {
        // SELL self-call: order.user is a merchant's own proxy (owned by this
        // integrator), used as the placer for INR withdrawals. Withdrawal
        // limits were already enforced at the withdraw entry point, so merchant
        // buy-side limits do not apply here. proxyMerchant is set only for
        // proxies this contract deployed, so an arbitrary address cannot spoof
        // the carve-out.
        if (proxyMerchant[user] != address(0)) return true;

        if (!registered[user]) revert NotRegistered();
        Merchant storage m = merchants[user];
        if (m.isFrozen) revert MerchantIsFrozen();
        // Per-tx cap keys off the merchant's REGISTERED currency, NOT the
        // caller-supplied order currency — otherwise an INR merchant (50 USDC
        // cap) could pass currency="BRL" to unlock the 100 USDC default and
        // double their per-tx limit at will (audit MED). The cap reflects the
        // merchant's market (India 50 / others 100), which is a property of the
        // account, not of an individual sale's currency.
        if (amount > perTxCap(m.currency)) revert ExceedsPerTxCap();

        uint256 today = block.timestamp / 86400;
        if (m.lastTxDate != today) {
            m.dailyTxCount = 0;
            m.lastTxDate = today;
        }
        if (m.dailyTxCount >= dailyLimit) revert DailyLimitReached();
        m.dailyTxCount++;
        return true;
    }

    function onOrderComplete(
        uint256 orderId,
        address user,
        uint256 amount,
        address /* recipientAddr */
    ) external onlyDiamond nonReentrant {
        // Idempotency (audit Finding 2): a given BUY completes exactly once. If the
        // Diamond ever delivered a duplicate completion for the same id, credit it
        // only the first time — a repeat reverts rather than double-crediting. (The
        // repeated principal would be physically backed anyway, so this is defense-
        // in-depth, not a solvency fix; but reverting keeps the books unambiguous.)
        if (orderCompleted[orderId]) revert WithdrawalAlreadySettled();
        orderCompleted[orderId] = true;

        // recipientAddr = the merchant's proxy (usdcThroughIntegrator =
        // false): the Diamond just sent USDC there. Pull it into this integrator,
        // then forward it into the VAULT (custody), where it sits until the
        // settlement bucket unlocks. The integrator never keeps the funds.
        UserProxy(proxyAddress(user)).transferERC20ToIntegrator(address(usdc), amount);
        _toVault(amount);

        // Resolve the hold from the merchant's currency ONCE and reuse it for both
        // the bucket and the event, so the emitted unlock always matches the credit.
        uint256 unlockAt = block.timestamp + _lockFor(merchants[user]);
        _creditBucket(merchants[user], amount, unlockAt);
        merchants[user].totalDeposited += amount;

        // AUDIT FIX #4: a completed order is terminal — clear its cancel
        // bookkeeping so a later out-of-order or duplicate onOrderCancel for the
        // SAME id is a no-op (merchant==0), exactly like the second cancel of an
        // order already is. Without this, a stray cancel callback after
        // completion would wrongly decrement the merchant's daily-tx count.
        delete orderToMerchant[orderId];
        delete orderPlacementDay[orderId];

        emit OrderCompleted(orderId, user, amount, unlockAt);
    }

    /// @notice Best-effort: releases the daily-count slot consumed in
    ///         validateOrder. Tolerates unknown orderIds; deletes the
    ///         orderToMerchant entry so a repeated cancellation cannot
    ///         double-decrement.
    function onOrderCancel(uint256 orderId) external onlyDiamond nonReentrant {
        address merchant = orderToMerchant[orderId];
        if (merchant == address(0)) return; // SELL or unknown — nothing to release
        Merchant storage m = merchants[merchant];
        // MED-4: only release a slot for the CURRENT day. A day-N order cancelled
        // on day N+1 must NOT decrement N+1's freshly-rolled counter (that slot
        // was never consumed today). If the day already rolled, today's count is
        // effectively 0 for the stale order, so we skip the decrement.
        uint256 placedDay = orderPlacementDay[orderId];
        if (m.lastTxDate == placedDay && m.dailyTxCount > 0) {
            m.dailyTxCount--;
        }
        delete orderToMerchant[orderId];
        delete orderPlacementDay[orderId];
        emit OrderCancelled(orderId, merchant);
    }

    // ─── Order entry point (merchant-driven POS flow) ─────────────────

    function userPlaceOrder(
        address client,
        uint256 productId,
        uint256 quantity,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey
    ) external whenNotPaused nonReentrant returns (uint256 orderId) {
        // AUDIT NOTE (informational, by design): `client` is caller-supplied and
        // NOT allowlisted, so `total = unitPrice * quantity` is effectively
        // merchant-chosen — the on-chain "product price" is an app convention, not
        // a trusted integrity source. This is SAFE for this integrator: it never
        // calls the client's onCheckoutPayment (no NFT mint / price re-check), the
        // Diamond escrows real USDC equal to `total`, `totalOwed` tracks exactly
        // what is credited, and the per-tx cap (validateOrder) + settlement lock
        // are the real bounds. A merchant can only ever place an order that debits
        // and re-credits their OWN funds — there is no cross-merchant or pool
        // impact. If authoritative product pricing is ever needed, allowlist
        // `client` (or pin it) and re-verify price*quantity at completion.
        uint256 unitPrice = ICheckoutClient(client).getProductPrice(productId);
        if (unitPrice == 0) revert ProductNotFound();
        if (quantity == 0) revert InvalidQuantity();
        uint256 total = unitPrice * quantity; // checked mul (0.8 default) — reverts on overflow

        address proxy = _ensureProxy(msg.sender);
        // recipientAddr = the merchant's proxy: with usdcThroughIntegrator =
        // false the Diamond sends USDC there at completion and
        // onOrderComplete pulls it into this contract.
        bytes memory data = abi.encodeCall(
            IB2BGateway.placeB2BOrder,
            (msg.sender, total, currency, proxy, pubKey, circleId, 0, 0)
        );
        bytes memory result = UserProxy(proxy).execute(diamond, data, address(usdc), 0);
        orderId = abi.decode(result, (uint256));

        // validateOrder receives no orderId (the Diamond assigns it after
        // validation) — record the merchant here so onOrderCancel can
        // release the daily-count slot. Record the placement day too so a
        // stale cross-day cancellation can't decrement a different day's count.
        orderToMerchant[orderId] = msg.sender;
        orderPlacementDay[orderId] = block.timestamp / 86400;

        emit OrderPlaced(orderId, msg.sender, total);
    }

    // ─── Withdrawals ──────────────────────────────────────────────────

    /// @notice Withdraw unlocked USDC as local fiat in the merchant's REGISTERED
    ///         currency. Places a SELL order through the merchant's own proxy,
    ///         funded at placement. The payout handle (UPI/PIX) is delivered
    ///         LATER, encrypted, via `deliverFiatPayout` — so this call carries
    ///         the relay `pubKey` (secp256k1), NOT the payout string. The last
    ///         arg is retained for source/ABI compatibility but is unused on-chain.
    /// @param circleId The offramp circle on the Diamond for this currency,
    ///        resolved off-chain via the subgraph.
    /// @param pubKey Relay public key (the same identity used for BUY orders).
    function withdrawFiat(
        uint256 amount,
        uint256 circleId,
        string calldata pubKey,
        string calldata /* payoutOverride */
    ) external whenNotPaused nonReentrant returns (uint256 orderId) {
        Merchant storage m = _checkWithdraw(amount);
        return _withdrawFiat(m, amount, circleId, m.currency, pubKey);
    }

    /// @notice Withdraw unlocked USDC as local fiat in ANY currency the protocol
    ///         supports — not just the merchant's registered one. This lets a
    ///         merchant cash out funds they ACCEPTED in another currency (e.g. a
    ///         BRL payment) as that currency. Generic: the currency + payout are
    ///         caller-supplied; the contract enforces only that funds are the
    ///         merchant's own (per-merchant escrow + balance cap) and that the
    ///         Diamond accepts the currency/circle pair (else it reverts safely
    ///         and the USDC is recoverable via reconcileWithdrawal).
    /// @param currency The offramp currency (bytes32, e.g. "INR"|"BRL"). Non-zero.
    /// @param pubKey   Relay public key (secp256k1) — the Diamond stores it on the
    ///        SELL order so the LP can encrypt the payout to it. The actual payout
    ///        handle is delivered later via `deliverFiatPayout`, NOT here.
    function withdrawFiatIn(
        uint256 amount,
        uint256 circleId,
        bytes32 currency,
        string calldata pubKey
    ) external whenNotPaused nonReentrant returns (uint256 orderId) {
        if (currency == bytes32(0)) revert InvalidCurrency();
        if (bytes(pubKey).length == 0) revert InvalidAddress();
        Merchant storage m = _checkWithdraw(amount);
        return _withdrawFiat(m, amount, circleId, currency, pubKey);
    }

    /// @dev Shared core for both fiat-withdrawal entry points. Currency + the
    ///      relay pubKey are passed in; everything else — per-merchant proxy
    ///      isolation, balance debit, serialization, escrow tracking — is
    ///      identical and currency-independent.
    /// @param pubKey The merchant's relay public key (secp256k1, the same
    ///        identity used for BUY). The Diamond stores this on the SELL order
    ///        and the LP encrypts the payout to it; the actual payout handle is
    ///        delivered later, encrypted, via `deliverFiatPayout`. This field is
    ///        NOT the payout id — passing a plain UPI/PIX string here makes the
    ///        LP reject the order ("invalid user pubkey").
    function _withdrawFiat(
        Merchant storage m,
        uint256 amount,
        uint256 circleId,
        bytes32 currency,
        string memory pubKey
    ) internal returns (uint256 orderId) {
        if (circleId == 0) revert InvalidCircle(); // friendly local guard
        if (bytes(pubKey).length == 0) revert InvalidAddress(); // need a real relay key
        // MED-1: serialize a merchant's fiat withdrawals. The merchant has ONE
        // proxy, so two concurrent SELLs would commingle principals on it and a
        // per-order top-up/reconcile (which key off the proxy's aggregate
        // balance) could pay one order's fee out of another's escrow.
        if (m.inFlightWithdrawals != 0) revert WithdrawalInFlight();
        _deductUnlocked(m, amount);

        // Per-merchant proxy: funds for THIS merchant's SELL sit only on the
        // merchant's own proxy, never commingled with other merchants'. The
        // principal comes OUT OF THE VAULT to the proxy for the SELL placement.
        address merchantProxy = _ensureProxy(m.merchantAddr);
        _vaultPull(merchantProxy, amount);
        // userPubKey = the relay pubkey (NOT the payout). The payout/UPI is set
        // later, encrypted, via deliverFiatPayout -> setSellOrderUpi.
        bytes memory data = abi.encodeCall(
            IB2BGateway.placeB2BSellOrder,
            (merchantProxy, amount, currency, pubKey, circleId, 0, 0)
        );
        bytes memory result = UserProxy(merchantProxy).execute(diamond, data, address(usdc), 0);
        orderId = abi.decode(result, (uint256));

        withdrawals[orderId] = PendingWithdrawal({
            merchant: m.merchantAddr,
            amount: amount,
            settled: false,
            upiDelivered: false,
            feeAdvanced: 0,
            slotFreed: false
        });
        m.inFlightWithdrawals++;

        emit WithdrawalFiat(m.merchantAddr, orderId, currency, amount);
    }

    /// @notice Second step of a fiat withdrawal: after the LP accepts the SELL
    ///         order, the Diamond pulls `actualUsdtAmount` (= principal + fee)
    ///         from the merchant proxy via transferFrom during setSellOrderUpi.
    ///         The proxy was funded with principal-only at withdrawFiat, so this
    ///         tops it up by the FEE from the integrator's USDC, grants the
    ///         allowance, and calls setSellOrderUpi so the Diamond can pull and
    ///         settle. Without this the Diamond auto-cancels the SELL (the
    ///         "fee bug"). Currency-agnostic — works for any offramp.
    ///
    ///         AUDIT-MED (griefing fix): this step is AUTHORIZED, not permissionless.
    ///         `encPayout` is the payout payload the LP decrypts — if any caller
    ///         could supply it, an attacker could front-run the real merchant,
    ///         mark upiDelivered with a bogus/attacker payload, brick the fiat
    ///         channel (owner-only recovery), and burn the merchant's fee. Only
    ///         the recorded merchant, the owner, or the owner-set trusted relayer
    ///         may deliver — all of which act on the merchant's behalf.
    /// @param encPayout The Diamond-encrypted payout payload for this order
    ///        (built off-chain from the order's pubkey + the merchant's saved
    ///        payout id), same as the BUY flow supplies a pubkey.
    function deliverFiatPayout(uint256 orderId, string calldata encPayout) external nonReentrant {
        PendingWithdrawal storage w = withdrawals[orderId];
        if (w.merchant == address(0)) revert WithdrawalNotFound();
        // Only the merchant, an owner, or the trusted relayer — never arbitrary.
        if (msg.sender != w.merchant && !isOwner[msg.sender] && msg.sender != trustedRelayer)
            revert OnlyOwner();
        if (w.settled) revert WithdrawalAlreadySettled();
        if (w.upiDelivered) revert WithdrawalAlreadySettled();

        // HIGH-2: a frozen merchant's in-flight withdrawal must not settle.
        // Freeze is the only fraud kill-switch, so this permissionless step has
        // to honour it just like the withdraw entry point does.
        Merchant storage m = merchants[w.merchant];
        if (m.isFrozen) revert MerchantIsFrozen();

        // The Diamond pulls actualUsdtAmount (principal + fee) from order.user
        // (the merchant proxy) during setSellOrderUpi. Read it; refuse to run
        // until the Diamond has computed it (0 = not ready) rather than fall
        // back to principal-only, which re-introduces the fee bug.
        IOrderFlow.AdditionalOrderDetailsView memory aod = IOrderFlow(diamond)
            .getAdditionalOrderDetails(orderId);
        uint256 needed = aod.actualUsdtAmount;
        if (needed == 0) revert OfframpFeeNotReady();
        // AUDIT FIX #1 (trust-boundary guard): the Diamond documents
        // actualUsdtAmount as principal + fee, so it must be >= the principal we
        // escrowed (`w.amount`). If it ever reports LESS (a re-price / partial
        // fill / fee-model change), do NOT proceed: the proxy holds `w.amount` but
        // we'd grant an allowance of only `needed`, stranding the (w.amount-needed)
        // surplus on the proxy while totalOwed already dropped by the full
        // principal — with no reconcile/finalize path to recover it. Revert
        // instead so the mismatch surfaces loudly rather than silently losing the
        // merchant's funds. Recoverable afterwards via the CANCELLED paths.
        if (needed < w.amount) revert OfframpFeeNotReady();

        // AUDIT (retry double-debit guard): only an ACCEPTED SELL is deliverable.
        // After a Diamond auto-cancel we roll back `upiDelivered` (below) so
        // reconcile can run — but that also re-opens this function for the same
        // orderId. Without this check a redundant retry against the now-CANCELLED
        // order would debit the merchant's fee a SECOND time (and overwrite
        // `feeAdvanced`, so reconcile could only ever re-credit one of them),
        // relying solely on the Diamond to reject the stale setSellOrderUpi.
        // Enforce it here instead of trusting the facet's internal state checks.
        uint8 preStatus = IOrderFlow(diamond).getOrdersById(orderId).status;
        if (preStatus != STATUS_ACCEPTED) revert WithdrawalNotDeliverable();

        // CEI: set the replay flag before the external call; a revert rolls it
        // back so a legitimate retry still works.
        w.upiDelivered = true;

        address merchantProxy = _ensureProxy(w.merchant);
        // The proxy was funded with exactly this order's principal (`w.amount`) at
        // withdrawFiat. The Diamond needs `needed` = principal + fee, so we top up
        // the fee delta — but HIGH-1: that fee is CHARGED TO THE WITHDRAWING
        // MERCHANT (debited from their own unlocked buckets), never sourced from
        // the commingled pool. The contract only physically forwards it; `totalOwed`
        // drops by the fee, so `usdc.balanceOf(this) >= totalOwed` is preserved.
        //
        // AUDIT FIX C: size the top-up from the RECORDED escrow (`w.amount`), NOT
        // the live `balanceOf(proxy)`. Keying off the live balance let a stray /
        // self-seeded USDC balance on the deterministic proxy silently cover the
        // fee — so the fee wasn't debited from the merchant's buckets, feeAdvanced
        // stayed 0, and on a later cancel the merchant's surplus was swept back to
        // custody without a matching re-credit (a self-inflicted loss). Charging
        // `needed - w.amount` makes fee sourcing independent of any stray balance:
        // the merchant always pays their own fee from their buckets, and the proxy
        // still ends up holding at least `needed` for the Diamond to pull.
        if (needed > w.amount) {
            uint256 topUp = needed - w.amount; // = the offramp fee for this order
            // Debit the fee from the merchant's own unlocked balance. Reverts
            // InsufficientAvailableBalance if they can't cover it — the merchant
            // pays their own offramp fee, exactly like any real withdrawal.
            _deductUnlocked(m, topUp);
            if (_pool() < topUp) revert OfframpInsufficientPool();
            w.feeAdvanced = topUp; // recorded so reconcile attributes it exactly
            _vaultPull(merchantProxy, topUp); // fee comes out of custody
        }

        // Grant the Diamond an allowance of exactly `needed` and call
        // setSellOrderUpi. UserProxy.execute does NOT auto-sweep the USDC
        // remainder; any surplus left on the proxy is recovered later by
        // reconcileWithdrawal (which re-sweeps this order's own capped amount).
        bytes memory data = abi.encodeCall(IOrderFlow.setSellOrderUpi, (orderId, encPayout, 0));
        UserProxy(merchantProxy).execute(diamond, data, address(usdc), needed);

        // #2 (event integrity vs the real Diamond): the live OrderFlowFacet wraps
        // its USDC pull in try/catch and, on failure (or a re-price/liquidity
        // branch), AUTO-CANCELS the order and returns success — it does NOT revert.
        // So a returned `execute` is not proof of delivery. Read the order status
        // back: only latch upiDelivered / emit WithdrawalUpiDelivered when the
        // Diamond actually moved the order to PAID. If it auto-cancelled, roll the
        // latch back so reconcileWithdrawal can make the merchant whole and the
        // event stream never reports a delivery that didn't happen.
        uint8 postStatus = IOrderFlow(diamond).getOrdersById(orderId).status;
        if (postStatus == STATUS_PAID) {
            emit WithdrawalUpiDelivered(orderId, needed);
        } else {
            // Not delivered — undo the optimistic replay latch. The order is now
            // (auto-)cancelled; the refund lands on the proxy and is recovered by
            // reconcileWithdrawal, which re-credits the merchant.
            w.upiDelivered = false;
        }
    }

    /// @notice Withdraw unlocked USDC straight to the merchant's wallet.
    ///         Funds are custodied in this contract and transferred to the merchant.
    function withdrawUSDC(uint256 amount) external whenNotPaused nonReentrant {
        Merchant storage m = _checkWithdraw(amount);
        _deductUnlocked(m, amount);

        _vaultPull(msg.sender, amount);

        emit WithdrawalUSDC(msg.sender, amount);
    }

    /// @notice Recover an INR withdrawal whose SELL order the Diamond
    ///         cancelled WITHOUT the merchant receiving fiat. Reads the
    ///         authoritative order from the Diamond (not a caller argument),
    ///         sweeps the refunded USDC off the MERCHANT'S OWN proxy, and
    ///         re-credits that merchant. Permissionless on purpose — anyone
    ///         can trigger recovery; the merchant is the only beneficiary.
    ///
    ///         Two safety properties vs. a naive "status == CANCELLED" check:
    ///         (1) funds are read from the merchant's own proxy, so attribution
    ///         is exact — no other merchant's parked funds can be swept; and
    ///         (2) we refuse to re-credit an order that shows evidence of fiat
    ///         delivery (an open/closed dispute), which would otherwise let a
    ///         merchant keep the INR AND reclaim USDC.
    /// @notice Recover a fiat withdrawal whose SELL the Diamond CANCELLED. This
    ///         covers BOTH the never-accepted (PLACED→CANCELLED) case AND the
    ///         accepted-then-clawed-back (PAID→CANCELLED) case — in the latter
    ///         the Diamond refunds principal+fee to the merchant's proxy, so the
    ///         merchant did NOT keep fiat and must be made whole (NEW-1 fix: the
    ///         old `upiDelivered` hard-block left PAID→CANCELLED unrecoverable
    ///         and permanently stuck the in-flight slot).
    ///
    ///         Double-spend safety (the MED-2 concern) is enforced STRUCTURALLY,
    ///         not by trusting a flag: we re-credit ONLY what is physically on
    ///         the proxy. If fiat was truly delivered to the merchant, the Diamond
    ///         did not refund the proxy, so proxyBal ≈ 0 and the re-credit is 0 —
    ///         the merchant cannot reclaim USDC they already converted to fiat.
    function reconcileWithdrawal(uint256 orderId) external nonReentrant {
        PendingWithdrawal storage w = withdrawals[orderId];
        if (w.merchant == address(0)) revert UnknownWithdrawal();
        if (w.settled) revert WithdrawalAlreadySettled();

        IOrderFlow.OrderView memory order = IOrderFlow(diamond).getOrdersById(orderId);
        if (order.status != STATUS_CANCELLED) revert WithdrawalNotCancellable();
        // Refuse on any recorded dispute — a disputed order may have had fiat
        // delivered; leave those to off-chain/admin resolution.
        if (order.disputeInfo.status != 0 || order.disputeInfo.raisedBy != 0)
            revert WithdrawalNotCancellable();

        w.settled = true;
        Merchant storage m = merchants[w.merchant];
        _releaseSlot(w, m); // idempotent — may already be freed by adminForceUnwedge

        // M-1 (cross-order fund absorption): sweep only THIS order's own capped
        // amount off the proxy, never the whole balance. A merchant has a single
        // shared proxy on which a second pot of funds can legitimately sit (a
        // stranded-BUY payout, or another order's leftover). Sweeping the full
        // balance here while re-crediting only min(owedBack, proxyBal) would
        // silently absorb that other pot into unattributed surplus. Taking exactly
        // `take` (== the re-credit) and leaving the remainder on the proxy keeps
        // every pot claimable by its own recovery path — sweep == credit, always.
        //
        // The cap is min(owedBack, proxyBal), the same structural double-spend
        // guard as before (no refund on the proxy → no re-credit):
        //
        // AUDIT NOTE (informational): if the Diamond keeps the offramp fee on a
        // clawback (refunds principal only, not principal+fee), proxyBal is short
        // of owedBack and the merchant is not re-credited that fee — the CORRECT
        // outcome, the fee was genuinely spent on the offramp attempt. If instead
        // the Diamond refunds principal+fee, proxyBal covers owedBack and the full
        // amount is re-credited. The cap self-adjusts to whatever the Diamond did.
        address merchantProxy = _ensureProxy(w.merchant);
        uint256 proxyBal = usdc.balanceOf(merchantProxy);
        uint256 owedBack = w.amount + w.feeAdvanced;
        uint256 recredit = owedBack < proxyBal ? owedBack : proxyBal;
        if (recredit > 0) {
            UserProxy(merchantProxy).transferERC20ToIntegrator(address(usdc), recredit);
            _toVault(recredit);
        }
        // Re-lock under a fresh settlement window when the SELL had reached PAID
        // (fiat attempted) OR the merchant is FROZEN — a frozen account must not
        // get instantly-spendable funds back (mirrors adminAbortWithdrawal's
        // intent), otherwise this permissionless path would undermine the freeze.
        // Only the clean never-accepted, not-frozen case unlocks immediately.
        uint256 unlockAt = (w.upiDelivered || m.isFrozen)
            ? block.timestamp + _lockFor(m)
            : block.timestamp - 1;
        _creditBucket(m, recredit, unlockAt);

        emit WithdrawalReconciled(w.merchant, orderId, recredit);
    }

    /// @notice Mark an INR withdrawal as successfully completed (frees the
    ///         tracking slot). Permissionless; only flips a withdrawal whose
    ///         Diamond status is COMPLETED, so it cannot be abused to block
    ///         a legitimate reconciliation.
    ///
    ///         AUDIT LOW (stranded proxy leftover): a COMPLETED SELL normally
    ///         leaves the proxy empty (the Diamond pulled the full principal+fee
    ///         allowance). If the Diamond ever pulls LESS than granted, the
    ///         remainder would strand on the proxy — the merchant can't sweep USDC
    ///         and no other path targets a completed order. So finalize also sweeps
    ///         the proxy and re-credits the merchant, capped by the SAME structural
    ///         guard as every recovery path: min(what physically remains, what this
    ///         order debited). One-in-flight serialization makes the proxy balance
    ///         attributable to exactly this order. Re-locked under a fresh
    ///         settlement window (fiat was delivered — mirror the reconcile rule).
    function finalizeWithdrawal(uint256 orderId) external nonReentrant {
        PendingWithdrawal storage w = withdrawals[orderId];
        if (w.merchant == address(0)) revert UnknownWithdrawal();
        if (w.settled) revert WithdrawalAlreadySettled();
        uint8 status = IOrderFlow(diamond).getOrdersById(orderId).status;
        if (status != STATUS_COMPLETED) revert WithdrawalNotCancellable();
        w.settled = true;
        Merchant storage m = merchants[w.merchant];
        _releaseSlot(w, m); // idempotent — may already be freed by adminForceUnwedge

        // M-1: sweep only this order's own capped amount (min(owedBack, proxyBal)),
        // never the whole proxy balance — any co-resident funds (a stranded BUY, or
        // another order's leftover) stay on the proxy for their own recovery path.
        address merchantProxy = _ensureProxy(w.merchant);
        uint256 proxyBal = usdc.balanceOf(merchantProxy);
        uint256 owedBack = w.amount + w.feeAdvanced;
        uint256 recredit = owedBack < proxyBal ? owedBack : proxyBal;
        if (recredit > 0) {
            UserProxy(merchantProxy).transferERC20ToIntegrator(address(usdc), recredit);
            _toVault(recredit); // sweep proxy → integrator (custody)
            _creditBucket(m, recredit, block.timestamp + _lockFor(m));
        }
        // #4: emit unconditionally — the clean (proxy-empty) COMPLETED case still
        // flips w.settled and frees the in-flight slot, a state change the backend
        // must be able to observe. recredit is 0 on the clean path.
        emit WithdrawalFinalized(w.merchant, orderId, recredit);
    }

    /// @notice RECOVER a COMPLETED BUY whose onOrderComplete callback reverted,
    ///         leaving the customer's USDC stranded on the merchant's proxy and the
    ///         merchant uncredited (audit Finding 1). The Diamond finalises a BUY
    ///         protocol-side even if the integrator callback reverts (its callback
    ///         is wrapped in try/catch), and no other path sweeps a BUY proxy — so
    ///         without this those funds would sit unrecoverable (UserProxy.sweepERC20
    ///         blocks USDC, so the merchant can't self-rescue). This sweeps the
    ///         stranded USDC into custody and credits the merchant, so the money the
    ///         customer paid always reaches the merchant even if the callback failed.
    ///
    ///         SAFETY:
    ///           • Only for an order the Diamond reports COMPLETED (real settlement),
    ///             and only if `orderCompleted[orderId]` is still false — i.e. the
    ///             normal credit genuinely never happened. A successful completion
    ///             set the flag, so this refuses (no double-credit).
    ///           • The credit is capped by BOTH the order's own `amount` and what is
    ///             PHYSICALLY on the proxy (`min`), the same structural guard every
    ///             recovery path uses — a merchant pre-seeding their proxy with stray
    ///             USDC cannot inflate the credit beyond the order's real value, and
    ///             nothing is credited that wasn't swept in.
    ///           • `recipientAddr` must be this merchant's proxy, tying the swept
    ///             funds to exactly this order. Credited under a fresh settlement lock
    ///             (like a normal deposit). Idempotent: it sets orderCompleted so a
    ///             second call reverts.
    ///         Callable by the merchant, an owner, or the trusted relayer — all act
    ///         for the merchant, who is the sole beneficiary.
    /// @param orderId The COMPLETED BUY order whose funds are stranded on the proxy.
    function sweepStrandedBuy(uint256 orderId) external nonReentrant {
        address merchant = orderToMerchant[orderId];
        // orderToMerchant is set for BUYs at placement and DELETED on a successful
        // completion; a reverted completion leaves it set. Zero ⇒ not a recoverable
        // stranded BUY (never placed here, or already cleanly completed).
        if (merchant == address(0)) revert UnknownWithdrawal();
        if (orderCompleted[orderId]) revert WithdrawalAlreadySettled();
        // Authorization: merchant / owner / trusted relayer (mirrors deliverFiatPayout).
        if (msg.sender != merchant && !isOwner[msg.sender] && msg.sender != trustedRelayer)
            revert OnlyOwner();

        // The Diamond must report this BUY COMPLETED — proof it really sent the
        // funds and finalised. Anything else is not a stranded-completion case.
        IOrderFlow.OrderView memory order = IOrderFlow(diamond).getOrdersById(orderId);
        if (order.status != STATUS_COMPLETED) revert WithdrawalNotCancellable();

        Merchant storage m = merchants[merchant];
        // M-1 (belt-and-suspenders serialization): refuse while a SELL withdrawal is
        // in flight. An in-flight withdrawal parks its principal on this same shared
        // proxy; combined with the capped-sweep fix below either alone prevents the
        // cross-order absorption, but the gate also keeps the proxy balance
        // attributable to exactly one order for the strongest invariant.
        if (m.inFlightWithdrawals != 0) revert WithdrawalInFlight();

        address merchantProxy = _ensureProxy(merchant);
        // The completion must have paid THIS merchant's proxy — ties the swept
        // balance to this order and blocks recovering against any other proxy.
        if (order.recipientAddr != merchantProxy) revert InvalidAddress();

        // Mark processed BEFORE the external sweep (CEI) — a revert rolls it back so
        // a legitimate retry still works; success makes a second call a no-op.
        orderCompleted[orderId] = true;
        delete orderToMerchant[orderId];
        delete orderPlacementDay[orderId];

        uint256 proxyBal = usdc.balanceOf(merchantProxy);
        if (proxyBal == 0) revert NothingToWithdraw(); // nothing stranded to recover

        // M-1: sweep only this order's own capped amount, never the whole proxy.
        // Structural cap: credit at most the order's real amount, and never more
        // than what was physically on the proxy. Sweeping exactly `credit` (== the
        // re-credit) leaves any co-resident funds on the proxy for their own path,
        // so one order's recovery can never absorb another's into surplus.
        uint256 credit = order.amount < proxyBal ? order.amount : proxyBal;
        UserProxy(merchantProxy).transferERC20ToIntegrator(address(usdc), credit);
        _toVault(credit); // sweep proxy → integrator (custody)

        // Locked under a fresh settlement window, exactly like a normal on-time
        // completion would have been.
        _creditBucket(m, credit, block.timestamp + _lockFor(m));
        m.totalDeposited += credit;

        emit StrandedBuyRecovered(orderId, merchant, credit);
    }

    function _checkWithdraw(uint256 amount) internal view returns (Merchant storage m) {
        if (!registered[msg.sender]) revert NotRegistered();
        m = merchants[msg.sender];
        if (m.isFrozen) revert MerchantIsFrozen();
        if (amount == 0) revert NothingToWithdraw();
    }

    /// @dev Append an unlocked/locked bucket, compacting fully-spent buckets
    ///      first so the array stays bounded by MAX_BUCKETS. Coalesces a new
    ///      credit into an existing bucket with the SAME unlock timestamp so a
    ///      merchant's live-bucket count cannot grow without bound (and the
    ///      credit path can never revert at the cap and strand a deposit).
    function _creditBucket(Merchant storage m, uint256 amount, uint256 unlockTimestamp) internal {
        if (amount == 0) return;
        totalOwed += amount;
        _compact(m);
        // Fold into an existing bucket sharing this unlock window if present.
        uint256 len = m.buckets.length;
        for (uint256 i = 0; i < len; i++) {
            if (m.buckets[i].unlockTimestamp == unlockTimestamp) {
                m.buckets[i].amount += amount;
                return;
            }
        }
        // No matching window — must append. If at the cap, fold the new credit
        // into an existing bucket rather than revert: this keeps the credit path
        // infallible (a completed deposit can ALWAYS be recorded).
        //
        // AUDIT FIX D (round 1) + #7 (round 2): the merge must never move funds
        // across the locked/unlocked boundary in EITHER direction — it must not
        // re-lock a merchant's already-spendable principal (the round-1 concern),
        // and it must not make a still-locked incoming credit spendable early (the
        // round-2 regression). We enforce that by folding ONLY into a bucket whose
        // lock-state MATCHES the incoming credit:
        //   • incoming LOCKED   → fold into the oldest still-LOCKED bucket, adopting
        //     max(hostTs, incomingTs) so neither unlocks earlier than intended.
        //   • incoming UNLOCKED → fold into the oldest already-UNLOCKED bucket,
        //     leaving its (past) timestamp untouched — both stay spendable.
        if (m.buckets.length >= MAX_BUCKETS) {
            bool incomingLocked = unlockTimestamp >= block.timestamp;
            // Find the oldest bucket whose lock-state MATCHES the incoming credit.
            uint256 target = type(uint256).max;
            uint256 targetTs = type(uint256).max;
            for (uint256 i = 0; i < len; i++) {
                uint256 ts = m.buckets[i].unlockTimestamp;
                bool bucketLocked = ts >= block.timestamp;
                if (bucketLocked == incomingLocked && ts < targetTs) {
                    targetTs = ts;
                    target = i;
                }
            }
            if (target != type(uint256).max) {
                // Same-state merge: locked→locked adopts the later unlock (never
                // early); unlocked→unlocked keeps the past timestamp (stays
                // spendable). The timestamp bump only ever applies to a locked
                // host, so it can never re-lock already-spendable principal.
                if (incomingLocked && unlockTimestamp > m.buckets[target].unlockTimestamp) {
                    m.buckets[target].unlockTimestamp = unlockTimestamp;
                }
                m.buckets[target].amount += amount;
                return;
            }
            // BUG FIX (#7 fallback): no same-state host exists (all 256 buckets are
            // the OPPOSITE lock-state). Folding into a mismatched bucket would
            // corrupt fund availability — re-locking incoming unlocked funds, or
            // re-locking a host's already-spendable principal (the exact bugs #7/D
            // fixed). Instead, coalesce the two oldest SAME-state EXISTING buckets
            // (all buckets share the opposite state, so a same-state pair always
            // exists) to free one slot, then append the incoming credit as its own
            // correctly-timestamped bucket. Every bucket keeps its true lock-state;
            // nothing is re-locked or unlocked early. This is a rare cap edge (256
            // buckets all one state, incoming the other, no exact-ts match).
            uint256 a = type(uint256).max;
            uint256 aTs = type(uint256).max;
            uint256 b = type(uint256).max;
            uint256 bTs = type(uint256).max;
            for (uint256 i = 0; i < len; i++) {
                uint256 ts = m.buckets[i].unlockTimestamp; // all are !incomingLocked here
                if (ts < aTs) {
                    b = a;
                    bTs = aTs;
                    a = i;
                    aTs = ts;
                } else if (ts < bTs) {
                    b = i;
                    bTs = ts;
                }
            }
            // Merge b into a using the safe (later) timestamp — both share the
            // opposite lock-state, so max() never crosses the locked/unlocked line.
            if (bTs > aTs) m.buckets[a].unlockTimestamp = bTs;
            m.buckets[a].amount += m.buckets[b].amount;
            m.buckets[b].amount = 0;
            _compact(m); // drop the now-zeroed slot, freeing room to append
        }
        m.buckets.push(SettlementBucket({ amount: amount, unlockTimestamp: unlockTimestamp }));
    }

    /// @dev Removes ALL fully-spent (amount == 0) buckets, preserving order of
    ///      the live ones. A stable compaction: spent buckets can appear
    ///      anywhere (a locked bucket can sit in front of a spent unlocked
    ///      one), so a head-only pass would leave interior zeros and let the
    ///      array drift toward MAX_BUCKETS. This pass reclaims every zero.
    function _compact(Merchant storage m) internal {
        uint256 len = m.buckets.length;
        uint256 write = 0;
        for (uint256 read = 0; read < len; read++) {
            if (m.buckets[read].amount != 0) {
                if (write != read) {
                    m.buckets[write] = m.buckets[read];
                }
                write++;
            }
        }
        // Pop the tail left after compaction (len - write spent slots).
        while (m.buckets.length > write) {
            m.buckets.pop();
        }
    }

    /// @dev Sums unlocked buckets, reverts if short, then deducts
    ///      oldest-first (buckets are pushed chronologically).
    function _deductUnlocked(Merchant storage m, uint256 amount) internal {
        uint256 unlocked = 0;
        uint256 len = m.buckets.length;
        for (uint256 i = 0; i < len; i++) {
            if (m.buckets[i].unlockTimestamp < block.timestamp) {
                unlocked += m.buckets[i].amount;
            }
        }
        if (unlocked < amount) revert InsufficientAvailableBalance();

        totalOwed -= amount;
        uint256 remaining = amount;
        for (uint256 i = 0; i < len && remaining > 0; i++) {
            SettlementBucket storage b = m.buckets[i];
            if (b.unlockTimestamp >= block.timestamp || b.amount == 0) continue;
            uint256 take = b.amount < remaining ? b.amount : remaining;
            b.amount -= take;
            remaining -= take;
        }
    }

    /// @dev AUDIT FIX #10: release a withdrawal's in-flight slot exactly once.
    ///      Idempotent via `w.slotFreed`, so whichever lifecycle path runs first
    ///      (an early adminForceUnwedge that frees the channel, then a later
    ///      reconcile/adminForceSettle that finalises the refund) decrements
    ///      inFlightWithdrawals only on the first call. Decoupling the slot release
    ///      from `settled` lets a late PAID→CANCELLED refund still be swept and
    ///      re-credited after the channel was un-wedged.
    function _releaseSlot(PendingWithdrawal storage w, Merchant storage m) internal {
        if (w.slotFreed) return;
        w.slotFreed = true;
        if (m.inFlightWithdrawals > 0) m.inFlightWithdrawals--;
    }

    // ─── Admin ────────────────────────────────────────────────────────

    /// @notice SUPER-ADMIN-ONLY: assign an admin's role tier. This is the single
    ///         entry point for role-based access. Roles are hierarchical — a higher
    ///         tier includes every lower tier's powers. Pass Role.NONE to revoke.
    ///         Keeps the legacy `admins` bool in sync (true for any non-NONE role)
    ///         so isAdmin / existing integrations keep working. No redeploy needed.
    ///         Only the super-admin (not other owners) may assign roles.
    /// @param who  The admin wallet.
    /// @param role 0=NONE(revoke) 1=VIEWER 2=SUPPORT 3=MANAGER 4=FINANCE.
    function setRole(address who, Role role) public onlySuperAdmin {
        if (who == address(0)) revert InvalidAddress();
        // The super-admin's own tier is FINANCE-by-virtue-of-superAdmin and can
        // never be lowered — refuse any attempt to set a role on the super-admin
        // (its access does not come from adminRole and must stay untouchable).
        if (who == superAdmin) revert CannotRemoveSuperAdmin();
        bool wasAdmin = adminRole[who] != Role.NONE;
        adminRole[who] = role;
        admins[who] = role != Role.NONE;
        emit AdminRoleSet(who, uint8(role));
        // Keep the legacy add/remove events firing for any listener still on them.
        if (role != Role.NONE && !wasAdmin) emit AdminAdded(who);
        if (role == Role.NONE && wasAdmin) emit AdminRemoved(who);
    }

    /// @notice SUPER-ADMIN-ONLY: add an admin. Back-compat shim — grants FINANCE
    ///         (the full admin tier, matching the previous flat-admin behaviour
    ///         where a single admin could do everything). Use setRole(who, <tier>)
    ///         for a narrower role (e.g. Role.SUPPORT for freeze-only, Role.VIEWER
    ///         for read-only).
    function addAdmin(address who) external onlySuperAdmin {
        setRole(who, Role.FINANCE);
    }

    /// @notice SUPER-ADMIN-ONLY: remove an admin (revoke all roles).
    function removeAdmin(address who) external onlySuperAdmin {
        setRole(who, Role.NONE);
    }

    /// @notice SUPER-ADMIN-ONLY: add another main owner (full access). Only the
    ///         super-admin may grow the owner set — a regular owner cannot add or
    ///         remove owners.
    function addOwner(address who) external onlySuperAdmin {
        if (who == address(0)) revert InvalidAddress();
        if (isOwner[who]) revert AlreadyRegistered();
        _addOwner(who);
    }

    /// @notice SUPER-ADMIN-ONLY: remove an owner. The super-admin can NEVER be
    ///         removed (CannotRemoveSuperAdmin), and the LAST owner can never be
    ///         removed either (the contract is never orphaned). Only the super-admin
    ///         may remove owners.
    function removeOwner(address who) external onlySuperAdmin {
        if (!isOwner[who]) revert InvalidAddress();
        // The super-admin is unremovable by anyone, including via the owner path.
        if (who == superAdmin) revert CannotRemoveSuperAdmin();
        if (ownerCount == 1) revert LastOwner();
        isOwner[who] = false;
        ownerCount--;
        emit OwnerRemoved(who);
    }

    /// @notice SUPER-ADMIN-ONLY: BEGIN a super-admin handoff to `next`. This is the
    ///         ONLY way the super-admin ever changes — there is no removal path.
    ///
    ///         AUDIT FIX B — TWO-STEP handoff: this only PROPOSES `next`; the role
    ///         does not move until `next` itself calls `acceptSuperAdmin`. This
    ///         makes a fat-fingered / uncontrolled target non-fatal — an address
    ///         that can't call accept never becomes super-admin, so root governance
    ///         can't be permanently orphaned by a single mistyped handoff. Re-call
    ///         with a different `next` to change the pending target, or address(0)
    ///         to cancel a pending handoff.
    /// @param next The proposed new super-admin (address(0) cancels a pending one).
    function transferSuperAdmin(address next) external onlySuperAdmin {
        if (next == superAdmin) revert InvalidAddress(); // no-op handoff
        pendingSuperAdmin = next;
        // AUDIT LOW (stale-handoff): a proposal is only acceptable for the TTL.
        // A forgotten pending target must not be able to seize root months later
        // (its key could be compromised by then). Cancelling clears the window.
        pendingSuperAdminExpiry = next == address(0)
            ? 0
            : block.timestamp + SUPER_ADMIN_HANDOFF_TTL;
        emit SuperAdminTransferStarted(superAdmin, next);
    }

    /// @notice Called by the PENDING super-admin to complete the handoff, proving
    ///         it controls the key. Only then does root actually move. Must run
    ///         within SUPER_ADMIN_HANDOFF_TTL of the proposal — an expired proposal
    ///         reverts and must be re-issued by the current super-admin. `next`
    ///         becomes an owner if it isn't already (the super-admin is always an
    ///         owner); the PREVIOUS super-admin REMAINS an owner (not auto-evicted).
    function acceptSuperAdmin() external {
        if (msg.sender != pendingSuperAdmin) revert OnlySuperAdmin();
        if (block.timestamp > pendingSuperAdminExpiry) revert HandoffExpired();
        if (!isOwner[msg.sender]) _addOwner(msg.sender); // the super-admin is always an owner
        address prev = superAdmin;
        superAdmin = msg.sender;
        pendingSuperAdmin = address(0);
        pendingSuperAdminExpiry = 0;
        emit SuperAdminTransferred(prev, msg.sender);
    }

    function _addOwner(address who) internal {
        isOwner[who] = true;
        ownerCount++;
        emit OwnerAdded(who);
    }

    // ─── Fund helpers (INTERNAL custody) ──────────────────────────────
    // This integrator custodies ALL merchant USDC itself — there is no separate
    // vault. USDC swept from a merchant proxy (BUY completion / SELL refund) lands
    // directly on this contract's own balance, and withdrawals pay out from that
    // same balance. `_pool()` is simply our own USDC balance. Keeping funds and
    // accounting (totalOwed, buckets) in ONE contract is deliberate: it makes the
    // solvency invariant `usdc.balanceOf(this) >= totalOwed` a local property, and
    // it makes upgrades safe — a replacement integrator is a fresh deployment; the
    // OLD one stays live holding its own funds + records so merchants drain it
    // normally (dormant leftovers are recoverable via adminEscheat). No cross-
    // contract fund migration is ever required, so funds can never be stranded by
    // a custody handoff. All money movement in the contract goes through these.

    /// @dev Historically forwarded a just-received deposit into an external vault.
    ///      With internal custody the USDC already sits on this contract, so there
    ///      is nothing to forward — this is a no-op kept so the sweep/credit call
    ///      sites read unchanged. (An explicit helper, not an inlined delete, so
    ///      the deposit path's intent — "this USDC is now custodied" — stays legible.)
    function _toVault(uint256 amount) internal pure {
        amount; // no-op: funds are already custodied on this contract
    }

    /// @dev Move `amount` USDC out of custody to `to`, straight from this
    ///      contract's own balance. The sole outward fund primitive.
    function _vaultPull(address to, uint256 amount) internal {
        if (amount > 0) usdc.safeTransfer(to, amount);
    }

    /// @dev The pool backing merchant funds is exactly the USDC this contract
    ///      holds. The solvency invariant is `_pool() >= totalOwed` at all times.
    function _pool() internal view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /// @notice Back-compat shim: transferOwnership here only ADDS `newOwner` to the
    ///         owner set — it does NOT drop the caller (the caller is the super-admin,
    ///         who must always remain an owner). Nothing is actually "transferred", so
    ///         it emits OwnerAdded (via _addOwner), NOT OwnershipTransferred, to avoid
    ///         misleading indexers into recording a handoff that never happened. With
    ///         multi-owner, prefer addOwner / removeOwner directly. To move ROOT
    ///         control, use transferSuperAdmin (the real two-step handoff).
    function transferOwnership(address newOwner) external onlySuperAdmin {
        if (newOwner == address(0)) revert InvalidAddress();
        // Guard the self-transfer foot-gun: transferOwnership(self) would fall
        // through to the drop-caller branch below and silently REMOVE the caller
        // (a pure self-eviction, not a handoff). A handoff to yourself is a no-op
        // by intent, so reject it explicitly rather than strip ownership.
        if (newOwner == msg.sender) revert InvalidAddress();
        // The caller is the super-admin (onlySuperAdmin), who must ALWAYS remain an
        // owner — dropping it below would leave the super-admin not-an-owner (it
        // would lose FINANCE-tier owner powers while still gating governance). So
        // add the new owner but do NOT evict the super-admin caller. Root handoff
        // is transferSuperAdmin's job, not this shim's.
        // #6: _addOwner emits OwnerAdded — the accurate event for what happened. We
        // deliberately do NOT emit OwnershipTransferred: the caller is never dropped,
        // so no ownership actually transfers, and emitting it would mislead indexers.
        if (!isOwner[newOwner]) _addOwner(newOwner);
    }

    // NOTE: there is intentionally NO setVault / flushToVault / migrateState.
    // Custody lives inside this contract, so there is no external vault to point
    // at and no cross-contract fund migration primitive to get wrong. An upgrade
    // is a fresh deployment: the OLD integrator stays live holding its own USDC +
    // buckets, merchants drain it normally, and any dormant leftovers are recovered
    // via adminEscheat — so a replacement never has to (and never can) strand funds
    // by adopting someone else's custody. See docs/integrators/merchant-terminal.md.

    /// @notice Set (or clear) the per-transaction USDC cap for a currency. Lets
    ///         the team onboard a NEW country and tune its cap entirely from the
    ///         admin dashboard — no contract change, no redeploy. Pass cap = 0 to
    ///         clear the override and fall back to the INR/default rule.
    /// @param currency The sale currency (bytes32, e.g. bytes32("MXN")).
    /// @param cap      Per-tx cap in USDC 6-decimals (e.g. 75 * 1e6). 0 = clear.
    function setPerTxCap(bytes32 currency, uint256 cap) external onlyRole(Role.MANAGER) {
        if (currency == bytes32(0)) revert InvalidCurrency();
        perTxCapOverride[currency] = cap;
        emit PerTxCapSet(currency, cap);
    }

    /// @notice Set the live daily order limit per merchant (admin-settable — no
    ///         redeploy). Must be non-zero (0 would block all orders). Applies
    ///         from the next order; a merchant already at/over the new lower
    ///         limit simply can't place more today.
    /// @param newLimit New max orders per merchant per UTC day.
    function setDailyLimit(uint256 newLimit) external onlyRole(Role.MANAGER) {
        if (newLimit == 0) revert InvalidQuantity();
        dailyLimit = newLimit;
        emit DailyLimitSet(newLimit);
    }

    /// @notice SUPER-ADMIN-ONLY: set the GLOBAL settlement lock (the default hold
    ///         used for any currency without a per-currency override). Lets the team
    ///         tune the base hold time from the dashboard with NO redeploy. Must fall
    ///         within [MIN_SETTLEMENT_PERIOD, MAX_SETTLEMENT_PERIOD] — the lock is the
    ///         solvency/fraud window, so it can't be set to ~0 (funds unlock before a
    ///         dispute surfaces) or absurdly long (funds stranded).
    ///
    ///         Restricted to the super-admin (not every MANAGER) because it changes
    ///         how long EVERY merchant's funds are held — a fund-sensitive global.
    ///         Applies to NEW credits only; buckets already created
    ///         keep their original unlock timestamp (no retroactive re-lock/unlock).
    /// @param newPeriod New global lock in seconds (e.g. 10 minutes = 600).
    function setSettlementPeriod(uint256 newPeriod) external onlySuperAdmin {
        if (newPeriod < MIN_SETTLEMENT_PERIOD || newPeriod > MAX_SETTLEMENT_PERIOD)
            revert InvalidLockPeriod();
        settlementPeriod = newPeriod;
        emit SettlementPeriodSet(newPeriod);
    }

    /// @notice SUPER-ADMIN-ONLY: set (or clear) the per-currency settlement lock so
    ///         each country can hold funds for a different duration (e.g. INR 10 min,
    ///         BRL 30 min) — all from the dashboard, no redeploy. Pass period = 0 to
    ///         CLEAR the override and fall back to the global `settlementPeriod`. A
    ///         non-zero period must fall within [MIN,MAX]_SETTLEMENT_PERIOD.
    ///
    ///         Applies to NEW credits only; existing buckets keep their timestamp.
    /// @param currency The offramp currency (bytes32, e.g. bytes32("BRL")). Non-zero.
    /// @param period   Lock in seconds, or 0 to clear the override.
    function setLockPeriod(bytes32 currency, uint256 period) external onlySuperAdmin {
        if (currency == bytes32(0)) revert InvalidCurrency();
        if (period != 0 && (period < MIN_SETTLEMENT_PERIOD || period > MAX_SETTLEMENT_PERIOD))
            revert InvalidLockPeriod();
        lockPeriodOverride[currency] = period;
        emit LockPeriodSet(currency, period);
    }

    /// @notice Set (or clear via address(0)) the keeper allowed to call
    ///         deliverFiatPayout on merchants' behalf. Owner + merchant can
    ///         always deliver regardless.
    function setTrustedRelayer(address relayer) external onlyRole(Role.MANAGER) {
        trustedRelayer = relayer;
        emit TrustedRelayerSet(relayer);
    }

    /// @dev SUPPORT tier or higher — freezing is the baseline safety action.
    ///      Stamps `frozenAt` (only on a fresh freeze, so re-calling while already
    ///      frozen does NOT extend the dormancy clock) to start the 90-day escheat
    ///      window. A subsequent unfreeze clears it, so escheat needs a CONTINUOUS
    ///      90-day freeze.
    function freezeMerchant(address merchant) external onlyRole(Role.SUPPORT) {
        Merchant storage m = merchants[merchant];
        // Idempotent: re-freezing an already-frozen merchant is a silent no-op —
        // no event, so indexers see exactly one MerchantFrozen per freeze episode
        // (and the dormancy clock is never restarted, per the escheat rules).
        if (!m.isFrozen) {
            m.isFrozen = true;
            m.frozenAt = block.timestamp; // start the dormancy clock
            emit MerchantFrozen(merchant);
        }
    }

    /// @dev SUPPORT tier or higher. Clears `frozenAt` so any freeze/unfreeze cycle
    ///      RESETS the 90-day dormancy clock (escheat requires continuous freeze).
    ///      Idempotent — unfreezing a not-frozen merchant is a silent no-op.
    function unfreezeMerchant(address merchant) external onlyRole(Role.SUPPORT) {
        Merchant storage m = merchants[merchant];
        if (m.isFrozen) {
            m.isFrozen = false;
            m.frozenAt = 0; // reset the dormancy clock
            emit MerchantUnfrozen(merchant);
        }
    }

    /// @notice The UNIX time at which `merchant` becomes escheatable, or 0 if they
    ///         are not currently frozen (not on the dormancy clock at all). Lets the
    ///         dashboard show a countdown. `block.timestamp >= this (and != 0)` ⇒
    ///         adminEscheat is callable.
    function escheatableAt(address merchant) external view returns (uint256) {
        Merchant storage m = merchants[merchant];
        if (!m.isFrozen || m.frozenAt == 0) return 0;
        return m.frozenAt + ESCHEAT_PERIOD;
    }

    /// @notice SUPER-ADMIN-ONLY, DORMANT-ACCOUNT ESCHEAT: withdraw the ENTIRE
    ///         remaining balance of a merchant who has been frozen CONTINUOUSLY for
    ///         at least ESCHEAT_PERIOD (90 days) to `to`. This exists so funds behind
    ///         a permanently-abandoned or indefinitely-blocked account are never lost
    ///         in the contract — after a long grace period, the super-admin can
    ///         recover them (e.g. to a treasury / the rightful party off-chain).
    ///
    ///         GUARANTEES / SAFETY:
    ///           • Gated on isFrozen AND (block.timestamp - frozenAt) >= 90 days. Any
    ///             unfreeze resets frozenAt, so a merchant only reaches this after a
    ///             genuinely continuous 90-day freeze — an unfreeze at any point
    ///             (e.g. the merchant returns / the block is lifted) cancels it.
    ///           • Moves ONLY this merchant's own funds: it sums and ZEROES this
    ///             merchant's buckets and decrements totalOwed by exactly that amount,
    ///             so the solvency invariant usdc.balanceOf(this) >= totalOwed is
    ///             preserved and no other merchant is touched.
    ///           • Buckets are zeroed BEFORE the external pull (CEI + nonReentrant),
    ///             so the balance can never be escheated twice.
    ///         This is a deliberate, audited exception to "funds move only by the
    ///         merchant's own action" — bounded by the 90-day continuous-freeze gate
    ///         and restricted to the single super-admin root.
    /// @param merchant The dormant (90-day frozen) merchant whose funds to recover.
    /// @param to       Destination for the recovered USDC (non-zero).
    function adminEscheat(address merchant, address to) external onlySuperAdmin nonReentrant {
        if (to == address(0)) revert InvalidAddress();
        Merchant storage m = merchants[merchant];
        // Must be frozen AND continuously so for the full window.
        if (!m.isFrozen || m.frozenAt == 0 || block.timestamp < m.frozenAt + ESCHEAT_PERIOD)
            revert NotEscheatable();

        // Sum the merchant's ENTIRE balance (locked + unlocked) and zero every
        // bucket, so the funds are accounted out exactly once.
        uint256 amount = 0;
        uint256 len = m.buckets.length;
        for (uint256 i = 0; i < len; i++) {
            amount += m.buckets[i].amount;
            m.buckets[i].amount = 0;
        }
        if (amount == 0) revert NothingToEscheat();
        _compact(m); // drop the now-zeroed buckets

        // Decrement the global owed by exactly what we removed (solvency preserved),
        // then transfer the funds out of custody to the chosen destination.
        totalOwed -= amount;
        _vaultPull(to, amount);

        emit MerchantEscheated(merchant, to, amount);
    }

    /// @notice SUPER-ADMIN-ONLY: withdraw USDC the contract holds ABOVE totalOwed.
    ///         Surplus accrues from sources no merchant is owed for — direct
    ///         donations, Diamond over-refunds, and remainders absorbed when a
    ///         recovery sweep pulls more off a proxy than that order's owedBack
    ///         (the min() cap). Without this the surplus is stuck forever.
    ///
    ///         SAFE BY CONSTRUCTION: the amount is exactly
    ///         `balanceOf(this) - totalOwed`, so after the transfer
    ///         `balanceOf(this) == totalOwed` — the solvency invariant cannot be
    ///         violated and merchant-owed funds cannot be touched, no matter when
    ///         or how often this is called. nonReentrant + computed-then-transfer
    ///         ordering keeps the read and the send atomic.
    /// @param to Destination for the surplus USDC (non-zero).
    function skimExcess(address to) external onlySuperAdmin nonReentrant {
        if (to == address(0)) revert InvalidAddress();
        uint256 pool = _pool();
        if (pool <= totalOwed) revert NothingToSkim();
        uint256 excess = pool - totalOwed;
        _vaultPull(to, excess);
        emit ExcessSkimmed(to, excess);
    }

    /// @notice BREAK-GLASS: halt all NEW activity (place order + every withdrawal).
    ///         Open to EVERY owner so the emergency stop is fast and never bottle-
    ///         necked on one key. This does NOT freeze existing custody or block
    ///         recovery: the Diamond completion/cancel callbacks, reconcileWithdrawal,
    ///         finalizeWithdrawal, deliverFiatPayout, and every admin recovery path
    ///         keep working, so an incident can be safely wound down while paused.
    function pause() external onlyOwner {
        if (paused) revert PauseUnchanged();
        paused = true;
        emit PausedSet(msg.sender);
    }

    /// @notice Lift the break-glass pause and resume normal activity. Any owner.
    function unpause() external onlyOwner {
        if (!paused) revert PauseUnchanged();
        paused = false;
        emit UnpausedSet(msg.sender);
    }

    /// @notice HIGH-2 admin recovery: claw a FROZEN merchant's in-flight, not-yet-
    ///         delivered fiat withdrawal back into the pool, independent of the
    ///         Diamond's order status. Only callable while the merchant is frozen
    ///         and only for a withdrawal whose fiat was never delivered
    ///         (upiDelivered == false) — so it can never reverse a real payout.
    ///         Sweeps the merchant's proxy USDC back, re-credits their principal
    ///         (locked again under a fresh settlement period so a frozen account
    ///         can't immediately re-extract), and frees the in-flight slot.
    function adminAbortWithdrawal(uint256 orderId) external onlyRole(Role.FINANCE) nonReentrant {
        PendingWithdrawal storage w = withdrawals[orderId];
        if (w.merchant == address(0)) revert UnknownWithdrawal();
        if (w.settled) revert WithdrawalAlreadySettled();
        if (w.upiDelivered) revert FiatAlreadyDelivered();
        Merchant storage m = merchants[w.merchant];
        if (!m.isFrozen) revert MerchantNotFrozen(); // only for frozen accounts

        // Pre-PAID only (upiDelivered==false guard above): the principal still
        // sits on the proxy, so this closes fully — settle AND release the slot.
        w.settled = true;
        _releaseSlot(w, m);

        address merchantProxy = _ensureProxy(w.merchant);
        uint256 proxyBal = usdc.balanceOf(merchantProxy);
        if (proxyBal > 0) {
            UserProxy(merchantProxy).transferERC20ToIntegrator(address(usdc), proxyBal);
            _toVault(proxyBal); // sweep proxy → integrator (custody)
        }
        // Make the merchant whole for principal + any fee advanced (capped by
        // the actual proxy refund, so still double-spend-safe).
        uint256 owedBack = w.amount + w.feeAdvanced;
        uint256 recredit = owedBack < proxyBal ? owedBack : proxyBal;
        // Re-lock under a fresh settlement window — a frozen merchant shouldn't
        // get instantly-available funds back; unfreeze + normal flow applies.
        _creditBucket(m, recredit, block.timestamp + _lockFor(m));

        emit WithdrawalReconciled(w.merchant, orderId, recredit);
    }

    /// @notice FINAL-AUDIT fix (disputed-clawback channel-brick): an owner-gated
    ///         recovery for an in-flight withdrawal that NO other settle path can
    ///         close — specifically a PAID→disputed→CANCELLED order, where
    ///         reconcileWithdrawal refuses the dispute, finalizeWithdrawal needs
    ///         COMPLETED, and adminAbortWithdrawal refuses upiDelivered. Without
    ///         this, inFlightWithdrawals stays stuck (bricking the merchant's
    ///         whole fiat channel) and the Diamond's proxy refund is stranded.
    ///
    ///         Double-spend safety is structural and unconditional: we re-credit
    ///         ONLY what is physically refunded to the proxy. If fiat actually
    ///         reached the merchant, the Diamond did not refund the proxy, so
    ///         proxyBal ≈ 0 and recredit ≈ 0. Owner-gated and requires the
    ///         Diamond status to be CANCELLED (a real clawback), so it cannot be
    ///         used to reverse a COMPLETED payout.
    function adminForceSettle(uint256 orderId) external onlyRole(Role.FINANCE) nonReentrant {
        PendingWithdrawal storage w = withdrawals[orderId];
        if (w.merchant == address(0)) revert UnknownWithdrawal();
        if (w.settled) revert WithdrawalAlreadySettled();

        // Only for orders the Diamond clawed back — never a completed payout.
        uint8 status = IOrderFlow(diamond).getOrdersById(orderId).status;
        if (status != STATUS_CANCELLED) revert WithdrawalNotCancellable();

        w.settled = true;
        Merchant storage m = merchants[w.merchant];
        _releaseSlot(w, m); // idempotent — may already be freed by adminForceUnwedge

        address merchantProxy = _ensureProxy(w.merchant);
        uint256 proxyBal = usdc.balanceOf(merchantProxy);
        if (proxyBal > 0) {
            UserProxy(merchantProxy).transferERC20ToIntegrator(address(usdc), proxyBal);
            _toVault(proxyBal); // sweep proxy → integrator (custody)
        }
        // Make whole for principal + fee, capped by the physical refund.
        uint256 owedBack = w.amount + w.feeAdvanced;
        uint256 recredit = owedBack < proxyBal ? owedBack : proxyBal;
        // Re-lock under a fresh settlement window (the order had reached PAID).
        _creditBucket(m, recredit, block.timestamp + _lockFor(m));

        emit WithdrawalReconciled(w.merchant, orderId, recredit);
    }

    /// @notice AUDIT FIX #9 / #10 — RECOVER a wedged in-flight SELL whose refund has
    ///         landed on the proxy. A SELL that reached PAID (upiDelivered==true) but
    ///         that the Diamond NEVER terminalises (neither COMPLETED nor CANCELLED —
    ///         e.g. an LP that vanishes mid-flight) can be closed by NO status-gated
    ///         path: finalizeWithdrawal needs COMPLETED, reconcile/adminForceSettle
    ///         need CANCELLED, adminAbortWithdrawal refuses upiDelivered.
    ///
    ///         This call sweeps whatever the proxy holds and re-credits it (capped by
    ///         the physical balance — the structural double-spend guard). It then
    ///         FINALISES (settles + frees the slot) ONLY when the FULL refund has
    ///         landed (recredit >= owedBack): the order is genuinely done. If the
    ///         refund has NOT fully arrived yet (proxyBal < owedBack; e.g. still
    ///         escrowed on the Diamond), it does NOT settle and does NOT free the slot
    ///         — leaving reconcile/adminForceSettle able to recover the eventual
    ///         PAID→CANCELLED refund without a NEW withdrawal's principal being
    ///         mis-swept off the shared proxy (AUDIT FIX #10: never strand a late
    ///         refund, never mis-attribute across orders).
    ///
    ///         IMPORTANT: because this does NOT free the slot when no refund landed,
    ///         it CANNOT by itself un-brick a channel wedged by an order the Diamond
    ///         will never refund (proxyBal stays 0 forever). For that operator-
    ///         confirmed never-refund case use `adminForceAbandonWedge`, which
    ///         unconditionally frees the channel. This split keeps the double-spend/
    ///         cross-order guarantees here while guaranteeing the channel is ALWAYS
    ///         admin-recoverable there. (AUDIT FIX #11: FIX #10 had gated the slot
    ///         free on a landed refund, which reintroduced the very brick FIX #9
    ///         removed for the proxyBal==0 wedge — the abandon path restores it.)
    ///
    ///         Gated on the merchant being FROZEN (incident tool). Re-locked under a
    ///         fresh settlement window so a frozen account never gets instantly-
    ///         spendable funds back.
    function adminForceUnwedge(uint256 orderId) external onlyRole(Role.FINANCE) nonReentrant {
        PendingWithdrawal storage w = withdrawals[orderId];
        if (w.merchant == address(0)) revert UnknownWithdrawal();
        if (w.settled) revert WithdrawalAlreadySettled();
        Merchant storage m = merchants[w.merchant];
        // Frozen-only, like adminAbortWithdrawal — the safety gate that makes this
        // an incident tool, not a routine one. Unlike adminAbort, it does NOT
        // refuse upiDelivered: the whole point is to close a PAID-but-never-
        // terminalised order that adminAbort cannot touch.
        if (!m.isFrozen) revert MerchantNotFrozen();

        address merchantProxy = _ensureProxy(w.merchant);
        uint256 proxyBal = usdc.balanceOf(merchantProxy);
        if (proxyBal > 0) {
            UserProxy(merchantProxy).transferERC20ToIntegrator(address(usdc), proxyBal);
            _toVault(proxyBal); // sweep proxy → integrator (custody)
        }
        // Structural double-spend guard: re-credit only what was physically
        // refunded to the proxy (fiat delivered → no refund → recredit ≈ 0).
        uint256 owedBack = w.amount + w.feeAdvanced;
        uint256 recredit = owedBack < proxyBal ? owedBack : proxyBal;
        _creditBucket(m, recredit, block.timestamp + _lockFor(m));

        // AUDIT FIX #10: only finalise (settle + free the slot) when the FULL refund
        // has already landed and been re-credited — then nothing more is owed back
        // and the order is genuinely done. If the refund hasn't fully arrived yet
        // (proxyBal < owedBack; classically proxyBal==0 because the order is still
        // escrowed on the Diamond), we DO NOT settle and DO NOT free the slot:
        //   • Not settling leaves reconcileWithdrawal / adminForceSettle able to
        //     sweep and re-credit the eventual PAID→CANCELLED refund later, so the
        //     merchant's principal+fee is never permanently stranded (the bug this
        //     fixes). Previously this always settled, sealing off that recovery.
        //   • Not freeing the slot KEEPS the channel serialized on this one order.
        //     Freeing it early would let the merchant place a NEW withdrawal that
        //     funds the SAME proxy, and a later recovery on THIS order would then
        //     sweep the new order's principal too (cross-order mis-attribution).
        //     Keeping the one-in-flight invariant makes each recovery sweep attribute
        //     the proxy balance to exactly one order. The channel un-wedges the
        //     moment the refund lands and a recovery path settles this order.
        // So: the "wedge" is fully cleared for a landed refund; for a not-yet-landed
        // refund the order stays open and safely recoverable rather than sealed.
        if (recredit >= owedBack) {
            w.settled = true;
            _releaseSlot(w, m);
        }

        emit WithdrawalReconciled(w.merchant, orderId, recredit);
    }

    /// @notice AUDIT FIX #11 — GUARANTEED channel un-brick for a wedged SELL the
    ///         Diamond will NEVER refund. adminForceUnwedge deliberately does NOT
    ///         free the slot when no refund has landed (so a late refund stays
    ///         recoverable and can't be mis-attributed). But if the operator has
    ///         CONFIRMED the order is dead — a PAID SELL the Diamond leaves non-
    ///         terminal forever AND never refunds the proxy (proxyBal stays 0) —
    ///         that leaves inFlightWithdrawals stuck at 1 and the merchant's entire
    ///         fiat-withdraw channel permanently bricked, which no other path can
    ///         clear (finalize needs COMPLETED, reconcile/adminForceSettle need
    ///         CANCELLED, adminAbort refuses upiDelivered, unwedge won't free without
    ///         a refund). This is the explicit escape: it UNCONDITIONALLY settles the
    ///         order and frees the slot, un-bricking the channel regardless of Diamond
    ///         status — restoring FIX #9's original guarantee that an admin can always
    ///         recover a wedged channel.
    ///
    ///         SAFETY: same structural double-spend guard — it re-credits ONLY what is
    ///         physically on the proxy right now (min(owedBack, proxyBal)); if fiat
    ///         actually reached the merchant, the Diamond did not refund the proxy so
    ///         proxyBal ≈ 0 → recredit ≈ 0, and the merchant cannot reclaim USDC they
    ///         already converted to fiat. Because it SETTLES the order, this is a
    ///         deliberate one-way "abandon": if a refund somehow arrives AFTER, it is
    ///         not auto-recovered (the operator accepted that when abandoning) — but no
    ///         cross-order mis-attribution is possible (the order is closed, so no later
    ///         recovery sweep runs against the shared proxy). FROZEN-gated + FINANCE-
    ///         gated, like the other incident tools; re-locked under a fresh window.
    function adminForceAbandonWedge(uint256 orderId) external onlyRole(Role.FINANCE) nonReentrant {
        PendingWithdrawal storage w = withdrawals[orderId];
        if (w.merchant == address(0)) revert UnknownWithdrawal();
        if (w.settled) revert WithdrawalAlreadySettled();
        Merchant storage m = merchants[w.merchant];
        if (!m.isFrozen) revert MerchantNotFrozen();

        // Unconditionally close the order and free the channel — this is the whole
        // point (guarantee an admin can always un-brick a dead wedge).
        w.settled = true;
        _releaseSlot(w, m);

        address merchantProxy = _ensureProxy(w.merchant);
        uint256 proxyBal = usdc.balanceOf(merchantProxy);
        if (proxyBal > 0) {
            UserProxy(merchantProxy).transferERC20ToIntegrator(address(usdc), proxyBal);
            _toVault(proxyBal); // sweep proxy → integrator (custody)
        }
        // Structural double-spend guard: re-credit only what's physically on the
        // proxy now (fiat delivered → no refund → recredit ≈ 0).
        uint256 owedBack = w.amount + w.feeAdvanced;
        uint256 recredit = owedBack < proxyBal ? owedBack : proxyBal;
        _creditBucket(m, recredit, block.timestamp + _lockFor(m));

        emit WithdrawalReconciled(w.merchant, orderId, recredit);
    }

    // ─── Views ────────────────────────────────────────────────────────

    /// @notice Balances derived from buckets at the current timestamp —
    ///         `pending` counts only still-locked buckets, `available` only
    ///         unlocked ones.
    function getMerchantBalance(
        address merchant
    )
        external
        view
        returns (uint256 pending, uint256 available, uint256 totalDeposited, bool isFrozen)
    {
        Merchant storage m = merchants[merchant];
        uint256 len = m.buckets.length;
        for (uint256 i = 0; i < len; i++) {
            if (m.buckets[i].unlockTimestamp < block.timestamp) {
                available += m.buckets[i].amount;
            } else {
                pending += m.buckets[i].amount;
            }
        }
        return (pending, available, m.totalDeposited, m.isFrozen);
    }

    /// @notice The public `merchants` auto-getter omits the buckets array —
    ///         this exposes it for tests and the dashboard.
    function getMerchantBuckets(
        address merchant
    ) external view returns (SettlementBucket[] memory) {
        return merchants[merchant].buckets;
    }

    /// @notice On-chain merchant profile, so the UI needs no off-chain store.
    ///         Returns the ENCRYPTED payout handle (opaque ciphertext — only the
    ///         merchant/LP can decrypt it; the raw handle is never on-chain in the
    ///         clear), shop name, offramp currency, registration + freeze status.
    function getMerchantInfo(
        address merchant
    )
        external
        view
        returns (
            bytes memory encPayoutId,
            string memory shopName,
            bytes32 currency,
            bool isRegistered,
            bool isFrozen
        )
    {
        Merchant storage m = merchants[merchant];
        return (m.encPayoutId, m.shopName, m.currency, registered[merchant], m.isFrozen);
    }

    function getDailyTxInfo(
        address merchant
    ) external view returns (uint256 usedToday, uint256 limit) {
        Merchant storage m = merchants[merchant];
        uint256 today = block.timestamp / 86400;
        usedToday = m.lastTxDate == today ? m.dailyTxCount : 0;
        return (usedToday, dailyLimit);
    }

    /// @notice The merchant's offramp currency as a readable code ("INR",
    ///         "BRL", …) — so the UI never has to decode a bytes32.
    function getMerchantCurrency(address merchant) external view returns (string memory) {
        return fromCurrency(merchants[merchant].currency);
    }

    // ─── Proxy helpers (mirror ExampleIntegrator exactly) ─────────────

    /// @notice Predicts the deterministic UserProxy address for `user`.
    ///         The clone may not yet be deployed — check `code.length` if
    ///         you need to know.
    function proxyAddress(address user) public view returns (address) {
        return
            Clones.predictDeterministicAddressWithImmutableArgs(
                proxyImpl,
                _proxyArgs(user),
                _salt(user),
                address(this)
            );
    }

    /// @dev Salt is the user EOA only. The "deployer" component of the
    ///      CREATE2 address derivation is the integrator (this contract),
    ///      so a (integrator, user) pair maps to exactly one proxy address.
    function _salt(address user) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(user)));
    }

    /// @dev Immutable args layout: [owner(20)][integrator(20)] — 40 bytes.
    ///      UserProxy.owner() and UserProxy.integrator() read these slots
    ///      via `Clones.fetchCloneArgs(address(this))`. The Diamond's
    ///      CREATE2-auth path reconstructs the same args from the registered
    ///      proxyImpl + user salt, so DO NOT change the layout.
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
            // Record proxy => owner so validateOrder can recognize a SELL
            // placed by one of our own merchant proxies.
            proxyMerchant[proxy] = user;
            emit UserProxyDeployed(user, proxy);
        }
    }
}
