// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { ITokenMessengerV2 } from "../../interfaces/ICctpV2.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title StocksIntegrator
 * @notice stocks.me — buy tokenized US equities (xStocks on Solana) with local
 *         fiat. The user pays INR/BRL/… on the P2P network; the Diamond settles
 *         USDC here; this contract burns it via Circle CCTP V2 to a FIXED
 *         Solana treasury USDC account. An off-chain worker then swaps that
 *         USDC into the chosen xStock and delivers it to the user's own Solana
 *         wallet.
 *
 *         Derived from ShowdownCheckoutIntegrator, which pioneered the
 *         fiat -> USDC-on-Solana leg. Differences, all deliberate:
 *
 *           1. NO ICheckoutClient. Like Showdown, the purchased USDC lands on
 *              this contract (recipientAddr = address(this), pinned at
 *              placement) and is burned. There is no product/quantity
 *              quantization — the user buys an arbitrary USDC notional.
 *
 *           2. The CCTP `mintRecipient` is an IMMUTABLE treasury USDC ATA, not
 *              a per-user account. CCTP reverts on the Solana side if the
 *              recipient token account does not exist, so a per-user ATA is a
 *              permanent-loss footgun (Showdown carries a 7-day rescue path for
 *              exactly this). Our treasury ATA is created once at setup and
 *              always exists, so the mint leg cannot strand funds.
 *
 *           3. The user's Solana WALLET and the chosen stock ride in the
 *              `StockDeliveryRequested` event, pinned at placement. They are
 *              delivery instructions for our worker, never CCTP parameters.
 *              `ref` binds the on-chain order to exactly one database row.
 *
 *         What the user signs: one gasless Base transaction (Privy embedded
 *         wallet + sponsored gas). Nothing on Solana, ever.
 *
 * @dev Deploy/register with `usdcThroughIntegrator = FALSE`. The onramp pins
 *      `recipientAddr = address(this)` in placeB2BOrder, so completion routes
 *      the USDC here without the flag — same as Showdown.
 *
 *      CCTP burns only Circle-issued USDC. The Base Sepolia Diamond settles in
 *      a mock token (GoofyGoober, 0x4095fE…) whose `burnLimitsPerMessage == 0`,
 *      so on Sepolia every burn fails closed into fulfilled-but-unbridged and
 *      is recoverable via `retryBridge` / `userRescueStuckBridge`. See
 *      `bridgeReserveToken` below for how testnet still exercises the real CCTP
 *      path end to end.
 */
