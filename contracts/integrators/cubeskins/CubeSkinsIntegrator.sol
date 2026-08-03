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
 *         same shape ShowdownCheckoutIntegrator uses. Register with
 *         **`usdcThroughIntegrator = false`**, matching every other integrator.
 *         (For this contract the flag is in fact behaviourally inert — the
 *         gateway sends to `recipientAddr` when false and to the integrator when
 *         true, and the recipient pin makes those the same address. `false` is
 *         still the correct registration; see docs/integrators/cubeskins.md.)
 *
 * @dev    Limits: per-tx ceilings are gated on a **liveness** attestation, not
 *         on RP.
 *
 *           - No attestation       -> cannot place an order at all.
 *           - Liveness attestation -> per-tx cap = min(attested limit,
 *                                     livenessTierCap).
 *
 *         The liveness service signs a dollar limit into the attestation and
 *         this contract additionally clamps it to an on-chain ceiling, so a
 *         compromised attestor key cannot authorize more than policy allows.
 *         Attestation verification is the on-chain twin of the service's
 *         `LivenessAttestationVerifier`: EIP-712 typehash
 *         `LivenessAttestation(address wallet,bytes32 nullifier,uint256 limit,uint256 expiry)`,
 *         domain name `LivenessVerifier`, recovered with `ecrecover`. Register
 *         this contract's address as the tenant `contract_address` with the
 *         liveness service so attestations are bound to it; the per-(tenant,
 *         human) `nullifier` is single-use for on-chain Sybil resistance.
 *
 * @dev    Limits are bounded by immutable policy ceilings. A whitelisted
 *         integrator bypasses the protocol's own RP / daily / monthly / yearly
 *         volume limits and is trusted to enforce its own in `validateOrder`,
 *         so an owner-raisable cap would be a protocol lever, not partner
 *         config: a compromised owner key could re-point the attestor at itself,
 *         self-attest an arbitrary limit, lift the cap and route unbounded
 *         fiat→USDC through P2P's LP network. `MAX_LIVENESS_TIER_CAP` and
 *         `MAX_DAILY_TX_COUNT_LIMIT` are committed to the bytecode and enforced
 *         in both the constructor and the setters — the owner may tighten
 *         policy, never loosen it past what was reviewed.
 *
 * @dev    Neither protocol callback ever reverts. The gateway wraps both in
 *         try/catch and finalises protocol state regardless, so a revert cannot
 *         undo anything — it can only strand settlement USDC in an immutable
 *         contract or silently drop a daily-count refund. Disagreements are
 *         reported as `SettlementAnomaly` for off-chain reconciliation instead.
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
    error BuyerMismatch();

    /// @notice A limit was set above its immutable policy ceiling, or a daily
    ///         count was set to 0 ("unlimited") — the hole in the ceiling.
    error CapExceedsCeiling();

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
    event LivenessTierCapUpdated(uint256 cap);
    event DailyTxCountLimitUpdated(uint256 count);
    event UsdcSwept(address indexed to, uint256 amount);
    /// @param tier 1 = liveness
    event LivenessClaimed(
        address indexed user,
        uint8 indexed tier,
        bytes32 nullifier,
        uint256 attestedLimit,
        uint256 grantedLimit
    );
    /**
     * @notice `onOrderComplete` settled against state that disagreed with what
     *         the gateway reported. The USDC has already been forwarded — this
     *         is a reconciliation signal, not a failure.
     * @param reason    One of the `ANOMALY_*` codes.
     * @param expected  What this contract had recorded for the order (0 if none).
     * @param actual    What the gateway reported (or the balance actually held,
     *                  for `ANOMALY_SHORT_BALANCE`).
     * @param forwarded USDC actually sent to `treasury` in this call.
     */
    event SettlementAnomaly(
        uint256 indexed p2pOrderId,
        uint8 indexed reason,
        uint256 expected,
        uint256 actual,
        uint256 forwarded
    );

    // ─── Tier constants ───────────────────────────────────────────────

    uint8 public constant TIER_NONE = 0;
    uint8 public constant TIER_LIVENESS = 1;

    // ─── Settlement anomaly codes ─────────────────────────────────────

    /// @notice Settled an order this contract has no session for.
    uint8 public constant ANOMALY_UNKNOWN_ORDER = 1;
    /// @notice Settled an order already marked fulfilled.
    uint8 public constant ANOMALY_ALREADY_FULFILLED = 2;
    /// @notice Settled an order whose session was already cancelled.
    uint8 public constant ANOMALY_SESSION_CANCELLED = 3;
    /// @notice Gateway amount differed from the amount pinned at placement.
    uint8 public constant ANOMALY_AMOUNT_MISMATCH = 4;
    /// @notice Held less USDC than the gateway said it settled.
    uint8 public constant ANOMALY_SHORT_BALANCE = 5;

    // ─── Immutable policy ceilings ────────────────────────────────────

    /// @notice Hard ceiling on the liveness per-tx cap (200 USDC, 6dp) — the
    ///         approved CubeSkins policy figure. The owner may set any cap at
    ///         or below this, including 0 to pause new orders, but can never
    ///         exceed it. Raising policy requires a new deploy and a fresh
    ///         whitelist review.
    uint256 public constant MAX_LIVENESS_TIER_CAP = 200e6;
    /// @notice Hard ceiling on orders per user per UTC day.
    uint256 public constant MAX_DAILY_TX_COUNT_LIMIT = 5;

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
    ///         on CubeSkins' behalf for testnet). Cannot be transferred or
    ///         renounced: deploy with the key that will operate in production.
    address public immutable owner;
    address public immutable proxyImpl;

    // ─── Attestation config ───────────────────────────────────────────

    /// @notice secp256k1 signer of the liveness service's attestations.
    address public livenessAttestor;

    // ─── Configurable limits (bounded by the ceilings above) ──────────

    /// @notice On-chain per-tx ceiling for the liveness tier (micro-USDC, 6dp).
    ///         Never above `MAX_LIVENESS_TIER_CAP`. 0 pauses new orders.
    uint256 public livenessTierCap;
    /// @notice Max orders per user per UTC day. Always 1..`MAX_DAILY_TX_COUNT_LIMIT`
    ///         — 0 is rejected, since "no limit" would defeat the ceiling.
    uint256 public dailyTxCountLimit;

    // ─── Per-user entitlement ─────────────────────────────────────────

    /// @notice Per-tx USDC ceiling attested by the liveness service. The
    ///         effective cap is this clamped by `livenessTierCap`.
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
     * @param _livenessTierCap   Per-tx ceiling, 0..`MAX_LIVENESS_TIER_CAP` (6dp).
     * @param _dailyTxCountLimit Orders per user per UTC day, 1..`MAX_DAILY_TX_COUNT_LIMIT`.
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
        // Same bounds as the setters — a deploy cannot start outside policy.
        if (_livenessTierCap > MAX_LIVENESS_TIER_CAP) revert CapExceedsCeiling();
        if (_dailyTxCountLimit == 0 || _dailyTxCountLimit > MAX_DAILY_TX_COUNT_LIMIT) {
            revert CapExceedsCeiling();
        }

        diamond = _diamond;
        usdc = IERC20(_usdc);
        treasury = _treasury;
        owner = _owner;
        livenessTierCap = _livenessTierCap;
        dailyTxCountLimit = _dailyTxCountLimit;
        livenessAttestor = _livenessAttestor;
        proxyImpl = address(new UserProxy());

        emit LivenessTierCapUpdated(_livenessTierCap);
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

    /// @notice Set the liveness per-tx cap. Can only ever set a value at or
    ///         below the immutable `MAX_LIVENESS_TIER_CAP` — the owner may
    ///         tighten policy, never raise past what the bytecode commits to.
    ///         0 is allowed and pauses new orders.
    function setLivenessTierCap(uint256 cap) external onlyOwner {
        if (cap > MAX_LIVENESS_TIER_CAP) revert CapExceedsCeiling();
        livenessTierCap = cap;
        emit LivenessTierCapUpdated(cap);
    }

    /// @notice Set orders per user per UTC day. Must be 1..`MAX_DAILY_TX_COUNT_LIMIT`;
    ///         0 is rejected because "unlimited" would defeat the ceiling.
    function setDailyTxCountLimit(uint256 count) external onlyOwner {
        if (count == 0 || count > MAX_DAILY_TX_COUNT_LIMIT) revert CapExceedsCeiling();
        dailyTxCountLimit = count;
        emit DailyTxCountLimitUpdated(count);
    }

    /**
     * @notice Recover USDC sitting on this contract.
     * @dev    Settlement USDC never rests here — `onOrderComplete` forwards it
     *         to `treasury` in the same call. Any balance is therefore money
     *         that arrived outside the order flow (a mistaken direct transfer,
     *         or a settlement whose callback could not be matched to a
     *         session). Without this, such funds would be locked forever in a
     *         contract that cannot be upgraded.
     */
    function sweepUsdc(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert InvalidAddress();
        usdc.safeTransfer(to, amount);
        emit UsdcSwept(to, amount);
    }

    // ─── Attestations ─────────────────────────────────────────────────

    /**
     * @notice Verify and record a liveness-tier attestation for `msg.sender`.
     * @param nullifier Per-(tenant, human) Sybil nullifier from the service.
     * @param limit     Attested per-tx USDC ceiling (micro-USDC, 6dp). The
     *                  effective cap is `min(limit, livenessTierCap)`.
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

        emit LivenessClaimed(msg.sender, TIER_LIVENESS, nullifier, limit, grantedLimit[msg.sender]);
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

        uint256 dayIndex = block.timestamp / 1 days;
        uint256 count = userDailyCount[user][dayIndex];
        if (count + 1 > dailyTxCountLimit) return false;
        userDailyCount[user][dayIndex] = count + 1;

        return true;
    }

    /**
     * @dev Settlement USDC arrives here because `userPlaceOrder` pinned
     *      `recipientAddr = address(this)`.
     *
     *      This function never reverts. The gateway transfers the USDC before
     *      calling, wraps the call in try/catch, and finalises the order either
     *      way — so a revert cannot undo the transfer, it can only leave the
     *      USDC stranded in a contract that can never be upgraded. Funds are
     *      therefore forwarded first and bookkeeping disagreements are reported
     *      as `SettlementAnomaly` rather than raised.
     *
     *      Validation is deliberately scoped to the session: the session is
     *      immutable once written, whereas the registration is owner-mutable,
     *      and re-reading it here would let an admin action desynchronise a
     *      settled order.
     */
    function onOrderComplete(
        uint256 orderId,
        address /* user */,
        uint256 amount,
        address /* recipientAddr */
    ) external onlyDiamond {
        // Forward whatever actually arrived, capped by the balance held so a
        // short or duplicate delivery can never revert on an underflowing
        // transfer.
        uint256 balance = usdc.balanceOf(address(this));
        uint256 forwarded = amount < balance ? amount : balance;
        if (forwarded > 0) {
            usdc.safeTransfer(treasury, forwarded);
        }
        if (forwarded < amount) {
            emit SettlementAnomaly(orderId, ANOMALY_SHORT_BALANCE, amount, balance, forwarded);
        }

        CheckoutSession storage session = sessions[orderId];
        if (session.user == address(0)) {
            emit SettlementAnomaly(orderId, ANOMALY_UNKNOWN_ORDER, 0, amount, forwarded);
            return;
        }
        if (session.fulfilled) {
            emit SettlementAnomaly(
                orderId,
                ANOMALY_ALREADY_FULFILLED,
                session.usdcAmount,
                amount,
                forwarded
            );
            return;
        }
        if (session.cancelled) {
            emit SettlementAnomaly(
                orderId,
                ANOMALY_SESSION_CANCELLED,
                session.usdcAmount,
                amount,
                forwarded
            );
        }
        if (session.usdcAmount != amount) {
            emit SettlementAnomaly(
                orderId,
                ANOMALY_AMOUNT_MISMATCH,
                session.usdcAmount,
                amount,
                forwarded
            );
        }

        session.fulfilled = true;
        registrations[session.marketplaceOrderId].fulfilled = true;

        // Carries what actually reached the treasury, not what the gateway
        // claimed — the indexer marks the marketplace order paid off this, and
        // on the happy path the two are identical anyway.
        emit CheckoutFulfilled(orderId, session.user, session.marketplaceOrderId, forwarded);
    }

    /**
     * @dev Releases the per-user accounting consumed at placement: the daily
     *      count slot, and the registration's `placed` flag so the buyer can
     *      retry the same marketplace order.
     *
     *      Never reverts, per the interface contract ("tolerate being called
     *      with an unknown orderId or after another cancellation"). The gateway
     *      try/catches this, so a revert would not block cancellation — it would
     *      silently drop the refund and surface only as a
     *      `B2BIntegratorCallbackFailed` event.
     */
    function onOrderCancel(uint256 orderId) external onlyDiamond {
        CheckoutSession storage session = sessions[orderId];
        if (session.user == address(0)) return;
        if (session.fulfilled || session.cancelled) return;
        session.cancelled = true;

        OrderRegistration storage reg = registrations[session.marketplaceOrderId];
        if (!reg.fulfilled) {
            reg.placed = false;
        }

        uint256 day = uint256(session.placementDay);
        uint256 count = userDailyCount[session.user][day];
        if (count > 0) {
            userDailyCount[session.user][day] = count - 1;
        }
    }

    // ─── Views ────────────────────────────────────────────────────────

    /**
     * @notice The effective per-tx USDC ceiling for `user`: the limit their
     *         attestation carries, clamped by this contract's tier ceiling.
     *         0 means "cannot transact". Gate the checkout UI on this.
     */
    function effectiveLimit(address user) public view returns (uint256) {
        if (userTier[user] == TIER_NONE) return 0;
        uint256 lim = grantedLimit[user];
        return lim < livenessTierCap ? lim : livenessTierCap;
    }

    /// @notice Back-compat view for readers written against the old
    ///         `tierCap(uint8)` mapping. Prefer `livenessTierCap`.
    function tierCap(uint8 tier) external view returns (uint256) {
        return tier == TIER_LIVENESS ? livenessTierCap : 0;
    }

    function getProductPrice(uint256 marketplaceOrderId) external view returns (uint256) {
        OrderRegistration storage reg = registrations[marketplaceOrderId];
        if (reg.fulfilled || reg.buyer == address(0)) return 0;
        return reg.usdcAmount;
    }

    function getRemainingDailyCount(address user) external view returns (uint256) {
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
