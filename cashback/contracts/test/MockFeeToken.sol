// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/**
 * @title MockFeeToken
 * @notice A fee-on-transfer ERC-20: the recipient receives less than the
 *         amount requested. Models the counter-desync finding — crediting
 *         the *requested* amount to the budget counters exhausts a campaign
 *         at up to 2x the tokens users actually received, so the campaign
 *         stops paying while its wallet still holds funds.
 */
contract MockFeeToken {
    uint256 public feeBps; // e.g. 5000 = 50%

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(uint256 _feeBps) {
        feeBps = _feeBps;
    }

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

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        uint256 fee = (amount * feeBps) / 10_000;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee; // the fee is burned
        return true;
    }
}
