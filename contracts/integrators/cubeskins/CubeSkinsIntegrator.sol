// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

/**
 * @title CubeSkinsIntegrator
 * @notice P2P onramp integrator for CubeSkins marketplace purchases (PIX → USDC).
 *         Order prices and buyer wallets are registered off-chain by the
 *         integrator owner before `userPlaceOrder` — users cannot alter amounts.
 *         On fiat settlement USDC is routed to the company treasury; the
 *         backend indexer marks the marketplace order as paid.
 *
 * @dev    Settlement routing: `userPlaceOrder` pins `recipientAddr = address(this)`,
 *         so the Diamond delivers completion USDC straight to this contract and
 *         `onOrderComplete` forwards it to the immutable `treasury`. This is the
 *         same shape ShowdownCheckoutIntegrator uses, and it means the integrator
 *         MUST be registered with **`usdcThroughIntegrator = false`** — the
 *         recipient pin already does the routing. See docs/integrators/cubeskins.md.
 *
 * @dev    Limits: per-tx ceilings are gated on a simple-kyc **liveness**
 *         attestation, not on RP.
 *
 *           - No attestation       -> cannot place an order at all.
 *           - Liveness attestation -> per-tx cap = min(attested limit,
 *                                     tierCap[TIER_LIVENESS]).
 *
 *         The simple-kyc service signs a dollar limit into the attestation and
 *         this contract additionally clamps it to an on-chain per-tier ceiling,
 *         so a compromised attestor key cannot authorize more than the tier
 *         allows. Attestation verification is the on-chain twin of simple-kyc's
 *         `LivenessAttestationVerifier`: EIP-712 typehash
 *         `LivenessAttestation(address wallet,bytes32 nullifier,uint256 limit,uint256 expiry)`,
 *         domain name `LivenessVerifier`, recovered with `ecrecover`. Register
 *         this contract's address as the tenant `contract_address` with the
 *         liveness service so attestations are bound to it; the per-(tenant,
 *         human) `nullifier` is single-use for on-chain Sybil resistance.
 */
