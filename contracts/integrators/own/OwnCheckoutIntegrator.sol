// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

/**
 * @title OwnCheckoutIntegrator
 * @notice Fiat -> Base USDC onramp for Own Finance (ownfinance.org), gated on a
 *         single verification tier: passport + liveness.
 *
 *         ── Where the money goes ─────────────────────────────────────────
 *         The purchased USDC is delivered by the Diamond DIRECTLY to the
 *         buyer's own Base wallet. `recipientAddr` is pinned to `msg.sender`
 *         at placement and there is no recipient parameter anywhere in this
 *         contract, so a caller can only ever buy USDC for themselves.
 *         Registered with `usdcThroughIntegrator = false`, neither this
 *         contract nor the buyer's `UserProxy` is ever in the settlement path:
 *         this integrator has NO custody of user funds at any point, and
 *         therefore no rescue, retry, or refund machinery to get them back.
 *
 *         ── Own is on Robinhood Chain ────────────────────────────────────
 *         Own settles in USDG on Robinhood Chain (4663), not in USDC on Base.
 *         That second leg is deliberately NOT performed here. Once the Diamond
 *         settles, the buyer holds USDC in their own wallet and bridges it to
 *         USDG on Robinhood Chain themselves, signing from that same wallet
 *         (Own's app routes this through Relay, the router its perps-margin
 *         bridge already uses; Relay lists Base USDC and Robinhood USDG as a
 *         live pair). Bridging from inside this contract would require taking
 *         custody of every buyer's proceeds and would reintroduce the whole
 *         class of stranded-funds failures that direct settlement avoids. The
 *         user's funds are never pooled with another user's, and no key held
 *         by Own or by P2P can move them.
 *
 *         ── The verification gate ────────────────────────────────────────
 *         One tier, no ladder: a wallet transacts only after it presents a
 *         passport + liveness attestation signed by the simple-kyc service.
 *         The attestation carries a dollar limit, and this contract clamps it
 *         to an on-chain per-region ceiling:
 *
 *           | tier               | India (INR) | Abroad |
 *           |--------------------|-------------|--------|
 *           | passport+liveness  | $100        | $200   |
 *
 *         plus 5 orders per user per day. The effective per-tx cap is
 *         `min(attested limit, regionCap[region])`, so a compromised attestor
 *         key cannot authorize more than the region allows.
 *
 *         Every one of those numbers is ALSO an immutable `MAX_*` constant in
 *         the bytecode, and `setRegionCap` / `setDailyTxCountLimit` check
 *         against them. So no limit can ever exceed its ceiling — not by the
 *         owner, not by anyone. That bound holds against a compromised OWNER
 *         key, which matters because a whitelisted integrator that could raise
 *         its own caps is a risk to the protocol, not just to Own.
 *
 *         Note what this does NOT say. Movement below a ceiling is free in
 *         both directions: an owner who lowers India to $25 can restore it to
 *         $100 in the next block. That is deliberate — a cap tightened during
 *         an incident has to be restorable, and one-way setters would mean
 *         redeploying to undo an operational decision. The guarantee is the
 *         ceiling, not monotonicity.
 *
 *         And the ceilings bound the PER-TRANSACTION USDC amount. A
 *         compromised owner can still point `setAttestor` at a key it holds
 *         and mint attestations for unlimited wallets, so the aggregate is
 *         bounded only by $ceiling x 5 x (wallets it cares to create). Owner
 *         compromise is a superset of attestor compromise; `owner` should be a
 *         multisig for that reason and not merely for `sweepUsdc`.
 *
 *         ── Region is settlement geography, not nationality ──────────────
 *         `region` is derived from the order's fiat currency, i.e. which rail
 *         the money lands on: `INR` settles in India and takes the India
 *         column; every other currency takes the Abroad column. It is not a
 *         claim about who the buyer is. A nationality gate, if one is ever
 *         wanted, belongs in the attestation.
 */
