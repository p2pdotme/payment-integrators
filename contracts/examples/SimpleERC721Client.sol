// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { ICheckoutClient } from "../interfaces/ICheckoutClient.sol";
import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title SimpleERC721Client
 * @notice Example business client that mints ERC721 tokens when users pay
 *         through the P2P checkout. Supports buying multiple units in one order.
 *
 * @dev Only the registered integrator can call onCheckoutPayment.
 *      Product prices are set by the owner. The contract receives USDC as
 *      payment and mints `quantity` NFTs to the user.
 */
contract SimpleERC721Client is ICheckoutClient, ERC721 {
    using SafeERC20 for IERC20;

    error OnlyIntegrator();
    error OnlyOwner();
    error ProductDoesNotExist();
    error InsufficientPayment();
    error InvalidQuantity();
    error InvalidAddress();

    event ProductPriceSet(uint256 indexed productId, uint256 price);
    event TokenMinted(uint256 indexed tokenId, address indexed user, uint256 indexed productId);

    address public immutable integrator;
    IERC20 public immutable usdc;
    address public immutable owner;

    uint256 public nextTokenId = 1;

    mapping(uint256 => uint256) public productPrices;
    mapping(uint256 => uint256) public tokenProduct;
    mapping(uint256 => address) public tokenBuyer;

    modifier onlyIntegrator() {
        if (msg.sender != integrator) revert OnlyIntegrator();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    constructor(
        address _integrator,
        address _usdc,
        string memory name,
        string memory symbol
    ) ERC721(name, symbol) {
        if (_integrator == address(0) || _usdc == address(0)) revert InvalidAddress();
        integrator = _integrator;
        usdc = IERC20(_usdc);
        owner = msg.sender;
    }

    // ─── Admin ────────────────────────────────────────────────────────

    function setProductPrice(uint256 productId, uint256 price) external onlyOwner {
        productPrices[productId] = price;
        emit ProductPriceSet(productId, price);
    }

    // ─── ICheckoutClient ──────────────────────────────────────────────

    /**
     * @notice Called by the integrator when checkout payment is received.
     *         Mints `quantity` NFTs to the user.
     */
    function onCheckoutPayment(
        address user,
        uint256 usdcAmount,
        uint256 productId,
        uint256 quantity
    ) external onlyIntegrator {
        if (quantity == 0) revert InvalidQuantity();
        uint256 price = productPrices[productId];
        if (price == 0) revert ProductDoesNotExist();
        if (usdcAmount < price * quantity) revert InsufficientPayment();

        for (uint256 i = 0; i < quantity; i++) {
            uint256 tokenId = nextTokenId++;
            tokenProduct[tokenId] = productId;
            tokenBuyer[tokenId] = user;
            _mint(user, tokenId);
            emit TokenMinted(tokenId, user, productId);
        }
    }

    function getProductPrice(uint256 productId) external view returns (uint256) {
        return productPrices[productId];
    }

    // ─── USDC Management ──────────────────────────────────────────────

    function withdrawUsdc(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert InvalidAddress();
        usdc.safeTransfer(to, amount);
    }
}
