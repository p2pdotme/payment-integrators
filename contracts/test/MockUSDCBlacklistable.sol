// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { MockUSDC } from "./MockUSDC.sol";

/**
 * @title MockUSDCBlacklistable
 * @notice MockUSDC + a blacklist, mirroring real Circle USDC (FiatTokenV2:
 *         `blacklist` / `unBlacklist` / `isBlacklisted`, and transfer /
 *         transferFrom revert to or from a blacklisted address). The
 *         integrator calls `isBlacklisted` on every order, so every stack in
 *         the tests uses this token (or a subclass).
 */
contract MockUSDCBlacklistable is MockUSDC {
    mapping(address => bool) private _blacklisted;

    function isBlacklisted(address account) external view returns (bool) {
        return _blacklisted[account];
    }

    function blacklist(address account) external {
        _blacklisted[account] = true;
    }

    function unBlacklist(address account) external {
        _blacklisted[account] = false;
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        require(!_blacklisted[from], "Blacklistable: sender is blacklisted");
        require(!_blacklisted[to], "Blacklistable: recipient is blacklisted");
        super._update(from, to, value);
    }
}
