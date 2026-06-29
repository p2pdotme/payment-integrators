// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

/**
 * @title UsdcDirectCheckoutIntegrator
 * @notice Onramp integrator that delivers USDC DIRECTLY to the end-user's own
 *         EOA, gated by simple-kyc identity attestations.
 *
 *         Unlike the goods-delivery integrators (Marketplace, LotPot, Example)
 *         where the Diamond routes USDC to a `UserProxy` that immediately spends
 *         it on a deliverable (and the proxy blocks USDC from ever reaching the
 *         EOA), this integrator places each order with `recipientAddr = the
 *         user's EOA`. With the Diamond's `usdcThroughIntegrator = false`, the
 *         B2B gateway transfers the purchased USDC straight to that EOA on
 *         completion. The user receives spendable USDC.
 *
 *         Because this reopens the fiat -> USDC -> user-wallet path that
 *         `UserProxy` deliberately closes, every order is gated on a verified
 *         simple-kyc attestation and bounded by the attested dollar limit:
 *
 *           - No attestation        -> cannot place a USDC-direct order at all.
 *           - Liveness attestation  -> per-tx cap = the liveness-tier limit
 *                                      (e.g. $20, signed by the liveness service).
 *           - Passport + liveness   -> per-tx cap = the KYC-tier limit
 *                                      (e.g. $100, signed by the KYC service).
 *
 *         The per-tx cap is the dollar `limit` the simple-kyc service signed
 *         into the attestation — this contract does not hardcode the tier
 *         amounts, it trusts the (tier-specific) attestor. Tiers stack
 *         monotonically: claiming a higher tier raises the cap; claiming a
 *         lower one never lowers it.
 *
 *         The proxy is still used, but only as the authenticated *caller* of
 *         `placeB2BOrder` (the B2B gateway is proxy-only). It never receives or
 *         holds USDC here, so the proxy's USDC trap is not in play.
 *
 * @dev    Attestation verification is the on-chain twin of simple-kyc's
 *         off-chain Ed25519 credential: the service also signs an EIP-712
 *         struct with a secp256k1 key that this contract recovers via
 *         `ecrecover`. The digest is byte-compatible with simple-kyc's
 *         reference `KycAttestationVerifier` / `LivenessAttestationVerifier`
 *         and with contracts-v4 `RpHelper1.submitKycAttestation`
 *         (typehash `KycAttestation(address wallet,bytes32 nullifier,uint256
 *         limit,uint256 expiry)`, domain name `KycVerifier` / `LivenessVerifier`,
 *         version `1`, `verifyingContract = address(this)`).
 *
 *         One integrator == one simple-kyc tenant per service: register this
 *         contract's address as the tenant `contract_address` for both the KYC
 *         and liveness services so the server signs attestations bound to it.
 *         The per-(tenant, human) `nullifier` is spent once, so a human can
 *         claim each tier here exactly once (on-chain Sybil resistance) while
 *         remaining free to claim on other contracts.
 */
