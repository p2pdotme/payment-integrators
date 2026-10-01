// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @title IFiatTokenBlacklist
 * @notice The blacklist getter of Circle's FiatToken (USDC). Not part of
 *         ERC-20: the integrator calls it with a `staticcall` and treats a
 *         token without it (the Base Sepolia mock) as having no blacklist.
 */
interface IFiatTokenBlacklist {
    function isBlacklisted(address account) external view returns (bool);
}
