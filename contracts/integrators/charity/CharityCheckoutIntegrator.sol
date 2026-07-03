// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

/**
 * @title CharityCheckoutIntegrator
 * @notice Donation onramp integrator: users pay local fiat (UPI, PIX, …) and
 *         the purchased USDC is delivered DIRECTLY to a single charity wallet.
 *         The end-user never receives USDC — every order is a donation, so the
 *         fiat -> USDC -> user-wallet path that `UserProxy` normally traps is
 *         not reopened, and no KYC / per-tx limit gate is needed.
 *
 *         Mechanics (mirrors `UsdcDirectCheckoutIntegrator`, minus the KYC/limit
 *         machinery): each order is placed with `recipientAddr = charityWallet`.
 *         The integrator is registered on the Diamond with
 *         `usdcThroughIntegrator = false`, so `B2BGatewayFacet.onB2BOrderComplete`
 *         transfers the purchased USDC straight to `charityWallet` on completion.
 *         The per-user `UserProxy` is used only as the authenticated *caller* of
 *         `placeB2BOrder` (the B2B gateway is proxy-only); it never holds USDC.
 *
 *         No amount cap, but each wallet is limited to `MAX_ORDERS_PER_DAY`
 *         donation orders per UTC day (`validateOrder` reserves the slot;
 *         `onOrderCancel` releases it so a cancelled order doesn't burn the day).
 *
 * @dev    The `charityWallet` is owner-updatable (emits `CharityWalletUpdated`).
 *         Updating it only affects orders placed AFTER the change — each order's
 *         `recipientAddr` is pinned at placement time. `usdc()` is exposed as a
 *         public getter because the canonical `UserProxy.sweepERC20` resolves the
 *         non-sweepable token via `IUsdcSource(integrator()).usdc()`.
 */
