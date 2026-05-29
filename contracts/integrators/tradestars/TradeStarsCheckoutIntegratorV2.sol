// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { IOrderFlow } from "../../interfaces/IOrderFlow.sol";
import { IRestrictedYieldVault } from "./IRestrictedYieldVault.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

/**
 * @title TradeStarsCheckoutIntegratorV2
 * @notice User-driven offramp ("offramp v2"). Supersedes the relayer-driven
 *         offramp on {TradeStarsCheckoutIntegrator}. The BUY (onramp) surface
 *         is unchanged from v1.
 *
 *         OFFRAMP MODEL
 *         -------------
 *         1. The relayer observes a Solana tUSDC burn and calls
 *            `allocateOfframp(userEOA, amount, burnTx, solPubkey)` — the ONLY
 *            relayer write. It pulls `amount` from the vault and forwards it to
 *            the user's *own* per-user proxy (the same proxy keyed on the user
 *            EOA that BUY uses). The relayer's job ends here.
 *         2. The USER (their Base wallet, gasless via paymaster) calls
 *            `userStartOfframp(allocationId, ...)`. The integrator places a
 *            SELL on the Diamond *through the user's proxy*, so
 *            `order.user == that proxy` — the Diamond pulls/refunds USDC there
 *            and the order is attributable to the user (not a shared system
 *            proxy), so it shows in the user's P2P history.
 *         3. The USER calls `userDeliverOfframpUpi(orderId, encUpi)` once a
 *            merchant accepts. The Diamond pulls `actualUsdtAmount` from the
 *            proxy → PAID → merchant pays fiat → COMPLETED.
 *         4. If the order is cancelled (merchant no-show / dispute / timeout),
 *            the Diamond refunds USDC to the proxy. The user simply calls
 *            `userStartOfframp` again — self-serve retry, no relayer/owner.
 *         5. `syncOfframp(orderId)` (permissionless) records the terminal
 *            status; on COMPLETED the allocation is settled. Abandoned
 *            allocations can be returned to the vault by the owner via
 *            `reclaimAbandonedOfframp` after a timeout.
 *
 *         USDC remains trapped in the proxy throughout — it can leave only via
 *         the Diamond pulling it for the SELL (→ fiat to the user off-chain) or
 *         via `transferERC20ToIntegrator` → vault on reclaim. It can never
 *         reach the user EOA. See docs/OFFRAMP-V2.md.
 */
