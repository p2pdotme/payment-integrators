// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { IOrderFlow } from "../../interfaces/IOrderFlow.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title RemitamIntegrator
 * @notice P2P.me B2B integrator for the Remitam remittance app. Backend-
 *         controlled server wallets (thirdweb) are whitelisted by the owner
 *         and place BUY legs (fiat -> USDC delivered to the server wallet;
 *         registered with usdcThroughIntegrator = false) and concurrent SELL
 *         legs (USDC -> fiat paid to the remittance recipient). Large
 *         remittances are split off-chain into multiple legs; this contract
 *         supports several in-flight SELL legs per wallet (bounded).
 *
 *         As a whitelisted integrator we bypass the protocol's RP/daily/
 *         monthly/yearly limits and enforce our own per-tx and daily limits
 *         here, owner-adjustable only up to immutable ceilings.
 */
contract RemitamIntegrator is IP2PIntegrator, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Errors ───────────────────────────────────────────────────────
    error OnlyDiamond();
    error OnlyOwner();
    error InvalidAddress();
    error NotWhitelisted();
    error LimitAboveCeiling();
    error TxLimitExceeded();
    error DailyVolumeExceeded();
    error DailyCountExceeded();
    error TooManyActiveSells();
    error SellLegNotFound();
    error NotAuthorized();
    error FeeNotReady();
    error ProxyUnderfunded();
    error AlreadyReconciled();
    error NotTerminal();

    // ─── Events ───────────────────────────────────────────────────────
    event AccountAdded(address indexed account);
    event AccountRemoved(address indexed account);
    event LimitsUpdated(uint256 txLimit, uint256 dailyVolumeLimit, uint256 dailyCountLimit);
    event UserProxyDeployed(address indexed user, address proxy);
    event BuyPlaced(
        uint256 indexed orderId,
        address indexed wallet,
        uint256 amount,
        bytes32 currency
    );
    event SellPlaced(
        uint256 indexed orderId,
        address indexed wallet,
        uint256 principal,
        bytes32 currency
    );
    event LegCompleted(uint256 indexed orderId, address indexed wallet, uint256 amount);
    event LegCancelled(uint256 indexed orderId, address indexed wallet);
    event PayoutDelivered(uint256 indexed orderId, uint8 statusAfter);
    event SellReconciled(uint256 indexed orderId, uint8 status, uint256 swept);

    // ─── Immutables ───────────────────────────────────────────────────
    address public immutable diamond;
    /// @notice Public getter required: UserProxy.sweepERC20 blocks USDC via
    ///         IUsdcSource(integrator()).usdc().
    IERC20 public immutable usdc;
    address public immutable owner;
    /// @notice Pinned at deploy; submitted with the whitelist request.
    address public immutable proxyImpl;

    /// @notice Immutable ceilings — the owner can move limits below these,
    ///         never above. Reviewed at whitelisting time.
    uint256 public immutable txLimitCeiling;
    uint256 public immutable dailyVolumeCeiling;
    uint256 public immutable dailyCountCeiling;

    // ─── Adjustable limits ────────────────────────────────────────────
    uint256 public txLimit;
    uint256 public dailyVolumeLimit;
    uint256 public dailyCountLimit;

    // ─── Whitelist ────────────────────────────────────────────────────
    mapping(address => bool) public whitelisted;
    /// @notice proxy => whitelisted wallet that owns it. Lets validateOrder
    ///         recognize a SELL placed with order.user = the wallet's proxy.
    mapping(address => address) public proxyOwner;

    // ─── Daily accounting (wallet => day => consumed) ─────────────────
    mapping(address => mapping(uint256 => uint256)) public dailyVolume;
    mapping(address => mapping(uint256 => uint256)) public dailyCount;

    // ─── Buy sessions (orderId => BuySession) ──────────────────────────
    struct BuySession {
        address user; // whitelisted server wallet
        uint256 amount; // USDC 1e6
        uint256 day; // day the validateOrder debit landed on
        bool active;
    }
    mapping(uint256 => BuySession) public buySessions;

    // ─── Sell legs ─────────────────────────────────────────────────────
    /// @notice Bounded fan-out per wallet: several concurrent SELL legs are the
    ///         mechanism for splitting one remittance across merchants, but an
    ///         unbounded count would let accounting arrays/gas grow unchecked.
    uint256 public constant MAX_CONCURRENT_SELLS = 8;

    struct SellLeg {
        address user; // whitelisted server wallet
        uint256 principal; // USDC 1e6 (fee excluded; fee read at deliver time)
        uint256 day; // day of the validateOrder debit
        uint8 lastStatus; // Diamond status recorded by reconcile
        bool initialized;
        bool settled; // terminal status reached and accounted
    }
    mapping(uint256 => SellLeg) public sellLegs;
    mapping(address => uint256) public activeSellCount;

    // ─── Modifiers ────────────────────────────────────────────────────
    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyDiamond() {
        if (msg.sender != diamond) revert OnlyDiamond();
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────
    constructor(
        address _diamond,
        address _usdc,
        uint256 _txLimitCeiling,
        uint256 _dailyVolumeCeiling,
        uint256 _dailyCountCeiling
    ) {
        if (_diamond == address(0) || _usdc == address(0)) revert InvalidAddress();
        diamond = _diamond;
        usdc = IERC20(_usdc);
        owner = msg.sender;
        proxyImpl = address(new UserProxy());

        txLimitCeiling = _txLimitCeiling;
        dailyVolumeCeiling = _dailyVolumeCeiling;
        dailyCountCeiling = _dailyCountCeiling;
        txLimit = _txLimitCeiling;
        dailyVolumeLimit = _dailyVolumeCeiling;
        dailyCountLimit = _dailyCountCeiling;
    }

    // ─── Whitelist admin ──────────────────────────────────────────────

    function addAccount(address account) external onlyOwner {
        if (account == address(0)) revert InvalidAddress();
        whitelisted[account] = true;
        emit AccountAdded(account);
    }

    function removeAccount(address account) external onlyOwner {
        whitelisted[account] = false;
        emit AccountRemoved(account);
    }

    // ─── Limits admin ─────────────────────────────────────────────────

    function setLimits(
        uint256 txLimit_,
        uint256 dailyVolumeLimit_,
        uint256 dailyCountLimit_
    ) external onlyOwner {
        if (
            txLimit_ > txLimitCeiling ||
            dailyVolumeLimit_ > dailyVolumeCeiling ||
            dailyCountLimit_ > dailyCountCeiling
        ) revert LimitAboveCeiling();
        txLimit = txLimit_;
        dailyVolumeLimit = dailyVolumeLimit_;
        dailyCountLimit = dailyCountLimit_;
        emit LimitsUpdated(txLimit_, dailyVolumeLimit_, dailyCountLimit_);
    }

    // ─── Buy leg ──────────────────────────────────────────────────────

    /// @notice Place a BUY leg (fiat -> USDC). The Diamond assigns merchants;
    ///         at completion USDC is transferred straight to msg.sender
    ///         (recipientAddr; we register usdcThroughIntegrator = false).
    function userPlaceBuyOrder(
        uint256 amount,
        bytes32 currency,
        string calldata pubKey,
        uint256 circleId,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) external nonReentrant returns (uint256 orderId) {
        if (!whitelisted[msg.sender]) revert NotWhitelisted();
        address proxy = _ensureProxy(msg.sender);

        bytes memory placeData = abi.encodeCall(
            IB2BGateway.placeB2BOrder,
            (
                msg.sender,
                amount,
                currency,
                msg.sender, // recipientAddr = the user's server wallet
                pubKey,
                circleId,
                preferredPaymentChannelConfigId,
                fiatAmountLimit
            )
        );
        // usdcAllowance = 0: the Diamond pulls nothing at BUY placement.
        bytes memory result = UserProxy(proxy).execute(diamond, placeData, address(usdc), 0);
        orderId = abi.decode(result, (uint256));

        // validateOrder already ran (synchronously, inside placeB2BOrder) and
        // debited today's buckets; snapshot the day so a late cancel releases
        // the right bucket.
        buySessions[orderId] = BuySession({
            user: msg.sender,
            amount: amount,
            day: _day(),
            active: true
        });
        emit BuyPlaced(orderId, msg.sender, amount, currency);
    }

    // ─── Sell leg ──────────────────────────────────────────────────────

    /// @notice Phase 1 of a SELL leg: place the order so the Diamond matches a
    ///         merchant. No USDC moves yet — funding happens at deliverPayout.
    ///         order.user is the wallet's UserProxy: the Diamond pulls USDC
    ///         from order.user during setSellOrderUpi, and on cancellation the
    ///         refund lands back on the proxy where reconcile can recover it.
    function userStartSell(
        uint256 principal,
        bytes32 currency,
        string calldata userPubKey,
        uint256 circleId,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) external nonReentrant returns (uint256 orderId) {
        if (!whitelisted[msg.sender]) revert NotWhitelisted();
        if (activeSellCount[msg.sender] >= MAX_CONCURRENT_SELLS) revert TooManyActiveSells();
        address proxy = _ensureProxy(msg.sender);

        bytes memory placeData = abi.encodeCall(
            IB2BGateway.placeB2BSellOrder,
            (
                proxy,
                principal,
                currency,
                userPubKey,
                circleId,
                preferredPaymentChannelConfigId,
                fiatAmountLimit
            )
        );
        bytes memory result = UserProxy(proxy).execute(diamond, placeData, address(usdc), 0);
        orderId = abi.decode(result, (uint256));

        sellLegs[orderId] = SellLeg({
            user: msg.sender,
            principal: principal,
            day: _day(),
            lastStatus: 0,
            initialized: true,
            settled: false
        });
        activeSellCount[msg.sender] += 1;
        emit SellPlaced(orderId, msg.sender, principal, currency);
    }

    /// @notice Phase 2 of a SELL leg: deliver the ECIES-encrypted payout
    ///         handle (CBU/PIX/Nequi... encrypted to the merchant's pubkey,
    ///         never plaintext, never in events) and trigger the Diamond's
    ///         USDC pull. The wallet must have funded its proxy with
    ///         principal + fee beforehand (plain ERC-20 transfer).
    /// @dev    The live Diamond wraps its pull in try/catch and AUTO-CANCELS
    ///         on failure instead of reverting, so success here is not proof
    ///         of delivery — we read the status back and emit it for the
    ///         keeper.
    function deliverPayout(uint256 orderId, string calldata encPayout) external nonReentrant {
        SellLeg storage leg = sellLegs[orderId];
        if (!leg.initialized) revert SellLegNotFound();
        if (msg.sender != leg.user && msg.sender != owner) revert NotAuthorized();

        // actualUsdtAmount = principal + fee. Zero means the Diamond has not
        // computed the fee yet — funding principal-only would make the pull
        // fail and silently cancel the order, so refuse and let the keeper
        // retry.
        uint256 needed = IOrderFlow(diamond).getAdditionalOrderDetails(orderId).actualUsdtAmount;
        if (needed == 0) revert FeeNotReady();

        address proxy = proxyAddress(leg.user);
        if (usdc.balanceOf(proxy) < needed) revert ProxyUnderfunded();

        bytes memory data = abi.encodeCall(IOrderFlow.setSellOrderUpi, (orderId, encPayout, 0));
        UserProxy(proxy).execute(diamond, data, address(usdc), needed);

        uint8 statusAfter = IOrderFlow(diamond).getOrdersById(orderId).status;
        emit PayoutDelivered(orderId, statusAfter);
    }

    /// @notice Permissionless settlement of a SELL leg. Reads the
    ///         authoritative status from the Diamond (never caller-supplied —
    ///         trusting a caller status is a griefing surface). On a terminal
    ///         status it frees the wallet's concurrency slot and sweeps any
    ///         USDC sitting on the proxy (a cancellation refund, or Diamond
    ///         under-pull dust) back to the wallet. On CANCELLED it also
    ///         releases the validateOrder daily debit.
    /// @dev    All of a wallet's legs share one proxy, so the sweep can pick
    ///         up funding parked for a sibling leg. Not a loss (funds return
    ///         to the same wallet), but the backend must fund-and-deliver one
    ///         leg at a time and reconcile cancelled legs before funding the
    ///         next.
    function reconcile(uint256 orderId) external nonReentrant {
        SellLeg storage leg = sellLegs[orderId];
        if (!leg.initialized) revert SellLegNotFound();
        if (leg.settled) revert AlreadyReconciled();

        uint8 status = IOrderFlow(diamond).getOrdersById(orderId).status;
        if (status != 3 && status != 4) revert NotTerminal();

        leg.settled = true;
        leg.lastStatus = status;
        if (activeSellCount[leg.user] > 0) activeSellCount[leg.user] -= 1;

        if (status == 4) {
            // The leg never consumed merchant capacity — free the daily budget.
            _releaseDebit(leg.user, leg.day, leg.principal);
        }

        // Recover whatever USDC sits on the proxy. sweepERC20 blocks USDC by
        // design; transferERC20ToIntegrator is the integrator-only primitive.
        address proxy = proxyAddress(leg.user);
        uint256 swept = usdc.balanceOf(proxy);
        if (swept > 0) {
            UserProxy(proxy).transferERC20ToIntegrator(address(usdc), swept);
            usdc.safeTransfer(leg.user, swept);
        }

        emit SellReconciled(orderId, status, swept);
    }

    // ─── Helpers ──────────────────────────────────────────────────────

    function _day() internal view returns (uint256) {
        return block.timestamp / 1 days;
    }

    /// @dev Resolves the accountable wallet: `user` directly (BUY legs place
    ///      with order.user = server wallet) or the owner of the proxy (SELL
    ///      legs place with order.user = the wallet's UserProxy).
    function _resolveWallet(address user) internal view returns (address wallet) {
        if (whitelisted[user]) return user;
        wallet = proxyOwner[user];
        if (wallet == address(0) || !whitelisted[wallet]) revert NotWhitelisted();
    }

    // ─── IP2PIntegrator (filled in over Tasks 3-4) ────────────────────

    function validateOrder(
        address user,
        uint256 amount,
        bytes32 /*currency*/
    ) external onlyDiamond returns (bool allowed) {
        address wallet = _resolveWallet(user);
        if (amount > txLimit) revert TxLimitExceeded();

        uint256 day = _day();
        uint256 newVolume = dailyVolume[wallet][day] + amount;
        if (newVolume > dailyVolumeLimit) revert DailyVolumeExceeded();
        uint256 newCount = dailyCount[wallet][day] + 1;
        if (newCount > dailyCountLimit) revert DailyCountExceeded();

        dailyVolume[wallet][day] = newVolume;
        dailyCount[wallet][day] = newCount;
        return true;
    }

    /// @dev Floor-guarded reversal of a validateOrder debit — used on
    ///      cancellation so a cancelled leg frees the wallet's daily budget.
    function _releaseDebit(address wallet, uint256 day, uint256 amount) internal {
        uint256 vol = dailyVolume[wallet][day];
        dailyVolume[wallet][day] = vol > amount ? vol - amount : 0;
        uint256 cnt = dailyCount[wallet][day];
        if (cnt > 0) dailyCount[wallet][day] = cnt - 1;
    }

    /// @notice Diamond callback on BUY settlement. USDC was already routed to
    ///         recipientAddr by the protocol; we only close our session.
    ///         Tolerates unknown orderIds (SELL completions are observed via
    ///         reconcile, not this callback).
    function onOrderComplete(
        uint256 orderId,
        address /*user*/,
        uint256 /*amount*/,
        address /*recipientAddr*/
    ) external onlyDiamond {
        BuySession storage s = buySessions[orderId];
        if (!s.active) return;
        s.active = false;
        emit LegCompleted(orderId, s.user, s.amount);
    }

    /// @notice Diamond callback on B2B BUY cancellation. Releases the daily
    ///         debit consumed at validateOrder time. Best-effort: tolerates
    ///         unknown / already-cancelled orderIds and never reverts.
    function onOrderCancel(uint256 orderId) external onlyDiamond {
        BuySession storage s = buySessions[orderId];
        if (!s.active) return;
        s.active = false;
        _releaseDebit(s.user, s.day, s.amount);
        emit LegCancelled(orderId, s.user);
    }

    // ─── Proxy helpers (mirror contracts/templates/MyIntegrator.sol) ──

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

    /// @dev Immutable args layout [owner(20)][integrator(20)] — fixed by the
    ///      Diamond's CREATE2-auth derivation. DO NOT change.
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
            proxyOwner[proxy] = user;
            emit UserProxyDeployed(user, proxy);
        }
    }
}
