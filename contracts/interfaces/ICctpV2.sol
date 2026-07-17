// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @title ICctpV2
 * @notice Minimal interfaces for Circle's Cross-Chain Transfer Protocol V2
 *         (https://www.circle.com/cross-chain-transfer-protocol), covering the
 *         burn side (TokenMessengerV2) and the mint side
 *         (MessageTransmitterV2).
 *
 *         Signatures mirror circlefin/evm-cctp-contracts `src/v2/`. Note that
 *         V2's `depositForBurn` returns nothing — V1 returned a uint64 nonce.
 *         V2 nonces are assigned off-chain by Circle's attestation service and
 *         surfaced in the `DepositForBurn` event, so callers that need a nonce
 *         must read the log rather than a return value.
 */
interface ITokenMessengerV2 {
    /**
     * @notice Burn `amount` of `burnToken` on this chain and authorize an
     *         equivalent mint to `mintRecipient` on `destinationDomain`.
     *
     * @dev Reverts (see `_depositForBurn`) when:
     *        - `amount == 0`                     — "Amount must be nonzero"
     *        - `mintRecipient == bytes32(0)`     — "Mint recipient must be nonzero"
     *        - `maxFee >= amount`                — "Max fee must be less than amount"
     *        - the messenger enforces a non-zero `minFee` and `maxFee` is under it
     *          — "Insufficient max fee"
     *        - `burnToken` is not a registered burnable token for the local
     *          TokenMinter (`burnLimitsPerMessage[token] == 0`)
     *      The caller must have approved the TokenMessenger for `amount` first.
     *
     * @param amount               Amount of `burnToken` to burn (micro-USDC, 6dp).
     * @param destinationDomain    CCTP domain of the destination chain
     *                             (Solana = 5, Base = 6 — same on testnet).
     * @param mintRecipient        Destination recipient as bytes32. For EVM,
     *                             `bytes32(uint256(uint160(addr)))`. For SOLANA
     *                             this MUST be the recipient's USDC *associated
     *                             token account* (ATA), not their wallet address,
     *                             and the ATA must already exist or the
     *                             destination-side `receiveMessage` reverts.
     * @param burnToken            Token to burn — must be Circle-issued USDC.
     * @param destinationCaller    Address permitted to call `receiveMessage` on
     *                             the destination, or bytes32(0) to let anyone
     *                             submit it (the normal case).
     * @param maxFee               Max fee (in `burnToken` units) the caller will
     *                             pay the attestation service. 0 is valid for a
     *                             Standard Transfer as long as the messenger's
     *                             `minFee` is 0.
     * @param minFinalityThreshold 1000 = Fast Transfer (confirmed, charges a
     *                             fee), 2000 = Standard Transfer (finalized).
     *                             Values below 1000 are treated as 1000; values
     *                             above 1000 are treated as 2000.
     */
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external;
}

interface IMessageTransmitterV2 {
    /**
     * @notice Mint the USDC authorized by a burn on the source domain.
     * @dev Permissionless when the source burn set `destinationCaller` to
     *      bytes32(0): any address may submit the message + attestation, and
     *      the USDC is minted to the `mintRecipient` encoded in the message —
     *      never to `msg.sender`. Submitting a message is therefore a delivery
     *      service, not a claim.
     */
    function receiveMessage(
        bytes calldata message,
        bytes calldata attestation
    ) external returns (bool success);
}
