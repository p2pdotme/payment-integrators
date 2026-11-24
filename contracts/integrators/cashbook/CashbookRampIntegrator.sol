// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/* ═══════════════════════════════════════════════════════════════════════════
   CashbookRampIntegrator

   cashbook.app lets someone become a p2p.me merchant without ever touching
   crypto. They pay in fiat to open a merchant account, and later cash out to
   their bank. This contract is the bridge between that fiat and the p2p.me
   Diamond. The Diamond enforces every protocol rule it can; this contract
   applies the per-person limits B2B orders skip, and keeps track of whose
   money is whose until it is staked.

   WHO IS WHO
     person    the cashbook user, an ordinary account (their smart account).
               Their merchant account on the Diamond is keyed to THIS address.
     UserProxy a tiny clone per person. The Diamond only accepts B2B orders from
               a registered integrator's proxies, so every order is placed
               through it. Only this contract can drive it.
     Diamond   p2p.me. Matches orders with merchants, holds stakes, pays out.

   DEPOSIT: fiat in, merchant stake out (a B2B BUY)
     1. depositFiat places a BUY from the person's proxy, with order.user = the
        person and recipientAddr = this contract. A merchant on the other side
        receives the fiat and releases USDC.
        Every deposit must leave the account at or above the Diamond's minimum
        stake once staked (the account's stake, plus what is pending, plus this
        deposit), or it reverts BelowStakeFloor: the Diamond's stake refuses
        anything less, and the USDC would wait here. Someone with no account
        opens it in the currency of their latest deposit, whichever order id
        stakeDeposit is called with.
     2. The order completes. The Diamond sends the USDC here and calls
        onOrderComplete, which adds it to pendingStake[person]. If that hook
        never ran, anyone can call reconcileDelivery to do the same.
     3. stakeDeposit(orderId), callable by anyone (normally our keeper), stakes
        everything the person has pending into their own merchant account:
        registerFor if the account does not exist yet (in currencyOf and the
        circle the person signed for), stakeFor if it does.
   CONSENT: the Diamond opens an account only with the merchant's own
   EIP-712 signature over (merchant, circle, currency, telegram id) —
   contracts-v4 #518. With no account, depositFiat takes that signature,
   checks it against the Diamond's registrationDigest before any money
   moves (so a bad one can never strand a delivery), and keeps it with the
   circle it names; stakeDeposit hands it to registerFor. The latest
   deposit's signature wins, with its currency.
   Steps 2 and 3 must be two transactions. completeOrder holds the Diamond's
   shared reentrancy lock while it calls our hook, and registerFor/stakeFor
   take the same lock, so staking from inside the hook always reverts.

   REWARDS: cashbook's own USDC, added to an account's stake. Fund it by a
   plain transfer to this contract. Only the owner pays it out (rewardStake,
   a batch of accounts and amounts), into any merchant account, and only
   from the free balance (below). Who earns a reward and how much is decided
   off chain (cashbook's backend). A reward is ordinary stake and leaves with
   the account on unstake.

   WITHDRAW: merchant money out to a bank (a B2B SELL)
     withdrawFiat places a SELL with order.user = the person, for any
     merchant account, opened here or not, in that account's currency. The
     Diamond pulls the USDC from the person's WALLET at setSellOrderUpi, not
     from their stake: what they sell is what reached their wallet from the
     Diamond (an approved unstake, or the merchant earnings it pays out).
     This contract's rewards only ever become stake.

   LIMITS (B2B orders skip the Diamond's RP per-tx, count, volume and
   blacklist checks, so these are the only ones that apply):
     deposit   at most getMaxBuyTxLimit(currency) each, MAX_DEPOSITS_PER_DAY a
               day per person; refused for the Diamond's merchant blacklist and
               ReputationManager's user blacklist.
     withdraw  at most getMaxSellTxLimit(currency) each, MAX_WITHDRAWALS_PER_DAY
               a day per person, only in the account's own currency (so the
               cap cannot be shopped); refused for the merchant blacklist.
               These stand in for the consumer SELL limits B2B placement
               skips: a merchant account is permanent and costs only a
               refundable floor, so without them this is an uncapped offramp.
   A day is a UTC day. Every placed order counts, cancelled or not. These are
   per address: they do not stop someone using many addresses.

   MONEY HELD HERE, and the only ways it leaves:
     pendingStake      people's delivered deposits (totalPending in all) →
                       only into the Diamond, as that person's own stake
     everything else   the free balance: any token, and USDC above
                       totalPending → the owner (withdraw), or USDC into an
                       account's stake (rewardStake)
   ⚠ A delivery whose completion hook did not run is not in totalPending until
   reconcileDelivery credits it, so it reads as free until then: credit every
   delivery before the owner withdraws or rewards (cashbook's backend
   check-credited lists any that are not).
   A person's pending USDC never moves from here to anyone but the Diamond,
   as their stake; it reaches their wallet only through the Diamond's own
   unstake. withdraw reaches only the free balance. If the Diamond refuses the
   stake (a blacklist, a pending unstake, a full circle), the money waits here,
   still theirs, and stakeDeposit lands it once the refusal is lifted.
   ═══════════════════════════════════════════════════════════════════════ */

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { IOrderFlow } from "../../interfaces/IOrderFlow.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @notice The p2p.me Diamond functions this contract calls, and nothing more.
interface IP2PDiamond {
    /// @dev Mirrors OrderProcessorStorage.OrderStatus, in the same order.
    enum OrderStatus {
        PLACED,
        ACCEPTED,
        PAID,
        COMPLETED,
        CANCELLED
    }

