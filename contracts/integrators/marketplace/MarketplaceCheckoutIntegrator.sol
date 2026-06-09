// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { IOrderFlow } from "../../interfaces/IOrderFlow.sol";
import { IMarketplaceClient } from "../../interfaces/IMarketplaceClient.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

/**
 * @title MarketplaceCheckoutIntegrator
 * @notice Integrator for clients that DO NOT implement ICheckoutClient and
 *         instead identify the buyer via `msg.sender` (e.g. a vanilla NFT
 *         marketplace with `buy(productId, quantity)` that pulls USDC and
 *         mints to `msg.sender`).
 *
 *         To make the client see the end-user as the buyer, the integrator
 *         routes each fulfillment through a per-user `UserProxy` clone
 *         deployed at a deterministic CREATE2 address. The proxy is
 *         deployed lazily on the user's first order and reused thereafter.
 *
 *         Per-product "recipes" are registered by the owner. Each recipe
 *         specifies the target client, unit price, function selector, and
 *         leading args. At fulfillment, the integrator constructs the call
 *         data and invokes the proxy, which calls the client. Tokens
 *         minted to the proxy stay on the proxy until the user pulls them
 *         out via `UserProxy.sweep*`.
 *
 *         RP-based per-tx limits and daily count limits match
 *         CheckoutIntegratorV2.
 */
