// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

/**
 * @title UnifyVaultCheckoutIntegrator
 * @notice Dual-path B2B Direct USDC Integrator for UnifyVault.
 *
 *         BUY Flow:
 *           INR/UPI → P2P.me → USDC → user's wallet (EOA)
 *         SELL Flow:
 *           USDC (user's wallet) → P2P.me → INR/UPI (user's bank account)
 *
 *         Architecture & Security Characteristics:
 *           - Registered on P2P Diamond with `usdcThroughIntegrator = false`.
 *           - Orders are placed exclusively through each user's deterministic
 *             `UserProxy` clone (CREATE2 with immutable args `(user, address(this))`).
 *           - On BUY orders: `recipientAddr = user` (the user's EOA), so the Diamond
 *             routes purchased USDC directly to the user's wallet on completion.
 *             The proxy never holds or custodies USDC.
 *           - On SELL orders: placed via `placeB2BSellOrder`. The Diamond pulls USDC
 *             directly from `order.user` (the user's EOA) upon payout delivery
 *             (`setSellOrderUpi`), and fiat is settled directly off-chain.
 *           - Gated by P2P.me Simple KYC EIP-712 attestations (Liveness tier and KYC tier).
 *           - Conforms to repository-wide conformance invariants (#77):
 *               • Immutable ceilings on all admin-tunable caps (MAX_*)
 *               • Transient storage reentrancy protection on value-moving entrypoints
 *               • Zero-address validation on attestor setters
 *               • Idempotent cancellation tolerance
 */
