// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @title IB2BGateway
 * @notice Interface for the B2BGatewayFacet on the P2P Diamond.
 */
interface IB2BGateway {
    function placeB2BOrder(
        address user,
        uint256 amount,
        bytes32 currency,
        address recipientAddr,
        string calldata pubKey,
        uint256 circleId,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) external returns (uint256 orderId);

    /// @notice SELL counterpart of placeB2BOrder. Whitelisted integrators bypass
    ///         protocol-side RP / daily / monthly / yearly volume limits and
    ///         enforce their own limits in `validateOrder`. Integrators that
    ///         act on behalf of users without a Base address (e.g. the
    ///         TradeStars Solana offramp) should pass `user = address(this)`.
    function placeB2BSellOrder(
        address user,
        uint256 amount,
        bytes32 currency,
        string calldata userPubKey,
        uint256 circleId,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) external returns (uint256 orderId);
}
