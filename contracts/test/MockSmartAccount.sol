// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/**
 * @notice Minimal contract-account caller used to exercise the Zapp ERC-4337
 *         integration shape. It is not an ERC-4337 implementation.
 */
contract MockSmartAccount {
    error OnlyOwner();

    address public immutable owner;

    constructor(address _owner) {
        owner = _owner;
    }

    function execute(address target, bytes calldata data) external returns (bytes memory result) {
        if (msg.sender != owner) revert OnlyOwner();
        (bool success, bytes memory returned) = target.call(data);
        if (!success) {
            assembly {
                revert(add(returned, 32), mload(returned))
            }
        }
        return returned;
    }
}
