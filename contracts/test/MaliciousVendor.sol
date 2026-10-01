// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

interface IReleasable {
    function release(uint256[] calldata orderIds) external;
}

/**
 * @title MaliciousVendor
 * @notice Test-only attacker: a vendor contract with a hostile `receive()`
 *         that tries to re-enter `release` on its own VendorEscrow mid-payout.
 *         Only reachable in tests wired against MockUSDCHooked (see that
 *         file for why real USDC gives no such opening) — this is a
 *         defense-in-depth check on the `nonReentrant` guard, not a live
 *         threat model against Circle's actual token.
 */
contract MaliciousVendor {
    IReleasable public escrow;
    uint256[] private reenterOrderIds;
    bool public armed;
    bool public reentered;
    bool public reentrantCallReverted;

    function arm(address _escrow, uint256[] calldata orderIds) external {
        escrow = IReleasable(_escrow);
        delete reenterOrderIds;
        for (uint256 i = 0; i < orderIds.length; i++) {
            reenterOrderIds.push(orderIds[i]);
        }
        armed = true;
        reentered = false;
        reentrantCallReverted = false;
    }

    receive() external payable {
        if (armed && !reentered) {
            reentered = true;
            armed = false; // one attempt only, avoid unbounded recursion
            try escrow.release(reenterOrderIds) {
                reentrantCallReverted = false;
            } catch {
                reentrantCallReverted = true;
            }
        }
    }
}
