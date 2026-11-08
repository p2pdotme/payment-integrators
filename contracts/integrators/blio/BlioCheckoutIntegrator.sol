// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title BlioCheckoutIntegrator
 * @notice Consumer checkout for blio.me Premium (local fiat in, USDC on Base out).
 *
 *         ── What it sells ─────────────────────────────────────────────────
 *         Digital subscriptions ("products"): the integrator holds a USDC
 *         price per `productId` (monthly / yearly Premium). The user pays in
 *         local fiat (Pago Movil, PIX, SPEI, ...) off-chain; on settlement the
 *         Diamond pays USDC to `treasury`.
 *
 *         ── Where the money goes (no custody) ─────────────────────────────
 *         `recipientAddr` is pinned to the immutable `treasury` (the blio Safe)
 *         and the integrator is registered with `usdcThroughIntegrator = false`,
 *         so the Diamond settles USDC DIRECTLY to that Safe. There is no vault
 *         and no affiliate split: every settlement is a single transfer. This
 *         contract never holds user funds at any point, which is why it has no
 *         withdrawal path for orders and only a stray-token `sweepUsdc`
 *         recovery hatch. blio's backend watches completion events and grants
 *         Premium off-chain.
 *
 *         ── Delivery is off-chain ──────────────────────────────────────────
 *         There is no on-chain `ICheckoutClient`: entitlement is a database
 *         row in blio, credited from `BlioOrderCompleted`. The integrator's
 *         on-chain job is the protocol lifecycle (validate -> complete /
 *         cancel) and emitting the event blio consumes.
 */
