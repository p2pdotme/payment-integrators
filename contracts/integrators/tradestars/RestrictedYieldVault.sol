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
 *         Principal access:
 *           - Owner withdraws up to 40% of principal + 100% of yield.
 *           - Operator (the offramp integrator) can draw up to 100% of
 *             principal to fund SELL orders. Refunds (cancelled offramps)
 *             are returned via `returnFromOfframp`.
 */
contract RestrictedYieldVault is IRestrictedYieldVault {
    using SafeERC20 for IERC20;

    error OnlyOwner();
    error OnlyOperator();
    error OnlyPendingOwner();
    error InvalidAddress();
    error InvalidAmount();
    error ExceedsOwnerQuota();
    error ExceedsOfframpQuota();
    /// @notice Owner's 40% quota is theoretical and computed against
    ///         `totalPrincipal`. The pool is shared with the offramp
    ///         operator (which can draw up to 100% of principal), so the
    ///         actual aUSDC balance may be below the owner's quota when
    ///         offramp activity has drained the vault. This error is
    ///         raised when the request is inside the quota but exceeds
    ///         the on-chain balance — distinct from `ExceedsOwnerQuota`,
    ///         which means the owner asked above 40% in the first place.
    error InsufficientFunds();

    event Deposited(address indexed from, uint256 amount, uint256 newPrincipal);
    event OwnerWithdrew(
        address indexed to,
        uint256 amount,
        uint256 fromYield,
        uint256 fromPrincipal
    );
    event OfframpReleased(address indexed operator, uint256 amount);
    event OfframpReturned(address indexed operator, uint256 amount);
    /// @notice Emitted when the current owner nominates a new owner. The
    ///         nominee must call `acceptOwnership` to complete the transfer.
    event OwnerProposed(address indexed proposed);
    event OwnerUpdated(address indexed newOwner);
    event OperatorUpdated(address indexed newOperator);

    IERC20 public immutable usdc;
    IERC20 public immutable aUsdc;
    IAavePool public immutable aave;
    /// @notice Bps (out of 10_000) of `totalPrincipal` reserved for the
    ///         owner's withdrawal quota. The rest backs the offramp pool.
    uint256 public constant OWNER_PRINCIPAL_BPS = 4000; // 40%

    address public owner;
    /// @notice 2-step ownership transfer: the proposed owner must call
    ///         `acceptOwnership` to complete the rotation. Closes the typo
    ///         risk that would otherwise brick the vault (custody-bearing
    ///         contract).
    address public pendingOwner;
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

        // Since the offramp operator can drain up to 100% of principal,
        // the theoretical quota may exceed the actual aUSDC balance.
        // Surface that as a clean revert instead of letting the call
        // reach Aave and fail with an opaque low-level error.
        if (amount > aUsdc.balanceOf(address(this))) revert InsufficientFunds();

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
        // Quota check uses the raw principal headroom rather than
        // `offrampQuota()` so the two failure modes stay distinguishable:
        // ExceedsOfframpQuota means the operator asked above cumulative
        // principal drawn, InsufficientFunds means the owner has pulled
        // their 40% and there isn't enough liquid balance to service this.
        uint256 q = totalPrincipal > offrampWithdrawn ? totalPrincipal - offrampWithdrawn : 0;
        if (amount > q) revert ExceedsOfframpQuota();
        if (amount > aUsdc.balanceOf(address(this))) revert InsufficientFunds();
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

    /// @notice Nominate a new owner. The nominee becomes owner only after
    ///         they call `acceptOwnership` from the proposed address — a
    ///         one-step transfer to a wrong address would brick the vault
    ///         (it holds principal + accrues yield from Aave).
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        pendingOwner = newOwner;
        emit OwnerProposed(newOwner);
    }

    /// @notice Complete a pending ownership transfer. Caller must be the
    ///         address nominated via `transferOwnership` — proves they
    ///         control the destination key.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert OnlyPendingOwner();
        address newOwner = pendingOwner;
        owner = newOwner;
        pendingOwner = address(0);
        emit OwnerUpdated(newOwner);
    }

    // ─── Views ───────────────────────────────────────────────────────

    function getYield() public view returns (uint256) {
        uint256 bal = aUsdc.balanceOf(address(this));
        return bal > totalPrincipal ? bal - totalPrincipal : 0;
    }

    /// @notice Effective USDC the owner can withdraw right now — the
    ///         theoretical (40% + yield) headroom bounded by the actual
    ///         aUSDC balance. Off-chain callers should treat this as a
    ///         hard ceiling; the on-chain function distinguishes the
    ///         two failure modes via `ExceedsOwnerQuota` vs
    ///         `InsufficientFunds`.
    function ownerQuota() external view returns (uint256) {
        uint256 principalQuota = (totalPrincipal * OWNER_PRINCIPAL_BPS) / 10_000;
        uint256 remaining = principalQuota > ownerWithdrawnPrincipal
            ? principalQuota - ownerWithdrawnPrincipal
            : 0;
        uint256 theoretical = remaining + getYield();
        uint256 bal = aUsdc.balanceOf(address(this));
        return theoretical < bal ? theoretical : bal;
    }

    /// @notice Effective USDC the operator can release right now — the
    ///         remaining principal headroom (totalPrincipal − offrampWithdrawn)
    ///         bounded by the actual aUSDC balance.
    function offrampQuota() public view returns (uint256) {
        uint256 q = totalPrincipal > offrampWithdrawn ? totalPrincipal - offrampWithdrawn : 0;
        uint256 bal = aUsdc.balanceOf(address(this));
        return q < bal ? q : bal;
    }
}
