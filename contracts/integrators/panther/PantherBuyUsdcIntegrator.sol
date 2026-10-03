// SPDX-License-Identifier: Apache-2.0
// ^0.8.28 (not .20): this contract deploys UserProxy, which uses `transient`
// storage, and keeps its own reentrancy flags in transient storage too.
pragma solidity ^0.8.28;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { IOrderFlow } from "../../interfaces/IOrderFlow.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

/**
 * @title PantherBuyUsdcIntegrator
 * @notice Server-driven onramp for Panther, a custodial wallet. Panther's
 *         backend buys USDC on behalf of its users through P2P BUY orders and
 *         every order settles DIRECTLY into Panther's treasury. Panther then
 *         credits the buyer's internal (off-chain) ledger when the order
 *         completes.
 *
 *         End users never hold keys on Base. Each Panther account is
 *         identified by an opaque `bytes32 cuenta` (a hash of the internal
 *         account id — no PII on-chain) and mapped to a deterministic, keyless
 *         pseudo user address `usuarioDe(cuenta)`. That pseudo user gets the
 *         canonical per-user `UserProxy`, exactly like every sibling, so the
 *         Diamond's per-user CREATE2 auth and the integrator's per-account
 *         limits both work unchanged.
 *
 *         Flow:
 *           1. `operator` (Panther's server key) calls `operatorPlaceOrder`.
 *              The integrator places through the account's proxy with
 *              `order.user = proxy` and `recipientAddr = treasury`.
 *           2. The Diamond calls back `validateOrder` synchronously; the
 *              per-tx cap, daily count and optional daily volume are enforced
 *              there and the slots reserved.
 *           3. The buyer pays fiat to the accepting LP off-chain, and Panther's
 *              server relays "I have paid" with `operatorMarkPaid`. The Diamond
 *              gates `paidBuyOrder` on `order.user`, which is why the proxy is
 *              `order.user` — the same reason merchant-terminal link orders
 *              place that way. Only this contract can drive the proxy.
 *           4. The LP completes; with `usdcThroughIntegrator = false` the
 *              Diamond transfers USDC straight to `treasury` and calls
 *              `onOrderComplete`, which only records and emits
 *              `PantherOrderCompleted` — the signal Panther credits on.
 *
 *         Custody: this contract never receives or forwards USDC in the
 *         normal flow, and neither do the proxies (they are only the
 *         authenticated caller). The only USDC path out of this contract is
 *         `flushToTreasury`, hard-wired to `treasury`, for the mis-registration
 *         case (`usdcThroughIntegrator = true`) or a stray transfer.
 *
 * @dev    Registration MUST be `registerIntegrator(this, false, proxyImpl)`.
 *         Every owner-settable limit is bounded by an immutable `MAX_*`
 *         ceiling compiled into the bytecode.
 */
