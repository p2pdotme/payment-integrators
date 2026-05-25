// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { IMegapot, IBatchPurchaseFacilitator } from "./IMegapot.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { GrantVault } from "../../base/GrantVault.sol";

/**
 * @title LotPotCheckoutIntegrator
 * @notice P2P integrator for the LotPot product, which sells Megapot lottery
 *         tickets through the P2P fiat checkout flow.
 *
 *         Two order entry points:
 *           - userPlaceOrder           — auto-random ticket numbers, generated
 *                                        on-chain at fulfillment time.
 *           - userPlaceOrderWithPicks  — user supplies the ticket numbers.
 *
 *         Placement and USDC custody flow through a per-user UserProxy
 *         clone (CREATE2 + immutable args): the proxy is the on-chain caller
 *         of the Diamond at placement and the temporary USDC holder until
 *         fulfillment. Ticket NFTs are minted **directly to the user EOA**
 *         by Megapot — both `buyTickets(_, recipient, …)` and
 *         `createBatchOrder(recipient, …)` take an explicit recipient
 *         parameter, so the proxy never receives NFTs.
 *
 *         Credit accounting: USDC stranded on a user's proxy (from a
 *         previously skipped fulfillment) is treated as a credit balance
 *         against the integrator. Subsequent placements auto-net against
 *         it: if the new order's total exceeds the credit, the Diamond
 *         order is placed for the delta only; if the credit covers the
 *         total, the order skips the Diamond entirely and the integrator
 *         buys tickets straight from the proxy's USDC. Credit can only
 *         exit as Megapot tickets — UserProxy disables both user-initiated
 *         USDC sweep AND auto-refund of USDC remainder in `execute`, so
 *         any USDC on the proxy must be consumed via this credit-redemption
 *         path. That closes a fraud-bypass surface where B2B-mediated
 *         fiat-to-USDC conversion would otherwise evade consumer-side
 *         fraud checks.
 *
 *         RP-based per-tx limits and daily count limits match
 *         ExampleIntegrator.
 */
/**
 * @dev V2 of the LotPot checkout integrator. Adds an on-chain "issued credit"
 *      ledger that the P2P Diamond writes to as part of its non-B2B BUY-order
 *      cashback flow, plus a two-vault pull pattern (Megapot-funded grant
 *      vault primary, P2P-funded fallback) consumed inside `_route` to
 *      materialize the credit as USDC on the user's proxy at ticket-purchase
 *      time. V1 behavior (skipped-fulfillment credit, _route, _redeemFromCredit,
 *      batch fulfillment, RP/limits) is preserved.
 */
