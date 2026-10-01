// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @title IOrderReader
 * @notice Read side of the Diamond's order storage (`getOrdersById`). The
 *         struct layout must match the Diamond's return value field by field
 *         for the ABI decode to line up — it mirrors MockDiamond.OrderView.
 */
interface IOrderReader {
    struct Dispute {
        uint8 raisedBy;
        uint8 status;
        uint256 redactTransId;
        uint256 accountNumber;
    }

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

    function getOrdersById(uint256 orderId) external view returns (OrderView memory);
}
