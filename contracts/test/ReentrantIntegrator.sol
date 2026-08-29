// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { IMerchantTerminalLinks } from "../interfaces/IMerchantTerminalLinks.sol";

interface ILinkRouterReentry {
    function place(
        bytes32 linkId,
        address client,
        uint256 productId,
        uint256 quantity,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        address customer
    ) external returns (uint256);

    function markPaid(bytes32 linkId, uint256 orderId, bytes calldata signature) external;
}

/**
 * @title ReentrantIntegrator
 * @notice A hostile integrator, for proving the Router's reentrancy guard.
 *
 * WHY THIS IS WORTH TESTING RATHER THAN ASSUMING
 * `place` cannot follow checks-effects-interactions: the orderId it must record
 * only exists after the external call returns, so the write happens last. That
 * is exactly the shape reentrancy exploits. The guard is what makes it safe,
 * and a guard nobody has seen fire is a guard nobody knows works.
 *
 * A real integrator would not do this. But the Router is deployed against ONE
 * integrator address forever, and "our integrator is honest" is an assumption
 * worth not depending on — a future facet, an upgrade, or a mistake in the
 * Diamond's callback ordering could re-enter without anyone intending it.
 *
 * Test fixture. Nothing here ships.
 */
contract ReentrantIntegrator is IMerchantTerminalLinks {
    ILinkRouterReentry public router;
    address public linkOwner;
    bool public attackOnPlace;
    bool public attackOnMarkPaid;

    /// @dev Records what the re-entrant call did, so a test can assert the
    ///      guard fired rather than the call quietly succeeding.
    bool public reentryReverted;
    uint256 public nextOrderId = 1;

    function setRouter(address r) external {
        router = ILinkRouterReentry(r);
    }

    function setLinkOwner(address o) external {
        linkOwner = o;
    }

    function setAttack(bool onPlace, bool onMarkPaid) external {
        attackOnPlace = onPlace;
        attackOnMarkPaid = onMarkPaid;
    }

    function relayerPlaceOrder(
        bytes32 linkId,
        address client,
        uint256 productId,
        uint256 quantity,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey
    ) external returns (uint256 orderId) {
        if (attackOnPlace) {
            // Re-enter while the Router is mid-`place`, before it has recorded
            // the order. Catching rather than bubbling lets the test see that
            // the guard fired, instead of the whole transaction reverting for
            // an ambiguous reason.
            try
                router.place(
                    linkId,
                    client,
                    productId,
                    quantity,
                    currency,
                    circleId,
                    pubKey,
                    msg.sender
                )
            returns (uint256) {
                reentryReverted = false;
            } catch {
                reentryReverted = true;
            }
        }
        return nextOrderId++;
    }

    function relayerMarkPaid(bytes32 linkId, uint256 orderId) external {
        if (attackOnMarkPaid) {
            try router.markPaid(linkId, orderId, hex"00") {
                reentryReverted = false;
            } catch {
                reentryReverted = true;
            }
        }
    }

    /// @dev Intentionally does nothing. The interface requires it, and the
    ///      cancel path re-enters through `relayerMarkPaid` above.
    // solhint-disable-next-line no-empty-blocks
    function relayerCancelOrder(bytes32, uint256) external {}

    function getLink(
        bytes32
    ) external view returns (address, uint96, bytes32, uint64, uint32, uint8, uint32, uint16) {
        return (linkOwner, 0, bytes32(0), 0, 0, 0, 0, 0);
    }
}
