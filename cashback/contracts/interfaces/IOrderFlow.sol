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

    /// @notice Dispute sub-struct embedded in the Diamond's Order record.
    ///         Both fields are uint8 enums on Diamond; mirror as uint8 so
    ///         ABI decoding works without importing Diamond's enum types.
    struct Dispute {
        uint8 raisedBy;
        uint8 status;
        uint256 redactTransId;
        uint256 accountNumber;
    }

    /// @notice Mirror of OrderProcessorStorage.Order. Field order must match
    ///         Diamond exactly — decoder reads positional ABI tuples. The
    ///         only field consumers (reconcile) actually read is `status`,
    ///         but the full shape has to be declared so the ABI return-type
    ///         resolves. Status values: 0=PLACED 1=ACCEPTED 2=PAID
    ///         3=COMPLETED 4=CANCELLED. Type values: 0=BUY 1=SELL 2=PAY.
    struct OrderView {
        uint256 amount;
        uint256 fiatAmount;
        uint256 placedTimestamp;
        uint256 completedTimestamp;
        uint256 userCompletedTimestamp;
        address acceptedMerchant;
        address user;
        address recipientAddr;
        string pubkey;
        string encUpi;
        bool userCompleted;
        uint8 status;
        uint8 orderType;
        Dispute disputeInfo;
        uint256 id;
        string userPubKey;
        string encMerchantUpi;
        uint256 acceptedAccountNo;
        uint256[] assignedAccountNos;
        bytes32 currency;
        uint256 preferredPaymentChannelConfigId;
        uint256 circleId;
    }

    /// @notice Mock of GetterFacet.getOrdersById. The integrator uses this
    ///         in `reconcile` to read the authoritative order status from
    ///         the Diamond rather than trusting a caller-supplied value —
    ///         closing a griefing surface where any address could lock the
    ///         offramp record into a wrong terminal state by passing the
    ///         wrong status.
    function getOrdersById(uint256 orderId) external view returns (OrderView memory);
}
