// SPDX-License-Identifier: Apache-2.0
// `transient` storage (EIP-1153) needs 0.8.28+, not 0.8.20.
pragma solidity ^0.8.28;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

/**
 * @notice ReputationManager's USER blacklist.
 *
 *         NOT the Diamond's `isBlacklisted(address)`. That one reads
 *         `MerchantRegistryStorage.layout().blacklistedMerchants[_merchant]`
 *         (contracts-v4 GetterFacet.sol:243), so a blacklisted user who is not
 *         a registered merchant is simply absent from that mapping and the view
 *         returns FALSE. Using it as a user gate fails OPEN and passes
 *         everyone - it is the obvious call and the wrong one.
 *
 *         The user flag lives in `mapping(address => RmUser) public rmusers`
 *         (contracts-v4 RpStorage.sol:84), so Solidity's generated getter is
 *         the whole interface we need. The member ORDER of RmUser is the ABI:
 *         `{ uint256 reputationPoints; uint256 voteCount; bool isBlacklisted; }`
 *         A new member inserted ahead of the flag would silently shift it,
 *         which is why a test asserts the decode against the real contract.
 */
interface IRmUserBlacklist {
    function rmusers(address user) external view returns (uint256, uint256, bool);
}

/**
 * @title HypeHouseRampIntegrator
 * @notice hype.house's fiat on-ramp into the P2P protocol.
 *
 *         PINNED RECIPIENT. `userPlaceOrder` takes no `recipientAddr` and
 *         `onOrderComplete` IGNORES the one the Diamond passes: the payout
 *         address is read from `rampRecipientOf[user]`, written once by a
 *         server worker at ramp-wallet provisioning. A tampered or scripted
 *         client therefore cannot redirect an on-ramp anywhere - the only
 *         place funds can land is the user's own policy-locked ramp wallet,
 *         which is the taint sink the whole design rests on.
 *
 *         WHAT IS DELIBERATELY NOT HERE: tranche accounting, cooldowns, the
 *         fiat-in/crypto-out rule. This contract cannot see balances spread
 *         across Solana, Arbitrum and Hyperliquid, so chain-side limits stay
 *         coarse and the real rule is enforced in the app before a transaction
 *         is ever built. Putting a half-informed version of it here would be
 *         worse than having none: it would read as the control and not be one.
 *
 *         Register with `registerIntegrator(integrator, FALSE, proxyImpl)`.
 *         The bool is `usdcThroughIntegrator`, and false is what makes this
 *         contract never custody a user's money:
 *
 *           true  -> l.usdt.safeTransfer(integrator, amount)
 *           false -> l.usdt.safeTransfer(_order.recipientAddr, amount)
 *                                                (B2BGatewayFacet.sol:264-268)
 *
 *         We place the order with `recipientAddr = rampRecipientOf[user]`, so
 *         the false branch pays the ramp wallet DIRECTLY from the Diamond: one
 *         transfer, no intermediate balance, and no way for a settlement to
 *         strand here. The client still cannot influence it, because that
 *         address is read from this contract's storage and not from any
 *         argument.
 *
 *         Registering with true instead would route every settlement through
 *         this contract, and since the callback that forwards it is
 *         best-effort and try/catch'd, a single failure there would leave user
 *         funds sitting on the integrator. The callback fires in BOTH branches
 *         (it is outside that if/else), so nothing is lost by taking the
 *         branch that never touches the money.
 */
