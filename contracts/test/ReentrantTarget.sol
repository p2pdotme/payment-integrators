// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { TestIntegratorShim } from "./TestIntegratorShim.sol";

/**
 * @title ReentrantTarget
 * @notice Execute target that re-enters UserProxy.execute via the shim.
 *         Used to verify the proxy's transient-storage `nonReentrant`
 *         modifier rejects nested execute calls in the same tx.
 */
contract ReentrantTarget {
    TestIntegratorShim public shim;
    address public proxy;
    address public usdc;

    function arm(TestIntegratorShim _shim, address _proxy, address _usdc) external {
        shim = _shim;
        proxy = _proxy;
        usdc = _usdc;
    }

    /// @notice When called, re-enters proxy.execute through the shim.
    ///         Expected to revert with Reentrancy inside the proxy.
    function reenter() external {
        shim.callExecute(proxy, address(this), abi.encodeWithSignature("nop()"), usdc, 0);
    }

    function nop() external {}
}
