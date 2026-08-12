// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { IOrderFlow } from "../interfaces/IOrderFlow.sol";

/**
 * @title MockOrderSource
 * @notice Stands in for the P2P Diamond's `getOrdersById` in tests. Only the
 *         fields `CashbackRegistry._verifyOrder` reads are meaningful — id,
 *         status, user, amount — the rest are zero-filled so the ABI tuple
 *         still decodes.
 *
 *         Status values mirror the Diamond: 0=PLACED 1=ACCEPTED 2=PAID
 *         3=COMPLETED 4=CANCELLED.
 */
contract MockOrderSource {
    struct Stored {
        uint256 amount;
        address user;
        uint8 status;
        bool exists;
    }

    mapping(uint256 => Stored) public orders;

    /// @notice When true, `getOrdersById` reverts — used to prove the
    ///         registry fails closed on an unreachable Diamond.
    bool public reverting;

    function setOrder(uint256 orderId, address user, uint256 amount, uint8 status) external {
        orders[orderId] = Stored({ amount: amount, user: user, status: status, exists: true });
    }

    function setReverting(bool flag) external {
        reverting = flag;
    }

    function getOrdersById(uint256 orderId) external view returns (IOrderFlow.OrderView memory o) {
        require(!reverting, "MockOrderSource: down");

        Stored memory s = orders[orderId];
        // An unknown order returns an all-zero record, so `order.id != orderId`
        // in the registry rejects it exactly as a real absent record would.
        if (!s.exists) return o;

        o.id = orderId;
        o.amount = s.amount;
        o.user = s.user;
        o.status = s.status;
        o.orderType = 0; // BUY
        return o;
    }
}
