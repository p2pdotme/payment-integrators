// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { ERC1155 } from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

/// @title MockERC1155
/// @notice Test stand-in for arbitrary ERC-1155 tokens. Used by UserProxy
///         tests to exercise the ERC-1155 receiver hook and the `sweepERC1155`
///         user-escape-hatch path.
contract MockERC1155 is ERC1155 {
    constructor() ERC1155("https://mock/{id}") {}

    function mint(address to, uint256 id, uint256 amount) external {
        _mint(to, id, amount, "");
    }
}
