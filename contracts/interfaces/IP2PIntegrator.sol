// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @title IP2PIntegrator
 * @notice Interface that every B2B integrator contract must implement.
 *         The protocol calls these functions during the order lifecycle.
 */
interface IP2PIntegrator {
    function validateOrder(
        address user,
        uint256 amount,
        bytes32 currency
    ) external returns (bool allowed);

    function onOrderComplete(
        uint256 orderId,
        address user,
        uint256 amount,
        address recipientAddr
    ) external;

    /// @notice Called by B2BGatewayFacet.onB2BOrderCancelled when a B2B BUY
    ///         order is cancelled (manual / expiry / dispute / PAY-failure).
    ///         Lets the integrator release any per-user accounting it
    ///         consumed during validateOrder (e.g. daily-count / RP debits).
    /// @dev    Best-effort from the gateway's POV: implementations should
    ///         tolerate being called with an unknown orderId or after another
    ///         cancellation, but MUST NOT touch any state tied to the
    ///         on-chain order itself — protocol-side completion / cancellation
    ///         has already finalised by the time this fires.
    function onOrderCancel(uint256 orderId) external;
}
