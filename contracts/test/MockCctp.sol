// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { ITokenMessengerV2, IMessageTransmitterV2 } from "../interfaces/ICctpV2.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IMintableBurnable {
    function mint(address to, uint256 amount) external;
}

/**
 * @title MockTokenMessengerV2
 * @notice Simulates Circle's TokenMessengerV2 burn side. Mirrors the real
 *         contract's `_depositForBurn` require ladder, and models the two ways
 *         a burn realistically fails in production:
 *
 *           - `burnLimitsPerMessage[token] == 0` — the token is not registered
 *             as burnable with the local TokenMinter. This is the case that
 *             matters on Base Sepolia, where the Diamond settles in a mock
 *             token that Circle will not burn.
 *           - `minFee > 0` and `maxFee` below it — "Insufficient max fee".
 *
 *         Burned USDC is moved to this contract rather than destroyed; tests
 *         assert on the emitted event and on the integrator's balance going to
 *         zero, so the disposal method is immaterial.
 */
contract MockTokenMessengerV2 is ITokenMessengerV2 {
    using SafeERC20 for IERC20;

    event DepositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    );

    mapping(address => uint256) public burnLimitsPerMessage;
    uint256 public minFee; // bps of amount, mirroring _calcMinFeeAmount
    bool public paused;

    function setBurnLimitPerMessage(address token, uint256 limit) external {
        burnLimitsPerMessage[token] = limit;
    }

    function setMinFee(uint256 bps) external {
        minFee = bps;
    }

    function setPaused(bool flag) external {
        paused = flag;
    }

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external override {
        require(!paused, "Pausable: paused");
        require(amount > 0, "Amount must be nonzero");
        require(mintRecipient != bytes32(0), "Mint recipient must be nonzero");
        require(maxFee < amount, "Max fee must be less than amount");
        if (minFee > 0) {
            uint256 required = (amount * minFee) / 10_000;
            if (required == 0) required = 1;
            require(maxFee >= required, "Insufficient max fee");
        }
        uint256 limit = burnLimitsPerMessage[burnToken];
        require(limit > 0, "Burn token not supported");
        require(amount <= limit, "Burn amount exceeds per tx burn limit");

        IERC20(burnToken).safeTransferFrom(msg.sender, address(this), amount);

        emit DepositForBurn(
            amount,
            destinationDomain,
            mintRecipient,
            burnToken,
            destinationCaller,
            maxFee,
            minFinalityThreshold
        );
    }
}

/**
 * @title MockMessageTransmitterV2
 * @notice Simulates the mint side. `message` is encoded as
 *         `abi.encode(mintRecipient, amount)` — enough for tests to drive a
 *         Solana -> Base delivery. Mirrors the real contract in the property
 *         that matters: the USDC is minted to the recipient named in the
 *         message, never to `msg.sender`.
 */
contract MockMessageTransmitterV2 is IMessageTransmitterV2 {
    address public immutable token;

    event MessageReceived(address mintRecipient, uint256 amount);

    constructor(address _token) {
        token = _token;
    }

    function receiveMessage(
        bytes calldata message,
        bytes calldata /* attestation */
    ) external override returns (bool) {
        (address mintRecipient, uint256 amount) = abi.decode(message, (address, uint256));
        IMintableBurnable(token).mint(mintRecipient, amount);
        emit MessageReceived(mintRecipient, amount);
        return true;
    }
}
