// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

/**
 * @title PlasmaPayCheckoutIntegrator
 * @notice Fiat -> Base USDC onramp for PlasmaPay, gated on a single
 *         verification tier: a simple-kyc **liveness** attestation.
 *
 *         ── Where the money goes ─────────────────────────────────────────
 *         The purchased USDC is delivered by the Diamond DIRECTLY to the
 *         buyer's own Base wallet. `recipientAddr` is pinned to `msg.sender`
 *         at placement and there is no recipient parameter anywhere in this
 *         contract, so a caller can only ever buy USDC for themselves.
 *         Registered with `usdcThroughIntegrator = false`, neither this
 *         contract nor the buyer's `UserProxy` is ever in the settlement
 *         path: this integrator has NO custody of user funds at any point,
 *         and therefore no rescue, retry, or refund machinery to get them
 *         back.
 *
 *         ── Why an integrator at all ─────────────────────────────────────
 *         PlasmaPay's existing ramp uses the direct-user path, where the
 *         Diamond sizes orders from the wallet's Reputation Points and a
 *         zero-RP wallet cannot place any order at all. That is a cold-start
 *         wall: a first-time user has to complete a full identity check
 *         before they can move a single dollar. A whitelisted integrator
 *         bypasses the protocol's RP limits and enforces its own in
 *         `validateOrder`, which is what lets a liveness check — a selfie,
 *         seconds, no documents — carry a small starting limit instead.
 *
 *         ── The verification gate ────────────────────────────────────────
 *         One tier, no ladder: a wallet transacts only after it presents a
 *         liveness attestation signed by the simple-kyc service. The
 *         attestation carries a dollar limit, and this contract clamps it to
 *         an on-chain ceiling:
 *
 *           | tier     | per tx | per day  |
 *           |----------|--------|----------|
 *           | liveness | $20    | 5 orders |
 *
 *         The effective per-tx cap is `min(attested limit, livenessTierCap)`,
 *         so a compromised attestor key cannot authorize more than policy.
 *
 *         Both numbers are ALSO immutable `MAX_*` constants in the bytecode.
 *         `setLivenessTierCap` and `setDailyTxCountLimit` can only ever move
 *         a limit DOWN. The policy therefore holds against a compromised
 *         OWNER key, not merely a compromised attestor — which matters
 *         because a whitelisted integrator that could raise its own caps is a
 *         risk to the protocol, not just to PlasmaPay.
 *
 *         ── Verification is the on-chain twin of simple-kyc ──────────────
 *         EIP-712 typehash `LivenessAttestation(address wallet,bytes32
 *         nullifier,uint256 limit,uint256 expiry)`, domain name
 *         `LivenessVerifier`, recovered with `ecrecover` — byte-compatible
 *         with the service's reference `LivenessAttestationVerifier`, so the
 *         service needs no new message shape, only this contract registered
 *         as its tenant `contract_address`. Binding `verifyingContract` to
 *         `address(this)` is what stops an attestation minted for one
 *         integrator being replayed against another. The per-(tenant, human)
 *         nullifier is single-use, which is the on-chain half of the Sybil
 *         defence (face dedup is the off-chain half).
 */
