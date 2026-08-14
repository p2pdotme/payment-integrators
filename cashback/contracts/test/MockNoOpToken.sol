// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/**
 * @title MockNoOpToken
 * @notice A contract that looks like an ERC-20 — it has `decimals()` — but
 *         whose `transferFrom` moves nothing and returns nothing.
 *
 *         This is the phantom-payout shape. Because empty returndata counts
 *         as success (the SafeERC20 rule, required for USDT-style tokens),
 *         a naive payout path would emit `Paid`, mark the order paid, and
 *         inflate the campaign's totals while no tokens ever moved — burning
 *         that order's one payout slot forever, so no later honest campaign
 *         could ever pay it.
 */
contract MockNoOpToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function decimals() external pure returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    /// @dev Does nothing at all, and returns nothing.
    function transferFrom(address, address, uint256) external {}
}
