// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IRestrictedYieldVault } from "./IRestrictedYieldVault.sol";

/**
 * @dev Subset of the Aave V3 Pool interface we need. Production deployment
 *      uses the canonical Aave V3 Pool on Base; tests use a mock that
 *      implements the same shape.
 */
interface IAavePool {
    function supply(
        address asset,
        uint256 amount,
        address onBehalfOf,
        uint16 referralCode
    ) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

/**
 * @title RestrictedYieldVault
 * @notice Custodies USDC for the TradeStars-style flow. Deposits supply
 *         USDC to Aave (via aUSDC) so the principal earns yield while
 *         held. Withdrawals draw down from Aave automatically.
 *
 *         The 40/60 split:
 *           - Owner withdraws up to 40% of principal + 100% of yield.
 *           - Operator (the offramp integrator) draws from the remaining
 *             60% to fund SELL orders. Refunds (cancelled offramps) are
 *             returned via `returnFromOfframp`.
 *
 *         The two pools are tracked separately so neither role can
 *         encroach on the other's quota.
 */
contract RestrictedYieldVault is IRestrictedYieldVault {
    using SafeERC20 for IERC20;

    error OnlyOwner();
    error OnlyOperator();
    error InvalidAddress();
    error InvalidAmount();
    error ExceedsOwnerQuota();
    error ExceedsOfframpQuota();

    event Deposited(address indexed from, uint256 amount, uint256 newPrincipal);
    event OwnerWithdrew(
        address indexed to,
        uint256 amount,
        uint256 fromYield,
        uint256 fromPrincipal
    );
    event OfframpReleased(address indexed operator, uint256 amount);
    event OfframpReturned(address indexed operator, uint256 amount);
    event OwnerUpdated(address indexed newOwner);
    event OperatorUpdated(address indexed newOperator);

    IERC20 public immutable usdc;
    IERC20 public immutable aUsdc;
    IAavePool public immutable aave;
    /// @notice Bps (out of 10_000) of `totalPrincipal` reserved for the
    ///         owner's withdrawal quota. The rest backs the offramp pool.
    uint256 public constant OWNER_PRINCIPAL_BPS = 4000; // 40%

    address public owner;
    address public offrampOperator;

    uint256 public override totalPrincipal;
    uint256 public override ownerWithdrawnPrincipal;
    uint256 public override offrampWithdrawn;

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != offrampOperator) revert OnlyOperator();
        _;
    }

    constructor(address _usdc, address _aUsdc, address _aave) {
        if (_usdc == address(0) || _aUsdc == address(0) || _aave == address(0))
            revert InvalidAddress();
        usdc = IERC20(_usdc);
        aUsdc = IERC20(_aUsdc);
        aave = IAavePool(_aave);
        owner = msg.sender;
    }

    // ─── Deposits ────────────────────────────────────────────────────

    function deposit(uint256 amount) external {
        if (amount == 0) revert InvalidAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        totalPrincipal += amount;
        usdc.forceApprove(address(aave), amount);
        aave.supply(address(usdc), amount, address(this), 0);
        emit Deposited(msg.sender, amount, totalPrincipal);
    }

    // ─── Owner withdraw ──────────────────────────────────────────────

    function ownerWithdraw(uint256 amount) external onlyOwner {
        if (amount == 0) revert InvalidAmount();

        uint256 yield = getYield();
        uint256 principalQuota = (totalPrincipal * OWNER_PRINCIPAL_BPS) / 10_000;
        uint256 remainingPrincipalQuota = principalQuota > ownerWithdrawnPrincipal
            ? principalQuota - ownerWithdrawnPrincipal
            : 0;
        uint256 maxWithdraw = remainingPrincipalQuota + yield;
        if (amount > maxWithdraw) revert ExceedsOwnerQuota();

        // Yield first, then principal.
        uint256 fromYield = amount > yield ? yield : amount;
        uint256 fromPrincipal = amount - fromYield;
        ownerWithdrawnPrincipal += fromPrincipal;

        aave.withdraw(address(usdc), amount, msg.sender);
        emit OwnerWithdrew(msg.sender, amount, fromYield, fromPrincipal);
    }

    // ─── Offramp operator pull / refund ──────────────────────────────

    function releaseForOfframp(uint256 amount) external onlyOperator {
        if (amount == 0) revert InvalidAmount();
        uint256 q = offrampQuota();
        if (amount > q) revert ExceedsOfframpQuota();
        offrampWithdrawn += amount;
        aave.withdraw(address(usdc), amount, msg.sender);
        emit OfframpReleased(msg.sender, amount);
    }

    function returnFromOfframp(uint256 amount) external onlyOperator {
        if (amount == 0) revert InvalidAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        // Net offrampWithdrawn back down. Excess returns (paying back more
        // than was pulled, e.g. yield via Aave between cycles) are tolerated
        // by clamping at zero.
        offrampWithdrawn = amount > offrampWithdrawn ? 0 : offrampWithdrawn - amount;
        usdc.forceApprove(address(aave), amount);
        aave.supply(address(usdc), amount, address(this), 0);
        emit OfframpReturned(msg.sender, amount);
    }

    // ─── Admin ───────────────────────────────────────────────────────

    function setOfframpOperator(address op) external onlyOwner {
        if (op == address(0)) revert InvalidAddress();
        offrampOperator = op;
        emit OperatorUpdated(op);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        owner = newOwner;
        emit OwnerUpdated(newOwner);
    }

    // ─── Views ───────────────────────────────────────────────────────

    function getYield() public view returns (uint256) {
        uint256 bal = aUsdc.balanceOf(address(this));
        return bal > totalPrincipal ? bal - totalPrincipal : 0;
    }

    function ownerQuota() external view returns (uint256) {
        uint256 principalQuota = (totalPrincipal * OWNER_PRINCIPAL_BPS) / 10_000;
        uint256 remaining = principalQuota > ownerWithdrawnPrincipal
            ? principalQuota - ownerWithdrawnPrincipal
            : 0;
        return remaining + getYield();
    }

    function offrampQuota() public view returns (uint256) {
        uint256 quota = (totalPrincipal * (10_000 - OWNER_PRINCIPAL_BPS)) / 10_000;
        return quota > offrampWithdrawn ? quota - offrampWithdrawn : 0;
    }
}
