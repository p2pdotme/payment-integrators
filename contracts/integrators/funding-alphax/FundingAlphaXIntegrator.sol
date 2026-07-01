// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { UserProxy } from "../../base/UserProxy.sol";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title FundingAlphaXIntegrator
 * @author FundingAlphaX
 * @notice P2P integrator for FundingAlphaX's "Pay with UPI" challenge-purchase
 *         flow. A buyer pays local fiat (UPI) through P2P; the protocol settles
 *         USDC on Base; this integrator forwards that USDC to a per-order
 *         NowPayments deposit address. NowPayments converts it to USDT-BSC and
 *         fires FundingAlphaX's existing webhook, which activates the trading
 *         challenge and pays the affiliate commission — off-chain, unchanged.
 *
 *         Flow:
 *           1. The FundingAlphaX backend (the trusted `operator`) creates a
 *              NowPayments USDC-on-Base invoice and gets a deposit address +
 *              exact amount.
 *           2. operator calls placeChallengeOrder(user, amount, npAddress, ...),
 *              which places a B2B BUY order with recipientAddr = the user's
 *              UserProxy. USDC lands on the proxy; the integrator routes it —
 *              the same custody pattern as LotPotCheckoutIntegratorV2
 *              (usdcThroughIntegrator = false).
 *           3. The buyer pays fiat off-chain; P2P settles USDC to the proxy and
 *              the Diamond calls onOrderComplete().
 *           4. onOrderComplete() pulls the USDC off the proxy and safeTransfers
 *              the realized amount to the per-order NowPayments deposit address.
 *
 *         SECURITY POSTURE (built to the repo's safe pattern):
 *           - The NowPayments recipient is set by the trusted `operator`, never
 *             by the buyer — funds cannot be redirected by a user.
 *           - Defense-in-depth on the completion callback: UnknownOrder,
 *             AmountMismatch, already-fulfilled / already-cancelled.
 *           - Forwards the *realized* USDC delta (push via safeTransfer), not a
 *             blindly-trusted callback amount.
 *           - nonReentrant + effects-before-interactions on the money path.
 *           - Per-tx cap + per-user daily-count limit bound blast radius;
 *             immediate forward-out (no pooling).
 *           - owner is a multisig/timelock (Ownable2Step); operator is a hot
 *             backend key that can only *place* capped orders — never withdraw.
 *
 *         NON-STANDARD vs ExampleIntegrator (called out for review):
 *           - Order placement is OPERATOR-driven (placeChallengeOrder is
 *             onlyOperator), not end-user-driven — FundingAlphaX buyers are
 *             walletless (no Base wallet); the operator places on their behalf.
 *           - Settled USDC is forwarded OUT to an external, operator-pinned
 *             NowPayments deposit address (an off-chain custodial off-ramp),
 *             rather than spent on an on-chain product. This is the deliberate
 *             custody difference from LotPot (which traps USDC on the proxy).
 */
contract FundingAlphaXIntegrator is IP2PIntegrator, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Errors ───────────────────────────────────────────────────────
    error OnlyDiamond();
    error OnlyOperator();
    error InvalidAddress();
    error AmountOutOfRange();
    error UnknownOrder();
    error OrderAlreadyFulfilled();
    error OrderAlreadyCancelled();
    error AmountMismatch();
    error NothingReceived();

    // ─── Events ───────────────────────────────────────────────────────
    event ChallengeOrderPlaced(
        uint256 indexed orderId,
        address indexed user,
        address indexed recipient,
        uint256 amount
    );
    event ChallengePaymentForwarded(
        uint256 indexed orderId,
        address indexed user,
        address indexed recipient,
        uint256 amount
    );
    event ChallengeOrderCancelled(uint256 indexed orderId);
    event UserProxyDeployed(address indexed user, address proxy);
    event OperatorUpdated(address indexed previous, address indexed next);
    event MaxPerTxUpdated(uint256 previous, uint256 next);
    event MaxDailyCountUpdated(uint256 previous, uint256 next);
    event StuckOrderRecovered(uint256 indexed orderId, address indexed recipient, uint256 amount);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    // ─── Immutables ───────────────────────────────────────────────────
    /// @notice The P2P Diamond (B2B gateway). Only it may call the lifecycle hooks.
    address public immutable diamond;
    /// @notice USDC (6-dec) on Base. Public getter because the canonical UserProxy
    ///         resolves the sweep-blocked token via IUsdcSource(integrator()).usdc().
    IERC20 public immutable usdc;
    /// @notice The canonical UserProxy implementation pinned at deploy. Submit this
    ///         alongside the integrator address in the whitelist request: the
    ///         Diamond records it for the CREATE2 proxy-auth path.
    address public immutable proxyImpl;

    // ─── Configurable limits ──────────────────────────────────────────
    /// @notice Hot backend key allowed to place orders (within the limits). Cannot move funds.
    address public operator;
    /// @notice Hard per-transaction USDC cap (6 decimals) — bounds blast radius.
    uint256 public maxPerTxUsdc;
    /// @notice Max orders per UTC day per `user`, enforced in validateOrder and
    ///         released in onOrderCancel. Bounds per-identity throughput.
    uint256 public maxDailyCountPerUser;

    struct Session {
        address user; // 20 bytes ┐
        bool fulfilled; //  1 byte  │ slot 0
        bool cancelled; //  1 byte  │
        uint32 placementDay; //  4 bytes ┘ (UTC day validateOrder bumped; keyed in onOrderCancel)
        address recipient; // per-order NowPayments USDC-on-Base deposit address
        uint256 amount; // expected USDC (6 decimals)
    }
    /// @notice orderId → session. Set at placement, consumed at completion.
    mapping(uint256 => Session) private _sessions;
    /// @notice user → (UTC day index) → orders placed that day. Consumed in
    ///         validateOrder, released in onOrderCancel.
    mapping(address => mapping(uint256 => uint256)) public userDailyCount;

    // ─── Modifiers ────────────────────────────────────────────────────
    modifier onlyDiamond() {
        if (msg.sender != diamond) revert OnlyDiamond();
        _;
    }
    modifier onlyOperator() {
        if (msg.sender != operator) revert OnlyOperator();
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────
    /// @param _diamond The P2P Diamond (B2B gateway) on the target network.
    /// @param _usdc USDC (6-dec) on the target network.
    /// @param _operator FundingAlphaX backend hot key (places capped orders only).
    /// @param _maxPerTxUsdc Per-transaction USDC cap (6 decimals).
    /// @param _maxDailyCountPerUser Max orders per UTC day per user.
    constructor(
        address _diamond,
        address _usdc,
        address _operator,
        uint256 _maxPerTxUsdc,
        uint256 _maxDailyCountPerUser
    ) Ownable(msg.sender) {
        if (_diamond == address(0) || _usdc == address(0) || _operator == address(0)) {
            revert InvalidAddress();
        }
        if (_maxPerTxUsdc == 0 || _maxDailyCountPerUser == 0) revert AmountOutOfRange();
        diamond = _diamond;
        usdc = IERC20(_usdc);
        operator = _operator;
        maxPerTxUsdc = _maxPerTxUsdc;
        maxDailyCountPerUser = _maxDailyCountPerUser;
        // Deploy the canonical UserProxy implementation; every per-user clone is a
        // cloneDeterministicWithImmutableArgs of this, with (user, this) packed in.
        proxyImpl = address(new UserProxy());
        emit OperatorUpdated(address(0), _operator);
        emit MaxPerTxUpdated(0, _maxPerTxUsdc);
        emit MaxDailyCountUpdated(0, _maxDailyCountPerUser);
    }

    // ─── IP2PIntegrator: protocol lifecycle hooks ─────────────────────

    /// @notice Called by the Diamond at placement to authorize the order and
    ///         consume the user's daily-count slot. Gated onlyDiamond because it
    ///         mutates per-user accounting — a public caller could otherwise
    ///         exhaust a user's daily quota. Returns false (blocks the order)
    ///         when paused, out of the per-tx range, or over the daily count.
    /// @param user The on-chain identity the order is keyed to.
    /// @param amount The USDC amount (6 decimals) being placed.
    /// @return allowed Whether the Diamond may proceed with the order.
    function validateOrder(
        address user,
        uint256 amount,
        bytes32 /* currency */
    ) external onlyDiamond returns (bool allowed) {
        if (paused()) return false;
        if (amount == 0 || amount > maxPerTxUsdc) return false;

        uint256 day = block.timestamp / 1 days;
        uint256 count = userDailyCount[user][day];
        if (count + 1 > maxDailyCountPerUser) return false;

        userDailyCount[user][day] = count + 1;
        return true;
    }

    /// @notice Called by the Diamond when fiat settles and USDC has been
    ///         delivered to the user's proxy. Pull it and forward the realized
    ///         amount to the per-order NowPayments deposit address.
    /// @param orderId The Diamond order id (also the session key).
    /// @param user The on-chain identity the order/proxy is keyed to.
    /// @param amount The USDC amount the Diamond reports settled (6 decimals).
    function onOrderComplete(
        uint256 orderId,
        address user,
        uint256 amount,
        address /* recipientAddr */ // == the proxy; we use the operator-set recipient
    ) external onlyDiamond nonReentrant {
        Session storage s = _sessions[orderId];
        if (s.user == address(0)) revert UnknownOrder();
        if (s.cancelled) revert OrderAlreadyCancelled();
        if (s.fulfilled) revert OrderAlreadyFulfilled();
        if (amount != s.amount) revert AmountMismatch();

        // Effects before interactions.
        s.fulfilled = true;
        address recipient = s.recipient;

        // Pull the settled USDC off the user's proxy, then forward the REALIZED
        // amount (not the blindly-trusted callback value) to NowPayments.
        address proxy = proxyAddress(user);
        uint256 balBefore = usdc.balanceOf(address(this));
        UserProxy(proxy).transferERC20ToIntegrator(address(usdc), amount);
        uint256 received = usdc.balanceOf(address(this)) - balBefore;
        if (received == 0) revert NothingReceived();

        usdc.safeTransfer(recipient, received);
        emit ChallengePaymentForwarded(orderId, user, recipient, received);
    }

    /// @notice Called by the Diamond on cancellation (manual/expiry/dispute/
    ///         PAY-fail). Releases the daily-count slot validateOrder consumed,
    ///         keyed on the placement-day snapshot so the decrement lands in the
    ///         right bucket even across a UTC day boundary. Best-effort:
    ///         tolerates unknown/duplicate and marks the session so it can never
    ///         be force-fulfilled.
    /// @param orderId The Diamond order id.
    function onOrderCancel(uint256 orderId) external onlyDiamond {
        Session storage s = _sessions[orderId];
        if (s.user != address(0) && !s.fulfilled && !s.cancelled) {
            s.cancelled = true;

            uint256 day = uint256(s.placementDay);
            uint256 count = userDailyCount[s.user][day];
            if (count > 0) {
                userDailyCount[s.user][day] = count - 1;
            }

            emit ChallengeOrderCancelled(orderId);
        }
    }

    // ─── Order entry point (called by the FundingAlphaX backend) ──────

    /// @notice Place a B2B BUY (checkout) order for a UPI challenge purchase.
    /// @param user The on-chain identity the order + proxy are keyed to.
    /// @param amount Exact USDC (6 dec) the NowPayments invoice expects.
    /// @param nowpaymentsRecipient The per-order NowPayments USDC-on-Base deposit address.
    /// @param currency P2P currency code (bytes32) for the fiat leg.
    /// @param circleId P2P circle id (0 if unused).
    /// @param pubKey Encryption pubkey P2P uses for the fiat leg.
    /// @return orderId The Diamond order id (also the session key).
    function placeChallengeOrder(
        address user,
        uint256 amount,
        address nowpaymentsRecipient,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey
    ) external onlyOperator whenNotPaused returns (uint256 orderId) {
        if (user == address(0) || nowpaymentsRecipient == address(0)) revert InvalidAddress();
        if (amount == 0 || amount > maxPerTxUsdc) revert AmountOutOfRange();

        address proxy = _ensureProxy(user);

        // recipientAddr = proxy (USDC lands on the proxy; we route it in onOrderComplete).
        // usdcAllowance = 0: placeB2BOrder pulls no USDC at placement (fiat settles off-chain).
        bytes memory placeData = abi.encodeCall(
            IB2BGateway.placeB2BOrder,
            (user, amount, currency, proxy, pubKey, circleId, 0, 0)
        );
        bytes memory ret = UserProxy(proxy).execute(diamond, placeData, address(usdc), 0);
        orderId = abi.decode(ret, (uint256));

        _sessions[orderId] = Session({
            user: user,
            fulfilled: false,
            cancelled: false,
            placementDay: uint32(block.timestamp / 1 days),
            recipient: nowpaymentsRecipient,
            amount: amount
        });
        emit ChallengeOrderPlaced(orderId, user, nowpaymentsRecipient, amount);
    }

    // ─── Owner admin ──────────────────────────────────────────────────

    /// @notice Rotate the backend operator hot key. Owner-only.
    function setOperator(address _operator) external onlyOwner {
        if (_operator == address(0)) revert InvalidAddress();
        emit OperatorUpdated(operator, _operator);
        operator = _operator;
    }

    /// @notice Update the per-transaction USDC cap. Owner-only.
    function setMaxPerTxUsdc(uint256 _maxPerTxUsdc) external onlyOwner {
        if (_maxPerTxUsdc == 0) revert AmountOutOfRange();
        emit MaxPerTxUpdated(maxPerTxUsdc, _maxPerTxUsdc);
        maxPerTxUsdc = _maxPerTxUsdc;
    }

    /// @notice Update the per-user daily order-count limit. Owner-only.
    function setMaxDailyCountPerUser(uint256 _maxDailyCountPerUser) external onlyOwner {
        if (_maxDailyCountPerUser == 0) revert AmountOutOfRange();
        emit MaxDailyCountUpdated(maxDailyCountPerUser, _maxDailyCountPerUser);
        maxDailyCountPerUser = _maxDailyCountPerUser;
    }

    /// @notice Pause new placements (and force validateOrder to return false). Owner-only.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume placements. Owner-only.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Recovery path: if onOrderComplete ever reverted (so funds sat on
    ///         the proxy and the session stayed unfulfilled), the owner can
    ///         re-pull and forward to the recorded NowPayments recipient.
    /// @param orderId The Diamond order id to recover.
    function recoverStuckOrder(uint256 orderId) external onlyOwner nonReentrant {
        Session storage s = _sessions[orderId];
        if (s.user == address(0)) revert UnknownOrder();
        if (s.cancelled) revert OrderAlreadyCancelled();
        if (s.fulfilled) revert OrderAlreadyFulfilled();
        s.fulfilled = true;

        address proxy = proxyAddress(s.user);
        uint256 balBefore = usdc.balanceOf(address(this));
        UserProxy(proxy).transferERC20ToIntegrator(address(usdc), s.amount);
        uint256 received = usdc.balanceOf(address(this)) - balBefore;
        if (received == 0) revert NothingReceived();

        usdc.safeTransfer(s.recipient, received);
        emit StuckOrderRecovered(orderId, s.recipient, received);
    }

    /// @notice Sweep stray tokens accidentally held by this integrator (e.g. a
    ///         failed forward). Owner-only; owner should be a multisig.
    /// @param token The ERC-20 to sweep.
    /// @param to The recipient.
    /// @param amount The amount to transfer.
    function rescueERC20(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert InvalidAddress();
        IERC20(token).safeTransfer(to, amount);
        emit Rescued(token, to, amount);
    }

    // ─── Views ────────────────────────────────────────────────────────

    /// @notice Returns the recorded session for `orderId`.
    function getSession(uint256 orderId) external view returns (Session memory) {
        return _sessions[orderId];
    }

    /// @notice Orders `user` can still place today before hitting the daily cap.
    function getRemainingDailyCount(address user) external view returns (uint256) {
        uint256 count = userDailyCount[user][block.timestamp / 1 days];
        if (count >= maxDailyCountPerUser) return 0;
        return maxDailyCountPerUser - count;
    }

    /// @notice Orders `user` has placed in the current UTC day.
    function getTodayCount(address user) external view returns (uint256) {
        return userDailyCount[user][block.timestamp / 1 days];
    }

    /// @notice Deterministic UserProxy address for `user` (may not be deployed yet).
    function proxyAddress(address user) public view returns (address) {
        return
            Clones.predictDeterministicAddressWithImmutableArgs(
                proxyImpl,
                _proxyArgs(user),
                _salt(user),
                address(this)
            );
    }

    // ─── Internal proxy helpers (mirror ExampleIntegrator exactly) ────

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

    /// @dev Salt is the user EOA only; the integrator (this) is the CREATE2 deployer,
    ///      so (integrator, user) → exactly one proxy. DO NOT change.
    function _salt(address user) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(user)));
    }

    /// @dev Immutable-args layout: [owner(20)][integrator(20)] — the Diamond's
    ///      CREATE2-auth path reconstructs the same args. DO NOT change the layout.
    function _proxyArgs(address user) internal view returns (bytes memory) {
        return abi.encodePacked(user, address(this));
    }
}
