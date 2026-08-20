// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/**
 * @title MockBadToken
 * @notice ERC-20 that misbehaves on purpose, to prove the registry's payout
 *         path degrades to a logged skip instead of reverting a batch.
 *
 *         Two failure modes:
 *           - `mode = REVERT`      — transferFrom reverts (hostile / paused token)
 *           - `mode = RETURN_FALSE`— transferFrom returns false without reverting
 *
 *         The second is the subtle one: a naive integration that ignores the
 *         boolean would mark the order paid while no tokens moved.
 */
contract MockBadToken {
    enum Mode {
        REVERT,
        RETURN_FALSE
    }

    Mode public mode;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(Mode _mode) {
        mode = _mode;
    }

    function setMode(Mode _mode) external {
        mode = _mode;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address, address, uint256) external view returns (bool) {
        if (mode == Mode.REVERT) revert("MockBadToken: nope");
        return false;
    }
}