contract CharityCheckoutIntegrator is IP2PIntegrator {
    using Clones for address;

    // ─── Errors ───────────────────────────────────────────────────────

    error OnlyDiamond();
    error OnlyOwner();
    error InvalidAddress();
    error InvalidAmount();
    error OrderAlreadyFulfilled();
    error OrderAlreadyCancelled();
    error DailyLimitReached();

    // ─── Events ───────────────────────────────────────────────────────

    event CharityWalletUpdated(address indexed previous, address indexed current);
    event UserProxyDeployed(address indexed user, address proxy);

    /// @notice Emitted when a user places a donation order.
    event DonationCreated(
        uint256 indexed orderId,
        address indexed user,
        uint256 amount,
        bytes32 currency,
        address charityWallet
    );

    /// @notice Emitted when a donation order settles — USDC has already been
    ///         delivered to `charityWallet` by the Diamond at this point.
    event Donated(
        uint256 indexed orderId,
        address indexed user,
        uint256 amount,
        address indexed charityWallet
    );

    // ─── Immutables ───────────────────────────────────────────────────

    address public immutable diamond;
    /// @notice Exposed so the canonical UserProxy can resolve the token to
    ///         block from user-initiated sweeps (`IUsdcSource.usdc()`).
    IERC20 public immutable usdc;
    address public immutable owner;
    /// @notice The UserProxy implementation all per-user clones point to. Pinned
    ///         on the Diamond at `registerIntegrator` time.
    address public immutable proxyImpl;

    // ─── Constants ────────────────────────────────────────────────────

    /// @notice Hard cap on the number of donation orders a single wallet may
    ///         place per UTC day. A cancelled order releases its slot (see
    ///         `onOrderCancel`), so this bounds *open + settled* orders per day.
    uint256 public constant MAX_ORDERS_PER_DAY = 1;

    // ─── State ────────────────────────────────────────────────────────

    /// @notice Destination for every donation's purchased USDC. Owner-updatable.
    address public charityWallet;

    /// @notice Cumulative USDC delivered to charity across all settled donations.
    uint256 public totalDonated;
    /// @notice Cumulative USDC a given user has successfully donated.
    mapping(address => uint256) public donatedBy;

    /// @notice Orders placed per user per day-index (`block.timestamp / 1 days`).
    ///         Incremented in `validateOrder`, decremented in `onOrderCancel`.
    mapping(address => mapping(uint256 => uint256)) public userDailyCount;

    struct Session {
        address user; // 20 bytes
        bool fulfilled; //  1 byte  — packs with user
        bool cancelled; //  1 byte  — packs with user
        uint32 placementDay; //  4 bytes — pinned for onOrderCancel decrement keying
        uint256 amount;
    }

    mapping(uint256 => Session) public sessions;

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
     * @param _diamond       P2P Diamond (B2B gateway) address.
     * @param _usdc          USDC token address.
     * @param _charityWallet Initial destination for all donated USDC.
     */
    constructor(address _diamond, address _usdc, address _charityWallet) {
        if (_diamond == address(0) || _usdc == address(0) || _charityWallet == address(0))
            revert InvalidAddress();
        diamond = _diamond;
        usdc = IERC20(_usdc);
        owner = msg.sender;
        charityWallet = _charityWallet;
        proxyImpl = address(new UserProxy());
        emit CharityWalletUpdated(address(0), _charityWallet);
    }

    // ─── Admin ────────────────────────────────────────────────────────

    /// @notice Update the charity destination. Only affects orders placed after
    ///         this call — each order's recipient is pinned at placement time.
    function setCharityWallet(address newCharityWallet) external onlyOwner {
        if (newCharityWallet == address(0)) revert InvalidAddress();
        address previous = charityWallet;
        charityWallet = newCharityWallet;
        emit CharityWalletUpdated(previous, newCharityWallet);
    }

    // ─── Views ────────────────────────────────────────────────────────

    /// @notice Predicts the deterministic proxy address for `user` (may not be
    ///         deployed yet — check `code.length` if needed).
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

    /// @notice How many more donation orders `user` may place today (UTC).
    function getRemainingDailyOrders(address user) external view returns (uint256) {
        uint256 count = userDailyCount[user][block.timestamp / 1 days];
        return count >= MAX_ORDERS_PER_DAY ? 0 : MAX_ORDERS_PER_DAY - count;
    }

    // ─── User-facing donation ─────────────────────────────────────────

    /**
     * @notice Place a donation BUY order. The caller pays local fiat off-chain;
     *         on settlement the Diamond delivers `amount` USDC straight to the
     *         current `charityWallet`. No amount cap, but limited to
     *         `MAX_ORDERS_PER_DAY` orders per wallet per UTC day.
     * @param amount   USDC to donate (micro-USDC, 6dp).
     * @param currency Fiat currency the user pays in (e.g. bytes32("BRL")).
     */
    function donate(
        uint256 amount,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) external returns (uint256 orderId) {
        if (amount == 0) revert InvalidAmount();

        // Friendly pre-check — validateOrder re-enforces this authoritatively
        // (and reserves the slot) when the Diamond calls back during placement.
        if (userDailyCount[msg.sender][block.timestamp / 1 days] >= MAX_ORDERS_PER_DAY)
            revert DailyLimitReached();

        address charity = charityWallet;
        orderId = _placeOrder(
            amount,
            currency,
            charity,
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

        emit DonationCreated(orderId, msg.sender, amount, currency, charity);
    }

    function _placeOrder(
        uint256 amount,
        bytes32 currency,
        address recipient,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) internal returns (uint256) {
        // Proxy-as-placer: the B2B gateway is proxy-only (rejects direct
        // integrator calls). The user's UserProxy is the msg.sender that calls
        // placeB2BOrder; the gateway resolves it to this integrator via CREATE2.
        //
        // recipientAddr = charityWallet: with usdcThroughIntegrator = false the
        // Diamond transfers the purchased USDC straight to the charity on
        // completion. The proxy is only the authenticated caller and never
        // receives USDC (usdcAllowance = 0 — the Diamond pulls nothing here).
        address proxy = _ensureProxy(msg.sender);
        bytes memory data = abi.encodeCall(
            IB2BGateway.placeB2BOrder,
            (
                msg.sender,
                amount,
                currency,
                recipient,
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
     * @notice The Diamond's synchronous gate during placeB2BOrder. Enforces the
     *         per-wallet daily order cap authoritatively and reserves the slot on
     *         success (released in `onOrderCancel`). No amount cap.
     */
    function validateOrder(
        address user,
        uint256 amount,
        bytes32 /* currency */
    ) external onlyDiamond returns (bool allowed) {
        if (amount == 0) return false;

        uint256 day = block.timestamp / 1 days;
        uint256 count = userDailyCount[user][day];
        if (count >= MAX_ORDERS_PER_DAY) return false;

        userDailyCount[user][day] = count + 1;
        return true;
    }

    /**
     * @notice Completion hook. USDC has already been delivered to the charity
     *         wallet by the Diamond (recipientAddr = charityWallet,
     *         usdcThroughIntegrator = false), so this only finalizes bookkeeping.
     *         Best-effort from the gateway's POV (wrapped in try/catch there).
     */
    function onOrderComplete(
        uint256 orderId,
        address /* user */,
        uint256 amount,
        address /* recipientAddr */
    ) external onlyDiamond {
        Session storage session = sessions[orderId];
        if (session.user == address(0)) return; // unknown order — no-op
        if (session.fulfilled) revert OrderAlreadyFulfilled();
        session.fulfilled = true;

        totalDonated += amount;
        donatedBy[session.user] += amount;

        emit Donated(orderId, session.user, amount, charityWallet);
    }

    /**
     * @notice Cancellation hook. Releases the daily-order slot reserved in
     *         validateOrder, keyed on the placement-day snapshot so a day
     *         rollover between placement and cancellation can't corrupt another
     *         day's counter. Tolerates unknown / already-finalized orders.
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
    }

    // ─── Internals: proxy ─────────────────────────────────────────────

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
