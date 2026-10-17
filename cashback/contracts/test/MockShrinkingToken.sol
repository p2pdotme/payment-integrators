// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/**
 * @title MockShrinkingToken
 * @notice A token whose `transferFrom` leaves the recipient's balance LOWER
 *         than before — a negative rebase, or simply a hostile token.
 *
 *         Models the fourth-pass high finding: measuring delivery as
 *         `balanceAfter - balanceBefore` with checked arithmetic panics
 *         here. Through `payBatch` that costs one row; called directly it
 *         reverts outright, and because the revert unwinds `orderPaid` the
 *         row then fails identically forever — a permanent poison pill.
 *         A saturating subtraction routes it into the graceful rollback.
 */
contract MockShrinkingToken {
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

    /// @dev Reports success, but shrinks the recipient rather than crediting.
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        // The recipient LOSES balance instead of gaining it.
        balanceOf[to] = balanceOf[to] / 2;
        return true;
    }
}
