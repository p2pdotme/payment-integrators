// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/**
 * @title ICashbackRegistry
 * @notice Public surface of the cashback registry: per-integrator ownership,
 *         the campaign table, the watcher-facing payout entry points, and the
 *         campaign lifecycle.
 *
 *         Multi-tenant by design: each integrator has an owner who runs
 *         cashback for that integrator alone, funded from their own wallet.
 *         One owner may run many campaigns across many integrators.
 */
interface ICashbackRegistry {
    /// @notice Campaign lifecycle. A campaign only pays while ACTIVE.
    ///         ENDED is terminal — it can never be reactivated.
    enum Status {
        INACTIVE,
        ACTIVE,
        PAUSED,
        ENDED
    }

    /**
     * @notice One campaign row. The first five fields are the operator-facing
     *         "form"; `fundingWallet` is where its rewards are paid from, and
     *         the rest is lifecycle.
     *
     * @dev `bps` and `flatAmount` are mutually exclusive — exactly one is
     *      non-zero. `bps` is in basis points (100 = 1%).
     */
    struct Campaign {
        uint256 epoch; // ownership epoch it was created in; stale = retired
        address integrator; // which integrator this applies to
        bytes32 orderType; // BUY / SELL / ANY
        bytes32 currency; // e.g. "INR" / ANY
        address rewardToken; // token paid out
        uint16 bps; // 100 = 1%  (XOR flatAmount)
        uint256 flatAmount; // fixed reward (XOR bps)
        address fundingWallet; // pays for THIS campaign — never anyone else's
        // Scales a 6dp USDC order amount into the reward token's units.
        uint256 scaleNum;
        uint256 scaleDen;
        // Budgets (0 = unlimited). Enforced on-chain rather than left to
        // operator discipline over the ERC-20 allowance.
        uint256 maxRewardPerOrder;
        uint256 dailyBudget;
        uint256 totalBudget;
        uint256 dailyPerUser;
        // Validity window. Only orders PLACED inside it are eligible, so a
        // campaign can never retroactively pay historical orders.
        uint64 startTime;
        uint64 endTime; // 0 = open-ended
        Status status;
        address owner; // integrator owner at creation time
    }

    /// @notice The budget dials, grouped so `createCampaign` stays readable
    ///         and callers cannot transpose them positionally.
    struct Budget {
        uint256 maxRewardPerOrder;
        uint256 dailyBudget;
        uint256 totalBudget;
        uint256 dailyPerUser;
        uint64 startTime;
        uint64 endTime;
    }

    /// @notice Running totals per campaign, for dashboards.
    struct Stats {
        uint256 totalPaid; // reward units transferred
        uint256 orderCount; // orders rewarded
    }

    /// @notice One reported order, as submitted by a watcher in a batch.
    struct OrderReport {
        uint256 orderId;
        address integrator;
        address user;
        uint256 orderAmount;
    }

    // ─── Events ───────────────────────────────────────────────────────

    /// @notice An integrator's cashback owner was set or changed. That owner
    ///         alone may run campaigns for this integrator.
    event IntegratorOwnerSet(address indexed integrator, address previous, address current);
    /// @notice An integrator changed hands, retiring every campaign created
    ///         under the previous owner so their funding wallet cannot be
    ///         spent by the new one.
    event IntegratorEpochBumped(address indexed integrator, uint256 epoch);
    /// @notice A wallet authorised (or revoked) a spender to attach it as a
    ///         campaign funding wallet. Only the wallet itself can call this.
    event FundingAuthorizationSet(
        address indexed wallet,
        address indexed spender,
        address indexed token,
        bool allowed
    );
    /// @notice A campaign's budget dials or validity window were changed.
    event CampaignBudgetChanged(bytes32 indexed campaignId);

    event CampaignCreated(
        bytes32 indexed campaignId,
        address indexed integrator,
        address indexed owner,
        address rewardToken,
        bytes32 orderType,
        bytes32 currency,
        uint16 bps,
        uint256 flatAmount,
        address fundingWallet
    );
    event CampaignStatusChanged(bytes32 indexed campaignId, Status previous, Status current);
    event CampaignRateChanged(bytes32 indexed campaignId, uint16 bps, uint256 flatAmount);
    event CampaignFundingWalletChanged(
        bytes32 indexed campaignId,
        address previous,
        address current
    );

    /// @notice A reward was paid. `orderId` ties it back to the protocol order.
    event Paid(
        bytes32 indexed campaignId,
        uint256 indexed orderId,
        address indexed user,
        address rewardToken,
        uint256 amount
    );
    /// @notice The reward transfer failed (funding wallet empty, approval
    ///         revoked, or a hostile token). The order is left unpaid so it
    ///         can be retried after the wallet is topped up.
    event PayFailed(
        bytes32 indexed campaignId,
        uint256 indexed orderId,
        address indexed user,
        uint256 amount
    );

    event AccruerSet(address indexed accruer, bool allowed);
    event AdminSet(address indexed admin, bool allowed);

    // ─── Payout ───────────────────────────────────────────────────────

    function pay(
        uint256 orderId,
        address integrator,
        address user,
        uint256 orderAmount
    ) external returns (uint256 reward);

    function payBatch(OrderReport[] calldata reports) external;

    // ─── Views ────────────────────────────────────────────────────────

    function orderPaid(uint256 orderId) external view returns (bool);

    function integratorOwner(address integrator) external view returns (address);

    function quote(
        address integrator,
        bytes32 orderType,
        bytes32 currency,
        uint256 orderAmount
    ) external view returns (bytes32 campaignId, uint256 reward);
}
