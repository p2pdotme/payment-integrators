// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { IOrderFlow } from "../../interfaces/IOrderFlow.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

/**
 * @title BlackstripeCheckoutIntegrator
 * @notice A deliberately minimal P2P integrator with two symmetric flows and
 *         NO liveness / KYC / anti-sybil gating:
 *
 *           1. Onramp  (fiat -> USDC): the user pays fiat and the Diamond
 *              delivers the purchased USDC straight to the user's own EOA
 *              (recipientAddr = user, usdcThroughIntegrator = false). Modeled
 *              on UsdcDirectCheckoutIntegrator, stripped of its attestation
 *              tiers — any user can buy, bounded only by simple per-tx /
 *              per-day limits.
 *
 *           2. Offramp (USDC -> fiat) FROM THE USER'S OWN WALLET: the user
 *              approves this integrator for `principal + fee` USDC, the
 *              integrator places a SELL on the Diamond, and at UPI-delivery
 *              time pulls that USDC directly from the user's wallet (via
 *              `transferFrom`) to fund the order. Unlike
 *              MarketplaceCheckoutIntegrator (which funds sells from a
 *              pre-seeded integrator pool), Blackstripe holds no pool — every
 *              cent sold comes from, and every refund returns to, the user.
 *
 *         Both flows route through a per-actor `UserProxy` clone at a
 *         deterministic CREATE2 address (the B2B gateway is proxy-only). The
 *         user's onramp proxy is only an authenticated caller and never holds
 *         USDC. The offramp uses the integrator's own "system proxy"
 *         (owner = address(this)) as `order.user`, funded just-in-time from
 *         the seller's wallet.
 *
 * @dev    Register on the Diamond with `usdcThroughIntegrator = false`:
 *         onramp completion routes USDC to the user EOA; the sell flow pulls
 *         USDC from `order.user` (the system proxy) at `setSellOrderUpi` and
 *         never routes completion USDC back through the integrator.
 */
