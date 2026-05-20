// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

contract MockV2Cloner {
    event Cloned(address indexed clone);

    function clone(
        address impl,
        address owner,
        address integrator,
        bytes32 salt
    ) external returns (address) {
        bytes memory args = abi.encodePacked(owner, integrator);
        address c = Clones.cloneDeterministicWithImmutableArgs(impl, args, salt);
        emit Cloned(c);
        return c;
    }
}
