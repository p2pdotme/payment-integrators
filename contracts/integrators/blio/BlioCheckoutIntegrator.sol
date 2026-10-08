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
 *         `recipientAddr` is pinned to the immutable `treasury` and the
 *         integrator is registered with `usdcThroughIntegrator = false`, so
 *         the Diamond settles USDC DIRECTLY to the treasury. This contract
 *         never holds user funds at any point, which is why it has no
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

    // ─── Events ───────────────────────────────────────────────────────

    event ProductPriceSet(uint256 indexed productId, uint256 price);
    event ProductActiveSet(uint256 indexed productId, bool active);
    event BaseTxLimitUpdated(uint256 limit);
    event MaxTxLimitUpdated(bytes32 indexed currency, uint256 cap);
    event DailyTxCountLimitUpdated(uint256 count);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event UserProxyDeployed(address indexed user, address proxy);
    event UsdcSwept(address indexed to, uint256 amount);

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
    /// @notice Where the Diamond settles the USDC. Never this contract.
    address public immutable treasury;

    // ─── Immutable policy ceilings ────────────────────────────────────
    // Compiled into the bytecode. The constructor and every owner setter are
    // bounded by these, so no limit can ever exceed its ceiling — not by a
    // compromised owner key. Movement below a ceiling is free in both
    // directions.
    uint256 public constant MAX_BASE_TX_LIMIT = 5_000e6; // $5,000 per tx
    uint256 public constant MAX_DAILY_TX_COUNT_LIMIT = 100; // placements/user/day

    // ─── Configurable limits ──────────────────────────────────────────

    /// @notice Per-tx USDC cap applied to every order (6 decimals).
    uint256 public baseTxLimit;
    /// @notice Optional per-currency cap; 0 means "no extra cap".
    mapping(bytes32 => uint256) public maxTxLimit;
    /// @notice Placements allowed per user per UTC day.
    uint256 public dailyTxCountLimit;
    bool public paused;

    // ─── Products ─────────────────────────────────────────────────────

    /// @notice USDC price per unit of `productId` (6 decimals). 0 = unknown.
    mapping(uint256 => uint256) public productPrice;
    /// @notice Whether a product can be purchased. Lets the owner retire one
    ///         without deleting its price history.
    mapping(uint256 => bool) public productActive;

    // ─── Order state ──────────────────────────────────────────────────

    struct Session {
        address user; // 20 bytes
        bool fulfilled; //  1 byte  — packs with user
        bool cancelled; //  1 byte  — packs with user
        uint32 placementDay; // 4 bytes — key for the onOrderCancel decrement
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
     * @param _treasury     Destination of every settlement (a multisig).
     * @param _owner        Operator key (a multisig): limits, products, pause.
     *                      Transferable two-step via `transferOwnership` /
     *                      `acceptOwnership`.
     * @param _baseTxLimit  Per-tx USDC cap (6 decimals).
     * @param _dailyTxCount Placements per user per day.
     */
    constructor(
        address _diamond,
        address _usdc,
        address _treasury,
        address _owner,
        uint256 _baseTxLimit,
        uint256 _dailyTxCount
    ) Ownable(_owner) {
        if (
            _diamond == address(0) ||
            _usdc == address(0) ||
            _treasury == address(0) ||
            _owner == address(0)
        ) revert InvalidAddress();
        if (_dailyTxCount == 0) revert InvalidQuantity();
        if (_baseTxLimit > MAX_BASE_TX_LIMIT) revert CapExceedsCeiling();
        if (_dailyTxCount > MAX_DAILY_TX_COUNT_LIMIT) revert CapExceedsCeiling();

        diamond = _diamond;
        usdc = IERC20(_usdc);
        treasury = _treasury;
        baseTxLimit = _baseTxLimit;
        dailyTxCountLimit = _dailyTxCount;

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

    function setBaseTxLimit(uint256 limit) external onlyOwner {
        if (limit > MAX_BASE_TX_LIMIT) revert CapExceedsCeiling();
        baseTxLimit = limit;
        emit BaseTxLimitUpdated(limit);
    }

    function setMaxTxLimit(bytes32 currency, uint256 cap) external onlyOwner {
        if (cap > MAX_BASE_TX_LIMIT) revert CapExceedsCeiling();
        maxTxLimit[currency] = cap;
        emit MaxTxLimitUpdated(currency, cap);
    }

    function setDailyTxCountLimit(uint256 count) external onlyOwner {
        if (count == 0) revert InvalidQuantity();
        if (count > MAX_DAILY_TX_COUNT_LIMIT) revert CapExceedsCeiling();
        dailyTxCountLimit = count;
        emit DailyTxCountLimitUpdated(count);
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
            placementDay: uint32(block.timestamp / 1 days),
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
        if (session.user == address(0) || session.fulfilled || session.cancelled) return;

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

    /// @notice Cancellation hook. Releases the daily-count slot reserved in
    ///         `validateOrder`, keyed on the placement-day snapshot.
    /// @dev    Never reverts (best-effort from the gateway's POV).
    function onOrderCancel(uint256 orderId) external onlyDiamond {
        Session storage session = sessions[orderId];
        if (session.user == address(0) || session.fulfilled || session.cancelled) return;

        session.cancelled = true;

        uint256 day = uint256(session.placementDay);
        uint256 count = userDailyCount[session.user][day];
        if (count > 0) {
            userDailyCount[session.user][day] = count - 1;
        }

        emit BlioOrderCancelled(orderId, session.user);
    }

    // ─── Views ────────────────────────────────────────────────────────

    /// @notice Effective per-tx USDC limit for `user` in `currency`.
    function userTxLimitFor(address /*user*/, bytes32 currency) public view returns (uint256) {
        uint256 cap = maxTxLimit[currency];
        if (cap > 0 && cap < baseTxLimit) return cap;
        return baseTxLimit;
    }

    /// @notice Parameterless per-tx cap, for the widget's `fetchUserTxLimit`.
    function userTxLimit() external view returns (uint256) {
        return baseTxLimit;
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