    /// @dev The leading fields of ProtocolConfigStorage.StakeConfig (all static,
    ///      so decoding this prefix is exact).
    struct StakeConfigHead {
        uint256 minCircleAdminP2PStake;
        uint256 minMerchantUSDCStake; // the floor registerFor and stakeFor enforce
    }

    /// @dev The leading fields of MerchantRegistryStorage.MerchantDetails. Every
    ///      field here is static, so decoding just this prefix of the returned
    ///      tuple is exact; the fields after `currency` are not needed.
    struct MerchantDetails {
        uint256 stake;
        bool isOnline;
        uint256 totalVolume;
        uint256 withdrawnAmount;
        uint256 lastVolumeResetTimestamp;
        uint256 accruedFees;
        bool isRegistered;
        bytes32 currency;
    }

    /// @dev Opens `merchant`'s account and pulls the stake from msg.sender (us).
    ///      Anyone may call it with `merchant`'s EIP-712 signature over
    ///      registrationDigest(merchant, circleId, currency, telegramId)
    ///      (contracts-v4 #518); the Diamond checks `merchant`'s blacklist.
    function registerFor(
        address merchant,
        uint256 circleId,
        uint256 stakeAmount,
        string calldata telegramId,
        bytes32 currency,
        bytes calldata signature
    ) external;

    /// @dev The digest `merchant` signs for registerFor (ECDSA or ERC-1271).
    function registrationDigest(
        address merchant,
        uint256 circleId,
        bytes32 currency,
        string calldata telegramId
    ) external view returns (bytes32);

    /// @dev Adds to `merchant`'s existing account, pulling from msg.sender (us).
    ///      Only an active integrator may call it (onlyActiveIntegrator,
    ///      contracts-v4 #518). Reverts below the floor, on a pending unstake,
    ///      on the merchant blacklist, in a paused circle.
    function stakeFor(address merchant, uint256 stakeAmount, bytes32 currency) external;

