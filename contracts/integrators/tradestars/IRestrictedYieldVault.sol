// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @title IRestrictedYieldVault
 * @notice Custodies USDC for an integrator (e.g. TradeStars) and earns
 *         yield via Aave. Two withdrawer roles:
 *
 *           - Owner: can pull up to 40% of principal + 100% of accrued
 *             yield, bounded by the actual aUSDC balance.
 *           - Operator: the offramp integrator. Can draw up to the vault's
 *             full aUSDC balance to fund SELL orders (no cumulative cap —
 *             yield and owner-funded liquidity included), returns USDC on
 *             cancellation.
 *
 *         The owner's 40% is a cap on cumulative withdrawals rather than
 *         a reservation — the operator may legitimately drain the pool,
 *         in which case `ownerWithdraw` reverts with `InsufficientFunds`
 *         until new principal is deposited via onramp.
 *
 *         Separately, an owner-configurable P2P fee accrues on onramp and
 *         offramp volume at independent per-leg rates (default 2.5% each),
 *         net of cancelled offramps. `p2pAccrued()` returns the running
 *         total. This is accounting only — the vault never pays it out and
 *         it does not affect the quotas above; the fee is settled off-chain.
 */
interface IRestrictedYieldVault {
    /// @notice Deposit USDC. Anyone can deposit; the vault auto-supplies it
    ///         to Aave so it starts accruing yield immediately.
    function deposit(uint256 amount) external;

    /// @notice Owner-only. Pull up to (40% × principal) − ownerWithdrawnPrincipal
    ///         plus all accrued yield to date, bounded by the actual aUSDC
    ///         balance held by the vault.
    function ownerWithdraw(uint256 amount) external;

    /// @notice Operator-only. Pull USDC for offramp settlement. Bounded only
    ///         by the vault's live aUSDC balance — cumulative offramp volume
    ///         may exceed onramp (totalPrincipal) when backed by yield or
    ///         owner-supplied liquidity.
    function releaseForOfframp(uint256 amount) external;

    /// @notice Operator-only. Return USDC to the vault (e.g. when an offramp
    ///         order cancels and the integrator is refunded).
    function returnFromOfframp(uint256 amount) external;

    // ── Views ────────────────────────────────────────────────────────────

    function totalPrincipal() external view returns (uint256);
    function ownerWithdrawnPrincipal() external view returns (uint256);
    function offrampWithdrawn() external view returns (uint256);
    function offrampOperator() external view returns (address);

    /// @notice Total P2P fee accrued across both legs, net of cancelled
    ///         offramps. Accounting only — settled off-chain. The per-leg
    ///         ledgers and rates are exposed on the concrete contract.
    function p2pAccrued() external view returns (uint256);

    /// @notice Current yield (aUSDC balance − totalPrincipal). Returns 0 if
    ///         the vault is in deficit (shouldn't happen with Aave).
    function getYield() external view returns (uint256);

    /// @notice Remaining USDC the owner can withdraw right now.
    function ownerQuota() external view returns (uint256);

    /// @notice USDC the operator can pull for offramps right now — the
    ///         vault's live aUSDC balance.
    function offrampQuota() external view returns (uint256);
}