contract MarketplaceCheckoutIntegrator is IP2PIntegrator {
    using SafeERC20 for IERC20;
    using Clones for address;

    // ─── Errors ───────────────────────────────────────────────────────

    error OnlyDiamond();
    error OnlyOwner();
    error RecipeNotFound();
    error RecipeAlreadySet();
    error OrderAlreadyFulfilled();
    error OrderAlreadyCancelled();
    error InvalidAddress();
    error InvalidQuantity();
    error InvalidUnitPrice();
    error ArrayLengthMismatch();

    // Offramp
    error OfframpDisabled();
    error OfframpNotAuthorized();
    error OfframpInsufficientPool();
    error OfframpUserCapExceeded();
    error OfframpAmountTooLarge();
    error OfframpRecordNotFound();
    error OfframpAlreadyReconciled();
    error OfframpNotCancelled();
    error TokenNotOwnedByCaller();
    error TokenNotMintedHere();

    // ─── Events ───────────────────────────────────────────────────────

    event RecipeSet(
        bytes32 indexed key,
        address indexed client,
        uint256 indexed productId,
        uint256 unitPrice,
        bytes4 selector
    );
    event RecipeRemoved(bytes32 indexed key);

    event CheckoutOrderCreated(
        uint256 indexed orderId,
        address indexed user,
        bytes32 indexed recipeKey,
        uint256 quantity,
        uint256 totalUsdcAmount
    );
    event CheckoutFulfilled(
        uint256 indexed orderId,
        address indexed user,
        address indexed client,
        bytes32 recipeKey,
        uint256 quantity,
        address proxy
    );
    event UserProxyDeployed(address indexed user, address proxy);

    event UserRPUpdated(address indexed user, uint256 rp);
    event RpRateUpdated(bytes32 indexed currency, uint256 usdcPerRp);
    event BaseTxLimitUpdated(uint256 limit);
    event MaxTxLimitUpdated(bytes32 indexed currency, uint256 cap);
    event DailyTxCountLimitUpdated(uint256 count);

    // Offramp
    event OfframpEnabledUpdated(bool enabled);
    event OfframpRelayerUpdated(address indexed relayer);
    event MaxUsdcPerOfframpUpdated(uint256 cap);
    event UserSellVolumeLimitUpdated(uint256 limit);
    event OfframpInitiated(
        uint256 indexed orderId,
        address indexed user,
        address indexed client,
        uint256 tokenId,
        uint256 productId,
        uint256 usdcAmount
    );
    event OfframpUpiDelivered(uint256 indexed orderId);
    event OfframpReconciled(uint256 indexed orderId, uint8 newStatus);
    event OfframpRetried(uint256 indexed originalOrderId, uint256 indexed newOrderId);
    event OfframpUsdcWithdrawn(address indexed to, uint256 amount);

    // ─── Immutables ───────────────────────────────────────────────────

    address public immutable diamond;
    IERC20 public immutable usdc;
    address public immutable owner;
    /// @notice The UserProxy implementation that all clones delegate to.
    address public immutable proxyImpl;

    // ─── Configurable Limits ──────────────────────────────────────────

    uint256 public baseTxLimit;
    uint256 public dailyTxCountLimit;
    mapping(bytes32 => uint256) public rpToUsdc;
    mapping(bytes32 => uint256) public maxTxLimit;
    mapping(address => uint256) public userRP;

    // ─── State ────────────────────────────────────────────────────────

    /**
     * @dev `outTokens` is metadata only — surfaced via events so a UI can
     *      list tokens the user may need to claim from their proxy. The
     *      integrator does not auto-sweep them in this version.
     */
    struct ProductRecipe {
        address client;
        uint256 unitPrice;
        bytes4 selector;
        bytes prefixArgs;
        bool appendQuantity;
        address[] outTokens;
    }

    struct CheckoutSession {
        address user; // 20 bytes
        bool fulfilled; //  1 byte  — packs with user
        bool cancelled; //  1 byte  — packs with user (PLACED → fulfilled XOR cancelled)
        uint32 placementDay; //  4 bytes — pinned for onOrderCancel decrement keying
        bytes32 recipeKey;
        uint256 quantity;
        uint256 usdcAmount;
    }

    mapping(bytes32 => ProductRecipe) private _recipes;
    mapping(uint256 => CheckoutSession) public sessions;
    mapping(address => mapping(uint256 => uint256)) public userDailyCount;

    // ─── Offramp state ────────────────────────────────────────────────

    /**
     * @dev Status mirrors MockDiamond.SellStatus and the contracts-v4
     *      OrderProcessorStorage.OrderStatus enum (PLACED=0, ACCEPTED=1,
     *      PAID=2, COMPLETED=3, CANCELLED=4). Stored as uint8 since the
     *      value is set externally by `reconcile`.
     */
    struct OfframpRecord {
        address user;
        address client;
        uint256 tokenId;
        uint256 productId;
        uint256 usdcAmount;
        uint8 lastStatus;
        bool initialized;
    }

    bool public offrampEnabled;
    address public offrampRelayer;
    uint256 public maxUsdcPerOfframp;
    /// @notice Lifetime per-user USDC sell volume cap. The integrator
    ///         decrements `userSellVolume` when an offramp order is
    ///         reconciled to CANCELLED so users aren't penalized for
    ///         merchant timeouts.
    uint256 public userSellVolumeLimit;

    mapping(uint256 => OfframpRecord) public offramps;
    mapping(uint256 => address) public orderInitiator;
    mapping(address => uint256) public userSellVolume;

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

    constructor(address _diamond, address _usdc, uint256 _baseTxLimit, uint256 _dailyTxCountLimit) {
        if (_diamond == address(0) || _usdc == address(0)) revert InvalidAddress();
        diamond = _diamond;
        usdc = IERC20(_usdc);
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

    // ─── Admin: Recipes ───────────────────────────────────────────────

    /// @notice Register or overwrite the recipe for `(client, productId)`.
    function setRecipe(
        address client,
        uint256 productId,
        uint256 unitPrice,
        bytes4 selector,
        bytes calldata prefixArgs,
        bool appendQuantity,
        address[] calldata outTokens
    ) external onlyOwner {
        if (client == address(0) || client.code.length == 0) revert InvalidAddress();
        if (unitPrice == 0) revert InvalidUnitPrice();

        bytes32 key = recipeKey(client, productId);
        _recipes[key] = ProductRecipe({
            client: client,
            unitPrice: unitPrice,
            selector: selector,
            prefixArgs: prefixArgs,
            appendQuantity: appendQuantity,
            outTokens: outTokens
        });

        emit RecipeSet(key, client, productId, unitPrice, selector);
    }

    function removeRecipe(address client, uint256 productId) external onlyOwner {
        bytes32 key = recipeKey(client, productId);
        delete _recipes[key];
        emit RecipeRemoved(key);
    }

    // ─── Views ────────────────────────────────────────────────────────

    function recipeKey(address client, uint256 productId) public pure returns (bytes32) {
        return keccak256(abi.encode(client, productId));
    }

    function getRecipe(
        address client,
        uint256 productId
    ) external view returns (ProductRecipe memory) {
        return _recipes[recipeKey(client, productId)];
    }

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

    /// @notice The integrator's own system proxy used as order.user for SELL
    ///         offramps (the integrator can't be the placer — the gateway is
    ///         proxy-only).
    function systemProxy() external view returns (address) {
        return _systemProxy();
    }

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

    // ─── User-Facing Order Placement ──────────────────────────────────

    /**
     * @notice End-user places a checkout order for `quantity` units of a
     *         registered product. Total cost = recipe.unitPrice × quantity.
     */
    function userPlaceOrder(
        address client,
        uint256 productId,
        uint256 quantity,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) external returns (uint256 orderId) {
        if (quantity == 0) revert InvalidQuantity();

        bytes32 key = recipeKey(client, productId);
        if (_recipes[key].client == address(0)) revert RecipeNotFound();

        uint256 totalPrice = _recipes[key].unitPrice * quantity;

        orderId = _placeOrder(
            totalPrice,
            currency,
            circleId,
            pubKey,
            preferredPaymentChannelConfigId,
            fiatAmountLimit
        );

        sessions[orderId] = CheckoutSession({
            user: msg.sender,
            recipeKey: key,
            quantity: quantity,
            usdcAmount: totalPrice,
            fulfilled: false,
            cancelled: false,
            placementDay: uint32(block.timestamp / 1 days)
        });

        emit CheckoutOrderCreated(orderId, msg.sender, key, quantity, totalPrice);
    }

    function _placeOrder(
        uint256 totalPrice,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) internal returns (uint256) {
        // Proxy-as-placer: the gateway is proxy-only (rejects direct integrator
        // calls). The user's UserProxy is the msg.sender that calls
        // placeB2BOrder; the gateway resolves msg.sender → integrator by
        // reading proxy.integrator() and re-deriving the CREATE2 clone address
        // against the integrator's pinned proxyImpl.
        // recipientAddr = proxy so completion routes USDC straight to the proxy
        // (no integrator hop). Requires usdcThroughIntegrator = false on the
        // Diamond's integrator config.
        address proxy = _ensureProxy(msg.sender);
        bytes memory data = abi.encodeCall(
            IB2BGateway.placeB2BOrder,
            (
                msg.sender,
                totalPrice,
                currency,
                proxy,
                pubKey,
                circleId,
                preferredPaymentChannelConfigId,
                fiatAmountLimit
            )
        );
        bytes memory result = UserProxy(proxy).execute(diamond, data, address(usdc), 0);
        return abi.decode(result, (uint256));
    }

    // ─── IP2PIntegrator Callbacks ─────────────────────────────────────

    function validateOrder(
        address user,
        uint256 amount,
        bytes32 currency
    ) external onlyDiamond returns (bool allowed) {
        // SELL self-call: offramps are placed with user = system proxy
        // (owner = address(this)). userInitiateSellBack / retryOfframp already
        // enforce per-token + per-user offramp caps before calling the gateway,
        // so the consumer-side per-user buy limits do not apply here.
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
        if (session.fulfilled) revert OrderAlreadyFulfilled();
        session.fulfilled = true;

        ProductRecipe memory recipe = _recipes[session.recipeKey];

        // USDC was sent directly to the proxy by the Diamond on completion
        // (recipientAddr = proxy, usdcThroughIntegrator = false). The integrator
        // never touches USDC — the proxy is the funded actor.
        address proxy = _ensureProxy(session.user);

        bytes memory data = recipe.appendQuantity
            ? bytes.concat(recipe.selector, recipe.prefixArgs, abi.encode(session.quantity))
            : bytes.concat(recipe.selector, recipe.prefixArgs);

        UserProxy(proxy).execute(recipe.client, data, address(usdc), amount);

        emit CheckoutFulfilled(
            orderId,
            session.user,
            recipe.client,
            session.recipeKey,
            session.quantity,
            proxy
        );
    }

    /// @notice Cancellation hook — releases the userDailyCount slot reserved
    ///         at validateOrder, keyed on the placement-day snapshot. SELL/
    ///         offramp orders bypass validateOrder's count bump (system
    ///         proxy short-circuit) and don't always have a corresponding
    ///         CheckoutSession entry, so an empty session is treated as
    ///         a no-op rather than an error.
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
    }

    // ─── Internals ────────────────────────────────────────────────────

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

    // ─── Offramp: admin ───────────────────────────────────────────────

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

    function setUserSellVolumeLimit(uint256 limit) external onlyOwner {
        userSellVolumeLimit = limit;
        emit UserSellVolumeLimitUpdated(limit);
    }

    /// @notice Move USDC out of the integrator's pool. Used to clear a
    ///         cancelled-offramp refund or rebalance the pool.
    function withdrawUsdc(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert InvalidAddress();
        usdc.safeTransfer(to, amount);
        emit OfframpUsdcWithdrawn(to, amount);
    }

    // ─── Offramp: user-initiated ──────────────────────────────────────

    /**
     * @notice Burn `tokenId` on `client` and place a SELL order on the Diamond
     *         priced at the original buy price stored on the client. The
     *         integrator becomes `order.user`; USDC is supplied from the
     *         integrator's accumulated buy pool when `setSellOrderUpi` runs.
     *
     * @dev    The caller must own `tokenId` on `client`. The product's
     *         original recipe must still exist on this integrator so we
     *         have proof the token was minted under our supervision (and so
     *         the recipe's currency/circle still applies for the sell-back).
     */
    function userInitiateSellBack(
        address client,
        uint256 tokenId,
        bytes32 currency,
        uint256 fiatAmount,
        uint256 circleId,
        uint256 preferredPaymentChannelConfigId,
        string calldata userPubKey
    ) external returns (uint256 orderId) {
        if (!offrampEnabled) revert OfframpDisabled();

        IMarketplaceClient mc = IMarketplaceClient(client);
        if (mc.ownerOf(tokenId) != msg.sender) revert TokenNotOwnedByCaller();

        uint256 productId = mc.tokenProduct(tokenId);
        bytes32 key = recipeKey(client, productId);
        if (_recipes[key].client == address(0)) revert TokenNotMintedHere();

        uint256 originalPrice = mc.tokenPrice(tokenId);
        if (originalPrice == 0) revert TokenNotMintedHere();
        if (maxUsdcPerOfframp != 0 && originalPrice > maxUsdcPerOfframp)
            revert OfframpAmountTooLarge();
        if (usdc.balanceOf(address(this)) < originalPrice) revert OfframpInsufficientPool();
        if (
            userSellVolumeLimit != 0 &&
            userSellVolume[msg.sender] + originalPrice > userSellVolumeLimit
        ) {
            revert OfframpUserCapExceeded();
        }

        mc.sellBackEntry(tokenId, msg.sender);
        userSellVolume[msg.sender] += originalPrice;

        orderId = _placeSellOrder(
            originalPrice,
            currency,
            fiatAmount,
            circleId,
            preferredPaymentChannelConfigId,
            userPubKey
        );

        offramps[orderId] = OfframpRecord({
            user: msg.sender,
            client: client,
            tokenId: tokenId,
            productId: productId,
            usdcAmount: originalPrice,
            lastStatus: 0,
            initialized: true
        });
        orderInitiator[orderId] = msg.sender;

        emit OfframpInitiated(orderId, msg.sender, client, tokenId, productId, originalPrice);
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
        // setSellOrderUpi, so we transfer funds to the proxy at
        // deliverOfframpUpi-time (just-in-time). On cancel, refunds land on
        // the proxy and reconcile sweeps them back here.
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
     * @notice Forward an encrypted UPI payload to the Diamond. Triggers the
     *         PAID transition (Diamond pulls USDC from this integrator).
     *         Callable by the original initiator (the user) or the configured
     *         relayer — TradeStars-style integrations would use the relayer
     *         path; the marketplace flow uses the user path.
     */
    function deliverOfframpUpi(uint256 orderId, string calldata encUpi) external {
        OfframpRecord memory r = offramps[orderId];
        if (!r.initialized) revert OfframpRecordNotFound();
        if (msg.sender != orderInitiator[orderId] && msg.sender != offrampRelayer) {
            revert OfframpNotAuthorized();
        }

        // Diamond's setSellOrderUpi pulls actualUsdtAmount (= principal + fee)
        // from order.user via transferFrom. Funding the proxy with only
        // r.usdcAmount makes the transferFrom fail and the Diamond auto-cancels
        // the order in its try/catch. Read the actual amount from the Diamond
        // and fund the proxy accordingly. UserProxy.execute auto-sweeps any
        // remainder back to this integrator (the proxy's owner).
        IOrderFlow.AdditionalOrderDetailsView memory aod = IOrderFlow(diamond)
            .getAdditionalOrderDetails(orderId);
        uint256 needed = aod.actualUsdtAmount;
        if (needed == 0) needed = r.usdcAmount;

        if (usdc.balanceOf(address(this)) < needed) revert OfframpInsufficientPool();

        address sysProxy = _ensureProxy(address(this));
        usdc.safeTransfer(sysProxy, needed);

        bytes memory data = abi.encodeCall(IOrderFlow.setSellOrderUpi, (orderId, encUpi, 0));
        UserProxy(sysProxy).execute(diamond, data, address(usdc), needed);

        emit OfframpUpiDelivered(orderId);
    }

    /**
     * @notice Read-and-record the Diamond status of an offramp order. Anyone
     *         can poke. On CANCELLED, decrements the user's volume so the
     *         cap accounts only for sells that consumed merchant capacity.
     */
    function reconcile(uint256 orderId, uint8 currentStatus) external {
        OfframpRecord storage r = offramps[orderId];
        if (!r.initialized) revert OfframpRecordNotFound();
        if (r.lastStatus == 3 || r.lastStatus == 4) revert OfframpAlreadyReconciled();

        if (currentStatus == 4 /* CANCELLED */) {
            // Cancel-while-PAID refunds USDC to order.user = system proxy.
            // Pull it back to the integrator pool. We can't use sweepERC20
            // (UserProxy blocks USDC sweep universally), but the integrator-
            // only `transferERC20ToIntegrator` is the right primitive here.
            address sysProxy = _ensureProxy(address(this));
            uint256 bal = usdc.balanceOf(sysProxy);
            if (bal > 0) {
                UserProxy(sysProxy).transferERC20ToIntegrator(address(usdc), bal);
            }

            // Don't penalize the user for a cancelled offramp.
            uint256 vol = userSellVolume[r.user];
            userSellVolume[r.user] = vol > r.usdcAmount ? vol - r.usdcAmount : 0;
        }
        r.lastStatus = currentStatus;
        emit OfframpReconciled(orderId, currentStatus);
    }

    /**
     * @notice Place a fresh sell order using the same user/amount as a
     *         previously cancelled offramp. The original record stays
     *         intact for audit; a new record is created with a new orderId.
     *         Owner-only — use after manual review of why the original
     *         cancelled.
     */
    function retryOfframp(
        uint256 originalOrderId,
        bytes32 currency,
        uint256 fiatAmount,
        uint256 circleId,
        uint256 preferredPaymentChannelConfigId,
        string calldata userPubKey
    ) external onlyOwner returns (uint256 newOrderId) {
        OfframpRecord memory original = offramps[originalOrderId];
        if (!original.initialized) revert OfframpRecordNotFound();
        if (original.lastStatus != 4) revert OfframpNotCancelled();
        if (usdc.balanceOf(address(this)) < original.usdcAmount) revert OfframpInsufficientPool();
        if (
            userSellVolumeLimit != 0 &&
            userSellVolume[original.user] + original.usdcAmount > userSellVolumeLimit
        ) {
            revert OfframpUserCapExceeded();
        }

        userSellVolume[original.user] += original.usdcAmount;

        newOrderId = _placeSellOrder(
            original.usdcAmount,
            currency,
            fiatAmount,
            circleId,
            preferredPaymentChannelConfigId,
            userPubKey
        );

        offramps[newOrderId] = OfframpRecord({
            user: original.user,
            client: original.client,
            tokenId: original.tokenId,
            productId: original.productId,
            usdcAmount: original.usdcAmount,
            lastStatus: 0,
            initialized: true
        });
        orderInitiator[newOrderId] = original.user;

        emit OfframpInitiated(
            newOrderId,
            original.user,
            original.client,
            original.tokenId,
            original.productId,
            original.usdcAmount
        );
        emit OfframpRetried(originalOrderId, newOrderId);
    }
}
