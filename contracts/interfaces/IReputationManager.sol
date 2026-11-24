// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @title IReputationManager
 * @notice The part of p2p.me's ReputationManager that holds its user
 *         blacklist: the same record the Diamond reads before a consumer BUY
 *         (contracts-v4 `libOrderProcessorFacet.isUserBlacklisted`).
 */
interface IReputationManager {
    struct RmUser {
        uint256 reputationPoints;
        uint256 voteCount;
        bool isBlacklisted;
    }

    function rmusers(address user) external view returns (RmUser memory);
}

/// @notice The Diamond's getter for its ReputationManager (GetterFacet).
///         Routed on the Base mainnet Diamond; not on Base Sepolia's.
interface IReputationManagerGetter {
    function getReputationManager() external view returns (address);
}
