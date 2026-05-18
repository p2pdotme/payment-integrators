// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { IERC1155 } from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import { IERC721Receiver } from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import { IERC1155Receiver } from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/**
 * @title UserProxy
 * @notice Per-user proxy used by P2P checkout integrators to call upstream
 *         protocols on behalf of an end-user. The proxy is `msg.sender` to
 *         the upstream contract, so any tokens minted/transferred to
 *         `msg.sender` land on the proxy. Non-USDC ERC-20s, ERC-721s, and
 *         ERC-1155s remain user-sweepable via the `sweep*` helpers.
 *
 *         USDC is special: it can ONLY exit a proxy by being pulled by the
 *         upstream protocol the integrator routes to (e.g. Megapot,
 *         marketplace clients, etc.). The user-initiated `sweepERC20`
 *         rejects USDC, and `execute` does not auto-refund unspent USDC
 *         back to the user EOA. This forces stranded USDC to be consumed
 *         through the integrator's recovery / credit-redemption path,
 *         which closes a fraud-bypass surface where a scammer could use a
 *         B2B integration to convert fiat → USDC while evading
 *         consumer-side fraud checks.
 *
 *         The USDC token address is resolved from the integrator's
 *         `usdc()` getter (every integrator using this proxy exposes one
 *         as a public state variable). Lookup happens on each
 *         `sweepERC20` call — the integrator address is immutable in the
 *         clone, so the resolution can't be spoofed.
 *
 * @dev    Deployed via `Clones.cloneDeterministicWithImmutableArgs`. The
 *         `owner` (end-user EOA) and `integrator` addresses are encoded in
 *         the clone's runtime code (40 bytes total). They are read on demand
 *         via `Clones.fetchCloneArgs(address(this))`.
 *
 *         Salt: `bytes32(uint256(uint160(user)))` — one proxy per user,
 *         reused across all orders.
 */
interface IUsdcSource {
    function usdc() external view returns (IERC20);
}

