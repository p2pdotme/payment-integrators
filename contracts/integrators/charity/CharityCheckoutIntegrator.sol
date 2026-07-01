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
 *         No limits: `validateOrder` accepts any non-zero amount from any user.
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

    // ─── State ────────────────────────────────────────────────────────

    /// @notice Destination for every donation's purchased USDC. Owner-updatable.
    address public charityWallet;

    /// @notice Cumulative USDC delivered to charity across all settled donations.
    uint256 public totalDonated;
    /// @notice Cumulative USDC a given user has successfully donated.
    mapping(address => uint256) public donatedBy;

    struct Session {
        address user; // 20 bytes
        bool fulfilled; //  1 byte — packs with user
        bool cancelled; //  1 byte — packs with user
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

    // ─── User-facing donation ─────────────────────────────────────────

    /**
     * @notice Place a donation BUY order. The caller pays local fiat off-chain;
     *         on settlement the Diamond delivers `amount` USDC straight to the
     *         current `charityWallet`. No limits.
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
     * @notice The Diamond's synchronous gate during placeB2BOrder. Charity has
     *         no limits — accept any non-zero amount from any user.
     */
    function validateOrder(
        address /* user */,
        uint256 amount,
        bytes32 /* currency */
    ) external view onlyDiamond returns (bool allowed) {
        return amount > 0;
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
     * @notice Cancellation hook. Charity consumes no per-user accounting in
     *         validateOrder, so there is nothing to release — just record the
     *         terminal state. Tolerates unknown / already-finalized orders.
     */
    function onOrderCancel(uint256 orderId) external onlyDiamond {
        Session storage session = sessions[orderId];
        if (session.user == address(0)) return;
        if (session.fulfilled) revert OrderAlreadyFulfilled();
        if (session.cancelled) revert OrderAlreadyCancelled();
        session.cancelled = true;
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
