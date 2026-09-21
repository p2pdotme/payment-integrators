// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @title IReputationManager
 * @notice The slice of the p2p.me ReputationManager that integrators read.
 *         The Diamond checks `rmusers(user).isBlacklisted` on consumer BUY
 *         orders but skips it on B2B orders, leaving the check to the
 *         integrator's `validateOrder`.
 */
interface IReputationManager {
    struct RmUser {
        uint256 reputationPoints;
        uint256 voteCount;
        bool isBlacklisted;
    }

    function rmusers(address user) external view returns (RmUser memory);
}
