// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title InvestablChallengeCheckoutIntegrator
 * @notice Goods/service integrator that lets an Investabl user pay local fiat
 *         (INR via UPI) to buy a prop-trading **challenge**. The "product" is a
 *         non-transferable challenge account granted off-chain in Investabl's
 *         backend — the user never receives spendable USDC, so this is the
 *         low-fraud goods model (not the USDC-to-user model that requires KYC).
 *
 *         Because the purchased asset is a non-liquid service, orders are gated
 *         only by an absolute per-tx USDC cap (`perTxUsdcCap`, default ≤ 50 USDC
 *         — P2P's no-KYC ceiling) plus a daily order-count limit. No reputation,
 *         no ZK-KYC: a brand-new wallet can buy immediately.
 *
 *         Flow:
 *           1. User's wallet calls `buyChallenge(...)` → places a B2B BUY order
 *              through their `UserProxy`, with `recipientAddr = this integrator`.
 *           2. User pays fiat off-chain (UPI) to the matched liquidity provider.
 *           3. On settlement the Diamond delivers the purchased USDC to this
 *              contract and calls `onOrderComplete`, which emits
 *              `ChallengePurchased`. Investabl's backend watches that event and
 *              grants the challenge (mapping `sessionRef` → the checkout session).
 *           4. Accrued USDC is swept to the treasury by the owner (`sweepUsdc`),
 *              then bridged to the Arbitrum treasury out of band.
 *
 *         Registration: `usdcThroughIntegrator = true`, `recipientAddr` is this
 *         contract (mirrors the canonical ExampleIntegrator goods pattern).
 *
 * @dev    Security invariants (see CONTRIBUTING.md):
 *           - `validateOrder` / `onOrderComplete` / `onOrderCancel` are
 *             `onlyDiamond` and authoritatively enforce the caps.
 *           - USDC is never routed to a user EOA. It accrues here and leaves
 *             only via the owner's `sweepUsdc` to `treasury`. All movements use
 *             SafeERC20.
 *           - The canonical un-forked `UserProxy` is used verbatim.
 *           - No upgradeability, no `delegatecall`, no `selfdestruct`.
 */
contract InvestablChallengeCheckoutIntegrator is IP2PIntegrator, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Errors ───────────────────────────────────────────────────────

    error OnlyDiamond();
    error OnlyOwner();
    error InvalidAddress();
    error InvalidAmount();
    error AmountExceedsCap();
    error DailyCountExceeded();
    error OrderAlreadyFulfilled();
    error OrderAlreadyCancelled();

    // ─── Events ───────────────────────────────────────────────────────

    event PerTxUsdcCapUpdated(uint256 cap);
    event DailyTxCountLimitUpdated(uint256 count);
    event TreasuryUpdated(address indexed treasury);
    /// @notice A challenge BUY order was placed on the Diamond.
    event ChallengeOrderCreated(
        uint256 indexed orderId,
        address indexed user,
        uint256 amount,
        bytes32 currency,
        bytes32 indexed sessionRef
    );
    /// @notice Fiat settled and USDC was delivered here. Investabl's backend
    ///         watches this to grant the challenge for `sessionRef` / `user`.
    event ChallengePurchased(
        uint256 indexed orderId,
        address indexed user,
        uint256 amount,
        bytes32 indexed sessionRef
    );
    event UsdcSwept(address indexed to, uint256 amount);
    event UserProxyDeployed(address indexed user, address proxy);
    /// @notice A placed order was cancelled (expiry / dispute / PAY-failure);
    ///         its reserved daily-count slot was released.
    event ChallengeOrderCancelled(uint256 indexed orderId, address indexed user);

    // ─── Immutables ───────────────────────────────────────────────────

    address public immutable diamond;
    /// @notice Exposed so the canonical UserProxy can resolve which token to
    ///         block from user-initiated sweep (`UserProxy.sweepERC20`).
    IERC20 public immutable usdc;
    address public immutable owner;
    /// @notice Pinned at deploy; submitted with the whitelist request.
    address public immutable proxyImpl;

    // ─── Configurable limits ──────────────────────────────────────────

    /// @notice Absolute per-tx USDC ceiling (micro-USDC, 6dp). No RP/KYC — this
    ///         cap alone gates every order. Keep ≤ 50 USDC (P2P no-KYC ceiling).
    uint256 public perTxUsdcCap;
    /// @notice Max challenge orders a single user can place per UTC day.
    uint256 public dailyTxCountLimit;
    /// @notice Destination for swept USDC proceeds. Defaults to `owner`.
    address public treasury;

    // ─── Order accounting ─────────────────────────────────────────────

    struct Session {
        address user; // 20 bytes
        bool fulfilled; //  1 byte  — packs with user
        bool cancelled; //  1 byte  — packs with user
        uint32 placementDay; //  4 bytes — pinned for onOrderCancel decrement keying
        uint256 amount;
        bytes32 sessionRef; // Investabl checkout-session id, echoed on completion
    }

    mapping(uint256 => Session) public sessions;
    mapping(address => mapping(uint256 => uint256)) public userDailyCount;

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
     * @param _usdc              USDC token address (native Circle USDC on Base).
     * @param _perTxUsdcCap      Absolute per-tx cap, micro-USDC (e.g. 50e6).
     * @param _dailyTxCountLimit Max challenge orders per user per day.
     */
    constructor(
        address _diamond,
        address _usdc,
        uint256 _perTxUsdcCap,
        uint256 _dailyTxCountLimit
    ) {
        if (_diamond == address(0) || _usdc == address(0)) revert InvalidAddress();
        if (_perTxUsdcCap == 0 || _dailyTxCountLimit == 0) revert InvalidAmount();
        diamond = _diamond;
        usdc = IERC20(_usdc);
        owner = msg.sender;
        perTxUsdcCap = _perTxUsdcCap;
        dailyTxCountLimit = _dailyTxCountLimit;
        treasury = msg.sender;
        proxyImpl = address(new UserProxy());
    }

    // ─── Admin ────────────────────────────────────────────────────────

    /// @notice Update the absolute per-tx USDC cap. Keep ≤ 50 USDC to stay in
    ///         the no-KYC lane; a higher value would fail P2P review.
    function setPerTxUsdcCap(uint256 cap) external onlyOwner {
        if (cap == 0) revert InvalidAmount();
        perTxUsdcCap = cap;
        emit PerTxUsdcCapUpdated(cap);
    }

    /// @notice Update the per-user daily order-count limit.
    function setDailyTxCountLimit(uint256 count) external onlyOwner {
        if (count == 0) revert InvalidAmount();
        dailyTxCountLimit = count;
        emit DailyTxCountLimitUpdated(count);
    }

    /// @notice Update the sweep destination for USDC proceeds.
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert InvalidAddress();
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    /// @notice Sweep `amount` of accrued USDC proceeds to `treasury`.
    function sweepUsdc(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert InvalidAmount();
        usdc.safeTransfer(treasury, amount);
        emit UsdcSwept(treasury, amount);
    }

    // ─── Views ────────────────────────────────────────────────────────

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

    /// @notice Remaining challenge orders `user` may place today.
    function getRemainingDailyCount(address user) external view returns (uint256) {
        uint256 count = userDailyCount[user][block.timestamp / 1 days];
        if (count >= dailyTxCountLimit) return 0;
        return dailyTxCountLimit - count;
    }

    /// @notice Orders `user` has placed today.
    function getTodayCount(address user) external view returns (uint256) {
        return userDailyCount[user][block.timestamp / 1 days];
    }

    // ─── User-facing checkout ─────────────────────────────────────────

    /**
     * @notice Place a challenge BUY order. The purchased USDC is delivered to
     *         this integrator on completion (recipientAddr = address(this));
     *         the challenge itself is granted off-chain when the backend sees
     *         `ChallengePurchased`.
     * @param amount                          USDC to buy (micro-USDC, 6dp).
     * @param currency                        Fiat currency, e.g. bytes32("INR").
     * @param circleId                        LP circle for `currency` (from routing).
     * @param pubKey                          User's relay pubkey for the order.
     * @param preferredPaymentChannelConfigId Preferred payment channel (0 = any).
     * @param fiatAmountLimit                 Max fiat the user will pay (0 = no cap).
     * @param sessionRef                      Investabl checkout-session id to echo.
     */
    function buyChallenge(
        uint256 amount,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit,
        bytes32 sessionRef
    ) external nonReentrant returns (uint256 orderId) {
        if (amount == 0) revert InvalidAmount();

        // Friendly pre-checks — validateOrder re-enforces these authoritatively
        // (and does the daily-count bump) when the Diamond calls back.
        if (amount > perTxUsdcCap) revert AmountExceedsCap();
        if (userDailyCount[msg.sender][block.timestamp / 1 days] + 1 > dailyTxCountLimit) {
            revert DailyCountExceeded();
        }

        address proxy = _ensureProxy(msg.sender);
        // recipientAddr = address(this): purchased USDC settles to the integrator
        // on completion. usdcAllowance = 0: placeB2BOrder pulls no USDC at
        // placement (fiat settles off-chain).
        bytes memory data = abi.encodeCall(
            IB2BGateway.placeB2BOrder,
            (
                msg.sender,
                amount,
                currency,
                address(this),
                pubKey,
                circleId,
                preferredPaymentChannelConfigId,
                fiatAmountLimit
            )
        );
        bytes memory result = UserProxy(proxy).execute(diamond, data, address(usdc), 0);
        orderId = abi.decode(result, (uint256));

        sessions[orderId] = Session({
            user: msg.sender,
            fulfilled: false,
            cancelled: false,
            placementDay: uint32(block.timestamp / 1 days),
            amount: amount,
            sessionRef: sessionRef
        });

        emit ChallengeOrderCreated(orderId, msg.sender, amount, currency, sessionRef);
    }

    // ─── IP2PIntegrator callbacks ─────────────────────────────────────

    /**
     * @notice Authoritative synchronous gate the Diamond calls inside
     *         placeB2BOrder. Enforces the absolute per-tx cap and the daily
     *         count budget (reserving the slot on success). No RP / KYC.
     */
    function validateOrder(
        address user,
        uint256 amount,
        bytes32 /* currency */
    ) external onlyDiamond returns (bool allowed) {
        if (amount == 0 || amount > perTxUsdcCap) return false;

        uint256 dayIndex = block.timestamp / 1 days;
        uint256 count = userDailyCount[user][dayIndex];
        if (count + 1 > dailyTxCountLimit) return false;

        userDailyCount[user][dayIndex] = count + 1;
        return true;
    }

    /**
     * @notice Completion hook. The Diamond has already delivered `amount` USDC
     *         to this contract (recipientAddr = address(this)). We only finalize
     *         bookkeeping and emit `ChallengePurchased` for the backend to grant
     *         the challenge. Best-effort from the gateway's POV (try/catch there).
     */
    function onOrderComplete(
        uint256 orderId,
        address /* user */,
        uint256 /* amount */,
        address /* recipientAddr */
    ) external onlyDiamond {
        Session storage session = sessions[orderId];
        if (session.user == address(0)) return; // unknown order — no-op
        if (session.fulfilled) revert OrderAlreadyFulfilled();
        session.fulfilled = true;
        emit ChallengePurchased(orderId, session.user, session.amount, session.sessionRef);
    }

    /**
     * @notice Cancellation hook — releases the daily-count slot reserved in
     *         validateOrder, keyed on the placement-day snapshot. Tolerates
     *         unknown / already-finalized orders. MUST NOT touch on-chain order
     *         state (protocol-side has already finalized).
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

        emit ChallengeOrderCancelled(orderId, session.user);
    }

    // ─── Internals: proxy (mirror ExampleIntegrator / template exactly) ─

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