contract StocksIntegrator is IP2PIntegrator, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Errors ───────────────────────────────────────────────────────
    error OnlyDiamond();
    error OnlyOwner();
    error OnlySelf();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidSolanaRecipient();
    error InvalidRef();
    error StockNotEnabled();
    error OrderAlreadyFulfilled();
    error UnexpectedRecipient();
    error AlreadyBridged();
    error NotFulfilled();
    error RescueTooEarly();
    error TxLimitExceeded();
    error DailyLimitExceeded();
    error AboveCeiling();
    error InvalidFinalityThreshold();
    error InsufficientUnreserved();

    // ─── Events ───────────────────────────────────────────────────────

    /// @notice THE event our worker watches. Everything needed to deliver the
    ///         stock is here, pinned at placement and immutable thereafter.
    event StockDeliveryRequested(
        uint256 indexed orderId,
        bytes32 indexed ref,
        address indexed user,
        bytes32 solanaWallet,
        uint16 stockId,
        uint256 usdcAmount
    );
    event OrderPlaced(
        uint256 indexed orderId,
        bytes32 indexed ref,
        address indexed user,
        uint16 stockId,
        uint256 amount,
        bytes32 currency
    );
    event BridgedToSolana(
        uint256 indexed orderId,
        uint256 amount,
        bytes32 mintRecipient,
        uint256 maxFee
    );
    event BridgeFailed(uint256 indexed orderId, bytes reason);
    event BridgeRescued(uint256 indexed orderId, address indexed user, uint256 amount);
    event OrderCancelled(uint256 indexed orderId, address indexed user);
    event UserProxyDeployed(address indexed user, address proxy);
    event StockEnabledUpdated(uint16 indexed stockId, bool enabled);
    event TxLimitUpdated(uint256 limit);
    event DailyTxCountLimitUpdated(uint256 count);
    event BridgeMaxFeeBpsUpdated(uint256 bps);
    event BridgeFinalityThresholdUpdated(uint32 threshold);
    event UsdcWithdrawn(address indexed to, uint256 amount);

    // ─── Immutable policy ceilings ────────────────────────────────────
    // Owner setters may only ever go at or BELOW these, so the policy holds
    // against a compromised owner key. Same pattern as Showdown.

    /// @notice Hard ceiling on a single order: $50 (hackathon scope).
    uint256 public constant MAX_TX_LIMIT = 50e6;
    /// @notice Hard ceiling on orders per user per UTC day.
    uint256 public constant MAX_DAILY_TX_COUNT = 10;
    /// @notice Hard ceiling on the CCTP attestation fee, in bps of the burn.
    uint256 public constant MAX_BRIDGE_FEE_BPS = 10;
    /// @notice How long a fulfilled-but-unbridged order must sit before the
    ///         buyer may pull their USDC back on Base.
    uint256 public constant RESCUE_DELAY = 7 days;

    /// @notice The only two `minFinalityThreshold` values CCTP V2 defines.
    uint32 public constant FINALITY_FAST = 1000;
    uint32 public constant FINALITY_STANDARD = 2000;

    // ─── Immutables ───────────────────────────────────────────────────

    address public immutable diamond;
    /// @notice Exposed so the canonical UserProxy can resolve which token to
    ///         block from user-initiated sweep.
    IERC20 public immutable usdc;
    address public immutable owner;
    address public immutable proxyImpl;

    /// @notice Circle CCTP V2 TokenMessenger on Base.
    ITokenMessengerV2 public immutable tokenMessenger;
    /// @notice CCTP domain for Solana. 5 on both mainnet and devnet.
    uint32 public immutable solanaDomain;

    /// @notice The token CCTP actually burns. On mainnet this IS `usdc`. On
    ///         Base Sepolia the Diamond settles in a mock token Circle refuses
    ///         to burn, so this points at real Circle testnet USDC held here as
    ///         a pre-funded reserve: settlement arrives as the mock token and we
    ///         burn an equal amount of the reserve. That makes the real CCTP
    ///         path exercisable on testnet, which is the whole point of a
    ///         testnet. Deploy asserts `bridgeReserveToken == usdc` whenever
    ///         `usdc` is itself CCTP-burnable (i.e. always on mainnet).
    IERC20 public immutable bridgeReserveToken;
    /// @notice True when settlement token != burn token (testnet only).
    bool public immutable receiptMode;

    /// @notice CCTP `mintRecipient`: our Solana treasury's USDC ASSOCIATED
    ///         TOKEN ACCOUNT as bytes32 — NOT a wallet address. Immutable, and
    ///         must already exist on Solana or no mint can ever execute.
    bytes32 public immutable treasuryUsdcAta;

    // ─── Config ───────────────────────────────────────────────────────

    uint256 public txLimit;
    uint256 public dailyTxCountLimit;
    uint256 public bridgeMaxFeeBps;
    uint32 public bridgeMinFinalityThreshold;

    /// @notice Whitelist of deliverable stocks, by our own stock id.
    mapping(uint16 => bool) public stockEnabled;

    // ─── State ────────────────────────────────────────────────────────

    struct Session {
        address user; // 20 bytes
        uint16 stockId; //  2
        bool fulfilled; //  1 — Diamond completed + USDC delivered here
        bool bridged; //  1 — burned to Solana via CCTP
        bool cancelled; //  1
        bool rescued; //  1 — pulled back to the buyer after the delay
        uint32 placementDay; //  4 — pinned for onOrderCancel decrement keying
        uint32 completedAt; //  4 — starts the rescue clock (== 34 bytes, 2 slots)
        uint256 amount;
        bytes32 solanaWallet; // user's Solana WALLET (stock delivery target)
        bytes32 ref; // binds this order to exactly one database row
    }

    mapping(uint256 => Session) public sessions;
    mapping(address => mapping(uint256 => uint256)) public userDailyCount;

    /// @notice Claim on the POOLED reserve balance held for unbridged orders.
    ///         Keeps `bridgeReserveToken.balanceOf(this) >= unbridgedTotal`
    ///         true, which is what makes withdrawUsdc / retryBridge /
    ///         userRescueStuckBridge safe against each other.
    uint256 public unbridgedTotal;

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
        address _tokenMessenger,
        address _bridgeReserveToken,
        bytes32 _treasuryUsdcAta,
        uint32 _solanaDomain,
        uint256 _txLimit,
        uint256 _dailyTxCountLimit
    ) {
        if (
            _diamond == address(0) ||
            _usdc == address(0) ||
            _tokenMessenger == address(0) ||
            _bridgeReserveToken == address(0)
        ) revert InvalidAddress();
        if (_treasuryUsdcAta == bytes32(0)) revert InvalidSolanaRecipient();
        if (_txLimit == 0 || _txLimit > MAX_TX_LIMIT) revert AboveCeiling();
        if (_dailyTxCountLimit == 0 || _dailyTxCountLimit > MAX_DAILY_TX_COUNT)
            revert AboveCeiling();

        diamond = _diamond;
        usdc = IERC20(_usdc);
        tokenMessenger = ITokenMessengerV2(_tokenMessenger);
        bridgeReserveToken = IERC20(_bridgeReserveToken);
        receiptMode = _bridgeReserveToken != _usdc;
        treasuryUsdcAta = _treasuryUsdcAta;
        solanaDomain = _solanaDomain;
        owner = msg.sender;

        txLimit = _txLimit;
        dailyTxCountLimit = _dailyTxCountLimit;
        // Fast Transfer by default — ~8-20s instead of 13-19 min. Costs ~1.3bps,
        // well under MAX_BRIDGE_FEE_BPS. Both values must be set for Fast to
        // actually engage; shipping them together removes that footgun.
        bridgeMaxFeeBps = 2;
        bridgeMinFinalityThreshold = FINALITY_FAST;

        proxyImpl = address(new UserProxy());
    }

    // ─── Owner config ─────────────────────────────────────────────────

    function setStockEnabled(uint16 stockId, bool enabled) external onlyOwner {
        stockEnabled[stockId] = enabled;
        emit StockEnabledUpdated(stockId, enabled);
    }

    function setTxLimit(uint256 limit) external onlyOwner {
        if (limit == 0 || limit > MAX_TX_LIMIT) revert AboveCeiling();
        txLimit = limit;
        emit TxLimitUpdated(limit);
    }

    function setDailyTxCountLimit(uint256 count) external onlyOwner {
        if (count == 0 || count > MAX_DAILY_TX_COUNT) revert AboveCeiling();
        dailyTxCountLimit = count;
        emit DailyTxCountLimitUpdated(count);
    }

    function setBridgeMaxFeeBps(uint256 bps) external onlyOwner {
        if (bps > MAX_BRIDGE_FEE_BPS) revert AboveCeiling();
        bridgeMaxFeeBps = bps;
        emit BridgeMaxFeeBpsUpdated(bps);
    }

    function setBridgeMinFinalityThreshold(uint32 threshold) external onlyOwner {
        if (threshold != FINALITY_FAST && threshold != FINALITY_STANDARD)
            revert InvalidFinalityThreshold();
        bridgeMinFinalityThreshold = threshold;
        emit BridgeFinalityThresholdUpdated(threshold);
    }

    /// @notice Sweep only the surplus that is NOT reserved for unbridged orders.
    ///         Protects buyers whose burn has not landed yet.
    function withdrawUsdc(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert InvalidAddress();
        uint256 bal = bridgeReserveToken.balanceOf(address(this));
        uint256 free = bal > unbridgedTotal ? bal - unbridgedTotal : 0;
        if (amount > free) revert InsufficientUnreserved();
        bridgeReserveToken.safeTransfer(to, amount);
        emit UsdcWithdrawn(to, amount);
    }

    // ─── Order entry point ────────────────────────────────────────────

    /**
     * @notice Buy `amount` USDC worth of stock `stockId`, paying in `currency`.
     *
     * @param amount        USDC notional (micro-USDC, 6dp).
     * @param stockId       Our own id for the xStock (see lib/stocks.ts).
     * @param currency      Fiat currency the user pays in, e.g. bytes32("INR").
     * @param solanaWallet  The user's Solana WALLET as bytes32 — the owner, not
     *                      a token account. Our worker derives and creates the
     *                      Token-2022 stock ATA for it. Pinned for the life of
     *                      the order so delivery cannot be redirected.
     * @param ref           Opaque 32-byte handle binding this order to one
     *                      database row. Must be non-zero.
     */
    function userBuyStock(
        uint256 amount,
        uint16 stockId,
        bytes32 currency,
        bytes32 solanaWallet,
        bytes32 ref,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) external nonReentrant returns (uint256 orderId) {
        if (amount == 0) revert InvalidAmount();
        if (solanaWallet == bytes32(0)) revert InvalidSolanaRecipient();
        if (ref == bytes32(0)) revert InvalidRef();
        if (!stockEnabled[stockId]) revert StockNotEnabled();

        // Friendly pre-checks. validateOrder re-enforces these authoritatively
        // when the Diamond calls back, and reserves the daily slot there.
        if (amount > txLimit) revert TxLimitExceeded();
        if (userDailyCount[msg.sender][block.timestamp / 1 days] + 1 > dailyTxCountLimit) {
            revert DailyLimitExceeded();
        }

        orderId = _placeBuyOrder(
            amount,
            currency,
            circleId,
            pubKey,
            preferredPaymentChannelConfigId,
            fiatAmountLimit
        );

        sessions[orderId] = Session({
            user: msg.sender,
            stockId: stockId,
            fulfilled: false,
            bridged: false,
            cancelled: false,
            rescued: false,
            placementDay: uint32(block.timestamp / 1 days),
            completedAt: 0,
            amount: amount,
            solanaWallet: solanaWallet,
            ref: ref
        });

        emit OrderPlaced(orderId, ref, msg.sender, stockId, amount, currency);
    }

    function _placeBuyOrder(
        uint256 amount,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) internal returns (uint256) {
        // Proxy-as-placer: the B2B gateway is proxy-only. recipientAddr =
        // address(this) so the purchased USDC lands here for burning; the proxy
        // is only the authenticated caller and never receives it.
        address proxy = _ensureProxy(msg.sender);
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
        return abi.decode(result, (uint256));
    }

    // ─── IP2PIntegrator callbacks ─────────────────────────────────────

    function validateOrder(
        address user,
        uint256 amount,
        bytes32 /* currency */
    ) external onlyDiamond returns (bool allowed) {
        if (amount > txLimit) return false;
        uint256 dayIndex = block.timestamp / 1 days;
        uint256 count = userDailyCount[user][dayIndex];
        if (count + 1 > dailyTxCountLimit) return false;
        userDailyCount[user][dayIndex] = count + 1;
        return true;
    }

    /**
     * @notice BUY completion hook. The Diamond has just delivered `amount` USDC
     *         here. Emit the delivery instruction, then burn to Solana.
     *
     * @dev The burn runs through an external self-call under try/catch so a
     *      CCTP failure cannot roll back this hook's bookkeeping. The gateway
     *      also try/catches this callback, so reverting here would silently
     *      strand the delivered USDC with no session record. Failing closed
     *      leaves the order fulfilled-but-unbridged and recoverable.
     */
    function onOrderComplete(
        uint256 orderId,
        address /* user */,
        uint256 amount,
        address recipientAddr
    ) external onlyDiamond {
        Session storage session = sessions[orderId];
        if (session.user == address(0)) return; // unknown / non-BUY order — no-op
        if (session.fulfilled) revert OrderAlreadyFulfilled();
        // The onramp pins this at placement, so a mismatch means the USDC is NOT
        // here. Reverting is correct — nothing is stranded, because nothing
        // arrived.
        if (recipientAddr != address(this)) revert UnexpectedRecipient();

        if (session.cancelled) {
            // Cancel-then-complete. The money has arrived; never revert once it
            // has. Re-charge the CURRENT day's bucket, not placementDay's.
            userDailyCount[session.user][block.timestamp / 1 days] += 1;
        }

        // Reserve at most what was PLACED, and at most what is actually
        // unreserved right now. `unbridgedTotal` is a claim on a POOLED
        // balance, so over-reserving would let this order's burn spend another
        // buyer's funds. Clamp rather than revert, for the reason above.
        //
        // In receiptMode the settlement token and the burn token differ, so the
        // bound is the pre-funded RESERVE, not what the Diamond just sent.
        uint256 bal = bridgeReserveToken.balanceOf(address(this));
        uint256 backed = bal > unbridgedTotal ? bal - unbridgedTotal : 0;
        uint256 delivered = amount < session.amount ? amount : session.amount;
        if (delivered > backed) delivered = backed;

        session.amount = delivered;
        session.fulfilled = true;
        session.completedAt = uint32(block.timestamp);
        unbridgedTotal += delivered;

        // Emitted BEFORE the burn: our worker needs the delivery instruction
        // even when the bridge leg fails closed (which is every order on
        // Base Sepolia). Delivery is gated off the CCTP mint landing, not off
        // this event alone.
        emit StockDeliveryRequested(
            orderId,
            session.ref,
            session.user,
            session.solanaWallet,
            session.stockId,
            delivered
        );

        if (delivered == 0) return; // nothing arrived; nothing to burn

        try this.selfBridge(orderId) {
            // bridged
        } catch (bytes memory reason) {
            emit BridgeFailed(orderId, reason);
        }
    }

    function onOrderCancel(uint256 orderId) external onlyDiamond {
        Session storage session = sessions[orderId];
        if (session.user == address(0)) return; // unknown — tolerate
        if (session.fulfilled || session.cancelled) return; // already terminal — tolerate
        session.cancelled = true;

        // Release the slot validateOrder consumed, keyed on the day it was
        // charged. Guarded so a double-cancel can never underflow.
        uint256 used = userDailyCount[session.user][session.placementDay];
        if (used > 0) userDailyCount[session.user][session.placementDay] = used - 1;

        emit OrderCancelled(orderId, session.user);
    }

    // ─── Bridge ───────────────────────────────────────────────────────

    /// @notice Permissionless retry for an order whose burn failed closed.
    function retryBridge(uint256 orderId) external nonReentrant {
        Session storage session = sessions[orderId];
        if (!session.fulfilled) revert NotFulfilled();
        if (session.bridged || session.rescued) revert AlreadyBridged();
        _bridge(orderId);
    }

    /// @dev Self-call entrypoint so `onOrderComplete` can try/catch the burn.
    ///      Reverting rolls back everything `_bridge` touched — including the
    ///      allowance it set — leaving the session cleanly unbridged.
    function selfBridge(uint256 orderId) external {
        if (msg.sender != address(this)) revert OnlySelf();
        _bridge(orderId);
    }

    function _bridge(uint256 orderId) internal {
        Session storage session = sessions[orderId];
        // Local idempotency guard, so a future second caller can never
        // double-burn one session out of another buyer's pooled reservation.
        if (session.bridged || session.rescued) revert AlreadyBridged();
        uint256 amount = session.amount;
        uint256 maxFee = _maxFeeFor(amount);

        // Checks-effects-interactions: mark bridged and release the reservation
        // BEFORE the external burn. A failed burn reverts the whole subcall and
        // rolls these writes back, leaving the order retryable.
        session.bridged = true;
        unbridgedTotal -= amount;

        bridgeReserveToken.forceApprove(address(tokenMessenger), amount);
        tokenMessenger.depositForBurn(
            amount,
            solanaDomain,
            treasuryUsdcAta,
            address(bridgeReserveToken),
            bytes32(0), // any address may deliver the message on Solana
            maxFee,
            bridgeMinFinalityThreshold
        );
        bridgeReserveToken.forceApprove(address(tokenMessenger), 0);

        emit BridgedToSolana(orderId, amount, treasuryUsdcAta, maxFee);
    }

    /// @dev CCTP requires `maxFee < amount`; clamp so a misconfigured bps can
    ///      never make the burn unsatisfiable. `amount == 0` would underflow.
    function _maxFeeFor(uint256 amount) internal view returns (uint256) {
        if (amount == 0) return 0;
        uint256 fee = (amount * bridgeMaxFeeBps) / 10_000;
        if (fee >= amount) fee = amount - 1;
        return fee;
    }

    /// @notice After RESCUE_DELAY, the buyer of a stuck order may pull their
    ///         USDC back on Base. Their funds, their call — not owner-gated.
    function userRescueStuckBridge(uint256 orderId) external nonReentrant {
        Session storage session = sessions[orderId];
        if (session.user != msg.sender) revert OnlyOwner();
        if (!session.fulfilled) revert NotFulfilled();
        if (session.bridged || session.rescued) revert AlreadyBridged();
        if (block.timestamp < uint256(session.completedAt) + RESCUE_DELAY) revert RescueTooEarly();

        uint256 amount = session.amount;
        session.rescued = true;
        unbridgedTotal -= amount;
        bridgeReserveToken.safeTransfer(msg.sender, amount);

        emit BridgeRescued(orderId, msg.sender, amount);
    }

    // ─── Views ────────────────────────────────────────────────────────

    function getSession(uint256 orderId) external view returns (Session memory) {
        return sessions[orderId];
    }

    function getRemainingDailyCount(address user) external view returns (uint256) {
        uint256 used = userDailyCount[user][block.timestamp / 1 days];
        return used >= dailyTxCountLimit ? 0 : dailyTxCountLimit - used;
    }

    // ─── Proxy helpers (mirror ExampleIntegrator exactly) ─────────────

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

    /// @dev Immutable args layout: [owner(20)][integrator(20)] — 40 bytes.
    ///      The Diamond's CREATE2-auth path reconstructs the same args, so
    ///      DO NOT change the layout.
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
