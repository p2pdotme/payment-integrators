// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockToken18
 * @notice An 18-decimal reward token. Proves that percentage rewards are
 *         rescaled from the order's 6-decimal USDC units into the reward
 *         token's own units — without which 1% of a $1,000 order would pay
 *         0.00000000001 tokens (audit F9).
 */
contract MockToken18 is ERC20 {
    constructor() ERC20("Points", "PTS") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