contract CubeSkinsIntegrator is IP2PIntegrator {
    using SafeERC20 for IERC20;
    using Clones for address;

    // ─── Errors ───────────────────────────────────────────────────────

    error OnlyDiamond();
    error OnlyOwner();
    error InvalidAddress();
    error InvalidAmount();
    error OrderNotRegistered();
    error OrderExpired();
    error OrderAlreadyPlaced();
    error OrderAlreadyFulfilled();
    error OrderAlreadyCancelled();
    error BuyerMismatch();
    error AmountMismatch();
    error UnknownOrder();

    // KYC / attestation
    error AttestorNotSet();
    error AttestationExpired();
    error NullifierAlreadySpent();
    error InvalidSignature();

    // ─── Events ───────────────────────────────────────────────────────

    event OrderRegistered(
        uint256 indexed marketplaceOrderId,
        address indexed buyer,
        uint256 usdcAmount,
        uint64 expiresAt
    );
    event OrderRegistrationCancelled(uint256 indexed marketplaceOrderId);
    event CheckoutOrderCreated(
        uint256 indexed p2pOrderId,
        address indexed user,
        uint256 indexed marketplaceOrderId,
        uint256 usdcAmount
    );
    event CheckoutFulfilled(
        uint256 indexed p2pOrderId,
        address indexed user,
        uint256 indexed marketplaceOrderId,
        uint256 usdcAmount
    );
    event UserProxyDeployed(address indexed user, address proxy);
    event LivenessAttestorUpdated(address indexed attestor);
    event TierCapUpdated(uint8 indexed tier, uint256 cap);
    event DailyTxCountLimitUpdated(uint256 count);
    /// @param tier 1 = liveness
    event LivenessClaimed(
        address indexed user,
        uint8 indexed tier,
        bytes32 nullifier,
        uint256 attestedLimit,
        uint256 grantedLimit
    );

    // ─── Tier constants ───────────────────────────────────────────────

    uint8 public constant TIER_NONE = 0;
    uint8 public constant TIER_LIVENESS = 1;

    // ─── EIP-712 constants ────────────────────────────────────────────

    /// @dev keccak256("LivenessAttestation(address wallet,bytes32 nullifier,uint256 limit,uint256 expiry)")
    bytes32 private constant _LIVENESS_TYPEHASH =
        keccak256(
            "LivenessAttestation(address wallet,bytes32 nullifier,uint256 limit,uint256 expiry)"
        );
    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
    bytes32 private constant _LIVENESS_DOMAIN_NAME = keccak256(bytes("LivenessVerifier"));
    bytes32 private constant _DOMAIN_VERSION = keccak256(bytes("1"));

    // ─── Immutables ───────────────────────────────────────────────────

    address public immutable diamond;
    IERC20 public immutable usdc;
    address public immutable treasury;
    /// @notice Admin key — the CubeSkins backend relayer. Set explicitly at
    ///         construction rather than taken from `msg.sender`, so the
    ///         deploying key and the operating key can differ (P2P may deploy
    ///         on CubeSkins' behalf for testnet).
    address public immutable owner;
    address public immutable proxyImpl;

    // ─── Attestation config ───────────────────────────────────────────

    /// @notice secp256k1 signer of the liveness service's attestations.
    address public livenessAttestor;

    // ─── Configurable limits ──────────────────────────────────────────

    /// @notice On-chain per-tx ceiling per tier (micro-USDC, 6dp).
    ///         A tier whose cap is 0 is effectively disabled.
    mapping(uint8 => uint256) public tierCap;
    /// @notice Max orders per user per UTC day. 0 = no daily count limit.
    uint256 public dailyTxCountLimit;

    // ─── Per-user entitlement ─────────────────────────────────────────

    /// @notice Per-tx USDC ceiling attested by the simple-kyc service. The
    ///         effective cap is this clamped by `tierCap[userTier[user]]`.
    mapping(address => uint256) public grantedLimit;
    /// @notice Highest tier the user has claimed (see TIER_* constants).
    mapping(address => uint8) public userTier;
    /// @notice Per-(tenant, human) Sybil nullifiers already consumed.
    mapping(bytes32 => bool) public livenessNullifierSpent;

    // ─── State ────────────────────────────────────────────────────────

    struct OrderRegistration {
        address buyer;
        uint256 usdcAmount;
        uint64 expiresAt;
        bool placed;
        bool fulfilled;
    }

    struct CheckoutSession {
        address user;
        bool fulfilled;
        bool cancelled;
        uint32 placementDay;
        uint256 marketplaceOrderId;
        uint256 usdcAmount;
    }

    mapping(uint256 => OrderRegistration) public registrations;
    mapping(uint256 => CheckoutSession) public sessions;
    mapping(address => mapping(uint256 => uint256)) public userDailyCount;

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
     * @param _usdc              Settlement token the Diamond pays out in.
     * @param _treasury          Immutable sink for settled USDC.
     * @param _owner             Admin key (CubeSkins backend relayer).
     * @param _livenessTierCap   Per-tx ceiling for the liveness tier (6dp).
     * @param _dailyTxCountLimit Max orders per user per UTC day (0 = none).
     * @param _livenessAttestor  Liveness service signer (may be 0, set later).
     */
    constructor(
        address _diamond,
        address _usdc,
        address _treasury,
        address _owner,
        uint256 _livenessTierCap,
        uint256 _dailyTxCountLimit,
        address _livenessAttestor
    ) {
        if (
            _diamond == address(0) ||
            _usdc == address(0) ||
            _treasury == address(0) ||
            _owner == address(0)
        ) {
            revert InvalidAddress();
        }
        diamond = _diamond;
        usdc = IERC20(_usdc);
        treasury = _treasury;
        owner = _owner;
        tierCap[TIER_LIVENESS] = _livenessTierCap;
        dailyTxCountLimit = _dailyTxCountLimit;
        livenessAttestor = _livenessAttestor;
        proxyImpl = address(new UserProxy());

        emit TierCapUpdated(TIER_LIVENESS, _livenessTierCap);
        emit DailyTxCountLimitUpdated(_dailyTxCountLimit);
        emit LivenessAttestorUpdated(_livenessAttestor);
    }

    // ─── Admin: order registration ────────────────────────────────────

    /// @notice Registers a marketplace order before the buyer can pay via P2P.
    ///         Only the owner (CubeSkins backend relayer) may set price + buyer.
    /// @dev    Rejects re-registration of an order that already has a live P2P
    ///         session (`placed`). Mutating a registration mid-flight would let
    ///         the buyer place a second order against one marketplace order, and
    ///         would desynchronise the live session's amount. Cancel the P2P
    ///         order first (which clears `placed` via `onOrderCancel`), or use a
    ///         fresh `marketplaceOrderId`.
    function registerOrder(
        uint256 marketplaceOrderId,
        address buyer,
        uint256 usdcAmount,
        uint64 expiresAt
    ) external onlyOwner {
        if (buyer == address(0)) revert InvalidAddress();
        if (usdcAmount == 0) revert InvalidAmount();
        if (expiresAt <= block.timestamp) revert OrderExpired();

        OrderRegistration storage reg = registrations[marketplaceOrderId];
        if (reg.fulfilled) revert OrderAlreadyFulfilled();
        if (reg.placed) revert OrderAlreadyPlaced();

        reg.buyer = buyer;
        reg.usdcAmount = usdcAmount;
        reg.expiresAt = expiresAt;

        emit OrderRegistered(marketplaceOrderId, buyer, usdcAmount, expiresAt);
    }

    /// @notice Cancels a pending registration (e.g. order expired in backend).
    /// @dev    Refuses to delete a registration that has a live P2P session.
    ///         Deleting mid-flight used to strand the order: `onOrderComplete`
    ///         would read a zeroed registration and revert, so the Diamond could
    ///         never finalise a settled order.
    function cancelRegistration(uint256 marketplaceOrderId) external onlyOwner {
        OrderRegistration storage reg = registrations[marketplaceOrderId];
        if (reg.fulfilled) revert OrderAlreadyFulfilled();
        if (reg.placed) revert OrderAlreadyPlaced();
        delete registrations[marketplaceOrderId];
        emit OrderRegistrationCancelled(marketplaceOrderId);
    }

    // ─── Admin: limits + attestation config ───────────────────────────

    function setLivenessAttestor(address attestor) external onlyOwner {
        livenessAttestor = attestor;
        emit LivenessAttestorUpdated(attestor);
    }

    function setTierCap(uint8 tier, uint256 cap) external onlyOwner {
        tierCap[tier] = cap;
        emit TierCapUpdated(tier, cap);
    }

    function setDailyTxCountLimit(uint256 count) external onlyOwner {
        dailyTxCountLimit = count;
        emit DailyTxCountLimitUpdated(count);
    }

    // ─── Attestations ─────────────────────────────────────────────────

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

        bytes32 digest = _digest(msg.sender, nullifier, limit, expiry);
        if (_recover(digest, signature) != livenessAttestor) revert InvalidSignature();

        livenessNullifierSpent[nullifier] = true;

        // Monotonic: a claim only ever raises the user's limit / tier. The
        // `expiry` is a claim-freshness deadline, not an ongoing clock — the
        // nullifier is single-use, so a grant can never be re-claimed.
        if (limit > grantedLimit[msg.sender]) grantedLimit[msg.sender] = limit;
        if (TIER_LIVENESS > userTier[msg.sender]) userTier[msg.sender] = TIER_LIVENESS;

        emit LivenessClaimed(
            msg.sender,
            TIER_LIVENESS,
            nullifier,
            limit,
            grantedLimit[msg.sender]
        );
    }

    // ─── User-facing placement ────────────────────────────────────────

    /// @notice Places a P2P buy order for a pre-registered marketplace order.
    ///         `marketplaceOrderId` is the CubeSkins DB order id; USDC amount
    ///         is read from the owner registration — never from user input.
    function userPlaceOrder(
        uint256 marketplaceOrderId,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) external returns (uint256 orderId) {
        OrderRegistration storage reg = registrations[marketplaceOrderId];
        if (reg.buyer == address(0) || reg.usdcAmount == 0) revert OrderNotRegistered();
        if (reg.buyer != msg.sender) revert BuyerMismatch();
        if (reg.placed || reg.fulfilled) revert OrderAlreadyPlaced();
        if (block.timestamp > reg.expiresAt) revert OrderExpired();

        uint256 totalPrice = reg.usdcAmount;
        reg.placed = true;

        address proxy = _ensureProxy(msg.sender);
        bytes memory data = abi.encodeCall(
            IB2BGateway.placeB2BOrder,
            (
                msg.sender,
                totalPrice,
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

        sessions[orderId] = CheckoutSession({
            user: msg.sender,
            marketplaceOrderId: marketplaceOrderId,
            usdcAmount: totalPrice,
            fulfilled: false,
            cancelled: false,
            placementDay: uint32(block.timestamp / 1 days)
        });

        emit CheckoutOrderCreated(orderId, msg.sender, marketplaceOrderId, totalPrice);
    }

    // ─── IP2PIntegrator callbacks ───────────────────────────────────────

    function validateOrder(
        address user,
        uint256 amount,
        bytes32 /* currency */
    ) external onlyDiamond returns (bool allowed) {
        // Tier gate: no liveness attestation -> effectiveLimit is 0 -> blocked.
        if (amount > effectiveLimit(user)) return false;

        if (dailyTxCountLimit != 0) {
            uint256 dayIndex = block.timestamp / 1 days;
            uint256 count = userDailyCount[user][dayIndex];
            if (count + 1 > dailyTxCountLimit) return false;
            userDailyCount[user][dayIndex] = count + 1;
        }
        return true;
    }

    /// @dev Settlement USDC arrives here because `userPlaceOrder` pinned
    ///      `recipientAddr = address(this)`. Validation is deliberately scoped
    ///      to the session only: the session is immutable once written, whereas
    ///      the registration is owner-mutable, and re-reading it here would let
    ///      an admin action make a settled order permanently unfinalisable.
    function onOrderComplete(
        uint256 orderId,
        address /* user */,
        uint256 amount,
        address /* recipientAddr */
    ) external onlyDiamond {
        CheckoutSession storage session = sessions[orderId];
        if (session.user == address(0)) revert UnknownOrder();
        if (session.cancelled) revert OrderAlreadyCancelled();
        if (session.fulfilled) revert OrderAlreadyFulfilled();
        if (session.usdcAmount != amount) revert AmountMismatch();

        session.fulfilled = true;
        registrations[session.marketplaceOrderId].fulfilled = true;

        usdc.safeTransfer(treasury, amount);

        emit CheckoutFulfilled(orderId, session.user, session.marketplaceOrderId, amount);
    }

    function onOrderCancel(uint256 orderId) external onlyDiamond {
        CheckoutSession storage session = sessions[orderId];
        if (session.user == address(0)) return;
        if (session.fulfilled) revert OrderAlreadyFulfilled();
        if (session.cancelled) revert OrderAlreadyCancelled();
        session.cancelled = true;

        // Release the registration so the buyer can retry the same marketplace
        // order, and give back the daily-count slot reserved in validateOrder.
        OrderRegistration storage reg = registrations[session.marketplaceOrderId];
        if (!reg.fulfilled) {
            reg.placed = false;
        }

        if (dailyTxCountLimit != 0) {
            uint256 day = uint256(session.placementDay);
            uint256 count = userDailyCount[session.user][day];
            if (count > 0) {
                userDailyCount[session.user][day] = count - 1;
            }
        }
    }

    // ─── Views ────────────────────────────────────────────────────────

    /**
     * @notice The effective per-tx USDC ceiling for `user`: the limit their
     *         attestation carries, clamped by this contract's ceiling for the
     *         tier they reached. 0 means "cannot transact".
     */
    function effectiveLimit(address user) public view returns (uint256) {
        uint8 tier = userTier[user];
        if (tier == TIER_NONE) return 0;
        uint256 lim = grantedLimit[user];
        uint256 cap = tierCap[tier];
        return lim < cap ? lim : cap;
    }

    function getProductPrice(uint256 marketplaceOrderId) external view returns (uint256) {
        OrderRegistration storage reg = registrations[marketplaceOrderId];
        if (reg.fulfilled || reg.buyer == address(0)) return 0;
        return reg.usdcAmount;
    }

    function getRemainingDailyCount(address user) external view returns (uint256) {
        if (dailyTxCountLimit == 0) return type(uint256).max;
        uint256 dayIndex = block.timestamp / 1 days;
        uint256 count = userDailyCount[user][dayIndex];
        if (count >= dailyTxCountLimit) return 0;
        return dailyTxCountLimit - count;
    }

    function getSession(uint256 orderId) external view returns (CheckoutSession memory) {
        return sessions[orderId];
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

    // ─── Internal ─────────────────────────────────────────────────────

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

    // ─── Internals: EIP-712 attestation verification ──────────────────

    function _domainSeparator() private view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    _EIP712_DOMAIN_TYPEHASH,
                    _LIVENESS_DOMAIN_NAME,
                    _DOMAIN_VERSION,
                    block.chainid,
                    address(this)
                )
            );
    }

    function _digest(
        address wallet,
        bytes32 nullifier,
        uint256 limit,
        uint256 expiry
    ) private view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(_LIVENESS_TYPEHASH, wallet, nullifier, limit, expiry)
        );
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
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
        if (signer == address(0)) revert InvalidSignature();
        return signer;
    }
}