contract PantherBuyUsdcIntegrator is IP2PIntegrator {
    using SafeERC20 for IERC20;

    // ─── Errors ───────────────────────────────────────────────────────

    error OnlyDiamond();
    error OnlyOwner();
    error OnlyOperator();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidCuenta();
    error InvalidLimit();
    error CapExceedsCeiling();
    error ContractPaused();
    error FieldTooLong();
    error PerTxCapExceeded();
    error DailyCountLimitExceeded();
    error DailyVolumeExceeded();
    error OrderValidationMissing();
    error OrderIdAlreadyUsed();
    error UnknownOrder();
    error OrderFinalized();
    error AlreadyPaid();
    error Reentrancy();

    // ─── Events ───────────────────────────────────────────────────────

    event OperatorUpdated(address indexed operator);
    event PerTxCapUpdated(uint256 cap);
    event DailyTxCountLimitUpdated(uint256 count);
    event DailyVolumeCapUpdated(uint256 cap);
    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event UserProxyDeployed(bytes32 indexed cuenta, address indexed user, address proxy);

    event PantherOrderPlaced(
        uint256 indexed orderId,
        bytes32 indexed cuenta,
        uint256 amount,
        bytes32 currency
    );
    event PantherOrderPaid(uint256 indexed orderId, bytes32 indexed cuenta);
    event PantherOrderCompleted(uint256 indexed orderId, bytes32 indexed cuenta, uint256 amount);
    event PantherOrderCancelled(uint256 indexed orderId, bytes32 indexed cuenta);

    /// @notice Widget-compatible 5-field placement event (same shape as
    ///         MarketplaceCheckoutIntegrator). `user` is the account's proxy,
    ///         `recipeKey` carries the `cuenta`, `quantity` is always 1.
    event CheckoutOrderCreated(
        uint256 indexed orderId,
        address indexed user,
        bytes32 indexed recipeKey,
        uint256 quantity,
        uint256 totalUsdcAmount
    );

    /// @notice An order that had been cancelled (slots released) completed
    ///         anyway — the Diamond's admin/dispute path can re-open a
    ///         CANCELLED BUY. The USDC did reach the treasury, so the order is
    ///         settled normally and the daily slot re-charged on today's bucket.
    event CancelledOrderCompleted(uint256 indexed orderId, bytes32 indexed cuenta);

    /// @notice A completion callback that does not look like the order this
    ///         contract placed, or settlement that was routed to this contract
    ///         instead of the treasury (`usdcThroughIntegrator` registered true).
    /// @dev    The Diamond passes `recipientAddr` unchanged in BOTH routing
    ///         branches, so a mis-registration is detected from the Diamond's
    ///         own config flag (raw word 1 of `getIntegratorConfig`), falling
    ///         back to this contract's balance if the config is unreadable.
    ///         Same reasoning as OwnCheckoutIntegrator.
    event SettlementRoutingAnomaly(
        uint256 indexed orderId,
        address expectedProxy,
        address callbackUser,
        uint256 callbackAmount,
        address callbackRecipient,
        uint256 integratorBalance
    );

    event FlushedToTreasury(uint256 amount);

    // ─── Immutable policy ceilings ────────────────────────────────────
    // Compiled into the bytecode. Nothing — owner included — can move them.

    /// @notice Hard ceiling for `perTxCap` (USDC, 6dp).
    uint256 public constant MAX_PER_TX_CAP = 500e6;
    /// @notice Hard ceiling for `dailyTxCountLimit`.
    uint256 public constant MAX_DAILY_TX_COUNT_LIMIT = 50;
    /// @notice Hard ceiling for `dailyVolumeCap` (USDC, 6dp).
    uint256 public constant MAX_DAILY_VOLUME_CAP = 5_000e6;
    /// @dev A secp256k1 public key is 128-132 hex chars. Capped because the
    ///      Diamond forwards and stores it.
    uint256 internal constant MAX_PUBKEY = 256;

    /// @notice Domain tag of the pseudo user derivation.
    string public constant USER_DOMAIN = "panther.p2pkit";

    // ─── Immutables ───────────────────────────────────────────────────

    address public immutable diamond;
    /// @notice Settlement token. Also read by `UserProxy.sweepERC20` (IUsdcSource).
    IERC20 public immutable usdc;
    /// @notice Deployer. Sets operator, limits and pause. Not transferable.
    address public immutable owner;
    /// @notice Panther's treasury: the `recipientAddr` of EVERY order and the
    ///         only destination USDC can ever be sent to from this contract.
    address public immutable treasury;
    /// @notice The canonical UserProxy implementation all clones point to.
    address public immutable proxyImpl;

    // ─── Configuration ────────────────────────────────────────────────

    /// @notice Panther's server hot wallet — the ONLY caller of
    ///         operatorPlaceOrder / operatorMarkPaid / operatorCancelOrder.
    ///         address(0) disables all three.
    address public operator;
    /// @notice Max USDC (6dp) per order. 1..MAX_PER_TX_CAP.
    uint256 public perTxCap;
    /// @notice Max placed orders per `cuenta` per UTC day. 1..MAX_DAILY_TX_COUNT_LIMIT.
    uint256 public dailyTxCountLimit;
    /// @notice Max USDC (6dp) placed per `cuenta` per UTC day. 0 = off.
    uint256 public dailyVolumeCap;
    /// @notice Break-glass: blocks NEW placements and operator cancels. Does NOT
    ///         block `operatorMarkPaid` or the Diamond callbacks.
    bool public paused;

    // ─── Accounting ───────────────────────────────────────────────────

    struct Session {
        bytes32 cuenta;
        uint256 amount;
        uint32 placementDay;
        bool paid;
        bool fulfilled;
        bool cancelled;
    }

    /// @notice proxy => cuenta, written when the proxy is first deployed.
    mapping(address => bytes32) public proxyCuenta;
    /// @notice orderId => session.
    mapping(uint256 => Session) public sessions;
    /// @notice cuenta => UTC day => orders placed (net of released cancels).
    mapping(bytes32 => mapping(uint256 => uint256)) public dailyCount;
    /// @notice cuenta => UTC day => USDC placed (net of released cancels).
    ///         Always tracked, so enabling `dailyVolumeCap` mid-day is exact.
    mapping(bytes32 => mapping(uint256 => uint256)) public dailyVolume;

    // ─── Transient state ──────────────────────────────────────────────

    /// @dev Entry-point guard.
    bool private transient _entered;
    /// @dev A SECOND, independent guard for the Diamond's callbacks.
    ///      `operatorCancelOrder -> Diamond.cancelOrder -> onOrderCancel` calls
    ///      straight back in; on a shared flag the callback would revert on the
    ///      lock its own caller holds, and the Diamond swallows callback
    ///      failures (lesson from MerchantTerminalIntegrator).
    bool private transient _cbLocked;

    /// @dev Pending-placement binding: `validateOrder` approves only the exact
    ///      (proxy, amount, currency) tuple `operatorPlaceOrder` is mid-flight
    ///      on, once.
    address private transient _pendingProxy;
    uint256 private transient _pendingAmount;
    bytes32 private transient _pendingCurrency;
    bool private transient _pendingValidated;

    // ─── Modifiers ────────────────────────────────────────────────────

    modifier onlyDiamond() {
        if (msg.sender != diamond) revert OnlyDiamond();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert OnlyOperator();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    modifier nonReentrant() {
        if (_entered) revert Reentrancy();
        _entered = true;
        _;
        _entered = false;
    }

    modifier nonReentrantCallback() {
        if (_cbLocked) revert Reentrancy();
        _cbLocked = true;
        _;
        _cbLocked = false;
    }

    // ─── Constructor ──────────────────────────────────────────────────

    /**
     * @param _diamond           P2P Diamond (B2B gateway) address.
     * @param _usdc              USDC token address.
     * @param _treasury          Panther treasury; recipient of every order.
     * @param _operator          Panther server hot wallet (may be 0, set later).
     * @param _perTxCap          Per-order USDC cap (6dp), 1..MAX_PER_TX_CAP.
     * @param _dailyTxCountLimit Orders per cuenta per day, 1..MAX_DAILY_TX_COUNT_LIMIT.
     * @param _dailyVolumeCap    USDC per cuenta per day (6dp), 0 = off, <= MAX_DAILY_VOLUME_CAP.
     */
    constructor(
        address _diamond,
        address _usdc,
        address _treasury,
        address _operator,
        uint256 _perTxCap,
        uint256 _dailyTxCountLimit,
        uint256 _dailyVolumeCap
    ) {
        if (_diamond == address(0) || _usdc == address(0) || _treasury == address(0)) {
            revert InvalidAddress();
        }
        if (_treasury == _diamond || _treasury == _usdc) revert InvalidAddress();
        diamond = _diamond;
        usdc = IERC20(_usdc);
        treasury = _treasury;
        owner = msg.sender;
        proxyImpl = address(new UserProxy());

        operator = _operator;
        emit OperatorUpdated(_operator);
        _setPerTxCap(_perTxCap);
        _setDailyTxCountLimit(_dailyTxCountLimit);
        _setDailyVolumeCap(_dailyVolumeCap);
    }

    // ─── Admin (owner) ────────────────────────────────────────────────

    /// @notice Rotate (or disable with address(0)) the operator key.
    function setOperator(address newOperator) external onlyOwner {
        operator = newOperator;
        emit OperatorUpdated(newOperator);
    }

    /// @notice Per-order USDC cap. 1..MAX_PER_TX_CAP.
    function setPerTxCap(uint256 cap) external onlyOwner {
        _setPerTxCap(cap);
    }

    /// @notice Orders per cuenta per UTC day. 1..MAX_DAILY_TX_COUNT_LIMIT.
    function setDailyTxCountLimit(uint256 count) external onlyOwner {
        _setDailyTxCountLimit(count);
    }

    /// @notice USDC per cuenta per UTC day. 0 = off, else <= MAX_DAILY_VOLUME_CAP.
    function setDailyVolumeCap(uint256 cap) external onlyOwner {
        _setDailyVolumeCap(cap);
    }

    /// @notice Stop new placements and operator cancels.
    function pause() external onlyOwner {
        if (paused) return;
        paused = true;
        emit Paused(msg.sender);
    }

    /// @notice Resume.
    function unpause() external onlyOwner {
        if (!paused) return;
        paused = false;
        emit Unpaused(msg.sender);
    }

    function _setPerTxCap(uint256 cap) internal {
        if (cap == 0) revert InvalidLimit();
        if (cap > MAX_PER_TX_CAP) revert CapExceedsCeiling();
        perTxCap = cap;
        emit PerTxCapUpdated(cap);
    }

    function _setDailyTxCountLimit(uint256 count) internal {
        if (count == 0) revert InvalidLimit();
        if (count > MAX_DAILY_TX_COUNT_LIMIT) revert CapExceedsCeiling();
        dailyTxCountLimit = count;
        emit DailyTxCountLimitUpdated(count);
    }

    function _setDailyVolumeCap(uint256 cap) internal {
        if (cap > MAX_DAILY_VOLUME_CAP) revert CapExceedsCeiling();
        dailyVolumeCap = cap;
        emit DailyVolumeCapUpdated(cap);
    }

    // ─── Recovery ─────────────────────────────────────────────────────

    /**
     * @notice Send this contract's entire USDC balance to `treasury`.
     * @dev    Permissionless on purpose: the destination is immutable, so the
     *         caller chooses nothing. By construction the balance is zero; it
     *         can only be non-zero after a mis-registration
     *         (`usdcThroughIntegrator = true`, flagged by
     *         `SettlementRoutingAnomaly`) or a stray transfer.
     */
    function flushToTreasury() external nonReentrant {
        uint256 bal = usdc.balanceOf(address(this));
        if (bal == 0) return;
        usdc.safeTransfer(treasury, bal);
        emit FlushedToTreasury(bal);
    }

    // ─── Views ────────────────────────────────────────────────────────

    /// @notice Deterministic keyless pseudo user for a Panther account.
    function usuarioDe(bytes32 cuenta) public pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(USER_DOMAIN, cuenta)))));
    }

    /// @notice Predicted proxy address for a pseudo user (may not exist yet).
    function proxyAddress(address user) public view returns (address) {
        return
            Clones.predictDeterministicAddressWithImmutableArgs(
                proxyImpl,
                _proxyArgs(user),
                _salt(user),
                address(this)
            );
    }

    /// @notice Predicted proxy address for a Panther account.
    function proxyDe(bytes32 cuenta) external view returns (address) {
        return proxyAddress(usuarioDe(cuenta));
    }

    /// @notice Orders `cuenta` can still place today.
    function getRemainingDailyCount(bytes32 cuenta) external view returns (uint256) {
        uint256 count = dailyCount[cuenta][block.timestamp / 1 days];
        if (count >= dailyTxCountLimit) return 0;
        return dailyTxCountLimit - count;
    }

    /// @notice USDC placed by `cuenta` today.
    function getTodayVolume(bytes32 cuenta) external view returns (uint256) {
        return dailyVolume[cuenta][block.timestamp / 1 days];
    }

    function getSession(uint256 orderId) external view returns (Session memory) {
        return sessions[orderId];
    }

    // ─── Operator flow ────────────────────────────────────────────────

    /**
     * @notice Place a BUY order for a Panther account. On completion the
     *         Diamond sends `amount` USDC to `treasury`.
     * @param cuenta   Panther account id hash (non-zero).
     * @param amount   USDC to buy (6dp).
     * @param currency Fiat currency the buyer pays in, e.g. bytes32("COP").
     * @param circleId P2P circle matching `currency`.
     * @param pubKey   Buyer-side encryption pubkey for the LP handshake.
     * @param preferredPaymentChannelConfigId Forwarded to the Diamond.
     * @param fiatAmountLimit Forwarded to the Diamond.
     * @return orderId The Diamond order id.
     */
    function operatorPlaceOrder(
        bytes32 cuenta,
        uint256 amount,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) external onlyOperator whenNotPaused nonReentrant returns (uint256 orderId) {
        if (cuenta == bytes32(0)) revert InvalidCuenta();
        if (amount == 0) revert InvalidAmount();
        if (bytes(pubKey).length > MAX_PUBKEY) revert FieldTooLong();

        // Friendly pre-checks with specific reverts; validateOrder re-enforces
        // them authoritatively and is where the slots are reserved.
        uint256 day = block.timestamp / 1 days;
        if (amount > perTxCap) revert PerTxCapExceeded();
        if (dailyCount[cuenta][day] >= dailyTxCountLimit) revert DailyCountLimitExceeded();
        if (dailyVolumeCap != 0 && dailyVolume[cuenta][day] + amount > dailyVolumeCap) {
            revert DailyVolumeExceeded();
        }

        address proxy = _ensureProxy(cuenta);

        _pendingProxy = proxy;
        _pendingAmount = amount;
        _pendingCurrency = currency;
        _pendingValidated = false;

        // order.user = proxy (so this contract can later drive paidBuyOrder /
        // cancelOrder through it); recipientAddr = treasury (settlement goes
        // straight there with usdcThroughIntegrator = false).
        bytes memory data = abi.encodeCall(
            IB2BGateway.placeB2BOrder,
            (
                proxy,
                amount,
                currency,
                treasury,
                pubKey,
                circleId,
                preferredPaymentChannelConfigId,
                fiatAmountLimit
            )
        );
        bytes memory result = UserProxy(proxy).execute(diamond, data, address(usdc), 0);
        orderId = abi.decode(result, (uint256));

        // The Diamond must have called back through validateOrder. If not, the
        // order skipped this contract's limits — unwind rather than record it.
        if (!_pendingValidated) revert OrderValidationMissing();
        _pendingProxy = address(0);
        _pendingAmount = 0;
        _pendingCurrency = bytes32(0);
        _pendingValidated = false;

        if (sessions[orderId].cuenta != bytes32(0)) revert OrderIdAlreadyUsed();
        sessions[orderId] = Session({
            cuenta: cuenta,
            amount: amount,
            placementDay: uint32(day),
            paid: false,
            fulfilled: false,
            cancelled: false
        });

        emit PantherOrderPlaced(orderId, cuenta, amount, currency);
        emit CheckoutOrderCreated(orderId, proxy, cuenta, 1, amount);
    }

    /**
     * @notice Relay the buyer's "I have paid" to the Diamond.
     * @dev    NOT gated by `paused`, deliberately (mirrors
     *         MerchantTerminalIntegrator.relayerMarkPaid): the buyer's fiat has
     *         already left their bank, and refusing the claim would strand it.
     *         PAID is a claim, not a settlement — USDC moves only when the LP
     *         completes after checking their own bank — so a compromised
     *         operator key cannot extract USDC with it.
     */
    function operatorMarkPaid(uint256 orderId) external onlyOperator nonReentrant {
        Session storage s = _liveSession(orderId);
        if (s.paid) revert AlreadyPaid();
        s.paid = true;
        _forward(s.cuenta, abi.encodeCall(IOrderFlow.paidBuyOrder, (orderId)));
        emit PantherOrderPaid(orderId, s.cuenta);
    }

    /**
     * @notice Cancel an order the buyer abandoned (only PLACED/ACCEPTED on the
     *         live Diamond).
     * @dev    Gated by `paused`, the opposite way round from `operatorMarkPaid`
     *         (same reasoning as MerchantTerminalIntegrator.relayerCancelOrder):
     *         cancelling destroys an in-flight order, which is the direction a
     *         compromised operator key would abuse. Abandoned orders still
     *         expire on the Diamond's own TTL while paused.
     *
     *         The slots are released here as well as in `onOrderCancel`
     *         (idempotent via `cancelled`), so they come back even if the
     *         Diamond's cancel callback is disabled for this integrator.
     */
    function operatorCancelOrder(uint256 orderId) external onlyOperator whenNotPaused nonReentrant {
        Session storage s = _liveSession(orderId);
        _forward(s.cuenta, abi.encodeCall(IOrderFlow.cancelOrder, (orderId)));
        _finalizeCancel(orderId);
    }

    // ─── IP2PIntegrator callbacks ─────────────────────────────────────

    /**
     * @notice The Diamond's synchronous gate during placeB2BOrder.
     * @dev    Returns false rather than reverting; the gateway unwinds. Only
     *         the exact tuple `operatorPlaceOrder` is mid-flight on can pass,
     *         and only once.
     */
    function validateOrder(
        address user,
        uint256 amount,
        bytes32 currency
    ) external onlyDiamond returns (bool allowed) {
        if (
            paused ||
            _pendingProxy == address(0) ||
            _pendingValidated ||
            _pendingProxy != user ||
            _pendingAmount != amount ||
            _pendingCurrency != currency
        ) return false;

        bytes32 cuenta = proxyCuenta[user];
        if (cuenta == bytes32(0)) return false; // not one of our proxies
        if (amount == 0 || amount > perTxCap) return false;

        uint256 day = block.timestamp / 1 days;
        uint256 count = dailyCount[cuenta][day];
        if (count >= dailyTxCountLimit) return false;
        uint256 vol = dailyVolume[cuenta][day] + amount;
        if (dailyVolumeCap != 0 && vol > dailyVolumeCap) return false;

        _pendingValidated = true;
        dailyCount[cuenta][day] = count + 1;
        dailyVolume[cuenta][day] = vol;
        return true;
    }

    /**
     * @notice Completion hook. Bookkeeping only: the Diamond has already sent
     *         the USDC to `treasury`. Emits `PantherOrderCompleted`, the event
     *         Panther credits the buyer's ledger on.
     * @dev    Never reverts on a known-but-odd state: the gateway try/catches
     *         this call, so a revert would only lose the event. Unknown or
     *         already-fulfilled orders are no-ops.
     */
    function onOrderComplete(
        uint256 orderId,
        address user,
        uint256 amount,
        address recipientAddr
    ) external onlyDiamond nonReentrantCallback {
        Session storage s = sessions[orderId];
        if (s.cuenta == bytes32(0) || s.fulfilled) return;

        address expectedProxy = proxyAddress(usuarioDe(s.cuenta));
        uint256 selfBalance = usdc.balanceOf(address(this));

        // Not the order we placed: report and leave it for manual review.
        if (user != expectedProxy || recipientAddr != treasury || amount == 0) {
            emit SettlementRoutingAnomaly(
                orderId,
                expectedProxy,
                user,
                amount,
                recipientAddr,
                selfBalance
            );
            return;
        }

        s.fulfilled = true;

        if (s.cancelled) {
            // Cancel-then-complete (admin/dispute re-open). The USDC arrived, so
            // settle; re-charge today's bucket for the slot the cancel freed.
            uint256 today = block.timestamp / 1 days;
            dailyCount[s.cuenta][today] += 1;
            dailyVolume[s.cuenta][today] += s.amount;
            emit CancelledOrderCompleted(orderId, s.cuenta);
        }

        // Mis-registration: the USDC is on THIS contract, not the treasury. The
        // order is still settled (the funds exist and can only go to the
        // treasury via flushToTreasury), but raise the alarm.
        (bool routesHere, bool known) = _routesThroughIntegrator();
        if (known ? routesHere : selfBalance >= amount) {
            emit SettlementRoutingAnomaly(
                orderId,
                expectedProxy,
                user,
                amount,
                recipientAddr,
                selfBalance
            );
        }

        emit PantherOrderCompleted(orderId, s.cuenta, amount);
    }

    /**
     * @notice Cancellation hook: releases the daily count / volume reserved in
     *         validateOrder, keyed on the placement day.
     * @dev    Tolerates unknown, already-cancelled and already-fulfilled
     *         orders (no-op, never reverts).
     */
    function onOrderCancel(uint256 orderId) external onlyDiamond nonReentrantCallback {
        _finalizeCancel(orderId);
    }

    // ─── Internals ────────────────────────────────────────────────────

    function _liveSession(uint256 orderId) internal view returns (Session storage s) {
        s = sessions[orderId];
        if (s.cuenta == bytes32(0)) revert UnknownOrder();
        if (s.fulfilled || s.cancelled) revert OrderFinalized();
    }

    /// @dev The proxy hop that satisfies the Diamond's `order.user` gate.
    function _forward(bytes32 cuenta, bytes memory data) internal {
        UserProxy(proxyAddress(usuarioDe(cuenta))).execute(diamond, data, address(usdc), 0);
    }

    function _finalizeCancel(uint256 orderId) internal {
        Session storage s = sessions[orderId];
        if (s.cuenta == bytes32(0) || s.fulfilled || s.cancelled) return;
        s.cancelled = true;

        uint256 day = uint256(s.placementDay);
        uint256 count = dailyCount[s.cuenta][day];
        if (count > 0) dailyCount[s.cuenta][day] = count - 1;
        uint256 vol = dailyVolume[s.cuenta][day];
        dailyVolume[s.cuenta][day] = vol > s.amount ? vol - s.amount : 0;

        emit PantherOrderCancelled(orderId, s.cuenta);
    }

    /// @dev `bytes4(keccak256("getIntegratorConfig(address)"))`.
    bytes4 private constant _GET_INTEGRATOR_CONFIG = 0x17353447;

    /// @dev Reads ONLY word 1 (`usdcThroughIntegrator`) of the Diamond's
    ///      integrator config with a raw staticcall, so the check survives the
    ///      struct growing fields (see OwnCheckoutIntegrator).
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

    function _salt(address user) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(user)));
    }

    function _proxyArgs(address user) internal view returns (bytes memory) {
        return abi.encodePacked(user, address(this));
    }

    function _ensureProxy(bytes32 cuenta) internal returns (address proxy) {
        address user = usuarioDe(cuenta);
        proxy = proxyAddress(user);
        if (proxy.code.length == 0) {
            address deployed = Clones.cloneDeterministicWithImmutableArgs(
                proxyImpl,
                _proxyArgs(user),
                _salt(user)
            );
            assert(deployed == proxy);
            proxyCuenta[proxy] = cuenta;
            emit UserProxyDeployed(cuenta, user, proxy);
        }
    }
}
