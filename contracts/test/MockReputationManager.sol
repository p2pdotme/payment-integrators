// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @title MockReputationManager
 * @notice Stands in for contracts-v4's ReputationManager, for the USER
 *         blacklist only.
 *
 *         The shape being mocked is the getter Solidity generates for
 *         `mapping(address => IReputationManager.RmUser) public rmusers`
 *         (RpStorage.sol:84), where RmUser is
 *         `{ uint256 reputationPoints; uint256 voteCount; bool isBlacklisted; }`.
 *         The MEMBER ORDER is the ABI, so this mock deliberately carries all
 *         three values rather than just the flag: a consumer that slipped a
 *         slot would read reputationPoints as the blacklist and pass this mock
 *         only if the other members were zero.
 *
 *         Not a substitute for asserting against the deployed contract — a
 *         member inserted ahead of `isBlacklisted` upstream would shift the
 *         decode and this mock would happily keep agreeing with the old
 *         layout.
 */
contract MockReputationManager {
    struct RmUser {
        uint256 reputationPoints;
        uint256 voteCount;
        bool isBlacklisted;
    }

    mapping(address => RmUser) public rmusers;

    function setBlacklisted(address user, bool flag) external {
        rmusers[user].isBlacklisted = flag;
    }

    function setUser(address user, uint256 rp, uint256 votes, bool flag) external {
        rmusers[user] = RmUser(rp, votes, flag);
    }
}
