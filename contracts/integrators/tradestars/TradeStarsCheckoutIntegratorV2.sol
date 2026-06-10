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
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Minimal view surface for the Diamond's small-order fee config, used
///         to compute the SELL fee up front so the proxy can be checked for
///         `principal + fee` before placing a draw.
interface IDiamondSmallOrderFees {
    function getSmallOrderThreshold(bytes32 currency) external view returns (uint256);
    function getSmallOrderFixedFeeSell(bytes32 currency) external view returns (uint256);
    function getSmallOrderFixedFee(bytes32 currency) external view returns (uint256);
}

/**
 * @title TradeStarsCheckoutIntegratorV2
 * @notice User-driven offramp ("offramp v2"). Supersedes the relayer-driven
 *         offramp on {TradeStarsCheckoutIntegrator}. The BUY (onramp) surface
 *         is unchanged from v1.
 *
 *         OFFRAMP MODEL (single-tx, voucher-attested)
 *         -------------------------------------------
 *         1. The attester (`offrampRelayer` key) observes a Solana tUSDC burn
 *            and SIGNS an EIP-712 `OfframpVoucher(burnTx, solPubkey, user,
 *            amount, deadline)` OFF-CHAIN. It never sends a transaction — the
 *            offramp has NO relayer write path at all.
 *         2. The USER (their Base wallet, gasless via paymaster) calls
 *            `userRedeemAndStartOfframp(voucher, sig, principal, ...)` — ONE
 *            Base tx that atomically (a) verifies the voucher + burn dedupe,
 *            (b) releases `voucher.amount` from the vault into the user's
 *            *own* per-user proxy (the same proxy keyed on the user EOA that
 *            BUY uses), pooling it with any prior balance, and (c) places the
 *            SELL on the Diamond *through that proxy*, so `order.user == the
 *            proxy` — the Diamond pulls/refunds USDC there and the order is
 *            attributable to the user (not a shared system proxy), so it shows
 *            in their P2P history. The small-order fee is funded from the
 *            proxy balance too (never subsidised), so a draw needing more than
 *            is available is rejected up front.
 *            Partial/subsequent draws of an already-redeemed balance use
 *            `userStartOfframp(principal, ...)` — same placement, no voucher.
 *         3. The USER calls `userDeliverOfframpUpi(orderId, encUpi)` once a
 *            merchant accepts. The Diamond pulls `actualUsdtAmount` from the
 *            proxy → PAID → merchant pays fiat → COMPLETED.
 *         4. If the order is cancelled (merchant no-show / dispute / timeout),
 *            the Diamond refunds USDC to the proxy. The user simply calls
 *            `userStartOfframp` again — the voucher is already redeemed, the
 *            funds sit in their proxy. Self-serve retry/redraw, no relayer/owner.
 *         5. `syncOfframp(orderId)` (permissionless) records the terminal
 *            status and frees the in-flight slot. Allocated USDC stays in the
 *            user's proxy until they draw it down — there is no owner reclaim.
 *
 *         USDC remains trapped in the proxy throughout — it can leave only via
 *         the Diamond pulling it for the SELL (→ fiat to the user off-chain). It
 *         can never reach the user EOA. See docs/OFFRAMP-V2.md.
 */
