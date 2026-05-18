// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { UserProxy } from "../base/UserProxy.sol";

/**
 * @title TestIntegratorShim
 * @notice Minimal integrator-shaped contract for testing UserProxy in
 *         isolation. Exposes the integrator-only entry points to UserProxy
 *         (`execute`, `transferERC20ToIntegrator`) so unit tests can drive
 *         them without standing up a full integrator + order flow.
 *
 *         Also exposes a `usdc()` getter so UserProxy's
 *         `IUsdcSource(integrator()).usdc()` lookup resolves correctly.
 */
contract TestIntegratorShim {
    IERC20 public immutable usdc;
    address public immutable proxyImpl;

    constructor(IERC20 _usdc) {
        usdc = _usdc;
        proxyImpl = address(new UserProxy());
    }

    function deployProxy(address user) external returns (address) {
        bytes memory args = abi.encodePacked(user, address(this));
        bytes32 salt = bytes32(uint256(uint160(user)));
        return Clones.cloneDeterministicWithImmutableArgs(proxyImpl, args, salt);
    }

    function proxyAddress(address user) external view returns (address) {
        bytes memory args = abi.encodePacked(user, address(this));
        bytes32 salt = bytes32(uint256(uint160(user)));
        return
            Clones.predictDeterministicAddressWithImmutableArgs(
                proxyImpl,
                args,
                salt,
                address(this)
            );
    }

    function callExecute(
        address proxy,
        address target,
        bytes calldata data,
        address usdcAddr,
        uint256 allowance
    ) external returns (bytes memory) {
        return UserProxy(proxy).execute(target, data, usdcAddr, allowance);
    }

    function callTransferERC20ToIntegrator(address proxy, address token, uint256 amount) external {
        UserProxy(proxy).transferERC20ToIntegrator(token, amount);
    }
}