contract PlasmaPayCheckoutIntegrator is IP2PIntegrator {
    using SafeERC20 for IERC20;

    // ─── Errors ───────────────────────────────────────────────────────

    error OnlyDiamond();
    error OnlyOwner();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidLimit();
    /// @notice A limit was set above its immutable `MAX_*` policy ceiling.
    error CapExceedsCeiling();
    error ContractPaused();
    error Reentrancy();

    error AttestorNotSet();
    error AttestationExpired();
    error NullifierAlreadySpent();
    error InvalidSignature();

    error NotVerified();
    error VerificationLimitExceeded();
    error DailyCountLimitExceeded();
    error UserIsBlocked();
    error OrderValidationMissing();
    error OrderIdAlreadyUsed();

    // ─── Events ───────────────────────────────────────────────────────

    event AttestorUpdated(address indexed attestor);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event UserBlocked(address indexed user, bool blocked);
    event LivenessTierCapUpdated(uint256 cap);
    event DailyTxCountLimitUpdated(uint256 limit);
    event UserProxyDeployed(address indexed user, address proxy);

    event LivenessVerified(
        address indexed user,
        bytes32 indexed nullifier,
        uint256 attestedLimit,
        uint256 grantedLimit
    );

    event OrderValidated(
        address indexed user,
        uint256 indexed day,
        uint256 amount,
        bytes32 currency
    );

    event OnrampOrderCreated(
        uint256 indexed orderId,
        address indexed user,
        uint256 amount,
        bytes32 currency
    );

    event OnrampOrderSettled(uint256 indexed orderId, address indexed user, uint256 amount);

    event OnrampOrderCancelled(uint256 indexed orderId, address indexed user, uint256 amount);

    /**
     * @notice Emitted when a completion callback does not describe the order
     *         this contract placed — in particular when `recipientAddr` is
     *         not the buyer. Under the intended registration
     *         (`usdcThroughIntegrator = false`) this can never fire; if it
     *         does, the integrator was mis-registered and settlement is being
     *         routed somewhere other than the buyer's wallet. Loud on-chain
     *         so it is caught on the first order rather than the hundredth.
     */
    event SettlementRoutingAnomaly(
        uint256 indexed orderId,
        address indexed expectedUser,
        address callbackUser,
        uint256 callbackAmount,
        address callbackRecipient
    );

    event UsdcSwept(address indexed to, uint256 amount);

    // ─── Immutable policy ceilings ────────────────────────────────────
    // Compiled into the bytecode. Nothing — owner included — can move them.
    // The setters check against these, so the deployed contract can only ever
    // become MORE restrictive than launch policy, never less.

    /// @notice Liveness tier — $20 per tx, and the most `setLivenessTierCap`
    ///         can ever be set to.
    uint256 public constant MAX_LIVENESS_TIER_CAP = 20e6;
    /// @notice At most 5 onramp placements per user per day.
    uint256 public constant MAX_DAILY_TX_COUNT_LIMIT = 5;

    // ─── EIP-712 (simple-kyc liveness service) ────────────────────────

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

    // ─── Immutable configuration ──────────────────────────────────────

    address public immutable diamond;
    IERC20 public immutable usdc;
    address public immutable owner;
    /// @notice Canonical `UserProxy` master this integrator clones from.
    ///         Pinned on the Diamond at registration and set-once there.
    address public immutable proxyImpl;

    // ─── Mutable policy (tightening only) ─────────────────────────────

    /// @notice secp256k1 signer of the liveness service's attestations
    ///         (simple-kyc liveness verifier, `GET /v1/attestor`).
    address public attestor;

    /// @notice On-chain per-tx ceiling, bounded by `MAX_LIVENESS_TIER_CAP`.
    ///         Setting it to 0 halts new orders without touching anyone's
    ///         attestation.
    uint256 public livenessTierCap;

    /// @notice Onramp placements allowed per user per UTC day.
    ///         1..`MAX_DAILY_TX_COUNT_LIMIT`.
    uint256 public dailyTxCountLimit;

    bool public paused;

    // ─── Verification state ───────────────────────────────────────────

    /// @notice Per-tx USDC ceiling attested by the service for this wallet.
    ///         Always further clamped by `livenessTierCap` at spend time.
    mapping(address => uint256) public grantedLimit;
    /// @notice True once the wallet has presented a liveness attestation.
    ///         There is no lower tier — this is the gate.
    mapping(address => bool) public verified;
    /// @notice Per-(tenant, human) Sybil nullifier, single-use.
    mapping(bytes32 => bool) public nullifierSpent;
    /// @notice Owner-set denylist (sanctions / confirmed fraud). Independent
    ///         of verification: a blocked wallet's effective limit is 0.
    mapping(address => bool) public blocked;

    // ─── Order state ──────────────────────────────────────────────────

    struct Session {
        address user;
        bool settled;
        bool cancelled;
        uint32 placementDay;
        uint256 amount;
        bytes32 currency;
    }

    /// @dev Binds the Diamond's synchronous `validateOrder` callback to the
    ///      placement this contract is executing right now. Without it,
    ///      `validateOrder` would be a standalone predicate; with it, the only
    ///      order that can ever validate is the exact (user, amount, currency)
    ///      tuple `buyUsdc` just initiated.
    struct PendingPlacement {
        address user;
        uint256 amount;
        bytes32 currency;
        bool validated;
    }

    mapping(address => mapping(uint256 => uint256)) public userDailyCount;
    mapping(uint256 => Session) public sessions;
    PendingPlacement private _pendingPlacement;

    uint256 private _reentrancyLock = 1;

    // ─── Modifiers ────────────────────────────────────────────────────

    modifier onlyDiamond() {
        if (msg.sender != diamond) revert OnlyDiamond();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier nonReentrant() {
        if (_reentrancyLock != 1) revert Reentrancy();
        _reentrancyLock = 2;
        _;
        _reentrancyLock = 1;
    }

    /**
     * @param _diamond      P2P Diamond proxy for the target network.
     * @param _usdc         USDC the Diamond settles in on that network.
     * @param _owner        Operator key: pause, denylist, tighten limits.
     * @param _attestor     Liveness service signer. MUST be read from the
     *                      service's own `/v1/attestor` endpoint — never a
     *                      value relayed by a partner or teammate. May be 0
     *                      here and set once known.
     * @param _tierCap      Per-tx cap in micro-USDC (<= $20).
     * @param _dailyTxCount Placements per user per day (1..5).
     *
     * @dev Both limits are checked against their immutable `MAX_*` ceilings,
     *      so a deploy can launch tighter than policy but never looser.
     */
    constructor(
        address _diamond,
        address _usdc,
        address _owner,
        address _attestor,
        uint256 _tierCap,
        uint256 _dailyTxCount
    ) {
        if (_diamond == address(0) || _usdc == address(0) || _owner == address(0)) {
            revert InvalidAddress();
        }

        diamond = _diamond;
        usdc = IERC20(_usdc);
        owner = _owner;
        attestor = _attestor;

        _setLivenessTierCap(_tierCap);
        _setDailyTxCountLimit(_dailyTxCount);

        proxyImpl = address(new UserProxy());
    }

    // ─── Administration (tightening + emergency only) ─────────────────

    /// @notice Rotate the attestation signer. Verifies nothing retroactively:
    ///         already-granted limits stand (use `setBlocked` to stop a
    ///         wallet).
    function setAttestor(address newAttestor) external onlyOwner {
        attestor = newAttestor;
        emit AttestorUpdated(newAttestor);
    }

    /**
     * @notice Lower the per-tx cap. Setting it to 0 halts new orders without
     *         touching anyone's attestation.
     * @dev    Can only ever set a value AT OR BELOW the immutable
     *         `MAX_LIVENESS_TIER_CAP` — the owner may tighten policy, never
     *         loosen it.
     */
    function setLivenessTierCap(uint256 cap) external onlyOwner {
        _setLivenessTierCap(cap);
    }

    /// @notice Set placements per user per day. 1..`MAX_DAILY_TX_COUNT_LIMIT`.
    /// @dev    0 is rejected so "disable" is never expressed by wrapping
    ///         around the ceiling. Use `setLivenessTierCap(0)` to stop orders.
    function setDailyTxCountLimit(uint256 count) external onlyOwner {
        _setDailyTxCountLimit(count);
    }

    /// @notice Deny/allow a wallet (sanctions, confirmed fraud). A blocked
    ///         wallet's effective limit is 0.
    function setBlocked(address user, bool isBlocked) external onlyOwner {
        blocked[user] = isBlocked;
        emit UserBlocked(user, isBlocked);
    }

    function pause() external onlyOwner {
        if (paused) return;
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        if (!paused) return;
        paused = false;
        emit Unpaused(msg.sender);
    }

    /**
     * @notice Recover USDC sitting on this contract.
     * @dev    By construction the balance here is always zero: every order
     *         pins `recipientAddr` to the buyer and the integrator is
     *         registered `usdcThroughIntegrator = false`, so onramp proceeds
     *         never touch this address. A non-zero balance therefore means
     *         either a stray transfer or a mis-registration — in both cases
     *         the funds are otherwise stuck, and this is the only way out.
     *         It is a recovery hatch for tokens that should not be here, not
     *         a withdrawal path for user funds; `SettlementRoutingAnomaly`
     *         fires on the first mis-routed completion so the condition is
     *         visible before any balance accumulates.
     */
    function sweepUsdc(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert InvalidAddress();
        usdc.safeTransfer(to, amount);
        emit UsdcSwept(to, amount);
    }

    function _setLivenessTierCap(uint256 cap) internal {
        if (cap > MAX_LIVENESS_TIER_CAP) revert CapExceedsCeiling();
        livenessTierCap = cap;
        emit LivenessTierCapUpdated(cap);
    }

    function _setDailyTxCountLimit(uint256 count) internal {
        if (count == 0) revert InvalidLimit();
        if (count > MAX_DAILY_TX_COUNT_LIMIT) revert CapExceedsCeiling();
        dailyTxCountLimit = count;
        emit DailyTxCountLimitUpdated(count);
    }

    // ─── Attestation intake ───────────────────────────────────────────

    /**
     * @notice Verify and record a liveness attestation for `msg.sender`,
     *         unlocking the onramp for that wallet.
     * @param nullifier Per-(tenant, human) Sybil nullifier from the service.
     * @param limit     Attested per-tx USDC ceiling (micro-USDC, 6dp). The
     *                  effective cap is `min(limit, livenessTierCap)`.
     * @param expiry    Unix seconds; the attestation must be claimed before
     *                  this.
     * @param signature 65-byte secp256k1 signature (r ‖ s ‖ v) from the
     *                  service.
     *
     * @dev The grant is monotonic and does not lapse: `expiry` is a
     *      claim-freshness deadline, not an ongoing clock. That is safe
     *      because the nullifier is single-use, so an expired grant could
     *      never be re-claimed anyway — and `setBlocked` is the lever for
     *      revoking a wallet.
     */
    function submitLivenessAttestation(
        bytes32 nullifier,
        uint256 limit,
        uint256 expiry,
        bytes calldata signature
    ) external {
        address signer = attestor;
        if (signer == address(0)) revert AttestorNotSet();
        if (block.timestamp >= expiry) revert AttestationExpired();
        if (nullifierSpent[nullifier]) revert NullifierAlreadySpent();

        bytes32 digest = _digest(msg.sender, nullifier, limit, expiry);
        if (_recover(digest, signature) != signer) revert InvalidSignature();

        nullifierSpent[nullifier] = true;
        verified[msg.sender] = true;
        if (limit > grantedLimit[msg.sender]) grantedLimit[msg.sender] = limit;

        emit LivenessVerified(msg.sender, nullifier, limit, grantedLimit[msg.sender]);
    }

    // ─── Views ────────────────────────────────────────────────────────

    /**
     * @notice The effective per-tx USDC ceiling for `user`: the limit their
     *         attestation carries, clamped by this contract's on-chain cap.
     *         0 means "cannot transact" — unverified, blocked, or the owner
     *         has zeroed the cap.
     */
    function effectiveLimit(address user) public view returns (uint256) {
        if (blocked[user] || !verified[user]) return 0;
        uint256 lim = grantedLimit[user];
        uint256 cap = livenessTierCap;
        return lim < cap ? lim : cap;
    }

    /// @notice Widget-compatibility view (`docs/INTEGRATORS.md`): the
    ///         unadjusted per-tx cap a fully verified wallet can reach.
    function userTxLimit() external view returns (uint256) {
        return livenessTierCap;
    }

    /// @notice Onramp placements left for `user` today (UTC).
    function getRemainingDailyCount(address user) external view returns (uint256) {
        uint256 used = userDailyCount[user][block.timestamp / 1 days];
        uint256 limit = dailyTxCountLimit;
        return used >= limit ? 0 : limit - used;
    }

    /// @notice Predicts the deterministic `UserProxy` address for `user`. The
    ///         proxy is only the authenticated caller into the B2B gateway;
    ///         it never receives the purchased USDC.
    function proxyAddress(address user) public view returns (address) {
        return
            Clones.predictDeterministicAddressWithImmutableArgs(
                proxyImpl,
                _proxyArgs(user),
                _salt(user),
                address(this)
            );
    }

    function getSession(uint256 orderId) external view returns (Session memory) {
        return sessions[orderId];
    }

    /// @notice EIP-712 domain separator this contract verifies attestations
    ///         against. Exposed so the simple-kyc service and the frontend
    ///         can assert they are signing for THIS deployment.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparator();
    }

    // ─── Onramp: fiat -> USDC in the buyer's own wallet ───────────────

    /**
     * @notice Buy Base USDC with fiat. The Diamond delivers the USDC straight
     *         to `msg.sender`; there is no recipient parameter, so a caller
     *         can only ever buy for themselves.
     *
     * @param amount   USDC to receive (micro-USDC, 6dp).
     * @param currency Fiat the buyer pays in, e.g. `bytes32("INR")`.
     * @param circleId P2P circle the order is placed into.
     * @param pubKey   Buyer's encryption pubkey for the merchant handshake.
     */
    function buyUsdc(
        uint256 amount,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) external nonReentrant returns (uint256 orderId) {
        if (paused) revert ContractPaused();
        if (amount == 0) revert InvalidAmount();
        if (blocked[msg.sender]) revert UserIsBlocked();

        // Friendly pre-checks with specific reverts. `validateOrder`
        // re-enforces all of them authoritatively when the Diamond calls
        // back, and is where the daily-count slot is actually consumed.
        uint256 lim = effectiveLimit(msg.sender);
        if (lim == 0) revert NotVerified();
        if (amount > lim) revert VerificationLimitExceeded();
        if (userDailyCount[msg.sender][block.timestamp / 1 days] >= dailyTxCountLimit) {
            revert DailyCountLimitExceeded();
        }

        _pendingPlacement = PendingPlacement({
            user: msg.sender,
            amount: amount,
            currency: currency,
            validated: false
        });

        orderId = _placeBuyOrder(
            amount,
            currency,
            circleId,
            pubKey,
            preferredPaymentChannelConfigId,
            fiatAmountLimit
        );

        // The Diamond must have called back through `validateOrder` during
        // the placement. If it did not, the order was created without passing
        // this contract's gate — unwind rather than record it.
        if (!_pendingPlacement.validated) revert OrderValidationMissing();
        delete _pendingPlacement;

        if (sessions[orderId].user != address(0)) revert OrderIdAlreadyUsed();
        sessions[orderId] = Session({
            user: msg.sender,
            settled: false,
            cancelled: false,
            placementDay: uint32(block.timestamp / 1 days),
            amount: amount,
            currency: currency
        });

        emit OnrampOrderCreated(orderId, msg.sender, amount, currency);
    }

    function _placeBuyOrder(
        uint256 amount,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) internal returns (uint256) {
        // Proxy-as-placer: the B2B gateway is proxy-only. The buyer's
        // UserProxy is the msg.sender that calls placeB2BOrder, and the
        // gateway resolves it back to this integrator via CREATE2.
        //
        // recipientAddr = msg.sender: settlement goes to the buyer's own
        // wallet. The proxy is only the authenticated caller and never holds
        // the USDC. usdcAllowance = 0: placeB2BOrder pulls nothing at
        // placement time, so there is no allowance to grant or reset.
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
     * @notice The Diamond's synchronous gate during `placeB2BOrder` — the
     *         authoritative verification and rate check.
     *
     * @dev Returns false rather than reverting: the gateway treats a false as
     *      "not allowed" and unwinds the placement itself.
     *
     *      The pending-placement binding means this can only ever approve the
     *      exact tuple `buyUsdc` is mid-flight on.
     */
    function validateOrder(
        address user,
        uint256 amount,
        bytes32 currency
    ) external onlyDiamond returns (bool allowed) {
        PendingPlacement storage pending = _pendingPlacement;
        if (
            paused ||
            pending.user == address(0) ||
            pending.validated ||
            pending.user != user ||
            pending.amount != amount ||
            pending.currency != currency
        ) return false;

        if (amount == 0) return false;
        uint256 lim = effectiveLimit(user);
        if (lim == 0 || amount > lim) return false;

        uint256 day = block.timestamp / 1 days;
        uint256 count = userDailyCount[user][day];
        if (count >= dailyTxCountLimit) return false;

        pending.validated = true;
        userDailyCount[user][day] = count + 1;

        emit OrderValidated(user, day, amount, currency);
        return true;
    }

    /**
     * @notice Completion hook. Bookkeeping only — the USDC has already been
     *         delivered by the Diamond straight to the buyer's wallet, and
     *         this contract has nothing to forward, mint, or release.
     *
     * @dev Never reverts. The gateway wraps this call in try/catch, so a
     *      revert here would not undo the settlement; it would only lose the
     *      event and leave the session permanently un-finalised. A callback
     *      that does not match the recorded order is reported via
     *      `SettlementRoutingAnomaly` instead — most importantly when
     *      `recipientAddr` is not the buyer, which is the on-chain signature
     *      of a mis-registered `usdcThroughIntegrator`.
     */
    function onOrderComplete(
        uint256 orderId,
        address user,
        uint256 amount,
        address recipientAddr
    ) external onlyDiamond {
        Session storage session = sessions[orderId];
        if (session.user == address(0) || session.settled || session.cancelled) return;

        if (session.user != user || session.amount != amount || recipientAddr != session.user) {
            emit SettlementRoutingAnomaly(orderId, session.user, user, amount, recipientAddr);
            return;
        }

        session.settled = true;
        emit OnrampOrderSettled(orderId, session.user, session.amount);
    }

    /**
     * @notice Cancellation hook. Marks the session terminal.
     *
     * @dev The daily-count slot is deliberately NOT released. The counter is
     *      placements-per-day, not completions-per-day: a placement consumes
     *      real merchant capacity for the life of the order whether or not it
     *      completes, so refunding the slot on cancel would let one wallet
     *      churn placements and crowd merchants out. Not releasing is also
     *      the only safe direction — a slot that is never freed early cannot
     *      be used to exceed the daily cap.
     *
     *      Note the live Diamond does not currently call this at all; it is
     *      implemented for interface conformance and forward compatibility.
     *      Never reverts, for the same reason as `onOrderComplete`.
     */
    function onOrderCancel(uint256 orderId) external onlyDiamond {
        Session storage session = sessions[orderId];
        if (session.user == address(0) || session.settled || session.cancelled) return;

        session.cancelled = true;
        emit OnrampOrderCancelled(orderId, session.user, session.amount);
    }

    // ─── Internals ────────────────────────────────────────────────────

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
        // ecrecover returns address(0) for a malformed signature — never treat
        // that as a valid signer.
        if (signer == address(0)) revert InvalidSignature();
        return signer;
    }
}
