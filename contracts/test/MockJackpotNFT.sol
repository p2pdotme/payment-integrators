// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/**
 * @title MockJackpotNFT
 * @notice Test stand-in for Megapot's JackpotTicketNFT. Owns the
 *         next-tokenId counter so multiple minters (MockMegapot,
 *         MockBatchPurchaseFacilitator, fresh redeploys of either) all
 *         draw from a single non-overlapping ID space — otherwise OZ
 *         ERC-721's `_mint` reverts with `ERC721InvalidSender(address(0))`
 *         when two minters happen to emit the same id.
 *
 *         Exposes both `_mint` (no receiver hook) and `_safeMint` paths
 *         so tests can verify the post-call sweep works regardless of
 *         which mint flow Megapot uses.
 */
contract MockJackpotNFT is ERC721 {
    uint256 public nextTokenId = 1;

    constructor() ERC721("MockJackpot", "MJP") {}

    /// @notice Mint a fresh token to `to`, returning the assigned id. The
    ///         NFT owns the counter so different minter contracts can
    ///         coexist without colliding.
    function mintNext(address to) external returns (uint256 id) {
        id = nextTokenId++;
        _mint(to, id);
    }

    function safeMintNext(address to) external returns (uint256 id) {
        id = nextTokenId++;
        _safeMint(to, id);
    }

    /// @dev Legacy explicit-id mint, kept for any existing test that pins
    ///      a specific id. Prefer `mintNext` for anything new.
    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }

    function safeMint(address to, uint256 tokenId) external {
        _safeMint(to, tokenId);
    }
}
