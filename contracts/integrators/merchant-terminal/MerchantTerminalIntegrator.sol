// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { IOrderFlow } from "../../interfaces/IOrderFlow.sol";
import { ICheckoutClient } from "../../interfaces/ICheckoutClient.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

/**
 * @title MerchantTerminalIntegrator
 * @notice P2P merchant terminal: merchants accept INR (UPI) payments from
 *         customers and receive USDC on Base under a 30-day settlement lock,
 *         then withdraw either as INR to their saved UPI (SELL offramp via
 *         the system proxy, TradeStars/Marketplace pattern) or as USDC to
 *         their wallet.
 *
 *         BUY flow: the merchant places the order (msg.sender), the order is
 *         routed through the merchant's UserProxy clone (B2BGatewayFacet is
 *         proxy-only), recipientAddr = the merchant's proxy and the
 *         integrator registers with usdcThroughIntegrator = false — the
 *         Diamond sends USDC to the proxy at completion and onOrderComplete
 *         pulls it into this contract, where it sits in 30-day settlement
 *         buckets.
 *
 *         SELL flow (INR withdrawal): a system proxy keyed on address(this)
 *         places the sell order (order.user = system proxy); this contract
 *         funds that proxy with the USDC at placement and passes the
 *         merchant's saved upiId as userPubKey. If a sell order is cancelled
 *         on the Diamond, the USDC is refunded to the system proxy;
 *         `reconcileWithdrawal` sweeps it back and re-credits the merchant so
 *         no funds are stranded.
 *
 *         Limits enforced in validateOrder: 50 USDC per transaction and 4
 *         transactions per merchant per UTC day. The system proxy is carved
 *         out so withdrawals never hit merchant buy-side limits.
 */
