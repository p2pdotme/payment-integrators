// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/**
 * @title IMerchantTerminalLinks
 * @notice The payment-link surface of `MerchantTerminalIntegrator` that
 *         `LinkRouter` speaks to.
 *
 *         Only the four relayer entry points and the link view are
 *         declared. The Router deliberately has no way to name anything else on
 *         the integrator — no withdrawal, no profile edit, no admin — so this
 *         interface IS the Router's maximum reach into custody code.
 */
interface IMerchantTerminalLinks {
    /// @notice Place a link order on the absent merchant's behalf.
    /// @dev Callable only by the integrator's `trustedRelayer`, which is the
    ///      Router. The merchant is resolved from `link.owner` inside the
    ///      integrator — it is NOT taken from the caller, which is what lets
    ///      the Router (and the link wallet behind it) hold nothing at all.
    function relayerPlaceOrder(
        bytes32 linkId,
        address client,
        uint256 productId,
        uint256 quantity,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey
    ) external returns (uint256 orderId);

    /// @notice Mark a link order paid. Same relayer gate.
    function relayerMarkPaid(bytes32 linkId, uint256 orderId) external;

    /// @notice Cancel a link order. Same relayer gate.
    function relayerCancelOrder(bytes32 linkId, uint256 orderId) external;

    /// @notice Raise (`appeal` false) or appeal (`appeal` true) the Diamond's
    ///         dispute on a link order. From the Router (relayer gate) it acts
    ///         for `linkId`'s owner; any other caller acts as itself, on its own
    ///         link orders. `redactTransId` is used by a raise only.
    function linkDispute(
        bytes32 linkId,
        uint256 orderId,
        uint256 redactTransId,
        bool appeal
    ) external;

    /// @notice Full link record. The Router uses `owner` to authorise
    ///         registration, and `status`/`uses` for nothing — every link rule
    ///         is enforced by the integrator itself on the calls above.
    function getLink(
        bytes32 linkId
    )
        external
        view
        returns (
            address owner,
            uint96 amount,
            bytes32 currency,
            uint64 expiresAt,
            uint32 maxUses,
            uint8 status,
            uint32 uses,
            uint16 strikes
        );
}
