// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IMintableERC20 {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
}

/**
 * @title MockAavePool
 * @notice Test stand-in for Aave V3's Pool. Holds USDC, mints/burns aUSDC
 *         1:1 with deposits/withdrawals. Optional `accrueYield` helper
 *         lets tests simulate yield by minting extra aUSDC.
 */
contract MockAavePool {
    using SafeERC20 for IERC20;

    function supply(
        address asset,
        uint256 amount,
        address onBehalfOf,
        uint16 /* referralCode */
    ) external {
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        IMintableERC20(_aTokenForAsset(asset)).mint(onBehalfOf, amount);
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        IMintableERC20(_aTokenForAsset(asset)).burn(msg.sender, amount);
        IERC20(asset).safeTransfer(to, amount);
        return amount;
    }

    /// @notice Test-only. Mints aUSDC to a holder without supplying USDC,
    ///         simulating accrued yield. Holder can withdraw it normally.
    function accrueYield(
        address aToken,
        address holder,
        uint256 amount,
        address backingAsset
    ) external {
        IMintableERC20(aToken).mint(holder, amount);
        // The pool needs the underlying asset on hand to honour withdrawals
        // up to its aToken supply. Tests fund this contract directly with
        // backing USDC before calling accrueYield.
        require(
            IERC20(backingAsset).balanceOf(address(this)) >= amount,
            "Mock: insufficient backing"
        );
    }

    /// @dev In a real Aave deployment the pool reads aTokens from a registry.
    ///      For the mock the test sets the mapping directly.
    address public aTokenForUsdc;
    address public configuredUsdc;

    function configure(address usdc, address aToken) external {
        configuredUsdc = usdc;
        aTokenForUsdc = aToken;
    }

    function _aTokenForAsset(address asset) internal view returns (address) {
        require(asset == configuredUsdc, "Mock: asset not configured");
        return aTokenForUsdc;
    }
}