contract OwnCheckoutIntegrator is IP2PIntegrator {
    using SafeERC20 for IERC20;

    // ─── Errors ───────────────────────────────────────────────────────

    error OnlyDiamond();
    error OnlyOwner();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidRegion();
    error InvalidLimit();
    /// @notice A limit was set above its immutable `MAX_*` policy ceiling.
    error CapExceedsCeiling();
    error ContractPaused();
    error Reentrancy();

    error AttestorNotSet();
    error AttestationExpired();
    error AttestationWindowTooLong();
    error NullifierAlreadySpent();
    error NullifierNotSpent();
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
    /// @param region 0 = India (INR), 1 = Abroad (every other currency).
    event RegionCapUpdated(uint8 indexed region, uint256 cap);
    event DailyTxCountLimitUpdated(uint256 limit);
    event UserProxyDeployed(address indexed user, address proxy);

    event PassportVerified(
        address indexed user,
        bytes32 indexed nullifier,
        address indexed submitter,
        uint256 attestedLimit,
        uint256 grantedLimit
    );

    /// @notice An enrolment was undone: the nullifier is spendable again and
    ///         the wallet is back to unverified. The owner's only remedy for a
    ///         nullifier bound to the wrong wallet.
    event EnrolmentRevoked(address indexed user, bytes32 indexed nullifier, address indexed by);

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
     * @notice Emitted when a completion does not look like the order this
     *         contract placed — either the callback describes something else,
     *         or the money did not go where the callback says it went.
     *
     * @dev    `integratorBalance` is the load-bearing field, and the reason
     *         this event is not driven by `recipientAddr` alone.
     *
     *         The Diamond routes settlement on `usdcThroughIntegrator`
     *         (`B2BGatewayFacet` — `safeTransfer(integrator, …)` when true,
     *         `safeTransfer(_order.recipientAddr, …)` when false) but passes
     *         `_order.recipientAddr` to this callback in BOTH branches. So
     *         under a mis-registration the argument still names the buyer, and
     *         a check on `recipientAddr` sees nothing wrong while the USDC
     *         sits here. The alarm was silent in exactly the case it existed
     *         for.
     *
     *         The balance is not fooled by that, because it is the invariant
     *         itself rather than a proxy for it: this contract is never a
     *         settlement destination, so holding the amount that was just
     *         settled means the money did not reach the buyer.
     */
    event SettlementRoutingAnomaly(
        uint256 indexed orderId,
        address indexed expectedUser,
        address callbackUser,
        uint256 callbackAmount,
        address callbackRecipient,
        uint256 integratorBalance
    );

    event UsdcSwept(address indexed to, uint256 amount);

    // ─── Region constants ─────────────────────────────────────────────

    /// @notice Settlement region, derived from the order's fiat currency.
    uint8 public constant REGION_INDIA = 0;
    uint8 public constant REGION_ABROAD = 1;

    /// @notice The fiat currency that settles on an Indian rail. Any other
    ///         currency is treated as Abroad.
    bytes32 public constant INDIA_CURRENCY = bytes32("INR");

    // ─── Immutable policy ceilings ────────────────────────────────────
    // Compiled into the bytecode. Nothing — owner included — can move them.
    // `setRegionCap` and `setDailyTxCountLimit` check against these, so no
    // limit can ever exceed its ceiling. Movement BELOW a ceiling is free in
    // both directions: launching under one leaves room to move back up to it
    // later, which is deliberate (see the header) and is why this is not
    // phrased as "only ever more restrictive".

    /// @notice Passport + liveness, India (INR) — $100 per tx.
    uint256 public constant MAX_REGION_CAP_INDIA = 100e6;
    /// @notice Passport + liveness, abroad — $200 per tx.
    uint256 public constant MAX_REGION_CAP_ABROAD = 200e6;
    /// @notice At most 5 onramp placements per user per day.
    uint256 public constant MAX_DAILY_TX_COUNT_LIMIT = 5;
    /// @notice How far ahead of now an attestation's `expiry` may sit. The
    ///         service issues one-hour windows today, so this is generous
    ///         headroom rather than a constraint on it. It exists because the
    ///         signature is a bearer capability once submission is untied from
    ///         the wallet, and an unbounded window is an unbounded one.
    uint256 public constant MAX_ATTESTATION_WINDOW = 2 hours;

    // ─── EIP-712 (simple-kyc service) ─────────────────────────────────
    // Domain and typehash match the passport+liveness ("KYC") service exactly
    // as it already signs for other integrators, so the service needs no new
    // message shape — only this contract registered as `verifyingContract`.
    // Binding `verifyingContract` to `address(this)` is what stops an
    // attestation minted for one integrator being replayed against another.

    /// @dev keccak256("KycAttestation(address wallet,bytes32 nullifier,uint256 limit,uint256 expiry)")
    bytes32 private constant _KYC_TYPEHASH =
        keccak256("KycAttestation(address wallet,bytes32 nullifier,uint256 limit,uint256 expiry)");
    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
    bytes32 private constant _KYC_DOMAIN_NAME = keccak256(bytes("KycVerifier"));
    bytes32 private constant _DOMAIN_VERSION = keccak256(bytes("1"));

    // ─── Immutable configuration ──────────────────────────────────────

    address public immutable diamond;
    IERC20 public immutable usdc;
    address public immutable owner;
    /// @notice Canonical `UserProxy` master this integrator clones from. Pinned
    ///         on the Diamond at registration and set-once there.
    address public immutable proxyImpl;

    // ─── Mutable policy (tightening only) ─────────────────────────────

    /// @notice secp256k1 signer of the passport+liveness service's attestations.
    address public attestor;

    /// @notice On-chain per-tx ceiling by region, each bounded by its
    ///         `MAX_REGION_CAP_*` constant. A cell set to 0 disables that
    ///         region without touching anyone's attestation.
    mapping(uint8 => uint256) public regionCap;

    /// @notice Onramp placements allowed per user per UTC day.
    ///         1..`MAX_DAILY_TX_COUNT_LIMIT`.
    uint256 public dailyTxCountLimit;

    bool public paused;

    // ─── Verification state ───────────────────────────────────────────

    /// @notice Per-tx USDC ceiling attested by the service for this wallet.
    ///         Always further clamped by `regionCap[...]` at spend time.
    mapping(address => uint256) public grantedLimit;
    /// @notice True once the wallet has presented a passport+liveness
    ///         attestation. There is no lower tier — this is the gate.
    mapping(address => bool) public verified;
    /// @notice Per-(tenant, human) Sybil nullifier, single-use.
    mapping(bytes32 => bool) public nullifierSpent;
    /// @notice Owner-set denylist (sanctions / confirmed fraud). Independent of
    ///         verification: a blocked wallet's effective limit is 0.
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
     * @param _attestor     Passport+liveness service signer. MUST be read from
     *                      the service's own `/v1/attestor` endpoint — never a
     *                      value relayed by a partner or teammate.
     *                      May be 0 here and set once known.
     * @param _capIndia     Per-tx cap for INR orders   (<= $100).
     * @param _capAbroad    Per-tx cap for other fiat   (<= $200).
     * @param _dailyTxCount Placements per user per day (1..5).
     *
     * @dev Every limit is checked against its immutable `MAX_*` ceiling, so a
     *      deploy can launch tighter than policy but never looser.
     */
    constructor(
        address _diamond,
        address _usdc,
        address _owner,
        address _attestor,
        uint256 _capIndia,
        uint256 _capAbroad,
        uint256 _dailyTxCount
    ) {
        if (_diamond == address(0) || _usdc == address(0) || _owner == address(0)) {
            revert InvalidAddress();
        }

        diamond = _diamond;
        usdc = IERC20(_usdc);
        owner = _owner;
        attestor = _attestor;

        _setRegionCap(REGION_INDIA, _capIndia);
        _setRegionCap(REGION_ABROAD, _capAbroad);
        _setDailyTxCountLimit(_dailyTxCount);

        proxyImpl = address(new UserProxy());
    }

    // ─── Administration (tightening + emergency only) ─────────────────

    /// @notice Rotate the attestation signer. Verifies nothing retroactively:
    ///         already-granted limits stand (use `setBlocked` to stop a wallet).
    /// @dev    Zero is rejected (#92): a fat-fingered rotation to address(0)
    ///         would make every submission revert `AttestorNotSet`, bricking
    ///         the tier until someone diagnosed it. The constructor still
    ///         accepts 0 deliberately — "deploy first, set once known" — but a
    ///         ROTATION to nothing is never intentional. Stopping submissions
    ///         on purpose is `pause()`, which now gates the submit path too.
    function setAttestor(address newAttestor) external onlyOwner {
        if (newAttestor == address(0)) revert InvalidAddress();
        attestor = newAttestor;
        emit AttestorUpdated(newAttestor);
    }

    /**
     * @notice Set the per-tx cap for one region. Setting a cap to 0 disables
     *         that region without touching anyone's attestation.
     * @dev    Bounded by the matching immutable `MAX_REGION_CAP_*`: a cap can
     *         never exceed its ceiling. It CAN move freely below it, in either
     *         direction — this is not a one-way ratchet, so a cap tightened
     *         during an incident can be restored without redeploying.
     */
    function setRegionCap(uint8 region, uint256 cap) external onlyOwner {
        _setRegionCap(region, cap);
    }

    /// @notice Set placements per user per day. 1..`MAX_DAILY_TX_COUNT_LIMIT`.
    /// @dev    0 is rejected so "disable" is never expressed by wrapping around
    ///         the ceiling. Use `setRegionCap(region, 0)` to stop a region.
    function setDailyTxCountLimit(uint256 count) external onlyOwner {
        _setDailyTxCountLimit(count);
    }

    /// @notice Deny/allow a wallet (sanctions, confirmed fraud). A blocked
    ///         wallet's effective limit is 0 in every region.
    function setBlocked(address user, bool isBlocked) external onlyOwner {
        blocked[user] = isBlocked;
        emit UserBlocked(user, isBlocked);
    }

    /**
     * @notice Undo an enrolment: free the nullifier and unverify the wallet.
     *
     * @dev The cost of untying submission from the wallet. The user used to
     *      hold a veto — a signature naming a wallet they could not use simply
     *      never landed, and the service re-issued for the right one. Now any
     *      holder of the signature lands it, so a retry, a stale queue entry,
     *      an abandoned flow or a wrong address from the client permanently
     *      binds that human's single nullifier to a wallet they may not
     *      control. Without this the only remedies are redeploying an
     *      immutable contract, which invalidates every existing grant, or
     *      minting a second nullifier for one human, which is the Sybil
     *      property the nullifier exists to provide.
     *
     *      `blocked` is not the same lever: it zeroes an effective limit and
     *      leaves the nullifier spent forever.
     *
     *      The pairing is not stored on chain, because one SSTORE per enrolment
     *      is a real cost on every sponsored submit for a remedy used almost
     *      never. `PassportVerified` records the true (wallet, nullifier) pair,
     *      so the caller reads it from the log and passes both back here, and
     *      `EnrolmentRevoked` records what was actually undone.
     *
     * @param nullifier The nullifier to free. Must currently be spent.
     * @param wallet    The wallet it was bound to, which loses its grant.
     */
    function revokeEnrolment(bytes32 nullifier, address wallet) external onlyOwner {
        if (wallet == address(0)) revert InvalidAddress();
        if (!nullifierSpent[nullifier]) revert NullifierNotSpent();

        nullifierSpent[nullifier] = false;
        verified[wallet] = false;
        grantedLimit[wallet] = 0;

        emit EnrolmentRevoked(wallet, nullifier, msg.sender);
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
     *         It is a recovery hatch for tokens that should not be here, not a
     *         withdrawal path for user funds; `SettlementRoutingAnomaly` fires
     *         on the first mis-routed completion so the condition is visible
     *         before any balance accumulates.
     *
     *         That last sentence is only true because the anomaly check reads
     *         this contract's USDC balance. It previously keyed on the
     *         callback's `recipientAddr`, which the Diamond passes unchanged
     *         in both routing branches — so under the one condition that puts
     *         funds here, the alarm said nothing and this hatch was the only
     *         thing standing between a mis-registration and stuck user money,
     *         with nobody told to reach for it.
     */
    function sweepUsdc(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert InvalidAddress();
        usdc.safeTransfer(to, amount);
        emit UsdcSwept(to, amount);
    }

    function _setRegionCap(uint8 region, uint256 cap) internal {
        if (region != REGION_INDIA && region != REGION_ABROAD) revert InvalidRegion();
        if (cap > maxRegionCap(region)) revert CapExceedsCeiling();
        regionCap[region] = cap;
        emit RegionCapUpdated(region, cap);
    }

    function _setDailyTxCountLimit(uint256 count) internal {
        if (count == 0) revert InvalidLimit();
        if (count > MAX_DAILY_TX_COUNT_LIMIT) revert CapExceedsCeiling();
        dailyTxCountLimit = count;
        emit DailyTxCountLimitUpdated(count);
    }

    // ─── Attestation intake ───────────────────────────────────────────

    /**
     * @notice Verify and record a passport + liveness attestation for
     *         `wallet`, unlocking the onramp for that wallet. Callable by
     *         ANYONE — the caller's identity plays no part in what is granted.
     *
     * @param wallet    The wallet the attestation was minted for. This is the
     *                  address the signature binds and the only address the
     *                  call can affect.
     * @param nullifier Per-(tenant, human) Sybil nullifier from the service.
     * @param limit     Attested per-tx USDC ceiling (micro-USDC, 6dp), > 0. The
     *                  effective cap is `min(limit, regionCap[region])` —
     *                  $100 for INR orders, $200 for anything else.
     * @param expiry    Unix seconds; the attestation must be claimed before this.
     * @param signature 65-byte secp256k1 signature (r ‖ s ‖ v) from the service.
     *
     * @dev ── Why anyone may submit ────────────────────────────────────────
     *      The signature IS the authorization: the service signed the exact
     *      tuple `(wallet, nullifier, limit, expiry)`, so no submitter can
     *      credit any wallet other than the one attested, grant any limit
     *      other than the one attested, or reuse the nullifier. An earlier
     *      version hashed `msg.sender` instead of a `wallet` parameter, which
     *      added no security (the same binding, expressed differently) but
     *      required the ONE wallet that by definition has no gas — a
     *      first-time fiat buyer — to send the transaction itself. That
     *      coupling was the whole cold-start problem: the sponsor service had
     *      to drip ETH so the wallet could afford this call, and had to
     *      re-verify attestations off-chain to decide who deserved the drip.
     *      Untying it lets any funded party — the gas service, a partner
     *      backend, or the wallet itself if it happens to hold ETH — land the
     *      attestation on-chain.
     *
     *      Front-running is harmless by construction: whoever submits first
     *      produces the identical state (the attested wallet verified, the
     *      attested limit granted, the nullifier spent). A user's own
     *      duplicate submit reverts `NullifierAlreadySpent` having lost
     *      nothing but its own gas.
     *
     *      The grant is monotonic and does not lapse: `expiry` is a
     *      claim-freshness deadline, not an ongoing clock. That is safe
     *      because the nullifier is single-use, so an expired grant could
     *      never be re-claimed anyway — and `setBlocked` is the lever for
     *      revoking a wallet.
     */
    function submitPassportAttestation(
        address wallet,
        bytes32 nullifier,
        uint256 limit,
        uint256 expiry,
        bytes calldata signature
    ) external {
        // Paused stops NEW enrolments as well as new purchases. Before this
        // gate, the only way to halt sponsored submissions in an incident was
        // rotating the attestor to zero — a diagnostic hazard masquerading as
        // a lever (#92). Pause is the lever; the attestor is configuration.
        if (paused) revert ContractPaused();
        if (wallet == address(0)) revert InvalidAddress();
        // A limit-0 attestation verifies a wallet whose effective cap is
        // min(0, regionCap) = 0 — it can never buy. The service should never
        // sign one; rejecting at the source stops a useless verified=true
        // state whoever submits, and stops the gas service paying to reach it
        // (#80). The nullifier is NOT yet spent, so a corrected re-issue can
        // still land.
        if (limit == 0) revert InvalidLimit();
        address signer = attestor;
        if (signer == address(0)) revert AttestorNotSet();
        if (block.timestamp >= expiry) revert AttestationExpired();
        // Untying submission from the wallet made the signature a bearer
        // capability: whoever holds it can land it. An unbounded `expiry` then
        // makes that capability live for as long as an off-chain service chose,
        // and every other policy input here carries an immutable ceiling for
        // exactly that reason. This is the one that now matters most.
        if (expiry > block.timestamp + MAX_ATTESTATION_WINDOW) {
            revert AttestationWindowTooLong();
        }
        if (nullifierSpent[nullifier]) revert NullifierAlreadySpent();

        bytes32 digest = _digest(wallet, nullifier, limit, expiry);
        if (_recover(digest, signature) != signer) revert InvalidSignature();

        nullifierSpent[nullifier] = true;
        verified[wallet] = true;
        if (limit > grantedLimit[wallet]) grantedLimit[wallet] = limit;

        // `msg.sender` is the whole new degree of freedom, so it belongs in the
        // log. Without it nothing on chain separates "our sponsor enrolled this
        // wallet" from "a third party front-ran it", which is the difference an
        // incident turns on.
        emit PassportVerified(wallet, nullifier, msg.sender, limit, grantedLimit[wallet]);
    }

    // ─── Views ────────────────────────────────────────────────────────

    /// @notice The settlement region an order in `currency` falls under.
    ///         `INR` is India; every other currency is Abroad.
    function regionFor(bytes32 currency) public pure returns (uint8) {
        return currency == INDIA_CURRENCY ? REGION_INDIA : REGION_ABROAD;
    }

    /// @notice The immutable policy ceiling for a region — the most
    ///         `setRegionCap` can ever be set to.
    function maxRegionCap(uint8 region) public pure returns (uint256) {
        if (region == REGION_INDIA) return MAX_REGION_CAP_INDIA;
        if (region == REGION_ABROAD) return MAX_REGION_CAP_ABROAD;
        return 0;
    }

    /**
     * @notice The effective per-tx USDC ceiling for `user` settling in
     *         `currency`: the limit their attestation carries, clamped by this
     *         contract's ceiling for the region that currency settles in.
     *         0 means "cannot transact" — unverified, blocked, or a region the
     *         owner has switched off.
     */
    function effectiveLimit(address user, bytes32 currency) public view returns (uint256) {
        if (blocked[user] || !verified[user]) return 0;
        uint256 lim = grantedLimit[user];
        uint256 cap = regionCap[regionFor(currency)];
        return lim < cap ? lim : cap;
    }

    /// @notice Both region limits for `user` in one call, for the UI: what they
    ///         may buy settling in INR vs in any other currency.
    function effectiveLimits(address user) external view returns (uint256 india, uint256 abroad) {
        india = effectiveLimit(user, INDIA_CURRENCY);
        // Any non-INR sentinel resolves to the Abroad column.
        abroad = effectiveLimit(user, bytes32(0));
    }

    /// @notice Onramp placements left for `user` today (UTC).
    function getRemainingDailyCount(address user) external view returns (uint256) {
        uint256 used = userDailyCount[user][block.timestamp / 1 days];
        uint256 limit = dailyTxCountLimit;
        return used >= limit ? 0 : limit - used;
    }

    /// @notice Predicts the deterministic `UserProxy` address for `user`. The
    ///         proxy is only the authenticated caller into the B2B gateway; it
    ///         never receives the purchased USDC.
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
    ///         against. Exposed so the simple-kyc service and the frontend can
    ///         assert they are signing for THIS deployment.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparator();
    }

    // ─── Onramp: fiat -> USDC in the buyer's own wallet ───────────────

    /**
     * @notice Buy Base USDC with fiat. The Diamond delivers the USDC straight
     *         to `msg.sender`; there is no recipient parameter, so a caller can
     *         only ever buy for themselves.
     *
     * @param amount   USDC to receive (micro-USDC, 6dp).
     * @param currency Fiat the buyer pays in, e.g. `bytes32("INR")`. Also picks
     *                 the region column: INR -> India ($100), else Abroad ($200).
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

        // Friendly pre-checks with specific reverts. `validateOrder` re-enforces
        // all of them authoritatively when the Diamond calls back, and is where
        // the daily-count slot is actually consumed.
        uint256 lim = effectiveLimit(msg.sender, currency);
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

        // The Diamond must have called back through `validateOrder` during the
        // placement. If it did not, the order was created without passing this
        // contract's gate — unwind rather than record it.
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
        // Proxy-as-placer: the B2B gateway is proxy-only. The buyer's UserProxy
        // is the msg.sender that calls placeB2BOrder, and the gateway resolves
        // it back to this integrator via CREATE2.
        //
        // recipientAddr = msg.sender: settlement goes to the buyer's own wallet.
        // The proxy is only the authenticated caller and never holds the USDC.
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
     *      exact tuple `buyUsdc` is mid-flight on. `currency` selects the
     *      region column, so the same wallet legitimately gets a $100 cap on an
     *      INR order and $200 on a foreign-currency one.
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
        uint256 lim = effectiveLimit(user, currency);
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
     *         delivered by the Diamond straight to the buyer's wallet, and this
     *         contract has nothing to forward, mint, or release.
     *
     * @dev Never reverts. The gateway wraps this call in try/catch, so a revert
     *      here would not undo the settlement; it would only lose the event and
     *      leave the session permanently un-finalised. A callback that does not
     *      match the recorded order is reported via `SettlementRoutingAnomaly`
     *      instead — most importantly when `recipientAddr` is not the buyer,
     *      which is the on-chain signature of a mis-registered
     *      `usdcThroughIntegrator`.
     */
    function onOrderComplete(
        uint256 orderId,
        address user,
        uint256 amount,
        address recipientAddr
    ) external onlyDiamond {
        Session storage session = sessions[orderId];
        if (session.user == address(0) || session.settled || session.cancelled) return;

        // Ask the Diamond how it is routing us, rather than inferring it from
        // a balance. `usdcThroughIntegrator` is the actual cause; a balance is
        // a symptom, and a symptom anyone can manufacture.
        //
        // The balance test this replaced looked adequate — it compared against
        // the settled amount rather than zero, so dust could not trip it — but
        // the balance is never consumed. One transfer of a full order's worth
        // left a standing balance that made EVERY later order anomalous until
        // an owner swept, and the attacker could redo it after each sweep. The
        // price was not an order's USDC apiece; it was one order's USDC per
        // sweep cycle, to keep the alarm ringing forever. An alarm that a
        // stranger can hold down is an alarm operators learn to ignore, which
        // is how a real mis-registration would then go unnoticed — the exact
        // failure the alarm exists to prevent, reached by a different road.
        (bool routesHere, bool flagKnown) = _routesThroughIntegrator();

        // Reported for diagnosis, not used as the signal.
        uint256 selfBalance = usdc.balanceOf(address(this));

        // The balance remains the fallback for the one case the flag cannot
        // answer: a Diamond that no longer exposes a readable config at all.
        // That is already a deeply abnormal state, and a griefable signal
        // beats no signal there.
        bool misrouted = flagKnown ? routesHere : selfBalance >= amount;

        if (
            session.user != user ||
            session.amount != amount ||
            recipientAddr != session.user ||
            misrouted
        ) {
            emit SettlementRoutingAnomaly(
                orderId,
                session.user,
                user,
                amount,
                recipientAddr,
                selfBalance
            );
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
     *      churn placements and crowd merchants out. Not releasing is also the
     *      only safe direction — a slot that is never freed early cannot be
     *      used to exceed the daily cap.
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

    /// @dev `bytes4(keccak256("getIntegratorConfig(address)"))`.
    bytes4 private constant _GET_INTEGRATOR_CONFIG = 0x17353447;

    /**
     * @dev Is the Diamond routing this integrator's settlements to us?
     *
     *      A raw `staticcall` that reads word 1 and ignores everything after
     *      it, which is deliberate and is the whole reason this is safe to
     *      depend on. `B2BGatewayStorage.IntegratorConfig` has been three
     *      fields, then four, and is now five — the extra one landed in the
     *      MIDDLE both times, which is what silently decoded `proxyImpl` to
     *      zero in the deploy script. Through all of it `isActive` and
     *      `usdcThroughIntegrator` have stayed words 0 and 1; only the tail
     *      has moved. Verified against the live Base mainnet and Base Sepolia
     *      Diamonds 2026-08-17.
     *
     *      So a typed tuple decode would revert or mis-read on the next
     *      change, while reading a fixed leading word cannot. A view this
     *      contract depends on for a safety alarm must not be the thing that
     *      breaks when the protocol grows a field.
     *
     * @return routes True when settlement is routed here instead of the buyer.
     * @return known  False when the config could not be read at all, so
     *                `routes` carries no information and the caller must fall
     *                back to something else.
     */
    function _routesThroughIntegrator() private view returns (bool routes, bool known) {
        (bool ok, bytes memory ret) = diamond.staticcall(
            abi.encodeWithSelector(_GET_INTEGRATOR_CONFIG, address(this))
        );
        // Two words minimum: anything shorter cannot contain word 1.
        if (!ok || ret.length < 64) return (false, false);

        uint256 flag;
        assembly {
            // ret + 0x20 is word 0 (isActive); + 0x40 is word 1.
            flag := mload(add(ret, 0x40))
        }
        return (flag != 0, true);
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

    function _domainSeparator() private view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    _EIP712_DOMAIN_TYPEHASH,
                    _KYC_DOMAIN_NAME,
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
        bytes32 structHash = keccak256(abi.encode(_KYC_TYPEHASH, wallet, nullifier, limit, expiry));
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