contract HypeHouseRampIntegrator is IP2PIntegrator {
    using SafeERC20 for IERC20;

    // ─── Errors ───────────────────────────────────────────────────────
    error OnlyDiamond();
    error OnlyOwner();
    error InvalidAddress();
    error NotRegistered(address user);
    error UserBlacklisted(address user);
    error OverPerTxCap(uint256 amount, uint256 cap);
    error OverDailyCap(uint256 amount, uint256 cap);
    error TooManyInFlight(address user, uint256 inFlight, uint256 cap);
    error Reentrancy();
    error OnlyRegistrar();
    error AlreadyPinned(address user);
    error CapExceedsCeiling(uint256 given, uint256 ceiling);
    error RoutesThroughIntegrator();
    error ConfigUnreadable();
    error NotPending();

    // ─── Events ───────────────────────────────────────────────────────
    event RampRecipientSet(address indexed user, address indexed recipient);
    event OrderPlaced(uint256 indexed orderId, address indexed user, uint256 amount);
    /// @notice The ONLY thing that opens a tranche in the app. Watched by the
    ///         indexer; never reported by a client callback, because a scripted
    ///         order does not call our API at all.
    event RampSettled(
        uint256 indexed orderId,
        address indexed user,
        uint256 amount,
        address recipient
    );
    event OrderCancelled(uint256 indexed orderId, address indexed user);
    event UserProxyDeployed(address indexed user, address proxy);
    event CapsUpdated(uint256 perTx, uint256 perDay, uint256 inFlight);
    /// @notice A pin was REPLACED, not created. Separate from RampRecipientSet so
    ///         an alert can page on this alone - it is the one action that
    ///         redirects a user's future on-ramps.
    event RampRecipientReset(address indexed user, address indexed from, address indexed to);
    event RegistrarChanged(address indexed from, address indexed to);
    event OwnerTransferStarted(address indexed from, address indexed to);
    event OwnerTransferred(address indexed from, address indexed to);
    event InFlightReset(address indexed user, uint256 from);
    event OrderReconciled(uint256 indexed orderId, address indexed user, uint8 status);
    event UsdcSwept(address indexed to, uint256 amount);

    // ─── Immutables ───────────────────────────────────────────────────
    address public immutable diamond;
    IERC20 public immutable usdc;

    /// @notice COLD key: caps, the registrar, re-pins, sweeps, ownership.
    ///         Mutable and two-step transferable - an immutable owner on a
    ///         contract that pins payout addresses is an un-rotatable hot key.
    address public owner;
    address public pendingOwner;
    /// @notice HOT key, called on every signup. May pin an UNSET user and nothing
    ///         else: if it leaks, the holder cannot redirect an existing user's
    ///         on-ramps and cannot lift the caps to make it worth doing.
    address public registrar;
    address public immutable proxyImpl;
    /// @notice ReputationManager, for the USER blacklist. Zero disables the
    ///         check - allowed only so tests and a pre-deploy environment can
    ///         run, never in production.
    IRmUserBlacklist public immutable reputationManager;

    // ─── Ceilings (immutable) ─────────────────────────────────────────
    // A whitelisted integrator bypasses the protocol's own RP, daily, monthly and
    // yearly limits, so an owner-raisable cap is a PROTOCOL lever rather than
    // partner config. Audit F1 on Investabl (#40) and Showdown (#35); Own,
    // Showdown and Investabl all carry MAX_* constants. The #77 conformance
    // ratchet missed this one because its regex matches set*(Limit|Cap|Bps)( and
    // this setter is plural.
    uint256 public constant MAX_PER_TX_USDC = 2_000e6;
    uint256 public constant MAX_PER_DAY_USDC = 10_000e6;
    uint256 public constant MAX_IN_FLIGHT = 10;

    // ─── Caps (owner-settable, under the ceilings) ────────────────────
    uint256 public perTxCapUsdc = 500e6;
    uint256 public perDayCapUsdc = 2000e6;
    /// @notice Orders placed and not yet settled or cancelled. The fraud
    ///         engine's own in-flight limit is off-chain and skippable; this
    ///         one is not.
    uint256 public inFlightCap = 3;

    // ─── State ────────────────────────────────────────────────────────
    mapping(address => address) public rampRecipientOf;
    mapping(address => uint256) public inFlightOf;
    /// @notice Cancels tighten the in-flight cap. The engine's
    ///         `rapid_cancellations_b2b` restriction is per-wallet and expires
    ///         in four hours, and the 2026-09-08 case shows the seed wallet
    ///         simply resumed after each one. This counter does not expire.
    mapping(address => uint256) public cancelCountOf;
    /// @dev user => day index => USDC placed that day.
    mapping(address => mapping(uint256 => uint256)) public dailySpentOf;
    /// @dev orderId => user, so cancel and complete can find their own row
    ///      without trusting an argument.
    mapping(uint256 => address) public orderUserOf;
    mapping(uint256 => uint256) public orderAmountOf;
    mapping(uint256 => uint256) public orderDayOf;

    /// @dev Transient (EIP-1153), so it costs nothing to clear at end-of-tx.
    ///      Guards the value-moving entrypoints, per the repo's #77 conformance
    ///      invariant. NOT on validateOrder - the Diamond calls that back from
    ///      inside userPlaceOrder, so a guard there would make every placement
    ///      revert on itself.
    bool private transient _entered;

    modifier nonReentrant() {
        if (_entered) revert Reentrancy();
        _entered = true;
        _;
        _entered = false;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    /// @dev The owner is also a registrar, so a fresh deploy can provision before
    ///      a separate hot key exists.
    modifier onlyRegistrar() {
        if (msg.sender != registrar && msg.sender != owner) revert OnlyRegistrar();
        _;
    }

    constructor(address _diamond, address _usdc, address _reputationManager) {
        if (_diamond == address(0) || _usdc == address(0)) revert InvalidAddress();
        diamond = _diamond;
        usdc = IERC20(_usdc);
        owner = msg.sender;
        registrar = msg.sender;
        reputationManager = IRmUserBlacklist(_reputationManager);
        proxyImpl = address(new UserProxy());
        // The defaults must themselves be legal, or the ceilings are decoration.
        assert(perTxCapUsdc <= MAX_PER_TX_USDC);
        assert(perDayCapUsdc <= MAX_PER_DAY_USDC);
        assert(inFlightCap <= MAX_IN_FLIGHT);
    }

    // ─── Admin ────────────────────────────────────────────────────────

    /// @notice Pin where this user's on-ramps may land. Written once at
    ///         provisioning, BEFORE the wallet is advertised as usable: a
    ///         wallet that exists unpinned simply cannot receive an on-ramp,
    ///         while a pin to an address that does not exist would strand funds.
    function setRampRecipient(address user, address recipient) external onlyRegistrar {
        if (user == address(0) || recipient == address(0)) revert InvalidAddress();
        // PIN ONCE. A registrar that can overwrite is a registrar that can
        // redirect every future on-ramp of an existing user to an address it
        // chooses - the user still pays the fiat. Re-pinning is a cold-key action
        // with its own event, so an alert can page on it alone.
        if (rampRecipientOf[user] != address(0)) revert AlreadyPinned(user);
        // A SELF-PIN IS ALLOWED, and that is a deliberate reversal.
        //
        // This used to `revert RecipientIsUser(user)` when recipient == user, on
        // the reasoning that on-ramped USDC must land somewhere whose spending
        // policy the app controls and a user-controlled destination collapses the
        // custody model. The invariant is right; `recipient != user` was a proxy
        // for it that INVERTS in the integration this contract was written for.
        //
        // hype.house signs `userPlaceOrder` from the user's policy-locked ramp
        // wallet, so `msg.sender` - and therefore `user` here - already IS the
        // app-controlled wallet, and is also the correct recipient. The old check
        // made the only configuration this integrator has unpinnable: proven by
        // setRampRecipient(w, w) reverting, which is what the app needs to call.
        //
        // What actually enforces the invariant is that pinning is REGISTRAR-ONLY.
        // A user cannot pin themselves, so they cannot name their own wallet as a
        // destination; only the server can, and the server only ever names a wallet
        // it provisioned under a Privy policy. A compromised registrar could
        // already pin any unset user to any address, so permitting the self-pin
        // adds nothing to that case.
        //
        // NOTE for anyone auditing the blacklist: because `user` is a freshly
        // minted per-user wallet, `_assertAllowed`'s rmusers() check can never
        // match, so the on-chain blacklist is VACUOUS for this integration. That
        // was already true before this change - it follows from who signs, not from
        // this check - and it must not be counted as a control. The caps are keyed
        // per ramp wallet, which is 1:1 with a user, so those still bind.
        rampRecipientOf[user] = recipient;
        emit RampRecipientSet(user, recipient);
    }

    /// @notice Replace an existing pin. COLD key only, distinct event.
    function resetRampRecipient(address user, address recipient) external onlyOwner {
        if (user == address(0) || recipient == address(0)) revert InvalidAddress();
        // Same reversal as setRampRecipient, for the same reason - and this path is
        // cold-key only, so it is the stricter of the two to begin with.
        address from = rampRecipientOf[user];
        rampRecipientOf[user] = recipient;
        emit RampRecipientReset(user, from, recipient);
    }

    function setRegistrar(address next) external onlyOwner {
        emit RegistrarChanged(registrar, next);
        registrar = next;
    }

    /// @notice Two-step, so a typo cannot hand the contract to an address nobody
    ///         controls. Passing address(0) cancels a pending transfer.
    function transferOwnership(address next) external onlyOwner {
        pendingOwner = next;
        emit OwnerTransferStarted(owner, next);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPending();
        emit OwnerTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    /**
     * @notice Manual escape for a leaked in-flight slot.
     *
     *         `reconcile` is the normal path and needs no privilege. This exists
     *         for the case reconcile cannot fix - an order id nobody recorded, or
     *         a Diamond read that will not resolve - because the alternative is a
     *         user permanently unable to place an order.
     */
    function resetInFlight(address user) external onlyOwner {
        emit InFlightReset(user, inFlightOf[user]);
        inFlightOf[user] = 0;
    }

    /**
     * @notice Last resort for USDC that should never have arrived here.
     *
     *         With usdcThroughIntegrator = false nothing routes through this
     *         contract, and `userPlaceOrder` refuses outright if the registration
     *         is ever flipped - so a balance here means something went wrong
     *         upstream. Without this the funds would be unrecoverable.
     */
    function sweepUsdc(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert InvalidAddress();
        emit UsdcSwept(to, amount);
        usdc.safeTransfer(to, amount);
    }

    function isRegistered(address user) external view returns (bool) {
        return rampRecipientOf[user] != address(0);
    }

    function setCaps(uint256 perTx, uint256 perDay, uint256 inFlight) external onlyOwner {
        if (perTx > MAX_PER_TX_USDC) revert CapExceedsCeiling(perTx, MAX_PER_TX_USDC);
        if (perDay > MAX_PER_DAY_USDC) revert CapExceedsCeiling(perDay, MAX_PER_DAY_USDC);
        if (inFlight > MAX_IN_FLIGHT) revert CapExceedsCeiling(inFlight, MAX_IN_FLIGHT);
        perTxCapUsdc = perTx;
        perDayCapUsdc = perDay;
        inFlightCap = inFlight;
        emit CapsUpdated(perTx, perDay, inFlight);
    }

    // ─── IP2PIntegrator ───────────────────────────────────────────────

    /**
     * @notice Called by the Diamond at placement; reverting blocks the order.
     *
     *         Reverts with a named error rather than returning false, so the
     *         client gets a decodable reason instead of a bare failure.
     */
    function validateOrder(
        address user,
        uint256 amount,
        bytes32 /*currency*/
    ) external returns (bool allowed) {
        _assertAllowed(user, amount);
        return true;
    }

    /**
     * @notice Fiat settled. Sweep the proxy and forward to the PINNED
     *         recipient, ignoring `recipientAddr`.
     *
     *         `recipientAddr` is ignored on purpose and not merely unused: it
     *         is the one value a client could have influenced, and honouring it
     *         would undo the reason this integrator is pinned at all.
     */
    function onOrderComplete(
        uint256 orderId,
        address user,
        uint256 amount,
        address recipientAddr
    ) external {
        if (msg.sender != diamond) revert OnlyDiamond();

        // THIS FUNCTION MOVES NO MONEY, and that is the point. Registered with
        // usdcThroughIntegrator = false, the Diamond has already paid
        // `_order.recipientAddr` - the ramp wallet we pinned at placement -
        // directly (B2BGatewayFacet.sol:267). There is no balance here to
        // forward, nothing to strand if this reverts, and no custody to reason
        // about. All that is left is bookkeeping and the event.
        //
        // DECREMENT ONLY THIS ORDER'S OWN SLOT. CANCELLED -> PAID -> COMPLETED is
        // a real BUY lifecycle (an admin re-opens a disputed order), and after a
        // cancel has already released the row, an unconditional decrement here
        // would free a slot belonging to a DIFFERENT in-flight order. Non-
        // reverting either way: the Diamond's state is final and a revert here
        // only loses the event.
        if (orderUserOf[orderId] == user) {
            if (inFlightOf[user] > 0) inFlightOf[user] -= 1;
            delete orderUserOf[orderId];
            delete orderAmountOf[orderId];
            delete orderDayOf[orderId];
        }

        emit RampSettled(orderId, user, amount, recipientAddr);
    }

    /**
     * @notice Order died. Release the daily debit and the in-flight slot, and
     *         count the cancel against the user.
     *
     *         Idempotent, and tolerant of an unknown id: the interface requires
     *         it, and the Diamond may call after on-chain state has finalised.
     *         Deleting the row is what makes a second call a no-op.
     */
    function onOrderCancel(uint256 orderId) external {
        if (msg.sender != diamond) revert OnlyDiamond();
        address user = orderUserOf[orderId];
        if (user == address(0)) return; // unknown or already handled

        uint256 amount = orderAmountOf[orderId];
        uint256 day = orderDayOf[orderId];
        if (dailySpentOf[user][day] >= amount) dailySpentOf[user][day] -= amount;
        else dailySpentOf[user][day] = 0;
        if (inFlightOf[user] > 0) inFlightOf[user] -= 1;
        cancelCountOf[user] += 1;

        delete orderUserOf[orderId];
        delete orderAmountOf[orderId];
        delete orderDayOf[orderId];

        emit OrderCancelled(orderId, user);
    }

    // ─── Order entry ──────────────────────────────────────────────────

    /**
     * @notice Place an on-ramp. No `recipientAddr` argument, by design (D2).
     *
     *         The caller is always `msg.sender`: an on-ramp cannot be placed on
     *         another user's behalf, so a registered account cannot be used as
     *         a funnel for an unregistered one.
     */
    function userPlaceOrder(
        uint256 amountUsdc,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey
    ) external nonReentrant returns (uint256 orderId) {
        address user = msg.sender;
        _assertAllowed(user, amountUsdc);

        uint256 day = block.timestamp / 1 days;
        // FAIL CLOSED ON A WRONG REGISTRATION. If this integrator is ever
        // whitelisted with usdcThroughIntegrator = TRUE - which has happened to
        // another integrator in production - settlement lands on this contract
        // instead of the user's ramp wallet, and `onOrderComplete` would still
        // emit RampSettled, so the app would credit a tranche to a user who never
        // received the money. Refusing at placement means no such order can
        // exist, so nothing can strand and nothing can be miscredited. The
        // comments and the deploy-script warning are not a control.
        if (_routesThroughIntegrator()) revert RoutesThroughIntegrator();

        // PROXY-AS-PLACER, and it is not optional: the B2B gateway is
        // proxy-only. The user's UserProxy is the msg.sender that calls
        // placeB2BOrder, and the gateway resolves that back to this integrator
        // by re-deriving the CREATE2 address. Calling the Diamond directly from
        // here would simply fail authentication.
        address proxy = _ensureProxy(user);

        // The recipient is THE control, so it is read from storage and never
        // from an argument - and it is recorded on the order itself, because
        // with usdcThroughIntegrator = false this is the address the Diamond
        // pays at settlement. _assertAllowed above has already refused a user
        // with no pin, so this can never be the zero address: an order that
        // would have nowhere to land cannot be placed in the first place.
        address recipient = rampRecipientOf[user];
        bytes memory placeData = abi.encodeCall(
            IB2BGateway.placeB2BOrder,
            (user, amountUsdc, currency, recipient, pubKey, circleId, 0, 0)
        );
        // usdcAllowance = 0: placeB2BOrder pulls nothing, at placement OR at
        // completion. A BUY settles from the merchant's already-escrowed funds, so
        // no USDC ever leaves the proxy on this path.
        // The orderId comes back through `execute`, which returns the call's
        // return data verbatim - the same way showdown reads it. An earlier
        // draft pre-read getNextOrderId() instead, on the belief that the return
        // value did not survive the proxy. It does, and the pre-read was also
        // strictly worse: it depends on the Diamond reads-then-increments, and
        // it records the wrong id whenever the gateway hands back an id it chose
        // for itself.
        bytes memory result = UserProxy(proxy).execute(diamond, placeData, address(usdc), 0);
        orderId = abi.decode(result, (uint256));

        // Debited AFTER the call, not before. The Diamond invokes
        // validateOrder DURING placement, and that runs the same _assertAllowed
        // as this function - so incrementing first made the order count against
        // itself and every placement past the first failed its own in-flight
        // cap. Caught by the caps tests, which is the only reason it is not
        // still in here.
        dailySpentOf[user][day] += amountUsdc;
        inFlightOf[user] += 1;

        orderUserOf[orderId] = user;
        orderAmountOf[orderId] = amountUsdc;
        orderDayOf[orderId] = day;

        emit OrderPlaced(orderId, user, amountUsdc);
    }

    /**
     * @notice Release an order's slot and daily debit from the CHAIN's own state.
     *
     *         THE REASON THIS EXISTS. `onOrderCancel` is the only other thing that
     *         releases a row, and the Diamond does not reliably call it: in
     *         contracts-v4 at the revision this was written against,
     *         `onB2BOrderCancelled` decrements the gateway's own activeOrderCount
     *         and emits, and never calls the integrator
     *         (B2BGatewayFacet.sol:301-318) - while `onB2BOrderComplete` does call
     *         onOrderComplete. Later revisions make it opt-in per integrator and
     *         default OFF. Either way the in-flight slot of an order that expired
     *         unaccepted, or that the user abandoned, is held forever; after
     *         `inFlightCap` of those the user can never place again. Roughly half
     *         of mainnet B2B BUY orders end CANCELLED, so that is the common case.
     *
     *         PERMISSIONLESS, because it grants nothing: the status comes from the
     *         Diamond and the row it releases is the one the Diamond names.
     *         Idempotent - an unknown or already-released id is a no-op.
     */
    function reconcile(uint256 orderId) external {
        address user = orderUserOf[orderId];
        if (user == address(0)) return; // unknown, or already released

        (address onChainUser, uint8 status) = _orderUserAndStatus(orderId);
        // SELF-CHECKING POSITIONAL READ. `status` sits at a fixed index in the
        // returned tuple's head whatever the strings contain, but a member
        // inserted upstream BEFORE it would shift both fields together - so the
        // user must agree, or this reverts rather than releasing the wrong row.
        if (onChainUser != user) revert ConfigUnreadable();
        // 3 = COMPLETED, 4 = CANCELLED (OrderProcessorStorage.OrderStatus).
        if (status != 3 && status != 4) return; // still live; nothing to release

        uint256 amount = orderAmountOf[orderId];
        uint256 day = orderDayOf[orderId];
        if (status == 4) {
            // A cancel refunds the day's debit. A completion does not: the money
            // moved, and the daily cap is about volume placed.
            if (dailySpentOf[user][day] >= amount) dailySpentOf[user][day] -= amount;
            else dailySpentOf[user][day] = 0;
        }
        if (inFlightOf[user] > 0) inFlightOf[user] -= 1;

        delete orderUserOf[orderId];
        delete orderAmountOf[orderId];
        delete orderDayOf[orderId];

        emit OrderReconciled(orderId, user, status);
    }

    // ─── Internal ─────────────────────────────────────────────────────

    /**
     * @dev Is this integrator registered to receive USDC itself?
     *
     *      Raw staticcall and word 1, not a typed decode. IntegratorConfig is
     *      `{bool isActive, bool usdcThroughIntegrator, uint256 activeOrderCount,
     *      address proxyImpl}` - all static, so word 1 is the flag and STAYS word
     *      1 even when the struct gains members at the end, which mainnet's has.
     *      A typed decode against a mirrored struct would revert on that change
     *      instead, turning an upstream addition into an outage.
     */
    function _routesThroughIntegrator() internal view returns (bool) {
        (bool ok, bytes memory out) = diamond.staticcall(
            abi.encodeWithSignature("getIntegratorConfig(address)", address(this))
        );
        if (!ok || out.length < 64) revert ConfigUnreadable();
        uint256 word1;
        assembly {
            word1 := mload(add(out, 0x40))
        }
        return word1 != 0;
    }

    /// @dev (user, status) from the Diamond's order. See reconcile for why the
    ///      positional read is safe and how it self-checks.
    function _orderUserAndStatus(uint256 orderId) internal view returns (address, uint8) {
        (bool ok, bytes memory out) = diamond.staticcall(
            abi.encodeWithSignature("getOrdersById(uint256)", orderId)
        );
        // offset word + 12 head words is the minimum that can contain `status`.
        if (!ok || out.length < 0x1a0) revert ConfigUnreadable();
        uint256 userWord;
        uint256 statusWord;
        assembly {
            // out points at the length; data starts at 0x20. The returned tuple is
            // dynamic, so data[0] is an offset (0x20) and the head begins at 0x40.
            // user is head index 6, status is head index 11.
            userWord := mload(add(out, add(0x40, mul(6, 0x20))))
            statusWord := mload(add(out, add(0x40, mul(11, 0x20))))
        }
        return (address(uint160(userWord)), uint8(statusWord));
    }

    /// @dev One gate, called from both `userPlaceOrder` and `validateOrder`, so
    ///      the front-run path and the Diamond's callback can never disagree.
    function _assertAllowed(address user, uint256 amount) internal view {
        if (rampRecipientOf[user] == address(0)) revert NotRegistered(user);

        if (address(reputationManager) != address(0)) {
            (, , bool blacklisted) = reputationManager.rmusers(user);
            if (blacklisted) revert UserBlacklisted(user);
        }

        if (amount > perTxCapUsdc) revert OverPerTxCap(amount, perTxCapUsdc);

        uint256 day = block.timestamp / 1 days;
        uint256 spent = dailySpentOf[user][day];
        if (spent + amount > perDayCapUsdc) revert OverDailyCap(spent + amount, perDayCapUsdc);

        // Every cancel permanently costs one slot, to a floor of one.
        uint256 cap = inFlightCap;
        uint256 penalty = cancelCountOf[user];
        cap = penalty >= cap ? 1 : cap - penalty;
        if (inFlightOf[user] >= cap) revert TooManyInFlight(user, inFlightOf[user], cap);
    }

    // ─── Proxy helpers (mirror the template exactly) ───────────────────

    function proxyAddress(address user) public view returns (address) {
        return
            Clones.predictDeterministicAddressWithImmutableArgs(
                proxyImpl,
                _proxyArgs(user),
                _salt(user),
                address(this)
            );
    }

    function _salt(address user) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(user)));
    }

    /// @dev [owner(20)][integrator(20)] — the Diamond's CREATE2 auth path
    ///      reconstructs these exact args. DO NOT change the layout.
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