contract MerchantTerminalIntegrator is IP2PIntegrator {
    using SafeERC20 for IERC20;

    // ─── Errors ───────────────────────────────────────────────────────
    error OnlyDiamond();
    error OnlyOwner();
    error InvalidAddress();
    error AlreadyRegistered();
    error NotRegistered();
    /// @dev Named MerchantIsFrozen because events and errors share one
    ///      identifier namespace and the event MerchantFrozen keeps the
    ///      canonical name (the backend indexes events).
    error MerchantIsFrozen();
    error ExceedsPerTxCap();
    error DailyLimitReached();
    error InsufficientAvailableBalance();
    error NothingToWithdraw();
    error InvalidQuantity();
    error ProductNotFound();
    error TooManyBuckets();
    error Reentrancy();
    error UnknownWithdrawal();
    error WithdrawalNotCancellable();
    error WithdrawalAlreadySettled();

    // ─── Events ───────────────────────────────────────────────────────
    event OrderPlaced(uint256 indexed orderId, address indexed user, uint256 amount);
    event UserProxyDeployed(address indexed user, address proxy);
    event MerchantRegistered(address indexed merchant, string upiId);
    event OrderCompleted(
        uint256 indexed orderId,
        address indexed merchant,
        uint256 amount,
        uint256 unlockTimestamp
    );
    event OrderCancelled(uint256 indexed orderId, address indexed merchant);
    event WithdrawalINR(address indexed merchant, uint256 indexed orderId, uint256 amount);
    event WithdrawalUSDC(address indexed merchant, uint256 amount);
    event WithdrawalReconciled(address indexed merchant, uint256 indexed orderId, uint256 amount);
    event MerchantFrozen(address indexed merchant);
    event MerchantUnfrozen(address indexed merchant);

    // ─── Immutables ───────────────────────────────────────────────────
    address public immutable diamond;
    /// @notice Exposed as a public getter so the canonical UserProxy can
    ///         resolve which token to block from user-initiated sweep —
    ///         UserProxy.sweepERC20 calls `IUsdcSource(integrator()).usdc()`.
    IERC20 public immutable usdc;
    address public immutable owner;
    /// @notice Pinned at deploy. Submit this address alongside the integrator
    ///         address when filing the whitelist request — the Diamond's
    ///         `registerIntegrator(integrator, proxyImpl, source)` records it
    ///         for the CREATE2-auth path that authorizes proxy calls.
    address public immutable proxyImpl;

    // ─── Constants ────────────────────────────────────────────────────
    uint256 public constant PER_TX_CAP = 50 * 1e6; // 50 USDC, 6 decimals
    uint256 public constant DAILY_TX_LIMIT = 4;
    uint256 public constant SETTLEMENT_PERIOD = 30 days;
    /// @dev Hard ceiling on a merchant's stored buckets. Withdrawals compact
    ///      spent buckets, so this bounds the per-call loop cost and prevents
    ///      an unbounded-array gas-griefing / self-DoS surface.
    uint256 public constant MAX_BUCKETS = 256;

    /// @dev Mirrors OrderProcessorStorage.OrderStatus on the Diamond — used
    ///      by reconcileWithdrawal to read the authoritative terminal state.
    uint8 internal constant STATUS_COMPLETED = 3;
    uint8 internal constant STATUS_CANCELLED = 4;

    // ─── State ────────────────────────────────────────────────────────

    struct SettlementBucket {
        uint256 amount;
        uint256 unlockTimestamp;
    }

    struct Merchant {
        address merchantAddr;
        string upiId;
        uint256 totalDeposited;
        bool isFrozen;
        uint256 dailyTxCount;
        uint256 lastTxDate;
        SettlementBucket[] buckets;
    }

    /// @dev Tracks an in-flight INR withdrawal (SELL order) so a Diamond-side
    ///      cancellation can be reconciled: USDC refunded to the system proxy
    ///      is swept back and re-credited to the merchant as a fresh unlocked
    ///      bucket. `settled` is a replay guard.
    struct PendingWithdrawal {
        address merchant;
        uint256 amount;
        bool settled;
    }

    mapping(address => Merchant) public merchants;
    mapping(address => bool) public registered;
    mapping(uint256 => address) public orderToMerchant;
    mapping(uint256 => PendingWithdrawal) public withdrawals;
    /// @notice proxy address => the EOA it was deployed for. Set in
    ///         _ensureProxy. Lets validateOrder recognize a SELL placed by one
    ///         of our own merchant proxies (the carve-out) without trusting a
    ///         caller-supplied address.
    mapping(address => address) public proxyMerchant;

    // ─── Reentrancy guard ─────────────────────────────────────────────
    uint256 private _locked = 1;

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    // ─── Access modifiers ─────────────────────────────────────────────

    modifier onlyDiamond() {
        if (msg.sender != diamond) revert OnlyDiamond();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────

    constructor(address _diamond, address _usdc) {
        if (_diamond == address(0) || _usdc == address(0)) revert InvalidAddress();
        diamond = _diamond;
        usdc = IERC20(_usdc);
        owner = msg.sender;
        // Deploy the canonical UserProxy implementation. Every per-user clone
        // is a `cloneDeterministicWithImmutableArgs` of this address, with
        // `(user, address(this))` packed as the immutable args.
        proxyImpl = address(new UserProxy());
    }

    // ─── Merchant registration ────────────────────────────────────────

    function registerMerchant(string calldata upiId) external {
        if (registered[msg.sender]) revert AlreadyRegistered();
        Merchant storage m = merchants[msg.sender];
        m.merchantAddr = msg.sender;
        m.upiId = upiId;
        registered[msg.sender] = true;
        emit MerchantRegistered(msg.sender, upiId);
    }

    // ─── IP2PIntegrator ───────────────────────────────────────────────

    function validateOrder(
        address user,
        uint256 amount,
        bytes32 /* currency */
    ) external onlyDiamond returns (bool allowed) {
        // SELL self-call: order.user is a merchant's own proxy (owned by this
        // integrator), used as the placer for INR withdrawals. Withdrawal
        // limits were already enforced at the withdraw entry point, so merchant
        // buy-side limits do not apply here. proxyMerchant is set only for
        // proxies this contract deployed, so an arbitrary address cannot spoof
        // the carve-out.
        if (proxyMerchant[user] != address(0)) return true;

        if (!registered[user]) revert NotRegistered();
        Merchant storage m = merchants[user];
        if (m.isFrozen) revert MerchantIsFrozen();
        if (amount > PER_TX_CAP) revert ExceedsPerTxCap();

        uint256 today = block.timestamp / 86400;
        if (m.lastTxDate != today) {
            m.dailyTxCount = 0;
            m.lastTxDate = today;
        }
        if (m.dailyTxCount >= DAILY_TX_LIMIT) revert DailyLimitReached();
        m.dailyTxCount++;
        return true;
    }

    function onOrderComplete(
        uint256 orderId,
        address user,
        uint256 amount,
        address /* recipientAddr */
    ) external onlyDiamond {
        // recipientAddr = the merchant's proxy (usdcThroughIntegrator =
        // false): the Diamond just sent USDC there. Pull it into this
        // integrator, where it sits until the settlement bucket unlocks.
        UserProxy(proxyAddress(user)).transferERC20ToIntegrator(address(usdc), amount);

        _creditBucket(merchants[user], amount, block.timestamp + SETTLEMENT_PERIOD);
        merchants[user].totalDeposited += amount;

        emit OrderCompleted(orderId, user, amount, block.timestamp + SETTLEMENT_PERIOD);
    }

    /// @notice Best-effort: releases the daily-count slot consumed in
    ///         validateOrder. Tolerates unknown orderIds; deletes the
    ///         orderToMerchant entry so a repeated cancellation cannot
    ///         double-decrement.
    function onOrderCancel(uint256 orderId) external onlyDiamond {
        address merchant = orderToMerchant[orderId];
        if (merchant == address(0)) return; // SELL or unknown — nothing to release
        Merchant storage m = merchants[merchant];
        if (m.dailyTxCount > 0) {
            m.dailyTxCount--;
        }
        delete orderToMerchant[orderId];
        emit OrderCancelled(orderId, merchant);
    }

    // ─── Order entry point (merchant-driven POS flow) ─────────────────

    function userPlaceOrder(
        address client,
        uint256 productId,
        uint256 quantity,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey
    ) external nonReentrant returns (uint256 orderId) {
        uint256 unitPrice = ICheckoutClient(client).getProductPrice(productId);
        if (unitPrice == 0) revert ProductNotFound();
        if (quantity == 0) revert InvalidQuantity();
        uint256 total = unitPrice * quantity;

        address proxy = _ensureProxy(msg.sender);
        // recipientAddr = the merchant's proxy: with usdcThroughIntegrator =
        // false the Diamond sends USDC there at completion and
        // onOrderComplete pulls it into this contract.
        bytes memory data = abi.encodeCall(
            IB2BGateway.placeB2BOrder,
            (msg.sender, total, currency, proxy, pubKey, circleId, 0, 0)
        );
        bytes memory result = UserProxy(proxy).execute(diamond, data, address(usdc), 0);
        orderId = abi.decode(result, (uint256));

        // validateOrder receives no orderId (the Diamond assigns it after
        // validation) — record the merchant here so onOrderCancel can
        // release the daily-count slot.
        orderToMerchant[orderId] = msg.sender;

        emit OrderPlaced(orderId, msg.sender, total);
    }

    // ─── Withdrawals ──────────────────────────────────────────────────

    /// @notice Withdraw unlocked USDC as INR to the merchant's saved UPI.
    ///         Places a SELL order through the MERCHANT'S OWN proxy (order.user
    ///         = merchant proxy) funded at placement; the Diamond pulls the
    ///         USDC from the proxy during settlement. Each merchant uses their
    ///         own proxy so in-flight withdrawal funds are physically isolated
    ///         per merchant — a cancellation of one merchant's order can never
    ///         touch another merchant's parked funds. The withdrawal is tracked
    ///         so a Diamond-side cancellation can be reconciled (funds returned).
    function withdrawINR(uint256 amount) external nonReentrant returns (uint256 orderId) {
        Merchant storage m = _checkWithdraw(amount);
        _deductUnlocked(m, amount);

        // Per-merchant proxy: funds for THIS merchant's SELL sit only on the
        // merchant's own proxy, never commingled with other merchants'.
        address merchantProxy = _ensureProxy(msg.sender);
        usdc.safeTransfer(merchantProxy, amount);
        bytes memory data = abi.encodeCall(
            IB2BGateway.placeB2BSellOrder,
            (merchantProxy, amount, bytes32("INR"), m.upiId, 0, 0, 0)
        );
        bytes memory result = UserProxy(merchantProxy).execute(diamond, data, address(usdc), 0);
        orderId = abi.decode(result, (uint256));

        withdrawals[orderId] = PendingWithdrawal({
            merchant: msg.sender,
            amount: amount,
            settled: false
        });

        emit WithdrawalINR(msg.sender, orderId, amount);
    }

    /// @notice Withdraw unlocked USDC straight to the merchant's wallet.
    ///         Funds sit on this integrator (pulled at onOrderComplete).
    function withdrawUSDC(uint256 amount) external nonReentrant {
        Merchant storage m = _checkWithdraw(amount);
        _deductUnlocked(m, amount);

        usdc.safeTransfer(msg.sender, amount);

        emit WithdrawalUSDC(msg.sender, amount);
    }

    /// @notice Recover an INR withdrawal whose SELL order the Diamond
    ///         cancelled WITHOUT the merchant receiving fiat. Reads the
    ///         authoritative order from the Diamond (not a caller argument),
    ///         sweeps the refunded USDC off the MERCHANT'S OWN proxy, and
    ///         re-credits that merchant. Permissionless on purpose — anyone
    ///         can trigger recovery; the merchant is the only beneficiary.
    ///
    ///         Two safety properties vs. a naive "status == CANCELLED" check:
    ///         (1) funds are read from the merchant's own proxy, so attribution
    ///         is exact — no other merchant's parked funds can be swept; and
    ///         (2) we refuse to re-credit an order that shows evidence of fiat
    ///         delivery (an open/closed dispute), which would otherwise let a
    ///         merchant keep the INR AND reclaim USDC.
    function reconcileWithdrawal(uint256 orderId) external nonReentrant {
        PendingWithdrawal storage w = withdrawals[orderId];
        if (w.merchant == address(0)) revert UnknownWithdrawal();
        if (w.settled) revert WithdrawalAlreadySettled();

        IOrderFlow.OrderView memory order = IOrderFlow(diamond).getOrdersById(orderId);
        if (order.status != STATUS_CANCELLED) revert WithdrawalNotCancellable();
        // Guard against double-spend: an order that carries any dispute may
        // have had fiat delivered to the merchant's UPI before cancellation.
        // Refuse to re-credit USDC in that case — the merchant already got INR.
        if (order.disputeInfo.status != 0 || order.disputeInfo.raisedBy != 0)
            revert WithdrawalNotCancellable();

        w.settled = true;

        // The cancelled order's USDC sits on the MERCHANT'S OWN proxy (funded
        // at placement; the Diamond refunds there on cancel). Because the proxy
        // is per-merchant, its balance is unambiguously this merchant's — no
        // cross-merchant attribution problem. Cap by the recorded amount and by
        // the proxy's actual balance (floor guard against a partial refund).
        address merchantProxy = _ensureProxy(w.merchant);
        uint256 proxyBal = usdc.balanceOf(merchantProxy);
        uint256 recovered = w.amount < proxyBal ? w.amount : proxyBal;
        if (recovered > 0) {
            UserProxy(merchantProxy).transferERC20ToIntegrator(address(usdc), recovered);
        }

        // Re-credit the merchant exactly what was recovered for their order.
        // Already past settlement (they withdrew from unlocked funds), so
        // unlock immediately. unlockTimestamp must be strictly < now to count
        // as available in getMerchantBalance, so use block.timestamp - 1.
        _creditBucket(merchants[w.merchant], recovered, block.timestamp - 1);

        emit WithdrawalReconciled(w.merchant, orderId, recovered);
    }

    /// @notice Mark an INR withdrawal as successfully completed (frees the
    ///         tracking slot). Permissionless; only flips a withdrawal whose
    ///         Diamond status is COMPLETED, so it cannot be abused to block
    ///         a legitimate reconciliation.
    function finalizeWithdrawal(uint256 orderId) external {
        PendingWithdrawal storage w = withdrawals[orderId];
        if (w.merchant == address(0)) revert UnknownWithdrawal();
        if (w.settled) revert WithdrawalAlreadySettled();
        uint8 status = IOrderFlow(diamond).getOrdersById(orderId).status;
        if (status != STATUS_COMPLETED) revert WithdrawalNotCancellable();
        w.settled = true;
    }

    function _checkWithdraw(uint256 amount) internal view returns (Merchant storage m) {
        if (!registered[msg.sender]) revert NotRegistered();
        m = merchants[msg.sender];
        if (m.isFrozen) revert MerchantIsFrozen();
        if (amount == 0) revert NothingToWithdraw();
    }

    /// @dev Append an unlocked/locked bucket, compacting fully-spent buckets
    ///      first so the array stays bounded by MAX_BUCKETS.
    function _creditBucket(Merchant storage m, uint256 amount, uint256 unlockTimestamp) internal {
        _compact(m);
        if (m.buckets.length >= MAX_BUCKETS) revert TooManyBuckets();
        m.buckets.push(SettlementBucket({ amount: amount, unlockTimestamp: unlockTimestamp }));
    }

    /// @dev Removes ALL fully-spent (amount == 0) buckets, preserving order of
    ///      the live ones. A stable compaction: spent buckets can appear
    ///      anywhere (a locked bucket can sit in front of a spent unlocked
    ///      one), so a head-only pass would leave interior zeros and let the
    ///      array drift toward MAX_BUCKETS. This pass reclaims every zero.
    function _compact(Merchant storage m) internal {
        uint256 len = m.buckets.length;
        uint256 write = 0;
        for (uint256 read = 0; read < len; read++) {
            if (m.buckets[read].amount != 0) {
                if (write != read) {
                    m.buckets[write] = m.buckets[read];
                }
                write++;
            }
        }
        // Pop the tail left after compaction (len - write spent slots).
        while (m.buckets.length > write) {
            m.buckets.pop();
        }
    }

    /// @dev Sums unlocked buckets, reverts if short, then deducts
    ///      oldest-first (buckets are pushed chronologically).
    function _deductUnlocked(Merchant storage m, uint256 amount) internal {
        uint256 unlocked = 0;
        uint256 len = m.buckets.length;
        for (uint256 i = 0; i < len; i++) {
            if (m.buckets[i].unlockTimestamp < block.timestamp) {
                unlocked += m.buckets[i].amount;
            }
        }
        if (unlocked < amount) revert InsufficientAvailableBalance();

        uint256 remaining = amount;
        for (uint256 i = 0; i < len && remaining > 0; i++) {
            SettlementBucket storage b = m.buckets[i];
            if (b.unlockTimestamp >= block.timestamp || b.amount == 0) continue;
            uint256 take = b.amount < remaining ? b.amount : remaining;
            b.amount -= take;
            remaining -= take;
        }
    }

    // ─── Admin ────────────────────────────────────────────────────────

    function freezeMerchant(address merchant) external onlyOwner {
        merchants[merchant].isFrozen = true;
        emit MerchantFrozen(merchant);
    }

    function unfreezeMerchant(address merchant) external onlyOwner {
        merchants[merchant].isFrozen = false;
        emit MerchantUnfrozen(merchant);
    }

    // ─── Views ────────────────────────────────────────────────────────

    /// @notice Balances derived from buckets at the current timestamp —
    ///         `pending` counts only still-locked buckets, `available` only
    ///         unlocked ones.
    function getMerchantBalance(
        address merchant
    )
        external
        view
        returns (uint256 pending, uint256 available, uint256 totalDeposited, bool isFrozen)
    {
        Merchant storage m = merchants[merchant];
        uint256 len = m.buckets.length;
        for (uint256 i = 0; i < len; i++) {
            if (m.buckets[i].unlockTimestamp < block.timestamp) {
                available += m.buckets[i].amount;
            } else {
                pending += m.buckets[i].amount;
            }
        }
        return (pending, available, m.totalDeposited, m.isFrozen);
    }

    /// @notice The public `merchants` auto-getter omits the buckets array —
    ///         this exposes it for tests and the dashboard.
    function getMerchantBuckets(
        address merchant
    ) external view returns (SettlementBucket[] memory) {
        return merchants[merchant].buckets;
    }

    function getDailyTxInfo(
        address merchant
    ) external view returns (uint256 usedToday, uint256 limit) {
        Merchant storage m = merchants[merchant];
        uint256 today = block.timestamp / 86400;
        usedToday = m.lastTxDate == today ? m.dailyTxCount : 0;
        return (usedToday, DAILY_TX_LIMIT);
    }

    // ─── Proxy helpers (mirror ExampleIntegrator exactly) ─────────────

    /// @notice Predicts the deterministic UserProxy address for `user`.
    ///         The clone may not yet be deployed — check `code.length` if
    ///         you need to know.
    function proxyAddress(address user) public view returns (address) {
        return
            Clones.predictDeterministicAddressWithImmutableArgs(
                proxyImpl,
                _proxyArgs(user),
                _salt(user),
                address(this)
            );
    }

    /// @dev Salt is the user EOA only. The "deployer" component of the
    ///      CREATE2 address derivation is the integrator (this contract),
    ///      so a (integrator, user) pair maps to exactly one proxy address.
    function _salt(address user) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(user)));
    }

    /// @dev Immutable args layout: [owner(20)][integrator(20)] — 40 bytes.
    ///      UserProxy.owner() and UserProxy.integrator() read these slots
    ///      via `Clones.fetchCloneArgs(address(this))`. The Diamond's
    ///      CREATE2-auth path reconstructs the same args from the registered
    ///      proxyImpl + user salt, so DO NOT change the layout.
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
            // Record proxy => owner so validateOrder can recognize a SELL
            // placed by one of our own merchant proxies.
            proxyMerchant[proxy] = user;
            emit UserProxyDeployed(user, proxy);
        }
    }
}
