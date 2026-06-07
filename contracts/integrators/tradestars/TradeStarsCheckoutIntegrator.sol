// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { IOrderFlow } from "../../interfaces/IOrderFlow.sol";
import { IRestrictedYieldVault } from "./IRestrictedYieldVault.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

/**
 * @title TradeStarsCheckoutIntegrator
 * @notice Integrator for the TradeStars checkout flow.
 *
 *         All Diamond placement now flows through a UserProxy clone owned by
 *         this integrator (B2BGatewayFacet is proxy-only — it rejects direct
 *         integrator calls).
 *
 *         Two proxy roles:
 *           - Per-user proxy keyed on the buyer's EOA — used for BUY (matches
 *             LotPot). order.user = user EOA, recipientAddr = integrator,
 *             usdcThroughIntegrator = true. The proxy is just the placer.
 *           - System proxy keyed on address(this) (owner = integrator) — used
 *             for SELL offramps where the user has no Base identity. order.user
 *             = system proxy. The integrator transfers USDC to the system proxy
 *             just-in-time before setSellOrderUpi so the Diamond can pull it.
 *
 *         Limits (RP / daily count) are enforced by validateOrder on this
 *         contract; the gateway delegates protocol-side checks to us.
 */
contract TradeStarsCheckoutIntegrator is IP2PIntegrator {
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
    /// @notice Diamond's onOrderComplete callback passed an `amount` that
    ///         doesn't match the session's recorded usdcAmount. Defense-in-
    ///         depth: under correct gateway bookkeeping this is impossible,
    ///         but reverting makes any future divergence loud rather than
    ///         silently depositing the wrong amount to the vault.
    error AmountMismatch();

    // Offramp
    error OfframpDisabled();
    error OnlyOfframpRelayer();
    error VaultNotSet();
    error BurnAlreadyProcessed();
    error OfframpAmountTooLarge();
    error OfframpRecordNotFound();
    error OfframpAlreadyReconciled();
    error OfframpInsufficientPool();
    /// @notice deliverOfframpUpi tried to fund the system proxy but Diamond
    ///         hasn't computed actualUsdtAmount yet (returned 0). Without
    ///         the fee component, transferFrom inside setSellOrderUpi would
    ///         underflow and Diamond would auto-cancel the order. Surface
    ///         this explicitly so the relayer retries instead of shipping a
    ///         doomed transaction.
    error OfframpFeeNotReady();
    /// @notice deliverOfframpUpi was already called for this order. Replay
    ///         guard — without it a duplicate relayer call would re-fund
    ///         the system proxy before Diamond reverted the duplicate
    ///         setSellOrderUpi. The outer revert rolls everything back
    ///         today, but the guard removes the cross-contract trust
    ///         coupling.
    error OfframpAlreadyDelivered();
    /// @notice reconcile was called but Diamond's order isn't yet in a
    ///         terminal state (COMPLETED or CANCELLED). Caller should wait
    ///         for the merchant to complete or Diamond to expire/cancel.
    error StatusNotTerminal();

    // ─── Events ───────────────────────────────────────────────────────

    event CheckoutOrderCreated(
        uint256 indexed orderId,
        address indexed user,
        bytes32 indexed solanaRecipient,
        uint256 amount
    );

    /// @notice Emitted when an order is fulfilled on Base. `user` is a Solana
    ///         pubkey (32 bytes) — the relayer uses this as the mint recipient.
    event CheckoutFulfilled(uint256 indexed orderId, bytes32 indexed user, uint256 amount);

    event UserProxyDeployed(address indexed user, address proxy);

    event UserRPUpdated(address indexed user, uint256 rp);
    event RpRateUpdated(bytes32 indexed currency, uint256 usdcPerRp);
    event BaseTxLimitUpdated(uint256 limit);
    event MaxTxLimitUpdated(bytes32 indexed currency, uint256 cap);
    event DailyTxCountLimitUpdated(uint256 count);

    // Offramp / vault
    event YieldVaultUpdated(address indexed vault);
    event OfframpRelayerUpdated(address indexed relayer);
    event OfframpEnabledUpdated(bool enabled);
    event MaxUsdcPerOfframpUpdated(uint256 cap);
    event UsdcDepositedToVault(uint256 indexed orderId, uint256 amount);
    event OfframpInitiated(
        uint256 indexed orderId,
        bytes32 indexed solanaBurnTx,
        bytes32 indexed solanaUserPubkey,
        uint256 usdcAmount
    );
    event OfframpUpiDelivered(uint256 indexed orderId);
    event OfframpReconciled(uint256 indexed orderId, uint8 newStatus, uint256 usdcReturnedToVault);

    /// @notice Emitted when the Diamond cancels a BUY order before fulfillment
    ///         and invokes the integrator's onOrderCancel hook. Mirrors LotPot's
    ///         `LotPotOrderCancelled` so off-chain consumers have a single
    ///         place to observe checkout lifecycle exits.
    event OrderCancelled(uint256 indexed orderId, address indexed user);

    // ─── Constants ────────────────────────────────────────────────────

    /// @notice Mirrors OrderProcessorStorage.OrderStatus on the P2P Diamond.
    ///         Hardcoded here so reconcile + offramp record bookkeeping can
    ///         reference the terminal values without an interface roundtrip.
    uint8 internal constant STATUS_COMPLETED = 3;
    uint8 internal constant STATUS_CANCELLED = 4;

    // ─── Immutables ───────────────────────────────────────────────────

    address public immutable diamond;
    address public immutable usdc;
    address public immutable owner;
    address public immutable proxyImpl;

    // ─── Configurable Limits ──────────────────────────────────────────

    uint256 public baseTxLimit;
    uint256 public dailyTxCountLimit;
    mapping(bytes32 => uint256) public rpToUsdc;
    mapping(bytes32 => uint256) public maxTxLimit;
    mapping(address => uint256) public userRP;

    // ─── State ────────────────────────────────────────────────────────

    struct CheckoutSession {
        address user; // 20 bytes
        bool fulfilled; //  1 byte  — packs with user
        bool cancelled; //  1 byte  — packs with user (lifecycle: PLACED → fulfilled XOR cancelled)
        uint32 placementDay; //  4 bytes — block.timestamp/1 days at placement; pinned so onOrderCancel decrements the right userDailyCount bucket even across UTC days
        bytes32 solanaRecipient;
        uint256 usdcAmount;
    }

    mapping(uint256 => CheckoutSession) public sessions;
    mapping(address => mapping(uint256 => uint256)) public userDailyCount;

    // ─── Vault + Offramp state ────────────────────────────────────────

    /// @notice RestrictedYieldVault that holds the integrator's USDC. Set by
    ///         the owner; until set, buy completions keep USDC on the
    ///         integrator (legacy behaviour) and offramp is unavailable.
    IRestrictedYieldVault public yieldVault;

    bool public offrampEnabled;
    address public offrampRelayer;
    uint256 public maxUsdcPerOfframp;

    struct OfframpRecord {
        bytes32 solanaBurnTx;
        bytes32 solanaUserPubkey;
        uint256 usdcAmount;
        uint8 lastStatus;
        bool initialized;
        /// @notice deliverOfframpUpi replay guard. Set true on first
        ///         successful invocation; remains true across subsequent
        ///         lifecycle transitions (terminal status is tracked
        ///         separately via lastStatus).
        bool delivered;
    }

    mapping(uint256 => OfframpRecord) public offramps;
    mapping(bytes32 => uint256) public solanaBurnToOrderId;

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

    // ─── User-Facing Order Placement ──────────────────────────────────

    /**
     * @notice End-user places a USDC checkout order to be minted on Solana.
     *         Routes through the user's UserProxy, which is the actual caller
     *         of placeB2BOrder on the Diamond.
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
        // Offramp SELL self-call: order.user is the system proxy (owned by this
        // integrator). The relayer entry point already enforced maxUsdcPerOfframp
        // and the vault's principal/balance bounds; per-user buy limits do not
        // apply here.
        if (user == _systemProxy()) return true;

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
        // Defense-in-depth — these should never fire under correct gateway
        // bookkeeping (BUY-only callback per B2BGatewayFacet line 257, single
        // call per orderId, amount fixed at placement). Reverting on
        // divergence makes any future drift loud rather than silently
        // operating on a zero-init session or depositing the wrong amount
        // to the vault. Mirrors LotPot's defense set.
        if (session.user == address(0)) revert UnknownOrder();
        if (session.cancelled) revert OrderAlreadyCancelled();
        if (session.fulfilled) revert OrderAlreadyFulfilled();
        if (amount != session.usdcAmount) revert AmountMismatch();

        session.fulfilled = true;

        // Diamond just pushed USDC to this contract (usdcThroughIntegrator =
        // true on this integrator). If a vault is wired up, forward the USDC
        // there so it starts earning Aave yield. Reset the allowance to 0
        // after deposit — RestrictedYieldVault.deposit pulls the exact
        // approved amount via safeTransferFrom (allowance lands at 0 anyway),
        // but the explicit reset is belt-and-suspenders against any future
        // vault that doesn't.
        if (address(yieldVault) != address(0)) {
            IERC20(usdc).forceApprove(address(yieldVault), amount);
            yieldVault.deposit(amount);
            IERC20(usdc).forceApprove(address(yieldVault), 0);
            emit UsdcDepositedToVault(orderId, amount);
        }

        emit CheckoutFulfilled(orderId, session.solanaRecipient, amount);
    }

    /// @notice Cancellation hook — releases the userDailyCount slot reserved
    ///         at validateOrder. Keyed on session.placementDay so the
    ///         decrement always lands in the bucket validateOrder bumped,
    ///         even if cancellation crosses a UTC day boundary. SELL/offramp
    ///         orders did not consume a slot (validateOrder bypasses for
    ///         system-proxy users) and have no CheckoutSession entry, so
    ///         session.user == address(0) → no-op.
    function onOrderCancel(uint256 orderId) external onlyDiamond {
        CheckoutSession storage session = sessions[orderId];
        if (session.user == address(0)) return; // SELL/offramp or unknown — nothing to release
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

    /// @notice Predicted address of the per-user UserProxy clone (BUY) or
    ///         system proxy (when called with `address(this)`). Deterministic
    ///         CREATE2 — the address exists before any deployment.
    function proxyAddress(address user) public view returns (address) {
        return
            Clones.predictDeterministicAddressWithImmutableArgs(
                proxyImpl,
                _proxyArgs(user),
                _salt(user),
                address(this)
            );
    }

    /// @notice The integrator's own system proxy used as order.user for SELL
    ///         offramps (Solana users have no Base identity).
    function systemProxy() external view returns (address) {
        return _systemProxy();
    }

    // ─── Admin: vault + offramp ───────────────────────────────────────

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

    // ─── Offramp: relayer-triggered ───────────────────────────────────

    /**
     * @notice Place a SELL order on the Diamond on behalf of a user who burned
     *         tUSDC on Solana. Pulls USDC from the vault, places the order via
     *         the system proxy (so order.user = systemProxy), records the
     *         burn → orderId mapping for dedupe.
     */
    function placeSellOrderForBurn(
        bytes32 solanaBurnTx,
        bytes32 solanaUserPubkey,
        uint256 usdcAmount,
        bytes32 currency,
        uint256 fiatAmount,
        uint256 circleId,
        uint256 preferredPaymentChannelConfigId,
        string calldata userPubKey
    ) external onlyOfframpRelayer returns (uint256 orderId) {
        if (!offrampEnabled) revert OfframpDisabled();
        if (address(yieldVault) == address(0)) revert VaultNotSet();
        if (solanaBurnTx == bytes32(0)) revert InvalidSolanaRecipient();
        if (solanaBurnToOrderId[solanaBurnTx] != 0) revert BurnAlreadyProcessed();
        if (usdcAmount == 0) revert InvalidAmount();
        if (maxUsdcPerOfframp != 0 && usdcAmount > maxUsdcPerOfframp)
            revert OfframpAmountTooLarge();

        // Pull USDC from the vault into this integrator. The vault bounds
        // the draw only by its live aUSDC balance (no cumulative cap); it
        // reverts InsufficientFunds if there isn't enough liquid balance to
        // service this release.
        yieldVault.releaseForOfframp(usdcAmount);

        orderId = _placeSellOrder(
            usdcAmount,
            currency,
            fiatAmount,
            circleId,
            preferredPaymentChannelConfigId,
            userPubKey
        );

        offramps[orderId] = OfframpRecord({
            solanaBurnTx: solanaBurnTx,
            solanaUserPubkey: solanaUserPubkey,
            usdcAmount: usdcAmount,
            lastStatus: 0,
            initialized: true,
            delivered: false
        });
        solanaBurnToOrderId[solanaBurnTx] = orderId;

        emit OfframpInitiated(orderId, solanaBurnTx, solanaUserPubkey, usdcAmount);
    }

    function _placeSellOrder(
        uint256 amount,
        bytes32 currency,
        uint256 fiatAmount,
        uint256 circleId,
        uint256 preferredPaymentChannelConfigId,
        string memory userPubKey
    ) internal returns (uint256 orderId) {
        // Place via the system proxy; order.user = system proxy. The Diamond
        // pulls USDC from order.user during setSellOrderUpi, so we transfer
        // funds to the proxy at deliverOfframpUpi-time (just-in-time).
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
        bytes memory result = UserProxy(sysProxy).execute(diamond, data, usdc, 0);
        return abi.decode(result, (uint256));
    }

    /**
     * @notice Forward an encrypted UPI payload to the Diamond. Triggers the
     *         PAID transition (Diamond pulls USDC from the system proxy).
     *
     *         Funding flow: integrator transfers r.usdcAmount to the system
     *         proxy, then the system proxy calls setSellOrderUpi via execute.
     *         The Diamond's transferFrom pulls actualUsdtAmount from the proxy.
     *         Any remainder (fee residue) is auto-refunded to owner=integrator
     *         by UserProxy.execute.
     */
    function deliverOfframpUpi(
        uint256 orderId,
        string calldata encUpi
    ) external onlyOfframpRelayer {
        // storage because we set the replay guard before external calls
        OfframpRecord storage r = offramps[orderId];
        if (!r.initialized) revert OfframpRecordNotFound();
        if (r.delivered) revert OfframpAlreadyDelivered();

        // CEI: flip the replay flag before any external call. If the
        // downstream call reverts, the whole transaction reverts and the
        // flag rolls back too — so a legitimate retry after a true revert
        // still works.
        r.delivered = true;

        // For SELL the Diamond pulls actualUsdtAmount (= principal + fee) from
        // order.user via transferFrom inside setSellOrderUpi. Funding the proxy
        // with only `r.usdcAmount` makes the transferFrom fail and the Diamond
        // auto-cancels the order in its try/catch. Read the actual amount from
        // the Diamond and fund accordingly. The proxy auto-sweeps any
        // remainder back to this integrator after execute.
        IOrderFlow.AdditionalOrderDetailsView memory aod = IOrderFlow(diamond)
            .getAdditionalOrderDetails(orderId);
        uint256 needed = aod.actualUsdtAmount;
        // No silent principal-only fallback — that path re-introduces the
        // 2026-05-07 fee bug (Diamond auto-cancels because transferFrom
        // underflows on principal + fee). Force the relayer to retry once
        // Diamond has populated actualUsdtAmount.
        if (needed == 0) revert OfframpFeeNotReady();

        if (IERC20(usdc).balanceOf(address(this)) < needed) revert OfframpInsufficientPool();

        address sysProxy = _ensureProxy(address(this));
        IERC20(usdc).safeTransfer(sysProxy, needed);

        bytes memory data = abi.encodeCall(IOrderFlow.setSellOrderUpi, (orderId, encUpi, 0));
        UserProxy(sysProxy).execute(diamond, data, usdc, needed);

        emit OfframpUpiDelivered(orderId);
    }

    /**
     * @notice Read-and-record the Diamond's terminal status for an offramp
     *         order. On CANCELLED, the Diamond refunded USDC to order.user =
     *         system proxy; we sweep it back to this integrator and forward
     *         to the vault so the offramp pool's accounting balances.
     *
     *         Permissionless on purpose — the relayer pokes on completion, and
     *         ops can close out bookkeeping after a dispute resolution without
     *         needing the relayer key. Security comes from reading the
     *         authoritative status from the Diamond (not from a caller-
     *         supplied argument) and rejecting non-terminal states: a griefer
     *         can call this but can't influence the recorded status or
     *         prematurely return offramp liquidity to the vault.
     */
    function reconcile(uint256 orderId) external {
        OfframpRecord storage r = offramps[orderId];
        if (!r.initialized) revert OfframpRecordNotFound();
        if (r.lastStatus == STATUS_COMPLETED || r.lastStatus == STATUS_CANCELLED)
            revert OfframpAlreadyReconciled();

        // Authoritative status from Diamond. Reverts if Diamond is broken or
        // the orderId doesn't exist (returns default-init Order with
        // status=PLACED, which fails the terminal check below).
        IOrderFlow.OrderView memory order = IOrderFlow(diamond).getOrdersById(orderId);
        uint8 status = order.status;
        if (status != STATUS_COMPLETED && status != STATUS_CANCELLED) revert StatusNotTerminal();

        uint256 returned = 0;
        if (status == STATUS_CANCELLED && address(yieldVault) != address(0)) {
            // After cancel-while-PAID, USDC was refunded to the system proxy.
            // Pull it back to this integrator. UserProxy blocks the user-
            // initiated USDC sweep universally; the integrator-only
            // `transferERC20ToIntegrator` is the correct primitive here.
            address sysProxy = _ensureProxy(address(this));
            uint256 proxyBal = IERC20(usdc).balanceOf(sysProxy);
            if (proxyBal > 0) {
                UserProxy(sysProxy).transferERC20ToIntegrator(usdc, proxyBal);
            }

            uint256 bal = IERC20(usdc).balanceOf(address(this));
            if (bal >= r.usdcAmount) {
                IERC20(usdc).forceApprove(address(yieldVault), r.usdcAmount);
                yieldVault.returnFromOfframp(r.usdcAmount);
                IERC20(usdc).forceApprove(address(yieldVault), 0);
                returned = r.usdcAmount;
            }
        }
        r.lastStatus = status;
        emit OfframpReconciled(orderId, status, returned);
    }

    // ─── Internal: proxy helpers ──────────────────────────────────────

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
            assert(deployed == proxy);
            emit UserProxyDeployed(user, proxy);
        }
    }
}
