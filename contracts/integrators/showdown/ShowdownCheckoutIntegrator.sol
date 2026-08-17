// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { IOrderFlow } from "../../interfaces/IOrderFlow.sol";
import { ITokenMessengerV2, IMessageTransmitterV2 } from "../../interfaces/ICctpV2.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

/**
 * @title ShowdownCheckoutIntegrator
 * @notice A P2P integrator for Showdown: a two-way fiat <-> USDC ramp whose
 *         user-facing asset lives on SOLANA, bridged with Circle's Cross-Chain
 *         Transfer Protocol V2 (CCTP).
 *
 *           1. Onramp  (fiat -> USDC on Solana): the user pays fiat on the P2P
 *              network; the Diamond delivers the purchased USDC to THIS
 *              contract (recipientAddr = address(this)); `onOrderComplete` then
 *              burns it via CCTP and authorizes an equivalent mint to the
 *              user's Solana USDC account. The final product the user holds is
 *              native USDC on Solana.
 *
 *           2. Offramp (USDC on Solana -> fiat): the user burns USDC on Solana
 *              with CCTP, naming their Base-side `UserProxy` as the
 *              `mintRecipient`. Once minted there, they place a SELL on the
 *              Diamond funded from that proxy balance, and receive fiat.
 *
 *         Both directions are gated by tiered simple-kyc attestations, since
 *         both convert between fiat and USDC the user actually controls. The
 *         per-tx cap is a function of the KYC tier AND the settlement region:
 *
 *           | tier                  | India (INR) | Abroad |
 *           |-----------------------|-------------|--------|
 *           | 0 — none              |     blocked | blocked|
 *           | 1 — liveness          |         $20 |    $50 |
 *           | 2 — passport+liveness |        $100 |   $200 |
 *
 *         The effective cap is `min(attested limit, tierCap[tier][region])`: the
 *         simple-kyc service signs a dollar limit into the attestation, and this
 *         contract additionally clamps it to an on-chain per-(tier, region)
 *         ceiling. A compromised attestor key therefore cannot authorize more
 *         than the tier allows.
 *
 *         Those four numbers, plus the 5-orders-per-day count, are also fixed in
 *         the bytecode as `MAX_*` constants. `setTierCap` /
 *         `setDailyTxCountLimit` can only ever move a limit DOWN from its
 *         ceiling — so the policy holds against a malicious or compromised
 *         owner, not merely against a bad attestor. This matters because a
 *         whitelisted integrator bypasses the protocol's own RP / daily /
 *         monthly / yearly volume limits and is trusted to enforce its own in
 *         `validateOrder` (see `IB2BGateway`).
 *
 *         REGION IS DERIVED FROM THE ORDER'S FIAT CURRENCY, not from the user's
 *         location: `INR` settles on an Indian rail and takes the India column;
 *         every other currency takes the Abroad column. The user picks the
 *         currency, so the real constraint is which fiat rail they can actually
 *         settle on — this is a payment-rail gate, not a nationality gate. If a
 *         nationality gate is ever needed it belongs in the attestation.
 *
 *         The owner can additionally `setUserBlocked` a wallet, which zeroes its
 *         effective limit in both directions. That is a binary gate only —
 *         limits themselves come solely from the KYC tier and the region
 *         ceiling, never from a per-user owner setting. A blocked user can still
 *         reach `userBridgeBackToSolana` and `userRescueStuckBridge`, so a block
 *         never traps funds the user already paid for.
 *
 * @dev SINGLE-TOKEN MODEL. `usdc` is simultaneously (a) the token the Diamond
 *      settles in and (b) the token CCTP burns. These coincide on Base mainnet,
 *      where the Diamond settles in Circle USDC. They do NOT coincide on Base
 *      Sepolia, whose Diamond settles in a mock token (GoofyGoober) that
 *      Circle's TokenMinter will not burn — there, every bridge attempt fails
 *      closed, leaving the order fulfilled-but-unbridged (`session.bridged ==
 *      false`, its USDC reserved in `unbridgedTotal`) and recoverable. See
 *      `_bridge` / `retryBridge` / `userRescueStuckBridge`.
 *
 *      SOLANA RECIPIENTS ARE TOKEN ACCOUNTS. `solanaRecipient` must be the
 *      user's USDC *associated token account* (ATA), not their wallet address,
 *      and it must already exist on Solana. A wallet address here produces a
 *      burn on Base whose mint can never be executed on Solana.
 *
 *      Register on the Diamond with `usdcThroughIntegrator = FALSE`: the onramp
 *      pins `recipientAddr = address(this)`, so completion already routes the
 *      purchased USDC here without the flag; the offramp SELL pulls USDC from
 *      `order.user` (the seller's own proxy) at `setSellOrderUpi` and never
 *      routes completion USDC back through the integrator.
 */