contract UserProxy is IERC721Receiver, IERC1155Receiver {
    using SafeERC20 for IERC20;

    error OnlyIntegrator();
    error OnlyOwner();
    error TargetNotAllowed();
    error CallFailed(bytes reason);
    error Reentrancy();
    error USDCSweepBlocked();

    event Executed(address indexed target, bytes data);
    event SweptERC20(address indexed token, address indexed to, uint256 amount);
    event SweptERC721(address indexed token, address indexed to, uint256 tokenId);
    event SweptERC1155(address indexed token, address indexed to, uint256 id, uint256 amount);

    /// @dev Transient storage (EIP-1153) — TSTORE/TLOAD on cancun. Saves
    ///      ~7k gas per `execute` versus a regular SSTORE-backed flag, and
    ///      auto-clears at end-of-tx so even an explicit reset is optional.
    bool transient _entered;

    modifier nonReentrant() {
        if (_entered) revert Reentrancy();
        _entered = true;
        _;
        _entered = false;
    }

    modifier onlyOwner() {
        if (msg.sender != owner()) revert OnlyOwner();
        _;
    }

    // ─── Immutable args ───────────────────────────────────────────────

    /// @notice The end-user EOA that this proxy acts on behalf of.
    function owner() public view returns (address ownerAddr) {
        bytes memory args = Clones.fetchCloneArgs(address(this));
        // args layout: [owner(20)][integrator(20)]
        assembly {
            ownerAddr := shr(96, mload(add(args, 0x20)))
        }
    }

    /// @notice The integrator authorized to call `execute` on this proxy.
    function integrator() public view returns (address integratorAddr) {
        bytes memory args = Clones.fetchCloneArgs(address(this));
        assembly {
            // 0x20 (length prefix) + 20 (owner offset) = 0x34
            integratorAddr := shr(96, mload(add(args, 0x34)))
        }
    }

    // ─── Execute ──────────────────────────────────────────────────────

    /**
     * @notice Approve `usdc` up to `usdcAllowance` to `target`, call `target`
     *         with `data`, then reset the allowance and refund any USDC
     *         remainder back to the owner.
     *
     * @dev    USDC is the only auto-swept token. Any NFTs or other ERC-20
     *         rewards minted/transferred to this proxy during the call must
     *         be pulled out by the owner via `sweepERC20/721/1155`. See
     *         docs/RELAYER-AUTO-SWEEP.md for a future relayer-driven
     *         auto-sweep design.
     */
    function execute(
        address target,
        bytes calldata data,
        address usdc,
        uint256 usdcAllowance
    ) external nonReentrant returns (bytes memory result) {
        address ig = integrator();
        if (msg.sender != ig) revert OnlyIntegrator();
        if (target == address(this) || target == ig) revert TargetNotAllowed();

        // Skip approval traffic for placement-style calls where the caller
        // doesn't need to spend USDC (e.g. proxy.execute(diamond, placeB2BOrder).
        // No allowance was set, so there's nothing to reset either.
        if (usdcAllowance > 0) {
            IERC20(usdc).forceApprove(target, usdcAllowance);
        }

        bool ok;
        (ok, result) = target.call(data);
        if (!ok) revert CallFailed(result);

        if (usdcAllowance > 0) {
            IERC20(usdc).forceApprove(target, 0);
        }

        // No auto-sweep of USDC remainder — any unspent USDC stays on the
        // proxy as future credit / for integrator-driven recovery. Pushing
        // it back to the user EOA inline would create a B2B-mediated
        // fiat-to-USDC exit that bypasses consumer-side fraud checks.
        emit Executed(target, data);
    }

    // ─── User escape hatches ──────────────────────────────────────────

    function sweepERC20(address token) external onlyOwner {
        // USDC exits only through integrator-driven flows (the upstream
        // protocol pulling it for goods/tickets, or an integrator-defined
        // credit-redemption path). Direct user-EOA exit would bypass the
        // consumer-side fraud checks the user-app enforces at deposit time.
        if (token == address(IUsdcSource(integrator()).usdc())) revert USDCSweepBlocked();
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal == 0) return;
        IERC20(token).safeTransfer(msg.sender, bal);
        emit SweptERC20(token, msg.sender, bal);
    }

    function sweepERC721(address token, uint256 tokenId) external onlyOwner {
        IERC721(token).safeTransferFrom(address(this), msg.sender, tokenId);
        emit SweptERC721(token, msg.sender, tokenId);
    }

    function sweepERC1155(address token, uint256 id) external onlyOwner {
        uint256 bal = IERC1155(token).balanceOf(address(this), id);
        if (bal == 0) return;
        IERC1155(token).safeTransferFrom(address(this), msg.sender, id, bal, "");
        emit SweptERC1155(token, msg.sender, id, bal);
    }

    /**
     * @notice Integrator-only: pull `amount` of `token` from this proxy back
     *         to the integrator. Needed for flows where the integrator must
     *         be the on-chain caller of an external protocol (e.g. Megapot's
     *         BatchPurchaseFacilitator, which checks an allowlist on
     *         `msg.sender`). Without this, the integrator can't direct the
     *         proxy's USDC anywhere outside `execute(target, …)` because
     *         `execute` rejects `target == integrator`.
     *
     * @dev    Source is hardcoded to `address(this)` and the only callable
     *         pull destination is `integrator()` — there is no way for the
     *         integrator to redirect the proxy's tokens elsewhere via this
     *         function. Worst case (compromised integrator key) is the
     *         integrator drains the proxy's token balance to itself, which
     *         is the same blast radius as `execute(target, transferData, …)`.
     */
    function transferERC20ToIntegrator(address token, uint256 amount) external {
        address ig = integrator();
        if (msg.sender != ig) revert OnlyIntegrator();
        IERC20(token).safeTransfer(ig, amount);
    }

    // ─── Receiver hooks ───────────────────────────────────────────────
    // Hooks just acknowledge receipt — auto-forwarding inside the hook is
    // unsafe (the original mint frame is still open and many third-party
    // mints emit/state-mutate after the hook returns).

    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    function onERC1155Received(
        address,
        address,
        uint256,
        uint256,
        bytes calldata
    ) external pure override returns (bytes4) {
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure override returns (bytes4) {
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return
            interfaceId == type(IERC165).interfaceId ||
            interfaceId == type(IERC721Receiver).interfaceId ||
            interfaceId == type(IERC1155Receiver).interfaceId;
    }
}