    function getMerchantDetails(address merchant) external view returns (MerchantDetails memory);
    /// @dev ProtocolConfigFacet: the currency's stake config; only its leading
    ///      fields are declared (see StakeConfigHead).
    function getStakeConfig(bytes32 currency) external view returns (StakeConfigHead memory);
    /// @dev The largest single BUY allowed in `currency`; 0 closes the currency.
    function getMaxBuyTxLimit(bytes32 currency) external view returns (uint256);
    /// @dev The largest single SELL allowed in `currency`; 0 closes the currency.
    function getMaxSellTxLimit(bytes32 currency) external view returns (uint256);
    /// @dev The Diamond's own day key (OrderFlowHelper), the one its daily
    ///      limits count by.
    function getDayKey(uint256 ts) external view returns (uint256);
    /// @dev The MERCHANT blacklist (only a registered merchant can be on it).
    function isBlacklisted(address merchant) external view returns (bool);
    function getUnstakeRequested(address merchant) external view returns (bool);
    function getOrdersById(uint256 orderId) external view returns (IOrderFlow.OrderView memory);
    /// @dev B2BGatewayFacet: the integrator whose proxy placed `orderId`, else 0.
    function getOrderIntegrator(uint256 orderId) external view returns (address);
}

/// @dev ReputationManager's USER blacklist (contracts-v4 IReputationManager.RmUser:
///      reputationPoints, voteCount, isBlacklisted). The Diamond's isBlacklisted
///      only covers merchants, and placeOrderForB2B leaves the user check to the
///      integrator (OrderFlowFacet.sol:364). HypeHouseRampIntegrator does the same.
interface IRmUserBlacklist {
    function rmusers(address user) external view returns (uint256, uint256, bool);
}

