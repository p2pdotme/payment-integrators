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
        uint8 orderType;
        bytes32 currency;
        address integrator;
        uint256 placedAt;
        bool exists;
    }

    mapping(uint256 => Stored) public orders;

    /// @notice When true, `getOrdersById` reverts — used to prove the
    ///         registry fails closed on an unreachable Diamond.
    bool public reverting;

    /// @notice Convenience overload: BUY, no integrator binding, placed now.
    function setOrder(uint256 orderId, address user, uint256 amount, uint8 status) external {
        orders[orderId] = Stored({
            amount: amount,
            user: user,
            status: status,
            orderType: 0,
            currency: bytes32("INR"),
            integrator: address(0),
            placedAt: block.timestamp,
            exists: true
        });
    }

    /// @notice Full form, mirroring what the real Diamond records.
    function setOrderFull(
        uint256 orderId,
        address user,
        uint256 amount,
        uint8 status,
        uint8 orderType,
        address integrator,
        uint256 placedAt
    ) external {
        _set(orderId, user, amount, status, orderType, bytes32("INR"), integrator, placedAt);
    }

    /// @notice Full form including the order currency.
    function setOrderWithCurrency(
        uint256 orderId,
        address user,
        uint256 amount,
        uint8 status,
        uint8 orderType,
        bytes32 currency,
        address integrator,
        uint256 placedAt
    ) external {
        _set(orderId, user, amount, status, orderType, currency, integrator, placedAt);
    }

    function _set(
        uint256 orderId,
        address user,
        uint256 amount,
        uint8 status,
        uint8 orderType,
        bytes32 currency,
        address integrator,
        uint256 placedAt
    ) internal {
        orders[orderId] = Stored({
            amount: amount,
            user: user,
            status: status,
            orderType: orderType,
            currency: currency,
            integrator: integrator,
            placedAt: placedAt == 0 ? block.timestamp : placedAt,
            exists: true
        });
    }

    /// @notice Mirrors the Diamond's order -> integrator binding
    ///         (selector 0xc0bc0d14, live on Base mainnet and Sepolia).
    ///         Returns address(0) for an organic, non-B2B order.
    function getOrderIntegrator(uint256 orderId) external view returns (address) {
        require(!reverting, "MockOrderSource: down");
        return orders[orderId].integrator;
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
        o.orderType = s.orderType;
        o.currency = s.currency;
        o.placedTimestamp = s.placedAt;
        return o;
    }
}
