// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @title IOrderFlow
 * @notice Subset of OrderFlowFacet used by the offramp section of
 *         MarketplaceCheckoutIntegrator. Targets the SELL flow only.
 *
 *         Order types: BUY=0, SELL=1, PAY=2.
 */
interface IOrderFlow {
    /// @notice Diamond's placeOrder returns void. The orderId is whatever
    ///         `getNextOrderId()` returned at the moment of the call (Diamond
    ///         reads-then-increments). Capture it before calling.
    function placeOrder(
        string calldata _pubKey,
        uint256 _amount,
        address _recipientAddr,
        uint8 _orderType,
        string calldata _userUpi,
        string calldata _userPubKey,
        bytes32 _currency,
        uint256 _preferredPaymentChannelConfigId,
        uint256 _circleId,
        uint256 _fiatAmountLimit
    ) external;

    function setSellOrderUpi(
        uint256 _orderId,
        string calldata _userEncUpi,
        uint256 _updatedAmount
    ) external;

    function getNextOrderId() external view returns (uint256);

    /// @notice Subset of GetterFacet.getAdditionalOrderDetails the integrator
    ///         needs to fund the system proxy correctly before setSellOrderUpi.
    ///         For SELL: actualUsdtAmount = principal + fee — this is what the
    ///         Diamond pulls via transferFrom from order.user, so the proxy
    ///         must hold (and approve) at least that much.
    struct AdditionalOrderDetailsView {
        uint64 fixedFeePaid;
        uint64 tipsPaid;
        uint128 acceptedTimestamp;
        uint128 paidTimestamp;
        uint128 reserved2;
        uint256 actualUsdtAmount;
        uint256 actualFiatAmount;
    }

    function getAdditionalOrderDetails(
        uint256 orderId
    ) external view returns (AdditionalOrderDetailsView memory);
}
