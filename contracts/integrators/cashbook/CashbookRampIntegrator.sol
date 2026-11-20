// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/* ═══════════════════════════════════════════════════════════════════════════
   CashbookRampIntegrator

   cashbook.app lets someone become a p2p.me merchant without ever touching
   crypto. They pay in fiat to open a merchant account, and later cash out to
   their bank. This contract is the bridge between that fiat and the p2p.me
   Diamond. The Diamond enforces every protocol rule it can; this contract only
   keeps track of whose money is whose until it is staked.

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
        If the person has no merchant account yet, this is an "opening"
        deposit: the currency's bonus is reserved for them from its pool right
        now, or the call reverts NoBonus if the pool cannot cover it. It must
        reach the Diamond's minimum stake on its own (with what is already
        pending and the bonus), or it reverts BelowStakeFloor, so no opening
        money can be left waiting for a top-up that may never be possible.
        One currency per opening: a deposit in another while one is live
        reverts SeatCurrencyMismatch.
     2. The order completes. The Diamond sends the USDC here and calls
        onOrderComplete, which adds it to pendingStake[person]. If that hook
        never ran, anyone can call reconcileDelivery to do the same.
     3. stakeDeposit(orderId), callable by anyone (normally our keeper), stakes
        everything the person has pending into their own merchant account:
        registerFor plus the reserved bonus if the account does not exist yet,
        stakeFor if it does. The account opens in the opening's currency and
        circleOf[that currency], whichever order id the caller names.
   Steps 2 and 3 must be two transactions. completeOrder holds the Diamond's
   shared reentrancy lock while it calls our hook, and registerFor/stakeFor
   take the same lock, so staking from inside the hook always reverts.

   THE BONUS: a fixed USDC amount per currency (bonus[currency], set by the
   owner), paid from that currency's pool (bonusPool[currency], which anyone
   may fund). It is reserved when the opening deposit is placed, so a pool
   emptied by others cannot take it away. It goes back to the pool if the
   opening order is cancelled (releaseBonus, or the person's next deposit) or
   if the account was opened somewhere else first; a cancelled opening that
   an admin later reopens and completes is credited with no bonus.

   WITHDRAW: merchant money out to a bank (a B2B SELL)
     withdrawFiat places a SELL with order.user = the person. The Diamond pulls
     the USDC from the person's own account at setSellOrderUpi; this contract
     never holds withdrawal money and sets no limit on it.

   LIMITS: each deposit is at most the Diamond's getMaxBuyTxLimit for its
   currency (B2B orders skip the Diamond's own per-order limits). An account on
   the Diamond's merchant blacklist or ReputationManager's user blacklist
   cannot deposit. There is no daily count; cancelled orders are watched from
   the subgraph instead.

   MONEY HELD HERE, and the only ways it leaves:
     pendingStake      people's delivered deposits → only into the Diamond, as
                       that person's own stake
     reserved bonuses  → into the stake that opens the account, or back to the pool
     bonusPool         → into reservations, or to the owner (withdrawBonus)
   USDC never moves from here to a person. Bought USDC is for use inside the
   Diamond only.
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
        uint256 minMerchantUSDCStake; // the floor registerFor enforces
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
    ///      Only an active B2B integrator may call it.
    function registerFor(
        address merchant,
        uint256 circleId,
        uint256 stakeAmount,
        string calldata telegramId,
        bytes32 currency
    ) external;

    /// @dev Adds to `merchant`'s existing account, pulling from msg.sender (us).
    ///      Only an active B2B integrator may call it.
    function stakeFor(address merchant, uint256 stakeAmount, bytes32 currency) external;

    function getMerchantDetails(address merchant) external view returns (MerchantDetails memory);
    /// @dev ProtocolConfigFacet: the currency's stake config; only its leading
    ///      fields are declared (see StakeConfigHead).
    function getStakeConfig(bytes32 currency) external view returns (StakeConfigHead memory);
    /// @dev The largest single BUY allowed in `currency`; 0 closes the currency.
    function getMaxBuyTxLimit(bytes32 currency) external view returns (uint256);
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
///      owner's only powers are setCircle, setBonus and withdrawBonus.
contract CashbookRampIntegrator is IP2PIntegrator, ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    // ─── Errors ───────────────────────────────────────────────────────

    /// @notice A Diamond-only callback was called by someone else.
    error OnlyDiamond();
    /// @notice Ownership can move (transferOwnership) but never be given up: a
    ///         renounced owner would freeze setCircle for good, and a full or
    ///         paused circle would then strand every new opening.
    error CannotRenounce();
    /// @notice An opening deposit that, with what is pending and its bonus, is
    ///         below the Diamond's minimum stake for the currency.
    error BelowStakeFloor();
    /// @notice A required address was zero.
    error InvalidAddress();
    /// @notice An amount was zero.
    error InvalidAmount();
    /// @notice The deposit is above the Diamond's getMaxBuyTxLimit for its currency.
    error AmountExceedsCap();
    /// @notice The person already has an account, or a live opening, in a
    ///         different currency; the deposit could never be staked into it.
    error SeatCurrencyMismatch();
    /// @notice The person's account is mid-unstake; stakeFor would refuse the deposit.
    error UnstakePending();
    /// @notice On the Diamond's merchant blacklist.
    error MerchantBlacklisted();
    /// @notice On ReputationManager's user blacklist.
    error UserBlacklisted();
    /// @notice withdrawFiat needs a merchant account on the Diamond.
    error NoSeat();
    /// @notice An opening deposit, but the currency's pool cannot cover its bonus.
    ///         The admin can fund the pool or set the bonus to 0 to reopen it.
    error NoBonus();
    /// @notice The order was not placed by this integrator, or not paid to it.
    error NotOurs();
    /// @notice The order has not been delivered (credited) here yet.
    error DepositNotDelivered();
    /// @notice The person has nothing pending; it has already been staked.
    error DepositAlreadyStaked();
    /// @notice The delivery has already been credited.
    error OrderAlreadyFulfilled();
    /// @notice releaseBonus: no reservation, or its order is not CANCELLED.
    error NotCancelled();
    /// @notice withdrawBonus asked for more than the unreserved pool.
    error BonusPoolShort();
    /// @notice An opening deposit in a currency with no cashbook circle set.
    error CircleNotSet();

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
    /// @param bonus  what the pool added on top (non-zero only when opening).
    /// @param opened true when this stake opened the account (registerFor).
    event DepositStaked(
        uint256 indexed orderId,
        address indexed user,
        uint256 paid,
        uint256 bonus,
        bool opened
    );
    /// @notice The owner set a currency's opening bonus.
    event BonusSet(bytes32 indexed currency, uint256 amount);
    /// @notice The owner set the circle new accounts in `currency` open in.
    event CircleSet(bytes32 indexed currency, uint256 circleId);
    /// @notice Someone added to a currency's bonus pool.
    event BonusFunded(address indexed from, bytes32 indexed currency, uint256 amount);
    /// @notice The owner took unreserved pool money back.
    event BonusWithdrawn(bytes32 indexed currency, address indexed to, uint256 amount);
    /// @notice An opening deposit set aside a bonus from the pool.
    event BonusReserved(uint256 indexed orderId, address indexed user, uint256 amount);
    /// @notice A reserved bonus went back to its pool (cancelled, or opened elsewhere).
    event BonusReleased(uint256 indexed orderId, address indexed user, uint256 amount);
    /// @notice A withdrawal (B2B SELL) was placed. `ref` is the app's own reference.
    event WithdrawalPlaced(
        uint256 indexed orderId,
        address indexed user,
        uint256 amount,
        bytes32 currency,
        bytes32 indexed ref
    );

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
    /// @notice USDC added to an account that opens in `currency`. 0 = no bonus.
    mapping(bytes32 => uint256) public bonus;
    /// @notice Unreserved bonus money per currency. Anyone may add to it.
    mapping(bytes32 => uint256) public bonusPool;
    /// @notice Per person: USDC delivered here and not yet staked. It can only
    ///         leave as that person's stake on the Diamond.
    mapping(address => uint256) public pendingStake;

    /// @notice A person's live opening: the order that reserved the bonus, the
    ///         amount taken from the pool, and the currency the account opens
    ///         in. orderId 0 = none.
    struct Opening {
        uint256 orderId;
        uint256 bonus;
        bytes32 currency;
    }
    mapping(address => Opening) public openings;

    /// @notice Deliveries already added to pendingStake, so none counts twice
    ///         (the hook and reconcileDelivery can both see the same order).
    mapping(uint256 => bool) public credited;

    modifier onlyDiamond() {
        if (msg.sender != address(diamond)) revert OnlyDiamond();
        _;
    }

    /// @param _diamond           the p2p.me Diamond
    /// @param _usdc              the Diamond's USDC
    /// @param _owner             sets circles and bonuses, withdraws unreserved pool (a Safe on
    ///                           mainnet). It can never touch pendingStake,
    ///                           a reservation or any order.
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

    /// @notice Set the bonus an account opening in `currency` receives. Applies
    ///         to deposits placed from now on; existing reservations keep the
    ///         amount they reserved. 0 turns the bonus off and lets opening
    ///         deposits through even with an empty pool.
    function setBonus(bytes32 currency, uint256 amount) external onlyOwner {
        bonus[currency] = amount;
        emit BonusSet(currency, amount);
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

    /// @notice Take unreserved pool money back, to the owner. It can never reach
    ///         pendingStake or a reservation: only bonusPool is debited.
    function withdrawBonus(bytes32 currency, uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (amount > bonusPool[currency]) revert BonusPoolShort();
        bonusPool[currency] -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit BonusWithdrawn(currency, msg.sender, amount);
    }

    // ─── Bonus pool ───────────────────────────────────────────────────

    /// @notice Add USDC to a currency's bonus pool. Anyone may call (approve first).
    function fundBonus(bytes32 currency, uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        bonusPool[currency] += amount;
        emit BonusFunded(msg.sender, currency, amount);
    }

    /// @notice Return a cancelled opening's bonus to its pool. Anyone may call,
    ///         so an abandoned reservation never locks pool money. An expired
    ///         order reads CANCELLED once the Diamond's permissionless
    ///         autoCancelExpiredOrders has run on it.
    function releaseBonus(address user) external nonReentrant {
        Opening memory op = openings[user];
        if (op.orderId == 0) revert NotCancelled();
        IOrderFlow.OrderView memory o = diamond.getOrdersById(op.orderId);
        if (o.status != uint8(IP2PDiamond.OrderStatus.CANCELLED)) revert NotCancelled();
        _release(user, op, op.currency);
    }

    // ─── Views ────────────────────────────────────────────────────────

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

    /// @notice Pay fiat in to open, finish or top up your merchant account.
    ///         One call for all three; the contract works out which it is.
    /// @dev    Refused up front, before any money moves: a blacklisted caller,
    ///         an amount over the max buy, and (for an existing account) a
    ///         different currency or a pending unstake — the cases stakeFor would
    ///         refuse after delivery, stranding the USDC here; and an opening
    ///         deposit in a currency with no circleOf. The minimum stake,
    ///         circle state and capacity are checked by the Diamond when it stakes.
    /// @param amount   USDC to buy (6 decimals)
    /// @param currency the on-chain currency code (e.g. "INR", "MEX" — not ISO "MXN")
    /// @param circleId the circle the order is matched in (any; the account
    ///                 opens in circleOf[currency])
    /// @param pubKey   the person's relay key; the merchant encrypts where to pay to it
    /// @param preferredPaymentChannelConfigId 0 for any payment channel
    /// @param fiatAmountLimit 0 for no limit on the fiat side
    /// @param ref      the app's own reference, echoed in DepositPlaced
    function depositFiat(
        uint256 amount,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit,
        bytes32 ref
    ) external nonReentrant returns (uint256 orderId) {
        if (amount == 0) revert InvalidAmount();
        if (diamond.isBlacklisted(msg.sender)) revert MerchantBlacklisted();
        if (_userBlacklisted(msg.sender)) revert UserBlacklisted();
        IP2PDiamond.MerchantDetails memory m = diamond.getMerchantDetails(msg.sender);
        if (m.isRegistered) {
            if (m.currency != currency) revert SeatCurrencyMismatch();
            if (diamond.getUnstakeRequested(msg.sender)) revert UnstakePending();
        } else if (circleOf[currency] == 0) {
            revert CircleNotSet();
        }
        if (amount > diamond.getMaxBuyTxLimit(currency)) revert AmountExceedsCap();

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
        // No account yet: an opening deposit. Reserve the bonus, then require
        // it to open the account on its own (with what is already pending).
        if (!m.isRegistered) {
            uint256 b = _reserve(msg.sender, orderId, currency);
            if (
                pendingStake[msg.sender] + amount + b <
                diamond.getStakeConfig(currency).minMerchantUSDCStake
            ) {
                revert BelowStakeFloor();
            }
        }
        emit DepositPlaced(orderId, msg.sender, amount, currency, ref);
    }

    /// @dev Reserve `currency`'s bonus for `user`'s opening deposit, or revert
    ///      NoBonus; returns the opening's bonus. One reservation per person: a
    ///      later deposit while the opening is still live adds money, not a
    ///      second bonus, and must be in the opening's currency. If the earlier
    ///      opening was cancelled, its bonus is released first and reserved
    ///      afresh for this order (at today's bonus amount, in its currency).
    function _reserve(
        address user,
        uint256 orderId,
        bytes32 currency
    ) internal returns (uint256 b) {
        Opening memory op = openings[user];
        if (op.orderId != 0) {
            IOrderFlow.OrderView memory o = diamond.getOrdersById(op.orderId);
            if (o.status != uint8(IP2PDiamond.OrderStatus.CANCELLED)) {
                if (op.currency != currency) revert SeatCurrencyMismatch();
                return op.bonus;
            }
            _release(user, op, op.currency);
        }
        b = bonus[currency];
        if (bonusPool[currency] < b) revert NoBonus();
        bonusPool[currency] -= b;
        openings[user] = Opening(orderId, b, currency);
        emit BonusReserved(orderId, user, b);
    }

    /// @dev Put `user`'s reserved bonus back into `currency`'s pool.
    function _release(address user, Opening memory op, bytes32 currency) internal {
        delete openings[user];
        bonusPool[currency] += op.bonus;
        emit BonusReleased(op.orderId, user, op.bonus);
    }

    // ─── Withdraw ─────────────────────────────────────────────────────

    /// @notice Cash out: place a SELL of your own USDC to your bank. The Diamond
    ///         pulls the USDC from your account at setSellOrderUpi, and a refund
    ///         goes back to you. No limits here, by decision, and no blacklist
    ///         check: the Diamond itself lets a blacklisted wallet sell.
    /// @dev    Only for someone with a merchant account on the Diamond (opened
    ///         here or anywhere else): this is a way out for merchant money, not
    ///         a general USDC exit.
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
        // An account on the Diamond, opened here or anywhere else.
        if (!diamond.getMerchantDetails(msg.sender).isRegistered) revert NoSeat();
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

    /// @notice A cancelled order needs nothing undone here; a reserved bonus is
    ///         returned by releaseBonus. Never reverts, as the gateway requires
    ///         before cancel callbacks can be switched on.
    function onOrderCancel(uint256) external view onlyDiamond {}

    /// @dev Mark `orderId` delivered and add its USDC to `user`'s pending money.
    function _credit(uint256 orderId, address user, uint256 amount) internal {
        credited[orderId] = true;
        pendingStake[user] += amount;
        emit DepositDelivered(orderId, user, amount);
    }

    // ─── Stake ────────────────────────────────────────────────────────

    /// @notice Stake everything `orderId`'s person has pending into their own
    ///         merchant account. No account yet: registerFor with their pending
    ///         money plus their reserved bonus (whichever deposit's stake opens
    ///         the account takes it, once), in the opening's currency and
    ///         circleOf[it], never the named order's currency or circle. Account exists: stakeFor, and a
    ///         leftover reservation goes back to the pool.
    /// @dev    Callable by anyone, so the person never depends on our keeper
    ///         being up. Every argument comes from the Diamond's order and this
    ///         contract's state, so a caller can trigger it but never steer it.
    function stakeDeposit(uint256 orderId) external nonReentrant {
        if (!credited[orderId]) revert DepositNotDelivered();
        IOrderFlow.OrderView memory o = diamond.getOrdersById(orderId);
        address user = o.user;
        uint256 paid = pendingStake[user];
        if (paid == 0) revert DepositAlreadyStaked();
        pendingStake[user] = 0;

        IP2PDiamond.MerchantDetails memory seat = diamond.getMerchantDetails(user);
        Opening memory op = openings[user];
        // The account's currency is the opening's, never the named order's:
        // a caller cannot choose it. No opening (released, then a cancelled
        // order completed later): the order's own currency.
        bytes32 cur = op.orderId != 0 ? op.currency : o.currency;
        uint256 b;
        if (op.orderId != 0) {
            if (seat.isRegistered) {
                // opened elsewhere since: the bonus goes back to its pool
                _release(user, op, op.currency);
            } else {
                b = op.bonus;
                delete openings[user];
            }
        }

        // Exact allowance, reset after: this contract holds other people's money.
        usdc.forceApprove(address(diamond), paid + b);
        // A top-up stakes in the account's own currency.
        if (seat.isRegistered) diamond.stakeFor(user, paid, seat.currency);
        else {
            uint256 circle = circleOf[cur];
            if (circle == 0) revert CircleNotSet(); // unset since the deposit: set it, then retry
            diamond.registerFor(user, circle, paid + b, "", cur);
        }
        usdc.forceApprove(address(diamond), 0);

        emit DepositStaked(orderId, user, paid, b, !seat.isRegistered);
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

    /// @dev On ReputationManager's user blacklist. Checked for deposits only:
    ///      the Diamond itself lets a blacklisted wallet SELL (OrderFlowFacet.sol:260).
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
