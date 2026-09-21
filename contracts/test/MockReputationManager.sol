// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { IReputationManager } from "../interfaces/IReputationManager.sol";

/**
 * @title MockReputationManager
 * @notice Settable stand-in for the p2p.me ReputationManager. `setReverts`
 *         makes every `rmusers` call revert, to exercise fail-open paths.
 */
contract MockReputationManager is IReputationManager {
    mapping(address => bool) public blacklisted;
    bool public reverts;

    function setBlacklisted(address user, bool value) external {
        blacklisted[user] = value;
    }

    function setReverts(bool value) external {
        reverts = value;
    }

    function rmusers(address user) external view returns (RmUser memory) {
        require(!reverts, "MockReputationManager: reverts");
        return RmUser({ reputationPoints: 0, voteCount: 0, isBlacklisted: blacklisted[user] });
    }
}
