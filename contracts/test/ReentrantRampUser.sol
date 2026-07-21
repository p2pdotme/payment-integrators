// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

interface IZeroXRampBuy {
    function userBuyAsset(
        address recipientAddr,
        bytes32 intentHash,
        uint256 amount,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) external returns (uint256 orderId);
}

/**
 * @title ReentrantRampUser
 * @notice Contract "user" that starts a 0xramp BUY and, when poked by a
 *         malicious diamond mid-placement (MockValidationDiamond's
 *         reentrantCaller hook), re-enters userBuyAsset with the same
 *         arguments. The inner revert data is captured so tests can assert
 *         the integrator refuses to stack a second PendingValidation while
 *         one is in flight (PendingValidationExists) — the guard that stops
 *         a hostile diamond from swapping which preparation a validateOrder
 *         callback consumes.
 */
contract ReentrantRampUser {
    IZeroXRampBuy public integrator;
    address public recipient;
    uint256 public amount;
    bytes32 public currency;

    bool public reentered;
    bytes public capturedReentryRevert;

    function buy(
        IZeroXRampBuy _integrator,
        address _recipient,
        uint256 _amount,
        bytes32 _currency
    ) external returns (uint256 orderId) {
        integrator = _integrator;
        recipient = _recipient;
        amount = _amount;
        currency = _currency;
        return integrator.userBuyAsset(_recipient, bytes32(0), _amount, _currency, 1, "pk", 0, 0);
    }

    /// @notice Called by MockValidationDiamond mid-placeB2BOrder.
    function pokeReenter() external {
        reentered = true;
        try
            integrator.userBuyAsset(recipient, bytes32(0), amount, currency, 1, "pk", 0, 0)
        returns (uint256) {
            capturedReentryRevert = "";
        } catch (bytes memory reason) {
            capturedReentryRevert = reason;
        }
    }
}
