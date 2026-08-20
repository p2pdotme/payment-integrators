// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/**
 * @title MockGasBomb
 * @notice A reward token whose `transferFrom` burns every wei of gas it is
 *         given. Models the F5 finding: without a gas cap on the token call,
 *         the 63/64 rule lets one tenant's hostile token consume the batch's
 *         remaining gas and starve every honest row in the same transaction.
 */
contract MockGasBomb {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function decimals() external pure returns (uint8) {
        return 6;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        // Spin until out of gas. With a capped call this consumes only the
        // forwarded allowance and the caller continues; uncapped, it takes
        // the whole transaction down.
        uint256 i;
        while (true) {
            unchecked {
                i++;
            }
        }
        return true; // unreachable
    }
}