contract TradeStarsCheckoutIntegratorV2 is IP2PIntegrator, EIP712 {
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
    error VaultNotSet();
    error BurnAlreadyProcessed();
    error OfframpAmountTooLarge();
    error OfframpRecordNotFound();
    /// @notice Voucher signature does not recover to the offramp attester key.
    error InvalidVoucherSignature();
    /// @notice Voucher deadline has passed — ask the attester to re-sign.
    error VoucherExpired();
    /// @notice Only the user named in the voucher may redeem it (the SELL is
    ///         placed as `msg.sender`, so redemption is bound to that wallet).
    error OnlyVoucherUser();
    /// @notice setSellOrderUpi funding tried to read `actualUsdtAmount` from the
    ///         Diamond before it was computed (returned 0). Funding the proxy
    ///         short of principal+fee would make the Diamond's transferFrom
    ///         underflow and auto-cancel. Surface explicitly so the user retries
    ///         once the Diamond has populated it.
    error OfframpFeeNotReady();
    /// @notice Caller is not the proxy owner who placed this order.
    error OnlyOrderOwner();
    /// @notice The user already has a non-terminal SELL in flight; finish or let
    ///         it cancel before placing another (one at a time) / reclaiming.
    error OfframpInFlight();
    /// @notice Proxy balance can't cover the requested principal + small-order
    ///         fee. The fee is funded from the user's own balance — never
    ///         subsidised — so a draw that needs more than is available is
    ///         rejected up front (no late setSellOrderUpi failure).
    error OfframpInsufficientBalance();

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
    event UsdcDepositedToVault(uint256 indexed orderId, uint256 amount);

    // Offramp v2 lifecycle
    /// @notice A signed voucher was redeemed — `amount` moved from the vault
    ///         into the user's proxy (inside the user's own redeem+place tx).
    event OfframpAllocated(
        uint256 indexed allocationId,
        address indexed user,
        address proxy,
        uint256 amount,
        bytes32 indexed solanaBurnTx,
        bytes32 solanaUserPubkey
    );
    /// @notice User drew `principal` from their pooled proxy balance as a SELL.
    event OfframpOrderPlaced(uint256 indexed orderId, address indexed user, uint256 principal);
    event OfframpUpiDelivered(uint256 indexed orderId);
    /// @notice Order COMPLETED — fiat sent for this draw.
    event OfframpSettled(uint256 indexed orderId, address indexed user);
    /// @notice Order CANCELLED — USDC refunded to the proxy; user may retry/redraw.
    event OfframpCancelled(uint256 indexed orderId, address indexed user);

    // ─── Constants ────────────────────────────────────────────────────

    /// @notice Mirrors OrderProcessorStorage.OrderStatus on the P2P Diamond.
    uint8 internal constant STATUS_PLACED = 0;
    uint8 internal constant STATUS_ACCEPTED = 1;
    uint8 internal constant STATUS_PAID = 2;
    uint8 internal constant STATUS_COMPLETED = 3;
    uint8 internal constant STATUS_CANCELLED = 4;

    /// @notice EIP-712 typehash for the burn attestation the offramp attester
    ///         signs off-chain. Field order must match `OfframpVoucher`.
    bytes32 internal constant OFFRAMP_VOUCHER_TYPEHASH =
        keccak256(
            "OfframpVoucher(bytes32 solanaBurnTx,bytes32 solanaUserPubkey,address user,uint256 amount,uint256 deadline)"
        );

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
    /// @notice The offramp ATTESTER key. It only signs `OfframpVoucher`s
    ///         off-chain — it has no on-chain write path in the offramp.
    ///         (Name kept from v2 so ops/tooling references stay valid.)
    address public offrampRelayer;
    uint256 public maxUsdcPerOfframp;

    // ─── Offramp v2 allocation state (pooled-proxy model) ─────────────
    //
    // An allocation is a *funding* record: the relayer moves `amount` into the
    // user's proxy and logs it (for burn-dedup + audit). Withdrawals are NOT
    // tied to a single allocation — the user draws any principal from the
    // pooled proxy balance, in as many parts as they like, until it's drained.
    // The proxy USDC balance is the single source of truth for what's cashable.

    struct OfframpAllocation {
        address user; // Base EOA = proxy owner
        uint256 amount; // USDC moved into the proxy (burned principal)
        bytes32 solanaBurnTx;
        bytes32 solanaUserPubkey;
        uint64 allocatedAt;
    }

    mapping(uint256 => OfframpAllocation) public allocations;
    /// @notice solanaBurnTx → allocationId. Non-zero ⇒ already processed.
    mapping(bytes32 => uint256) public burnToAllocation;
    /// @notice Diamond orderId → the user (proxy owner) who placed the draw.
    mapping(uint256 => address) public orderToUser;
    /// @notice User's current SELL draw (0 = none). One in-flight at a time;
    ///         a new draw is allowed once the prior order is terminal.
    mapping(address => uint256) public userActiveOrder;
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

    // ─── Constructor ──────────────────────────────────────────────────

    constructor(
        address _diamond,
        address _usdc,
        uint256 _baseTxLimit,
        uint256 _dailyTxCountLimit
    ) EIP712("TradeStarsOfframp", "1") {
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
        // Our own offramp SELL placement (_startOfframp). The draw is already
        // bounded by the attested voucher amount (≤ maxUsdcPerOfframp) and the
        // proxy balance; per-user BUY limits do not apply.
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

    // ─── Offramp v3: voucher-attested single-tx redeem + draw ─────────

    /// @notice Burn attestation signed off-chain by `offrampRelayer`. The
    ///         signature authorises moving `amount` from the vault into
    ///         `user`'s proxy exactly once (keyed on `solanaBurnTx`).
    struct OfframpVoucher {
        bytes32 solanaBurnTx;
        bytes32 solanaUserPubkey;
        address user; // Base EOA that may redeem (and whose proxy is funded)
        uint256 amount; // USDC released from the vault, 6 decimals
        uint256 deadline; // unix seconds; attester re-signs if it lapses
    }

    /**
     * @notice User-only, ONE Base tx for the whole offramp entry: verify the
     *         attester-signed voucher, release `voucher.amount` from the vault
     *         into the caller's own proxy (pooled with any prior balance), and
     *         place a SELL for `principal` on the Diamond through that proxy.
     *
     *         `principal` may be less than `voucher.amount` (the remainder
     *         stays pooled in the proxy) or more (if a prior balance covers
     *         the difference) — placement is bounded only by the proxy
     *         balance, exactly like `userStartOfframp`.
     *
     *         The voucher is single-use (burn-tx dedupe). Retries after a
     *         cancel do NOT need a new voucher — the funds are already in the
     *         proxy; call `userStartOfframp`.
     */
    function userRedeemAndStartOfframp(
        OfframpVoucher calldata voucher,
        bytes calldata signature,
        uint256 principal,
        bytes32 currency,
        uint256 fiatAmount,
        uint256 circleId,
        uint256 preferredPaymentChannelConfigId,
        string calldata userPubKey
    ) external returns (uint256 orderId) {
        if (!offrampEnabled) revert OfframpDisabled();
        if (address(yieldVault) == address(0)) revert VaultNotSet();
        if (msg.sender != voucher.user) revert OnlyVoucherUser();
        if (voucher.amount == 0) revert InvalidAmount();
        if (voucher.solanaBurnTx == bytes32(0)) revert InvalidSolanaRecipient();
        if (block.timestamp > voucher.deadline) revert VoucherExpired();
        if (burnToAllocation[voucher.solanaBurnTx] != 0) revert BurnAlreadyProcessed();
        if (maxUsdcPerOfframp != 0 && voucher.amount > maxUsdcPerOfframp) {
            revert OfframpAmountTooLarge();
        }

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    OFFRAMP_VOUCHER_TYPEHASH,
                    voucher.solanaBurnTx,
                    voucher.solanaUserPubkey,
                    voucher.user,
                    voucher.amount,
                    voucher.deadline
                )
            )
        );
        if (ECDSA.recover(digest, signature) != offrampRelayer) revert InvalidVoucherSignature();

        // Reserve leg: vault → caller's proxy. The vault reverts if its
        // balance can't service this.
        yieldVault.releaseForOfframp(voucher.amount);
        address proxy = _ensureProxy(voucher.user);
        IERC20(usdc).safeTransfer(proxy, voucher.amount);

        uint256 allocationId = ++nextAllocationId;
        allocations[allocationId] = OfframpAllocation({
            user: voucher.user,
            amount: voucher.amount,
            solanaBurnTx: voucher.solanaBurnTx,
            solanaUserPubkey: voucher.solanaUserPubkey,
            allocatedAt: uint64(block.timestamp)
        });
        burnToAllocation[voucher.solanaBurnTx] = allocationId;
        _userAllocations[voucher.user].push(allocationId);

        emit OfframpAllocated(
            allocationId,
            voucher.user,
            proxy,
            voucher.amount,
            voucher.solanaBurnTx,
            voucher.solanaUserPubkey
        );

        // Withdraw leg: place the SELL in the same tx. Reverts here roll the
        // reserve leg back too — the voucher stays unredeemed.
        orderId = _startOfframp(
            principal,
            currency,
            fiatAmount,
            circleId,
            preferredPaymentChannelConfigId,
            userPubKey
        );
    }

    // ─── Offramp v2: user-driven lifecycle ────────────────────────────

    /**
     * @notice User-only. Draw `principal` from the pooled USDC sitting in the
     *         caller's own proxy and place a SELL for it on the Diamond.
     *         Callable repeatedly — any principal up to the available balance,
     *         in as many parts as the user likes, one in-flight order at a time.
     *         `order.user` is the proxy, so the Diamond pulls/refunds USDC there
     *         and the order shows in the user's P2P history.
     *
     *         The small-order fee (when `principal` is at or below the Diamond's
     *         threshold) is paid from the proxy balance too — never subsidised.
     *         The draw is rejected up front unless the proxy holds
     *         `principal + fee`, so a user can't withdraw an amount that would
     *         leave the fee uncovered (→ `OfframpInsufficientBalance`).
     */
    function userStartOfframp(
        uint256 principal,
        bytes32 currency,
        uint256 fiatAmount,
        uint256 circleId,
        uint256 preferredPaymentChannelConfigId,
        string calldata userPubKey
    ) external returns (uint256 orderId) {
        if (!offrampEnabled) revert OfframpDisabled();
        orderId = _startOfframp(
            principal,
            currency,
            fiatAmount,
            circleId,
            preferredPaymentChannelConfigId,
            userPubKey
        );
    }

    /// @dev Shared placement body for `userStartOfframp` (pooled-balance draw)
    ///      and `userRedeemAndStartOfframp` (same draw right after the reserve
    ///      leg funded the proxy). `msg.sender` is the drawing user in both.
    function _startOfframp(
        uint256 principal,
        bytes32 currency,
        uint256 fiatAmount,
        uint256 circleId,
        uint256 preferredPaymentChannelConfigId,
        string calldata userPubKey
    ) internal returns (uint256 orderId) {
        if (principal == 0) revert InvalidAmount();

        // One in-flight draw per user: the prior order must be terminal
        // (COMPLETED or CANCELLED) before the next part.
        uint256 active = userActiveOrder[msg.sender];
        if (active != 0) {
            uint8 st = _diamondStatus(active);
            if (st != STATUS_COMPLETED && st != STATUS_CANCELLED) revert OfframpInFlight();
        }

        address proxy = _ensureProxy(msg.sender);
        uint256 needed = principal + _sellFee(currency, principal);
        if (IERC20(usdc).balanceOf(proxy) < needed) revert OfframpInsufficientBalance();

        bytes memory data = abi.encodeCall(
            IB2BGateway.placeB2BSellOrder,
            (
                proxy,
                principal,
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
        userActiveOrder[msg.sender] = orderId;
        orderToUser[orderId] = msg.sender;

        emit OfframpOrderPlaced(orderId, msg.sender, principal);
    }

    /**
     * @notice User-only. Forward the encrypted payout address to the Diamond,
     *         triggering the PAID transition (the Diamond pulls actualUsdtAmount
     *         = principal + fee from the proxy). `userStartOfframp` already
     *         guaranteed the proxy holds it — there is NO integrator-float
     *         subsidy; if the proxy is somehow short the call reverts.
     */
    function userDeliverOfframpUpi(uint256 orderId, string calldata encUpi) external {
        address user = orderToUser[orderId];
        if (user == address(0)) revert OfframpRecordNotFound();
        if (msg.sender != user) revert OnlyOrderOwner();

        IOrderFlow.AdditionalOrderDetailsView memory aod = IOrderFlow(diamond)
            .getAdditionalOrderDetails(orderId);
        uint256 needed = aod.actualUsdtAmount; // principal + fee
        if (needed == 0) revert OfframpFeeNotReady();

        address proxy = _ensureProxy(user);
        if (IERC20(usdc).balanceOf(proxy) < needed) revert OfframpInsufficientBalance();

        bytes memory data = abi.encodeCall(IOrderFlow.setSellOrderUpi, (orderId, encUpi, 0));
        UserProxy(proxy).execute(diamond, data, usdc, needed);

        emit OfframpUpiDelivered(orderId);
    }

    /**
     * @notice Permissionless. Read the Diamond's authoritative terminal status
     *         and clear the user's in-flight slot so they can start the next
     *         draw. On CANCELLED the USDC is back in the proxy (redraw/retry);
     *         nothing is returned to the vault here. Optional bookkeeping —
     *         `userStartOfframp` also tolerates a terminal prior order directly.
     */
    function syncOfframp(uint256 orderId) external {
        address user = orderToUser[orderId];
        if (user == address(0)) revert OfframpRecordNotFound();

        uint8 status = _diamondStatus(orderId);
        if (status != STATUS_COMPLETED && status != STATUS_CANCELLED) revert StatusNotTerminal();

        if (userActiveOrder[user] == orderId) userActiveOrder[user] = 0;

        if (status == STATUS_COMPLETED) {
            emit OfframpSettled(orderId, user);
        } else {
            emit OfframpCancelled(orderId, user);
        }
    }

    error StatusNotTerminal();

    // ─── Offramp v2: views ────────────────────────────────────────────

    /// @notice Cashable balance for `user` — simply the USDC pooled in their
    ///         proxy. The widget shows this; the user draws any principal
    ///         (+ fee) up to it, in as many parts as they like.
    function availableOfframp(address user) external view returns (uint256) {
        return IERC20(usdc).balanceOf(proxyAddress(user));
    }

    /// @notice All allocation ids that funded `user`'s proxy (audit/history).
    function getUserAllocations(address user) external view returns (uint256[] memory) {
        return _userAllocations[user];
    }

    function getAllocation(uint256 allocationId) external view returns (OfframpAllocation memory) {
        return allocations[allocationId];
    }

    /// @notice EIP-712 digest the attester must sign for `voucher`. Exposed so
    ///         off-chain signers/tests can cross-check their typed-data hashing
    ///         against the contract's domain (name/version/chainId/address).
    function hashOfframpVoucher(OfframpVoucher calldata voucher) external view returns (bytes32) {
        return
            _hashTypedDataV4(
                keccak256(
                    abi.encode(
                        OFFRAMP_VOUCHER_TYPEHASH,
                        voucher.solanaBurnTx,
                        voucher.solanaUserPubkey,
                        voucher.user,
                        voucher.amount,
                        voucher.deadline
                    )
                )
            );
    }

    /// @notice Principal + small-order fee the Diamond will charge for a SELL of
    ///         `principal` in `currency`. Mirrors `libOrderProcessorFacet`: the
    ///         fixed fee applies when `principal <= smallOrderThreshold`. Prefers
    ///         the per-type SELL getter (V22+) and falls back to the unified
    ///         getter (pre-V22) — both read the `smallOrderFixedFee` the Diamond
    ///         actually charges for SELL.
    function _sellFee(bytes32 currency, uint256 principal) internal view returns (uint256) {
        if (principal > IDiamondSmallOrderFees(diamond).getSmallOrderThreshold(currency)) {
            return 0;
        }
        try IDiamondSmallOrderFees(diamond).getSmallOrderFixedFeeSell(currency) returns (
            uint256 fee
        ) {
            return fee;
        } catch {
            return IDiamondSmallOrderFees(diamond).getSmallOrderFixedFee(currency);
        }
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
