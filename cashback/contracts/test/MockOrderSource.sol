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

    /**
     * @notice The Diamond's own B2B placement event, which is how the watcher
     *         DISCOVERS orders in the first place.
     *
     *         Deliberately not emitted by the `setOrder*` helpers: those write
     *         a record directly, which is the right shape for a contract test
     *         that wants an order to exist without a discovery step. The full
     *         end-to-end run needs the event too, because the watcher's cursor
     *         is driven by `queryFilter` over it — so it gets its own function
     *         rather than changing what every existing test emits.
     */
    event B2BOrderPlaced(
        uint256 indexed orderId,
        address indexed integrator,
        address indexed user,
        uint256 amount
    );

    /**
     * @notice Record an order as PLACED and announce it, exactly as the
     *         Diamond does. The end-to-end suite drives the real watcher
     *         through this, so the discovery leg — `queryFilter`, the block
     *         cursor, the pending set — is exercised rather than assumed.
     */
    function placeB2BOrder(
        uint256 orderId,
        address user,
        uint256 amount,
        uint8 orderType,
        bytes32 currency,
        address integrator
    ) external {
        orders[orderId] = Stored({
            amount: amount,
            user: user,
            status: 0, // PLACED — completion is a separate step, as on-chain
            orderType: orderType,
            currency: currency,
            integrator: integrator,
            placedAt: block.timestamp,
            exists: true
        });
        emit B2BOrderPlaced(orderId, integrator, user, amount);
    }

    /// @notice Advance an existing order's status, leaving every other field
    ///         untouched — the completion leg of the flow above.
    function setStatus(uint256 orderId, uint8 status) external {
        require(orders[orderId].exists, "unknown order");
        orders[orderId].status = status;
    }

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
