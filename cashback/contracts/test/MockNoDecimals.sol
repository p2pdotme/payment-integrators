// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/**
 * @title MockNoDecimals
 * @notice A minimal ERC-20 that does NOT expose `decimals()`. The registry
 *         must fall back to assuming 6dp (1:1 with the order amount) rather
 *         than reverting — the conservative choice, since it under-pays
 *         rather than over-pays if the assumption is wrong.
 */
contract MockNoDecimals {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