contract BlackstripeCheckoutIntegrator is IP2PIntegrator {
    using SafeERC20 for IERC20;
    using Clones for address;

    // ─── Errors ───────────────────────────────────────────────────────

    error OnlyDiamond();
    error OnlyOwner();
    error InvalidAddress();
    error InvalidAmount();
    error TxLimitExceeded();
    error DailyCountExceeded();
    error OrderAlreadyFulfilled();
    error OrderAlreadyCancelled();

    // Offramp
    error OfframpDisabled();
    error OfframpNotAuthorized();
    error OfframpAmountTooLarge();
    error OfframpInsufficientAllowance();
    error OfframpRecordNotFound();
    error OfframpAlreadyReconciled();

    // ─── Events ───────────────────────────────────────────────────────

    event BaseTxLimitUpdated(uint256 limit);
    event DailyTxCountLimitUpdated(uint256 count);
    event OfframpEnabledUpdated(bool enabled);
    event OfframpRelayerUpdated(address indexed relayer);
    event MaxUsdcPerOfframpUpdated(uint256 cap);

    event UserProxyDeployed(address indexed user, address proxy);

    // Onramp
    event OnrampOrderCreated(
        uint256 indexed orderId,
        address indexed user,
        uint256 amount,
        bytes32 currency
    );
    event OnrampOrderFulfilled(uint256 indexed orderId, address indexed user, uint256 amount);

    // Offramp
    event OfframpInitiated(uint256 indexed orderId, address indexed user, uint256 usdcAmount);
    event OfframpUpiDelivered(uint256 indexed orderId, uint256 usdcPulled);
    event OfframpReconciled(uint256 indexed orderId, uint8 status);
    event OfframpRefunded(uint256 indexed orderId, address indexed user, uint256 amount);

    // ─── Immutables ───────────────────────────────────────────────────

    address public immutable diamond;
    IERC20 public immutable usdc;
    address public immutable owner;
    /// @notice The UserProxy implementation that all clones delegate to.
    address public immutable proxyImpl;

    // ─── Configurable limits ──────────────────────────────────────────

    /// @notice Per-tx USDC ceiling for onramp BUY orders (micro-USDC, 6dp).
    ///         0 = no per-tx limit.
    uint256 public baseTxLimit;
    /// @notice Max number of onramp BUY orders a user can place per day.
    ///         0 = no daily count limit.
    uint256 public dailyTxCountLimit;

    // ─── Offramp config ───────────────────────────────────────────────

    /// @notice Master switch for the offramp flow. Defaults ON at deploy.
    bool public offrampEnabled;
    /// @notice Optional relayer permitted to deliver UPI on a user's behalf
    ///         (in addition to the order's initiator). 0 = user-only.
    address public offrampRelayer;
    /// @notice Optional per-offramp USDC cap (micro-USDC, 6dp). 0 = no cap.
    uint256 public maxUsdcPerOfframp;

    // ─── Onramp accounting ────────────────────────────────────────────

    mapping(address => mapping(uint256 => uint256)) public userDailyCount;

    struct Session {
        address user; // 20 bytes
        bool fulfilled; //  1 byte  — packs with user
        bool cancelled; //  1 byte  — packs with user
        uint32 placementDay; //  4 bytes — pinned for onOrderCancel decrement keying
        uint256 amount;
    }

    /// @notice BUY sessions, keyed by Diamond orderId.
    mapping(uint256 => Session) public sessions;

    // ─── Offramp accounting ───────────────────────────────────────────

    struct OfframpRecord {
        address user; // the seller whose wallet funds / is refunded
        uint256 usdcAmount; // principal placed (excludes fee)
        uint8 lastStatus; // last reconciled Diamond status (3=COMPLETED,4=CANCELLED)
        bool initialized;
    }

    /// @notice Offramp records, keyed by Diamond orderId.
    mapping(uint256 => OfframpRecord) public offramps;
    /// @notice orderId => the address that initiated the offramp (may deliver UPI).
    mapping(uint256 => address) public orderInitiator;

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
     * @param _usdc              USDC token address.
     * @param _baseTxLimit       Per-tx USDC cap for onramp BUYs (0 = none).
     * @param _dailyTxCountLimit Max onramp BUYs per user per day (0 = none).
     */
    constructor(
        address _diamond,
        address _usdc,
        uint256 _baseTxLimit,
        uint256 _dailyTxCountLimit
    ) {
        if (_diamond == address(0) || _usdc == address(0)) revert InvalidAddress();
        diamond = _diamond;
        usdc = IERC20(_usdc);
        owner = msg.sender;
        baseTxLimit = _baseTxLimit;
        dailyTxCountLimit = _dailyTxCountLimit;
        offrampEnabled = true;
        proxyImpl = address(new UserProxy());
    }

    // ─── Admin ────────────────────────────────────────────────────────

    function setBaseTxLimit(uint256 limit) external onlyOwner {
        baseTxLimit = limit;
        emit BaseTxLimitUpdated(limit);
    }

    function setDailyTxCountLimit(uint256 count) external onlyOwner {
        dailyTxCountLimit = count;
        emit DailyTxCountLimitUpdated(count);
    }

    function setOfframpEnabled(bool flag) external onlyOwner {
        offrampEnabled = flag;
        emit OfframpEnabledUpdated(flag);
    }

    function setOfframpRelayer(address relayer) external onlyOwner {
        offrampRelayer = relayer;
        emit OfframpRelayerUpdated(relayer);
    }

    function setMaxUsdcPerOfframp(uint256 cap) external onlyOwner {
        maxUsdcPerOfframp = cap;
        emit MaxUsdcPerOfframpUpdated(cap);
    }

    /// @notice Escape hatch: move any stray USDC held by the integrator (e.g.
    ///         dust left by a partial refund) to `to`. Blackstripe holds no
    ///         pool in normal operation, so this only ever sweeps residue.
    function withdrawUsdc(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert InvalidAddress();
        usdc.safeTransfer(to, amount);
    }

    // ─── Views ────────────────────────────────────────────────────────

    /// @notice Predicts the deterministic proxy address for `user`. The proxy
    ///         may not be deployed yet — check `code.length` if needed.
    function proxyAddress(address user) public view returns (address) {
        return
            Clones.predictDeterministicAddressWithImmutableArgs(
                proxyImpl,
                _proxyArgs(user),
                _salt(user),
                address(this)
            );
    }

    /// @notice The integrator's own system proxy (owner = address(this)) used
    ///         as `order.user` for offramp SELL orders.
    function systemProxy() external view returns (address) {
        return _systemProxy();
    }

    function getRemainingDailyCount(address user) external view returns (uint256) {
        if (dailyTxCountLimit == 0) return type(uint256).max;
        uint256 count = userDailyCount[user][block.timestamp / 1 days];
        if (count >= dailyTxCountLimit) return 0;
        return dailyTxCountLimit - count;
    }

    function getSession(uint256 orderId) external view returns (Session memory) {
        return sessions[orderId];
    }

    function getOfframp(uint256 orderId) external view returns (OfframpRecord memory) {
        return offramps[orderId];
    }

    // ─── User-facing onramp (fiat -> USDC to the user's EOA) ───────────

    /**
     * @notice Place an onramp BUY order. On completion the Diamond sends
     *         `amount` USDC to the caller's own EOA. No liveness / KYC — any
     *         user may buy, bounded by `baseTxLimit` and `dailyTxCountLimit`.
     * @param amount   USDC to receive (micro-USDC, 6dp).
     * @param currency Fiat currency the user pays in (e.g. bytes32("INR")).
     */
    function userBuyUsdc(
        uint256 amount,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) external returns (uint256 orderId) {
        if (amount == 0) revert InvalidAmount();

        // Friendly pre-checks (validateOrder re-enforces authoritatively when
        // the Diamond calls back, and reserves the daily-count slot there).
        if (baseTxLimit != 0 && amount > baseTxLimit) revert TxLimitExceeded();
        if (
            dailyTxCountLimit != 0 &&
            userDailyCount[msg.sender][block.timestamp / 1 days] + 1 > dailyTxCountLimit
        ) revert DailyCountExceeded();

        orderId = _placeBuyOrder(
            amount,
            currency,
            circleId,
            pubKey,
            preferredPaymentChannelConfigId,
            fiatAmountLimit
        );

        sessions[orderId] = Session({
            user: msg.sender,
            fulfilled: false,
            cancelled: false,
            placementDay: uint32(block.timestamp / 1 days),
            amount: amount
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
        // Proxy-as-placer: the B2B gateway is proxy-only. The user's UserProxy
        // is the msg.sender that calls placeB2BOrder; the gateway resolves it
        // back to this integrator via CREATE2.
        //
        // recipientAddr = msg.sender (the user's EOA): with
        // usdcThroughIntegrator = false the Diamond transfers the purchased
        // USDC straight to the user on completion. The proxy is only the
        // authenticated caller and never receives USDC.
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
     * @notice The Diamond's synchronous gate during placeB2BOrder /
     *         placeB2BSellOrder. For BUY: enforce per-tx and daily-count
     *         limits (reserving the count slot). For the offramp SELL self-
     *         call (user == system proxy) allow unconditionally — offramp
     *         caps are enforced in userInitiateOfframp.
     */
    function validateOrder(
        address user,
        uint256 amount,
        bytes32 /* currency */
    ) external onlyDiamond returns (bool allowed) {
        // SELL self-call: offramps are placed with user = system proxy.
        if (user == _systemProxy()) return true;

        // BUY: simple limits, no liveness/KYC.
        if (baseTxLimit != 0 && amount > baseTxLimit) return false;

        if (dailyTxCountLimit != 0) {
            uint256 dayIndex = block.timestamp / 1 days;
            uint256 count = userDailyCount[user][dayIndex];
            if (count + 1 > dailyTxCountLimit) return false;
            userDailyCount[user][dayIndex] = count + 1;
        }
        return true;
    }

    /**
     * @notice BUY completion hook. USDC has already been delivered to the
     *         user's EOA by the Diamond, so this only finalizes bookkeeping.
     *         (SELL orders get no completion callback.)
     */
    function onOrderComplete(
        uint256 orderId,
        address /* user */,
        uint256 /* amount */,
        address /* recipientAddr */
    ) external onlyDiamond {
        Session storage session = sessions[orderId];
        if (session.user == address(0)) return; // unknown / non-BUY order — no-op
        if (session.fulfilled) revert OrderAlreadyFulfilled();
        session.fulfilled = true;
        emit OnrampOrderFulfilled(orderId, session.user, session.amount);
    }

    /**
     * @notice BUY cancellation hook — releases the daily-count slot reserved in
     *         validateOrder, keyed on the placement-day snapshot. Tolerates
     *         unknown / already-finalized / SELL orders (best-effort).
     */
    function onOrderCancel(uint256 orderId) external onlyDiamond {
        Session storage session = sessions[orderId];
        if (session.user == address(0)) return;
        if (session.fulfilled) revert OrderAlreadyFulfilled();
        if (session.cancelled) revert OrderAlreadyCancelled();
        session.cancelled = true;

        if (dailyTxCountLimit != 0) {
            uint256 day = uint256(session.placementDay);
            uint256 count = userDailyCount[session.user][day];
            if (count > 0) {
                userDailyCount[session.user][day] = count - 1;
            }
        }
    }

    // ─── User-facing offramp (USDC from the user's wallet -> fiat) ─────

    /**
     * @notice Place a SELL order and register it to be funded from the
     *         caller's own USDC. The caller must have approved this integrator
     *         for at least `principal + fee` USDC BEFORE calling
     *         `deliverOfframpUpi` (the widget's placeCashout does this). No USDC
     *         moves here — it is pulled just-in-time at UPI delivery.
     * @param amount  USDC principal to sell (micro-USDC, 6dp). The fee is added
     *                on top and pulled from the same wallet at delivery.
     */
    function userInitiateOfframp(
        uint256 amount,
        bytes32 currency,
        uint256 fiatAmount,
        uint256 circleId,
        uint256 preferredPaymentChannelConfigId,
        string calldata userPubKey
    ) external returns (uint256 orderId) {
        if (!offrampEnabled) revert OfframpDisabled();
        if (amount == 0) revert InvalidAmount();
        if (maxUsdcPerOfframp != 0 && amount > maxUsdcPerOfframp) revert OfframpAmountTooLarge();
        // Friendly guard: the seller must have approved at least the principal.
        // (Full principal+fee is enforced by the transferFrom at delivery.)
        if (usdc.allowance(msg.sender, address(this)) < amount) {
            revert OfframpInsufficientAllowance();
        }

        orderId = _placeSellOrder(
            amount,
            currency,
            fiatAmount,
            circleId,
            preferredPaymentChannelConfigId,
            userPubKey
        );

        offramps[orderId] = OfframpRecord({
            user: msg.sender,
            usdcAmount: amount,
            lastStatus: 0,
            initialized: true
        });
        orderInitiator[orderId] = msg.sender;

        emit OfframpInitiated(orderId, msg.sender, amount);
    }

    function _placeSellOrder(
        uint256 amount,
        bytes32 currency,
        uint256 fiatAmount,
        uint256 circleId,
        uint256 preferredPaymentChannelConfigId,
        string memory userPubKey
    ) internal returns (uint256 orderId) {
        // Place via the system proxy (owner = address(this)); order.user =
        // system proxy. The Diamond pulls USDC from order.user during
        // setSellOrderUpi, so we fund the proxy from the seller's wallet at
        // deliverOfframpUpi-time (just-in-time). On cancel, refunds land on the
        // proxy and reconcile returns them to the seller.
        address sysProxy = _ensureProxy(address(this));
        bytes memory data = abi.encodeCall(
            IB2BGateway.placeB2BSellOrder,
            (
                sysProxy,
                amount,
                currency,
                userPubKey,
                circleId,
                preferredPaymentChannelConfigId,
                fiatAmount
            )
        );
        bytes memory result = UserProxy(sysProxy).execute(diamond, data, address(usdc), 0);
        return abi.decode(result, (uint256));
    }

    /**
     * @notice Forward an encrypted UPI payload to the Diamond, funding the
     *         order from the seller's wallet. Reads the authoritative
     *         `actualUsdtAmount` (principal + fee) from the Diamond, pulls
     *         exactly that from the seller via `transferFrom` into the system
     *         proxy, then calls setSellOrderUpi (which makes the Diamond pull
     *         it from the proxy). Callable by the initiator or the relayer.
     */
    function deliverOfframpUpi(uint256 orderId, string calldata encUpi) external {
        OfframpRecord memory r = offramps[orderId];
        if (!r.initialized) revert OfframpRecordNotFound();
        if (msg.sender != orderInitiator[orderId] && msg.sender != offrampRelayer) {
            revert OfframpNotAuthorized();
        }

        // Diamond's setSellOrderUpi pulls actualUsdtAmount (= principal + fee)
        // from order.user via transferFrom. Read the authoritative amount and
        // pull exactly that from the seller's wallet into the system proxy.
        IOrderFlow.AdditionalOrderDetailsView memory aod = IOrderFlow(diamond)
            .getAdditionalOrderDetails(orderId);
        uint256 needed = aod.actualUsdtAmount;
        if (needed == 0) needed = r.usdcAmount;

        address sysProxy = _ensureProxy(address(this));
        // Pull from the SELLER's own wallet (not a pool). Requires the seller
        // to have approved this integrator for >= needed.
        usdc.safeTransferFrom(r.user, sysProxy, needed);

        bytes memory data = abi.encodeCall(IOrderFlow.setSellOrderUpi, (orderId, encUpi, 0));
        UserProxy(sysProxy).execute(diamond, data, address(usdc), needed);

        emit OfframpUpiDelivered(orderId, needed);
    }

    /**
     * @notice Read the authoritative order status from the Diamond and record
     *         it. On CANCELLED, any USDC that was refunded to the system proxy
     *         is pulled back and returned to the seller's wallet. Anyone can
     *         poke; the status is read from the Diamond (not caller-supplied),
     *         so a wrong value can't grief the record or the refund.
     */
    function reconcile(uint256 orderId) external {
        OfframpRecord storage r = offramps[orderId];
        if (!r.initialized) revert OfframpRecordNotFound();
        if (r.lastStatus == 3 || r.lastStatus == 4) revert OfframpAlreadyReconciled();

        uint8 currentStatus = IOrderFlow(diamond).getOrdersById(orderId).status;

        if (currentStatus == 4 /* CANCELLED */) {
            // Cancel-while-PAID refunds USDC to order.user = system proxy.
            // Pull it off the proxy (USDC sweep is blocked, but the integrator-
            // only transferERC20ToIntegrator is permitted) and return it to the
            // seller who funded the order.
            address sysProxy = _ensureProxy(address(this));
            uint256 bal = usdc.balanceOf(sysProxy);
            if (bal > 0) {
                UserProxy(sysProxy).transferERC20ToIntegrator(address(usdc), bal);
                usdc.safeTransfer(r.user, bal);
                emit OfframpRefunded(orderId, r.user, bal);
            }
        }
        r.lastStatus = currentStatus;
        emit OfframpReconciled(orderId, currentStatus);
    }

    // ─── Internals: proxy ─────────────────────────────────────────────

    function _systemProxy() internal view returns (address) {
        return proxyAddress(address(this));
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
            // Sanity: predicted == deployed. If this ever fails, the immutable
            // args or salt have drifted.
            assert(deployed == proxy);
            emit UserProxyDeployed(user, proxy);
        }
    }
}