contract ShowdownCheckoutIntegrator is IP2PIntegrator {
    using SafeERC20 for IERC20;
    using Clones for address;

    // ─── Errors ───────────────────────────────────────────────────────

    error OnlyDiamond();
    error OnlyOwner();
    error OnlySelf();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidTier();
    error InvalidRegion();
    error OrderAlreadyFulfilled();
    error OrderAlreadyCancelled();
    error Reentrancy();

    /// @notice A limit was set above its immutable `MAX_*` policy ceiling.
    error CapExceedsCeiling();

    // KYC / attestation
    error AttestorNotSet();
    error AttestationExpired();
    error NullifierAlreadySpent();
    error InvalidSignature();
    error NotKycVerified();
    error KycLimitExceeded();
    error UserIsBlocked();

    // Bridge
    error InvalidSolanaRecipient();
    error UnknownOrder();
    error OrderNotFulfilled();
    error AlreadyBridged();
    error RescueTooEarly();
    error NotOrderOwner();
    error WithdrawExceedsSurplus();
    error UnexpectedRecipient();

    // Offramp
    error OfframpDisabled();
    error OfframpNotAuthorized();
    error OfframpRecordNotFound();
    error OfframpAlreadyReconciled();
    /// @notice The Diamond's authoritative `actualUsdtAmount` is unusable: zero,
    ///         or below the principal this contract escrowed at placement. Either
    ///         means a re-price, a partial fill or a fee-model change — surface it
    ///         rather than pulling an amount nobody agreed to. (#72)
    error OfframpFeeNotReady();
    /// @notice The order is not in ACCEPTED, so there is no matched merchant to
    ///         deliver to. (#72)
    error OfframpNotDeliverable();
    /// @notice `minFinalityThreshold` must be 1000 (Fast) or 2000 (Standard). (#75)
    error InvalidFinalityThreshold();
    error InsufficientBridgedFunds();

    // ─── Events ───────────────────────────────────────────────────────

    event LivenessAttestorUpdated(address indexed attestor);
    event KycAttestorUpdated(address indexed attestor);
    /// @param region 0 = India (INR), 1 = Abroad (every other currency).
    event TierCapUpdated(uint8 indexed tier, uint8 indexed region, uint256 cap);
    event DailyTxCountLimitUpdated(uint256 count);
    event UserBlockedUpdated(address indexed user, bool isBlocked);
    event OfframpEnabledUpdated(bool enabled);
    event BridgeMaxFeeBpsUpdated(uint256 bps);
    event BridgeFinalityThresholdUpdated(uint32 threshold);
    event UsdcWithdrawn(address indexed to, uint256 amount);
    /// @notice A user pulled bridged-in USDC off their own proxy to their own
    ///         wallet without using CCTP. (#74)
    event ProxyUsdcRescued(address indexed user, uint256 amount);
    event UserProxyDeployed(address indexed user, address proxy);

    /// @param tier 1 = liveness, 2 = passport + liveness (KYC)
    event KycClaimed(
        address indexed user,
        uint8 indexed tier,
        bytes32 indexed nullifier,
        uint256 attestedLimit,
        uint256 grantedLimit
    );

    // Onramp
    event OnrampOrderCreated(
        uint256 indexed orderId,
        address indexed user,
        uint256 amount,
        bytes32 currency,
        bytes32 solanaRecipient
    );
    event OnrampOrderFulfilled(uint256 indexed orderId, address indexed user, uint256 amount);
    /// @notice The Diamond delivered an amount other than the one placed. The
    ///         session is re-pinned to what actually arrived — see
    ///         `onOrderComplete`. Should never fire; alert if it does.
    event OnrampAmountAdjusted(uint256 indexed orderId, uint256 placed, uint256 delivered);

    /// @notice A cancelled order was subsequently completed by the gateway: the
    ///         delivered USDC was settled normally and the daily slot released
    ///         by onOrderCancel was re-charged. Alert + audit trail — this
    ///         sequence should be rare (admin CANCELLED -> re-open -> COMPLETE).
    event CancelledOrderCompleted(uint256 indexed orderId, address indexed user);
    event BridgedToSolana(
        uint256 indexed orderId,
        address indexed user,
        uint256 amount,
        bytes32 solanaRecipient,
        uint256 maxFee
    );
    event BridgeFailed(uint256 indexed orderId, bytes reason);
    event BridgeRescued(uint256 indexed orderId, address indexed user, uint256 amount);
    event BridgedBackToSolana(
        address indexed user,
        uint256 amount,
        bytes32 solanaRecipient,
        uint256 maxFee
    );

    // Offramp
    event OfframpInitiated(
        uint256 indexed orderId,
        address indexed user,
        uint256 usdcAmount,
        address proxy
    );
    event OfframpUpiDelivered(uint256 indexed orderId, uint256 usdcPulled);
    /// @notice `setSellOrderUpi` returned success but the Diamond auto-cancelled
    ///         instead of pulling (its failed-pull branch cancels and returns).
    ///         Nothing was paid; the principal is still on the seller's proxy. (#71)
    event OfframpDeliveryAutoCancelled(uint256 indexed orderId, uint8 status);
    event OfframpReconciled(uint256 indexed orderId, uint8 status);

    // ─── Tier / region constants ──────────────────────────────────────

    uint8 public constant TIER_NONE = 0;
    uint8 public constant TIER_LIVENESS = 1;
    uint8 public constant TIER_KYC = 2;

    /// @notice Settlement region, derived from the order's fiat currency.
    uint8 public constant REGION_INDIA = 0;
    uint8 public constant REGION_ABROAD = 1;

    /// @notice The fiat currency that settles on an Indian rail. Any other
    ///         currency is treated as Abroad. `bytes32("INR")` is the same
    ///         right-padded encoding the Diamond and the widget use.
    bytes32 public constant INDIA_CURRENCY = bytes32("INR");

    // ─── Immutable policy ceilings ────────────────────────────────────
    //
    // Fixed in the bytecode, so they are auditable without reading storage and
    // cannot be moved by anyone — owner included. `setTierCap` and
    // `setDailyTxCountLimit` may only ever set a value at or below these.

    /// @notice Liveness tier, India (INR) — $20 per tx.
    uint256 public constant MAX_TIER_CAP_LIVENESS_INDIA = 20e6;
    /// @notice Liveness tier, abroad — $50 per tx.
    uint256 public constant MAX_TIER_CAP_LIVENESS_ABROAD = 50e6;
    /// @notice Passport + liveness tier, India (INR) — $100 per tx.
    uint256 public constant MAX_TIER_CAP_KYC_INDIA = 100e6;
    /// @notice Passport + liveness tier, abroad — $200 per tx.
    uint256 public constant MAX_TIER_CAP_KYC_ABROAD = 200e6;
    /// @notice Max orders per user per UTC day, applied to each direction
    ///         independently (see `dailyTxCountLimit`).
    uint256 public constant MAX_DAILY_TX_COUNT_LIMIT = 5;
    /// @notice Ceiling on the CCTP attestation fee the owner may agree to pay,
    ///         as bps of the burn. Circle's Fast Transfer fee has run ~1-14 bps;
    ///         1% is ample headroom. A burn that fails on fee grounds is
    ///         fail-closed and retryable, never a loss.
    uint256 public constant MAX_BRIDGE_MAX_FEE_BPS = 100;

    /// @notice How long an onramp's USDC must sit unbridged before the buyer
    ///         may pull it back to their own wallet. Only reachable when CCTP
    ///         has refused the burn for this long (e.g. the burn token isn't
    ///         Circle USDC, or the messenger is paused) — the happy path bridges
    ///         inside `onOrderComplete`.
    uint256 public constant BRIDGE_RESCUE_DELAY = 7 days;

    // ─── EIP-712 constants ────────────────────────────────────────────

    /// @dev keccak256("KycAttestation(address wallet,bytes32 nullifier,uint256 limit,uint256 expiry)")
    bytes32 private constant _KYC_TYPEHASH =
        keccak256("KycAttestation(address wallet,bytes32 nullifier,uint256 limit,uint256 expiry)");
    /// @dev keccak256("LivenessAttestation(address wallet,bytes32 nullifier,uint256 limit,uint256 expiry)")
    bytes32 private constant _LIVENESS_TYPEHASH =
        keccak256(
            "LivenessAttestation(address wallet,bytes32 nullifier,uint256 limit,uint256 expiry)"
        );
    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
    bytes32 private constant _KYC_DOMAIN_NAME = keccak256(bytes("KycVerifier"));
    bytes32 private constant _LIVENESS_DOMAIN_NAME = keccak256(bytes("LivenessVerifier"));
    bytes32 private constant _DOMAIN_VERSION = keccak256(bytes("1"));

    // ─── Immutables ───────────────────────────────────────────────────

    address public immutable diamond;
    IERC20 public immutable usdc;
    address public immutable owner;
    /// @notice The UserProxy implementation that all clones delegate to.
    address public immutable proxyImpl;
    /// @notice Circle CCTP V2 TokenMessengerV2 (burn side).
    ITokenMessengerV2 public immutable tokenMessenger;
    /// @notice Circle CCTP V2 MessageTransmitterV2 (mint side).
    IMessageTransmitterV2 public immutable messageTransmitter;
    /// @notice CCTP domain of the chain the user's USDC lives on. Solana = 5.
    uint32 public immutable solanaDomain;

    // ─── Attestation config ───────────────────────────────────────────

    /// @notice secp256k1 signer of the liveness service's attestations.
    address public livenessAttestor;
    /// @notice secp256k1 signer of the KYC (passport+liveness) service's attestations.
    address public kycAttestor;

    // ─── Configurable limits ──────────────────────────────────────────

    /// @notice On-chain per-tx ceiling, keyed `tierCap[tier][region]`
    ///         (micro-USDC, 6dp). Set at deploy, owner-lowerable, and hard
    ///         bounded by the matching `MAX_TIER_CAP_*` constant. A cell set to
    ///         0 disables that (tier, region) without touching any attestation
    ///         — the kill switch for one lane.
    mapping(uint8 => mapping(uint8 => uint256)) public tierCap;

    /// @notice Max orders a user may place per UTC day, applied SEPARATELY to
    ///         each direction: `dailyTxCountLimit` onramp BUYs and, independently,
    ///         `dailyTxCountLimit` offramp SELLs. Must be 1..`MAX_DAILY_TX_COUNT_LIMIT`;
    ///         0 (previously "unlimited") is rejected.
    /// @dev    In practice this bounds PLACEMENTS per day, not settled orders:
    ///         the live Diamond never calls `onOrderCancel` (the selector is
    ///         absent from every mainnet facet), so a cancelled or expired order
    ///         keeps its slot. Safe direction — a slot can never be freed early,
    ///         so the cap cannot be exceeded — but a user whose orders keep
    ///         failing is locked out until the next UTC day (00:00 UTC =
    ///         05:30 IST).
    uint256 public dailyTxCountLimit;

    /// @notice Wallets the owner has blocked. A binary gate: it zeroes the
    ///         effective limit in both directions and nothing else. Limits are
    ///         never set per-user — they come solely from the KYC tier and the
    ///         region ceiling.
    /// @dev    Deliberately does NOT gate `userBridgeBackToSolana` or
    ///         `userRescueStuckBridge`: those move only the user's own funds
    ///         back out, so a block never strands money.
    mapping(address => bool) public blocked;

    // ─── Offramp config ───────────────────────────────────────────────

    /// @notice Master switch for the offramp flow. Defaults ON at deploy.
    bool public offrampEnabled;
    // NOTE (#53.2, decided 2026-08-13): there is deliberately NO `offrampRelayer`.
    // An earlier revision let an owner-set relayer call `deliverOfframpUpi` for
    // someone else's order. That is not a relay — `encUpi` IS the fiat payout
    // target, `placeB2BSellOrder` leaves `order.encUpi` empty, and the Diamond's
    // substitution guard accepts any string into an empty slot, so a relayer
    // could redirect ANY seller's payout to itself (first writer wins; the order
    // then moves to PAID and every health metric still reads clean).
    //
    // Binding it with a user EIP-712 signature over keccak256(encUpi) was
    // considered and rejected as illusory: `encUpi` is encrypted to the MATCHED
    // MERCHANT, who is unknown until after the accept, so the user cannot
    // pre-sign the destination at placement. By the time they can sign it they
    // are online and can simply call `deliverOfframpUpi` themselves.
    //
    // Showdown's client encrypts `encUpi` locally, so a relayer buys no
    // capability the user does not already have. Delivery is initiator-only.

    // ─── Bridge config ────────────────────────────────────────────────

    /// @notice `maxFee` passed to `depositForBurn`, as bps of the burn amount.
    ///         0 = pay no attestation fee (valid while the messenger's `minFee`
    ///         is 0, which is the case on Base Sepolia today). Raise this if
    ///         Circle starts enforcing a minimum fee, or when using Fast
    ///         Transfers, which do charge.
    uint256 public bridgeMaxFeeBps;
    /// @notice The only two `minFinalityThreshold` values CCTP V2 defines.
    uint32 public constant FINALITY_FAST = 1000;
    uint32 public constant FINALITY_STANDARD = 2000;
    /// @notice `minFinalityThreshold` passed to `depositForBurn`.
    ///         2000 = Standard Transfer (finalized, free, ~13-19 min from Base).
    ///         1000 = Fast Transfer (confirmed, seconds, charges up to maxFee).
    uint32 public bridgeMinFinalityThreshold;

    // ─── Per-user entitlement ─────────────────────────────────────────

    /// @notice Per-tx USDC ceiling attested by the simple-kyc service, keyed
    ///         `grantedLimit[user][tier]`. The effective cap reads the CURRENT
    ///         tier's own attested limit, clamped by
    ///         `tierCap[userTier[user]][regionFor(currency)]`.
    /// @dev    Per-tier (not one shared scalar) so a per-user AML sub-cap the
    ///         service signs at one tier cannot be inflated by a higher limit
    ///         attested at a different tier/service. See #45. ABI note: the
    ///         auto-getter is now `grantedLimit(address,uint8)`.
    ///
    ///         ⚠️ A signed DOWNGRADE is advisory, not binding. The digest binds
    ///         `wallet = msg.sender`, so the service cannot push one onto a
    ///         flagged user — they simply never claim it. And the replay guard is
    ///         per-nullifier, not per-user, so any OTHER unexpired higher-limit
    ///         attestation re-raises the cap after a downgrade is claimed.
    ///         `setUserBlocked` is the only lever that binds a flagged user.
    ///         Exposure meanwhile is bounded by the immutable tier ceilings and
    ///         the daily count.
    mapping(address => mapping(uint8 => uint256)) public grantedLimit;
    /// @notice Highest KYC tier the user has claimed (see TIER_* constants).
    mapping(address => uint8) public userTier;
    /// @notice Per-(tenant, human) nullifier sets, namespaced by service so a
    ///         liveness and a KYC nullifier can never collide.
    mapping(bytes32 => bool) public livenessNullifierSpent;
    mapping(bytes32 => bool) public kycNullifierSpent;

    // ─── Accounting ───────────────────────────────────────────────────

    /// @notice user => UTC day => onramp BUY orders placed that day.
    mapping(address => mapping(uint256 => uint256)) public userDailyCount;
    /// @notice user => UTC day => offramp SELL orders placed that day. Counted
    ///         separately from the onramp so each direction gets its own
    ///         `dailyTxCountLimit` budget.
    mapping(address => mapping(uint256 => uint256)) public userDailyOfframpCount;

    /// @notice proxy address => the user it belongs to. Lets `validateOrder`
    ///         tell an offramp SELL (placed with `order.user` = the seller's
    ///         proxy) apart from an onramp BUY (placed with the user's EOA).
    mapping(address => address) public proxyOwner;

    /// @notice USDC delivered by the Diamond for onramps that have not yet been
    ///         burned to Solana. Bounds `withdrawUsdc` so the owner can only
    ///         ever sweep genuine surplus, never a buyer's in-flight funds.
    uint256 public unbridgedTotal;

    struct Session {
        address user; // 20 bytes
        bool fulfilled; //  1 byte — Diamond completed + USDC delivered here
        bool bridged; //  1 byte — burned to Solana via CCTP
        bool cancelled; //  1 byte
        bool rescued; //  1 byte — pulled back to the buyer after the delay
        uint32 placementDay; //  4 bytes — pinned for onOrderCancel decrement keying
        uint32 completedAt; //  4 bytes — starts the rescue clock (== 32 bytes)
        uint256 amount;
        bytes32 solanaRecipient; // USDC ATA on Solana, pinned at order time
    }

    /// @notice Onramp BUY sessions, keyed by Diamond orderId.
    mapping(uint256 => Session) public sessions;

    struct OfframpRecord {
        address user; // the seller, whose proxy funds the order
        uint256 usdcAmount; // principal placed (excludes fee)
        uint8 lastStatus; // last reconciled Diamond status (3=COMPLETED,4=CANCELLED)
        bool initialized;
        uint32 placementDay; // UTC day the SELL slot was consumed, for release keying (#51)
    }

    /// @notice Offramp records, keyed by Diamond orderId.
    mapping(uint256 => OfframpRecord) public offramps;
    /// @notice orderId => the address that initiated the offramp (may deliver UPI).
    mapping(uint256 => address) public orderInitiator;
    /// @notice Sum of a user's placed-but-not-yet-terminal SELL principals. A
    ///         reservation, not a lock: `userInitiateOfframp` requires the proxy
    ///         balance to cover `pending + new amount`, so N SELLs can't be
    ///         over-committed against one balance (only one would ever settle).
    ///         Released on terminal `reconcile`. (#51 / #44 over-commit half)
    mapping(address => uint256) public pendingOfframpTotal;

    // ─── Modifiers ────────────────────────────────────────────────────

    /// @dev Transient storage (EIP-1153), matching `UserProxy`. Auto-clears at
    ///      end-of-tx. Guards the user-facing value-moving entrypoints only —
    ///      NOT `validateOrder` (the Diamond calls it back inside
    ///      `userBuyUsdcToSolana` / `userInitiateOfframp`) and NOT
    ///      `onOrderComplete` / `selfBridge` (which self-call by design).
    bool private transient _entered;

    modifier nonReentrant() {
        if (_entered) revert Reentrancy();
        _entered = true;
        _;
        _entered = false;
    }

    modifier onlyDiamond() {
        if (msg.sender != diamond) revert OnlyDiamond();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────

    /**
     * @param _diamond            P2P Diamond (B2B gateway) address.
     * @param _usdc               Settlement + burn token. MUST be the token the
     *                            Diamond settles in; CCTP burns will only
     *                            succeed if it is also Circle-issued USDC.
     * @param _tokenMessenger     CCTP V2 TokenMessengerV2.
     * @param _messageTransmitter CCTP V2 MessageTransmitterV2.
     * @param _solanaDomain       CCTP domain of the user-facing chain (Solana = 5).
     * @param _dailyTxCountLimit  Orders per user per UTC day, applied to each
     *                            direction independently. 1..5; 0 is rejected.
     * @param _livenessAttestor   Liveness service signer (may be 0, set later).
     * @param _kycAttestor        KYC service signer (may be 0, set later).
     * @param _livenessCapIndia   Liveness cap for INR orders   (<= $20).
     * @param _livenessCapAbroad  Liveness cap for other fiat   (<= $50).
     * @param _kycCapIndia        Passport cap for INR orders   (<= $100).
     * @param _kycCapAbroad       Passport cap for other fiat   (<= $200).
     *
     * @dev Every cap is checked against its immutable `MAX_TIER_CAP_*` ceiling,
     *      so a deploy cannot start above policy any more than a setter can move
     *      it there later.
     */
    constructor(
        address _diamond,
        address _usdc,
        address _tokenMessenger,
        address _messageTransmitter,
        uint32 _solanaDomain,
        uint256 _dailyTxCountLimit,
        address _livenessAttestor,
        address _kycAttestor,
        uint256 _livenessCapIndia,
        uint256 _livenessCapAbroad,
        uint256 _kycCapIndia,
        uint256 _kycCapAbroad
    ) {
        if (
            _diamond == address(0) ||
            _usdc == address(0) ||
            _tokenMessenger == address(0) ||
            _messageTransmitter == address(0) ||
            // Attestors are immutable in practice too: a deploy that zeroes them
            // ships a contract where no one can ever verify (both entrypoints
            // revert `AttestorNotSet`), and `owner` cannot be transferred, so the
            // only remedy is a redeploy + re-whitelist. Refuse at construction.
            _livenessAttestor == address(0) ||
            _kycAttestor == address(0)
        ) revert InvalidAddress();

        diamond = _diamond;
        usdc = IERC20(_usdc);
        owner = msg.sender;
        tokenMessenger = ITokenMessengerV2(_tokenMessenger);
        messageTransmitter = IMessageTransmitterV2(_messageTransmitter);
        solanaDomain = _solanaDomain;
        livenessAttestor = _livenessAttestor;
        kycAttestor = _kycAttestor;

        _setDailyTxCountLimit(_dailyTxCountLimit);
        _setTierCap(TIER_LIVENESS, REGION_INDIA, _livenessCapIndia);
        _setTierCap(TIER_LIVENESS, REGION_ABROAD, _livenessCapAbroad);
        _setTierCap(TIER_KYC, REGION_INDIA, _kycCapIndia);
        _setTierCap(TIER_KYC, REGION_ABROAD, _kycCapAbroad);

        offrampEnabled = true;
        // Standard Transfer, no attestation fee — see `bridgeMaxFeeBps`.
        bridgeMinFinalityThreshold = 2000;

        proxyImpl = address(new UserProxy());
    }

    // ─── Admin ────────────────────────────────────────────────────────

    /// @dev Zero is rejected rather than treated as "disable this tier". Zeroing
    ///      an attestor fails closed (`AttestorNotSet`), so it would brick the
    ///      tier silently and irreversibly for anyone mid-verification; the
    ///      supported way to close a lane is `setTierCap(tier, region, 0)`, which
    ///      leaves attestations verifiable. Same reasoning in the constructor.
    function setLivenessAttestor(address attestor) external onlyOwner {
        if (attestor == address(0)) revert InvalidAddress();
        livenessAttestor = attestor;
        emit LivenessAttestorUpdated(attestor);
    }

    function setKycAttestor(address attestor) external onlyOwner {
        if (attestor == address(0)) revert InvalidAddress();
        kycAttestor = attestor;
        emit KycAttestorUpdated(attestor);
    }

    /**
     * @notice Lower the per-tx cap for one (tier, region) cell. Setting a cap to
     *         0 disables that lane without touching anyone's attestation.
     * @dev    Can only ever set a value AT OR BELOW the matching immutable
     *         `MAX_TIER_CAP_*` ceiling — the owner may tighten policy, never
     *         loosen it past what the bytecode commits to.
     */
    function setTierCap(uint8 tier, uint8 region, uint256 cap) external onlyOwner {
        _setTierCap(tier, region, cap);
    }

    /// @notice Set the per-direction daily order count. 1..`MAX_DAILY_TX_COUNT_LIMIT`.
    /// @dev    0 is rejected: it used to mean "unlimited", which would be a way
    ///         around the ceiling. Use `setTierCap(tier, region, 0)` to stop a lane.
    function setDailyTxCountLimit(uint256 count) external onlyOwner {
        _setDailyTxCountLimit(count);
    }

    /**
     * @notice Block or unblock a wallet. A blocked wallet's effective limit is 0
     *         in both directions, so it can neither onramp nor offramp.
     *
     * @dev    Binary only — this never sets a per-user limit. Limits come solely
     *         from the KYC tier and the region ceiling. It also does not gate
     *         `userBridgeBackToSolana` or `userRescueStuckBridge`, so a blocked
     *         user can always get their own already-paid-for funds back out; a
     *         block stops new conversions, it does not seize anything.
     */
    function setUserBlocked(address user, bool isBlocked) external onlyOwner {
        if (user == address(0)) revert InvalidAddress();
        blocked[user] = isBlocked;
        emit UserBlockedUpdated(user, isBlocked);
    }

    function _setTierCap(uint8 tier, uint8 region, uint256 cap) internal {
        if (tier != TIER_LIVENESS && tier != TIER_KYC) revert InvalidTier();
        if (region != REGION_INDIA && region != REGION_ABROAD) revert InvalidRegion();
        if (cap > maxTierCap(tier, region)) revert CapExceedsCeiling();
        tierCap[tier][region] = cap;
        emit TierCapUpdated(tier, region, cap);
    }

    function _setDailyTxCountLimit(uint256 count) internal {
        if (count == 0) revert InvalidAmount();
        if (count > MAX_DAILY_TX_COUNT_LIMIT) revert CapExceedsCeiling();
        dailyTxCountLimit = count;
        emit DailyTxCountLimitUpdated(count);
    }

    function setOfframpEnabled(bool flag) external onlyOwner {
        offrampEnabled = flag;
        emit OfframpEnabledUpdated(flag);
    }

    /// @dev Bounded by `MAX_BRIDGE_MAX_FEE_BPS` so a misconfigured or
    ///      compromised owner cannot hand an arbitrary share of every burn to
    ///      the attestation service.
    function setBridgeMaxFeeBps(uint256 bps) external onlyOwner {
        if (bps > MAX_BRIDGE_MAX_FEE_BPS) revert CapExceedsCeiling();
        bridgeMaxFeeBps = bps;
        emit BridgeMaxFeeBpsUpdated(bps);
    }

    /// @notice Switch between Standard and Fast Transfer. Restricted to the two
    ///         values CCTP V2 actually defines.
    /// @dev    Every other limit here is bounded by a bytecode constant; this
    ///         setter was the one exception, which contradicted the governance
    ///         story stated at the top of this file. An arbitrary value is not
    ///         rejected by CCTP — it is silently normalised by the attestation
    ///         service, so e.g. 500 becomes a Fast transfer that charges a fee
    ///         while `bridgeMaxFeeBps` defaults to 0, turning every burn into a
    ///         fail-closed retry that looks like a CCTP outage. (#75)
    ///
    ///         Switching to Fast is a TWO-setter operation: raise
    ///         `bridgeMaxFeeBps` to cover Circle's fee (1.3 bps on Base → Solana
    ///         at the time of writing, so >= 2) BEFORE calling this, or every
    ///         burn fails closed. Fast messages also carry a real 24h
    ///         `expirationBlock` and need `POST /v2/reattest/{nonce}` after it —
    ///         the "attestations never expire" property the delivery sweeper
    ///         relies on holds only for Standard.
    function setBridgeMinFinalityThreshold(uint32 threshold) external onlyOwner {
        if (threshold != FINALITY_FAST && threshold != FINALITY_STANDARD) {
            revert InvalidFinalityThreshold();
        }
        bridgeMinFinalityThreshold = threshold;
        emit BridgeFinalityThresholdUpdated(threshold);
    }

    /**
     * @notice Sweep surplus USDC (dust, or tokens sent here by mistake) to `to`.
     * @dev Hard-bounded by `unbridgedTotal`: USDC that the Diamond delivered for
     *      an onramp still awaiting its burn is reserved and cannot be withdrawn
     *      by the owner. Those funds leave only via `retryBridge` (to the Solana
     *      account pinned at order time) or `userRescueStuckBridge` (to the
     *      buyer). The owner therefore never has custody of a user's in-flight
     *      onramp.
     */
    function withdrawUsdc(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert InvalidAddress();
        uint256 bal = usdc.balanceOf(address(this));
        uint256 reserved = unbridgedTotal;
        if (bal < reserved || amount > bal - reserved) revert WithdrawExceedsSurplus();
        usdc.safeTransfer(to, amount);
        emit UsdcWithdrawn(to, amount);
    }

    // ─── Attestation intake ───────────────────────────────────────────

    /**
     * @notice Verify and record a liveness-tier attestation for `msg.sender`.
     * @param nullifier Per-(tenant, human) Sybil nullifier from the service.
     * @param limit     Attested per-tx USDC ceiling (micro-USDC, 6dp). The
     *                  effective cap is `min(limit, tierCap[TIER_LIVENESS][region])`
     *                  — $20 for INR orders, $50 for anything else.
     * @param expiry    Unix seconds; the attestation must be claimed before this.
     * @param signature 65-byte secp256k1 signature (r ‖ s ‖ v) from the service.
     */
    function submitLivenessAttestation(
        bytes32 nullifier,
        uint256 limit,
        uint256 expiry,
        bytes calldata signature
    ) external {
        if (livenessAttestor == address(0)) revert AttestorNotSet();
        if (block.timestamp >= expiry) revert AttestationExpired();
        if (livenessNullifierSpent[nullifier]) revert NullifierAlreadySpent();

        bytes32 digest = _digest(
            _LIVENESS_DOMAIN_NAME,
            _LIVENESS_TYPEHASH,
            msg.sender,
            nullifier,
            limit,
            expiry
        );
        if (_recover(digest, signature) != livenessAttestor) revert InvalidSignature();

        livenessNullifierSpent[nullifier] = true;
        _applyGrant(msg.sender, limit, TIER_LIVENESS, nullifier);
    }

    /**
     * @notice Verify and record a passport+liveness (KYC) attestation for
     *         `msg.sender`, raising their per-tx cap to the KYC tier.
     * @dev Same shape as `submitLivenessAttestation` but bound to the KYC
     *      service's domain (`KycVerifier`), typehash, attestor, and nullifier
     *      set.
     */
    function submitKycAttestation(
        bytes32 nullifier,
        uint256 limit,
        uint256 expiry,
        bytes calldata signature
    ) external {
        if (kycAttestor == address(0)) revert AttestorNotSet();
        if (block.timestamp >= expiry) revert AttestationExpired();
        if (kycNullifierSpent[nullifier]) revert NullifierAlreadySpent();

        bytes32 digest = _digest(
            _KYC_DOMAIN_NAME,
            _KYC_TYPEHASH,
            msg.sender,
            nullifier,
            limit,
            expiry
        );
        if (_recover(digest, signature) != kycAttestor) revert InvalidSignature();

        kycNullifierSpent[nullifier] = true;
        _applyGrant(msg.sender, limit, TIER_KYC, nullifier);
    }

    /// @dev The TIER is monotonic (a claim only ever raises it). The per-tier
    ///      LIMIT is NOT: a fresh same-tier attestation OVERWRITES that tier's
    ///      granted limit, so a risk-driven downgrade the service signs actually
    ///      binds (#45). Cross-tier limits no longer bleed into each other. The
    ///      attestation `expiry` is a claim-freshness deadline (checked above),
    ///      not an ongoing clock — the per-(tenant, human) nullifier is
    ///      single-use, so an expiring grant could never be re-claimed.
    function _applyGrant(address user, uint256 limit, uint8 tier, bytes32 nullifier) internal {
        grantedLimit[user][tier] = limit;
        if (tier > userTier[user]) userTier[user] = tier;
        emit KycClaimed(user, tier, nullifier, limit, grantedLimit[user][tier]);
    }

    // ─── Views ────────────────────────────────────────────────────────

    /// @notice The settlement region an order in `currency` falls under.
    ///         `INR` is India; every other currency is Abroad.
    function regionFor(bytes32 currency) public pure returns (uint8) {
        return currency == INDIA_CURRENCY ? REGION_INDIA : REGION_ABROAD;
    }

    /// @notice The immutable policy ceiling for one (tier, region) cell — the
    ///         most `setTierCap` can ever be set to.
    function maxTierCap(uint8 tier, uint8 region) public pure returns (uint256) {
        if (tier == TIER_LIVENESS) {
            return
                region == REGION_INDIA ? MAX_TIER_CAP_LIVENESS_INDIA : MAX_TIER_CAP_LIVENESS_ABROAD;
        }
        if (tier == TIER_KYC) {
            return region == REGION_INDIA ? MAX_TIER_CAP_KYC_INDIA : MAX_TIER_CAP_KYC_ABROAD;
        }
        return 0;
    }

    /**
     * @notice The effective per-tx USDC ceiling for `user` settling in
     *         `currency`, applied to BOTH the onramp and the offramp: the limit
     *         their attestation carries, clamped by this contract's ceiling for
     *         the tier they reached and the region the currency settles in.
     *         0 means "cannot transact" — unverified, blocked, or a lane the
     *         owner has switched off.
     */
    function effectiveLimit(address user, bytes32 currency) public view returns (uint256) {
        if (blocked[user]) return 0;
        uint8 tier = userTier[user];
        if (tier == TIER_NONE) return 0;
        uint256 lim = grantedLimit[user][tier];
        uint256 cap = tierCap[tier][regionFor(currency)];
        return lim < cap ? lim : cap;
    }

    /// @notice Both region limits for `user` in one call, for the UI: what they
    ///         may send settling in INR vs in any other currency.
    function effectiveLimits(address user) external view returns (uint256 india, uint256 abroad) {
        india = effectiveLimit(user, INDIA_CURRENCY);
        // Any non-INR sentinel resolves to the Abroad column.
        abroad = effectiveLimit(user, bytes32(0));
    }

    /// @notice Predicts the deterministic proxy address for `user`. This is the
    ///         address a Solana-side CCTP burn must name as its `mintRecipient`
    ///         to fund an offramp. It need not be deployed yet — CCTP can mint
    ///         to it before it exists, and `userInitiateOfframp` deploys it.
    function proxyAddress(address user) public view returns (address) {
        return
            Clones.predictDeterministicAddressWithImmutableArgs(
                proxyImpl,
                _proxyArgs(user),
                _salt(user),
                address(this)
            );
    }

    /// @notice `proxyAddress(user)` encoded as the bytes32 a Solana-side CCTP
    ///         `depositForBurn` expects for `mintRecipient`.
    function offrampMintRecipient(address user) external view returns (bytes32) {
        return bytes32(uint256(uint160(proxyAddress(user))));
    }

    /// @notice USDC bridged in from Solana and available to offramp for `user`.
    function bridgedBalance(address user) external view returns (uint256) {
        return usdc.balanceOf(proxyAddress(user));
    }

    /// @notice Onramp BUY placements left for `user` today (UTC).
    function getRemainingDailyCount(address user) external view returns (uint256) {
        return _remaining(userDailyCount[user][block.timestamp / 1 days]);
    }

    /// @notice Offramp SELL placements left for `user` today (UTC). Budgeted
    ///         separately from the onramp.
    function getRemainingOfframpDailyCount(address user) external view returns (uint256) {
        return _remaining(userDailyOfframpCount[user][block.timestamp / 1 days]);
    }

    function _remaining(uint256 used) private view returns (uint256) {
        uint256 limit = dailyTxCountLimit;
        return used >= limit ? 0 : limit - used;
    }

    function getSession(uint256 orderId) external view returns (Session memory) {
        return sessions[orderId];
    }

    function getOfframp(uint256 orderId) external view returns (OfframpRecord memory) {
        return offramps[orderId];
    }

    // ─── Onramp: fiat -> USDC on Solana ───────────────────────────────

    /**
     * @notice Place an onramp BUY order. On completion the Diamond delivers the
     *         USDC to this contract, which immediately burns it via CCTP to mint
     *         an equivalent amount to `solanaRecipient` on Solana.
     *
     * @param amount          USDC to deliver on Solana (micro-USDC, 6dp).
     * @param currency        Fiat currency the user pays in (e.g. bytes32("INR")).
     * @param solanaRecipient The user's USDC ASSOCIATED TOKEN ACCOUNT on Solana
     *                        as bytes32 — NOT their wallet address. It must
     *                        already exist, or the mint cannot be executed on
     *                        Solana. Pinned here for the life of the order, so
     *                        the later burn cannot be redirected by anyone.
     */
    function userBuyUsdcToSolana(
        uint256 amount,
        bytes32 currency,
        bytes32 solanaRecipient,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) external nonReentrant returns (uint256 orderId) {
        if (amount == 0) revert InvalidAmount();
        if (solanaRecipient == bytes32(0)) revert InvalidSolanaRecipient();

        // Friendly pre-checks; validateOrder re-enforces these authoritatively
        // when the Diamond calls back, and reserves the daily-count slot there.
        // `currency` picks the region column: INR -> India, anything else -> Abroad.
        if (blocked[msg.sender]) revert UserIsBlocked();
        uint256 lim = effectiveLimit(msg.sender, currency);
        if (lim == 0) revert NotKycVerified();
        if (amount > lim) revert KycLimitExceeded();

        orderId = _placeBuyOrder(
            amount,
            currency,
            circleId,
            pubKey,
            preferredPaymentChannelConfigId,
            fiatAmountLimit
        );

        sessions[orderId] = Session({
            user: msg.sender,
            fulfilled: false,
            bridged: false,
            cancelled: false,
            rescued: false,
            placementDay: uint32(block.timestamp / 1 days),
            completedAt: 0,
            amount: amount,
            solanaRecipient: solanaRecipient
        });

        emit OnrampOrderCreated(orderId, msg.sender, amount, currency, solanaRecipient);
    }

    function _placeBuyOrder(
        uint256 amount,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) internal returns (uint256) {
        // Proxy-as-placer: the B2B gateway is proxy-only. The user's UserProxy is
        // the msg.sender that calls placeB2BOrder; the gateway resolves it back
        // to this integrator via CREATE2.
        //
        // recipientAddr = address(this): the purchased USDC must land here so
        // onOrderComplete can burn it to Solana. The proxy is only the
        // authenticated caller and never receives the onramp's USDC.
        address proxy = _ensureProxy(msg.sender);
        bytes memory data = abi.encodeCall(
            IB2BGateway.placeB2BOrder,
            (
                msg.sender,
                amount,
                currency,
                address(this),
                pubKey,
                circleId,
                preferredPaymentChannelConfigId,
                fiatAmountLimit
            )
        );
        bytes memory result = UserProxy(proxy).execute(diamond, data, address(usdc), 0);
        return abi.decode(result, (uint256));
    }

    // ─── IP2PIntegrator callbacks ─────────────────────────────────────

    /**
     * @notice The Diamond's synchronous gate during placeB2BOrder /
     *         placeB2BSellOrder — the authoritative KYC check for both flows.
     *
     * @dev An offramp SELL is placed with `order.user` = the seller's own proxy,
     *      so `proxyOwner` resolves it back to the human and their tier is
     *      checked. A BUY arrives with the user's EOA. Each direction consumes a
     *      slot from its OWN daily budget, so 5/day means 5 onramps and,
     *      independently, 5 offramps.
     *
     *      Neither counter is ever released: the live Diamond does not call
     *      `onOrderCancel` at all, and the gateway would only ever call it for a
     *      BUY. Slots are therefore placements/day in both directions — the safe
     *      direction, since a slot can never be freed early.
     *
     *      `currency` selects the region column, so the same wallet legitimately
     *      gets a different cap for an INR order than for a foreign-currency one.
     */
    function validateOrder(
        address user,
        uint256 amount,
        bytes32 currency
    ) external onlyDiamond returns (bool allowed) {
        uint256 dayIndex = block.timestamp / 1 days;

        address seller = proxyOwner[user];
        if (seller != address(0)) {
            uint256 sellerLim = effectiveLimit(seller, currency);
            if (sellerLim == 0 || amount > sellerLim) return false;

            uint256 sellCount = userDailyOfframpCount[seller][dayIndex];
            if (sellCount + 1 > dailyTxCountLimit) return false;
            userDailyOfframpCount[seller][dayIndex] = sellCount + 1;
            return true;
        }

        uint256 lim = effectiveLimit(user, currency);
        if (lim == 0 || amount > lim) return false;

        uint256 count = userDailyCount[user][dayIndex];
        if (count + 1 > dailyTxCountLimit) return false;
        userDailyCount[user][dayIndex] = count + 1;
        return true;
    }

    /**
     * @notice BUY completion hook. The Diamond has just delivered `amount` USDC
     *         to this contract; burn it to the Solana account pinned at order
     *         time.
     *
     * @dev The burn runs through an external self-call under try/catch so that a
     *      CCTP failure (unsupported burn token, messenger paused, per-tx burn
     *      limit) cannot roll back this hook's bookkeeping. The gateway also
     *      try/catches this callback, so a revert here would silently strand the
     *      delivered USDC with no session record. Failing closed instead leaves
     *      the order marked fulfilled-but-unbridged and recoverable via
     *      `retryBridge` or `userRescueStuckBridge`.
     *
     *      Two guards keep the core accounting invariant — `usdc.balanceOf(this)
     *      >= unbridgedTotal` — true, which is what makes `withdrawUsdc`,
     *      `retryBridge` and `userRescueStuckBridge` safe against each other.
     *      Unbridged onramps share one pooled balance here, so reserving USDC
     *      that never arrived would let one order's burn consume another
     *      buyer's funds:
     *
     *        1. `recipientAddr` must be this contract. The onramp pins it at
     *           placement, so this can only fail if the routing ever changes —
     *           and then the USDC is not here, so recording it would be a lie.
     *           Reverting is correct: the gateway swallows it and nothing is
     *           stranded here, because nothing arrived here.
     *        2. The session is re-pinned to the amount actually DELIVERED. Here
     *           a revert would be wrong — the USDC did arrive, and a swallowed
     *           revert would leave it with no session record, i.e. sweepable by
     *           the owner as "surplus". Trusting the delivered figure keeps it
     *           reserved and refundable. Sibling integrators (LotPot, Investabl)
     *           revert with `AmountMismatch` instead; they can, because they do
     *           not pool user funds.
     */
    function onOrderComplete(
        uint256 orderId,
        address /* user */,
        uint256 amount,
        address recipientAddr
    ) external onlyDiamond {
        Session storage session = sessions[orderId];
        if (session.user == address(0)) return; // unknown / non-BUY order — no-op
        if (session.fulfilled) revert OrderAlreadyFulfilled();
        if (recipientAddr != address(this)) revert UnexpectedRecipient();

        if (session.cancelled) {
            // Cancel-then-complete (admin CANCELLED -> re-open -> COMPLETE once
            // feat/integrator-on-order-cancel ships). The USDC is already here —
            // the gateway routes funds BEFORE this hook and try/catches it, so a
            // revert would be swallowed and strand the delivered amount with no
            // session record (sweepable as owner "surplus"). Same asymmetry as
            // the F2 delivery-accounting rule: never revert once the money has
            // arrived. Settle normally, re-charge the daily slot onOrderCancel
            // released, and leave `cancelled = true` as the honest record.
            // Charge the CURRENT day's bucket, not placementDay's. (#89) Same
            // day they are identical; across a midnight boundary the cancel
            // freed a slot the user could re-spend on day one, and re-charging
            // day one's bucket — which nothing reads any more — would net one
            // extra placement. Charging today keeps over-counting as the safe
            // direction it claims to be: stricter, never looser.
            userDailyCount[session.user][block.timestamp / 1 days] += 1;
            emit CancelledOrderCompleted(orderId, session.user);
        }

        // Reserve at most what was PLACED, and at most what is actually
        // unreserved on this contract right now. `unbridgedTotal` is a claim on a
        // POOLED balance, so over-reserving lets this order's burn spend another
        // buyer's USDC and breaks `balanceOf(this) >= unbridgedTotal`.
        //
        // Runs UNCONDITIONALLY (#73). An earlier version only ran when the
        // reported amount differed from the placed one, which missed the case the
        // invariant actually needs: a Diamond that reports the placed amount
        // while transferring less. Bounding by `session.amount` rather than by
        // free balance alone also stops an over-report from reserving unrelated
        // surplus already sitting here — e.g. USDC from a user who pointed a
        // Solana burn at the integrator instead of `offrampMintRecipient(user)`,
        // the confusion this contract warns about elsewhere.
        //
        // Clamp rather than revert: the gateway routes funds BEFORE this hook and
        // swallows a revert, so reverting would strand the delivered USDC with no
        // session record (sweepable as owner "surplus") — the same asymmetry the
        // cancel-then-complete branch above turns on.
        //
        // Deliberately NOT re-checked against the tier cap: clamping an
        // over-delivery down to the cap would leave the excess unreserved and
        // owner-sweepable, converting an AML limit breach into a user fund loss.
        // The cap is enforced at placement, where it belongs.
        //
        // Unreachable on today's gateway (it passes exactly the amount it
        // transferred, verified against contracts-v4). Defence in depth: this
        // integrator is immutable and the Diamond is not.
        uint256 bal = usdc.balanceOf(address(this));
        // Saturating: the invariant should make this non-negative, but a panic
        // here would strand the delivered USDC, which is what we are preventing.
        uint256 backed = bal > unbridgedTotal ? bal - unbridgedTotal : 0;
        uint256 pinned = amount < session.amount ? amount : session.amount;
        if (pinned > backed) pinned = backed;
        // Emit on ANY discrepancy, including an over-report clamped back to the
        // placed amount — `OnrampAmountAdjusted` is the alert that the Diamond
        // delivered something other than what was placed, and it should never be
        // silent just because the clamp absorbed it.
        if (amount != session.amount || pinned != session.amount) {
            emit OnrampAmountAdjusted(orderId, session.amount, pinned);
            session.amount = pinned;
        }

        session.fulfilled = true;
        session.completedAt = uint32(block.timestamp);
        unbridgedTotal += session.amount;
        emit OnrampOrderFulfilled(orderId, session.user, session.amount);

        try this.selfBridge(orderId) {
            // bridged — BridgedToSolana emitted inside
        } catch (bytes memory reason) {
            emit BridgeFailed(orderId, reason);
        }
    }

    /**
     * @notice BUY cancellation hook — releases the daily-count slot reserved in
     *         validateOrder, keyed on the placement-day snapshot. Tolerates
     *         unknown / already-finalized / SELL orders (best-effort).
     *
     * @dev [live protocol] NOT CALLED TODAY. The mainnet Diamond's
     *      `IP2PIntegrator` has only `validateOrder` + `onOrderComplete`; the
     *      `onOrderCancel` selector `0x7ff83a04` is absent from all 21 facets
     *      and exists only on the unmerged `feat/integrator-on-order-cancel`
     *      branch. So this is forward-compatible dead code, and until it ships
     *      `dailyTxCountLimit` bounds PLACEMENTS per day: a cancelled or expired
     *      order keeps its slot. Strictly safe (a slot can never be freed early,
     *      so the cap can't be exceeded); the cost is UX, and at 5/day it bites
     *      sooner than it did at 10.
     *
     *      There is deliberately no offramp counterpart: the gateway only ever
     *      calls this for a BUY, so an offramp slot could never be released
     *      either way.
     */
    function onOrderCancel(uint256 orderId) external onlyDiamond {
        Session storage session = sessions[orderId];
        if (session.user == address(0)) return;
        if (session.fulfilled) revert OrderAlreadyFulfilled();
        // IP2PIntegrator asks this hook to tolerate repeat calls — return
        // rather than revert. Returning BEFORE the decrement below also keeps a
        // repeat call from double-freeing the daily slot. (#55)
        if (session.cancelled) return;
        session.cancelled = true;

        uint256 day = uint256(session.placementDay);
        uint256 count = userDailyCount[session.user][day];
        if (count > 0) {
            userDailyCount[session.user][day] = count - 1;
        }
    }

    // ─── Bridge: Base -> Solana ───────────────────────────────────────

    /**
     * @notice Push a fulfilled-but-unbridged onramp through CCTP again.
     *         Permissionless: the destination and amount were pinned when the
     *         order was placed, so the caller cannot redirect anything — they
     *         only pay the gas. Reverts bubble up so the caller sees why CCTP
     *         refused.
     */
    function retryBridge(uint256 orderId) external nonReentrant {
        Session storage session = sessions[orderId];
        if (session.user == address(0)) revert UnknownOrder();
        if (!session.fulfilled) revert OrderNotFulfilled();
        if (session.bridged || session.rescued) revert AlreadyBridged();
        _bridge(orderId);
    }

    /// @dev Self-call entrypoint so `onOrderComplete` can try/catch the burn.
    ///      Reverting rolls back everything `_bridge` touched — including the
    ///      allowance it set — leaving the session cleanly unbridged.
    function selfBridge(uint256 orderId) external {
        if (msg.sender != address(this)) revert OnlySelf();
        _bridge(orderId);
    }

    function _bridge(uint256 orderId) internal {
        Session storage session = sessions[orderId];
        // Local idempotency guard. Previously this check lived only in
        // retryBridge, so _bridge's safety rested on four separate external
        // facts (the CEI order, onOrderComplete's `fulfilled` guard,
        // retryBridge's check, and there being exactly one `this.selfBridge`
        // caller). Making it local means a future second caller can never
        // double-burn one session out of another buyer's pooled reservation. (#55)
        if (session.bridged || session.rescued) revert AlreadyBridged();
        uint256 amount = session.amount;
        bytes32 recipient = session.solanaRecipient;
        uint256 maxFee = _maxFeeFor(amount);

        // Checks-effects-interactions: mark bridged and release the reservation
        // BEFORE the external burn. The automatic path (onOrderComplete ->
        // this.selfBridge -> _bridge) is not nonReentrant, so with a burn token
        // that had a transfer hook a reentrant retryBridge(orderId) could
        // otherwise re-enter here while session.bridged was still false and burn
        // a second time out of the pooled balance. Canonical Circle USDC has no
        // such hook (enforced at deploy), so this is defense-in-depth; a failed
        // burn still reverts the whole subcall and rolls these writes back,
        // leaving the order fulfilled-but-unbridged and retryable.
        session.bridged = true;
        unbridgedTotal -= amount;

        usdc.forceApprove(address(tokenMessenger), amount);
        tokenMessenger.depositForBurn(
            amount,
            solanaDomain,
            recipient,
            address(usdc),
            bytes32(0), // any address may deliver the message on Solana
            maxFee,
            bridgeMinFinalityThreshold
        );
        usdc.forceApprove(address(tokenMessenger), 0);

        emit BridgedToSolana(orderId, session.user, amount, recipient, maxFee);
    }

    /// @dev CCTP requires `maxFee < amount`; clamp so a misconfigured bps can
    ///      never make the burn unsatisfiable.
    function _maxFeeFor(uint256 amount) internal view returns (uint256) {
        // amount == 0 would underflow on `amount - 1` below and panic. Newly
        // reachable since the delivery clamp (#73) can legitimately pin a session
        // to 0 when nothing arrived; the burn then fails closed into BridgeFailed
        // rather than taking down the completion hook with a panic. (#75)
        if (amount == 0) return 0;
        uint256 fee = (amount * bridgeMaxFeeBps) / 10_000;
        if (fee >= amount) fee = amount - 1;
        return fee;
    }

    /**
     * @notice Withdraw bridged-in USDC from your own proxy to your own wallet,
     *         without going through CCTP. One caveat (#86): USDC escrowed against
     *         an outstanding SELL (plus SELL_FEE_HEADROOM) is not withdrawable
     *         until the order is terminal and the permissionless `reconcile`
     *         releases it — an abandoned order reaches terminal via the Diamond's
     *         own expiry plus the permissionless `autoCancelExpiredOrders`, so
     *         the wait is minutes and needs no one's permission.
     * @dev    Every other exit for offramp funds needs something else to be
     *         working: `userBridgeBackToSolana` needs a successful CCTP burn (the
     *         burn is in the same tx, so a paused or migrated TokenMessenger
     *         reverts the whole call), and `deliverOfframpUpi` needs
     *         `offrampEnabled`, a tier above 0, not being blocked, and a matched
     *         merchant. `UserProxy.sweepERC20` rejects USDC by design and
     *         `transferERC20ToIntegrator` is integrator-only, so without this the
     *         user cannot reach their own proxy balance at all — and neither can
     *         the owner, since `withdrawUsdc` only moves this contract's balance.
     *
     *         That contradicted the invariant stated twice in this file and in
     *         showdown.md: a block never traps funds. It does not now. (#74)
     *
     *         Deliberately NOT gated on `blocked[]` or `offrampEnabled`, for the
     *         same reason `userBridgeBackToSolana` and `userRescueStuckBridge`
     *         are not: this moves only the caller's own already-paid-for funds
     *         back to the caller. A block stops new conversions; it must never
     *         seize or strand. No delay either — unlike an onramp rescue there is
     *         nothing in flight to wait on; the escrow check below is what
     *         protects an accepted merchant.
     */
    function userRescueProxyUsdc(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();

        address proxy = _ensureProxy(msg.sender);
        // Same escrow rule as bridging out: never move USDC committed to an
        // outstanding SELL.
        if (usdc.balanceOf(proxy) < _escrowFloor(msg.sender) + amount) {
            revert InsufficientBridgedFunds();
        }

        // Via the integrator, since the proxy will only release USDC to it. The
        // pooled invariant is untouched: balance rises then falls in one tx and
        // `unbridgedTotal` never moves.
        UserProxy(proxy).transferERC20ToIntegrator(address(usdc), amount);
        usdc.safeTransfer(msg.sender, amount);

        emit ProxyUsdcRescued(msg.sender, amount);
    }

    /**
     * @notice Last-resort exit for the buyer when CCTP has refused an onramp's
     *         burn for `BRIDGE_RESCUE_DELAY`: pull the USDC to their own wallet
     *         instead of leaving it stranded.
     *
     * @dev Buyer-only and delay-gated — never an owner power. This does hand the
     *      buyer Base-side USDC rather than the Solana USDC they ordered, which
     *      is a deliberate trade against permanent loss: they already paid fiat
     *      for it, they are attested, and the amount is bounded by their per-tx
     *      tier cap (up to $200 under the current matrix). It is unreachable
     *      while CCTP is healthy.
     */
    function userRescueStuckBridge(uint256 orderId) external nonReentrant {
        Session storage session = sessions[orderId];
        if (session.user == address(0)) revert UnknownOrder();
        if (session.user != msg.sender) revert NotOrderOwner();
        if (!session.fulfilled) revert OrderNotFulfilled();
        if (session.bridged || session.rescued) revert AlreadyBridged();
        if (block.timestamp < uint256(session.completedAt) + BRIDGE_RESCUE_DELAY) {
            revert RescueTooEarly();
        }

        uint256 amount = session.amount;
        session.rescued = true;
        unbridgedTotal -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit BridgeRescued(orderId, msg.sender, amount);
    }

    // ─── Bridge: Solana -> Base ───────────────────────────────────────

    /**
     * @notice Convenience passthrough to CCTP's MessageTransmitterV2 so the
     *         widget can redeem a Solana burn through this one ABI.
     *
     * @dev Carries no privilege and grants none: `receiveMessage` mints to the
     *      `mintRecipient` encoded in the attested message (for Showdown, the
     *      user's proxy — see `offrampMintRecipient`), never to `msg.sender`.
     *      Anyone may submit anyone's message; calling the transmitter directly
     *      is equivalent.
     */
    function receiveFromSolana(
        bytes calldata message,
        bytes calldata attestation
    ) external returns (bool) {
        return messageTransmitter.receiveMessage(message, attestation);
    }

    /**
     * @notice Send bridged-in USDC back to Solana instead of offramping it —
     *         the escape hatch for funds sitting on a user's proxy (e.g. they
     *         changed their mind, or their tier does not cover the amount).
     *
     * @param solanaRecipient The user's USDC associated token account (ATA).
     */
    function userBridgeBackToSolana(uint256 amount, bytes32 solanaRecipient) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (solanaRecipient == bytes32(0)) revert InvalidSolanaRecipient();

        address proxy = _ensureProxy(msg.sender);
        // Respect the SELL escrow: bridging out funds already committed to an
        // outstanding offramp would strand a merchant who has accepted it, and
        // delivery would then revert until they cancel. Self-inflicted griefing
        // rather than theft, but the escrow exists precisely to stop it.
        if (usdc.balanceOf(proxy) < _escrowFloor(msg.sender) + amount) {
            revert InsufficientBridgedFunds();
        }

        // Pull to the integrator and burn in the same tx: if the burn reverts,
        // the whole call reverts and the USDC is never left sitting here.
        UserProxy(proxy).transferERC20ToIntegrator(address(usdc), amount);

        uint256 maxFee = _maxFeeFor(amount);
        usdc.forceApprove(address(tokenMessenger), amount);
        tokenMessenger.depositForBurn(
            amount,
            solanaDomain,
            solanaRecipient,
            address(usdc),
            bytes32(0),
            maxFee,
            bridgeMinFinalityThreshold
        );
        usdc.forceApprove(address(tokenMessenger), 0);

        emit BridgedBackToSolana(msg.sender, amount, solanaRecipient, maxFee);
    }

    // ─── Offramp: USDC (bridged from Solana) -> fiat ──────────────────

    /**
     * @notice Place a SELL order funded by the USDC this user bridged in from
     *         Solana, which lives on their `UserProxy` (the `mintRecipient` of
     *         their Solana burn — see `offrampMintRecipient`).
     *
     * @dev The order is placed with `order.user` = that same proxy, so the
     *      Diamond pulls the USDC from it at `setSellOrderUpi` and, on a
     *      cancel-while-PAID, refunds straight back to it. The seller's funds
     *      never transit the integrator.
     *
     * @param amount USDC principal to sell (micro-USDC, 6dp). The Diamond's fee
     *               is charged on top and also comes off the proxy balance, so
     *               the proxy must hold principal + fee by delivery time.
     */
    function userInitiateOfframp(
        uint256 amount,
        bytes32 currency,
        uint256 fiatAmount,
        uint256 circleId,
        uint256 preferredPaymentChannelConfigId,
        string calldata userPubKey
    ) external nonReentrant returns (uint256 orderId) {
        if (!offrampEnabled) revert OfframpDisabled();
        if (amount == 0) revert InvalidAmount();

        if (blocked[msg.sender]) revert UserIsBlocked();
        uint256 lim = effectiveLimit(msg.sender, currency);
        if (lim == 0) revert NotKycVerified();
        if (amount > lim) revert KycLimitExceeded();

        address proxy = _ensureProxy(msg.sender);
        // Escrow, not just a balance check: the proxy must cover every
        // outstanding SELL principal plus this one, so a user can't place N
        // orders against the same balance and strand all but one at delivery.
        // (#51 escrow / #44 over-commit). NOTE: the per-order fee is charged on
        // top and is Diamond-determined, unknown at placement, so this does not
        // by itself prevent a single FULL-balance SELL from being undeliverable
        // (`needed = principal + fee > balance`) — see #44; the widget must
        // reserve fee headroom (surface via getRemainingOfframpDailyCount +
        // proxy balance) and/or p2p confirms a max-fee bound to enforce here.
        if (usdc.balanceOf(proxy) < pendingOfframpTotal[msg.sender] + amount) {
            revert InsufficientBridgedFunds();
        }

        orderId = _placeSellOrder(
            proxy,
            amount,
            currency,
            fiatAmount,
            circleId,
            preferredPaymentChannelConfigId,
            userPubKey
        );

        offramps[orderId] = OfframpRecord({
            user: msg.sender,
            usdcAmount: amount,
            lastStatus: 0,
            initialized: true,
            placementDay: uint32(block.timestamp / 1 days)
        });
        orderInitiator[orderId] = msg.sender;
        pendingOfframpTotal[msg.sender] += amount;

        emit OfframpInitiated(orderId, msg.sender, amount, proxy);
    }

    function _placeSellOrder(
        address proxy,
        uint256 amount,
        bytes32 currency,
        uint256 fiatAmount,
        uint256 circleId,
        uint256 preferredPaymentChannelConfigId,
        string calldata userPubKey
    ) internal returns (uint256) {
        bytes memory data = abi.encodeCall(
            IB2BGateway.placeB2BSellOrder,
            (
                proxy,
                amount,
                currency,
                userPubKey,
                circleId,
                preferredPaymentChannelConfigId,
                fiatAmount
            )
        );
        bytes memory result = UserProxy(proxy).execute(diamond, data, address(usdc), 0);
        return abi.decode(result, (uint256));
    }

    /**
     * @notice Forward the encrypted UPI payload to the Diamond, letting it pull
     *         the sale's USDC from the seller's proxy. Reads the authoritative
     *         `actualUsdtAmount` (principal + fee) from the Diamond rather than
     *         assuming the principal. Callable ONLY by the order's initiator —
     *         there is no relayer path (#53.2); see the note by `offrampEnabled`.
     */
    function deliverOfframpUpi(uint256 orderId, string calldata encUpi) external nonReentrant {
        OfframpRecord memory record = offramps[orderId];
        if (!record.initialized) revert OfframpRecordNotFound();
        // Initiator-only by design (#53.2) — see the note by `offrampEnabled`.
        if (msg.sender != orderInitiator[orderId]) revert OfframpNotAuthorized();
        // Honour a block placed AFTER the order was placed. blocked[] exists
        // precisely to stop a payout (fraud report / sanctions), so unlike the
        // offrampEnabled kill switch — which we deliberately let in-flight orders
        // settle to avoid stranding an accepted merchant — a blocked seller must
        // NOT be delivered. No stranding risk: the USDC is still on the seller's
        // own proxy and userBridgeBackToSolana remains open to them. (#53)
        if (blocked[record.user]) revert UserIsBlocked();

        // The Diamond names the amount this contract is about to grant an
        // allowance over, out of the seller's proxy. Bound it in both directions
        // before trusting it — MerchantTerminalIntegrator guards this same
        // boundary four ways and this one carried only the balance check. (#72)
        //
        // The order must be ACCEPTED: PLACED means no matched merchant to pay,
        // and PAID/COMPLETED/CANCELLED mean this is a replay or a dead order.
        if (IOrderFlow(diamond).getOrdersById(orderId).status != STATUS_ACCEPTED) {
            revert OfframpNotDeliverable();
        }

        IOrderFlow.AdditionalOrderDetailsView memory aod = IOrderFlow(diamond)
            .getAdditionalOrderDetails(orderId);
        uint256 needed = aod.actualUsdtAmount;
        // Was: `if (needed == 0) needed = record.usdcAmount;`. That fallback read
        // as a safety net but is unreachable for an ACCEPTED order — the Diamond
        // writes actualUsdtAmount at placement and only zeroes it on cancel — so
        // a zero here means the Diamond is not in the state we think it is.
        // Refuse instead of inventing an amount.
        if (needed == 0) revert OfframpFeeNotReady();
        // The Diamond documents actualUsdtAmount as principal + fee, so anything
        // BELOW the escrowed principal is a re-price, a partial fill or a fee
        // model change. No upper bound here: that needs a MAX_SELL_FEE_BPS, the
        // same input still outstanding on #44.
        if (needed < record.usdcAmount) revert OfframpFeeNotReady();

        address proxy = _ensureProxy(record.user);
        if (usdc.balanceOf(proxy) < needed) revert InsufficientBridgedFunds();

        bytes memory data = abi.encodeCall(IOrderFlow.setSellOrderUpi, (orderId, encUpi, 0));
        UserProxy(proxy).execute(diamond, data, address(usdc), needed);

        // The live OrderFlowFacet wraps its USDC pull in try/catch and, on ANY
        // failure, AUTO-CANCELS the order and returns success — it does not
        // revert. So a returned `execute` is not proof of delivery. Read the
        // status back and only report a delivery the Diamond actually made;
        // otherwise the event stream reports a payout that never happened while
        // the seller's daily slot stays consumed. Same pattern as
        // MerchantTerminalIntegrator. (#71)
        uint8 postStatus = IOrderFlow(diamond).getOrdersById(orderId).status;
        if (postStatus == STATUS_PAID) {
            emit OfframpUpiDelivered(orderId, needed);
        } else {
            // Auto-cancelled: nothing was pulled, the principal is still on the
            // seller's proxy. `reconcile` (permissionless) releases the escrow
            // and, for a never-accepted order, refunds the daily slot.
            emit OfframpDeliveryAutoCancelled(orderId, postStatus);
        }
    }

    /**
     * @notice Record the authoritative order status from the Diamond. Anyone can
     *         poke; the status is read from the Diamond rather than supplied by
     *         the caller, so a wrong value can't grief the record.
     *
     * @dev No refund handling: a cancel-while-PAID returns USDC to `order.user`,
     *      which is the seller's own proxy, so the funds are already back where
     *      they started and are re-offrampable (or bridgeable back to Solana).
     *
     *      On a terminal status it also does the offramp accounting cleanup:
     *      release the escrow reservation, and refund the daily SELL slot for an
     *      order that expired without any merchant accepting it. The terminal
     *      latch guarantees this runs exactly once per order.
     *
     *      Known limitation (#55): a settled dispute can drive a COMPLETED (3)
     *      SELL back to CANCELLED (4) with a refund; the latch keeps this record
     *      at its first terminal status, so the off-chain view built on
     *      `OfframpReconciled` can misreport that late transition. Left as-is on
     *      purpose — reopening the latch would risk double-releasing the escrow
     *      and slot, and the accounting correctness matters more than the
     *      observability edge. Funds are unaffected either way.
     */
    /// @dev Diamond order status: 0 PLACED, 1 ACCEPTED, 2 PAID, 3 COMPLETED,
    ///      4 CANCELLED. Only ACCEPTED is deliverable. (#72)
    uint8 private constant STATUS_ACCEPTED = 1;
    uint8 private constant STATUS_PAID = 2;

    /// @notice Flat fee headroom the user EXITS must leave on top of the escrowed
    ///         principals, so a seller cannot drain the proxy to exactly the
    ///         escrow floor after a merchant accepts and strand their own
    ///         delivery by the fee. (#90)
    /// @dev    The Diamond's SELL fee is FIXED and applies only at or under the
    ///         small-order threshold — live mainnet values 2026-08-17: $0.10 INR,
    ///         $0.05 BRL, $0.125 EUR, $0 USD/NGN, thresholds $10/$2. $1 covers
    ///         8× the largest live fee, i.e. at least eight concurrent small
    ///         SELLs. Applied only in `userRescueProxyUsdc` /
    ///         `userBridgeBackToSolana`; `userInitiateOfframp` deliberately still
    ///         escrows the bare principal — full-balance placement handling is
    ///         widget-side by the recorded #44 decision, and a headroom there
    ///         would block the max cash-out outright.
    uint256 public constant SELL_FEE_HEADROOM = 1e6;

    function _escrowFloor(address user) internal view returns (uint256) {
        uint256 pending = pendingOfframpTotal[user];
        return pending == 0 ? 0 : pending + SELL_FEE_HEADROOM;
    }

    function reconcile(uint256 orderId) external {
        OfframpRecord storage record = offramps[orderId];
        if (!record.initialized) revert OfframpRecordNotFound();
        if (record.lastStatus == 3 || record.lastStatus == 4) revert OfframpAlreadyReconciled();

        IOrderFlow.OrderView memory ord = IOrderFlow(diamond).getOrdersById(orderId);
        uint8 currentStatus = ord.status;
        record.lastStatus = currentStatus;

        if (currentStatus == 3 || currentStatus == 4) {
            // Release this order's escrow reservation (runs once, per the latch).
            uint256 amt = record.usdcAmount;
            uint256 pending = pendingOfframpTotal[record.user];
            pendingOfframpTotal[record.user] = pending > amt ? pending - amt : 0;

            // Refund the daily SELL slot ONLY for an order no merchant ever
            // accepted (expired / never taken), so a stranded-before-accept SELL
            // doesn't burn the day. A merchant-accepted order keeps its slot —
            // releasing that could be farmed to waste merchant capacity. (#51)
            if (currentStatus == 4 && ord.acceptedMerchant == address(0)) {
                uint256 day = uint256(record.placementDay);
                uint256 c = userDailyOfframpCount[record.user][day];
                if (c > 0) userDailyOfframpCount[record.user][day] = c - 1;
            }
        }
        emit OfframpReconciled(orderId, currentStatus);
    }

    // ─── Internals: proxy ─────────────────────────────────────────────

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
            // Sanity: predicted == deployed. If this ever fails, the immutable
            // args or salt have drifted.
            assert(deployed == proxy);
            emit UserProxyDeployed(user, proxy);
        }
        // Recorded outside the deploy branch so the reverse lookup is present
        // even for a proxy CCTP minted into before we first deployed it.
        if (proxyOwner[proxy] == address(0)) proxyOwner[proxy] = user;
    }

    // ─── Internals: EIP-712 attestation verification ──────────────────

    function _domainSeparator(bytes32 nameHash) private view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    _EIP712_DOMAIN_TYPEHASH,
                    nameHash,
                    _DOMAIN_VERSION,
                    block.chainid,
                    address(this)
                )
            );
    }

    function _digest(
        bytes32 nameHash,
        bytes32 typeHash,
        address wallet,
        bytes32 nullifier,
        uint256 limit,
        uint256 expiry
    ) private view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(typeHash, wallet, nullifier, limit, expiry));
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(nameHash), structHash));
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) revert InvalidSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        // Reject the high-`s` half of each signature (EIP-2): otherwise every
        // signature has a malleated twin that recovers the same signer, so the
        // sig bytes aren't a unique id for off-chain consumers.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0)
            revert InvalidSignature();
        if (v != 27 && v != 28) revert InvalidSignature();
        address signer = ecrecover(digest, v, r, s);
        // ecrecover returns address(0) for a malformed signature — never treat
        // that as a valid signer.
        if (signer == address(0)) revert InvalidSignature();
        return signer;
    }
}
