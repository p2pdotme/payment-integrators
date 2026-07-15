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
 *         both convert between fiat and USDC the user actually controls:
 *
 *           - No attestation        -> blocked entirely.
 *           - Liveness              -> per-tx cap = `tierCap[TIER_LIVENESS]` ($20).
 *           - Passport + liveness   -> per-tx cap = `tierCap[TIER_KYC]`      ($50).
 *
 *         The effective cap is `min(attested limit, tierCap[tier])`: the
 *         simple-kyc service signs a dollar limit into the attestation, and this
 *         contract additionally clamps it to an on-chain per-tier ceiling. The
 *         $20 / $50 tiers are therefore enforced by the contract itself and a
 *         compromised attestor key cannot authorize more than the tier allows.
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
    error OrderAlreadyFulfilled();
    error OrderAlreadyCancelled();

    // KYC / attestation
    error AttestorNotSet();
    error AttestationExpired();
    error NullifierAlreadySpent();
    error InvalidSignature();
    error NotKycVerified();
    error KycLimitExceeded();

    // Bridge
    error InvalidSolanaRecipient();
    error UnknownOrder();
    error OrderNotFulfilled();
    error AlreadyBridged();
    error RescueTooEarly();
    error NotOrderOwner();
    error WithdrawExceedsSurplus();

    // Offramp
    error OfframpDisabled();
    error OfframpNotAuthorized();
    error OfframpRecordNotFound();
    error OfframpAlreadyReconciled();
    error InsufficientBridgedFunds();

    // ─── Events ───────────────────────────────────────────────────────

    event LivenessAttestorUpdated(address indexed attestor);
    event KycAttestorUpdated(address indexed attestor);
    event TierCapUpdated(uint8 indexed tier, uint256 cap);
    event DailyTxCountLimitUpdated(uint256 count);
    event OfframpEnabledUpdated(bool enabled);
    event OfframpRelayerUpdated(address indexed relayer);
    event BridgeMaxFeeBpsUpdated(uint256 bps);
    event BridgeFinalityThresholdUpdated(uint32 threshold);
    event UsdcWithdrawn(address indexed to, uint256 amount);
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
    event OfframpReconciled(uint256 indexed orderId, uint8 status);

    // ─── Tier constants ───────────────────────────────────────────────

    uint8 public constant TIER_NONE = 0;
    uint8 public constant TIER_LIVENESS = 1;
    uint8 public constant TIER_KYC = 2;

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

    /// @notice On-chain per-tx ceiling per KYC tier (micro-USDC, 6dp):
    ///         tierCap[1] = $20 (liveness), tierCap[2] = $50 (passport+liveness).
    ///         A tier whose cap is 0 is effectively disabled.
    mapping(uint8 => uint256) public tierCap;
    /// @notice Max number of onramp BUY orders a user can place per day.
    ///         0 = no daily count limit.
    uint256 public dailyTxCountLimit;

    // ─── Offramp config ───────────────────────────────────────────────

    /// @notice Master switch for the offramp flow. Defaults ON at deploy.
    bool public offrampEnabled;
    /// @notice Optional relayer permitted to deliver UPI on a user's behalf
    ///         (in addition to the order's initiator). 0 = user-only.
    address public offrampRelayer;

    // ─── Bridge config ────────────────────────────────────────────────

    /// @notice `maxFee` passed to `depositForBurn`, as bps of the burn amount.
    ///         0 = pay no attestation fee (valid while the messenger's `minFee`
    ///         is 0, which is the case on Base Sepolia today). Raise this if
    ///         Circle starts enforcing a minimum fee, or when using Fast
    ///         Transfers, which do charge.
    uint256 public bridgeMaxFeeBps;
    /// @notice `minFinalityThreshold` passed to `depositForBurn`.
    ///         2000 = Standard Transfer (finalized, free, ~13-19 min from Base).
    ///         1000 = Fast Transfer (confirmed, seconds, charges up to maxFee).
    uint32 public bridgeMinFinalityThreshold;

    // ─── Per-user entitlement ─────────────────────────────────────────

    /// @notice Per-tx USDC ceiling attested by the simple-kyc service. The
    ///         effective cap is this clamped by `tierCap[userTier[user]]`.
    mapping(address => uint256) public grantedLimit;
    /// @notice Highest KYC tier the user has claimed (see TIER_* constants).
    mapping(address => uint8) public userTier;
    /// @notice Per-(tenant, human) nullifier sets, namespaced by service so a
    ///         liveness and a KYC nullifier can never collide.
    mapping(bytes32 => bool) public livenessNullifierSpent;
    mapping(bytes32 => bool) public kycNullifierSpent;

    // ─── Accounting ───────────────────────────────────────────────────

    mapping(address => mapping(uint256 => uint256)) public userDailyCount;

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
    }

    /// @notice Offramp records, keyed by Diamond orderId.
    mapping(uint256 => OfframpRecord) public offramps;
    /// @notice orderId => the address that initiated the offramp (may deliver UPI).
    mapping(uint256 => address) public orderInitiator;

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

    /**
     * @param _diamond            P2P Diamond (B2B gateway) address.
     * @param _usdc               Settlement + burn token. MUST be the token the
     *                            Diamond settles in; CCTP burns will only
     *                            succeed if it is also Circle-issued USDC.
     * @param _tokenMessenger     CCTP V2 TokenMessengerV2.
     * @param _messageTransmitter CCTP V2 MessageTransmitterV2.
     * @param _solanaDomain       CCTP domain of the user-facing chain (Solana = 5).
     * @param _dailyTxCountLimit  Max onramp BUYs per user per day (0 = none).
     * @param _livenessAttestor   Liveness service signer (may be 0, set later).
     * @param _kycAttestor        KYC service signer (may be 0, set later).
     * @param _livenessTxCap      Per-tx cap for the liveness tier ($20 = 20e6).
     * @param _kycTxCap           Per-tx cap for the KYC tier ($50 = 50e6).
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
        uint256 _livenessTxCap,
        uint256 _kycTxCap
    ) {
        if (
            _diamond == address(0) ||
            _usdc == address(0) ||
            _tokenMessenger == address(0) ||
            _messageTransmitter == address(0)
        ) revert InvalidAddress();

        diamond = _diamond;
        usdc = IERC20(_usdc);
        owner = msg.sender;
        tokenMessenger = ITokenMessengerV2(_tokenMessenger);
        messageTransmitter = IMessageTransmitterV2(_messageTransmitter);
        solanaDomain = _solanaDomain;
        dailyTxCountLimit = _dailyTxCountLimit;
        livenessAttestor = _livenessAttestor;
        kycAttestor = _kycAttestor;

        tierCap[TIER_LIVENESS] = _livenessTxCap;
        tierCap[TIER_KYC] = _kycTxCap;
        emit TierCapUpdated(TIER_LIVENESS, _livenessTxCap);
        emit TierCapUpdated(TIER_KYC, _kycTxCap);

        offrampEnabled = true;
        // Standard Transfer, no attestation fee — see `bridgeMaxFeeBps`.
        bridgeMinFinalityThreshold = 2000;

        proxyImpl = address(new UserProxy());
    }

    // ─── Admin ────────────────────────────────────────────────────────

    function setLivenessAttestor(address attestor) external onlyOwner {
        livenessAttestor = attestor;
        emit LivenessAttestorUpdated(attestor);
    }

    function setKycAttestor(address attestor) external onlyOwner {
        kycAttestor = attestor;
        emit KycAttestorUpdated(attestor);
    }

    /// @notice Adjust the on-chain per-tx ceiling for a KYC tier. Setting a cap
    ///         to 0 disables that tier without touching anyone's attestation.
    function setTierCap(uint8 tier, uint256 cap) external onlyOwner {
        if (tier != TIER_LIVENESS && tier != TIER_KYC) revert InvalidTier();
        tierCap[tier] = cap;
        emit TierCapUpdated(tier, cap);
    }

    function setDailyTxCountLimit(uint256 count) external onlyOwner {
        dailyTxCountLimit = count;
        emit DailyTxCountLimitUpdated(count);
    }

    function setOfframpEnabled(bool flag) external onlyOwner {
        offrampEnabled = flag;
        emit OfframpEnabledUpdated(flag);
    }

    function setOfframpRelayer(address relayer) external onlyOwner {
        offrampRelayer = relayer;
        emit OfframpRelayerUpdated(relayer);
    }

    function setBridgeMaxFeeBps(uint256 bps) external onlyOwner {
        if (bps > 10_000) revert InvalidAmount();
        bridgeMaxFeeBps = bps;
        emit BridgeMaxFeeBpsUpdated(bps);
    }

    function setBridgeMinFinalityThreshold(uint32 threshold) external onlyOwner {
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
    function withdrawUsdc(address to, uint256 amount) external onlyOwner {
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
     *                  effective cap is `min(limit, tierCap[TIER_LIVENESS])`.
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

    /// @dev Monotonic: a claim only ever raises the user's limit / tier. The
    ///      attestation `expiry` is a claim-freshness deadline (checked above),
    ///      not an ongoing clock — the per-(tenant, human) nullifier is
    ///      single-use, so an expiring grant could never be re-claimed.
    function _applyGrant(address user, uint256 limit, uint8 tier, bytes32 nullifier) internal {
        if (limit > grantedLimit[user]) grantedLimit[user] = limit;
        if (tier > userTier[user]) userTier[user] = tier;
        emit KycClaimed(user, tier, nullifier, limit, grantedLimit[user]);
    }

    // ─── Views ────────────────────────────────────────────────────────

    /**
     * @notice The effective per-tx USDC ceiling for `user`, applied to BOTH the
     *         onramp and the offramp: the limit their attestation carries,
     *         clamped by this contract's ceiling for the tier they reached.
     *         0 means "cannot transact".
     */
    function effectiveLimit(address user) public view returns (uint256) {
        uint8 tier = userTier[user];
        if (tier == TIER_NONE) return 0;
        uint256 lim = grantedLimit[user];
        uint256 cap = tierCap[tier];
        return lim < cap ? lim : cap;
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

    function getRemainingDailyCount(address user) external view returns (uint256) {
        if (dailyTxCountLimit == 0) return type(uint256).max;
        uint256 count = userDailyCount[user][block.timestamp / 1 days];
        if (count >= dailyTxCountLimit) return 0;
        return dailyTxCountLimit - count;
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
    ) external returns (uint256 orderId) {
        if (amount == 0) revert InvalidAmount();
        if (solanaRecipient == bytes32(0)) revert InvalidSolanaRecipient();

        // Friendly pre-checks; validateOrder re-enforces these authoritatively
        // when the Diamond calls back, and reserves the daily-count slot there.
        uint256 lim = effectiveLimit(msg.sender);
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
     *      checked. A BUY arrives with the user's EOA. Only BUYs consume a
     *      daily-count slot: SELLs get no `onOrderCancel` callback from the
     *      gateway, so a slot reserved for one could never be released.
     */
    function validateOrder(
        address user,
        uint256 amount,
        bytes32 /* currency */
    ) external onlyDiamond returns (bool allowed) {
        address seller = proxyOwner[user];
        if (seller != address(0)) {
            uint256 sellerLim = effectiveLimit(seller);
            return sellerLim != 0 && amount <= sellerLim;
        }

        uint256 lim = effectiveLimit(user);
        if (lim == 0 || amount > lim) return false;

        if (dailyTxCountLimit != 0) {
            uint256 dayIndex = block.timestamp / 1 days;
            uint256 count = userDailyCount[user][dayIndex];
            if (count + 1 > dailyTxCountLimit) return false;
            userDailyCount[user][dayIndex] = count + 1;
        }
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
     */
    function onOrderComplete(
        uint256 orderId,
        address /* user */,
        uint256 /* amount */,
        address /* recipientAddr */
    ) external onlyDiamond {
        Session storage session = sessions[orderId];
        if (session.user == address(0)) return; // unknown / non-BUY order — no-op
        if (session.fulfilled) revert OrderAlreadyFulfilled();
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
     */
    function onOrderCancel(uint256 orderId) external onlyDiamond {
        Session storage session = sessions[orderId];
        if (session.user == address(0)) return;
        if (session.fulfilled) revert OrderAlreadyFulfilled();
        if (session.cancelled) revert OrderAlreadyCancelled();
        session.cancelled = true;

        if (dailyTxCountLimit != 0) {
            uint256 day = uint256(session.placementDay);
            uint256 count = userDailyCount[session.user][day];
            if (count > 0) {
                userDailyCount[session.user][day] = count - 1;
            }
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
    function retryBridge(uint256 orderId) external {
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
        uint256 amount = session.amount;
        bytes32 recipient = session.solanaRecipient;
        uint256 maxFee = _maxFeeFor(amount);

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

        session.bridged = true;
        unbridgedTotal -= amount;
        emit BridgedToSolana(orderId, session.user, amount, recipient, maxFee);
    }

    /// @dev CCTP requires `maxFee < amount`; clamp so a misconfigured bps can
    ///      never make the burn unsatisfiable.
    function _maxFeeFor(uint256 amount) internal view returns (uint256) {
        uint256 fee = (amount * bridgeMaxFeeBps) / 10_000;
        if (fee >= amount) fee = amount - 1;
        return fee;
    }

    /**
     * @notice Last-resort exit for the buyer when CCTP has refused an onramp's
     *         burn for `BRIDGE_RESCUE_DELAY`: pull the USDC to their own wallet
     *         instead of leaving it stranded.
     *
     * @dev Buyer-only and delay-gated — never an owner power. This does hand the
     *      buyer Base-side USDC rather than the Solana USDC they ordered, which
     *      is a deliberate trade against permanent loss: they already paid fiat
     *      for it, they are attested, and the amount is bounded by their tier
     *      cap ($20 / $50). It is unreachable while CCTP is healthy.
     */
    function userRescueStuckBridge(uint256 orderId) external {
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
    function userBridgeBackToSolana(uint256 amount, bytes32 solanaRecipient) external {
        if (amount == 0) revert InvalidAmount();
        if (solanaRecipient == bytes32(0)) revert InvalidSolanaRecipient();

        address proxy = _ensureProxy(msg.sender);
        if (usdc.balanceOf(proxy) < amount) revert InsufficientBridgedFunds();

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
    ) external returns (uint256 orderId) {
        if (!offrampEnabled) revert OfframpDisabled();
        if (amount == 0) revert InvalidAmount();

        uint256 lim = effectiveLimit(msg.sender);
        if (lim == 0) revert NotKycVerified();
        if (amount > lim) revert KycLimitExceeded();

        address proxy = _ensureProxy(msg.sender);
        if (usdc.balanceOf(proxy) < amount) revert InsufficientBridgedFunds();

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
            initialized: true
        });
        orderInitiator[orderId] = msg.sender;

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
     *         assuming the principal. Callable by the initiator or the relayer.
     */
    function deliverOfframpUpi(uint256 orderId, string calldata encUpi) external {
        OfframpRecord memory record = offramps[orderId];
        if (!record.initialized) revert OfframpRecordNotFound();
        if (msg.sender != orderInitiator[orderId] && msg.sender != offrampRelayer) {
            revert OfframpNotAuthorized();
        }

        IOrderFlow.AdditionalOrderDetailsView memory aod = IOrderFlow(diamond)
            .getAdditionalOrderDetails(orderId);
        uint256 needed = aod.actualUsdtAmount;
        if (needed == 0) needed = record.usdcAmount;

        address proxy = _ensureProxy(record.user);
        if (usdc.balanceOf(proxy) < needed) revert InsufficientBridgedFunds();

        bytes memory data = abi.encodeCall(IOrderFlow.setSellOrderUpi, (orderId, encUpi, 0));
        UserProxy(proxy).execute(diamond, data, address(usdc), needed);

        emit OfframpUpiDelivered(orderId, needed);
    }

    /**
     * @notice Record the authoritative order status from the Diamond. Anyone can
     *         poke; the status is read from the Diamond rather than supplied by
     *         the caller, so a wrong value can't grief the record.
     *
     * @dev No refund handling: a cancel-while-PAID returns USDC to `order.user`,
     *      which is the seller's own proxy, so the funds are already back where
     *      they started and are re-offrampable (or bridgeable back to Solana).
     */
    function reconcile(uint256 orderId) external {
        OfframpRecord storage record = offramps[orderId];
        if (!record.initialized) revert OfframpRecordNotFound();
        if (record.lastStatus == 3 || record.lastStatus == 4) revert OfframpAlreadyReconciled();

        uint8 currentStatus = IOrderFlow(diamond).getOrdersById(orderId).status;
        record.lastStatus = currentStatus;
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
