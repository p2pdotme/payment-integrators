// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
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

    // ─── Constants ────────────────────────────────────────────────────

    /// @notice Wildcard for `orderType` / `currency`, letting one campaign
    ///         cover every order type or every currency for an integrator.
    bytes32 public constant ANY = bytes32(0);

    /// @notice Hard ceiling on any campaign rate (2000 bps = 20%). There is
    ///         no setter — a compromised key, at any level, cannot configure
    ///         an unbounded payout.
    uint16 public constant MAX_BPS = 2000;

    /// @notice Ceiling on a flat per-order reward. Without this the
    ///         "no unbounded payout" guarantee covered only the percentage
    ///         path. 1e24 is generous for any 6- or 18-decimal reward token
    ///         while still bounding a single order's blast radius.
    uint256 public constant MAX_FLAT_AMOUNT = 1e24;

    uint256 private constant BPS_DENOMINATOR = 10_000;

    /// @dev Diamond order status (OrderProcessorStorage.OrderStatus).
    uint8 private constant STATUS_COMPLETED = 3;

    // ─── Immutables ───────────────────────────────────────────────────

    /// @notice The P2P Diamond. Every reported order is verified against it.
    address public immutable diamond;

    // ─── Roles ────────────────────────────────────────────────────────

    /// @notice Registry admins. They assign integrator owners and manage
    ///         watchers. They deliberately CANNOT create campaigns, change a
    ///         rate, or redirect anyone's funds — see `emergencyStop` for the
    ///         one power they hold over a live campaign.
    mapping(address => bool) public admin;

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

    /// @notice fundingWallet => spender => may that spender attach this
    ///         wallet to a campaign. Only the wallet itself can grant this,
    ///         and it is re-checked on every payout, so revoking it stops
    ///         the campaign immediately.
    mapping(address => mapping(address => bool)) public fundingAuthorized;

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
        emit AdminSet(msg.sender, true);
    }

    // ─── Registry admin ───────────────────────────────────────────────

    function setAdmin(address who, bool allowed) external onlyAdmin {
        if (who == address(0)) revert InvalidAddress();
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
    function emergencyStop(bytes32 campaignId, bool permanent) external onlyAdmin {
        Campaign storage c = _campaigns[campaignId];
        if (c.integrator == address(0)) revert UnknownCampaign();
        if (c.status == Status.ENDED) revert InvalidStatus();

        Status previous = c.status;
        _releaseSlot(campaignId, c);
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
    function authorizeCampaignFunder(address spender, bool allowed) external {
        if (spender == address(0)) revert InvalidAddress();
        fundingAuthorized[msg.sender][spender] = allowed;
        emit FundingAuthorizationSet(msg.sender, spender, allowed);
    }

    // ─── Campaign management (integrator owners) ──────────────────────

    /**
     * @notice Create a campaign for an integrator you own. This is the form.
     *         Starts INACTIVE — `activate` is a deliberate second step so a
     *         half-configured campaign can never pay out.
     *
     * @param integrator    Integrator the campaign applies to. You must be
     *                      its registered owner.
     * @param orderType     BUY / SELL, or ANY for every type.
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
        address fundingWallet
    ) external returns (bytes32 campaignId) {
        address owner = integratorOwner[integrator];
        if (owner == address(0)) revert IntegratorUnclaimed();
        if (msg.sender != owner) revert OnlyIntegratorOwner();
        if (rewardToken == address(0) || fundingWallet == address(0)) revert InvalidAddress();
        _validateRate(bps, flatAmount);
        _requireFundingControl(fundingWallet);

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

    /// @notice Stop accruals without closing the campaign. Frees the lookup
    ///         slot so a replacement campaign can take the triple.
    function pause(bytes32 campaignId) external onlyCampaignOwner(campaignId) {
        Campaign storage c = _campaigns[campaignId];
        if (c.status != Status.ACTIVE) revert InvalidStatus();
        _releaseSlot(campaignId, c);
        c.status = Status.PAUSED;
        emit CampaignStatusChanged(campaignId, Status.ACTIVE, Status.PAUSED);
    }

    /// @notice Close a campaign permanently. Terminal.
    function end(bytes32 campaignId) external onlyCampaignOwner(campaignId) {
        Campaign storage c = _campaigns[campaignId];
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
        _validateRate(bps, flatAmount);
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
        _requireFundingControl(fundingWallet);

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
        bytes32 orderType,
        bytes32 currency,
        uint256 orderAmount
    ) public onlyAccruer returns (uint256 reward) {
        if (orderPaid[orderId]) return 0;

        // TRUST BOUNDARY. Re-read the order from the Diamond and confirm it
        // matches the report. `verifiedUser` is the Diamond's record of who
        // the order belongs to — the reward goes there, never to the address
        // the watcher supplied. `orderAmount` is USDC (6dp), so percentage
        // rewards are a share of USDC bought, not of local fiat paid.
        (bool ok, address verifiedUser) = _verifyOrder(orderId, integrator, user, orderAmount);
        if (!ok) return 0;

        bytes32 campaignId = _resolve(integrator, orderType, currency);
        if (campaignId == bytes32(0)) return 0;

        Campaign storage c = _campaigns[campaignId];
        if (c.status != Status.ACTIVE) return 0;

        // A campaign created before the integrator changed hands is retired:
        // its funding wallet belongs to the previous owner and must not be
        // spent by the new one.
        if (c.epoch != integratorEpoch[c.integrator]) return 0;

        // Funding authorisation is LIVE, not a one-time assertion. A wallet
        // that revoked its authorisation stops paying immediately, even
        // though the ERC-20 allowance may still be in place for other
        // campaigns.
        address funder = c.fundingWallet;
        if (funder != c.owner && !fundingAuthorized[funder][c.owner]) return 0;

        reward = c.flatAmount > 0 ? c.flatAmount : (orderAmount * c.bps) / BPS_DENOMINATOR;
        if (reward == 0) return 0;

        // Mark before the transfer so a reentrant token cannot re-enter and
        // collect twice for this order. Rolled back below if the transfer
        // fails, leaving the order retryable.
        orderPaid[orderId] = true;

        // Pull from THIS campaign's funding wallet — never a shared pool, so
        // one owner's campaign can never spend another's tokens. Wrapped so
        // an empty wallet, a revoked approval, or a hostile token degrades to
        // a logged skip rather than reverting the caller's whole batch.
        try IERC20(c.rewardToken).transferFrom(c.fundingWallet, verifiedUser, reward) returns (
            bool success
        ) {
            // Tokens that signal failure with a false return rather than a
            // revert must be treated as failures too — otherwise the order
            // would be marked paid while no tokens moved.
            if (!success) {
                orderPaid[orderId] = false;
                emit PayFailed(campaignId, orderId, verifiedUser, reward);
                return 0;
            }
        } catch {
            orderPaid[orderId] = false;
            emit PayFailed(campaignId, orderId, verifiedUser, reward);
            return 0;
        }

        Stats storage s = stats[campaignId];
        s.totalPaid += reward;
        s.orderCount += 1;

        emit Paid(campaignId, orderId, verifiedUser, c.rewardToken, reward);
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
            try this.pay(r.orderId, r.integrator, r.user, r.orderType, r.currency, r.orderAmount) {
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

        uint256 balance = IERC20(campaign.rewardToken).balanceOf(campaign.fundingWallet);
        uint256 allowed = IERC20(campaign.rewardToken).allowance(
            campaign.fundingWallet,
            address(this)
        );
        spendable = balance < allowed ? balance : allowed;
    }

    /// @notice Resolve the campaign that would apply to an order, and what it
    ///         would pay. Read-only preview for dashboards and the watcher.
    function quote(
        address integrator,
        bytes32 orderType,
        bytes32 currency,
        uint256 orderAmount
    ) external view returns (bytes32 campaignId, uint256 reward) {
        campaignId = _resolve(integrator, orderType, currency);
        if (campaignId == bytes32(0)) return (bytes32(0), 0);
        Campaign storage c = _campaigns[campaignId];
        if (c.status != Status.ACTIVE) return (campaignId, 0);
        reward = c.flatAmount > 0 ? c.flatAmount : (orderAmount * c.bps) / BPS_DENOMINATOR;
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
    function _resolve(
        address integrator,
        bytes32 orderType,
        bytes32 currency
    ) internal view returns (bytes32) {
        bytes32 id = activeFor[_key(integrator, orderType, currency)];
        if (_payable(id, integrator)) return id;

        id = activeFor[_key(integrator, orderType, ANY)];
        if (_payable(id, integrator)) return id;

        id = activeFor[_key(integrator, ANY, ANY)];
        if (_payable(id, integrator)) return id;

        return bytes32(0);
    }

    /// @dev Is this campaign live enough to be worth resolving to?
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
    ) internal view returns (bool ok, address verifiedUser) {
        // `integrator` is not on the Diamond's order record; it comes from
        // the B2BOrderPlaced event the watcher read. It only selects which
        // campaign applies — it cannot redirect funds, because the recipient
        // is taken from the verified order below.
        if (integrator == address(0)) return (false, address(0));

        try IOrderFlow(diamond).getOrdersById(orderId) returns (IOrderFlow.OrderView memory order) {
            if (order.id != orderId) return (false, address(0));
            if (order.status != STATUS_COMPLETED) return (false, address(0));
            if (order.user == address(0)) return (false, address(0));
            if (order.user != reportedUser) return (false, address(0));
            if (order.amount != reportedAmount) return (false, address(0));
            return (true, order.user);
        } catch {
            return (false, address(0));
        }
    }

    /// @dev Exactly one of `bps` / `flatAmount` must be set, and BOTH rate
    ///      forms are bounded.
    ///
    ///      AUDIT FIX: `flatAmount` previously had no ceiling, so the
    ///      "no unbounded payout" guarantee held only for the percentage
    ///      path — a flat rate could be set to drain a funding wallet in a
    ///      single order. `MAX_FLAT_AMOUNT` closes that.
    function _validateRate(uint16 bps, uint256 flatAmount) internal pure {
        bool usesBps = bps > 0;
        bool usesFlat = flatAmount > 0;
        if (usesBps == usesFlat) revert InvalidRate(); // both or neither
        if (usesBps && bps > MAX_BPS) revert InvalidRate();
        if (usesFlat && flatAmount > MAX_FLAT_AMOUNT) revert InvalidRate();
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
    function _requireFundingControl(address fundingWallet) internal view {
        if (fundingWallet == msg.sender) return;
        if (fundingAuthorized[fundingWallet][msg.sender]) return;
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
