// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { IP2PIntegrator } from "../interfaces/IP2PIntegrator.sol";

interface IUserProxyIntegratorView {
    function integrator() external view returns (address);
}

interface IUserProxyExecute {
    function execute(
        address target,
        bytes calldata data,
        address usdc,
        uint256 usdcAllowance
    ) external returns (bytes memory);
}

interface IReentrantCaller {
    function pokeReenter() external;
}

/**
 * @title MockValidationDiamond
 * @notice Lean, deliberately misbehaving Diamond used by the 0xramp V2 suite
 *         to probe the integrator's validateOrder callback binding
 *         (PendingValidation: account + amount + currency + direction) and
 *         its fail-closed defenses against a diamond that validates the wrong
 *         tuple, validates twice, or skips validation entirely.
 *
 *         Unlike MockDiamond it performs NO CREATE2 proxy re-derivation and
 *         keeps no order state — placeB2B*Order only resolves the integrator
 *         from the calling proxy, applies the configured overrides to the
 *         validateOrder call, and returns a fresh orderId. That keeps every
 *         knob orthogonal so each binding test flips exactly one dimension.
 */
contract MockValidationDiamond {
    uint256 public nextOrderId = 1;

    // ─── IP2PUserLimits ──────────────────────────────────────────────
    mapping(address => mapping(bytes32 => uint256)) public userBuyTxLimit;
    mapping(address => mapping(bytes32 => uint256)) public userSellTxLimit;
    bool public userTxLimitReverts;

    // ─── validateOrder overrides (sentinel 0 = "no override") ────────
    bool public skipValidate;
    bool public validateTwice;
    address public overrideValidateUser;
    uint256 public overrideValidateAmount;
    bytes32 public overrideValidateCurrency;

    // ─── reentrancy probes ───────────────────────────────────────────
    /// @notice When set, `_place` pokes this contract mid-placement so it can
    ///         re-enter the integrator while a PendingValidation is in flight.
    address public reentrantCaller;
    /// @notice When set, `_place` attempts to re-enter UserProxy.execute on
    ///         the calling proxy and records the revert data (expected:
    ///         the proxy's transient-storage Reentrancy() guard).
    bool public reenterProxyOnPlace;
    bytes public capturedProxyRevert;

    function setUserTxLimit(
        address user,
        bytes32 currency,
        uint256 buyLimit,
        uint256 sellLimit
    ) external {
        userBuyTxLimit[user][currency] = buyLimit;
        userSellTxLimit[user][currency] = sellLimit;
    }

    function setUserTxLimitReverts(bool v) external {
        userTxLimitReverts = v;
    }

    function setValidateOverrides(
        bool _skipValidate,
        bool _validateTwice,
        address _overrideUser,
        uint256 _overrideAmount,
        bytes32 _overrideCurrency
    ) external {
        skipValidate = _skipValidate;
        validateTwice = _validateTwice;
        overrideValidateUser = _overrideUser;
        overrideValidateAmount = _overrideAmount;
        overrideValidateCurrency = _overrideCurrency;
    }

    function setReentrancyProbes(address _reentrantCaller, bool _reenterProxyOnPlace) external {
        reentrantCaller = _reentrantCaller;
        reenterProxyOnPlace = _reenterProxyOnPlace;
    }

    function userTxLimit(
        address user,
        bytes32 currency
    ) external view returns (uint256 buyLimit, uint256 sellLimit) {
        require(!userTxLimitReverts, "limits facet unavailable");
        return (userBuyTxLimit[user][currency], userSellTxLimit[user][currency]);
    }

    // ─── B2B gateway stubs ───────────────────────────────────────────

    function placeB2BOrder(
        address user,
        uint256 amount,
        bytes32 currency,
        address /* recipientAddr */,
        string calldata /* pubKey */,
        uint256 /* circleId */,
        uint256 /* preferredPaymentChannelConfigId */,
        uint256 /* fiatAmountLimit */
    ) external returns (uint256 orderId) {
        return _place(user, amount, currency);
    }

    function placeB2BSellOrder(
        address user,
        uint256 amount,
        bytes32 currency,
        string calldata /* userPubKey */,
        uint256 /* circleId */,
        uint256 /* preferredPaymentChannelConfigId */,
        uint256 /* fiatAmountLimit */
    ) external returns (uint256 orderId) {
        return _place(user, amount, currency);
    }

    function _place(address user, uint256 amount, bytes32 currency) internal returns (uint256) {
        address integ = IUserProxyIntegratorView(msg.sender).integrator();

        if (reentrantCaller != address(0)) {
            IReentrantCaller(reentrantCaller).pokeReenter();
        }

        if (reenterProxyOnPlace) {
            try IUserProxyExecute(msg.sender).execute(address(this), "", address(0), 0) {
                capturedProxyRevert = "";
            } catch (bytes memory reason) {
                capturedProxyRevert = reason;
            }
        }

        if (!skipValidate) {
            address vUser = overrideValidateUser == address(0) ? user : overrideValidateUser;
            uint256 vAmount = overrideValidateAmount == 0 ? amount : overrideValidateAmount;
            bytes32 vCurrency = overrideValidateCurrency == bytes32(0)
                ? currency
                : overrideValidateCurrency;

            bool allowed = IP2PIntegrator(integ).validateOrder(vUser, vAmount, vCurrency);
            require(allowed, "Validation failed");

            if (validateTwice) {
                // Same-preparation double consume: must fail if the pending
                // validation is single-use.
                bool again = IP2PIntegrator(integ).validateOrder(user, amount, currency);
                require(again, "Second validation failed");
            }
        }

        return nextOrderId++;
    }

    // ─── direct callback drivers (msg.sender == this diamond) ────────

    /// @notice Calls validateOrder directly (outside any placement) so tests
    ///         can probe rejection when no PendingValidation was prepared.
    ///         Non-view because validateOrder mutates; use staticCall.
    function probeValidate(
        address integ,
        address user,
        uint256 amount,
        bytes32 currency
    ) external returns (bool allowed) {
        return IP2PIntegrator(integ).validateOrder(user, amount, currency);
    }

    function callOnOrderComplete(
        address integ,
        uint256 orderId,
        address user,
        uint256 amount,
        address recipientAddr
    ) external {
        IP2PIntegrator(integ).onOrderComplete(orderId, user, amount, recipientAddr);
    }

    /// @notice Same-transaction completion replay: the second invocation must
    ///         be a no-op on a well-behaved integrator (no double sweep, no
    ///         duplicate event).
    function callOnOrderCompleteTwice(
        address integ,
        uint256 orderId,
        address user,
        uint256 amount,
        address recipientAddr
    ) external {
        IP2PIntegrator(integ).onOrderComplete(orderId, user, amount, recipientAddr);
        IP2PIntegrator(integ).onOrderComplete(orderId, user, amount, recipientAddr);
    }

    function callOnOrderCancel(address integ, uint256 orderId) external {
        IP2PIntegrator(integ).onOrderCancel(orderId);
    }
}