contract BlioCheckoutIntegrator is IP2PIntegrator, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Buyer verification tier. `None` means no attestation and gets a
    ///         zero limit — the contract fails closed until the user submits a
    ///         valid attestation (see `submitLivenessAttestation`).
    enum Tier {
        None,
        Liveness,
        Passport
    }

    // ─── Errors ───────────────────────────────────────────────────────

    error OnlyDiamond();
    error InvalidAddress();
    error InvalidQuantity();
    error ProductNotFound();
    error ProductInactive();
    error AmountExceedsLimit();
    error DailyCountExceeded();
    error ContractPaused();
    error OrderValidationMissing();
    error OrderIdAlreadyUsed();
    error RenounceDisabled();
    /// @notice An owner-settable limit was set above its immutable ceiling.
    error CapExceedsCeiling();
    error InvalidTier();
    /// @notice The currency is not on the owner-managed allowlist. Only the
    ///         canonical label is allowed per fiat (no `keccak("INR")`,
    ///         lowercase or padded aliases falling into the OTHER bucket).
    error CurrencyNotAllowed();

    // KYC / attestation
    /// @notice The buyer has no attestation; the checkout is closed to them.
    error NotAttested();
    /// @notice The attestation's claim deadline has already passed.
    error AttestationExpired();
    /// @notice The nullifier was already consumed by a previous attestation.
    error NullifierUsed();
    /// @notice The signature did not recover to the matching immutable attestor.
    error InvalidSignature();
    /// @notice An attestation can only raise the tier, never lower it.
    error TierDowngrade();
    /// @notice The signed claim deadline is further out than allowed.
    error DeadlineTooFar();

    // ─── Events ───────────────────────────────────────────────────────

    event ProductPriceSet(uint256 indexed productId, uint256 price);
    event ProductActiveSet(uint256 indexed productId, bool active);
    event TxLimitUpdated(bytes32 indexed currency, Tier indexed tier, uint256 limit);
    event CurrencyAllowlistUpdated(bytes32 indexed currency, bool allowed);
    event DailyTxCountLimitUpdated(uint256 count);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event UserProxyDeployed(address indexed user, address proxy);
    event UsdcSwept(address indexed to, uint256 amount);

    /// @notice A buyer's verification tier was recorded from a valid attestor
    ///         signature. `nullifier` is stable per person and bound to the
    ///         wallet, so re-verification is allowed but another wallet is not.
    event AttestationSubmitted(address indexed user, uint8 indexed tier, bytes32 nullifier);

    /// @notice Emitted for every accepted placement so the widget / backend can
    ///         read the product metadata from a single receipt.
    event BlioOrderCreated(
        uint256 indexed orderId,
        address indexed user,
        uint256 productId,
        uint256 quantity,
        uint256 usdcAmount
    );

    /// @notice The signal blio's backend consumes to grant Premium.
    event BlioOrderCompleted(
        uint256 indexed orderId,
        address indexed user,
        uint256 productId,
        uint256 quantity,
        uint256 usdcAmount
    );

    event BlioOrderCancelled(uint256 indexed orderId, address indexed user);

    /// @notice A completion that does not match the recorded order — most
    ///         importantly when the Diamond routed USDC somewhere other than
    ///         `treasury` (the on-chain signature of a mis-registration).
    event SettlementRoutingAnomaly(
        uint256 indexed orderId,
        address expectedUser,
        address callbackUser,
        uint256 callbackAmount,
        address callbackRecipient
    );

    // ─── Immutables ───────────────────────────────────────────────────

    address public immutable diamond;
    IERC20 public immutable usdc;
    /// @notice Canonical `UserProxy` master every per-user clone deploys from.
    ///         Pinned on the Diamond at registration and set-once there.
    address public immutable proxyImpl;
    /// @notice Where the Diamond settles the USDC (the blio Safe). Never this
    ///         contract, and never an intermediate vault.
    address public immutable treasury;
    /// @notice Signer of the liveness attestations (`LivenessVerifier` domain).
    ///         Immutable: rotating it requires a redeploy, which is the point —
    ///         no owner key can mint tiers or rewrite trust after the fact.
    address public immutable livenessAttestor;
    /// @notice Signer of the passport/KYC attestations (`KycVerifier` domain).
    ///         Immutable, non-zero and distinct from `livenessAttestor`.
    address public immutable kycAttestor;

    /// @notice EIP-712 domain separator for liveness attestations.
    bytes32 private immutable _livenessDomain;
    /// @notice EIP-712 domain separator for passport/KYC attestations.
    bytes32 private immutable _kycDomain;

    // ─── Immutable policy ceilings ────────────────────────────────────
    // Compiled into the bytecode. The constructor and every owner setter are
    // bounded by these, so no limit can ever exceed its ceiling — not by a
    // compromised owner key. Movement below a ceiling is free in both
    // directions.
    uint256 public constant MAX_DAILY_TX_COUNT_LIMIT = 5; // placements/user/day

    /// @notice A signed attestation claim must land within this window of
    ///         `block.timestamp`; a far-future deadline cannot be redeemed.
    ///         p2p issues short-lived claims with `expiry = issuedAt + 1 hour`;
    ///         the 2-hour cap leaves margin for block drift.
    uint256 public constant MAX_ATTESTATION_DEADLINE = 2 hours;
    /// @notice How long a recorded tier stays usable after `attestedAt`,
    ///         independent of the signed claim deadline. Past this point
    ///         `_tierOf` reports `None` (fail closed).
    uint256 public constant ATTESTATION_TTL = 180 days;

    /// @notice Per-tx ceilings by currency class and verification tier
    ///         (6 decimals). INR is deliberately tighter than the rest.
    uint256 public constant MAX_TX_LIMIT_INR_LIVENESS = 20e6; // $20
    uint256 public constant MAX_TX_LIMIT_INR_PASSPORT = 100e6; // $100
    uint256 public constant MAX_TX_LIMIT_OTHER_LIVENESS = 50e6; // $50
    uint256 public constant MAX_TX_LIMIT_OTHER_PASSPORT = 200e6; // $200

    bytes32 public constant INR_CURRENCY = bytes32("INR");
    /// @notice Wildcard bucket every non-INR currency normalizes to.
    bytes32 public constant OTHER_CURRENCY = bytes32(0);

    // ─── EIP-712 constants ────────────────────────────────────────────

    /// @dev keccak256("LivenessAttestation(address wallet,bytes32 nullifier,uint256 limit,uint256 expiry)")
    bytes32 private constant _LIVENESS_TYPEHASH =
        keccak256(
            "LivenessAttestation(address wallet,bytes32 nullifier,uint256 limit,uint256 expiry)"
        );
    /// @dev keccak256("KycAttestation(address wallet,bytes32 nullifier,uint256 limit,uint256 expiry)")
    bytes32 private constant _KYC_TYPEHASH =
        keccak256("KycAttestation(address wallet,bytes32 nullifier,uint256 limit,uint256 expiry)");
    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
    bytes32 private constant _LIVENESS_DOMAIN_NAME = keccak256(bytes("LivenessVerifier"));
    bytes32 private constant _KYC_DOMAIN_NAME = keccak256(bytes("KycVerifier"));
    bytes32 private constant _DOMAIN_VERSION = keccak256(bytes("1"));

    // ─── Configurable limits ──────────────────────────────────────────

    /// @dev Effective per-tx USDC cap by normalized currency and tier
    ///      (6 decimals). Initialized to the immutable ceilings in the
    ///      constructor; every owner write is bounded by them.
    mapping(bytes32 => mapping(Tier => uint256)) private _limitFor;
    /// @notice Owner-managed allowlist of exact currency labels. INR and the
    ///         OTHER wildcard (`bytes32(0)`) are enabled in the constructor;
    ///         any other label (BRL, PIX, ...) must be explicitly added. This
    ///         blocks look-alike labels (`keccak("INR")`, `"inr"`, `"INR "`)
    ///         from reaching the looser OTHER bucket.
    mapping(bytes32 => bool) public allowedCurrency;
    /// @notice Placements allowed per user per UTC day.
    uint256 public dailyTxCountLimit;
    bool public paused;

    /// @notice Buyer verification tier, written only by a valid attestation.
    ///         `None` is the default and grants a zero limit.
    mapping(address => Tier) public tierOf;
    /// @notice Per-tx USDC ceiling the latest attestation signed for the buyer
    ///         (6 decimals). 0 means "no attested cap": policy applies.
    mapping(address => uint256) public attestedLimit;
    /// @notice Timestamp of the last accepted attestation for each buyer.
    mapping(address => uint256) public attestedAt;
    /// @notice Timestamp after which the recorded tier stops counting.
    mapping(address => uint256) public attestationExpiresAt;
    /// @notice Wallet each Sybil nullifier is bound to. p2p's nullifier is
    ///         stable per (tenant, human, contract), so the same wallet may
    ///         re-attest or upgrade tiers with it, while another wallet can
    ///         never replay it.
    mapping(bytes32 => address) public nullifierWallet;

    // ─── Products ─────────────────────────────────────────────────────

    /// @notice USDC price per unit of `productId` (6 decimals). 0 = unknown.
    mapping(uint256 => uint256) public productPrice;
    /// @notice Whether a product can be purchased. Lets the owner retire one
    ///         without deleting its price history.
    mapping(uint256 => bool) public productActive;

    // ─── Order state ──────────────────────────────────────────────────

    struct Session {
        address user; // 20 bytes
        bool fulfilled; //  1 byte — packs with user
        bool cancelled; //  1 byte — packs with user
        uint256 productId;
        uint256 quantity;
        uint256 usdcAmount;
    }

    mapping(uint256 => Session) public sessions;
    mapping(address => mapping(uint256 => uint256)) public userDailyCount;

    /// @dev Binds the Diamond's synchronous `validateOrder` to the placement
    ///      this contract is executing right now, so only the exact
    ///      (user, amount, currency) tuple in flight can validate.
    struct PendingPlacement {
        address user;
        uint256 amount;
        bytes32 currency;
        bool validated;
    }

    PendingPlacement private _pendingPlacement;

    // ─── Modifiers ────────────────────────────────────────────────────

    modifier onlyDiamond() {
        if (msg.sender != diamond) revert OnlyDiamond();
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────

    /**
     * @param _diamond      P2P Diamond proxy for the target network.
     * @param _usdc         USDC the Diamond settles in on that network.
     * @param _treasury     Destination of every settlement (the blio Safe).
     * @param _owner        Operator key (a multisig): limits, products, pause.
     *                      Transferable two-step via `transferOwnership` /
     *                      `acceptOwnership`.
     * @param _dailyTxCount      Placements per user per day (max 5).
     * @param _livenessAttestor  Liveness service signer. Immutable and non-zero.
     * @param _kycAttestor       Passport/KYC service signer. Immutable, non-zero
     *                           and distinct from `_livenessAttestor`: p2p uses
     *                           separate signers per service.
     */
    constructor(
        address _diamond,
        address _usdc,
        address _treasury,
        address _owner,
        uint256 _dailyTxCount,
        address _livenessAttestor,
        address _kycAttestor
    ) Ownable(_owner) {
        if (
            _diamond == address(0) ||
            _usdc == address(0) ||
            _treasury == address(0) ||
            _owner == address(0) ||
            _livenessAttestor == address(0) ||
            _kycAttestor == address(0) ||
            _livenessAttestor == _kycAttestor
        ) revert InvalidAddress();
        if (_dailyTxCount == 0) revert InvalidQuantity();
        if (_dailyTxCount > MAX_DAILY_TX_COUNT_LIMIT) revert CapExceedsCeiling();

        diamond = _diamond;
        usdc = IERC20(_usdc);
        treasury = _treasury;
        livenessAttestor = _livenessAttestor;
        kycAttestor = _kycAttestor;
        dailyTxCountLimit = _dailyTxCount;

        _livenessDomain = keccak256(
            abi.encode(
                _EIP712_DOMAIN_TYPEHASH,
                _LIVENESS_DOMAIN_NAME,
                _DOMAIN_VERSION,
                block.chainid,
                address(this)
            )
        );
        _kycDomain = keccak256(
            abi.encode(
                _EIP712_DOMAIN_TYPEHASH,
                _KYC_DOMAIN_NAME,
                _DOMAIN_VERSION,
                block.chainid,
                address(this)
            )
        );

        // Seed the whole matrix at its immutable ceiling. Non-INR currencies
        // share the OTHER_CURRENCY bucket, so one write covers "resto".
        _limitFor[INR_CURRENCY][Tier.Liveness] = MAX_TX_LIMIT_INR_LIVENESS;
        _limitFor[INR_CURRENCY][Tier.Passport] = MAX_TX_LIMIT_INR_PASSPORT;
        _limitFor[OTHER_CURRENCY][Tier.Liveness] = MAX_TX_LIMIT_OTHER_LIVENESS;
        _limitFor[OTHER_CURRENCY][Tier.Passport] = MAX_TX_LIMIT_OTHER_PASSPORT;

        // The canonical INR label and the OTHER wildcard are the only ones
        // enabled out of the box; every other fiat is opt-in via the owner.
        allowedCurrency[INR_CURRENCY] = true;
        allowedCurrency[OTHER_CURRENCY] = true;

        proxyImpl = address(new UserProxy());
    }

    // ─── Admin ────────────────────────────────────────────────────────

    function setProductPrice(uint256 productId, uint256 price) external onlyOwner {
        productPrice[productId] = price;
        emit ProductPriceSet(productId, price);
    }

    function setProductActive(uint256 productId, bool active) external onlyOwner {
        productActive[productId] = active;
        emit ProductActiveSet(productId, active);
    }

    function setTxLimit(bytes32 currency, Tier tier, uint256 limit) external onlyOwner {
        if (tier == Tier.None) revert InvalidTier();
        if (limit == 0) revert InvalidQuantity();
        if (limit > maxTxLimitFor(currency, tier)) revert CapExceedsCeiling();
        bytes32 key = normalizeCurrency(currency);
        _limitFor[key][tier] = limit;
        emit TxLimitUpdated(currency, tier, limit);
    }

    function setDailyTxCountLimit(uint256 count) external onlyOwner {
        if (count == 0) revert InvalidQuantity();
        if (count > MAX_DAILY_TX_COUNT_LIMIT) revert CapExceedsCeiling();
        dailyTxCountLimit = count;
        emit DailyTxCountLimitUpdated(count);
    }

    /// @notice Enable or disable an exact currency label. Only enabled labels
    ///         (plus `bytes32(0)`, the OTHER wildcard) can be placed.
    function setCurrencyAllowed(bytes32 currency, bool allowed) external onlyOwner {
        allowedCurrency[currency] = allowed;
        emit CurrencyAllowlistUpdated(currency, allowed);
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

    /// @notice Disabled: burning ownership would permanently disable the
    ///         limits, product, pause and recovery levers.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// @notice Recover USDC that should never sit here. By construction every
    ///         settlement routes to `treasury`, so a non-zero balance means a
    ///         stray transfer or a mis-registration.
    function sweepUsdc(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert InvalidAddress();
        usdc.safeTransfer(to, amount);
        emit UsdcSwept(to, amount);
    }

    // ─── Attestations ─────────────────────────────────────────────────

    /**
     * @notice Verify and record a liveness-tier attestation for `msg.sender`.
     *
     * @dev    Byte-compatible with p2p's simple-kyc reference verifier:
     *         type `LivenessAttestation(address wallet,bytes32 nullifier,
     *         uint256 limit,uint256 expiry)` under the domain
     *         `("LivenessVerifier", "1", block.chainid, address(this))`, signed
     *         by `livenessAttestor`.
     *
     *         `expiry` is the service's short-lived claim deadline (p2p signs
     *         `issuedAt + 1 hour`). It is capped to
     *         `block.timestamp + MAX_ATTESTATION_DEADLINE` so a bearer signature
     *         cannot sit around forever. The recorded tier is independent of
     *         that claim and lives for `ATTESTATION_TTL` from acceptance.
     *
     * @param nullifier Per-(tenant, human) Sybil nullifier from the service.
     * @param limit     Attested per-tx USDC ceiling (6dp). 0 = use policy.
     * @param expiry    Unix seconds; the claim must land strictly before this.
     * @param signature 65-byte secp256k1 signature (r ‖ s ‖ v) from the service.
     */
    function submitLivenessAttestation(
        bytes32 nullifier,
        uint256 limit,
        uint256 expiry,
        bytes calldata signature
    ) external {
        _submitAttestation(
            msg.sender,
            nullifier,
            limit,
            expiry,
            signature,
            _livenessDomain,
            _LIVENESS_TYPEHASH,
            livenessAttestor,
            Tier.Liveness
        );
    }

    /**
     * @notice Verify and record a passport+liveness (KYC) attestation for
     *         `wallet`.
     *
     * @dev    Type `KycAttestation(address wallet,bytes32 nullifier,uint256
     *         limit,uint256 expiry)` under the domain
     *         `("KycVerifier", "1", block.chainid, address(this))`, signed by
     *         `kycAttestor`. The signature binds `wallet`, so a relayer (the
     *         gas service, a backend) may submit it without changing the grant.
     *
     *         Tiers are monotonic: KYC always lands as `Passport`; the
     *         liveness function refuses to downgrade a Passport buyer.
     *
     * @param wallet    Buyer the attestation is for (bound in the signature).
     * @param nullifier Per-(tenant, human) Sybil nullifier from the service.
     * @param limit     Attested per-tx USDC ceiling (6dp). Clamped to policy.
     * @param expiry    Unix seconds; the claim must land strictly before this.
     * @param signature 65-byte secp256k1 signature (r ‖ s ‖ v) from the service.
     */
    function submitKycAttestation(
        address wallet,
        bytes32 nullifier,
        uint256 limit,
        uint256 expiry,
        bytes calldata signature
    ) external {
        _submitAttestation(
            wallet,
            nullifier,
            limit,
            expiry,
            signature,
            _kycDomain,
            _KYC_TYPEHASH,
            kycAttestor,
            Tier.Passport
        );
    }

    /// @dev Shared intake for both services. `domain` and `typeHash` are the
    ///      service-specific EIP-712 values; `attestor_` is the matching
    ///      immutable signer. A nullifier is bound to one wallet and shared
    ///      across tiers, so the same wallet may re-verify or upgrade, but the
    ///      nullifier can never be replayed by another wallet.
    function _submitAttestation(
        address wallet,
        bytes32 nullifier,
        uint256 limit,
        uint256 expiry,
        bytes calldata signature,
        bytes32 domain,
        bytes32 typeHash,
        address attestor_,
        Tier tier
    ) internal {
        if (wallet == address(0)) revert InvalidAddress();
        if (block.timestamp >= expiry) revert AttestationExpired();
        if (expiry > block.timestamp + MAX_ATTESTATION_DEADLINE) revert DeadlineTooFar();
        address nw = nullifierWallet[nullifier];
        if (nw != address(0) && nw != wallet) revert NullifierUsed();
        if (uint8(tier) < uint8(tierOf[wallet])) revert TierDowngrade();

        bytes32 structHash = keccak256(abi.encode(typeHash, wallet, nullifier, limit, expiry));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        if (_recover(digest, signature) != attestor_) revert InvalidSignature();

        nullifierWallet[nullifier] = wallet;
        tierOf[wallet] = tier;
        attestedLimit[wallet] = limit;
        attestedAt[wallet] = block.timestamp;
        attestationExpiresAt[wallet] = block.timestamp + ATTESTATION_TTL;

        emit AttestationSubmitted(wallet, uint8(tier), nullifier);
    }

    // ─── User-facing placement ────────────────────────────────────────

    /**
     * @notice Place a checkout order for `quantity` units of `productId`.
     *         Cost = productPrice[productId] * quantity.
     *
     * @dev    The UserProxy is the authenticated caller into the gateway; it is
     *         a thin placement vehicle, never a USDC router (`recipientAddr`
     *         is the treasury).
     */
    function userPlaceOrder(
        uint256 productId,
        uint256 quantity,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) external nonReentrant returns (uint256 orderId) {
        if (paused) revert ContractPaused();
        if (quantity == 0) revert InvalidQuantity();
        if (!allowedCurrency[currency]) revert CurrencyNotAllowed();
        if (_tierOf(msg.sender) == Tier.None) revert NotAttested();

        uint256 price = productPrice[productId];
        if (price == 0) revert ProductNotFound();
        if (!productActive[productId]) revert ProductInactive();

        uint256 total = price * quantity;

        // Friendly pre-checks; `validateOrder` re-enforces authoritatively.
        uint256 lim = userTxLimitFor(msg.sender, currency);
        if (total > lim) revert AmountExceedsLimit();
        if (userDailyCount[msg.sender][block.timestamp / 1 days] >= dailyTxCountLimit) {
            revert DailyCountExceeded();
        }

        _pendingPlacement = PendingPlacement({
            user: msg.sender,
            amount: total,
            currency: currency,
            validated: false
        });

        orderId = _placeOrder(
            total,
            currency,
            circleId,
            pubKey,
            preferredPaymentChannelConfigId,
            fiatAmountLimit
        );

        // The Diamond must have called back through `validateOrder` during the
        // placement. If not, the order was created without passing this gate.
        if (!_pendingPlacement.validated) revert OrderValidationMissing();
        delete _pendingPlacement;

        if (sessions[orderId].user != address(0)) revert OrderIdAlreadyUsed();

        sessions[orderId] = Session({
            user: msg.sender,
            fulfilled: false,
            cancelled: false,
            productId: productId,
            quantity: quantity,
            usdcAmount: total
        });

        emit BlioOrderCreated(orderId, msg.sender, productId, quantity, total);
    }

    function _placeOrder(
        uint256 total,
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
                total,
                currency,
                treasury,
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

    /// @dev The Diamond's synchronous gate during `placeB2BOrder`. Returns
    ///      false (the gateway unwinds) rather than reverting.
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

        // Authoritative attestation gate: an unattested buyer can never place an
        // order, and unlike the amount/daily checks this reverts (rather than
        // returning false) so the reason is visible in the receipt.
        if (_tierOf(user) == Tier.None) revert NotAttested();
        if (!allowedCurrency[currency]) revert CurrencyNotAllowed();

        if (amount == 0) return false;
        if (amount > userTxLimitFor(user, currency)) return false;

        uint256 day = block.timestamp / 1 days;
        uint256 count = userDailyCount[user][day];
        if (count >= dailyTxCountLimit) return false;

        pending.validated = true;
        userDailyCount[user][day] = count + 1;

        return true;
    }

    /**
     * @notice Completion hook. USDC has already been delivered to `treasury` by
     *         the Diamond; this only verifies the callback matches the recorded
     *         order and emits the signal blio's backend consumes.
     *
     * @dev    Never reverts: the gateway wraps this in try/catch, so a revert
     *         would only lose the event and leave the session unfinalised.
     */
    function onOrderComplete(
        uint256 orderId,
        address user,
        uint256 amount,
        address recipientAddr
    ) external onlyDiamond {
        Session storage session = sessions[orderId];
        // A cancellation is NOT terminal in the protocol: an admin can re-open a
        // CANCELLED BUY (dispute path) and complete it. Ignoring `cancelled`
        // here is what lets that reopened order still grant Premium; only an
        // already-fulfilled session is truly done.
        if (session.user == address(0) || session.fulfilled) return;

        // Ask the Diamond how it is routing us, rather than trusting the
        // callback itself: `recipientAddr` is passed unchanged in both routing
        // branches, so it cannot reveal a mis-registered
        // `usdcThroughIntegrator = true` that would strand the USDC here.
        (bool routesHere, bool flagKnown) = _routesThroughIntegrator();
        bool misrouted = flagKnown ? routesHere : usdc.balanceOf(address(this)) >= amount;

        if (
            session.user != user ||
            session.usdcAmount != amount ||
            recipientAddr != treasury ||
            misrouted
        ) {
            emit SettlementRoutingAnomaly(orderId, session.user, user, amount, recipientAddr);
            return;
        }

        session.fulfilled = true;
        emit BlioOrderCompleted(orderId, session.user, session.productId, session.quantity, amount);
    }

    /// @notice Cancellation hook. Marks the session cancelled; it does NOT
    ///         release the daily-count slot reserved in `validateOrder`.
    /// @dev    The counter measures PLACEMENTS, not successful settlements, so
    ///         cancel-and-retry still consumes the user's daily allowance. That
    ///         is also coherent with `cancelCallbackEnabled = false`: the
    ///         gateway may never call this hook at all, so any refund of the
    ///         slot here would be best-effort and gameable. Never reverts
    ///         (best-effort from the gateway's POV).
    function onOrderCancel(uint256 orderId) external onlyDiamond {
        Session storage session = sessions[orderId];
        if (session.user == address(0) || session.fulfilled || session.cancelled) return;

        session.cancelled = true;

        emit BlioOrderCancelled(orderId, session.user);
    }

    // ─── Views ────────────────────────────────────────────────────────

    /// @notice Effective per-tx USDC limit for `user` in `currency`, based on
    ///         the buyer's verification tier. Returns 0 (fail closed) when
    ///         the tier is missing/expired or the label is not allowlisted.
    function userTxLimitFor(address user, bytes32 currency) public view returns (uint256) {
        Tier tier = _tierOf(user);
        if (tier == Tier.None) return 0;
        if (!allowedCurrency[currency]) return 0;

        uint256 policy = _limitFor[normalizeCurrency(currency)][tier];
        uint256 attested = attestedLimit[user];
        // The signed limit can only tighten the policy, never widen it. 0 means
        // "the service did not cap it", so the policy applies.
        if (attested == 0 || attested >= policy) return policy;
        return attested;
    }

    /// @notice Effective per-tx USDC cap stored for `currency` at `tier`.
    function limitFor(bytes32 currency, Tier tier) public view returns (uint256) {
        return _limitFor[normalizeCurrency(currency)][tier];
    }

    /// @notice Widget helper: effective per-tx cap for the caller in `currency`.
    function userTxLimit(bytes32 currency) external view returns (uint256) {
        return userTxLimitFor(msg.sender, currency);
    }

    /// @notice EIP-712 domain separator the liveness attestor signs under.
    function livenessDomainSeparator() external view returns (bytes32) {
        return _livenessDomain;
    }

    /// @notice EIP-712 domain separator the KYC/passport attestor signs under.
    function kycDomainSeparator() external view returns (bytes32) {
        return _kycDomain;
    }

    /// @notice Currency class the limit matrix is keyed by: INR is its own
    ///         bucket and every other currency shares `OTHER_CURRENCY`. Only
    ///         the exact canonical labels reach a bucket: INR must be
    ///         `bytes32("INR")`, and the OTHER bucket is reachable only via
    ///         `bytes32(0)` or an owner-allowlisted label. Look-alikes such as
    ///         `keccak("INR")`, `"inr"` or `"INR "` are rejected on placement.
    function normalizeCurrency(bytes32 currency) public pure returns (bytes32) {
        return currency == INR_CURRENCY ? INR_CURRENCY : OTHER_CURRENCY;
    }

    /// @notice Immutable ceiling for a (currency, tier) pair.
    function maxTxLimitFor(bytes32 currency, Tier tier) public pure returns (uint256) {
        bool inr = normalizeCurrency(currency) == INR_CURRENCY;
        if (tier == Tier.Passport) {
            return inr ? MAX_TX_LIMIT_INR_PASSPORT : MAX_TX_LIMIT_OTHER_PASSPORT;
        }
        if (tier == Tier.Liveness) {
            return inr ? MAX_TX_LIMIT_INR_LIVENESS : MAX_TX_LIMIT_OTHER_LIVENESS;
        }
        return 0;
    }

    /// @dev The recorded tier, or `None` — which `userTxLimitFor` maps to a zero
    ///      limit, so an unattested or expired buyer cannot transact.
    function _tierOf(address user) internal view returns (Tier) {
        Tier tier = tierOf[user];
        if (tier == Tier.None) return Tier.None;
        if (block.timestamp > attestationExpiresAt[user]) return Tier.None;
        return tier;
    }

    function getRemainingDailyCount(address user) external view returns (uint256) {
        uint256 count = userDailyCount[user][block.timestamp / 1 days];
        if (count >= dailyTxCountLimit) return 0;
        return dailyTxCountLimit - count;
    }

    function getTodayCount(address user) external view returns (uint256) {
        return userDailyCount[user][block.timestamp / 1 days];
    }

    function getSession(uint256 orderId) external view returns (Session memory) {
        return sessions[orderId];
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

    // ─── Internal: proxy helpers ──────────────────────────────────────

    /// @dev `bytes4(keccak256("getIntegratorConfig(address)"))`.
    bytes4 private constant _GET_INTEGRATOR_CONFIG = 0x17353447;

    /// @dev Is the Diamond routing this integrator's settlements to us? Reads
    ///      word 1 (`usdcThroughIntegrator`) raw, so it survives the config
    ///      struct growing fields in the middle.
    function _routesThroughIntegrator() private view returns (bool routes, bool known) {
        (bool ok, bytes memory ret) = diamond.staticcall(
            abi.encodeWithSelector(_GET_INTEGRATOR_CONFIG, address(this))
        );
        if (!ok || ret.length < 64) return (false, false);

        uint256 flag;
        assembly {
            flag := mload(add(ret, 0x40))
        }
        return (flag != 0, true);
    }

    // ─── Internal: EIP-712 attestation verification ───────────────────

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
        // signature has a malleated twin that recovers the same signer.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0)
            revert InvalidSignature();
        if (v != 27 && v != 28) revert InvalidSignature();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
        return signer;
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
}
