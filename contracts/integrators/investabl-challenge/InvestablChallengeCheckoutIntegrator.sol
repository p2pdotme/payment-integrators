// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title InvestablChallengeCheckoutIntegrator
 * @notice Goods/service integrator that lets an Investabl user pay local fiat
 *         (INR via UPI) to buy a prop-trading **challenge**. The "product" is a
 *         non-transferable challenge account granted off-chain in Investabl's
 *         backend — the user never receives spendable USDC, so this is the
 *         low-fraud goods model (not the USDC-to-user model that requires KYC).
 *
 *         Orders are gated on a simple-kyc **liveness** attestation plus a daily
 *         order-count limit:
 *
 *           - No attestation       -> cannot buy at all.
 *           - Liveness attestation -> per-tx cap = min(attested limit,
 *                                     livenessTierCap), deployed at 20 USDC.
 *
 *         The service signs a dollar limit into the attestation and this contract
 *         additionally clamps it to `livenessTierCap`. That cap is owner-tunable
 *         but can only ever be *lowered* — it is hard-bounded by the immutable
 *         MAX_LIVENESS_TIER_CAP (20 USDC), so neither a compromised attestor key
 *         nor a compromised owner can authorize more than P2P's agreed policy.
 *         Verification is
 *         the on-chain twin of simple-kyc's `LivenessAttestationVerifier`: EIP-712
 *         typehash `LivenessAttestation(address wallet,bytes32 nullifier,uint256
 *         limit,uint256 expiry)`, domain name `LivenessVerifier`, recovered with
 *         `ecrecover`. Register this contract's address as the tenant
 *         `contract_address` with the liveness service; the per-(tenant, human)
 *         `nullifier` is single-use for on-chain Sybil resistance.
 *
 *         Flow:
 *           0. User completes the liveness check once and calls
 *              `submitLivenessAttestation(...)` from their wallet.
 *           1. User's wallet calls `buyChallenge(...)` → places a B2B BUY order
 *              through their `UserProxy`, with `recipientAddr = this integrator`.
 *           2. User pays fiat off-chain (UPI) to the matched liquidity provider.
 *           3. On settlement the Diamond delivers the purchased USDC to this
 *              contract and calls `onOrderComplete`, which emits
 *              `ChallengePurchased`. Investabl's backend watches that event and
 *              grants the challenge (mapping `sessionRef` → the checkout session).
 *           4. Accrued USDC is swept to the treasury by the owner (`sweepUsdc`),
 *              then bridged to the Arbitrum treasury out of band.
 *
 *         Registration: **`usdcThroughIntegrator = false`**. `buyChallenge` pins
 *         `recipientAddr = address(this)`, so the recipient pin already routes
 *         settlement USDC here; setting the flag as well would double-route.
 *         Every integrator in this repo registers `false` — see docs/WHITELISTING.md.
 *
 * @dev    Security invariants (see CONTRIBUTING.md):
 *           - `validateOrder` / `onOrderComplete` / `onOrderCancel` are
 *             `onlyDiamond` and authoritatively enforce the caps.
 *           - The per-tx cap and the daily order count are owner-tunable but
 *             hard-bounded by the immutable `MAX_LIVENESS_TIER_CAP` (20 USDC)
 *             and `MAX_DAILY_TX_COUNT_LIMIT` (5) ceilings. The owner can only
 *             tighten policy, never raise it past what P2P whitelisted.
 *           - USDC is never routed to a user EOA. It accrues here and leaves
 *             only via the owner's `sweepUsdc` to `treasury`. All movements use
 *             SafeERC20.
 *           - The canonical un-forked `UserProxy` is used verbatim.
 *           - No upgradeability, no `delegatecall`, no `selfdestruct`.
 */
