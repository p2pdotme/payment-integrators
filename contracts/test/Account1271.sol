// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { SimpleAccount } from "@account-abstraction/contracts/samples/SimpleAccount.sol";
import { IEntryPoint } from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { Create2 } from "@openzeppelin/contracts/utils/Create2.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/**
 * @title Account1271
 * @notice A smart account that can also SIGN — the shape production has.
 *
 * WHY THE REFERENCE ACCOUNT IS NOT ENOUGH HERE
 * `SimpleAccount` implements ERC-4337 but not ERC-1271, so it can send
 * operations and cannot answer "is this signature mine". Hosted accounts —
 * thirdweb's included — implement both, because a smart-account wallet has to
 * be able to sign in to things.
 *
 * That gap matters for `/api/links/:linkId/wallet`. The merchant signs with the
 * key their social login controls, but the address REGISTERED as a merchant is
 * the account, not that key. Checking the signature the naive way recovers the
 * owner key and then looks up a merchant that is not there, so a real merchant
 * is refused — which is precisely what happened, and only showed up once a test
 * used a smart account instead of an EOA.
 *
 * ERC-1271 is the standard answer: ask the account whether the signature is
 * valid for it. Reference accounts cannot answer, so this fixture supplies one
 * that can, and the worker's real verification path is exercised rather than
 * approximated.
 *
 * Test fixture. Nothing here ships.
 */
contract Account1271 is SimpleAccount {
    /// @dev The ERC-1271 magic value: `bytes4(keccak256("isValidSignature(bytes32,bytes)"))`.
    bytes4 internal constant MAGIC = 0x1626ba7e;

    constructor(IEntryPoint anEntryPoint) SimpleAccount(anEntryPoint) {}

    /**
     * @notice ERC-1271. Valid when the account's owner signed the hash.
     * @dev The digest arrives already EIP-712 encoded, so it is verified as-is
     *      rather than being wrapped in the personal-message prefix — wrapping
     *      it would reject exactly the signatures this is meant to accept.
     */
    function isValidSignature(
        bytes32 hash,
        bytes calldata signature
    ) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(hash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == owner) return MAGIC;
        return 0xffffffff;
    }
}

/**
 * @title Account1271Factory
 * @notice Deploys `Account1271` at a deterministic address.
 *
 * Deliberately the same `(address owner, uint256 salt)` shape as the reference
 * factory, so `ACCOUNT_FACTORY_KIND = "simple"` addresses it correctly and the
 * worker needs no special case for the fixture.
 */
contract Account1271Factory {
    Account1271 public immutable accountImplementation;

    constructor(IEntryPoint anEntryPoint) {
        accountImplementation = new Account1271(anEntryPoint);
    }

    function createAccount(address owner, uint256 salt) public returns (Account1271) {
        address addr = getAddress(owner, salt);
        if (addr.code.length > 0) return Account1271(payable(addr));
        return
            Account1271(
                payable(
                    new ERC1967Proxy{ salt: bytes32(salt) }(
                        address(accountImplementation),
                        abi.encodeCall(SimpleAccount.initialize, (owner))
                    )
                )
            );
    }

    function getAddress(address owner, uint256 salt) public view returns (address) {
        return
            Create2.computeAddress(
                bytes32(salt),
                keccak256(
                    abi.encodePacked(
                        type(ERC1967Proxy).creationCode,
                        abi.encode(
                            address(accountImplementation),
                            abi.encodeCall(SimpleAccount.initialize, (owner))
                        )
                    )
                )
            );
    }
}
