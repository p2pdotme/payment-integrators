// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Minimal `decimals()` view. Not every ERC-20 implements it, so calls
///      are wrapped in try/catch at the call site.
interface IERC20Metadata {
    function decimals() external view returns (uint8);
}
import { ICashbackRegistry } from "../interfaces/ICashbackRegistry.sol";
import { IOrderFlow } from "../interfaces/IOrderFlow.sol";

/**
 * @title CashbackRegistry
 * @notice Multi-tenant, config-driven cashback for the P2P protocol.
 *
 *         Each integrator has a cashback OWNER. That owner alone creates,
 *         activates, pauses, retunes and ends campaigns for their integrator,
 *         funded from their own wallet. One owner may run many campaigns
 *         across many integrators; nobody can touch anyone else's.
 *
 *         A campaign is five fields — integrator, order type, currency,
 *         reward token, rate — plus the wallet that pays for it. Rewards are
 *         pushed straight to the user's wallet the moment an order is
 *         verified; there is no claim step and no `owed` ledger.
 *
 *         WHY THIS TOUCHES NO INTEGRATOR: the Diamond emits
 *         `B2BOrderPlaced(orderId, integrator, user, amount)` on every order
 *         for every integrator — integrators never emit it themselves. An
 *         off-chain watcher tails that event and reports completed orders
 *         here. Existing (immutable) integrators are therefore covered
 *         immediately, and future ones the day they are whitelisted, with
 *         zero cashback code inside any of them.
 *
 *         WHY REWARDS ARE PAID BESIDE THE PAYMENT, NOT INSIDE IT: integrators
 *         settle order USDC to four different destinations (a user proxy, the
 *         user's own EOA, the integrator itself, or time-locked merchant
 *         custody), and one of them pays a merchant rather than a buyer.
 *         There is no common injection point, and for the merchant-custody
 *         case crediting settlement would break that contract's solvency
 *         accounting. Paying from a separate funding wallet after settlement
 *         completes works uniformly and can never disturb a payment.
 *
 *         REWARD BASIS: `order.amount` on the Diamond is the USDC amount
 *         (6dp), not the local fiat figure. Percentage rewards are therefore
 *         always a share of USDC bought, never of rupees or reais paid.
 *
 *         TRUST MODEL: the watcher is NOT trusted. Every report is verified
 *         against the Diamond via `getOrdersById` — the order must exist, be
 *         COMPLETED, and match the reported user and amount. The reward
 *         recipient is taken from the Diamond's record, never from the
 *         report. Combined with the per-order replay guard, a compromised
 *         watcher cannot invent orders, inflate amounts, or misdirect funds;
 *         its only power is omission (delaying reports), and anyone may run a
 *         second watcher to backfill.
 *
 * @dev    Reward tokens never enter this contract. Each campaign pulls from
 *         its own `fundingWallet` via `transferFrom`, so revoking that
 *         wallet's approval is an immediate, contract-free kill switch that
 *         affects only that owner's campaigns.
 */
