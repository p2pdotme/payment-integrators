// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/**
 * @title IMarketplaceClient
 * @notice Subset of a marketplace client (e.g. SimpleNFTMarketplace) that
 *         the offramp section of MarketplaceCheckoutIntegrator needs to
 *         read at sell-back time and call to burn the token.
 *
 *         A client opts into offramp by exposing this interface and
 *         setting `offrampIntegrator` to the integrator's address.
 */
interface IMarketplaceClient {
    /// @notice Original USDC price paid for `tokenId` at mint time.
    function tokenPrice(uint256 tokenId) external view returns (uint256);

    /// @notice Product ID associated with `tokenId`.
    function tokenProduct(uint256 tokenId) external view returns (uint256);

    /// @notice ERC-721 owner lookup. Reverts on nonexistent tokens.
    function ownerOf(uint256 tokenId) external view returns (address);

    /// @notice Burn `tokenId`. Caller is the integrator; client verifies
    ///         msg.sender is its registered offramp integrator and that
    ///         `from` is the current owner.
    function sellBackEntry(uint256 tokenId, address from) external;
}
