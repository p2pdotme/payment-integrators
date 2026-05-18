// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { IP2PIntegrator } from "../contracts/interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../contracts/interfaces/IB2BGateway.sol";
import { ICheckoutClient } from "../contracts/interfaces/ICheckoutClient.sol";
import { UserProxy } from "../contracts/base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

/**
 * @title MyIntegrator
 * @notice STARTER TEMPLATE — copy this file into
 *         contracts/integrators/<your-name>/ and start customising.
 *
 *         Read docs/ARCHITECTURE.md and docs/PROXY-PATTERN.md first.
 *
 *         What you MUST implement (IP2PIntegrator):
 *           - validateOrder(user, amount, currency) — enforce your per-tx
 *             and daily limits here. Reverting blocks the order.
 *           - onOrderComplete(orderId, user, amount, recipientAddr) — called
 *             by the Diamond when fiat settles. Route USDC to your client
 *             and trigger delivery.
 *           - onOrderCancel(orderId) — release the daily-count debit you
 *             consumed in validateOrder.
 *
 *         What you MUST NOT do:
 *           - Fork UserProxy. Use the canonical one at contracts/base/UserProxy.sol.
 *           - Add upgradeability (proxy / delegatecall-to-impl).
 *           - Skip onOrderCancel; cancelled orders must not burn daily slots.
 *           - Use plain `transfer` for USDC. Use SafeERC20.
 */
contract MyIntegrator is IP2PIntegrator {
    using SafeERC20 for IERC20;

    // ─── Errors ───────────────────────────────────────────────────────
    error OnlyDiamond();
    error OnlyOwner();
    error InvalidAddress();
    // TODO: add integrator-specific errors

    // ─── Events ───────────────────────────────────────────────────────
    event OrderPlaced(uint256 indexed orderId, address indexed user, uint256 amount);
    event OrderCompleted(uint256 indexed orderId, address indexed user, uint256 amount);
    // TODO: add events for state-changing functions

    // ─── Immutables ───────────────────────────────────────────────────
    address public immutable diamond;
    IERC20 public immutable usdc;
    address public immutable proxyImpl;
    address public immutable owner;

    // ─── State ────────────────────────────────────────────────────────
    // TODO: per-user RP, daily counters, registered clients, etc.

    // ─── Constructor ──────────────────────────────────────────────────
    constructor(address _diamond, address _usdc, address _owner) {
        if (_diamond == address(0) || _usdc == address(0) || _owner == address(0)) {
            revert InvalidAddress();
        }
        diamond = _diamond;
        usdc = IERC20(_usdc);
        owner = _owner;
        // Deploy the canonical UserProxy implementation. The Diamond will
        // pin this address at registerIntegrator time and use it to verify
        // CREATE2-derived per-user proxy addresses.
        proxyImpl = address(new UserProxy());
    }

    // ─── IP2PIntegrator ───────────────────────────────────────────────
    function validateOrder(
        address /*user*/,
        uint256 /*amount*/,
        bytes32 /*currency*/
    ) external returns (bool allowed) {
        // TODO: enforce per-tx + daily-count limits.
        // Return false (or revert with a specific error) to block.
        return true;
    }

    function onOrderComplete(
        uint256 /*orderId*/,
        address /*user*/,
        uint256 /*amount*/,
        address /*recipientAddr*/
    ) external {
        if (msg.sender != diamond) revert OnlyDiamond();
        // TODO: route USDC to your business client, trigger product delivery.
    }

    function onOrderCancel(uint256 /*orderId*/) external {
        if (msg.sender != diamond) revert OnlyDiamond();
        // TODO: reverse the daily-count debit (best-effort; tolerate
        // unknown orderId or repeated cancellation).
    }

    // ─── Order entry point (called by your frontend / SDK) ────────────
    function userPlaceOrder(
        address /*client*/,
        uint256 /*productId*/,
        uint256 /*quantity*/,
        bytes32 /*currency*/,
        uint256 /*circleId*/,
        string calldata /*pubKey*/
    ) external returns (uint256 orderId) {
        // TODO: implement.
        //   1. Look up unit price from the client (ICheckoutClient.getProductPrice).
        //   2. Compute total = unitPrice * quantity.
        //   3. Apply your per-tx + daily-count checks (or rely on validateOrder).
        //   4. Deploy or fetch the user's UserProxy clone.
        //   5. Have the proxy call IB2BGateway.placeB2BOrder on the Diamond.
        //   6. Emit OrderPlaced.
    }

    // ─── Internal helpers ─────────────────────────────────────────────
    function _getOrDeployProxy(address user) internal returns (UserProxy proxy) {
        address predicted = Clones.predictDeterministicAddress(
            proxyImpl,
            bytes32(uint256(uint160(user)))
        );
        if (predicted.code.length == 0) {
            proxy = UserProxy(payable(Clones.cloneDeterministic(
                proxyImpl,
                bytes32(uint256(uint160(user)))
            )));
            proxy.initialize(user, address(this));
        } else {
            proxy = UserProxy(payable(predicted));
        }
    }
}
