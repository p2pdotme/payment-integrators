// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { MockUSDC } from "./MockUSDC.sol";

interface IRetryBridge {
    function retryBridge(uint256 orderId) external;
}

/**
 * @title MockReentrantUSDC
 * @notice Malicious burn token for the CEI regression test on
 *         ShowdownCheckoutIntegrator._bridge. When armed, the first
 *         `transferFrom` (i.e. the TokenMessenger pulling the burn amount,
 *         mid-`depositForBurn`) re-enters `retryBridge(orderId)` on the
 *         integrator and records whether the reentrant call succeeded.
 *
 *         With checks-effects-interactions in `_bridge` (bridged = true set
 *         BEFORE the burn), the reentrant call must revert `AlreadyBridged`.
 *         If the effects ever move back below the burn, the reentrant call
 *         succeeds and burns the same session twice — `reentrySucceeded`
 *         flips true and the test fails. This is the mutation the plain
 *         suite could not see (no other mock re-enters).
 */
contract MockReentrantUSDC is MockUSDC {
    address public target;
    uint256 public targetOrderId;
    bool public armed;
    bool public inCall;
    bool public reentryAttempted;
    bool public reentrySucceeded;

    function armReentrancy(address _target, uint256 _orderId) external {
        target = _target;
        targetOrderId = _orderId;
        armed = true;
        reentryAttempted = false;
        reentrySucceeded = false;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (armed && !inCall) {
            armed = false;
            inCall = true;
            reentryAttempted = true;
            try IRetryBridge(target).retryBridge(targetOrderId) {
                reentrySucceeded = true;
            } catch {
                reentrySucceeded = false;
            }
            inCall = false;
        }
        return super.transferFrom(from, to, amount);
    }
}