contract UnifyVaultCheckoutIntegrator is IP2PIntegrator {
    using Clones for address;

    // ─── Errors ───────────────────────────────────────────────────────

    error OnlyDiamond();
    error OnlyOwner();
    error InvalidAddress();
    error InvalidAmount();
    error Reentrancy();
    error CapExceedsCeiling(uint256 requested, uint256 ceiling);

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

    event UsdcDirectBuyOrderCreated(
        uint256 indexed orderId,
        address indexed user,
        uint256 amount,
        bytes32 currency
    );
    event UsdcDirectSellOrderCreated(
        uint256 indexed orderId,
        address indexed user,
        uint256 amount,
        bytes32 currency
    );
    event UsdcDirectOrderFulfilled(uint256 indexed orderId, address indexed user, uint256 amount);
    event UsdcDirectOrderCancelled(uint256 indexed orderId, address indexed user, uint256 amount);
    event UserProxyDeployed(address indexed user, address proxy);

    // ─── Tier constants ───────────────────────────────────────────────

    uint8 public constant TIER_NONE = 0;
    uint8 public constant TIER_LIVENESS = 1;
    uint8 public constant TIER_KYC = 2;

    // ─── Hard Ceilings (Immutable) ────────────────────────────────────

    uint256 public constant MAX_PER_TX_USDC = 2_000e6; // $2,000 max per-tx ceiling
    uint256 public constant MAX_DAILY_COUNT = 100; // 100 orders per day ceiling
    uint256 public constant MAX_DAILY_VOLUME = 10_000e6; // $10,000 daily volume ceiling

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
    address public livenessAttestor;
    /// @notice secp256k1 signer of the KYC service's attestations
    address public kycAttestor;

    // ─── Configurable limits (under immutable MAX_* ceilings) ─────────

    /// @notice Optional owner ceiling applied on top of the attested per-tx limit.
    uint256 public perTxUsdcCap;
    /// @notice Max number of direct USDC orders a user can place per day.
    uint256 public dailyTxCountLimit;
    /// @notice Optional per-user cumulative USDC cap per day. 0 = disabled.
    uint256 public dailyUsdcVolumeCap;

    // ─── Per-user entitlement ─────────────────────────────────────────

    mapping(address => uint256) public grantedLimit;
    mapping(address => uint8) public userTier;
    mapping(bytes32 => bool) public livenessNullifierSpent;
    mapping(bytes32 => bool) public kycNullifierSpent;

    // ─── Order accounting ─────────────────────────────────────────────

    mapping(address => mapping(uint256 => uint256)) public userDailyCount;
    mapping(address => mapping(uint256 => uint256)) public userDailyVolume;

    struct Session {
        address user; // 20 bytes
        bool fulfilled; //  1 byte
        bool cancelled; //  1 byte
        bool isSell; //  1 byte
        uint32 placementDay; //  4 bytes
        uint256 amount;
    }

    mapping(uint256 => Session) public sessions;

    // ─── Transient Reentrancy Guard (EIP-1153) ─────────────────────────

    bool private transient _entered;

    modifier nonReentrant() {
        if (_entered) revert Reentrancy();
        _entered = true;
        _;
        _entered = false;
    }

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
     * @param _dailyTxCountLimit Max direct orders per user per day.
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
        if (_dailyTxCountLimit > MAX_DAILY_COUNT)
            revert CapExceedsCeiling(_dailyTxCountLimit, MAX_DAILY_COUNT);

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
        if (attestor == address(0)) revert InvalidAddress();
        livenessAttestor = attestor;
        emit LivenessAttestorUpdated(attestor);
    }

    function setKycAttestor(address attestor) external onlyOwner {
        if (attestor == address(0)) revert InvalidAddress();
        kycAttestor = attestor;
        emit KycAttestorUpdated(attestor);
    }

    function setPerTxUsdcCap(uint256 cap) external onlyOwner {
        if (cap > MAX_PER_TX_USDC) revert CapExceedsCeiling(cap, MAX_PER_TX_USDC);
        perTxUsdcCap = cap;
        emit PerTxUsdcCapUpdated(cap);
    }

    function setDailyTxCountLimit(uint256 count) external onlyOwner {
        if (count > MAX_DAILY_COUNT) revert CapExceedsCeiling(count, MAX_DAILY_COUNT);
        dailyTxCountLimit = count;
        emit DailyTxCountLimitUpdated(count);
    }

    function setDailyUsdcVolumeCap(uint256 cap) external onlyOwner {
        if (cap > MAX_DAILY_VOLUME) revert CapExceedsCeiling(cap, MAX_DAILY_VOLUME);
        dailyUsdcVolumeCap = cap;
        emit DailyUsdcVolumeCapUpdated(cap);
    }

    // ─── Attestation intake ───────────────────────────────────────────

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

    function _applyGrant(address user, uint256 limit, uint8 tier, bytes32 nullifier) internal {
        if (limit > grantedLimit[user]) grantedLimit[user] = limit;
        if (tier > userTier[user]) userTier[user] = tier;
        emit KycClaimed(user, tier, nullifier, limit, grantedLimit[user]);
    }

    // ─── Views ────────────────────────────────────────────────────────

    function effectiveLimit(address user) public view returns (uint256) {
        uint256 lim = grantedLimit[user];
        uint256 cap = perTxUsdcCap;
        if (cap != 0 && lim > cap) return cap;
        return lim;
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

    // ─── BUY: User-Facing Onramp ──────────────────────────────────────

    function userBuyUsdc(
        uint256 amount,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) external nonReentrant returns (uint256 orderId) {
        if (amount == 0) revert InvalidAmount();

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
            isSell: false,
            placementDay: uint32(block.timestamp / 1 days),
            amount: amount
        });

        emit UsdcDirectBuyOrderCreated(orderId, msg.sender, amount, currency);
    }

    // ─── SELL: User-Facing Offramp ────────────────────────────────────

    function userPlaceSellOrder(
        uint256 amountUsdc,
        bytes32 currency,
        string calldata userPubKey,
        uint256 circleId,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) external nonReentrant returns (uint256 orderId) {
        return
            _executeSellOrder(
                amountUsdc,
                currency,
                userPubKey,
                circleId,
                preferredPaymentChannelConfigId,
                fiatAmountLimit
            );
    }

    /// @notice Ergonomic alias for `userPlaceSellOrder`
    function userSellUsdc(
        uint256 amountUsdc,
        bytes32 currency,
        uint256 circleId,
        string calldata userPubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) external nonReentrant returns (uint256 orderId) {
        return
            _executeSellOrder(
                amountUsdc,
                currency,
                userPubKey,
                circleId,
                preferredPaymentChannelConfigId,
                fiatAmountLimit
            );
    }

    function _executeSellOrder(
        uint256 amountUsdc,
        bytes32 currency,
        string calldata userPubKey,
        uint256 circleId,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) internal returns (uint256 orderId) {
        if (amountUsdc == 0) revert InvalidAmount();

        uint256 lim = effectiveLimit(msg.sender);
        if (lim == 0) revert NotKycVerified();
        if (amountUsdc > lim) revert KycLimitExceeded();
        if (
            dailyUsdcVolumeCap != 0 &&
            userDailyVolume[msg.sender][block.timestamp / 1 days] + amountUsdc > dailyUsdcVolumeCap
        ) revert DailyVolumeExceeded();

        orderId = _placeSellOrder(
            amountUsdc,
            currency,
            userPubKey,
            circleId,
            preferredPaymentChannelConfigId,
            fiatAmountLimit
        );

        sessions[orderId] = Session({
            user: msg.sender,
            fulfilled: false,
            cancelled: false,
            isSell: true,
            placementDay: uint32(block.timestamp / 1 days),
            amount: amountUsdc
        });

        emit UsdcDirectSellOrderCreated(orderId, msg.sender, amountUsdc, currency);
    }

    function _placeSellOrder(
        uint256 amountUsdc,
        bytes32 currency,
        string calldata userPubKey,
        uint256 circleId,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) internal returns (uint256) {
        address proxy = _ensureProxy(msg.sender);
        bytes memory data = abi.encodeCall(
            IB2BGateway.placeB2BSellOrder,
            (
                msg.sender,
                amountUsdc,
                currency,
                userPubKey,
                circleId,
                preferredPaymentChannelConfigId,
                fiatAmountLimit
            )
        );
        bytes memory result = UserProxy(proxy).execute(diamond, data, address(usdc), 0);
        return abi.decode(result, (uint256));
    }

    function _placeOrder(
        uint256 amount,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) internal returns (uint256) {
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

    // ─── IP2PIntegrator Callbacks ─────────────────────────────────────

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

    function onOrderComplete(
        uint256 orderId,
        address /* user */,
        uint256 /* amount */,
        address /* recipientAddr */
    ) external onlyDiamond {
        Session storage session = sessions[orderId];
        if (session.user == address(0)) return;
        if (session.fulfilled) return;
        session.fulfilled = true;
        emit UsdcDirectOrderFulfilled(orderId, session.user, session.amount);
    }

    function onOrderCancel(uint256 orderId) external onlyDiamond {
        Session storage session = sessions[orderId];
        if (session.user == address(0)) return;
        if (session.fulfilled) return;
        if (session.cancelled) return; // Idempotent: repeat cancel tolerated
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

        emit UsdcDirectOrderCancelled(orderId, session.user, session.amount);
    }

    // ─── Internals: Proxy ─────────────────────────────────────────────

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

    // ─── Internals: EIP-712 Attestation Verification ──────────────────

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
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0)
            revert InvalidSignature();
        if (v != 27 && v != 28) revert InvalidSignature();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
        return signer;
    }
}
