// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ICheckoutClient
 * @notice Interface that business client contracts must implement to receive
 *         checkout payments and deliver products.
 */
interface ICheckoutClient {
    /// @notice Called by the integrator when a checkout order completes.
    ///         The client receives USDC and should deliver `quantity` units of the product.
    /// @param user The end-user who paid
    /// @param usdcAmount Total USDC received (6 decimals, = unitPrice × quantity)
    /// @param productId The product being purchased
    /// @param quantity Number of units to deliver
    function onCheckoutPayment(
        address user,
        uint256 usdcAmount,
        uint256 productId,
        uint256 quantity
    ) external;

    /// @notice Returns the USDC unit price for a product.
    /// @param productId The product ID
    /// @return price USDC amount per unit (6 decimals), 0 if product doesn't exist
    function getProductPrice(uint256 productId) external view returns (uint256 price);
}