contract CashbackRegistry is ICashbackRegistry {
    // ─── Errors ───────────────────────────────────────────────────────

    error OnlyAdmin();
    error OnlyAccruer();
    error OnlyIntegratorOwner();
    error InvalidAddress();
    error InvalidRate();
    error InvalidStatus();
    error UnknownCampaign();
    error CampaignSlotTaken();
    error CampaignEnded();
    error IntegratorUnclaimed();
    error FundingWalletNotAuthorized();
    error CampaignRetired();
    error UnsupportedOrderType();
    error InvalidWindow();
    error LastAdmin();

    // ─── Constants ────────────────────────────────────────────────────

    /// @notice Wildcard for `orderType` / `currency`, letting one campaign
    ///         cover every order type or every currency for an integrator.
    bytes32 public constant ANY = bytes32(0);

    /// @notice Canonical order-type labels, derived from the Diamond's own
    ///         uint8 enum (0=BUY, 1=SELL, 2=PAY) rather than trusted from a
    ///         report. Campaigns are keyed on these.
    bytes32 public constant ORDER_TYPE_BUY = bytes32("BUY");
    bytes32 public constant ORDER_TYPE_SELL = bytes32("SELL");
    bytes32 public constant ORDER_TYPE_PAY = bytes32("PAY");

    /// @notice Hard ceiling on any campaign rate. AUDIT F6: lowered from 20%
    ///         to 5% — 20% is not a cashback rate, it is a drain budget, and
    ///         a ceiling only helps if it is programme-shaped.
    uint16 public constant MAX_BPS = 500;

    /// @notice Ceiling on a flat per-order reward, expressed in WHOLE reward
    ///         tokens rather than base units.
    ///
    ///         AUDIT M2. The previous ceiling was a fixed `1e21` base units,
    ///         and its own comment gave the game away: "1e15 USDC at 6dp and
    ///         1,000 tokens at 18dp". Only the second half is a bound. For
    ///         the 6-decimal token this actually ships with, 1e21 base units
    ///         is 10^15 USDC — a quadrillion dollars, i.e. no ceiling at all,
    ///         leaving the funding wallet's balance as the only real limit.
    ///         That matters because an authorised third-party funder (see
    ///         `authorizeCampaignFunder`) can set the rate: F4 scoped that
    ///         grant to one token, but nothing bounded the per-order draw
    ///         against it.
    ///
    ///         Denominating the cap in whole tokens makes it mean the same
    ///         thing at every decimal precision — 1,000 tokens per order,
    ///         which is what the old comment claimed it already did. The
    ///         effective base-unit cap is derived per campaign from the
    ///         token's own `decimals()`; see `_maxFlatAmount`.
    uint256 public constant MAX_FLAT_TOKENS = 1_000;

    // ─── Decline reasons (see ICashbackRegistry.PayDeclined) ──────────
    // AUDIT N1. The watcher must be able to tell a permanent decline from a
    // temporary one; without that it retires deferred orders and they are
    // never paid. Terminal: 1,2,3,4,6,7,9. Retryable: 5,8,10.
    uint8 private constant DECLINE_ALREADY_PAID = 1;
    uint8 private constant DECLINE_UNVERIFIED = 2;
    uint8 private constant DECLINE_ORDER_TYPE = 3;
    uint8 private constant DECLINE_NO_CAMPAIGN = 4;
    uint8 private constant DECLINE_CAMPAIGN_INACTIVE = 5;
    uint8 private constant DECLINE_CAMPAIGN_RETIRED = 6;
    uint8 private constant DECLINE_OUT_OF_WINDOW = 7;
    uint8 private constant DECLINE_FUNDER_UNAUTHORIZED = 8;
    uint8 private constant DECLINE_ZERO_REWARD = 9;
    uint8 private constant DECLINE_BUDGET_EXHAUSTED = 10;

    /// @notice Gas forwarded to a reward token's `transferFrom`. AUDIT F5:
    ///         without a cap, the 63/64 rule lets a token that burns all
    ///         forwarded gas take down the whole batch, so one tenant's
    ///         hostile token starves every honest row. Generous for any
    ///         reasonable ERC-20, fatal to a gas bomb.
    uint256 public constant TOKEN_CALL_GAS = 150_000;

    uint256 private constant BPS_DENOMINATOR = 10_000;

    /// @dev Diamond order status (OrderProcessorStorage.OrderStatus).
    uint8 private constant STATUS_COMPLETED = 3;

    /// @dev What `_verifyOrder` proved from the Diamond's own record. Every
    ///      field here is authoritative; nothing in it comes from the report.
    struct VerifiedOrder {
        address user;
        bytes32 orderType;
        bytes32 currency;
        uint256 placedAt;
    }

    // ─── Immutables ───────────────────────────────────────────────────

    /// @notice The P2P Diamond. Every reported order is verified against it.
    address public immutable diamond;

    // ─── Roles ────────────────────────────────────────────────────────

    /// @notice Registry admins. They assign integrator owners and manage
    ///         watchers. They deliberately CANNOT create campaigns, change a
    ///         rate, or redirect anyone's funds — see `emergencyStop` for the
    ///         one power they hold over a live campaign.
    mapping(address => bool) public admin;

    /// @notice How many admins exist. Guards against removing the last one.
    uint256 public adminCount;

    /// @notice Addresses permitted to report orders (the watcher service).
    mapping(address => bool) public accruer;

    /// @notice integrator => the address that runs cashback for it.
    ///         Assigned by a registry admin once, then that owner is
    ///         self-service. Zero means unclaimed: no campaigns possible.
    mapping(address => address) public integratorOwner;

    /// @notice integrator => how many times it has changed hands. A campaign
    ///         records the epoch it was created in; if the integrator is
    ///         later reassigned, every campaign from an earlier epoch is
    ///         dead. This is what stops an incoming owner inheriting control
    ///         of a campaign funded by the outgoing owner's wallet.
    mapping(address => uint256) public integratorEpoch;

    /// @notice fundingWallet => spender => token => may that spender attach
    ///         this wallet to a campaign paying THAT token. Only the wallet
    ///         itself can grant it, and it is re-checked on every payout.
    ///
    ///         AUDIT F4: this was previously an unscoped blanket grant, so a
    ///         treasury that authorised a partner for a points-token campaign
    ///         had also authorised them to create a USDC campaign funded by
    ///         the same wallet.
    mapping(address => mapping(address => mapping(address => bool))) public fundingAuthorized;

    /// @dev owner => integrator => already recorded in `_integratorsByOwner`.
    ///      Keeps that enumeration free of duplicates across handovers.
    mapping(address => mapping(address => bool)) private _ownsIntegrator;

    // ─── Campaigns ────────────────────────────────────────────────────

    mapping(bytes32 => Campaign) private _campaigns;

    /// @notice Running totals per campaign, for dashboards.
    mapping(bytes32 => Stats) public stats;

    /// @notice lookupKey => the ACTIVE campaign for it. At most one campaign
    ///         may be active per (integrator, orderType, currency) triple, so
    ///         resolution is never ambiguous.
    mapping(bytes32 => bytes32) public activeFor;

    /// @notice orderId => already paid. One reward per order, ever.
    mapping(uint256 => bool) public orderPaid;

    /// @notice campaign => UTC day => reward units spent that day.
    mapping(bytes32 => mapping(uint256 => uint256)) public campaignDaySpend;

    /// @notice campaign => recipient => UTC day => reward units they earned.
    ///         Bounds how much any single address can farm in a day.
    mapping(bytes32 => mapping(address => mapping(uint256 => uint256))) public userDaySpend;

    // ─── Enumeration (dashboards) ─────────────────────────────────────
    // Campaign ids are content-addressed, so without these a UI could only
    // reconstruct an owner's portfolio by replaying every historical event.
    // These make "show me everything I run" a single call.

    /// @notice Every campaign ever created, in creation order.
    bytes32[] private _allCampaigns;
    /// @notice owner => their campaigns, across every integrator they run.
    mapping(address => bytes32[]) private _campaignsByOwner;
    /// @notice integrator => its campaigns.
    mapping(address => bytes32[]) private _campaignsByIntegrator;
    /// @notice owner => integrators they have been assigned.
    mapping(address => address[]) private _integratorsByOwner;

    /// @dev Monotonic counter keeping campaign ids unique when the same
    ///      triple is configured repeatedly over time.
    uint256 private _campaignNonce;

    // ─── Modifiers ────────────────────────────────────────────────────

    modifier onlyAdmin() {
        if (!admin[msg.sender]) revert OnlyAdmin();
        _;
    }

    /// @dev `payBatch` dispatches each row through `this.pay` so every row
    ///      gets its own revert boundary. That self-call arrives with
    ///      `msg.sender == address(this)`, authorised here rather than in the
    ///      `accruer` mapping so it can never be revoked by accident — and,
    ///      being an internal dispatch only, it grants no outside caller any
    ///      additional power.
    modifier onlyAccruer() {
        if (!accruer[msg.sender] && msg.sender != address(this)) revert OnlyAccruer();
        _;
    }

    /// @dev Gate on the CAMPAIGN's integrator owner. Note this reads the
    ///      current owner, not the one recorded at creation: if an
    ///      integrator changes hands, control of its campaigns follows.
    modifier onlyCampaignOwner(bytes32 campaignId) {
        Campaign storage c = _campaigns[campaignId];
        if (c.integrator == address(0)) revert UnknownCampaign();
        if (msg.sender != integratorOwner[c.integrator]) revert OnlyIntegratorOwner();
        // A campaign from a previous ownership epoch is dead: not even the
        // current owner may operate it, because its funding wallet belongs
        // to whoever held the integrator before.
        if (c.epoch != integratorEpoch[c.integrator]) revert CampaignRetired();
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────

    constructor(address _diamond) {
        if (_diamond == address(0)) revert InvalidAddress();
        diamond = _diamond;
        admin[msg.sender] = true;
        adminCount = 1;
        emit AdminSet(msg.sender, true);
    }

    // ─── Registry admin ───────────────────────────────────────────────

    function setAdmin(address who, bool allowed) external onlyAdmin {
        if (who == address(0)) revert InvalidAddress();
        if (admin[who] == allowed) return;

        // AUDIT F11: never let the registry reach zero admins. Campaigns
        // would keep paying with nobody able to rotate the accruer or
        // emergency-stop anything again.
        if (!allowed) {
            if (adminCount == 1) revert LastAdmin();
            unchecked {
                --adminCount;
            }
        } else {
            unchecked {
                ++adminCount;
            }
        }
        admin[who] = allowed;
        emit AdminSet(who, allowed);
    }

    function setAccruer(address who, bool allowed) external onlyAdmin {
        if (who == address(0)) revert InvalidAddress();
        accruer[who] = allowed;
        emit AccruerSet(who, allowed);
    }

    /**
     * @notice Assign (or transfer) the cashback owner of an integrator. This
     *         is the ONE setup step a registry admin performs per integrator;
     *         afterwards that owner is fully self-service.
     *
     * @dev    Ownership is registered rather than read from the integrator
     *         because integrators do not share an ownership interface — some
     *         expose `owner()`, others are multi-owner with `isOwner()` and a
     *         super-admin. A registered mapping works uniformly and cannot be
     *         spoofed by a look-alike contract.
     *
     *         Transferring ownership hands over existing campaigns too: the
     *         owner check reads this mapping live.
     */
    function setIntegratorOwner(address integrator, address owner) external onlyAdmin {
        if (integrator == address(0) || owner == address(0)) revert InvalidAddress();
        address previous = integratorOwner[integrator];
        if (previous == owner) return;

        integratorOwner[integrator] = owner;
        // Guard against duplicate entries when an integrator is handed back
        // and forth; the early-return above only catches immediate no-ops.
        if (!_ownsIntegrator[owner][integrator]) {
            _ownsIntegrator[owner][integrator] = true;
            _integratorsByOwner[owner].push(integrator);
        }

        // AUDIT FIX (critical): a handover must not leave the incoming owner
        // in control of campaigns still funded by the OUTGOING owner's
        // wallet. `onlyCampaignOwner` reads the live owner mapping, so
        // without this the new owner could retune the rate and drain a
        // wallet they never controlled — and an admin could grant themselves
        // that power, contradicting the rule that admins cannot spend
        // anyone's funds.
        //
        // Bumping the epoch invalidates every campaign created under the
        // previous owner: they read as ENDED and stop paying. This is O(1),
        // so a handover can never run out of gas over a large portfolio.
        // The new owner re-creates whatever they want under their own wallet.
        if (previous != address(0)) {
            unchecked {
                ++integratorEpoch[integrator];
            }
            emit IntegratorEpochBumped(integrator, integratorEpoch[integrator]);
        }

        emit IntegratorOwnerSet(integrator, previous, owner);
    }

    /**
     * @notice Emergency brake. A registry admin may PAUSE or END any
     *         campaign — nothing more.
     *
     *         Deliberately narrow: an admin can stop a campaign that is being
     *         abused, but cannot change its rate, redirect its funding
     *         wallet, or spend an owner's tokens differently. Stopping is a
     *         safety power; spending is not.
     */
    /// @notice Un-assign an integrator, retiring its campaigns.
    ///
    ///         AUDIT F11: `setIntegratorOwner` rejects address(0), so without
    ///         this an integrator could only ever be handed on, never
    ///         withdrawn. Bumps the epoch so the outgoing owner's campaigns
    ///         stop paying immediately and their funding wallet is safe.
    function unassignIntegrator(address integrator) external onlyAdmin {
        address previous = integratorOwner[integrator];
        if (previous == address(0)) revert IntegratorUnclaimed();

        delete integratorOwner[integrator];
        unchecked {
            ++integratorEpoch[integrator];
        }
        emit IntegratorEpochBumped(integrator, integratorEpoch[integrator]);
        emit IntegratorOwnerSet(integrator, previous, address(0));
    }

    function emergencyStop(bytes32 campaignId, bool permanent) external onlyAdmin {
        Campaign storage c = _campaigns[campaignId];
        if (c.integrator == address(0)) revert UnknownCampaign();
        if (c.status == Status.ENDED) revert InvalidStatus();

        Status previous = c.status;
        // AUDIT N1, as in `pause`. A non-permanent stop is recoverable, so
        // the slot is kept and the decline reads as retryable; only ENDED,
        // which is terminal, gives the triple up.
        if (permanent) _releaseSlot(campaignId, c);
        c.status = permanent ? Status.ENDED : Status.PAUSED;
        emit CampaignStatusChanged(campaignId, previous, c.status);
    }

    // ─── Funding-wallet authorisation (anyone, for their own wallet) ──

    /**
     * @notice Authorise (or revoke) `spender` to attach the CALLER's wallet
     *         as a campaign funding wallet. Only the wallet itself can grant
     *         this, which is what makes it real proof of control.
     *
     *         Revoking takes effect immediately: `pay` re-checks this on
     *         every payout, so a revoked spender's campaigns stop paying
     *         from this wallet at once — without touching the ERC-20
     *         allowance, and without affecting any other campaign that
     *         happens to share the same token approval.
     */
    function authorizeCampaignFunder(address spender, address token, bool allowed) external {
        if (spender == address(0) || token == address(0)) revert InvalidAddress();
        fundingAuthorized[msg.sender][spender][token] = allowed;
        emit FundingAuthorizationSet(msg.sender, spender, token, allowed);
    }

    // ─── Campaign management (integrator owners) ──────────────────────

    /**
     * @notice Create a campaign for an integrator you own. This is the form.
     *         Starts INACTIVE — `activate` is a deliberate second step so a
     *         half-configured campaign can never pay out.
     *
     * @param integrator    Integrator the campaign applies to. You must be
     *                      its registered owner.
     * @param orderType     BUY, or ANY for every type. SELL and PAY are
     *                      rejected — see the AUDIT F8 note in the body, and
     *                      note that a wildcard campaign will not pay them
     *                      either (enforced in `pay` on the verified record).
     * @param currency      e.g. bytes32("INR"), or ANY for every currency.
     * @param rewardToken   ERC-20 paid out as cashback.
     * @param bps           Rate in basis points (100 = 1%). Zero if flat.
     * @param flatAmount    Fixed reward per order. Zero if using bps.
     * @param fundingWallet Wallet that pays for THIS campaign. Must be the
     *                      caller, or a wallet that has approved the caller
     *                      as a spender of `rewardToken` (proving control).
     */
    function createCampaign(
        address integrator,
        bytes32 orderType,
        bytes32 currency,
        address rewardToken,
        uint16 bps,
        uint256 flatAmount,
        address fundingWallet,
        Budget calldata budget
    ) external returns (bytes32 campaignId) {
        address owner = integratorOwner[integrator];
        if (owner == address(0)) revert IntegratorUnclaimed();
        if (msg.sender != owner) revert OnlyIntegratorOwner();
        if (rewardToken == address(0) || fundingWallet == address(0)) revert InvalidAddress();
        // THIRD-PASS AUDIT. An explicit code check, not an incidental one.
        // Empty returndata counts as success (the SafeERC20 rule, needed for
        // USDT-style tokens), and a low-level call to a CODELESS address also
        // returns success with empty returndata — so without this a campaign
        // pointed at an EOA would mark orders paid and emit `Paid` while no
        // tokens moved. It happened to be unreachable because `_decimalScale`
        // does a `try ... returns` whose extcodesize check reverts outside
        // the catchable region, but relying on that is relying on a compiler
        // detail, not on an invariant.
        if (rewardToken.code.length == 0) revert InvalidAddress();
        // AUDIT M2. Decimals are needed to bound `flatAmount`, so read them
        // before validating the rate rather than after.
        (uint256 scaleNum, uint256 scaleDen) = _decimalScale(rewardToken);
        _validateRate(bps, flatAmount, scaleNum, scaleDen);
        _requireFundingControl(fundingWallet, rewardToken);

        // AUDIT F8. On SELL/offramp flows `order.user` is a UserProxy, not a
        // person: for some integrators the seller's own proxy (where a USDC
        // reward is permanently trapped by UserProxy's sweep block), for
        // others the integrator's shared system proxy (where every seller's
        // reward piles up unattributable). Until there is a delivery story,
        // SELL and PAY are not payable.
        //
        // RE-AUDIT (F8, half-fixed). Rejecting the KEY here only stopped a
        // campaign explicitly keyed to SELL. It did nothing about the
        // (ANY, ANY) wildcard row — which is precisely the configuration a
        // tenant reaches for once this revert tells them they cannot key one
        // to SELL. A SELL order resolves tier 1 and 2 to nothing, falls
        // through to the wildcard, and pays the proxy. The guard has to sit
        // on the VERIFIED order type at payout time to mean anything; this
        // check is kept as the early, legible failure for the operator.
        if (orderType == ORDER_TYPE_SELL || orderType == ORDER_TYPE_PAY) {
            revert UnsupportedOrderType();
        }

        // AUDIT N4 (was the same bug the second pass fixed one function down
        // in `setBudget`, left in place here). The end was validated against
        // the RAW `budget.startTime`, but the start that actually gets stored
        // is floored at `block.timestamp` below. So `startTime: 0` with any
        // small `endTime` passed the check — 1000 > 0 — and then stored a
        // start of "now", producing an inside-out window: a campaign that
        // reads ACTIVE, can never pay a single order, and occupies its
        // lookup slot until somebody notices and ends it.
        //
        // Floor first, validate against the floored value, store that.
        uint64 effectiveStart = budget.startTime > uint64(block.timestamp)
            ? budget.startTime
            : uint64(block.timestamp);
        if (budget.endTime != 0 && budget.endTime <= effectiveStart) revert InvalidWindow();

        campaignId = keccak256(
            abi.encode(integrator, orderType, currency, rewardToken, _campaignNonce++)
        );

        _campaigns[campaignId] = Campaign({
            epoch: integratorEpoch[integrator],
            integrator: integrator,
            orderType: orderType,
            currency: currency,
            rewardToken: rewardToken,
            bps: bps,
            flatAmount: flatAmount,
            fundingWallet: fundingWallet,
            scaleNum: scaleNum,
            scaleDen: scaleDen,
            maxRewardPerOrder: budget.maxRewardPerOrder,
            dailyBudget: budget.dailyBudget,
            totalBudget: budget.totalBudget,
            dailyPerUser: budget.dailyPerUser,
            // RE-AUDIT (high). The start is FLOORED at now, not merely
            // defaulted. Defaulting only when the caller passed 0 left the
            // whole point of F7 bypassable by passing `startTime: 1`: the
            // owner could stand up a campaign today and immediately harvest
            // the integrator's entire order history. A campaign may be
            // scheduled to start later, never earlier.
            startTime: effectiveStart,
            endTime: budget.endTime,
            status: Status.INACTIVE,
            owner: owner
        });

        _allCampaigns.push(campaignId);
        _campaignsByOwner[owner].push(campaignId);
        _campaignsByIntegrator[integrator].push(campaignId);

        emit CampaignCreated(
            campaignId,
            integrator,
            owner,
            rewardToken,
            orderType,
            currency,
            bps,
            flatAmount,
            fundingWallet
        );
    }

    /// @notice Retune a campaign's budget dials or validity window.
    ///         Cannot resurrect an ended campaign or widen it backwards past
    ///         its original start.
    ///
    /// @dev    This REPLACES all four budget dials — it does not patch
    ///         individual ones. Passing 0 for a dial means "no cap on this
    ///         dial", so read the current budget and restate what you want to
    ///         keep. `startTime` is the one exception, where 0 means "leave
    ///         unchanged"; `endTime` cannot be cleared at all once set
    ///         (AUDIT M1). The emitted event carries every resulting value.
    function setBudget(
        bytes32 campaignId,
        Budget calldata budget
    ) external onlyCampaignOwner(campaignId) {
        Campaign storage c = _campaigns[campaignId];
        if (c.status == Status.ENDED) revert CampaignEnded();
        // The start may move forward but never backward — otherwise a
        // campaign could be widened to swallow history it was never
        // eligible for, which is the F7 hole by another route.
        if (budget.startTime != 0 && budget.startTime < c.startTime) revert InvalidWindow();

        // RE-AUDIT (medium). Validate the end against the EFFECTIVE start.
        // Comparing against `budget.startTime` meant that passing 0 (the
        // "leave the start unchanged" sentinel) compared against 0, so any
        // positive endTime passed — including one below the real start,
        // which leaves the campaign permanently unpayable with no error.
        uint64 effectiveStart = budget.startTime != 0 ? budget.startTime : c.startTime;
        if (budget.endTime != 0 && budget.endTime <= effectiveStart) revert InvalidWindow();

        // AUDIT M1. `endTime` had no "leave unchanged" sentinel while
        // `startTime` immediately below it did — two adjacent fields, two
        // different conventions. An operator bumping `dailyBudget` from a
        // freshly-built struct and not restating `endTime` therefore did not
        // merely lose a cap: they silently converted a time-boxed campaign
        // into a perpetual one, with no event field to notice it by.
        //
        // A bounded programme must not become unbounded by omission. Closing
        // the window is what `end()` is for, so removing an existing end date
        // through this path is refused outright.
        if (c.endTime != 0 && budget.endTime == 0) revert InvalidWindow();

        c.maxRewardPerOrder = budget.maxRewardPerOrder;
        c.dailyBudget = budget.dailyBudget;
        c.totalBudget = budget.totalBudget;
        c.dailyPerUser = budget.dailyPerUser;
        if (budget.startTime != 0) c.startTime = budget.startTime;
        c.endTime = budget.endTime;

        // AUDIT F6/M1. Emit the complete resulting budget, not just the id:
        // this call REPLACES all four dials, so an indexer that saw only the
        // campaign id could not tell which caps a partial update dropped.
        emit CampaignBudgetChanged(
            campaignId,
            c.maxRewardPerOrder,
            c.dailyBudget,
            c.totalBudget,
            c.dailyPerUser,
            c.startTime,
            c.endTime
        );
    }

    /// @notice Start (or resume) a campaign, claiming the lookup slot for its
    ///         (integrator, orderType, currency) triple.
    function activate(bytes32 campaignId) external onlyCampaignOwner(campaignId) {
        Campaign storage c = _campaigns[campaignId];
        if (c.status == Status.ENDED) revert CampaignEnded();
        if (c.status == Status.ACTIVE) revert InvalidStatus();

        bytes32 key = _key(c.integrator, c.orderType, c.currency);
        bytes32 holder = activeFor[key];
        // A retired holder (from a previous ownership epoch) is not a live
        // occupant — it can no longer pay, so it must not block the new
        // owner from standing up a replacement. Without this, a handover
        // would permanently brick every slot the previous owner had taken.
        if (holder != bytes32(0) && holder != campaignId && _payable(holder, c.integrator))
            revert CampaignSlotTaken();

        activeFor[key] = campaignId;
        Status previous = c.status;
        c.status = Status.ACTIVE;
        emit CampaignStatusChanged(campaignId, previous, Status.ACTIVE);
    }

    /// @notice Stop accruals without closing the campaign. A replacement
    ///         campaign can still take the triple: `activate` only refuses a
    ///         slot whose holder is still payable, and a paused one is not.
    ///
    /// @dev    AUDIT N1. This used to clear the slot outright. That erased
    ///         the only on-chain trace that a campaign existed for the
    ///         triple, so an order arriving mid-pause was indistinguishable
    ///         from one for an integrator that runs no cashback at all —
    ///         and the watcher, told "no campaign", retired it. Resuming
    ///         then paid nothing, because the order was already gone.
    ///
    ///         Keeping the slot costs nothing now that resolution falls
    ///         through unpayable tiers (`_payableAt`): a paused holder no
    ///         longer shadows a broader campaign, and `_declineReason` can
    ///         see it and report the decline as recoverable.
    function pause(bytes32 campaignId) external onlyCampaignOwner(campaignId) {
        Campaign storage c = _campaigns[campaignId];
        if (c.status != Status.ACTIVE) revert InvalidStatus();
        c.status = Status.PAUSED;
        emit CampaignStatusChanged(campaignId, Status.ACTIVE, Status.PAUSED);
    }

    /// @notice Close a campaign permanently. Terminal.
    ///
    ///         AUDIT F10: a RETIRED campaign (one whose integrator changed
    ///         hands) is deliberately excluded from `onlyCampaignOwner`, so
    ///         it used to be closeable by nobody — it sat reading ACTIVE
    ///         forever while its owner's stale token approval lingered. The
    ///         address recorded as its creator can always close it, which
    ///         is exactly who needs to know to revoke that approval.
    function end(bytes32 campaignId) external {
        Campaign storage c = _campaigns[campaignId];
        if (c.integrator == address(0)) revert UnknownCampaign();

        bool isCurrentOwner = msg.sender == integratorOwner[c.integrator] &&
            c.epoch == integratorEpoch[c.integrator];
        bool isRecordedOwner = msg.sender == c.owner;
        if (!isCurrentOwner && !isRecordedOwner) revert OnlyIntegratorOwner();

        if (c.status == Status.ENDED) revert InvalidStatus();
        Status previous = c.status;
        _releaseSlot(campaignId, c);
        c.status = Status.ENDED;
        emit CampaignStatusChanged(campaignId, previous, Status.ENDED);
    }

    /// @notice Retune the rate mid-flight — the core experiment knob.
    ///         Applies to subsequent orders only.
    function setRate(
        bytes32 campaignId,
        uint16 bps,
        uint256 flatAmount
    ) external onlyCampaignOwner(campaignId) {
        Campaign storage c = _campaigns[campaignId];
        if (c.status == Status.ENDED) revert CampaignEnded();
        // AUDIT M2. `setRate` can retune a flat reward mid-flight, so it
        // needs the same decimal-aware ceiling `createCampaign` applies —
        // otherwise the cap is only enforced on the way in.
        _validateRate(bps, flatAmount, c.scaleNum, c.scaleDen);
        c.bps = bps;
        c.flatAmount = flatAmount;
        emit CampaignRateChanged(campaignId, bps, flatAmount);
    }

    /// @notice Repoint a campaign's funding wallet (e.g. EOA -> multisig).
    ///         The new wallet must be the caller or have approved them.
    function setCampaignFundingWallet(
        bytes32 campaignId,
        address fundingWallet
    ) external onlyCampaignOwner(campaignId) {
        if (fundingWallet == address(0)) revert InvalidAddress();
        Campaign storage c = _campaigns[campaignId];
        if (c.status == Status.ENDED) revert CampaignEnded();
        _requireFundingControl(fundingWallet, c.rewardToken);

        address previous = c.fundingWallet;
        c.fundingWallet = fundingWallet;
        emit CampaignFundingWalletChanged(campaignId, previous, fundingWallet);
    }

    // ─── Payout ───────────────────────────────────────────────────────

    /**
     * @notice Report a completed order and pay its reward immediately.
     *         Callable only by an allowlisted watcher.
     *
     *         Returns 0 rather than reverting whenever the order does not
     *         qualify — unknown, unverified, no active campaign, or a
     *         zero-value reward. Reverting would let one bad row in a batch
     *         block every other payout, and a failure inside cashback must
     *         never surface as anything the protocol has to handle.
     *
     * @return reward Amount actually transferred (0 if nothing was paid).
     */
    function pay(
        uint256 orderId,
        address integrator,
        address user,
        uint256 orderAmount
    ) public onlyAccruer returns (uint256 reward) {
        // AUDIT N1. Every `return 0` below now says why, so the watcher can
        // distinguish "this will never pay" from "not yet". Retiring the two
        // alike is how a budget-throttled order became an order that is
        // silently never paid.
        if (orderPaid[orderId]) {
            emit PayDeclined(orderId, DECLINE_ALREADY_PAID);
            return 0;
        }

        // TRUST BOUNDARY. Everything used below comes from the Diamond's own
        // record: the recipient, the order type, the currency, and the
        // placement time. The report only says WHICH order to look at.
        (bool ok, VerifiedOrder memory v) = _verifyOrder(orderId, integrator, user, orderAmount);
        if (!ok) {
            emit PayDeclined(orderId, DECLINE_UNVERIFIED);
            return 0;
        }

        // AUDIT F8 (the half that was missing). `createCampaign` refuses a
        // campaign KEYED to SELL/PAY, but that guard never reached the
        // (ANY, ANY) wildcard row — the very row a tenant creates instead
        // once the keyed one is refused. A SELL order misses tiers 1 and 2,
        // falls through to the wildcard, and pushes the reward to a
        // UserProxy: trapped by the sweep block on a seller's own proxy, or
        // pooled unattributably on an integrator's shared system proxy.
        //
        // Enforcing on the VERIFIED order type — the Diamond's record, not
        // the campaign key — is the only placement that covers every
        // resolution path. Terminal: the order type will never change.
        if (v.orderType == ORDER_TYPE_SELL || v.orderType == ORDER_TYPE_PAY) {
            emit PayDeclined(orderId, DECLINE_ORDER_TYPE);
            return 0;
        }

        // AUDIT N3. Resolve against the order's OWN placement time, so a
        // campaign that was not yet live (or had already closed) when this
        // order was placed cannot occupy the tier and shadow the broader
        // campaign underneath it.
        bytes32 campaignId = _resolve(integrator, v.orderType, v.currency, v.placedAt);
        if (campaignId == bytes32(0)) {
            // Say WHY nothing resolved. `_resolve` folds several distinct
            // situations into one empty result, and they are not alike to a
            // watcher: "this integrator runs no cashback" is terminal, while
            // "the campaign is paused" is a thing an operator fixes in a
            // minute. Reporting the union as terminal would drop orders that
            // a resumed campaign would have paid — the same silent
            // non-payment this round is about, one level down.
            emit PayDeclined(
                orderId,
                _declineReason(integrator, v.orderType, v.currency, v.placedAt)
            );
            return 0;
        }

        Campaign storage c = _campaigns[campaignId];
        if (c.status != Status.ACTIVE) {
            // Retryable: a paused campaign may resume.
            emit PayDeclined(orderId, DECLINE_CAMPAIGN_INACTIVE);
            return 0;
        }

        // A campaign created before the integrator changed hands is retired:
        // its funding wallet belongs to the previous owner.
        if (c.epoch != integratorEpoch[c.integrator]) {
            emit PayDeclined(orderId, DECLINE_CAMPAIGN_RETIRED);
            return 0;
        }

        // AUDIT F7. Only orders placed inside the campaign's own window are
        // eligible, so activating a campaign cannot retroactively pay months
        // of history and `setRate` cannot re-price orders already placed.
        //
        // `_payableAt` already enforced this during resolution; kept here as
        // a local invariant so the F7 guarantee stays legible at the payout
        // site and survives any future change to how campaigns are selected.
        if (v.placedAt < c.startTime || (c.endTime != 0 && v.placedAt > c.endTime)) {
            emit PayDeclined(orderId, DECLINE_OUT_OF_WINDOW);
            return 0;
        }

        // Funding authorisation is LIVE, not a one-time assertion, and is
        // scoped to this campaign's reward token (AUDIT F4).
        address funder = c.fundingWallet;
        if (funder != c.owner && !fundingAuthorized[funder][c.owner][c.rewardToken]) {
            // Retryable: the wallet may re-authorise.
            emit PayDeclined(orderId, DECLINE_FUNDER_UNAUTHORIZED);
            return 0;
        }

        // Reward and budget clamps go through the same helpers `quote` uses,
        // so the preview and the payout can never disagree.
        reward = _grossReward(c, orderAmount);
        if (reward == 0) {
            emit PayDeclined(orderId, DECLINE_ZERO_REWARD);
            return 0;
        }

        Stats storage st = stats[campaignId];
        // AUDIT N6. All-or-nothing against the budgets: see `_applyBudgets`.
        reward = _applyBudgets(campaignId, c, reward, v.user);
        if (reward == 0) {
            // Retryable: daily caps reset, and a lifetime cap may be raised.
            emit PayDeclined(orderId, DECLINE_BUDGET_EXHAUSTED);
            return 0;
        }

        uint256 today = block.timestamp / 1 days;

        // Mark before the transfer so a reentrant token cannot collect twice.
        // Rolled back below if the transfer fails, leaving it retryable.
        orderPaid[orderId] = true;

        // Snapshot for the delivered-amount measurement below, gas-capped
        // (see `_tryBalanceOf`). A token that cannot report a balance is
        // not one we can account for, so refuse rather than guess.
        (bool okBefore, uint256 balanceBefore) = _tryBalanceOf(c.rewardToken, v.user);
        if (!okBefore) {
            orderPaid[orderId] = false;
            emit PayFailed(campaignId, orderId, v.user, reward);
            return 0;
        }

        // AUDIT F5. Gas-capped so a hostile reward token cannot burn the
        // batch's remaining gas and starve every other row.
        (bool callOk, bytes memory ret) = c.rewardToken.call{ gas: TOKEN_CALL_GAS }(
            abi.encodeCall(IERC20.transferFrom, (funder, v.user, reward))
        );
        // Success is judged by the SafeERC20 rule, NOT by "did it return 32
        // bytes of true".
        //
        // RE-AUDIT (critical). This previously required `ret.length == 32`,
        // which made a USDT-style token — one that moves the tokens and
        // returns NOTHING — read as a failure. The rollback below then
        // cleared `orderPaid` and skipped the budget counters, while the
        // tokens had already left the funding wallet. A watcher retrying
        // the unpaid order drained the wallet one transfer at a time, with
        // every guard bypassed: no replay protection, no budget accounting.
        // It fired automatically in normal operation — no attacker needed.
        //
        // So: a call that reverted is a failure; a call that returned data
        // decoding to `false` is a failure; a call that returned NOTHING is
        // a success, because a non-compliant token that did not revert has
        // moved the tokens.
        bool transferred = callOk &&
            (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool))));
        if (!transferred) {
            orderPaid[orderId] = false;
            emit PayFailed(campaignId, orderId, v.user, reward);
            return 0;
        }

        // THIRD-PASS AUDIT. Account what was DELIVERED, not what was asked
        // for. With a fee-on-transfer or rebasing token the two differ, and
        // crediting the requested amount exhausted budgets at up to 2x the
        // tokens users actually received — a campaign stopping while its
        // wallet still held funds, and `dailyPerUser` locking someone out
        // early. Measuring the recipient's balance delta is the only figure
        // that is true for every token.
        // Saturating, not checked-subtraction. FOURTH-PASS AUDIT (high):
        // a rebasing token — or simply a hostile one — can leave the
        // recipient's balance LOWER than before, and `a - b` under ^0.8
        // then panics. Via payBatch that loses one row; called directly it
        // reverts outright and, because the revert unwinds `orderPaid`, the
        // row fails identically forever. Saturating to 0 routes it into the
        // graceful rollback below instead.
        (bool okAfter, uint256 balanceAfter) = _tryBalanceOf(c.rewardToken, v.user);
        uint256 delivered = (okAfter && balanceAfter > balanceBefore)
            ? balanceAfter - balanceBefore
            : 0;
        if (delivered == 0) {
            // Nothing arrived despite a "successful" call — a no-op token.
            // Roll back rather than burn this order's one payout slot
            // forever on a payment the user never received.
            orderPaid[orderId] = false;
            emit PayFailed(campaignId, orderId, v.user, reward);
            return 0;
        }
        if (delivered > reward) delivered = reward; // never credit more than intended

        st.totalPaid += delivered;
        st.orderCount += 1;
        campaignDaySpend[campaignId][today] += delivered;
        userDaySpend[campaignId][v.user][today] += delivered;

        emit Paid(campaignId, orderId, v.user, c.rewardToken, delivered);
        return delivered;
    }

    /**
     * @notice Batch form of `pay`, used by the watcher. Each row is isolated,
     *         so a single malformed or unqualifying report cannot revert the
     *         rest of the batch.
     */
    function payBatch(OrderReport[] calldata reports) external onlyAccruer {
        uint256 len = reports.length;
        for (uint256 i; i < len; ++i) {
            OrderReport calldata r = reports[i];
            // External self-call so each row gets its own revert boundary
            // (see the note on `onlyAccruer`).
            try this.pay(r.orderId, r.integrator, r.user, r.orderAmount) {
                // Outcome is emitted by pay() as Paid / PayFailed.
            } catch {
                // Row failed hard (unexpected); skip it and continue.
            }
        }
    }

    // ─── Views ────────────────────────────────────────────────────────

    function getCampaign(bytes32 campaignId) external view returns (Campaign memory) {
        return _campaigns[campaignId];
    }

    /// @notice Everything an owner runs, across every integrator. One call
    ///         backs the whole "my campaigns" dashboard.
    function campaignsOfOwner(address owner) external view returns (bytes32[] memory) {
        return _campaignsByOwner[owner];
    }

    function campaignsOfIntegrator(address integrator) external view returns (bytes32[] memory) {
        return _campaignsByIntegrator[integrator];
    }

    function integratorsOfOwner(address owner) external view returns (address[] memory) {
        return _integratorsByOwner[owner];
    }

    function campaignCount() external view returns (uint256) {
        return _allCampaigns.length;
    }

    /// @notice Paginated global listing, for an admin overview that must not
    ///         grow unbounded in a single call.
    function campaignsPaged(
        uint256 offset,
        uint256 limit
    ) external view returns (bytes32[] memory page) {
        uint256 total = _allCampaigns.length;
        if (offset >= total) return new bytes32[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        page = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = _allCampaigns[i];
        }
    }

    /**
     * @notice Everything a dashboard needs for one campaign in a single call:
     *         its config, its running totals, and — crucially — whether its
     *         funding wallet can still actually pay.
     *
     * @return campaign   The campaign record.
     * @return campaignStats Totals paid and orders rewarded.
     * @return spendable  min(wallet balance, allowance granted to this
     *                    registry). Zero means the next payout will fail even
     *                    though the campaign reads as ACTIVE — the single
     *                    most useful health signal in the UI.
     */
    function campaignView(
        bytes32 campaignId
    )
        external
        view
        returns (Campaign memory campaign, Stats memory campaignStats, uint256 spendable)
    {
        campaign = _campaigns[campaignId];
        campaignStats = stats[campaignId];
        if (campaign.rewardToken == address(0)) return (campaign, campaignStats, 0);

        // AUDIT M3. Was a second, uncapped copy of `_spendable`'s body.
        // Reuse the gas-capped helper so there is one implementation to
        // reason about and a hostile reward token cannot revert this view.
        spendable = _spendable(_campaigns[campaignId]);
    }

    /// @notice Resolve the campaign that would apply to an order, and what it
    ///         would pay. Read-only preview for dashboards and the watcher.
    function quote(
        address integrator,
        bytes32 orderType,
        bytes32 currency,
        uint256 orderAmount
    ) external view returns (bytes32 campaignId, uint256 reward) {
        // AUDIT N5. Resolve at `block.timestamp`: a quote is a preview for an
        // order placed NOW, so a campaign that has not started (or has
        // already closed) must neither be quoted nor shadow the live campaign
        // beneath it. The window was the one item of the three this function
        // was documented as modelling that never actually landed — it
        // advertised 3% for a campaign `pay` would pay 0 on.
        campaignId = _resolve(integrator, orderType, currency, block.timestamp);
        if (campaignId == bytes32(0)) return (bytes32(0), 0);

        Campaign storage c = _campaigns[campaignId];
        if (c.status != Status.ACTIVE) return (campaignId, 0);

        // RE-AUDIT (medium). `quote` must model what `pay` would ACTUALLY
        // transfer, not just the headline rate. It previously replicated
        // neither the budget clamps nor the funding-authorisation check, so
        // a dashboard kept advertising a reward after the budget was spent
        // or the funder had revoked — promising users cashback the contract
        // would not pay.
        address funder = c.fundingWallet;
        if (funder != c.owner && !fundingAuthorized[funder][c.owner][c.rewardToken]) {
            return (campaignId, 0);
        }

        reward = _grossReward(c, orderAmount);
        reward = _applyBudgets(campaignId, c, reward, address(0));
        if (reward == 0) return (campaignId, 0);

        // What the funding wallet can actually pay right now. AUDIT N6
        // (same class): this used to CLAMP to `spendable` and report the
        // remainder, but `pay` never transfers a partial reward — it asks
        // for the full amount, the transfer reverts on the shortfall, and
        // `PayFailed` leaves the order unpaid. Quoting the remainder
        // advertised a number no code path would ever pay. Under-funded is
        // 0, not "nearly".
        if (reward > _spendable(c)) return (campaignId, 0);
    }

    /// @notice What `pay` would transfer for a specific user, accounting for
    ///         their own daily allowance too. Preferred by dashboards that
    ///         know the recipient.
    function quoteForUser(
        address integrator,
        address user,
        bytes32 orderType,
        bytes32 currency,
        uint256 orderAmount
    ) external view returns (bytes32 campaignId, uint256 reward) {
        // AUDIT N5 / N6 — see `quote` for both.
        campaignId = _resolve(integrator, orderType, currency, block.timestamp);
        if (campaignId == bytes32(0)) return (bytes32(0), 0);

        Campaign storage c = _campaigns[campaignId];
        if (c.status != Status.ACTIVE) return (campaignId, 0);

        address funder = c.fundingWallet;
        if (funder != c.owner && !fundingAuthorized[funder][c.owner][c.rewardToken]) {
            return (campaignId, 0);
        }

        reward = _grossReward(c, orderAmount);
        reward = _applyBudgets(campaignId, c, reward, user);
        if (reward == 0) return (campaignId, 0);

        if (reward > _spendable(c)) return (campaignId, 0);
    }

    /// @notice The largest `flatAmount` this token may be configured with,
    ///         in its own base units — `MAX_FLAT_TOKENS` whole tokens.
    ///
    ///         AUDIT M2. The ceiling is decimals-dependent, so it cannot be
    ///         read off a constant any more. Exposed rather than left
    ///         implicit so an operator (or a UI) can show the real bound
    ///         instead of discovering it through a revert.
    function maxFlatAmountFor(address token) external view returns (uint256) {
        (uint256 num, uint256 den) = _decimalScale(token);
        return _maxFlatAmount(num, den);
    }

    /// @notice The lookup key for a triple, so operators can inspect
    ///         `activeFor` directly.
    function lookupKey(
        address integrator,
        bytes32 orderType,
        bytes32 currency
    ) external pure returns (bytes32) {
        return _key(integrator, orderType, currency);
    }

    // ─── Internals ────────────────────────────────────────────────────

    function _key(
        address integrator,
        bytes32 orderType,
        bytes32 currency
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(integrator, orderType, currency));
    }

    /**
     * @dev Campaign resolution, most specific first:
     *        1. (integrator, orderType, currency)  — exact match
     *        2. (integrator, orderType, ANY)       — any currency
     *        3. (integrator, ANY, ANY)             — integrator-wide default
     *      This is what lets one row cover a whole integrator while a single
     *      cell is overridden to run an experiment.
     */
    ///
    ///      `atTime` is the moment the reward is being judged AT — the
    ///      order's own `placedTimestamp` for `pay`, and `block.timestamp`
    ///      for the forward-looking `quote`. See `_payableAt`.
    function _resolve(
        address integrator,
        bytes32 orderType,
        bytes32 currency,
        uint256 atTime
    ) internal view returns (bytes32) {
        bytes32 id = activeFor[_key(integrator, orderType, currency)];
        if (_payableAt(id, integrator, atTime)) return id;

        id = activeFor[_key(integrator, orderType, ANY)];
        if (_payableAt(id, integrator, atTime)) return id;

        id = activeFor[_key(integrator, ANY, ANY)];
        if (_payableAt(id, integrator, atTime)) return id;

        return bytes32(0);
    }

    /// @dev Why did `_resolve` come back empty? Inspects the same three
    ///      tiers and reports the most actionable explanation, preferring a
    ///      recoverable one: if ANY tier is occupied by a campaign that is
    ///      merely paused, the order is worth retrying and must not be
    ///      retired. Slots already read by `_resolve`, so these loads are
    ///      warm.
    function _declineReason(
        address integrator,
        bytes32 orderType,
        bytes32 currency,
        uint256 atTime
    ) internal view returns (uint8) {
        bytes32[3] memory ids = [
            activeFor[_key(integrator, orderType, currency)],
            activeFor[_key(integrator, orderType, ANY)],
            activeFor[_key(integrator, ANY, ANY)]
        ];

        uint8 best = DECLINE_NO_CAMPAIGN;
        for (uint256 i; i < 3; ++i) {
            if (ids[i] == bytes32(0)) continue;
            Campaign storage c = _campaigns[ids[i]];
            if (c.status != Status.ACTIVE) return DECLINE_CAMPAIGN_INACTIVE; // recoverable
            if (c.epoch != integratorEpoch[integrator]) {
                best = DECLINE_CAMPAIGN_RETIRED;
                continue;
            }
            // Active and current, so the window is the only thing left.
            if (atTime < c.startTime || (c.endTime != 0 && atTime > c.endTime)) {
                best = DECLINE_OUT_OF_WINDOW;
            }
        }
        return best;
    }

    /// @dev Would this campaign pay an order judged at `atTime`?
    ///
    ///      AUDIT N3. `_payable` checked status and epoch but NOT the
    ///      validity window, while `pay` checked the window only after
    ///      resolution had already committed to a campaign. A campaign
    ///      scheduled to start next week — activated now, which is allowed —
    ///      therefore occupied its tier, shadowed the healthy integrator-wide
    ///      row beneath it, and paid nothing in the meantime. That is the
    ///      same shadowing class as the retired-campaign bug already fixed
    ///      once in `_payable`; the window was simply missed.
    ///
    ///      WHY `atTime` AND NOT `block.timestamp`: judging the window
    ///      against "now" would have been a regression dressed as a fix.
    ///      Orders are routinely reported late — the watcher holds them for
    ///      up to a 14-day dispute TTL — so an order genuinely placed inside
    ///      the window but reported after `endTime` would stop resolving to
    ///      its own campaign and fall through to a broader one, or to
    ///      nothing. Resolution asks "which campaign governed THIS order",
    ///      which is a question about when the order was placed.
    function _payableAt(
        bytes32 id,
        address integrator,
        uint256 atTime
    ) internal view returns (bool) {
        if (!_payable(id, integrator)) return false;
        Campaign storage c = _campaigns[id];
        if (atTime < c.startTime) return false;
        if (c.endTime != 0 && atTime > c.endTime) return false;
        return true;
    }

    /// @dev Does this campaign OCCUPY its lookup slot? Status and epoch only
    ///      — deliberately not the validity window, because a campaign
    ///      scheduled to start next week still owns its triple, and one whose
    ///      window has closed may still owe payment on orders placed inside
    ///      it that have not been reported yet. Freeing a slot is what
    ///      `pause` and `end` are for. Resolution asks the stricter,
    ///      order-relative question — see `_payableAt`.
    ///
    ///      Is this campaign live enough to be worth resolving to?
    ///
    ///      AUDIT FIX: resolution used to stop at the first OCCUPIED slot,
    ///      so a narrow campaign that had gone stale (retired by an
    ///      ownership handover) permanently shadowed a healthy broader one —
    ///      orders matched it, found it unpayable, and never fell through.
    ///      Checking payability per tier makes the fallback do what it
    ///      claims. Note this deliberately does NOT check the funding
    ///      wallet's balance: an underfunded campaign should surface as
    ///      `PayFailed` and be topped up, not be silently bypassed by a
    ///      different campaign the operator did not intend to use.
    function _payable(bytes32 id, address integrator) internal view returns (bool) {
        if (id == bytes32(0)) return false;
        Campaign storage c = _campaigns[id];
        if (c.status != Status.ACTIVE) return false;
        return c.epoch == integratorEpoch[integrator];
    }

    /**
     * @dev The trust boundary. Reads the order back from the Diamond and
     *      confirms every field the watcher claimed. Returns the Diamond's
     *      own `user` so the caller pays the address of record rather than
     *      the reported one.
     *
     *      A Diamond that reverts or returns a malformed record fails closed
     *      (no payout) instead of bubbling up.
     */
    function _verifyOrder(
        uint256 orderId,
        address integrator,
        address reportedUser,
        uint256 reportedAmount
    ) internal view returns (bool ok, VerifiedOrder memory v) {
        if (integrator == address(0)) return (false, v);

        // AUDIT F1 (HIGH). Bind the order to the integrator being billed.
        // Previously `integrator` was taken from the report and only checked
        // non-zero, so whoever held the accruer key could point ANY completed
        // order — including organic ones that never touched an integrator —
        // at ANY campaign and drain that tenant's funding wallet. The
        // Diamond is the authority on which integrator placed an order.
        try IOrderFlow(diamond).getOrderIntegrator(orderId) returns (address bound) {
            if (bound == address(0) || bound != integrator) return (false, v);
        } catch {
            return (false, v);
        }

        try IOrderFlow(diamond).getOrdersById(orderId) returns (IOrderFlow.OrderView memory order) {
            if (order.id != orderId) return (false, v);
            if (order.status != STATUS_COMPLETED) return (false, v);
            if (order.user == address(0)) return (false, v);
            if (order.user != reportedUser) return (false, v);
            if (order.amount != reportedAmount) return (false, v);

            // AUDIT F7 (MEDIUM). Campaigns are not retroactive: an order is
            // only eligible for a campaign that was already running when the
            // order was placed. Without this, activating a campaign today
            // would pay every historical order for that integrator, and
            // `setRate` would silently re-price orders placed under the old
            // rate.
            if (order.placedTimestamp == 0) return (false, v);

            // AUDIT F3 (MEDIUM-HIGH). Derive the campaign selectors from the
            // RECORD, not the report. They were reported values, so the same
            // key that reports orders also chose which campaign paid — an
            // INR BUY could be reported as a SELL to hit a higher promo row.
            // Both fields are on the record we already read.
            v.user = order.user;
            v.orderType = _orderTypeLabel(order.orderType);
            v.currency = order.currency;
            v.placedAt = order.placedTimestamp;
            return (true, v);
        } catch {
            return (false, v);
        }
    }

    /// @dev Diamond order types are a uint8 enum (0=BUY, 1=SELL, 2=PAY).
    ///      An unrecognised value maps to bytes32(0), which is the ANY
    ///      wildcard — so it can only ever match a deliberately-wildcard
    ///      campaign, never be mislabelled as a BUY.
    function _orderTypeLabel(uint8 orderType) internal pure returns (bytes32) {
        if (orderType == 0) return ORDER_TYPE_BUY;
        if (orderType == 1) return ORDER_TYPE_SELL;
        if (orderType == 2) return ORDER_TYPE_PAY;
        return ANY;
    }

    /// @dev Gas-capped, failure-tolerant `balanceOf`.
    ///
    ///      FOURTH-PASS AUDIT (critical). The delivered-amount measurement
    ///      introduced two *uncapped* high-level `balanceOf` calls into the
    ///      payout path. `rewardToken` is chosen by the tenant, so that is
    ///      attacker code receiving 63/64 of the batch's remaining gas — a
    ///      token whose `balanceOf` loops forever drained the batch before
    ///      `transferFrom` was ever reached, taking down every honest row.
    ///      That is exactly the griefing `TOKEN_CALL_GAS` exists to stop:
    ///      the fix for one finding reopened the hole closed by another.
    ///
    ///      Capped at the same budget, and a revert or malformed return
    ///      yields `(false, 0)` so the caller degrades instead of bubbling.
    function _tryBalanceOf(
        address token,
        address who
    ) internal view returns (bool ok, uint256 bal) {
        (bool callOk, bytes memory ret) = token.staticcall{ gas: TOKEN_CALL_GAS }(
            abi.encodeCall(IERC20.balanceOf, (who))
        );
        if (!callOk || ret.length < 32) return (false, 0);
        return (true, abi.decode(ret, (uint256)));
    }

    /// @dev The headline reward before any budget clamp. Shared by `pay`
    ///      and `quote` so the two can never drift apart.
    function _grossReward(
        Campaign storage c,
        uint256 orderAmount
    ) internal view returns (uint256 reward) {
        reward = c.flatAmount > 0
            ? c.flatAmount
            : (orderAmount * c.bps * c.scaleNum) / (BPS_DENOMINATOR * c.scaleDen);
        if (c.maxRewardPerOrder != 0 && reward > c.maxRewardPerOrder) {
            reward = c.maxRewardPerOrder;
        }
    }

    /// @dev Applies the lifetime, daily and per-user budgets to a reward.
    ///      Returns the amount to pay, or 0 to decline the order and leave it
    ///      retryable. Pass `user = address(0)` to skip the per-user leg (the
    ///      generic `quote`, which does not know the recipient).
    ///
    ///      AUDIT N6. This used to CLAMP unconditionally — pay out whatever
    ///      headroom was left, however small. With one micro-unit of daily
    ///      budget remaining, an order that had earned $10 was paid
    ///      $0.000001; because `orderPaid` is set on any non-zero payout,
    ///      that burned the order's one payout slot forever. The user got
    ///      dust instead of cashback, permanently, and the log recorded it
    ///      as a successful payment.
    ///
    ///      THE RULE: defer only when deferring can actually change the
    ///      outcome. A daily cap refills at UTC midnight, so an order that
    ///      would fit a fresh day is declined today and paid in full
    ///      tomorrow. A lifetime cap never refills, so its remainder is paid
    ///      out rather than withheld forever. And a reward larger than the
    ///      whole cap — a misconfigured campaign, or an outsized order under
    ///      an unlimited `maxRewardPerOrder` — is still clamped, because
    ///      waiting would never help it and best effort beats never paying.
    ///
    ///      That last case is why this is not a flat "all or nothing": that
    ///      version reads cleaner and deadlocks. Any reward permanently
    ///      exceeding a cap would be declined every day until the watcher's
    ///      TTL dropped it, turning a too-small cap into silent non-payment
    ///      — the exact failure this audit round was about.
    ///
    ///      Deferral only works if somebody retries. It pairs with
    ///      `PayDeclined(BUDGET_EXHAUSTED)` and a watcher that keeps
    ///      declined orders pending (AUDIT N1); without that half, deferring
    ///      is just a slower way to never pay.
    function _applyBudgets(
        bytes32 campaignId,
        Campaign storage c,
        uint256 reward,
        address user
    ) internal view returns (uint256) {
        // LIFETIME budget. This one never refills, so deferring the order
        // could not help — it would just be a slower way of never paying it.
        // Spend what remains.
        if (c.totalBudget != 0) {
            uint256 paid = stats[campaignId].totalPaid;
            uint256 leftTotal = c.totalBudget > paid ? c.totalBudget - paid : 0;
            if (reward > leftTotal) reward = leftTotal;
            if (reward == 0) return 0;
        }

        uint256 today = block.timestamp / 1 days;

        // DAILY budget. Refills at UTC midnight, so a reward that today's
        // remainder cannot cover is deferred rather than shaved.
        if (c.dailyBudget != 0) {
            uint256 spentToday = campaignDaySpend[campaignId][today];
            uint256 leftToday = c.dailyBudget > spentToday ? c.dailyBudget - spentToday : 0;
            if (reward > leftToday) {
                if (reward <= c.dailyBudget) return 0; // fits a fresh day — wait for one
                reward = leftToday; // never fits; best effort beats never
                if (reward == 0) return 0;
            }
        }

        // PER-USER daily allowance. Same reasoning against the user's own cap.
        if (user != address(0) && c.dailyPerUser != 0) {
            uint256 userToday = userDaySpend[campaignId][user][today];
            uint256 leftUser = c.dailyPerUser > userToday ? c.dailyPerUser - userToday : 0;
            if (reward > leftUser) {
                if (reward <= c.dailyPerUser) return 0;
                reward = leftUser;
                if (reward == 0) return 0;
            }
        }
        return reward;
    }

    /// @dev What the funding wallet can actually pay right now: the lesser of
    ///      its balance and the allowance it granted this registry.
    ///
    ///      AUDIT M3. These were high-level, UNCAPPED calls into
    ///      tenant-chosen token code — exactly the hazard `TOKEN_CALL_GAS`
    ///      and `_tryBalanceOf` exist to contain on the payout path, left
    ///      open on the view path. A token whose `balanceOf` loops forever
    ///      made `quote`, `quoteForUser` and `campaignView` revert for that
    ///      campaign, so the fix for the payout path had simply moved the
    ///      griefing surface to the dashboard.
    ///
    ///      A token that cannot report either figure is treated as unable to
    ///      pay (0) rather than bubbling the revert — the same fail-closed
    ///      posture `pay` takes.
    function _spendable(Campaign storage c) internal view returns (uint256) {
        (bool okBal, uint256 balance) = _tryBalanceOf(c.rewardToken, c.fundingWallet);
        if (!okBal) return 0;
        (bool okAllow, uint256 allowed) = _tryAllowance(c.rewardToken, c.fundingWallet);
        if (!okAllow) return 0;
        return balance < allowed ? balance : allowed;
    }

    /// @dev Gas-capped, failure-tolerant `allowance(owner, address(this))`.
    ///      See `_tryBalanceOf`; same rationale (AUDIT M3).
    function _tryAllowance(
        address token,
        address owner
    ) internal view returns (bool ok, uint256 amount) {
        (bool callOk, bytes memory ret) = token.staticcall{ gas: TOKEN_CALL_GAS }(
            abi.encodeCall(IERC20.allowance, (owner, address(this)))
        );
        if (!callOk || ret.length < 32) return (false, 0);
        return (true, abi.decode(ret, (uint256)));
    }

    /// @dev Converts a 6-decimal USDC order amount into the reward token's
    ///      units. A token that does not expose `decimals()` is treated as
    ///      6dp (1:1), which is the conservative choice — it under-pays
    ///      rather than over-pays if the assumption is wrong.
    function _decimalScale(address token) internal view returns (uint256 num, uint256 den) {
        uint8 dec = 6;
        try IERC20Metadata(token).decimals() returns (uint8 d) {
            dec = d;
        } catch {
            // keep 6
        }
        if (dec >= 6) return (10 ** (uint256(dec) - 6), 1);
        return (1, 10 ** (6 - uint256(dec)));
    }

    /// @dev Exactly one of `bps` / `flatAmount` must be set, and BOTH rate
    ///      forms are bounded.
    ///
    ///      AUDIT FIX: `flatAmount` previously had no ceiling, so the
    ///      "no unbounded payout" guarantee held only for the percentage
    ///      path — a flat rate could be set to drain a funding wallet in a
    ///      single order. `MAX_FLAT_TOKENS` closes that — see
    ///      `_maxFlatAmount` for why the cap is denominated in whole tokens
    ///      rather than base units (AUDIT M2).
    function _validateRate(
        uint16 bps,
        uint256 flatAmount,
        uint256 scaleNum,
        uint256 scaleDen
    ) internal pure {
        bool usesBps = bps > 0;
        bool usesFlat = flatAmount > 0;
        if (usesBps == usesFlat) revert InvalidRate(); // both or neither
        if (usesBps && bps > MAX_BPS) revert InvalidRate();
        if (usesFlat && flatAmount > _maxFlatAmount(scaleNum, scaleDen)) revert InvalidRate();
    }

    /// @dev `MAX_FLAT_TOKENS` whole tokens, in this token's base units.
    ///
    ///      AUDIT M2. `scaleNum/scaleDen` already encode the token's decimals
    ///      relative to USDC's 6 (see `_decimalScale`), so one whole token is
    ///      `1e6 * scaleNum / scaleDen` base units and the cap is that times
    ///      `MAX_FLAT_TOKENS`. Worked through: USDC (6dp, 1/1) gives 1e9 =
    ///      1,000 USDC; an 18dp token (1e12/1) gives 1e21 = 1,000 tokens;
    ///      a 2dp token (1/1e4) gives 1e5 = 1,000 tokens. The same programme
    ///      -shaped ceiling in every decimal world, rather than one that is
    ///      real at 18dp and vacuous at 6dp.
    function _maxFlatAmount(uint256 scaleNum, uint256 scaleDen) internal pure returns (uint256) {
        return (MAX_FLAT_TOKENS * 1e6 * scaleNum) / scaleDen;
    }

    /**
     * @dev Proof that the caller may spend from `fundingWallet`.
     *
     *      AUDIT FIX: this used to also accept "the wallet granted msg.sender
     *      an allowance of the reward token". That was unsound on three
     *      counts: it tested the wrong spender (payouts pull as
     *      `address(this)`, not as the caller), any dust allowance granted
     *      for an unrelated reason passed it, and it was point-in-time — the
     *      binding survived the allowance being revoked. Together those let
     *      one owner fund a campaign from another party's treasury.
     *
     *      A wallet other than the caller must therefore opt in explicitly
     *      via `authorizeCampaignFunder`, which only that wallet's keyholder
     *      can call. Authorisation is re-checked on every payout, so it is a
     *      live permission rather than a one-time assertion.
     */
    function _requireFundingControl(address fundingWallet, address token) internal view {
        if (fundingWallet == msg.sender) return;
        if (fundingAuthorized[fundingWallet][msg.sender][token]) return;
        revert FundingWalletNotAuthorized();
    }

    /// @dev Free the lookup slot if this campaign currently holds it.
    function _releaseSlot(bytes32 campaignId, Campaign storage c) internal {
        bytes32 key = _key(c.integrator, c.orderType, c.currency);
        if (activeFor[key] == campaignId) {
            delete activeFor[key];
        }
    }
}
