// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { IP2PIntegrator } from "../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../interfaces/IB2BGateway.sol";
import { ICheckoutClient } from "../interfaces/ICheckoutClient.sol";
import { UserProxy } from "../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

/**
 * @title MyIntegrator
 * @notice STARTER TEMPLATE for new integrators. Copy this file out of
 *         `contracts/templates/` into `contracts/integrators/<your-name>/`
 *         and rename the contract. It compiles as-is so the project always
 *         builds while you fill in the TODOs.
 *
 *         Read docs/ARCHITECTURE.md and docs/PROXY-PATTERN.md first — they
 *         explain the UserProxy CREATE2-with-immutable-args pattern this
 *         template uses and the rules the Diamond's CREATE2 auth enforces.
 *
 *         What you MUST implement (IP2PIntegrator):
 *           - validateOrder(user, amount, currency) — apply per-tx + daily
 *             limits. Reverting blocks the order.
 *           - onOrderComplete(orderId, user, amount, recipientAddr) — called
 *             by the Diamond when fiat settles. Pull USDC from the proxy,
 *             route it to your client, trigger product delivery.
 *           - onOrderCancel(orderId) — release the daily-count debit you
 *             consumed in validateOrder.
 *
 *         What you MUST NOT do:
 *           - Fork UserProxy. Use the canonical one at contracts/base/UserProxy.sol.
 *           - Add upgradeability (proxy / delegatecall-to-impl).
 *           - Allow USDC to flow back to the user EOA (the proxy already
 *             enforces this — do not undo it in your routing).
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
    event UserProxyDeployed(address indexed user, address proxy);
    // TODO: add events for every other state-changing function

    // ─── Immutables ───────────────────────────────────────────────────
    address public immutable diamond;
    /// @notice Exposed as a public getter so the canonical UserProxy can
    ///         resolve which token to block from user-initiated sweep —
    ///         UserProxy.sweepERC20 calls `IUsdcSource(integrator()).usdc()`.
    IERC20 public immutable usdc;
    address public immutable owner;
    /// @notice Pinned at deploy. Submit this address alongside the integrator
    ///         address when filing the whitelist request — the Diamond's
    ///         `registerIntegrator(integrator, proxyImpl, source)` records it
    ///         for the CREATE2-auth path that authorizes proxy calls.
    address public immutable proxyImpl;

    // ─── State ────────────────────────────────────────────────────────
    // TODO: per-user RP, daily counters, registered clients, session storage, etc.

    // ─── Constructor ──────────────────────────────────────────────────
    constructor(address _diamond, address _usdc) {
        if (_diamond == address(0) || _usdc == address(0)) revert InvalidAddress();
        diamond = _diamond;
        usdc = IERC20(_usdc);
        owner = msg.sender;
        // Deploy the canonical UserProxy implementation. Every per-user clone
        // is a `cloneDeterministicWithImmutableArgs` of this address, with
        // `(user, address(this))` packed as the immutable args.
        proxyImpl = address(new UserProxy());
    }

    // ─── IP2PIntegrator ───────────────────────────────────────────────

    function validateOrder(
        address /*user*/,
        uint256 /*amount*/,
        bytes32 /*currency*/
    ) external returns (bool allowed) {
        // TODO: enforce per-tx + daily-count limits. Revert with a specific
        //       error to block, return false otherwise.
        return true;
    }

    function onOrderComplete(
        uint256 /*orderId*/,
        address /*user*/,
        uint256 /*amount*/,
        address /*recipientAddr*/
    ) external {
        if (msg.sender != diamond) revert OnlyDiamond();
        // TODO:
        //   1. Resolve the user's proxy via proxyAddress(user).
        //   2. Pull USDC from the proxy to this integrator:
        //        UserProxy(proxy).transferERC20ToIntegrator(address(usdc), amount);
        //   3. Approve + call your client contract:
        //        usdc.forceApprove(client, amount);
        //        ICheckoutClient(client).onCheckoutPayment(user, amount, productId, quantity);
        //   4. Emit OrderCompleted.
    }

    function onOrderCancel(uint256 /*orderId*/) external {
        if (msg.sender != diamond) revert OnlyDiamond();
        // TODO: reverse the daily-count debit (best-effort — tolerate unknown
        //       orderId or repeated cancellation). The Diamond may call this
        //       AFTER on-chain order state has finalised, so do not touch
        //       order state — only your own per-user accounting.
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
        // TODO: full implementation. Sketch:
        //
        //   1. unitPrice = ICheckoutClient(client).getProductPrice(productId);
        //   2. total = unitPrice * quantity;
        //   3. Apply per-tx + daily-count checks (your validateOrder will
        //      also run when the Diamond calls back, but front-running it
        //      here gives the user a cleaner revert path).
        //   4. address proxy = _ensureProxy(msg.sender);
        //   5. Build the Diamond call and route it through the proxy:
        //        bytes memory placeData = abi.encodeCall(
        //            IB2BGateway.placeB2BOrder,
        //            (msg.sender, total, currency, address(0), pubKey, circleId, 0, 0)
        //        );
        //        UserProxy(proxy).execute(diamond, placeData, address(usdc), 0);
        //
        //      `usdcAllowance = 0` is correct: Diamond.placeB2BOrder does
        //      not pull USDC at placement — payment settles off-chain, and
        //      the Diamond pulls via the proxy at onOrderComplete time.
        //   6. Capture orderId (the standard pattern: read getNextOrderId()
        //      before the call, then the placed order has that id).
        //   7. Record the session, emit OrderPlaced, return orderId.
        return 0;
    }

    // ─── Proxy helpers (mirror ExampleIntegrator exactly) ─────────────

    /// @notice Predicts the deterministic UserProxy address for `user`.
    ///         The clone may not yet be deployed — check `code.length` if
    ///         you need to know.
    function proxyAddress(address user) public view returns (address) {
        return
            Clones.predictDeterministicAddressWithImmutableArgs(
                proxyImpl,
                _proxyArgs(user),
                _salt(user),
                address(this)
            );
    }

    /// @dev Salt is the user EOA only. The "deployer" component of the
    ///      CREATE2 address derivation is the integrator (this contract),
    ///      so a (integrator, user) pair maps to exactly one proxy address.
    function _salt(address user) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(user)));
    }

    /// @dev Immutable args layout: [owner(20)][integrator(20)] — 40 bytes.
    ///      UserProxy.owner() and UserProxy.integrator() read these slots
    ///      via `Clones.fetchCloneArgs(address(this))`. The Diamond's
    ///      CREATE2-auth path reconstructs the same args from the registered
    ///      proxyImpl + user salt, so DO NOT change the layout.
    function _proxyArgs(address user) internal view returns (bytes memory) {
        return abi.encodePacked(user, address(this));
    }

    function _ensureProxy(address user) internal returns (address proxy) {
        proxy = proxyAddress(user);
        if (proxy.code.length == 0) {
            address deployed = Clones.cloneDeterministicWithImmutableArgs(
                proxyImpl,
                _proxyArgs(user),
                _salt(user)
            );
            assert(deployed == proxy);
            emit UserProxyDeployed(user, proxy);
        }
    }
}