contract LotPotCheckoutIntegratorV2 is IP2PIntegrator {
    using SafeERC20 for IERC20;

    // ─── Errors ───────────────────────────────────────────────────────

    error OnlyDiamond();
    error OnlyOwner();
    error OrderAlreadyFulfilled();
    error OrderAlreadyCancelled();
    error UnknownOrder();
    error AmountMismatch();
    error MegapotReturnMismatch();
    error InvalidAddress();
    error InvalidQuantity();
    error InvalidTicketPrice();
    error InvalidBallRange();
    error TooManyTickets();
    error ArrayLengthMismatch();
    // V2-only:
    error OnlyCreditIssuer();
    error InvalidAmount();

    // ─── Events ───────────────────────────────────────────────────────

    /// @notice `totalUsdcAmount` is the full purchase price (= quantity ×
    ///         placement-time ticketPrice). For credit-applied orders the
    ///         Diamond's `B2BOrderPlaced.amount` will be smaller (= total −
    ///         credit netted from the proxy); reconcile via the matching
    ///         `LotPotCreditRedeemed.creditUsed` event for the same orderId.
    event LotPotOrderCreated(
        uint256 indexed orderId,
        address indexed user,
        uint256 quantity,
        bool autoRandom,
        uint256 totalUsdcAmount
    );
    /// @notice Order fulfilled via Jackpot.buyTickets — tickets minted and
    ///         already swept to the user EOA inside this transaction.
    event LotPotFulfilled(
        uint256 indexed orderId,
        address indexed user,
        address indexed proxy,
        uint256 quantity
    );
    /// @notice Order routed through BatchPurchaseFacilitator (quantity > 10).
    ///         Tickets are minted asynchronously by Megapot's keeper *directly
    ///         to the user EOA* — the integrator emits no further event for
    ///         this order. Frontends/indexers should listen for the
    ///         facilitator's `BatchOrderExecuted` (with `_recipient = user`)
    ///         and/or `JackpotTicketNFT.Transfer(to=user)` to detect the
    ///         actual mint.
    event LotPotBatchFulfilled(
        uint256 indexed orderId,
        address indexed user,
        address indexed proxy,
        uint256 dynamicTicketCount,
        uint256 staticTicketCount
    );
    event LotPotOrderCancelled(uint256 indexed orderId, address indexed user);
    /// @notice User redeemed stranded proxy credit (in whole or in part)
    ///         for Megapot tickets. Fired for both pure credit-only
    ///         redemptions (no Diamond order, `orderId = 0`) and for
    ///         delta-mediated orders where credit was netted against a
    ///         smaller Diamond order (`orderId = the Diamond orderId`).
    event LotPotCreditRedeemed(
        address indexed user,
        uint256 indexed orderId,
        uint256 quantity,
        uint256 creditUsed
    );
    /// @notice Order could not be fulfilled at Megapot because the active
    ///         drawing's state no longer matches the placement-time
    ///         commitment (e.g. a daily rollover invalidated user picks, or
    ///         Megapot's owner raised the per-drawing ticketPrice above what
    ///         the user committed). USDC is intentionally **left on the
    ///         user's proxy** — the user (and only the user) can recover it
    ///         by calling `proxy.sweepERC20(usdc)` from their EOA. Auto-
    ///         pushing the refund inline would let an attacker use the B2B
    ///         path to bypass consumer-side fraud checks; requiring an
    ///         explicit owner-signed recovery preserves that gate.
    ///
    ///         The session is recorded as fulfilled so the Diamond's
    ///         settlement state closes; querying `getSession(orderId)`
    ///         returns `fulfilled = true` for an order that emitted this
    ///         event, distinguishable from a true success by the absence
    ///         of a `LotPotFulfilled` / `LotPotBatchFulfilled` for the
    ///         same orderId.
    event LotPotFulfillmentSkipped(
        uint256 indexed orderId,
        address indexed user,
        address indexed proxy,
        uint256 amount,
        SkipReason reason
    );
    event UserProxyDeployed(address indexed user, address proxy);

    enum SkipReason {
        PriceExceedsCommitment, // currentDrawing.ticketPrice * qty > committed
        PicksOutOfRange, // user picks invalid for the active drawing
        UpstreamReverted // Megapot buyTickets / facilitator createBatchOrder reverted
    }

    event SourceUpdated(bytes32 source);

    event UserRPUpdated(address indexed user, uint256 rp);
    event RpRateUpdated(bytes32 indexed currency, uint256 usdcPerRp);
    event BaseTxLimitUpdated(uint256 limit);
    event MaxTxLimitUpdated(bytes32 indexed currency, uint256 cap);
    event DailyTxCountLimitUpdated(uint256 count);

    // V2-only events
    /// @notice A whitelisted caller (initially the P2P Diamond) registered
    ///         issued cashback credit for a user. No USDC moves at this
    ///         point — it's a ledger increment, consumed at ticket purchase.
    event CreditIssued(address indexed issuer, address indexed user, uint256 amount);
    /// @notice A user's issued credit was consumed during a ticket purchase
    ///         (the integrator pulled USDC from the vaults equal to `consumed`).
    event CreditConsumed(address indexed user, uint256 consumed, uint256 remaining);
    /// @notice Owner toggled a credit issuer's authorization.
    event CreditIssuerSet(address indexed issuer, bool approved);
    /// @notice Owner pointed the integrator at new grant/fallback vaults.
    event VaultsUpdated(address grantVault, address fallbackVault);

    // ─── Constants ────────────────────────────────────────────────────

    /// @notice Megapot's `buyTickets` is capped at 10 tickets per call. Above
    ///         this we route to BatchPurchaseFacilitator (whose
    ///         `minimumTicketCount` is 11 on Base mainnet, exactly matching
    ///         this boundary). Both auto-random and user-picked orders use
    ///         the same boundary — picks > 10 are passed as
    ///         `_userStaticTickets` to the batch path (verified against
    ///         mainnet 0x01774B53…aa76: there is no on-chain cap on the
    ///         static-ticket array; the "≤10" mentioned in Megapot's UI
    ///         docs is advisory only).
    ///
    ///         There is intentionally no separate "max tickets per order"
    ///         constant. The de-facto cap is the integrator's per-tx USDC
    ///         limit (`getUserTxLimit(user, currency)`), which the gateway
    ///         already enforces via `validateOrder` at placement: a user
    ///         can buy `getUserTxLimit / ticketPrice` tickets per order.
    ///         Owner-tunable via `setBaseTxLimit` / `setMaxTxLimit` /
    ///         `setRpToUsdc` / `setUserRP`.
    uint256 public constant MAX_DIRECT_TICKETS = 10;

    uint256 public constant NORMALS_PER_TICKET = 5;
    /// @notice Single-referrer full weight; Megapot requires split to total 1e18.
    uint256 public constant REFERRAL_SPLIT_FULL = 1e18;
    /// @notice Sanity cap on referrer count vs an unknown upstream Megapot limit.
    uint256 public constant MAX_REFERRERS = 10;

    // ─── Immutables ───────────────────────────────────────────────────

    address public immutable diamond;
    IERC20 public immutable usdc;
    address public immutable owner;
    address public immutable proxyImpl;
    address public immutable megapot;
    /// @notice BatchPurchaseFacilitator (Megapot's batch path for >10-ticket
    ///         orders). The integrator must be on this contract's allowlist
    ///         (managed by Megapot's owner) for createBatchOrder to succeed.
    ///         Pinned at construction so the integrator can't silently retarget
    ///         the user's USDC.
    address public immutable batchFacilitator;
    /// @notice JackpotTicketNFT — the ERC-721 minted by Megapot. Tickets land
    ///         here on the proxy and are batch-transferred to the user at
    ///         fulfillment.
    address public immutable jackpotNft;
    /// @notice Fallback referrer used whenever a placement supplies no
    ///         valid referrer set. Set to the deployer at construction;
    ///         immutable, no constructor input.
    address public immutable defaultReferrer;

    // ─── Configurable ─────────────────────────────────────────────────

    /// @notice Telemetry tag forwarded to Megapot's `buyTickets` for source
    ///         attribution. Owner-tunable.
    bytes32 public source;

    uint256 public baseTxLimit;
    uint256 public dailyTxCountLimit;
    mapping(bytes32 => uint256) public rpToUsdc;
    mapping(bytes32 => uint256) public maxTxLimit;
    mapping(address => uint256) public userRP;

    // ─── State ────────────────────────────────────────────────────────

    /// @dev Per-order snapshot of the active Megapot drawing's state at
    ///      placement (read from `getDrawingState(currentDrawingId)`).
    ///      Megapot is the single source of truth; the integrator never
    ///      caches its config in storage.
    ///
    ///      The snapshot's role differs by path:
    ///      - `usdcAmount` / `ticketPrice`: the user's USDC commitment. Frozen
    ///        here so the in-flight order isn't repriced if the drawing rolls
    ///        or Megapot's owner mutates the live drawing.
    ///      - `ballMax` / `bonusballMax`: informational for picks-mode orders
    ///        (records what range the user committed against). Fulfillment
    ///        re-reads the *current* drawing's ranges and refunds inline if
    ///        a rollover invalidated the picks. For auto-random orders these
    ///        fields are ignored at fulfillment — random picks are regenerated
    ///        against the active drawing's ranges so they always pass
    ///        Megapot's validation.
    ///
    ///      placementDay = block.timestamp/1 days when the order was placed —
    ///      onOrderCancel decrements userDailyCount keyed on that bucket so
    ///      a cancelled order's quota slot is returned to the user even when
    ///      the cancellation lands in a later UTC day.
    struct CheckoutSession {
        address user; // 20 bytes
        uint8 ballMax; //  1 byte  — packs with user
        uint8 bonusballMax; //  1 byte  — packs with user
        bool autoRandom; //  1 byte  — packs with user
        bool fulfilled; //  1 byte  — packs with user
        bool cancelled; //  1 byte  — packs with user
        uint32 placementDay; //  4 bytes — packs with user (slot 0 total: 29 bytes)
        uint256 quantity;
        uint256 usdcAmount;
        uint256 ticketPrice;
        IMegapot.Ticket[] tickets;
        address[] referrers;
        uint256[] referralSplit;
    }

    /// @dev Snapshot of a skipped order's referral set, retained per user so
    ///      the credit-only redemption path can attribute credit-funded
    ///      tickets to the original purchase's referrer (most-recent-skip-wins).
    struct StoredReferral {
        address[] referrers;
        uint256[] split;
    }

    /// @dev Bundles the Diamond placement params + referral arrays so each
    ///      entrypoint collapses ~8 calldata stack slots into one memory
    ///      pointer (keeps `userPlace*` under the EVM stack-depth limit).
    struct PlaceReq {
        bytes32 currency;
        uint256 circleId;
        uint256 preferredPaymentChannelConfigId;
        uint256 fiatAmountLimit;
        address[] referrers;
        uint256[] referralSplit;
    }

    mapping(uint256 => CheckoutSession) private _sessions;
    mapping(address => mapping(uint256 => uint256)) public userDailyCount;
    mapping(address => StoredReferral) private _creditReferral;

    /// @dev Monotonic counter used to seed auto-random tickets in the
    ///      credit-only redemption path (no Diamond orderId is available
    ///      there). Mixed with `user`, block.number, and blockhash so
    ///      multiple credit redemptions from the same user in the same
    ///      block produce distinct ticket numbers.
    uint256 private _creditRedemptionCounter;

    // ─── V2: Issued-credit ledger + vault config ──────────────────────

    /// @notice Per-user accumulating cashback ledger. Each `issueCredit`
    ///         call (gated to whitelisted issuers) adds to the user's
    ///         balance; each ticket purchase that consumes credit
    ///         decrements it by the amount actually pulled from vaults.
    ///         No expiry, no admin clearing — credits are inert until
    ///         redeemed.
    mapping(address => uint256) public issuedCredit;

    /// @notice Whitelist of contracts allowed to call `issueCredit`.
    ///         Initially: the P2P Diamond. Owner-managed.
    mapping(address => bool) public creditIssuer;

    /// @notice Primary vault (Megapot-funded). Set post-deploy by owner.
    ///         May be `address(0)` to disable the primary leg.
    address public grantVault;

    /// @notice Fallback vault (P2P-funded). Used when the grant vault is
    ///         empty or has revoked this integrator. May be `address(0)`
    ///         to disable the fallback leg.
    address public fallbackVault;

    // ─── Modifiers ────────────────────────────────────────────────────

    modifier onlyDiamond() {
        if (msg.sender != diamond) revert OnlyDiamond();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyCreditIssuer() {
        if (!creditIssuer[msg.sender]) revert OnlyCreditIssuer();
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────

    constructor(
        address _diamond,
        address _usdc,
        address _megapot,
        address _batchFacilitator,
        address _jackpotNft,
        uint256 _baseTxLimit,
        uint256 _dailyTxCountLimit,
        bytes32 _source
    ) {
        if (
            _diamond == address(0) ||
            _usdc == address(0) ||
            _megapot == address(0) ||
            _batchFacilitator == address(0) ||
            _jackpotNft == address(0)
        ) revert InvalidAddress();

        diamond = _diamond;
        usdc = IERC20(_usdc);
        megapot = _megapot;
        batchFacilitator = _batchFacilitator;
        jackpotNft = _jackpotNft;
        owner = msg.sender;
        baseTxLimit = _baseTxLimit;
        dailyTxCountLimit = _dailyTxCountLimit;
        source = _source;
        proxyImpl = address(new UserProxy());
        defaultReferrer = msg.sender;
    }

    // ─── V2 Admin: Credit issuers + vaults ────────────────────────────

    /// @notice Authorize (or revoke) a contract permitted to call
    ///         `issueCredit`. The P2P Diamond is the expected first
    ///         issuer; additional issuers may be added in the future.
    function setCreditIssuer(address issuer, bool approved) external onlyOwner {
        if (issuer == address(0)) revert InvalidAddress();
        creditIssuer[issuer] = approved;
        emit CreditIssuerSet(issuer, approved);
    }

    /// @notice Point the integrator at the grant + fallback vaults.
    ///         Either argument may be `address(0)` to disable that leg
    ///         (e.g., before Megapot's vault is deployed, set only the
    ///         P2P fallback). The vaults must independently whitelist
    ///         this integrator via `vault.setApprovedSpender`.
    function setVaults(address grant, address fallback_) external onlyOwner {
        if (grant == grantVault && fallback_ == fallbackVault) return;
        grantVault = grant;
        fallbackVault = fallback_;
        emit VaultsUpdated(grant, fallback_);
    }

    // ─── V2 Issuer-Gated: Credit ledger ───────────────────────────────

    /// @notice Register cashback credit for a user. Callable only by a
    ///         whitelisted credit issuer (the P2P Diamond on day one).
    ///         No USDC moves here — the credit is consumed lazily at the
    ///         user's next ticket purchase.
    function issueCredit(address user, uint256 amount) external onlyCreditIssuer {
        if (user == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        issuedCredit[user] += amount;
        emit CreditIssued(msg.sender, user, amount);
    }

    /// @notice UX helper. Frontend reads this before quoting the user's
    ///         next ticket purchase so the credit-adjusted fiat charge
    ///         can be shown accurately.
    /// @return onProxy        USDC physically sitting on the user's proxy
    ///                        (from any prior skipped fulfillment).
    /// @return issued         Cashback credit issued to this user, not yet redeemed.
    /// @return grantAvail     Current USDC balance of the grant vault
    ///                        (capacity to honor `issued` on the next pull).
    /// @return fallbackAvail  Current USDC balance of the fallback vault.
    function previewAvailableCredit(
        address user
    )
        external
        view
        returns (uint256 onProxy, uint256 issued, uint256 grantAvail, uint256 fallbackAvail)
    {
        onProxy = usdc.balanceOf(proxyAddress(user));
        issued = issuedCredit[user];
        grantAvail = grantVault == address(0) ? 0 : usdc.balanceOf(grantVault);
        fallbackAvail = fallbackVault == address(0) ? 0 : usdc.balanceOf(fallbackVault);
    }

    // ─── Admin: Source ────────────────────────────────────────────────

    function setSource(bytes32 _source) external onlyOwner {
        source = _source;
        emit SourceUpdated(_source);
    }

    // ─── Admin: Limits ────────────────────────────────────────────────

    function setBaseTxLimit(uint256 limit) external onlyOwner {
        baseTxLimit = limit;
        emit BaseTxLimitUpdated(limit);
    }

    function setDailyTxCountLimit(uint256 count) external onlyOwner {
        dailyTxCountLimit = count;
        emit DailyTxCountLimitUpdated(count);
    }

    function setRpToUsdc(bytes32 currency, uint256 usdcPerRp) external onlyOwner {
        rpToUsdc[currency] = usdcPerRp;
        emit RpRateUpdated(currency, usdcPerRp);
    }

    function setMaxTxLimit(bytes32 currency, uint256 cap) external onlyOwner {
        maxTxLimit[currency] = cap;
        emit MaxTxLimitUpdated(currency, cap);
    }

    function setUserRP(address user, uint256 rp) external onlyOwner {
        userRP[user] = rp;
        emit UserRPUpdated(user, rp);
    }

    function batchSetUserRP(address[] calldata users, uint256[] calldata rps) external onlyOwner {
        if (users.length != rps.length) revert ArrayLengthMismatch();
        for (uint256 i = 0; i < users.length; i++) {
            userRP[users[i]] = rps[i];
            emit UserRPUpdated(users[i], rps[i]);
        }
    }

    // ─── Views ────────────────────────────────────────────────────────

    function proxyAddress(address user) public view returns (address) {
        return
            Clones.predictDeterministicAddressWithImmutableArgs(
                proxyImpl,
                _proxyArgs(user),
                _salt(user),
                address(this)
            );
    }

    function getUserTxLimit(address user, bytes32 currency) public view returns (uint256) {
        uint256 rp = userRP[user];
        if (rp == 0) return baseTxLimit;

        uint256 rate = rpToUsdc[currency];
        if (rate == 0) rate = 1e6;
        uint256 limit = rp * rate;

        uint256 cap = maxTxLimit[currency];
        if (cap > 0 && limit > cap) return cap;
        return limit;
    }

    function getRemainingDailyCount(address user) external view returns (uint256) {
        uint256 dayIndex = block.timestamp / 1 days;
        uint256 count = userDailyCount[user][dayIndex];
        if (count >= dailyTxCountLimit) return 0;
        return dailyTxCountLimit - count;
    }

    function getTodayCount(address user) external view returns (uint256) {
        return userDailyCount[user][block.timestamp / 1 days];
    }

    /// @notice Returns the user's redeemable credit balance — USDC sitting
    ///         on their proxy from a previously skipped fulfillment that
    ///         can be auto-applied to subsequent ticket purchases (either
    ///         partially netting the Diamond delta, or covering the full
    ///         price and skipping the Diamond entirely).
    ///
    ///         UI: call this before quoting an order so the credit-adjusted
    ///         fiat charge can be shown to the user. Returns 0 for users
    ///         whose proxy hasn't been deployed yet (proxy USDC defaults to
    ///         0; the address is still queryable via `proxyAddress`).
    ///
    ///         WARNING: do not apply this figure to multiple in-flight
    ///         orders concurrently. The credit is consumed at fulfillment,
    ///         so a new order placed while a previous credit-applied order
    ///         is still awaiting Diamond completion can race — the second
    ///         order may consume USDC the first one was relying on,
    ///         causing the first to skip at fulfillment. The frontend
    ///         should gate retries on prior orders reaching a terminal
    ///         state (LotPotFulfilled / LotPotBatchFulfilled /
    ///         LotPotFulfillmentSkipped / cancellation).
    function availableCredit(address user) external view returns (uint256) {
        return usdc.balanceOf(proxyAddress(user));
    }

    function getSession(
        uint256 orderId
    )
        external
        view
        returns (
            address user,
            uint256 quantity,
            uint256 usdcAmount,
            bool autoRandom,
            bool fulfilled,
            IMegapot.Ticket[] memory tickets,
            uint8 ballMax_,
            uint8 bonusballMax_,
            uint256 ticketPrice_,
            uint32 placementDay,
            bool cancelled,
            address[] memory referrers,
            uint256[] memory referralSplit
        )
    {
        CheckoutSession storage s = _sessions[orderId];
        return (
            s.user,
            s.quantity,
            s.usdcAmount,
            s.autoRandom,
            s.fulfilled,
            s.tickets,
            s.ballMax,
            s.bonusballMax,
            s.ticketPrice,
            s.placementDay,
            s.cancelled,
            s.referrers,
            s.referralSplit
        );
    }

    // ─── User-Facing Order Placement ──────────────────────────────────

    /**
     * @notice Place a LotPot order with auto-generated ticket numbers.
     *         Numbers are derived deterministically from blockhash + orderId
     *         at fulfillment time. Megapot's VRF decides winners — the user's
     *         number choice doesn't change EV — so weak randomness here is
     *         acceptable.
     */
    function userPlaceOrder(
        uint256 quantity,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit,
        address[] calldata referrers,
        uint256[] calldata referralSplit
    ) external returns (uint256 orderId) {
        if (quantity == 0) revert InvalidQuantity();
        // Type-level safety net: the batch path casts quantity to uint64
        // when calling createBatchOrder, so anything above uint64 max would
        // silently truncate. No business cap — the per-tx USDC limit
        // (validateOrder) is the real ceiling.
        if (quantity > type(uint64).max) revert TooManyTickets();

        IMegapot.DrawingState memory d = _loadCurrentDrawing();
        // Collapse the placement + referral params into one memory pointer
        // before the routing call so the entrypoint stays under the EVM
        // stack-depth limit.
        PlaceReq memory r = PlaceReq(
            currency,
            circleId,
            preferredPaymentChannelConfigId,
            fiatAmountLimit,
            referrers,
            referralSplit
        );
        return _route(quantity, true, r, pubKey, new IMegapot.Ticket[](0), d);
    }

    /// @dev Shared credit-netting + placement routing for both entrypoints.
    ///      credit ≥ total → synchronous credit-only redemption (orderId 0);
    ///      otherwise place a Diamond order for the delta and record the
    ///      session (incl. referral set). `picks` is empty for auto-random.
    function _route(
        uint256 quantity,
        bool autoRandom,
        PlaceReq memory r,
        string calldata pubKey,
        IMegapot.Ticket[] memory picks,
        IMegapot.DrawingState memory d
    ) internal returns (uint256 orderId) {
        uint256 totalPrice = d.ticketPrice * quantity;

        // V2 credit accounting (in addition to V1's skipped-fulfillment USDC
        // already on the proxy):
        //   1. Read issued cashback ledger (`issuedCredit[user]`).
        //   2. If proxy balance alone doesn't cover the price, try to pull
        //      USDC from the grant vault (Megapot-funded) then the fallback
        //      vault (P2P-funded), up to the issued amount. Decrement the
        //      ledger by exactly what was pulled.
        //   3. If proxy + pulled covers the price → synchronous credit
        //      redemption (no Diamond order). Otherwise, place a Diamond
        //      order for the remaining delta (partial fulfillment when
        //      both vaults are dry).
        address proxy = _ensureProxy(msg.sender);
        uint256 proxyBal = usdc.balanceOf(proxy);

        // Checks-effects-interactions: decrement the ledger by the intended
        // pull amount BEFORE calling the vault, then restore any shortfall
        // afterwards if the vault released less than asked. This way a
        // malicious vault that re-enters userPlaceOrder during release()
        // observes the post-decrement balance and cannot double-spend the
        // same credit. The pessimistic over-decrement is safe because:
        //   - if the vault delivers in full, the restore is a no-op
        //   - if the vault partially fails, we only restore the diff
        //   - if a reentrant call drained more credit, the restore lands
        //     on top of the (already-further-decremented) value and
        //     underflow-checks would catch any attempt to over-restore
        uint256 pulled = 0;
        if (proxyBal < totalPrice) {
            uint256 issued = issuedCredit[msg.sender];
            if (issued > 0) {
                uint256 need = totalPrice - proxyBal;
                uint256 toPull = need < issued ? need : issued;

                // Effect first
                issuedCredit[msg.sender] = issued - toPull;

                // Interaction
                pulled = _pullFromVaults(toPull, proxy);

                // Effect after: restore any unpulled amount. Safe under
                // reentrancy — by this point all external calls in the
                // pull path have returned.
                if (pulled < toPull) {
                    issuedCredit[msg.sender] += toPull - pulled;
                }

                if (pulled > 0) {
                    emit CreditConsumed(msg.sender, pulled, issuedCredit[msg.sender]);
                }
            }
        }

        uint256 covered = proxyBal + pulled;
        if (covered >= totalPrice) {
            _redeemFromCredit(msg.sender, proxy, quantity, autoRandom, picks, totalPrice, d);
            return 0;
        }

        uint256 delta = totalPrice - covered;
        orderId = _placeOrder(proxy, delta, r, pubKey);

        _writeSession(
            orderId,
            msg.sender,
            quantity,
            delta,
            d.ticketPrice,
            d.ballMax,
            d.bonusballMax,
            autoRandom,
            r.referrers,
            r.referralSplit
        );

        if (!autoRandom) {
            CheckoutSession storage s = _sessions[orderId];
            for (uint256 i = 0; i < quantity; i++) {
                s.tickets.push(picks[i]);
            }
        }

        emit LotPotOrderCreated(orderId, msg.sender, quantity, autoRandom, totalPrice);
    }

    /**
     * @notice Place a LotPot order with user-supplied ticket numbers.
     *         Each ticket must have exactly NORMALS_PER_TICKET normals, all
     *         in [1, ballMax], unique within the ticket, and sorted ascending.
     *         Bonusball must be in [1, bonusballMax]. Megapot validates again
     *         on fulfillment — invalid input causes the order to revert and
     *         USDC is refunded via the proxy.
     *
     * @dev    Same routing as userPlaceOrder: ≤MAX_DIRECT_TICKETS goes
     *         through Jackpot.buyTickets, >MAX_DIRECT_TICKETS goes through
     *         BatchPurchaseFacilitator with picks passed as
     *         `_userStaticTickets` and `_dynamicTicketCount = 0`. The
     *         per-tx USDC limit (validateOrder) is the de-facto upper bound.
     */
    function userPlaceOrderWithPicks(
        IMegapot.Ticket[] calldata tickets,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit,
        address[] calldata referrers,
        uint256[] calldata referralSplit
    ) external returns (uint256 orderId) {
        uint256 quantity = tickets.length;
        if (quantity == 0) revert InvalidQuantity();
        // Same uint64 safety net as userPlaceOrder — batch path narrows
        // the count to uint64 when constructing the static-tickets array.
        if (quantity > type(uint64).max) revert TooManyTickets();

        IMegapot.DrawingState memory d = _loadCurrentDrawing();
        _validatePicks(tickets, d.ballMax, d.bonusballMax);

        PlaceReq memory r = PlaceReq(
            currency,
            circleId,
            preferredPaymentChannelConfigId,
            fiatAmountLimit,
            referrers,
            referralSplit
        );
        return _route(quantity, false, r, pubKey, tickets, d);
    }

    /// @dev Reads the active drawing's state fresh from Megapot. The
    ///      integrator never caches Megapot's config — `getDrawingState` is
    ///      authoritative for what `buyTickets` will accept and at what price.
    ///      Validates the returns defensively: a zero ticketPrice or a
    ///      sub-NORMALS_PER_TICKET ballMax would otherwise reach
    ///      `_pickUniqueNormals` and either loop forever or revert with a
    ///      less-actionable error.
    function _loadCurrentDrawing() internal view returns (IMegapot.DrawingState memory d) {
        IMegapot _mp = IMegapot(megapot);
        d = _mp.getDrawingState(_mp.currentDrawingId());
        if (d.ticketPrice == 0) revert InvalidTicketPrice();
        if (d.ballMax < NORMALS_PER_TICKET || d.bonusballMax == 0) revert InvalidBallRange();
    }

    /// @dev Centralised session writer: freezes Megapot's placement-time
    ///      config and lifecycle metadata into the session, shared by both
    ///      placement entry points.
    ///
    ///      `diamondAmount` is the amount the Diamond is processing (=
    ///      total purchase price minus any credit netted from the proxy).
    ///      The integrator's `onOrderComplete` validates the Diamond's
    ///      passed `amount` against this stored value via `AmountMismatch`.
    ///      The full purchase total is recoverable at fulfillment time as
    ///      `quantity * ticketPrice` — fulfillment uses that, not the
    ///      Diamond delta, when approving Megapot.
    function _writeSession(
        uint256 orderId,
        address user,
        uint256 quantity,
        uint256 diamondAmount,
        uint256 _ticketPrice,
        uint8 _ballMax,
        uint8 _bonusballMax,
        bool autoRandom,
        address[] memory referrers,
        uint256[] memory referralSplit
    ) internal {
        CheckoutSession storage s = _sessions[orderId];
        s.user = user;
        s.quantity = quantity;
        s.usdcAmount = diamondAmount;
        s.ticketPrice = _ticketPrice;
        s.ballMax = _ballMax;
        s.bonusballMax = _bonusballMax;
        s.autoRandom = autoRandom;
        s.placementDay = uint32(block.timestamp / 1 days);
        delete s.referrers;
        delete s.referralSplit;
        for (uint256 i = 0; i < referrers.length; i++) {
            s.referrers.push(referrers[i]);
        }
        for (uint256 i = 0; i < referralSplit.length; i++) {
            s.referralSplit.push(referralSplit[i]);
        }
    }

    /// @dev Synchronous credit-only redemption path: no Diamond order,
    ///      proxy USDC pays Megapot directly. Reverts on Megapot/
    ///      facilitator revert (user is the caller; they get clear
    ///      feedback and can retry).
    ///
    ///      For `quantity <= MAX_DIRECT_TICKETS`, calls `buyTickets`
    ///      via `proxy.execute` so the proxy supplies USDC. For larger
    ///      quantities, routes through `BatchPurchaseFacilitator` like
    ///      the Diamond-mediated batch path.
    function _redeemFromCredit(
        address user,
        address proxy,
        uint256 quantity,
        bool autoRandom,
        IMegapot.Ticket[] memory userPicks,
        uint256 totalPrice,
        IMegapot.DrawingState memory d
    ) internal {
        IMegapot.Ticket[] memory tickets;
        if (autoRandom) {
            // Synthetic seed for ticket generation since there's no
            // Diamond orderId. The counter advance prevents collisions
            // between repeated credit redemptions in the same block.
            unchecked {
                _creditRedemptionCounter += 1;
            }
            uint256 entropy = uint256(
                keccak256(abi.encode(blockhash(block.number - 1), user, _creditRedemptionCounter))
            );
            tickets = _generateRandomTickets(quantity, entropy, d.ballMax, d.bonusballMax);
        } else {
            tickets = userPicks;
        }

        // Credit-funded tickets carry the most-recently-skipped order's
        // referral attribution (not the new placement's args). Resolved
        // through the same sanitizer, then the snapshot is cleared.
        StoredReferral storage cr = _creditReferral[user];
        (address[] memory rRefs, uint256[] memory rSplit) = _resolveReferrers(
            cr.referrers,
            cr.split,
            user,
            proxy
        );
        delete _creditReferral[user];

        if (quantity <= MAX_DIRECT_TICKETS) {
            bytes memory data = abi.encodeCall(
                IMegapot.buyTickets,
                (tickets, user, rRefs, rSplit, source)
            );
            bytes memory result = UserProxy(proxy).execute(
                megapot,
                data,
                address(usdc),
                totalPrice
            );
            uint256[] memory ticketIds = abi.decode(result, (uint256[]));
            if (ticketIds.length != quantity) revert MegapotReturnMismatch();
        } else {
            UserProxy(proxy).transferERC20ToIntegrator(address(usdc), totalPrice);
            usdc.forceApprove(batchFacilitator, totalPrice);
            IBatchPurchaseFacilitator(batchFacilitator).createBatchOrder(
                user,
                autoRandom ? uint64(quantity) : 0,
                autoRandom ? new IMegapot.Ticket[](0) : tickets,
                rRefs,
                rSplit
            );
            usdc.forceApprove(batchFacilitator, 0);
        }

        emit LotPotCreditRedeemed(user, 0, quantity, totalPrice);
    }

    function _placeOrder(
        address proxy,
        uint256 totalPrice,
        PlaceReq memory r,
        string calldata pubKey
    ) internal returns (uint256) {
        // Proxy is the actor on the Diamond. The integrator validates business rules
        // and orchestrates; the proxy is the msg.sender that calls placeB2BOrder.
        // The gateway resolves msg.sender → integrator by reading proxy.integrator()
        // and re-deriving the CREATE2 clone address against the integrator's pinned
        // proxyImpl — no runtime trust on this contract.
        // recipientAddr = proxy so completion routes USDC straight to the proxy
        // (no integrator hop). This requires the integrator to be registered with
        // usdcThroughIntegrator = false.
        // Caller is responsible for having already ensured the proxy exists.
        bytes memory data = abi.encodeCall(
            IB2BGateway.placeB2BOrder,
            (
                msg.sender,
                totalPrice,
                r.currency,
                proxy,
                pubKey,
                r.circleId,
                r.preferredPaymentChannelConfigId,
                r.fiatAmountLimit
            )
        );
        bytes memory result = UserProxy(proxy).execute(diamond, data, address(usdc), 0);
        return abi.decode(result, (uint256));
    }

    // ─── IP2PIntegrator Callbacks ─────────────────────────────────────

    function validateOrder(
        address user,
        uint256 amount,
        bytes32 currency
    ) external onlyDiamond returns (bool allowed) {
        uint256 txLimit = getUserTxLimit(user, currency);
        if (amount > txLimit) return false;

        uint256 dayIndex = block.timestamp / 1 days;
        uint256 count = userDailyCount[user][dayIndex];
        if (count + 1 > dailyTxCountLimit) return false;

        userDailyCount[user][dayIndex] = count + 1;
        return true;
    }

    function onOrderComplete(
        uint256 orderId,
        address /* user */,
        uint256 amount,
        address /* recipientAddr */
    ) external onlyDiamond {
        CheckoutSession storage session = _sessions[orderId];
        // Defense-in-depth — these should never fire under correct gateway
        // bookkeeping, but make divergence explicit instead of silently
        // operating on a zero-init session or a mismatched amount.
        if (session.user == address(0)) revert UnknownOrder();
        if (session.cancelled) revert OrderAlreadyCancelled();
        if (session.fulfilled) revert OrderAlreadyFulfilled();
        if (amount != session.usdcAmount) revert AmountMismatch();
        session.fulfilled = true;

        // USDC was sent directly to the proxy by the Diamond on completion
        // (recipientAddr = proxy, usdcThroughIntegrator = false). The integrator
        // never touches USDC unless we're routing through BatchPurchaseFacilitator
        // (see _fulfillBatch).
        address proxy = _ensureProxy(session.user);

        if (session.quantity <= MAX_DIRECT_TICKETS) {
            _fulfillDirect(orderId, session, proxy);
        } else {
            _fulfillBatch(orderId, session, proxy);
        }
    }

    /// @dev ≤10-ticket path: proxy approves Megapot and calls buyTickets with
    ///      `_recipient = session.user`, so NFTs land directly on the user
    ///      EOA — no intermediate sweep needed. We still decode and verify
    ///      the returned ticketIds length to surface a Megapot bug/upgrade
    ///      that would otherwise silently leave the user under-credited.
    ///
    ///      Handles drawing rollover between placement and fulfillment by
    ///      re-reading the active drawing's state and refunding inline if
    ///      the order can no longer be fulfilled at the user's commitment:
    ///      - ticketPrice rose above the committed amount
    ///      - user picks fall outside the active drawing's ranges
    ///
    ///      For auto-random orders we regenerate against the active drawing's
    ///      ranges (not the placement snapshot's) so the picks are guaranteed
    ///      to pass Megapot's validation.
    function _fulfillDirect(
        uint256 orderId,
        CheckoutSession storage session,
        address proxy
    ) internal {
        IMegapot.DrawingState memory d = _loadCurrentDrawing();

        // Full purchase amount the user committed to at placement = quantity
        // × snapshotted ticketPrice. Equals (Diamond delta = session.usdcAmount)
        // + (credit on proxy at placement). The proxy now holds the full
        // amount: Diamond routed the delta on completion; credit was already
        // there.
        uint256 expectedTotal = session.quantity * session.ticketPrice;

        // Pre-empt the only ticketPrice scenario that would make Megapot
        // revert: a higher live price the user didn't commit to. (Lower
        // live price is fine — Megapot pulls less and proxy.execute
        // auto-sweeps the remainder back to the user.)
        if (d.ticketPrice * session.quantity > expectedTotal) {
            _skipFulfillment(orderId, session, proxy, SkipReason.PriceExceedsCommitment);
            return;
        }

        IMegapot.Ticket[] memory tickets;
        if (session.autoRandom) {
            // Use the *active* drawing's ranges, not the placement snapshot.
            // Random picks are random — drawing them from the current valid
            // range gives equivalent fairness and guarantees Megapot accepts
            // them.
            tickets = _generateRandomTickets(session.quantity, orderId, d.ballMax, d.bonusballMax);
        } else {
            tickets = _copyStoredTickets(session);
            if (!_picksAreValid(tickets, d.ballMax, d.bonusballMax)) {
                _skipFulfillment(orderId, session, proxy, SkipReason.PicksOutOfRange);
                return;
            }
        }

        (address[] memory rRefs, uint256[] memory rSplit) = _resolveReferrers(
            session.referrers,
            session.referralSplit,
            session.user,
            proxy
        );
        bytes memory data = abi.encodeCall(
            IMegapot.buyTickets,
            (
                tickets,
                session.user, // mint straight to user EOA
                rRefs,
                rSplit,
                source
            )
        );

        // Wrap the upstream call so a Megapot revert (paused, mid-flight
        // upgrade, etc.) converts into a skip event rather than bubbling
        // to the Diamond as an opaque callback-failed. USDC stays on the
        // proxy (the inner approval + transferFrom inside execute() roll
        // back together when the call reverts) so the user can recover
        // via the credit-redemption path on a subsequent order.
        bytes memory result;
        bool execOk;
        try UserProxy(proxy).execute(megapot, data, address(usdc), expectedTotal) returns (
            bytes memory r
        ) {
            result = r;
            execOk = true;
        } catch {
            /* execOk stays false */
        }

        if (!execOk) {
            _snapshotCreditReferral(session.user, session);
            emit LotPotFulfillmentSkipped(
                orderId,
                session.user,
                proxy,
                expectedTotal,
                SkipReason.UpstreamReverted
            );
            return;
        }

        uint256[] memory ticketIds = abi.decode(result, (uint256[]));
        // Megapot's documented invariant is one ID per ticket. A buggy /
        // upgraded Megapot returning a mismatched count means buyTickets
        // succeeded but credited the user wrong — revert (past the try
        // above) so the outer Diamond catches it and the buyTickets state
        // is fully rolled back. We don't convert this to a skip because
        // we don't want partial-mint state to persist.
        if (ticketIds.length != session.quantity) revert MegapotReturnMismatch();

        emit LotPotFulfilled(orderId, session.user, proxy, session.quantity);

        // If credit was netted at placement (delta < total), surface it as
        // a LotPotCreditRedeemed event tied to this orderId so off-chain
        // consumers can reconcile balances.
        if (session.usdcAmount < expectedTotal) {
            emit LotPotCreditRedeemed(
                session.user,
                orderId,
                session.quantity,
                expectedTotal - session.usdcAmount
            );
        }
    }

    /// @dev Skip fulfillment without pushing USDC anywhere — emit the
    ///      `LotPotFulfillmentSkipped` event so off-chain consumers know
    ///      the order didn't proceed, leaving the USDC on the user's proxy
    ///      as redeemable credit. The session is already marked
    ///      `fulfilled` by `onOrderComplete` so the Diamond's settlement
    ///      path closes.
    ///
    ///      The `amount` field reports the full purchase total (= quantity
    ///      × placement-time ticketPrice), which equals what's actually
    ///      sitting on the proxy — not the Diamond delta. For credit-
    ///      applied orders these can differ (delta < total) and the event
    ///      consumer needs the total to reconcile stranded balance.
    function _skipFulfillment(
        uint256 orderId,
        CheckoutSession storage session,
        address proxy,
        SkipReason reason
    ) internal {
        uint256 expectedTotal = session.quantity * session.ticketPrice;
        _snapshotCreditReferral(session.user, session);
        emit LotPotFulfillmentSkipped(orderId, session.user, proxy, expectedTotal, reason);
    }

    /// @dev >10-ticket path: pull USDC from proxy back into the integrator
    ///      (the integrator must be the on-chain caller because
    ///      BatchPurchaseFacilitator gates createBatchOrder on its
    ///      `isAllowed(msg.sender)` allowlist), approve the facilitator,
    ///      register the batch order with `_recipient = session.user` so
    ///      tickets are minted directly to the user EOA when Megapot's
    ///      keeper later executes the batch. No follow-up integrator call
    ///      is required to deliver the NFTs.
    ///
    ///      Auto-random orders pass `_dynamicTicketCount = quantity` with
    ///      no static tickets; user-picked orders pass `_dynamicTicketCount
    ///      = 0` with the user's picks as `_userStaticTickets` (the live
    ///      facilitator imposes no on-chain cap on the static-ticket
    ///      array, only on the total count vs `minimumTicketCount`).
    function _fulfillBatch(
        uint256 orderId,
        CheckoutSession storage session,
        address proxy
    ) internal {
        IMegapot.DrawingState memory d = _loadCurrentDrawing();

        // Full purchase amount that the proxy now holds (delta + credit).
        uint256 expectedTotal = session.quantity * session.ticketPrice;

        // Best-effort price check: if the active drawing's price already
        // exceeds the user's commitment, skip up front. A rollover *during*
        // the keeper's later execution can still leave the facilitator with
        // insufficient funds — that's out of our control once we've handed
        // off, but flagging the pre-handoff case avoids losing the USDC
        // into the facilitator.
        if (d.ticketPrice * session.quantity > expectedTotal) {
            _skipFulfillment(orderId, session, proxy, SkipReason.PriceExceedsCommitment);
            return;
        }

        // Pull the full USDC amount (delta + credit) from the proxy into
        // this contract. proxy.execute can't target the integrator
        // (TargetNotAllowed), so this dedicated escape hatch is the only
        // way to surface the proxy's USDC for an integrator-initiated
        // external call.
        UserProxy(proxy).transferERC20ToIntegrator(address(usdc), expectedTotal);

        // forceApprove handles both fresh and dirty allowance slots — the
        // facilitator should pull exactly `expectedTotal` and leave 0
        // behind, but we explicitly reset to 0 below as belt-and-suspenders.
        usdc.forceApprove(batchFacilitator, expectedTotal);

        // Hoist the dynamic/static args out of the try expression so the
        // call site stays a single statement.
        uint64 dynamicQty;
        IMegapot.Ticket[] memory staticTickets;
        if (session.autoRandom) {
            dynamicQty = uint64(session.quantity);
            staticTickets = new IMegapot.Ticket[](0);
        } else {
            dynamicQty = 0;
            staticTickets = _copyStoredTickets(session);
        }

        // Wrap the facilitator call. Reverts here typically mean the
        // integrator has been removed from the allowlist, there's an
        // active batch order, or the facilitator is paused. Convert to a
        // skip event and return USDC to the proxy so the user can redeem
        // it through a subsequent credit-aware order.
        (address[] memory rRefs, uint256[] memory rSplit) = _resolveReferrers(
            session.referrers,
            session.referralSplit,
            session.user,
            proxy
        );
        try
            IBatchPurchaseFacilitator(batchFacilitator).createBatchOrder(
                session.user, // mint straight to user EOA
                dynamicQty,
                staticTickets,
                rRefs,
                rSplit
            )
        {
            usdc.forceApprove(batchFacilitator, 0);
            if (session.autoRandom) {
                emit LotPotBatchFulfilled(orderId, session.user, proxy, session.quantity, 0);
            } else {
                emit LotPotBatchFulfilled(orderId, session.user, proxy, 0, session.quantity);
            }
            if (session.usdcAmount < expectedTotal) {
                emit LotPotCreditRedeemed(
                    session.user,
                    orderId,
                    session.quantity,
                    expectedTotal - session.usdcAmount
                );
            }
        } catch {
            // Reset the dangling allowance and return the USDC we pulled
            // to the proxy so the user's credit balance is intact for
            // future redemption attempts.
            usdc.forceApprove(batchFacilitator, 0);
            usdc.safeTransfer(proxy, expectedTotal);
            _snapshotCreditReferral(session.user, session);
            emit LotPotFulfillmentSkipped(
                orderId,
                session.user,
                proxy,
                expectedTotal,
                SkipReason.UpstreamReverted
            );
        }
    }

    /**
     * @notice Cancellation hook. Called by the gateway from
     *         B2BGatewayFacet.onB2BOrderCancelled when a B2B BUY order is
     *         cancelled (manual / expiry / dispute / PAY-failure).
     *
     *         Releases the userDailyCount slot that validateOrder consumed
     *         at placement, keyed on the placement-day snapshot so the
     *         decrement lands in the correct bucket even if cancellation
     *         crosses a UTC day boundary.
     *
     *         Best-effort from the gateway's POV: if this reverts the gateway
     *         emits its callback-failed event and protocol state still
     *         finalises. Idempotency is enforced via session.cancelled —
     *         a duplicate call surfaces OrderAlreadyCancelled rather than
     *         double-decrementing.
     */
    function onOrderCancel(uint256 orderId) external onlyDiamond {
        CheckoutSession storage session = _sessions[orderId];
        if (session.user == address(0)) revert UnknownOrder();
        if (session.fulfilled) revert OrderAlreadyFulfilled();
        if (session.cancelled) revert OrderAlreadyCancelled();
        session.cancelled = true;

        uint256 day = uint256(session.placementDay);
        uint256 count = userDailyCount[session.user][day];
        if (count > 0) {
            userDailyCount[session.user][day] = count - 1;
        }

        emit LotPotOrderCancelled(orderId, session.user);
    }

    // ─── Ticket generation / validation ───────────────────────────────

    function _generateRandomTickets(
        uint256 quantity,
        uint256 orderId,
        uint8 _ballMax,
        uint8 _bonusballMax
    ) internal view returns (IMegapot.Ticket[] memory tickets) {
        tickets = new IMegapot.Ticket[](quantity);

        for (uint256 i = 0; i < quantity; i++) {
            bytes32 baseSeed = keccak256(abi.encode(blockhash(block.number - 1), orderId, i));
            tickets[i] = IMegapot.Ticket({
                normals: _pickUniqueNormals(baseSeed, _ballMax),
                bonusball: uint8(
                    (uint256(keccak256(abi.encode(baseSeed, "bb"))) % _bonusballMax) + 1
                )
            });
        }
    }

    function _pickUniqueNormals(
        bytes32 seed,
        uint8 _ballMax
    ) internal pure returns (uint8[] memory normals) {
        normals = new uint8[](NORMALS_PER_TICKET);
        // ballMax fits in uint8 → max 255. Use a fixed-size flag array sized
        // to 256 slots; values 1.._ballMax are the only ones we touch.
        bool[256] memory picked;
        uint256 count = 0;
        uint256 nonce = 0;

        while (count < NORMALS_PER_TICKET) {
            uint256 candidate = (uint256(keccak256(abi.encode(seed, nonce))) % _ballMax) + 1;
            if (!picked[candidate]) {
                picked[candidate] = true;
                normals[count] = uint8(candidate);
                unchecked {
                    count++;
                }
            }
            unchecked {
                nonce++;
            }
        }

        // Megapot requires normals sorted ascending. Selection sort on 5 items.
        for (uint256 a = 0; a < NORMALS_PER_TICKET; a++) {
            for (uint256 b = a + 1; b < NORMALS_PER_TICKET; b++) {
                if (normals[a] > normals[b]) {
                    (normals[a], normals[b]) = (normals[b], normals[a]);
                }
            }
        }
    }

    function _validatePicks(
        IMegapot.Ticket[] calldata tickets,
        uint8 _ballMax,
        uint8 _bonusballMax
    ) internal pure {
        for (uint256 i = 0; i < tickets.length; i++) {
            uint8[] calldata normals = tickets[i].normals;
            if (normals.length != NORMALS_PER_TICKET) revert InvalidTicketNumbers();
            uint8 prev = 0;
            for (uint256 j = 0; j < NORMALS_PER_TICKET; j++) {
                uint8 n = normals[j];
                if (n == 0 || n > _ballMax) revert InvalidTicketNumbers();
                if (n <= prev) revert InvalidTicketNumbers(); // sorted + unique
                prev = n;
            }
            uint8 bb = tickets[i].bonusball;
            if (bb == 0 || bb > _bonusballMax) revert InvalidTicketNumbers();
        }
    }

    error InvalidTicketNumbers();

    /// @dev Memory-array, non-reverting equivalent of `_validatePicks` used at
    ///      fulfillment to decide whether placement-time picks still fit the
    ///      active drawing's ranges. Returns `false` so the caller can route
    ///      to the refund branch instead of bubbling a revert that would
    ///      leave USDC stranded on the proxy.
    function _picksAreValid(
        IMegapot.Ticket[] memory tickets,
        uint8 _ballMax,
        uint8 _bonusballMax
    ) internal pure returns (bool) {
        for (uint256 i = 0; i < tickets.length; i++) {
            uint8[] memory normals = tickets[i].normals;
            if (normals.length != NORMALS_PER_TICKET) return false;
            uint8 prev = 0;
            for (uint256 j = 0; j < NORMALS_PER_TICKET; j++) {
                uint8 n = normals[j];
                if (n == 0 || n > _ballMax) return false;
                if (n <= prev) return false;
                prev = n;
            }
            uint8 bb = tickets[i].bonusball;
            if (bb == 0 || bb > _bonusballMax) return false;
        }
        return true;
    }

    function _copyStoredTickets(
        CheckoutSession storage session
    ) internal view returns (IMegapot.Ticket[] memory tickets) {
        uint256 n = session.tickets.length;
        tickets = new IMegapot.Ticket[](n);
        for (uint256 i = 0; i < n; i++) {
            tickets[i] = session.tickets[i];
        }
    }

    // ─── Referral resolution ──────────────────────────────────────────

    function _sum(uint256[] memory a) internal pure returns (uint256 s) {
        for (uint256 i = 0; i < a.length; i++) {
            s += a[i];
        }
    }

    /// @dev Sanitizes a UI-supplied referrer set. Any problem — empty,
    ///      length mismatch, over MAX_REFERRERS, split not totalling
    ///      REFERRAL_SPLIT_FULL, a zero address, or a referrer equal to the
    ///      recipient EOA or the proxy (msg.sender to Megapot) — collapses
    ///      the whole set to [defaultReferrer],[1e18]. Never reverts, so
    ///      fulfillment can never strand credit on bad referral input.
    function _resolveReferrers(
        address[] memory referrers,
        uint256[] memory split,
        address recipient,
        address proxy
    ) internal view returns (address[] memory outRefs, uint256[] memory outSplit) {
        bool valid = referrers.length > 0 &&
            referrers.length == split.length &&
            referrers.length <= MAX_REFERRERS &&
            _sum(split) == REFERRAL_SPLIT_FULL;
        if (valid) {
            for (uint256 i = 0; i < referrers.length; i++) {
                address r = referrers[i];
                if (r == address(0) || r == recipient || r == proxy) {
                    valid = false;
                    break;
                }
            }
        }
        if (!valid) {
            outRefs = new address[](1);
            outRefs[0] = defaultReferrer;
            outSplit = new uint256[](1);
            outSplit[0] = REFERRAL_SPLIT_FULL;
        } else {
            outRefs = referrers;
            outSplit = split;
        }
    }

    /// @dev Snapshots a skipped order's referral set per user so the
    ///      credit-only redemption path can reuse it (most-recent-skip-wins).
    function _snapshotCreditReferral(address user, CheckoutSession storage s) internal {
        StoredReferral storage cr = _creditReferral[user];
        delete cr.referrers;
        delete cr.split;
        for (uint256 i = 0; i < s.referrers.length; i++) {
            cr.referrers.push(s.referrers[i]);
        }
        for (uint256 i = 0; i < s.referralSplit.length; i++) {
            cr.split.push(s.referralSplit[i]);
        }
    }

    // ─── V2 Vault helpers ─────────────────────────────────────────────

    /// @dev Pulls up to `needed` USDC from the configured vaults into
    ///      `to`, preferring the grant vault and falling back to the
    ///      fallback vault. Each vault call is wrapped in try/catch so
    ///      a misconfigured vault (paused, spender revoked, etc.)
    ///      degrades gracefully — the caller treats the (possibly
    ///      partial) `pulled` amount as authoritative. Reads only the
    ///      vault's actual USDC balance to size each pull, so we never
    ///      attempt to release more than the vault holds.
    function _pullFromVaults(uint256 needed, address to) internal returns (uint256 pulled) {
        address gv = grantVault;
        if (gv != address(0)) {
            uint256 grantBal = usdc.balanceOf(gv);
            uint256 fromGrant = needed < grantBal ? needed : grantBal;
            if (fromGrant > 0) {
                try GrantVault(gv).release(to, fromGrant) {
                    pulled += fromGrant;
                    needed -= fromGrant;
                } catch {
                    // Grant vault failed (e.g., spender revoked). Fall
                    // through to fallback without unwinding.
                }
            }
        }
        address fv = fallbackVault;
        if (needed > 0 && fv != address(0)) {
            uint256 fallbackBal = usdc.balanceOf(fv);
            uint256 fromFallback = needed < fallbackBal ? needed : fallbackBal;
            if (fromFallback > 0) {
                try GrantVault(fv).release(to, fromFallback) {
                    pulled += fromFallback;
                } catch {
                    // Fallback also failed → partial fulfillment by
                    // the caller (delta path).
                }
            }
        }
    }

    // ─── Proxy helpers ────────────────────────────────────────────────

    function _salt(address user) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(user)));
    }

    function _proxyArgs(address user) internal view returns (bytes memory) {
        // Layout: [owner(20)][integrator(20)] — matches the real Diamond's
        // B2BGatewayFacet._predictCloneAddress, which hardcodes this
        // 40-byte layout when verifying CREATE2 of incoming proxy callers.
        // We can't append USDC as a third immutable arg without breaking
        // that verification; LotPotUserProxy queries `integrator.usdc()`
        // at sweep time instead.
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
