// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/**
 * @title MockBalanceBomb
 * @notice A reward token whose `balanceOf` burns every wei of gas it is
 *         given, while `transferFrom` behaves normally.
 *
 *         Models the fourth-pass critical finding: capping the gas on
 *         `transferFrom` alone is not enough once the payout path also
 *         calls `balanceOf` to measure the delivered amount. Those reads
 *         are attacker code too — the tenant picks the reward token — so
 *         an uncapped call there hands over 63/64 of the batch's remaining
 *         gas and starves every honest row, which is precisely the attack
 *         the transferFrom cap was introduced to prevent.
 */
contract MockBalanceBomb {
    mapping(address => uint256) internal _balances;
    mapping(address => mapping(address => uint256)) public allowance;

    function decimals() external pure returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _balances[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    /// @dev Spins until out of gas. Under a capped staticcall this consumes
    ///      only the forwarded allowance and the caller carries on.
    function balanceOf(address) external pure returns (uint256) {
        uint256 i;
        while (true) {
            unchecked {
                i++;
            }
        }
        return i; // unreachable
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(_balances[from] >= amount, "balance");
        _balances[from] -= amount;
        _balances[to] += amount;
        return true;
    }
}
