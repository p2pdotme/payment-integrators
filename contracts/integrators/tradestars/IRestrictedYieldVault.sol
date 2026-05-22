// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @title IRestrictedYieldVault
 * @notice Custodies USDC for an integrator (e.g. TradeStars) and earns
 *         yield via Aave. Two withdrawer roles:
 *
 *           - Owner: can pull up to 40% of principal + 100% of accrued yield.
 *           - Operator: the offramp integrator. Pulls from the remaining 60%
 *             pool to fund SELL orders, returns USDC on cancellation.
 *
 *         The split is tracked separately so neither role can drain the
 *         other's quota.
 */
interface IRestrictedYieldVault {
    /// @notice Deposit USDC. Anyone can deposit; the vault auto-supplies it
    ///         to Aave so it starts accruing yield immediately.
    function deposit(uint256 amount) external;

    /// @notice Owner-only. Pull up to (40% × principal) − ownerWithdrawnPrincipal
    ///         plus all accrued yield to date.
    function ownerWithdraw(uint256 amount) external;

    /// @notice Operator-only. Pull USDC for offramp settlement. Capped at
    ///         (60% × principal) − offrampWithdrawn so the owner's quota is
    ///         preserved.
    function releaseForOfframp(uint256 amount) external;

    /// @notice Operator-only. Return USDC to the vault (e.g. when an offramp
    ///         order cancels and the integrator is refunded).
    function returnFromOfframp(uint256 amount) external;

    // ── Views ────────────────────────────────────────────────────────────

    function totalPrincipal() external view returns (uint256);
    function ownerWithdrawnPrincipal() external view returns (uint256);
    function offrampWithdrawn() external view returns (uint256);
    function offrampOperator() external view returns (address);

    /// @notice Current yield (aUSDC balance − totalPrincipal). Returns 0 if
    ///         the vault is in deficit (shouldn't happen with Aave).
    function getYield() external view returns (uint256);

    /// @notice Remaining USDC the owner can withdraw right now.
    function ownerQuota() external view returns (uint256);

    /// @notice Remaining USDC the operator can pull for offramps.
    function offrampQuota() external view returns (uint256);
}