contract InvestablChallengeCheckoutIntegrator is IP2PIntegrator, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Errors ───────────────────────────────────────────────────────

    error OnlyDiamond();
    error OnlyOwner();
    error InvalidAddress();
    error InvalidAmount();
    error AmountExceedsCap();
    error DailyCountExceeded();
    /// @dev Raised when a setter would push a limit above its immutable ceiling.
    error CapExceedsCeiling();
    error OrderAlreadyFulfilled();
    error OrderAlreadyCancelled();

    // KYC / attestation
    error AttestorNotSet();
    error AttestationExpired();
    error NullifierAlreadySpent();
    error InvalidSignature();

    // ─── Events ───────────────────────────────────────────────────────

    event TierCapUpdated(uint256 cap);
    event LivenessAttestorUpdated(address indexed attestor);
    /// @param tier 1 = liveness
    event LivenessClaimed(
        address indexed user,
        uint8 indexed tier,
        bytes32 nullifier,
        uint256 attestedLimit,
        uint256 grantedLimit
    );
    event DailyTxCountLimitUpdated(uint256 count);
    event TreasuryUpdated(address indexed treasury);
    /// @notice A challenge BUY order was placed on the Diamond.
    event ChallengeOrderCreated(
        uint256 indexed orderId,
        address indexed user,
        uint256 amount,
        bytes32 currency,
        bytes32 indexed sessionRef
    );
    /// @notice Fiat settled and USDC was delivered here. Investabl's backend
    ///         watches this to grant the challenge for `sessionRef` / `user`.
    event ChallengePurchased(
        uint256 indexed orderId,
        address indexed user,
        uint256 amount,
        bytes32 indexed sessionRef
    );
    event UsdcSwept(address indexed to, uint256 amount);
    event UserProxyDeployed(address indexed user, address proxy);
    /// @notice A placed order was cancelled (expiry / dispute / PAY-failure);
    ///         its reserved daily-count slot was released.
    event ChallengeOrderCancelled(uint256 indexed orderId, address indexed user);

    // ─── Immutables ───────────────────────────────────────────────────

    address public immutable diamond;
    /// @notice Exposed so the canonical UserProxy can resolve which token to
    ///         block from user-initiated sweep (`UserProxy.sweepERC20`).
    IERC20 public immutable usdc;
    address public immutable owner;
    /// @notice Pinned at deploy; submitted with the whitelist request.
    address public immutable proxyImpl;

    // ─── Tier constants ───────────────────────────────────────────────

    uint8 public constant TIER_NONE = 0;
    uint8 public constant TIER_LIVENESS = 1;

    // ─── Immutable policy ceilings ────────────────────────────────────

    /// @notice Hard ceiling on the liveness per-tx cap (micro-USDC, 6dp). The
    ///         owner may set `livenessTierCap` to any non-zero value at or below
    ///         this, but never above it — the whitelisted maximum is fixed in
    ///         bytecode. P2P's agreed policy for Investabl = 20 USDC.
    uint256 public constant MAX_LIVENESS_TIER_CAP = 20e6;
    /// @notice Hard ceiling on the per-user daily order count. Same rule: the
    ///         owner may lower `dailyTxCountLimit` but never raise it past this.
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

    // ─── Attestation config ───────────────────────────────────────────

    /// @notice secp256k1 signer of the liveness service's attestations. While
    ///         unset every user is TIER_NONE, whose per-tx limit is 0 — the
    ///         contract fails closed and no order can be placed.
    address public livenessAttestor;

    // ─── Owner-tunable limits (bounded by the ceilings above) ─────────

    /// @notice Effective per-tx USDC ceiling for the liveness tier (micro-USDC,
    ///         6dp). Owner-settable via `setTierCap`, always in
    ///         (0, MAX_LIVENESS_TIER_CAP].
    uint256 public livenessTierCap;
    /// @notice Max challenge orders a single user can place per UTC day.
    ///         Owner-settable via `setDailyTxCountLimit`, always in
    ///         (0, MAX_DAILY_TX_COUNT_LIMIT].
    uint256 public dailyTxCountLimit;
    /// @notice Destination for swept USDC proceeds. Defaults to `owner`.
    address public treasury;

    // ─── Per-user entitlement ─────────────────────────────────────────

    /// @notice Per-tx USDC ceiling attested by the simple-kyc service. The
    ///         effective cap is this clamped by `livenessTierCap`.
    mapping(address => uint256) public grantedLimit;
    /// @notice Highest tier the user has claimed (see TIER_* constants).
    mapping(address => uint8) public userTier;
    /// @notice Per-(tenant, human) Sybil nullifiers already consumed.
    mapping(bytes32 => bool) public livenessNullifierSpent;

    // ─── Order accounting ─────────────────────────────────────────────

    struct Session {
        address user; // 20 bytes
        bool fulfilled; //  1 byte  — packs with user
        bool cancelled; //  1 byte  — packs with user
        uint32 placementDay; //  4 bytes — pinned for onOrderCancel decrement keying
        uint256 amount;
        bytes32 sessionRef; // Investabl checkout-session id, echoed on completion
    }

    mapping(uint256 => Session) public sessions;
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
     * @param _usdc              USDC token address (native Circle USDC on Base).
     * @param _livenessTierCap   Per-tx ceiling for the liveness tier, micro-USDC
     *                           (e.g. 20e6).
     * @param _dailyTxCountLimit Max challenge orders per user per day.
     * @param _livenessAttestor  Liveness service signer. May be 0 and set later
     *                           with `setLivenessAttestor`, but no order can be
     *                           placed until it is set.
     */
    constructor(
        address _diamond,
        address _usdc,
        uint256 _livenessTierCap,
        uint256 _dailyTxCountLimit,
        address _livenessAttestor
    ) {
        if (_diamond == address(0) || _usdc == address(0)) revert InvalidAddress();
        if (_livenessTierCap == 0 || _dailyTxCountLimit == 0) revert InvalidAmount();
        if (
            _livenessTierCap > MAX_LIVENESS_TIER_CAP ||
            _dailyTxCountLimit > MAX_DAILY_TX_COUNT_LIMIT
        ) revert CapExceedsCeiling();
        diamond = _diamond;
        usdc = IERC20(_usdc);
        owner = msg.sender;
        livenessTierCap = _livenessTierCap;
        dailyTxCountLimit = _dailyTxCountLimit;
        livenessAttestor = _livenessAttestor;
        treasury = msg.sender;
        proxyImpl = address(new UserProxy());

        emit TierCapUpdated(_livenessTierCap);
        emit DailyTxCountLimitUpdated(_dailyTxCountLimit);
        emit LivenessAttestorUpdated(_livenessAttestor);
    }

    // ─── Admin ────────────────────────────────────────────────────────

    /// @notice Set the liveness per-tx USDC cap. Owner-tunable but bounded: the
    ///         value must be non-zero and can never exceed the immutable
    ///         `MAX_LIVENESS_TIER_CAP`, so the owner may only tighten policy.
    function setTierCap(uint256 cap) external onlyOwner {
        if (cap == 0) revert InvalidAmount();
        if (cap > MAX_LIVENESS_TIER_CAP) revert CapExceedsCeiling();
        livenessTierCap = cap;
        emit TierCapUpdated(cap);
    }

    /// @notice Point the contract at the liveness service's signing key. Kept
    ///         mutable for key rotation; the immutable `MAX_LIVENESS_TIER_CAP`
    ///         bounds what any attestor (even a compromised one) can authorize.
    function setLivenessAttestor(address attestor) external onlyOwner {
        livenessAttestor = attestor;
        emit LivenessAttestorUpdated(attestor);
    }

    /// @notice Update the per-user daily order-count limit. Owner-tunable but
    ///         bounded: non-zero and never above `MAX_DAILY_TX_COUNT_LIMIT`.
    function setDailyTxCountLimit(uint256 count) external onlyOwner {
        if (count == 0) revert InvalidAmount();
        if (count > MAX_DAILY_TX_COUNT_LIMIT) revert CapExceedsCeiling();
        dailyTxCountLimit = count;
        emit DailyTxCountLimitUpdated(count);
    }

    /// @notice Update the sweep destination for USDC proceeds.
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert InvalidAddress();
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    /// @notice Sweep `amount` of accrued USDC proceeds to `treasury`.
    function sweepUsdc(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert InvalidAmount();
        usdc.safeTransfer(treasury, amount);
        emit UsdcSwept(treasury, amount);
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

    // ─── Views ────────────────────────────────────────────────────────

    /**
     * @notice The effective per-tx USDC ceiling for `user`: the limit their
     *         attestation carries, clamped by this contract's ceiling for the
     *         tier they reached. 0 means "cannot transact".
     */
    function effectiveLimit(address user) public view returns (uint256) {
        uint8 tier = userTier[user];
        if (tier == TIER_NONE) return 0;
        // TIER_LIVENESS is the only tier above NONE, so the ceiling is the
        // (bounded) liveness cap; grantedLimit is clamped by it.
        uint256 lim = grantedLimit[user];
        uint256 cap = livenessTierCap;
        return lim < cap ? lim : cap;
    }

    /// @notice Predicts the deterministic UserProxy address for `user`.
    function proxyAddress(address user) public view returns (address) {
        return
            Clones.predictDeterministicAddressWithImmutableArgs(
                proxyImpl,
                _proxyArgs(user),
                _salt(user),
                address(this)
            );
    }

    /// @notice Remaining challenge orders `user` may place today.
    function getRemainingDailyCount(address user) external view returns (uint256) {
        uint256 count = userDailyCount[user][block.timestamp / 1 days];
        if (count >= dailyTxCountLimit) return 0;
        return dailyTxCountLimit - count;
    }

    /// @notice Orders `user` has placed today.
    function getTodayCount(address user) external view returns (uint256) {
        return userDailyCount[user][block.timestamp / 1 days];
    }

    // ─── User-facing checkout ─────────────────────────────────────────

    /**
     * @notice Place a challenge BUY order. The purchased USDC is delivered to
     *         this integrator on completion (recipientAddr = address(this));
     *         the challenge itself is granted off-chain when the backend sees
     *         `ChallengePurchased`.
     * @param amount                          USDC to buy (micro-USDC, 6dp).
     * @param currency                        Fiat currency, e.g. bytes32("INR").
     * @param circleId                        LP circle for `currency` (from routing).
     * @param pubKey                          User's relay pubkey for the order.
     * @param preferredPaymentChannelConfigId Preferred payment channel (0 = any).
     * @param fiatAmountLimit                 Max fiat the user will pay (0 = no cap).
     * @param sessionRef                      Investabl checkout-session id to echo.
     */
    function buyChallenge(
        uint256 amount,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit,
        bytes32 sessionRef
    ) external nonReentrant returns (uint256 orderId) {
        if (amount == 0) revert InvalidAmount();

        // Friendly pre-checks — validateOrder re-enforces these authoritatively
        // (and does the daily-count bump) when the Diamond calls back. A user
        // with no liveness attestation has an effective limit of 0, so this is
        // also the "you must verify first" gate.
        if (amount > effectiveLimit(msg.sender)) revert AmountExceedsCap();
        if (userDailyCount[msg.sender][block.timestamp / 1 days] + 1 > dailyTxCountLimit) {
            revert DailyCountExceeded();
        }

        address proxy = _ensureProxy(msg.sender);
        // recipientAddr = address(this): purchased USDC settles to the integrator
        // on completion. usdcAllowance = 0: placeB2BOrder pulls no USDC at
        // placement (fiat settles off-chain).
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
        orderId = abi.decode(result, (uint256));

        sessions[orderId] = Session({
            user: msg.sender,
            fulfilled: false,
            cancelled: false,
            placementDay: uint32(block.timestamp / 1 days),
            amount: amount,
            sessionRef: sessionRef
        });

        emit ChallengeOrderCreated(orderId, msg.sender, amount, currency, sessionRef);
    }

    // ─── IP2PIntegrator callbacks ─────────────────────────────────────

    /**
     * @notice Authoritative synchronous gate the Diamond calls inside
     *         placeB2BOrder. Enforces the liveness-tier per-tx cap and the daily
     *         count budget (reserving the slot on success). A user with no
     *         attestation has an effective limit of 0 and is rejected here.
     */
    function validateOrder(
        address user,
        uint256 amount,
        bytes32 /* currency */
    ) external onlyDiamond returns (bool allowed) {
        if (amount == 0 || amount > effectiveLimit(user)) return false;

        uint256 dayIndex = block.timestamp / 1 days;
        uint256 count = userDailyCount[user][dayIndex];
        if (count + 1 > dailyTxCountLimit) return false;

        userDailyCount[user][dayIndex] = count + 1;
        return true;
    }

    /**
     * @notice Completion hook. The Diamond has already delivered `amount` USDC
     *         to this contract (recipientAddr = address(this)). We only finalize
     *         bookkeeping and emit `ChallengePurchased` for the backend to grant
     *         the challenge. Best-effort from the gateway's POV (try/catch there).
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
        emit ChallengePurchased(orderId, session.user, session.amount, session.sessionRef);
    }

    /**
     * @notice Cancellation hook — releases the daily-count slot reserved in
     *         validateOrder, keyed on the placement-day snapshot. Tolerates
     *         unknown / already-finalized orders. MUST NOT touch on-chain order
     *         state (protocol-side has already finalized).
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

        emit ChallengeOrderCancelled(orderId, session.user);
    }

    // ─── Internals: proxy (mirror ExampleIntegrator / template exactly) ─

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
