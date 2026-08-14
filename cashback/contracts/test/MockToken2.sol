// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockToken2
 * @notice A 2-decimal reward token — fewer decimals than the 6dp USDC the
 *         order is denominated in, exercising the scale-DOWN branch of the
 *         reward calculation.
 */
contract MockToken2 is ERC20 {
    constructor() ERC20("TwoDec", "TWO") {}

    function decimals() public pure override returns (uint8) {
        return 2;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