contract TradeStarsCheckoutIntegratorV2 is IP2PIntegrator {
    using SafeERC20 for IERC20;

    // ─── Errors ───────────────────────────────────────────────────────

    error OnlyDiamond();
    error OnlyOwner();
    error OrderAlreadyFulfilled();
    error OrderAlreadyCancelled();
    error UnknownOrder();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidSolanaRecipient();
    error ArrayLengthMismatch();
    error AmountMismatch();

    // Offramp
    error OfframpDisabled();
    error OnlyOfframpRelayer();
    error VaultNotSet();
    error BurnAlreadyProcessed();
    error OfframpAmountTooLarge();
    error OfframpRecordNotFound();
    error OfframpAlreadySettled();
    error OfframpInsufficientPool();
    /// @notice setSellOrderUpi funding tried to read `actualUsdtAmount` from the
    ///         Diamond before it was computed (returned 0). Funding the proxy
    ///         short of principal+fee would make the Diamond's transferFrom
    ///         underflow and auto-cancel. Surface explicitly so the user retries
    ///         once the Diamond has populated it.
    error OfframpFeeNotReady();
    /// @notice Caller is not the EOA that owns this allocation.
    error OnlyAllocationOwner();
    /// @notice The allocation already has a non-cancelled order in flight; finish
    ///         or let it cancel before placing/reclaiming.
    error OfframpInFlight();
    /// @notice reclaimAbandonedOfframp called before the abandon timeout.
    error NotYetAbandoned();

    // ─── Events ───────────────────────────────────────────────────────

    event CheckoutOrderCreated(
        uint256 indexed orderId,
        address indexed user,
        bytes32 indexed solanaRecipient,
        uint256 amount
    );
    event CheckoutFulfilled(uint256 indexed orderId, bytes32 indexed user, uint256 amount);
    event UserProxyDeployed(address indexed user, address proxy);
    event UserRPUpdated(address indexed user, uint256 rp);
    event RpRateUpdated(bytes32 indexed currency, uint256 usdcPerRp);
    event BaseTxLimitUpdated(uint256 limit);
    event MaxTxLimitUpdated(bytes32 indexed currency, uint256 cap);
    event DailyTxCountLimitUpdated(uint256 count);
    event OrderCancelled(uint256 indexed orderId, address indexed user);

    // Vault / offramp config
    event YieldVaultUpdated(address indexed vault);
    event OfframpRelayerUpdated(address indexed relayer);
    event OfframpEnabledUpdated(bool enabled);
    event MaxUsdcPerOfframpUpdated(uint256 cap);
    event OfframpAbandonTimeoutUpdated(uint64 timeout);
    event UsdcDepositedToVault(uint256 indexed orderId, uint256 amount);

    // Offramp v2 lifecycle
    /// @notice Relayer moved `amount` from the vault into the user's proxy.
    event OfframpAllocated(
        uint256 indexed allocationId,
        address indexed user,
        address proxy,
        uint256 amount,
        bytes32 indexed solanaBurnTx,
        bytes32 solanaUserPubkey
    );
    /// @notice User placed (or re-placed, on retry) a SELL order from the proxy.
    event OfframpOrderPlaced(
        uint256 indexed allocationId,
        uint256 indexed orderId,
        address indexed user,
        uint256 amount
    );
    event OfframpUpiDelivered(uint256 indexed orderId);
    /// @notice Order COMPLETED — fiat sent; allocation closed.
    event OfframpSettled(uint256 indexed allocationId, uint256 indexed orderId);
    /// @notice Order CANCELLED — USDC refunded to the proxy; user may retry.
    event OfframpCancelled(uint256 indexed allocationId, uint256 indexed orderId);
    /// @notice Owner returned an abandoned allocation's USDC to the vault.
    event OfframpReclaimed(uint256 indexed allocationId, uint256 amount);

    // ─── Constants ────────────────────────────────────────────────────

    /// @notice Mirrors OrderProcessorStorage.OrderStatus on the P2P Diamond.
    uint8 internal constant STATUS_PLACED = 0;
    uint8 internal constant STATUS_ACCEPTED = 1;
    uint8 internal constant STATUS_PAID = 2;
    uint8 internal constant STATUS_COMPLETED = 3;
    uint8 internal constant STATUS_CANCELLED = 4;

    // ─── Immutables ───────────────────────────────────────────────────

    address public immutable diamond;
    address public immutable usdc;
    address public immutable owner;
    address public immutable proxyImpl;

    // ─── Configurable Limits (BUY) ────────────────────────────────────

    uint256 public baseTxLimit;
    uint256 public dailyTxCountLimit;
    mapping(bytes32 => uint256) public rpToUsdc;
    mapping(bytes32 => uint256) public maxTxLimit;
    mapping(address => uint256) public userRP;

    // ─── BUY state ────────────────────────────────────────────────────

    struct CheckoutSession {
        address user;
        bool fulfilled;
        bool cancelled;
        uint32 placementDay;
        bytes32 solanaRecipient;
        uint256 usdcAmount;
    }

    mapping(uint256 => CheckoutSession) public sessions;
    mapping(address => mapping(uint256 => uint256)) public userDailyCount;

    // ─── Vault + offramp config ───────────────────────────────────────

    IRestrictedYieldVault public yieldVault;
    bool public offrampEnabled;
    address public offrampRelayer;
    uint256 public maxUsdcPerOfframp;
    /// @notice How long after allocation before the owner may reclaim an
    ///         abandoned (never-completed) allocation's USDC to the vault.
    uint64 public offrampAbandonTimeout = 7 days;

    // ─── Offramp v2 allocation state ──────────────────────────────────

    struct OfframpAllocation {
        address user; // Base EOA = proxy owner
        uint256 amount; // USDC moved into the proxy (burned principal)
        bytes32 solanaBurnTx;
        bytes32 solanaUserPubkey;
        uint64 allocatedAt;
        uint256 activeOrderId; // current in-flight SELL (0 = none)
        uint8 lastStatus; // last status seen by syncOfframp (informational)
        bool settled; // COMPLETED (fiat sent) or reclaimed to vault
    }

    mapping(uint256 => OfframpAllocation) public allocations;
    /// @notice solanaBurnTx → allocationId. Non-zero ⇒ already processed.
    mapping(bytes32 => uint256) public burnToAllocation;
    /// @notice Diamond orderId → allocationId.
    mapping(uint256 => uint256) public orderToAllocation;
    mapping(address => uint256[]) internal _userAllocations;
    uint256 public nextAllocationId;

    /// @notice Set true only for the duration of `userStartOfframp`'s placement
    ///         call so `validateOrder` recognises our own offramp SELL and
    ///         bypasses per-user BUY limits. Transient (EIP-1153): auto-clears
    ///         at end-of-tx, so a revert mid-placement can't leave it stuck.
    bool transient _offrampPlacing;

    // ─── Modifiers ────────────────────────────────────────────────────

    modifier onlyDiamond() {
        if (msg.sender != diamond) revert OnlyDiamond();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyOfframpRelayer() {
        if (msg.sender != offrampRelayer) revert OnlyOfframpRelayer();
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────

    constructor(address _diamond, address _usdc, uint256 _baseTxLimit, uint256 _dailyTxCountLimit) {
        if (_diamond == address(0) || _usdc == address(0)) revert InvalidAddress();
        diamond = _diamond;
        usdc = _usdc;
        owner = msg.sender;
        baseTxLimit = _baseTxLimit;
        dailyTxCountLimit = _dailyTxCountLimit;
        proxyImpl = address(new UserProxy());
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

    // ─── Admin: User RP ───────────────────────────────────────────────

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

    // ─── User-Facing Order Placement (BUY) ────────────────────────────

    /**
     * @notice End-user places a USDC checkout order to be minted on Solana.
     *         Routes through the user's UserProxy, which is the actual caller
     *         of placeB2BOrder on the Diamond. Unchanged from v1.
     */
    function userPlaceOrder(
        bytes32 solanaRecipient,
        uint256 amount,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) external returns (uint256 orderId) {
        if (solanaRecipient == bytes32(0)) revert InvalidSolanaRecipient();
        if (amount == 0) revert InvalidAmount();

        address userProxy = _ensureProxy(msg.sender);
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
        bytes memory result = UserProxy(userProxy).execute(diamond, data, usdc, 0);
        orderId = abi.decode(result, (uint256));

        sessions[orderId] = CheckoutSession({
            user: msg.sender,
            solanaRecipient: solanaRecipient,
            usdcAmount: amount,
            fulfilled: false,
            cancelled: false,
            placementDay: uint32(block.timestamp / 1 days)
        });

        emit CheckoutOrderCreated(orderId, msg.sender, solanaRecipient, amount);
    }

    // ─── IP2PIntegrator Callbacks ─────────────────────────────────────

    function validateOrder(
        address user,
        uint256 amount,
        bytes32 currency
    ) external onlyDiamond returns (bool allowed) {
        // Our own offramp SELL placement (userStartOfframp). The relayer already
        // bounded the draw by maxUsdcPerOfframp + the vault balance at allocation
        // time; per-user BUY limits do not apply.
        if (_offrampPlacing) return true;

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
        CheckoutSession storage session = sessions[orderId];
        if (session.user == address(0)) revert UnknownOrder();
        if (session.cancelled) revert OrderAlreadyCancelled();
        if (session.fulfilled) revert OrderAlreadyFulfilled();
        if (amount != session.usdcAmount) revert AmountMismatch();

        session.fulfilled = true;

        // usdcThroughIntegrator = true: the Diamond pushed USDC here on BUY
        // completion. Forward it to the vault to earn yield.
        if (address(yieldVault) != address(0)) {
            IERC20(usdc).forceApprove(address(yieldVault), amount);
            yieldVault.deposit(amount);
            IERC20(usdc).forceApprove(address(yieldVault), 0);
            emit UsdcDepositedToVault(orderId, amount);
        }

        emit CheckoutFulfilled(orderId, session.solanaRecipient, amount);
    }

    /// @notice BUY cancellation hook — releases the userDailyCount slot reserved
    ///         at validateOrder. Offramp SELL orders have no CheckoutSession
    ///         (session.user == 0) → no-op.
    function onOrderCancel(uint256 orderId) external onlyDiamond {
        CheckoutSession storage session = sessions[orderId];
        if (session.user == address(0)) return;
        if (session.fulfilled) revert OrderAlreadyFulfilled();
        if (session.cancelled) revert OrderAlreadyCancelled();
        session.cancelled = true;

        uint256 day = uint256(session.placementDay);
        uint256 count = userDailyCount[session.user][day];
        if (count > 0) {
            userDailyCount[session.user][day] = count - 1;
        }

        emit OrderCancelled(orderId, session.user);
    }

    // ─── View Functions ───────────────────────────────────────────────

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

    function getSession(uint256 orderId) external view returns (CheckoutSession memory) {
        return sessions[orderId];
    }

    /// @notice Predicted address of the per-user UserProxy clone. Deterministic
    ///         CREATE2 — the address exists before any deployment, so the widget
    ///         can derive it to query the user's offramp history.
    function proxyAddress(address user) public view returns (address) {
        return
            Clones.predictDeterministicAddressWithImmutableArgs(
                proxyImpl,
                _proxyArgs(user),
                _salt(user),
                address(this)
            );
    }

    // ─── Admin: vault + offramp config ────────────────────────────────

    function setYieldVault(address vault) external onlyOwner {
        yieldVault = IRestrictedYieldVault(vault);
        emit YieldVaultUpdated(vault);
    }

    function setOfframpRelayer(address relayer) external onlyOwner {
        offrampRelayer = relayer;
        emit OfframpRelayerUpdated(relayer);
    }

    function setOfframpEnabled(bool flag) external onlyOwner {
        offrampEnabled = flag;
        emit OfframpEnabledUpdated(flag);
    }

    function setMaxUsdcPerOfframp(uint256 cap) external onlyOwner {
        maxUsdcPerOfframp = cap;
        emit MaxUsdcPerOfframpUpdated(cap);
    }

    function setOfframpAbandonTimeout(uint64 timeout) external onlyOwner {
        offrampAbandonTimeout = timeout;
        emit OfframpAbandonTimeoutUpdated(timeout);
    }

    // ─── Offramp v2: relayer allocation ───────────────────────────────

    /**
     * @notice Relayer-only. After observing a Solana burn, move `amount` from
     *         the vault into `user`'s per-user proxy and record an allocation.
     *         This is the ONLY relayer write in the offramp path — the user
     *         drives everything after this.
     */
    function allocateOfframp(
        address user,
        uint256 amount,
        bytes32 solanaBurnTx,
        bytes32 solanaUserPubkey
    ) external onlyOfframpRelayer returns (uint256 allocationId) {
        if (!offrampEnabled) revert OfframpDisabled();
        if (address(yieldVault) == address(0)) revert VaultNotSet();
        if (user == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (solanaBurnTx == bytes32(0)) revert InvalidSolanaRecipient();
        if (burnToAllocation[solanaBurnTx] != 0) revert BurnAlreadyProcessed();
        if (maxUsdcPerOfframp != 0 && amount > maxUsdcPerOfframp) revert OfframpAmountTooLarge();

        // Pull USDC from the vault into this integrator, then forward to the
        // user's proxy. The vault reverts if its balance can't service this.
        yieldVault.releaseForOfframp(amount);
        address proxy = _ensureProxy(user);
        IERC20(usdc).safeTransfer(proxy, amount);

        allocationId = ++nextAllocationId;
        allocations[allocationId] = OfframpAllocation({
            user: user,
            amount: amount,
            solanaBurnTx: solanaBurnTx,
            solanaUserPubkey: solanaUserPubkey,
            allocatedAt: uint64(block.timestamp),
            activeOrderId: 0,
            lastStatus: 0,
            settled: false
        });
        burnToAllocation[solanaBurnTx] = allocationId;
        _userAllocations[user].push(allocationId);

        emit OfframpAllocated(allocationId, user, proxy, amount, solanaBurnTx, solanaUserPubkey);
    }

    // ─── Offramp v2: user-driven lifecycle ────────────────────────────

    /**
     * @notice User-only. Place (or re-place, on retry) a SELL order from the
     *         user's own proxy, funded by the allocation already sitting there.
     *         `order.user` is the proxy, so the Diamond pulls/refunds USDC there
     *         and the order is attributed to the user in P2P history.
     */
    function userStartOfframp(
        uint256 allocationId,
        bytes32 currency,
        uint256 fiatAmount,
        uint256 circleId,
        uint256 preferredPaymentChannelConfigId,
        string calldata userPubKey
    ) external returns (uint256 orderId) {
        OfframpAllocation storage a = allocations[allocationId];
        if (a.user == address(0)) revert OfframpRecordNotFound();
        if (msg.sender != a.user) revert OnlyAllocationOwner();
        if (a.settled) revert OfframpAlreadySettled();
        // One in-flight order per allocation: a prior order must be terminally
        // CANCELLED (USDC refunded to the proxy) before re-placing.
        if (a.activeOrderId != 0 && _diamondStatus(a.activeOrderId) != STATUS_CANCELLED) {
            revert OfframpInFlight();
        }

        address proxy = _ensureProxy(a.user);
        bytes memory data = abi.encodeCall(
            IB2BGateway.placeB2BSellOrder,
            (
                proxy,
                a.amount,
                currency,
                userPubKey,
                circleId,
                preferredPaymentChannelConfigId,
                fiatAmount
            )
        );

        _offrampPlacing = true;
        bytes memory result = UserProxy(proxy).execute(diamond, data, usdc, 0);
        _offrampPlacing = false;

        orderId = abi.decode(result, (uint256));
        a.activeOrderId = orderId;
        a.lastStatus = STATUS_PLACED;
        orderToAllocation[orderId] = allocationId;

        emit OfframpOrderPlaced(allocationId, orderId, a.user, a.amount);
    }

    /**
     * @notice User-only. Forward the encrypted payout address to the Diamond,
     *         triggering the PAID transition (the Diamond pulls actualUsdtAmount
     *         from the proxy). The proxy already holds the allocation; any
     *         small-order fee shortfall is fronted from the integrator's USDC
     *         float (recovered into the proxy on a later cancel-refund).
     */
    function userDeliverOfframpUpi(uint256 orderId, string calldata encUpi) external {
        uint256 allocationId = orderToAllocation[orderId];
        OfframpAllocation storage a = allocations[allocationId];
        if (a.user == address(0)) revert OfframpRecordNotFound();
        if (msg.sender != a.user) revert OnlyAllocationOwner();
        if (a.activeOrderId != orderId) revert UnknownOrder();

        IOrderFlow.AdditionalOrderDetailsView memory aod = IOrderFlow(diamond)
            .getAdditionalOrderDetails(orderId);
        uint256 needed = aod.actualUsdtAmount; // principal + fee
        if (needed == 0) revert OfframpFeeNotReady();

        address proxy = _ensureProxy(a.user);
        uint256 proxyBal = IERC20(usdc).balanceOf(proxy);
        if (proxyBal < needed) {
            uint256 gap = needed - proxyBal;
            if (IERC20(usdc).balanceOf(address(this)) < gap) revert OfframpInsufficientPool();
            IERC20(usdc).safeTransfer(proxy, gap);
        }

        bytes memory data = abi.encodeCall(IOrderFlow.setSellOrderUpi, (orderId, encUpi, 0));
        UserProxy(proxy).execute(diamond, data, usdc, needed);

        emit OfframpUpiDelivered(orderId);
    }

    /**
     * @notice Permissionless. Read the Diamond's authoritative terminal status
     *         and record it. On COMPLETED the allocation is settled (fiat sent).
     *         On CANCELLED the USDC is back in the proxy — the user may retry
     *         via `userStartOfframp`; nothing is returned to the vault here.
     */
    function syncOfframp(uint256 orderId) external {
        uint256 allocationId = orderToAllocation[orderId];
        OfframpAllocation storage a = allocations[allocationId];
        if (a.user == address(0)) revert OfframpRecordNotFound();

        uint8 status = _diamondStatus(orderId);
        if (status != STATUS_COMPLETED && status != STATUS_CANCELLED) revert StatusNotTerminal();
        a.lastStatus = status;

        if (status == STATUS_COMPLETED) {
            a.settled = true;
            emit OfframpSettled(allocationId, orderId);
        } else {
            emit OfframpCancelled(allocationId, orderId);
        }
    }

    error StatusNotTerminal();

    /**
     * @notice Owner break-glass. After `offrampAbandonTimeout` from allocation,
     *         pull the proxy's remaining USDC back to the integrator and return
     *         it to the vault. Refuses while an order is in flight (not yet
     *         cancelled) so it can never yank funds the Diamond might pull.
     */
    function reclaimAbandonedOfframp(uint256 allocationId) external onlyOwner {
        OfframpAllocation storage a = allocations[allocationId];
        if (a.user == address(0)) revert OfframpRecordNotFound();
        if (a.settled) revert OfframpAlreadySettled();
        if (block.timestamp < uint256(a.allocatedAt) + uint256(offrampAbandonTimeout)) {
            revert NotYetAbandoned();
        }
        if (a.activeOrderId != 0 && _diamondStatus(a.activeOrderId) != STATUS_CANCELLED) {
            revert OfframpInFlight();
        }

        a.settled = true;

        address proxy = _ensureProxy(a.user);
        uint256 bal = IERC20(usdc).balanceOf(proxy);
        uint256 ret = bal < a.amount ? bal : a.amount;
        if (ret > 0) {
            UserProxy(proxy).transferERC20ToIntegrator(usdc, ret);
            IERC20(usdc).forceApprove(address(yieldVault), ret);
            yieldVault.returnFromOfframp(ret);
            IERC20(usdc).forceApprove(address(yieldVault), 0);
        }
        emit OfframpReclaimed(allocationId, ret);
    }

    // ─── Offramp v2: views ────────────────────────────────────────────

    /// @notice Total unsettled allocation principal for `user` — what the widget
    ///         shows as the offramp-able balance.
    function availableOfframp(address user) external view returns (uint256 total) {
        uint256[] storage ids = _userAllocations[user];
        for (uint256 i = 0; i < ids.length; i++) {
            OfframpAllocation storage a = allocations[ids[i]];
            if (!a.settled) total += a.amount;
        }
    }

    /// @notice Unsettled allocation ids for `user` (newest-inclusive). The widget
    ///         picks one to drive the Cashout flow.
    function pendingAllocations(address user) external view returns (uint256[] memory ids) {
        uint256[] storage all = _userAllocations[user];
        uint256 n;
        for (uint256 i = 0; i < all.length; i++) {
            if (!allocations[all[i]].settled) n++;
        }
        ids = new uint256[](n);
        uint256 j;
        for (uint256 i = 0; i < all.length; i++) {
            if (!allocations[all[i]].settled) {
                ids[j++] = all[i];
            }
        }
    }

    function getAllocation(uint256 allocationId) external view returns (OfframpAllocation memory) {
        return allocations[allocationId];
    }

    // ─── Internal helpers ─────────────────────────────────────────────

    function _diamondStatus(uint256 orderId) internal view returns (uint8) {
        return IOrderFlow(diamond).getOrdersById(orderId).status;
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
