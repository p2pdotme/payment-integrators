// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IBlioIntegratorReentry {
    function validateOrder(
        address user,
        uint256 amount,
        bytes32 currency
    ) external returns (bool allowed);

    function userPlaceOrder(
        uint256 productId,
        uint256 quantity,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) external returns (uint256 orderId);
}

/**
 * @title ReentrantBlioDiamond
 * @notice Fixture hostil: al colocar, re-entra en `userPlaceOrder` del
 *         integrador. Sirve para comprobar que el `nonReentrant` de la
 *         colocación dispara. Nada de esto se despliega.
 */
contract ReentrantBlioDiamond {
    error ValidationFailed();

    address public integrator;
    bool public attack;
    uint256 public nextOrderId = 1;

    bool public reentryAttempted;
    bool public reentrySucceeded;
    bytes4 public reentryError;

    function configure(address _integrator, bool _attack) external {
        integrator = _integrator;
        attack = _attack;
    }

    function placeB2BOrder(
        address user,
        uint256 amount,
        bytes32 currency,
        address,
        string calldata,
        uint256,
        uint256,
        uint256
    ) external returns (uint256 orderId) {
        bool allowed = IBlioIntegratorReentry(integrator).validateOrder(user, amount, currency);
        if (!allowed) revert ValidationFailed();
        if (attack) {
            reentryAttempted = true;
            try
                IBlioIntegratorReentry(integrator).userPlaceOrder(1, 1, currency, 1, "", 0, 0)
            returns (uint256) {
                reentrySucceeded = true;
            } catch (bytes memory reason) {
                if (reason.length >= 4) {
                    bytes4 selector;
                    assembly {
                        selector := mload(add(reason, 0x20))
                    }
                    reentryError = selector;
                }
            }
        }

        orderId = nextOrderId++;
    }
}