contract UsdcDirectCheckoutIntegrator is IP2PIntegrator {
    using Clones for address;

    // ─── Errors ───────────────────────────────────────────────────────

    error OnlyDiamond();
    error OnlyOwner();
    error InvalidAddress();
    error InvalidAmount();
    error OrderAlreadyFulfilled();
    error OrderAlreadyCancelled();

    // KYC / attestation
    error AttestorNotSet();
    error AttestationExpired();
    error NullifierAlreadySpent();
    error InvalidSignature();
    error NotKycVerified();
    error KycLimitExceeded();
    error DailyVolumeExceeded();

    // ─── Events ───────────────────────────────────────────────────────

    event LivenessAttestorUpdated(address indexed attestor);
    event KycAttestorUpdated(address indexed attestor);
    event PerTxUsdcCapUpdated(uint256 cap);
    event DailyTxCountLimitUpdated(uint256 count);
    event DailyUsdcVolumeCapUpdated(uint256 cap);

    /// @param tier 1 = liveness, 2 = passport + liveness (KYC)
    event KycClaimed(
        address indexed user,
        uint8 indexed tier,
        bytes32 indexed nullifier,
        uint256 attestedLimit,
        uint256 grantedLimit
    );

    event UsdcDirectOrderCreated(
        uint256 indexed orderId,
        address indexed user,
        uint256 amount,
        bytes32 currency
    );
    event UsdcDirectOrderFulfilled(uint256 indexed orderId, address indexed user, uint256 amount);
    event UserProxyDeployed(address indexed user, address proxy);

    // ─── Tier constants ───────────────────────────────────────────────

    uint8 public constant TIER_NONE = 0;
    uint8 public constant TIER_LIVENESS = 1;
    uint8 public constant TIER_KYC = 2;

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

    // ─── Attestation config ───────────────────────────────────────────

    /// @notice secp256k1 signer of the liveness service's attestations
    ///         (simple-kyc liveness verifier, GET /v1/attestor).
    address public livenessAttestor;
    /// @notice secp256k1 signer of the KYC (passport+liveness) service's
    ///         attestations (simple-kyc KYC verifier, GET /v1/attestor).
    address public kycAttestor;

    // ─── Configurable limits ──────────────────────────────────────────

    /// @notice Optional owner ceiling applied on top of the attested per-tx
    ///         limit (defense-in-depth: bounds the blast radius of a
    ///         compromised attestor key). 0 = no extra ceiling.
    uint256 public perTxUsdcCap;
    /// @notice Max number of USDC-direct orders a user can place per day.
    uint256 public dailyTxCountLimit;
    /// @notice Optional per-user cumulative USDC cap per day. 0 = disabled.
    uint256 public dailyUsdcVolumeCap;

    // ─── Per-user entitlement ─────────────────────────────────────────

    /// @notice Standing per-tx USDC ceiling (micro-USDC, 6dp) for USDC-direct
    ///         orders. Set to the highest attested tier limit the user has
    ///         claimed. 0 means "not verified" -> blocked.
    mapping(address => uint256) public grantedLimit;
    /// @notice Highest KYC tier the user has claimed (see TIER_* constants).
    mapping(address => uint8) public userTier;
    /// @notice Per-(tenant, human) nullifier sets, namespaced by service so a
    ///         liveness and a KYC nullifier can never collide.
    mapping(bytes32 => bool) public livenessNullifierSpent;
    mapping(bytes32 => bool) public kycNullifierSpent;

    // ─── Order accounting ─────────────────────────────────────────────

    mapping(address => mapping(uint256 => uint256)) public userDailyCount;
    mapping(address => mapping(uint256 => uint256)) public userDailyVolume;

    struct Session {
        address user; // 20 bytes
        bool fulfilled; //  1 byte  — packs with user
        bool cancelled; //  1 byte  — packs with user
        uint32 placementDay; //  4 bytes — pinned for onOrderCancel decrement keying
        uint256 amount;
    }

    mapping(uint256 => Session) public sessions;

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
     * @param _diamond           P2P Diamond (B2B gateway) address.
     * @param _usdc              USDC token address.
     * @param _dailyTxCountLimit Max USDC-direct orders per user per day.
     * @param _livenessAttestor  Liveness service signer (may be 0, set later).
     * @param _kycAttestor       KYC service signer (may be 0, set later).
     */
    constructor(
        address _diamond,
        address _usdc,
        uint256 _dailyTxCountLimit,
        address _livenessAttestor,
        address _kycAttestor
    ) {
        if (_diamond == address(0) || _usdc == address(0)) revert InvalidAddress();
        diamond = _diamond;
        usdc = IERC20(_usdc);
        owner = msg.sender;
        dailyTxCountLimit = _dailyTxCountLimit;
        livenessAttestor = _livenessAttestor;
        kycAttestor = _kycAttestor;
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

    function setPerTxUsdcCap(uint256 cap) external onlyOwner {
        perTxUsdcCap = cap;
        emit PerTxUsdcCapUpdated(cap);
    }

    function setDailyTxCountLimit(uint256 count) external onlyOwner {
        dailyTxCountLimit = count;
        emit DailyTxCountLimitUpdated(count);
    }

    function setDailyUsdcVolumeCap(uint256 cap) external onlyOwner {
        dailyUsdcVolumeCap = cap;
        emit DailyUsdcVolumeCapUpdated(cap);
    }

    // ─── Attestation intake ───────────────────────────────────────────

    /**
     * @notice Verify and record a liveness-tier attestation for `msg.sender`,
     *         raising their USDC-direct per-tx limit to the attested amount.
     * @param nullifier  Per-(tenant, human) Sybil nullifier from the service.
     * @param limit      Attested per-tx USDC ceiling (micro-USDC, 6dp).
     * @param expiry     Unix seconds; the attestation must be claimed before this.
     * @param signature  65-byte secp256k1 signature (r ‖ s ‖ v) from the service.
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
     *         `msg.sender`, raising their USDC-direct per-tx limit.
     * @dev    Same shape as `submitLivenessAttestation` but bound to the KYC
     *         service's domain (`KycVerifier`), typehash, attestor, and
     *         nullifier set.
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

    /// @notice The effective per-tx USDC ceiling for `user`: their granted
    ///         limit, optionally clamped by the owner's `perTxUsdcCap`.
    function effectiveLimit(address user) public view returns (uint256) {
        uint256 lim = grantedLimit[user];
        uint256 cap = perTxUsdcCap;
        if (cap != 0 && lim > cap) return cap;
        return lim;
    }

    /// @notice Predicts the deterministic proxy address for `user`. The proxy
    ///         may not be deployed yet — check `code.length` if needed.
    function proxyAddress(address user) public view returns (address) {
        return
            Clones.predictDeterministicAddressWithImmutableArgs(
                proxyImpl,
                _proxyArgs(user),
                _salt(user),
                address(this)
            );
    }

    function getRemainingDailyCount(address user) external view returns (uint256) {
        uint256 count = userDailyCount[user][block.timestamp / 1 days];
        if (count >= dailyTxCountLimit) return 0;
        return dailyTxCountLimit - count;
    }

    function getTodayVolume(address user) external view returns (uint256) {
        return userDailyVolume[user][block.timestamp / 1 days];
    }

    function getSession(uint256 orderId) external view returns (Session memory) {
        return sessions[orderId];
    }

    // ─── User-facing onramp ───────────────────────────────────────────

    /**
     * @notice Place a USDC-direct BUY order. On completion the Diamond sends
     *         `amount` USDC to the caller's own EOA. Requires a verified KYC
     *         tier whose per-tx limit covers `amount`.
     * @param amount   USDC to receive (micro-USDC, 6dp).
     * @param currency Fiat currency the user pays in (e.g. bytes32("INR")).
     */
    function userBuyUsdc(
        uint256 amount,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) external returns (uint256 orderId) {
        if (amount == 0) revert InvalidAmount();

        // Friendly pre-checks (validateOrder re-enforces these authoritatively
        // when the Diamond calls back, plus the daily count/volume bumps).
        uint256 lim = effectiveLimit(msg.sender);
        if (lim == 0) revert NotKycVerified();
        if (amount > lim) revert KycLimitExceeded();
        if (
            dailyUsdcVolumeCap != 0 &&
            userDailyVolume[msg.sender][block.timestamp / 1 days] + amount > dailyUsdcVolumeCap
        ) revert DailyVolumeExceeded();

        orderId = _placeOrder(
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
            cancelled: false,
            placementDay: uint32(block.timestamp / 1 days),
            amount: amount
        });

        emit UsdcDirectOrderCreated(orderId, msg.sender, amount, currency);
    }

    function _placeOrder(
        uint256 amount,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) internal returns (uint256) {
        // Proxy-as-placer: the B2B gateway is proxy-only (rejects direct
        // integrator calls). The user's UserProxy is the msg.sender that calls
        // placeB2BOrder; the gateway resolves it to this integrator via CREATE2.
        //
        // recipientAddr = msg.sender (the user's EOA): with
        // usdcThroughIntegrator = false the Diamond transfers the purchased
        // USDC straight to the user on completion. The proxy here is only the
        // authenticated caller and never receives USDC.
        address proxy = _ensureProxy(msg.sender);
        bytes memory data = abi.encodeCall(
            IB2BGateway.placeB2BOrder,
            (
                msg.sender,
                amount,
                currency,
                msg.sender,
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
     * @notice The Diamond's synchronous gate during placeB2BOrder. This is the
     *         authoritative KYC check: reject any order from an unverified user
     *         or above their attested per-tx limit, and enforce the daily
     *         count / volume budgets (reserving the slots on success).
     */
    function validateOrder(
        address user,
        uint256 amount,
        bytes32 /* currency */
    ) external onlyDiamond returns (bool allowed) {
        uint256 lim = effectiveLimit(user);
        if (lim == 0 || amount > lim) return false;

        uint256 dayIndex = block.timestamp / 1 days;

        uint256 count = userDailyCount[user][dayIndex];
        if (count + 1 > dailyTxCountLimit) return false;

        if (dailyUsdcVolumeCap != 0) {
            uint256 vol = userDailyVolume[user][dayIndex];
            if (vol + amount > dailyUsdcVolumeCap) return false;
            userDailyVolume[user][dayIndex] = vol + amount;
        }

        userDailyCount[user][dayIndex] = count + 1;
        return true;
    }

    /**
     * @notice Completion hook. USDC has already been delivered to the user's
     *         EOA by the Diamond (recipientAddr = user, usdcThroughIntegrator =
     *         false), so this only finalizes bookkeeping. Best-effort from the
     *         gateway's POV (wrapped in try/catch there).
     */
    function onOrderComplete(
        uint256 orderId,
        address /* user */,
        uint256 /* amount */,
        address /* recipientAddr */
    ) external onlyDiamond {
        Session storage session = sessions[orderId];
        if (session.user == address(0)) return; // unknown order — no-op
        if (session.fulfilled) revert OrderAlreadyFulfilled();
        session.fulfilled = true;
        emit UsdcDirectOrderFulfilled(orderId, session.user, session.amount);
    }

    /**
     * @notice Cancellation hook — releases the daily count (and volume) slots
     *         reserved in validateOrder, keyed on the placement-day snapshot.
     *         Tolerates unknown / already-finalized orders (best-effort).
     */
    function onOrderCancel(uint256 orderId) external onlyDiamond {
        Session storage session = sessions[orderId];
        if (session.user == address(0)) return;
        if (session.fulfilled) revert OrderAlreadyFulfilled();
        if (session.cancelled) revert OrderAlreadyCancelled();
        session.cancelled = true;

        uint256 day = uint256(session.placementDay);

        uint256 count = userDailyCount[session.user][day];
        if (count > 0) {
            userDailyCount[session.user][day] = count - 1;
        }

        if (dailyUsdcVolumeCap != 0) {
            uint256 vol = userDailyVolume[session.user][day];
            userDailyVolume[session.user][day] = vol > session.amount ? vol - session.amount : 0;
        }
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
