// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/**
 * @title MockNoReturnToken
 * @notice A USDT-style ERC-20 whose `transferFrom` moves the tokens but
 *         returns NO data. Non-compliant with the ERC-20 return convention,
 *         yet common enough that OpenZeppelin's SafeERC20 exists precisely
 *         to accommodate it.
 *
 *         This is the shape that broke the audit's F5 rollback: the call
 *         SUCCEEDS and the balance moves, but a caller checking
 *         `returndata.length == 32` reads it as a failure. If that caller
 *         then rolls back its replay guard, the same order can be paid
 *         again — and again — with the budget counters never incrementing.
 */
contract MockNoReturnToken {
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

    /// @dev Deliberately returns nothing — note the absence of a return type.
    function transferFrom(address from, address to, uint256 amount) external {
        require(balanceOf[from] >= amount, "balance");
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}
