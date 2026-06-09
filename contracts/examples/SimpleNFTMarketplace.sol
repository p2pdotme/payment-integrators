// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title SimpleNFTMarketplace
 * @notice Example "unmodified third-party" client used to demonstrate the
 *         MarketplaceCheckoutIntegrator + UserProxy flow. It does NOT
 *         implement ICheckoutClient — the buyer is identified purely by
 *         `msg.sender` and tokens are minted to `msg.sender`.
 *
 *         When called via the integrator, `msg.sender` is the user's
 *         UserProxy clone, so NFTs land on the proxy and the user pulls
 *         them out via `UserProxy.sweepERC721`.
 */
contract SimpleNFTMarketplace is ERC721 {
    using SafeERC20 for IERC20;

    error OnlyOwner();
    error OnlyOfframpIntegrator();
    error NotTokenOwner();
    error ProductDoesNotExist();
    error InvalidQuantity();
    error InvalidAddress();

    event ProductPriceSet(uint256 indexed productId, uint256 price);
    event Bought(address indexed buyer, uint256 indexed productId, uint256 quantity, uint256 paid);
    event SoldBack(
        address indexed user,
        uint256 indexed productId,
        uint256 indexed tokenId,
        uint256 originalPrice
    );
    event OfframpIntegratorUpdated(address indexed integrator);

    IERC20 public immutable usdc;
    address public immutable owner;

    uint256 public nextTokenId = 1;
    mapping(uint256 => uint256) public productPrices;
    mapping(uint256 => uint256) public tokenProduct;
    /// @notice Price (USDC, 6 decimals) paid for the token at mint time. The
    ///         offramp integrator reads this so a sell-back honors the
    ///         original purchase price even if `productPrices` has since
    ///         changed.
    mapping(uint256 => uint256) public tokenPrice;

    /// @notice Integrator authorized to burn-on-sell-back. Must be set by
    ///         the owner before any sell-back can succeed.
    address public offrampIntegrator;

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    constructor(address _usdc, string memory name, string memory symbol) ERC721(name, symbol) {
        if (_usdc == address(0)) revert InvalidAddress();
        usdc = IERC20(_usdc);
        owner = msg.sender;
    }

    function setProductPrice(uint256 productId, uint256 price) external onlyOwner {
        productPrices[productId] = price;
        emit ProductPriceSet(productId, price);
    }

    /**
     * @notice Buy `quantity` units of `productId`. Caller must have approved
     *         USDC to this contract for `price * quantity`. NFTs are minted
     *         to `msg.sender`.
     */
    function buy(uint256 productId, uint256 quantity) external {
        if (quantity == 0) revert InvalidQuantity();
        uint256 price = productPrices[productId];
        if (price == 0) revert ProductDoesNotExist();

        uint256 total = price * quantity;
        usdc.safeTransferFrom(msg.sender, address(this), total);

        for (uint256 i = 0; i < quantity; i++) {
            uint256 tokenId = nextTokenId++;
            tokenProduct[tokenId] = productId;
            tokenPrice[tokenId] = price;
            _mint(msg.sender, tokenId);
        }

        emit Bought(msg.sender, productId, quantity, total);
    }

    function setOfframpIntegrator(address _integrator) external onlyOwner {
        offrampIntegrator = _integrator;
        emit OfframpIntegratorUpdated(_integrator);
    }

    /**
     * @notice Burn `tokenId` as part of a sell-back flow. The integrator is
     *         the only authorized caller; it has already verified that
     *         `from` owns the token, so we re-check here defensively. The
     *         caller is responsible for placing the matching sell order
     *         on the Diamond.
     */
    function sellBackEntry(uint256 tokenId, address from) external {
        if (msg.sender != offrampIntegrator) revert OnlyOfframpIntegrator();
        if (ownerOf(tokenId) != from) revert NotTokenOwner();
        uint256 productId = tokenProduct[tokenId];
        uint256 originalPrice = tokenPrice[tokenId];
        _burn(tokenId);
        emit SoldBack(from, productId, tokenId, originalPrice);
    }

    function withdrawUsdc(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert InvalidAddress();
        usdc.safeTransfer(to, amount);
    }
}
