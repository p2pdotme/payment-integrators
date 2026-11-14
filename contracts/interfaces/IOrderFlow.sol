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

    /// @notice Marks a BUY order's fiat leg as sent, moving it to PAID.
    /// @dev GATED ON THE DIAMOND TO `order.user` — not to msg.sender of the
    ///      placement, and not to `recipientAddr`. Verified by eth_call against
    ///      both the Base mainnet Diamond (0x4cad…6368) and the Base Sepolia
    ///      Diamond (0xeb0B…beb9): from `order.user` the call clears the ACL and
    ///      fails only on a status/expiry check, while every other caller —
    ///      including the order's own `recipientAddr` — gets NotAuthorized()
    ///      (0xea8e4eb5).
    ///
    ///      This is why a payment-link order must place with the merchant's
    ///      proxy as `order.user`: the merchant is absent, and only an address
    ///      this integrator can drive is able to advance the order.
    ///
    ///      PAID is a CLAIM, not a settlement. USDC moves at COMPLETED, which
    ///      only the accepting LP can trigger after checking their own bank.
    function paidBuyOrder(uint256 orderId) external;

    /// @notice Cancels an order. Same `order.user` gate as `paidBuyOrder`.
    /// @dev Succeeds from `order.user` in PLACED and ACCEPTED. A PAID BUY is
    ///      out of `order.user`'s hands: on the Base Sepolia Diamond it reverts
    ///      NotAuthorized() (0xea8e4eb5) for `order.user` and the LP alike, and
    ///      only the Diamond's admin can cancel it (fork-checked by
    ///      scripts/fork-dispute.ts). Terminal states revert
    ///      OrderStatusInvalid() (0x181b1b2e).
    function cancelOrder(uint256 orderId) external;

    /// @notice Raises a dispute on an order. Same `order.user` gate as
    ///         `paidBuyOrder` (OrderProcessorFacet.raiseDispute).
    /// @dev Only for a BUY that was CANCELLED after being marked paid
    ///      (`paidTimestamp != 0`), 15 min to 24 h after placement.
    ///      `redactTransId` is the last 4 digits of the payer's bank transfer.
    function raiseDispute(uint256 orderId, uint256 redactTransId) external;

    /// @notice Appeals an open dispute to the next tier (DisputeFacet,
    ///         live on Base mainnet since 9 Nov 2026). `order.user` only —
    ///         anyone else reverts NotDisputeUser() (0x69ac4b4e).
    /// @dev Allowed while a tier-1/2 decision is pending and its appeal window
    ///      is open, or when the current tier missed its decision SLA. Not at
    ///      tier 3. The Base Sepolia Diamond does not have it yet.
    function appealDispute(uint256 orderId) external;

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