/// @dev Ownership is OpenZeppelin's Ownable2Step: the owner proposes a new owner
///      (transferOwnership) and it only takes effect when that address accepts
///      (acceptOwnership), so a mistyped address can never take the role. The
///      owner's only powers are setCircle, rewardStake and withdraw.
contract CashbookRampIntegrator is IP2PIntegrator, ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    // ─── Errors ───────────────────────────────────────────────────────

    /// @notice A Diamond-only callback was called by someone else.
    error OnlyDiamond();
    /// @notice Ownership can move (transferOwnership) but never be given up: a
    ///         renounced owner would freeze setCircle for good, and a full or
    ///         paused circle would then strand every new opening.
    error CannotRenounce();
    /// @notice The deposit would leave the account below the Diamond's minimum
    ///         stake (its stake, plus what is pending, plus this deposit).
    error BelowStakeFloor();
    /// @notice A required address was zero.
    error InvalidAddress();
    /// @notice An amount was zero.
    error InvalidAmount();
    /// @notice Above the Diamond's getMaxBuyTxLimit / getMaxSellTxLimit.
    error AmountExceedsCap();
    /// @notice The person already has an account, or pending deposits, in a
    ///         different currency (a deposit could never be staked into it), or
    ///         a withdrawal names a currency other than the account's.
    error SeatCurrencyMismatch();
    /// @notice The person's account is mid-unstake; stakeFor would refuse the deposit.
    error UnstakePending();
    /// @notice On the Diamond's merchant blacklist.
    error MerchantBlacklisted();
    /// @notice On ReputationManager's user blacklist.
    error UserBlacklisted();
    /// @notice withdrawFiat and rewardStake need a merchant account on the Diamond.
    error NoSeat();
    /// @notice The person has placed today's maximum number of deposits or withdrawals.
    error DailyLimitReached();
    /// @notice The order was not placed by this integrator, or not paid to it.
    error NotOurs();
    /// @notice The order has not been delivered (credited) here yet.
    error DepositNotDelivered();
    /// @notice The person has nothing pending; it has already been staked.
    error DepositAlreadyStaked();
    /// @notice The delivery has already been credited.
    error OrderAlreadyFulfilled();
    /// @notice rewardStake: no accounts, or accounts and amounts of different lengths.
    error LengthMismatch();
    /// @notice More than the free balance (people's pending money is never free).
    error InsufficientFree();
    /// @notice An opening deposit in a currency with no cashbook circle set.
    error CircleNotSet();
    /// @notice An opening deposit without the person's signature for the
    ///         account it would open (registrationDigest, circleOf[currency]).
    error ConsentInvalid();

    // ─── Events ───────────────────────────────────────────────────────

    /// @notice A deposit (B2B BUY) was placed. `ref` is the app's own reference.
    event DepositPlaced(
        uint256 indexed orderId,
        address indexed user,
        uint256 amount,
        bytes32 currency,
        bytes32 indexed ref
    );
    /// @notice A deposit's USDC arrived and was added to pendingStake. The
    ///         keeper's cue to call stakeDeposit(orderId). The backend matches
    ///         this exact signature, so changing it means redeploying both.
    event DepositDelivered(uint256 indexed orderId, address indexed user, uint256 amount);
    /// @notice A person's UserProxy was deployed (on their first order).
    event UserProxyDeployed(address indexed user, address proxy);
    /// @notice Pending money was staked into the person's merchant account.
    /// @param paid   what the person paid in (their pending deposits).
    /// @param opened true when this stake opened the account (registerFor).
    event DepositStaked(uint256 indexed orderId, address indexed user, uint256 paid, bool opened);
    /// @notice The owner set the circle new accounts in `currency` open in.
    event CircleSet(bytes32 indexed currency, uint256 circleId);
    /// @notice The owner moved free money out.
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    /// @notice A reward was staked into `user`'s account.
    event Rewarded(address indexed user, uint256 amount);
    /// @notice A withdrawal (B2B SELL) was placed. `ref` is the app's own reference.
    event WithdrawalPlaced(
        uint256 indexed orderId,
        address indexed user,
        uint256 amount,
        bytes32 currency,
        bytes32 indexed ref
    );

    // ─── Limits ───────────────────────────────────────────────────────

    /// @notice Deposits one person may place in a UTC day (the Diamond's own
    ///         per-buyer daily count, which B2B placement skips).
    uint256 public constant MAX_DEPOSITS_PER_DAY = 5;
    /// @notice Withdrawals one person may place in a UTC day, counted apart from
    ///         deposits (the Diamond's per-seller daily count, which B2B
    ///         placement skips).
    uint256 public constant MAX_WITHDRAWALS_PER_DAY = 5;

    // ─── Immutables ───────────────────────────────────────────────────

    /// @notice The p2p.me Diamond.
    IP2PDiamond public immutable diamond;
    /// @notice The Diamond's USDC. UserProxy.sweepERC20 reads this and refuses
    ///         to sweep it, so bought USDC can never be pulled out of a proxy.
    IERC20 public immutable usdc;
    /// @notice The UserProxy implementation every person's clone points at. The
    ///         Diamond pins it at registerIntegrator and accepts orders only from
    ///         clones at the address it derives from it
    ///         (B2BGatewayFacet._resolveIntegrator). A redeploy therefore needs a
    ///         new registration, and gives everyone a new proxy.
    address public immutable proxyImpl;
    /// @notice ReputationManager, for the user blacklist. 0 turns the check off
    ///         (only for a testnet Diamond that has none). Fixed at deploy: if the
    ///         Diamond switches to a new ReputationManager, redeploy this.
    IRmUserBlacklist public immutable reputationManager;

    // ─── State ────────────────────────────────────────────────────────

    /// @notice The circle every account opening in `currency` registers in:
    ///         cashbook's own circle, where banks are approved on adding. Only the
    ///         account's circle; the deposit order itself is matched in whatever
    ///         circle depositFiat names. 0 = not set (circle ids start at 1).
    mapping(bytes32 => uint256) public circleOf;
    /// @notice Σ pendingStake: the USDC here that belongs to people.
    uint256 public totalPending;
    /// @notice Per person: USDC delivered here and not yet staked. It can only
    ///         leave as that person's stake on the Diamond.
    mapping(address => uint256) public pendingStake;
    /// @notice The currency the account of someone with no account opens in:
    ///         that of their latest deposit.
    mapping(address => bytes32) public currencyOf;
    /// @notice With no account: the person's signature for registerFor, from
    ///         their latest deposit, and the circle it names. Cleared once the
    ///         account opens.
    mapping(address => bytes) public consentOf;
    mapping(address => uint256) public consentCircleOf;

    /// @notice Deposits and withdrawals placed per person per day, keyed by the
    ///         Diamond's getDayKey.
    mapping(address => mapping(uint256 => uint256)) public depositsOn;
    mapping(address => mapping(uint256 => uint256)) public withdrawalsOn;

    /// @notice Deliveries already added to pendingStake, so none counts twice
    ///         (the hook and reconcileDelivery can both see the same order).
    mapping(uint256 => bool) public credited;

    modifier onlyDiamond() {
        if (msg.sender != address(diamond)) revert OnlyDiamond();
        _;
    }

    /// @param _diamond           the p2p.me Diamond
    /// @param _usdc              the Diamond's USDC
    /// @param _owner             sets circles, pays rewards, withdraws free money (a
    ///                           Safe on mainnet). It can never touch pendingStake
    ///                           or any order.
    /// @param _reputationManager the Diamond's getReputationManager(), or 0 for none
    constructor(
        address _diamond,
        address _usdc,
        address _owner,
        address _reputationManager
    ) Ownable(_owner) {
        if (_diamond == address(0) || _usdc == address(0)) revert InvalidAddress();
        diamond = IP2PDiamond(_diamond);
        usdc = IERC20(_usdc);
        reputationManager = IRmUserBlacklist(_reputationManager);
        proxyImpl = address(new UserProxy());
    }

    // ─── Owner ────────────────────────────────────────────────────────

    /// @notice Always reverts CannotRenounce: ownership only moves.
    function renounceOwnership() public pure override {
        revert CannotRenounce();
    }

    /// @notice Set the circle accounts opening in `currency` register in. Applies
    ///         to accounts opened from now on: an existing account keeps its
    ///         circle (a top-up is stakeFor, which takes none). 0 stops new
    ///         accounts in that currency. The Diamond checks the circle's state
    ///         and currency at registration; this does not.
    function setCircle(bytes32 currency, uint256 circleId) external onlyOwner {
        circleOf[currency] = circleId;
        emit CircleSet(currency, circleId);
    }

    /// @notice Send `amount` of `token` to `to`: any token, and USDC only up to
    ///         the free balance, so people's pending money never leaves this way.
    function withdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (to == address(0)) revert InvalidAddress();
        if (amount > available(token)) revert InsufficientFree();
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, to, amount);
    }

    // ─── Rewards ──────────────────────────────────────────────────────

    /// @notice Stake `amounts[i]` of free USDC into `users[i]`'s account, for
    ///         each i. Owner only, any merchant account, opened here or not.
    ///         Who opened here is DepositStaked(…, opened = true) and what each
    ///         was paid is Rewarded: read them from the events. All or nothing:
    ///         any refusal here or by the Diamond's stakeFor (blacklisted,
    ///         pending unstake, below the minimum stake) reverts the whole batch.
    function rewardStake(
        address[] calldata users,
        uint256[] calldata amounts
    ) external onlyOwner nonReentrant {
        uint256 n = users.length;
        if (n == 0 || n != amounts.length) revert LengthMismatch();
        uint256 total;
        for (uint256 i; i < n; ++i) total += amounts[i];
        if (total > available(address(usdc))) revert InsufficientFree();

        // Exact allowance for the batch, reset after: pendingStake is here too.
        usdc.forceApprove(address(diamond), total);
        for (uint256 i; i < n; ++i) {
            address user = users[i];
            uint256 amount = amounts[i];
            if (amount == 0) revert InvalidAmount();
            IP2PDiamond.MerchantDetails memory m = diamond.getMerchantDetails(user);
            if (!m.isRegistered) revert NoSeat();
            diamond.stakeFor(user, amount, m.currency);
            emit Rewarded(user, amount);
        }
        usdc.forceApprove(address(diamond), 0);
    }

    // ─── Views ────────────────────────────────────────────────────────

    /// @notice What the owner may move of `token`: all of it, except USDC that
    ///         belongs to people (totalPending).
    function available(address token) public view returns (uint256) {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (token != address(usdc)) return bal;
        return bal > totalPending ? bal - totalPending : 0;
    }

    /// @notice Where `user`'s UserProxy lives (deployed or not). The Diamond
    ///         derives the same address to recognise our orders.
    function proxyAddress(address user) public view returns (address) {
        return
            Clones.predictDeterministicAddressWithImmutableArgs(
                proxyImpl,
                _proxyArgs(user),
                _salt(user),
                address(this)
            );
    }

    // ─── Deposit ──────────────────────────────────────────────────────

    /// @notice Pay fiat in to open or top up your merchant account. One call for
    ///         both; the contract works out which it is.
    /// @dev    Refused up front, before any money moves: a blacklisted caller,
    ///         today's count reached, an amount over the max buy, a deposit that
    ///         would leave the account below the minimum stake, and (for an
    ///         existing account) a different currency or a pending unstake: the
    ///         cases the Diamond's stake would refuse after delivery, stranding
    ///         the USDC here. With no account: a currency with no circleOf, or
    ///         a consent that is not the person's
    ///         signature for that account. Circle state and capacity are
    ///         checked by the Diamond when it stakes.
    /// @param amount   USDC to buy (6 decimals)
    /// @param currency the on-chain currency code (e.g. "INR", "MEX" — not ISO "MXN")
    /// @param circleId the circle the order is matched in (any; the account
    ///                 opens in circleOf[currency])
    /// @param pubKey   the person's relay key; the merchant encrypts where to pay to it
    /// @param preferredPaymentChannelConfigId 0 for any payment channel
    /// @param fiatAmountLimit 0 for no limit on the fiat side
    /// @param ref      the app's own reference, echoed in DepositPlaced
    /// @param consent  with no account: the person's signature over
    ///                 diamond.registrationDigest(person, circleOf[currency],
    ///                 currency, ""); ignored for an existing account. A smart
    ///                 account sends its inner ERC-1271 signature, never an
    ///                 ERC-6492 wrapper (the Diamond does not unwrap one).
    function depositFiat(
        uint256 amount,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit,
        bytes32 ref,
        bytes calldata consent
    ) external nonReentrant returns (uint256 orderId) {
        if (amount == 0) revert InvalidAmount();
        if (diamond.isBlacklisted(msg.sender)) revert MerchantBlacklisted();
        if (_userBlacklisted(msg.sender)) revert UserBlacklisted();
        _countToday(depositsOn, MAX_DEPOSITS_PER_DAY);
        if (amount > diamond.getMaxBuyTxLimit(currency)) revert AmountExceedsCap();

        IP2PDiamond.MerchantDetails memory m = diamond.getMerchantDetails(msg.sender);
        if (m.isRegistered) {
            if (m.currency != currency) revert SeatCurrencyMismatch();
            if (diamond.getUnstakeRequested(msg.sender)) revert UnstakePending();
        } else {
            /* The latest deposit picks the currency the account opens in.
               stakeDeposit reads currencyOf at stake time and USDC carries no
               currency, so pending money stakes in whichever is picked last. It
               is safe because the floor check below counts what is pending
               against this currency, and every delivered deposit met its own
               currency's floor: one more deposit in that currency always lets
               the pending money stake. Only the person can change their own. */
            currencyOf[msg.sender] = currency;
            uint256 circle = circleOf[currency];
            if (circle == 0) revert CircleNotSet();
            /* Checked here, against the Diamond's own digest, so a signature
               registerFor would refuse never gets as far as a delivery. The
               circle is kept with it: changing circleOf later cannot void it. */
            if (
                !SignatureChecker.isValidSignatureNow(
                    msg.sender,
                    diamond.registrationDigest(msg.sender, circle, currency, ""),
                    consent
                )
            ) revert ConsentInvalid();
            consentOf[msg.sender] = consent;
            consentCircleOf[msg.sender] = circle;
        }
        // m.stake is 0 with no account. Undelivered deposits do not count.
        if (
            m.stake + pendingStake[msg.sender] + amount <
            diamond.getStakeConfig(currency).minMerchantUSDCStake
        ) {
            revert BelowStakeFloor();
        }

        /* user = the person, never the proxy: only the order's user can mark it
           paid. recipientAddr = this contract, so the person never holds the
           bought USDC. */
        orderId = _placeFromProxy(
            abi.encodeCall(
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
            )
        );
        emit DepositPlaced(orderId, msg.sender, amount, currency, ref);
    }

    // ─── Withdraw ─────────────────────────────────────────────────────

    /// @notice Cash out: place a SELL of USDC in your wallet to your bank. The
    ///         Diamond pulls it from your wallet at setSellOrderUpi (not from
    ///         your stake), and a refund goes back to you.
    /// @dev    Any merchant account, opened here or not, in its own currency, at
    ///         most the Diamond's max sell per order and MAX_WITHDRAWALS_PER_DAY
    ///         a day. Not a general USDC exit (no account: NoSeat), and never for
    ///         the merchant blacklist, which B2B placement skips.
    function withdrawFiat(
        uint256 amount,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit,
        bytes32 ref
    ) external nonReentrant returns (uint256 orderId) {
        if (amount == 0) revert InvalidAmount();
        IP2PDiamond.MerchantDetails memory m = diamond.getMerchantDetails(msg.sender);
        if (!m.isRegistered) revert NoSeat();
        if (m.currency != currency) revert SeatCurrencyMismatch();
        if (diamond.isBlacklisted(msg.sender)) revert MerchantBlacklisted();
        _countToday(withdrawalsOn, MAX_WITHDRAWALS_PER_DAY);
        if (amount > diamond.getMaxSellTxLimit(currency)) revert AmountExceedsCap();
        orderId = _placeFromProxy(
            abi.encodeCall(
                IB2BGateway.placeB2BSellOrder,
                (
                    msg.sender,
                    amount,
                    currency,
                    pubKey,
                    circleId,
                    preferredPaymentChannelConfigId,
                    fiatAmountLimit
                )
            )
        );
        emit WithdrawalPlaced(orderId, msg.sender, amount, currency, ref);
    }

    // ─── Diamond callbacks ────────────────────────────────────────────

    /// @notice The Diamond asks this inside placeB2BOrder / placeB2BSellOrder.
    ///         Always yes: the Diamond accepts orders only from our clones, only
    ///         this contract can drive a clone (UserProxy.execute is
    ///         integrator-only), and every check ran before the order was placed.
    function validateOrder(address, uint256, bytes32) external view onlyDiamond returns (bool) {
        return true;
    }

    /// @notice A BUY completed: the Diamond has already sent the USDC here
    ///         (B2BGatewayFacet.onB2BOrderComplete). Record it and nothing more.
    /// @dev    Never stakes (the Diamond's lock is held, see the header) and
    ///         never reverts, so a completion can never be blocked by us.
    function onOrderComplete(
        uint256 orderId,
        address user,
        uint256 amount,
        address recipientAddr
    ) external onlyDiamond {
        if (credited[orderId] || recipientAddr != address(this)) return;
        _credit(orderId, user, amount);
    }

    /// @notice Credit a delivery whose completion hook never ran (the Diamond
    ///         calls hooks best-effort). Anyone may call.
    /// @dev    Both "ours" checks matter: another integrator registered with
    ///         usdcThroughIntegrator could place a BUY naming us as recipient
    ///         while its USDC actually goes to itself.
    function reconcileDelivery(uint256 orderId) external nonReentrant {
        if (credited[orderId]) revert OrderAlreadyFulfilled();
        if (diamond.getOrderIntegrator(orderId) != address(this)) revert NotOurs();
        IOrderFlow.OrderView memory o = diamond.getOrdersById(orderId);
        if (o.recipientAddr != address(this)) revert NotOurs();
        if (o.status != uint8(IP2PDiamond.OrderStatus.COMPLETED)) revert DepositNotDelivered();
        _credit(orderId, o.user, o.amount);
    }

    /// @notice A cancelled order needs nothing undone here. Never reverts, as
    ///         the gateway requires before cancel callbacks can be switched on.
    function onOrderCancel(uint256) external view onlyDiamond {}

    /// @dev Mark `orderId` delivered and add its USDC to `user`'s pending money.
    function _credit(uint256 orderId, address user, uint256 amount) internal {
        credited[orderId] = true;
        pendingStake[user] += amount;
        totalPending += amount;
        emit DepositDelivered(orderId, user, amount);
    }

    // ─── Stake ────────────────────────────────────────────────────────

    /// @notice Stake everything `orderId`'s person has pending into their own
    ///         merchant account. No account yet: registerFor in currencyOf[person]
    ///         and the circle their consent names, with that consent; never the
    ///         named order's currency or circle.
    ///         Account exists: stakeFor, in its own currency.
    /// @dev    Callable by anyone, so the person never depends on our keeper
    ///         being up. Every argument comes from the Diamond's order and this
    ///         contract's state, so a caller can trigger it but never steer it.
    function stakeDeposit(uint256 orderId) external nonReentrant {
        if (!credited[orderId]) revert DepositNotDelivered();
        address user = diamond.getOrdersById(orderId).user;
        uint256 paid = pendingStake[user];
        if (paid == 0) revert DepositAlreadyStaked();
        pendingStake[user] = 0;
        totalPending -= paid;

        IP2PDiamond.MerchantDetails memory seat = diamond.getMerchantDetails(user);
        // Exact allowance, reset after: this contract holds other people's money.
        usdc.forceApprove(address(diamond), paid);
        if (seat.isRegistered) {
            diamond.stakeFor(user, paid, seat.currency);
        } else {
            diamond.registerFor(
                user,
                consentCircleOf[user],
                paid,
                "",
                currencyOf[user],
                consentOf[user]
            );
            delete consentOf[user];
            delete consentCircleOf[user];
        }
        usdc.forceApprove(address(diamond), 0);

        emit DepositStaked(orderId, user, paid, !seat.isRegistered);
    }

    // ─── Limits ───────────────────────────────────────────────────────

    /// @dev Count one more order for msg.sender today, or revert DailyLimitReached.
    function _countToday(
        mapping(address => mapping(uint256 => uint256)) storage counts,
        uint256 max
    ) internal {
        uint256 day = diamond.getDayKey(block.timestamp);
        uint256 n = counts[msg.sender][day];
        if (n >= max) revert DailyLimitReached();
        counts[msg.sender][day] = n + 1;
    }

    // ─── UserProxy ────────────────────────────────────────────────────

    /// @dev Place `call` on the Diamond from the caller's UserProxy (deploying
    ///      it first if needed) and return the new order id.
    function _placeFromProxy(bytes memory call) internal returns (uint256 orderId) {
        address proxy = _ensureProxy(msg.sender);
        bytes memory result = UserProxy(proxy).execute(address(diamond), call, address(usdc), 0);
        orderId = abi.decode(result, (uint256));
    }

    /// @dev `user`'s UserProxy, deployed on first use at exactly proxyAddress —
    ///      the address the Diamond's CREATE2 check re-derives. Same as
    ///      HypeHouseRampIntegrator.
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

    /// @dev On ReputationManager's user blacklist. Checked for deposits only,
    ///      as the Diamond's own rule stops BUYs only: a blacklisted user can
    ///      still take their money out.
    function _userBlacklisted(address user) internal view returns (bool) {
        if (address(reputationManager) == address(0)) return false;
        (, , bool blacklisted) = reputationManager.rmusers(user);
        return blacklisted;
    }

    /// @dev One proxy per person: the salt is their address.
    function _salt(address user) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(user)));
    }

    /// @dev The immutable args baked into each clone: its owner and this integrator.
    function _proxyArgs(address user) internal view returns (bytes memory) {
        return abi.encodePacked(user, address(this));
    }
}
