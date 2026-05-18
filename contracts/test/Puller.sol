// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title Puller
 * @notice Tiny test target that pulls ERC-20 tokens from a `from` address
 *         via `transferFrom`. Used to exercise UserProxy.execute's
 *         approve-then-reset path: the integrator forceApprove's the proxy's
 *         USDC to the Puller, the Puller pulls, then the proxy resets the
 *         allowance to zero.
 */
contract Puller {
    function pull(IERC20 token, address from, address to, uint256 amount) external {
        token.transferFrom(from, to, amount);
    }
}
