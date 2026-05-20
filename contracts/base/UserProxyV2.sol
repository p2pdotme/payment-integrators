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
 * @title UserProxyV2
 * @notice Per-user proxy — identical to V1 but adds an activity-clock for the
 *         cashback feature. The activity clock is anchored via a one-shot
 *         `initialize()` call immediately after the clone is deployed and is
 *         bumped on every outbound `execute()` and on every
 *         `notifyCashbackCredit()` callback from the integrator's Diamond.
 *
 *         A `sweepStale` escape hatch lets the integrator recover proxy USDC
 *         after 90 days of inactivity, or immediately when the integrator has
 *         been deprecated.
 *
 * @dev    Immutable-args layout is identical to V1:
 *         [owner(20)][integrator(20)] — 40 bytes encoded by the cloner.
 *
 *         V2 is a separate file. Do NOT modify UserProxy.sol (V1).
 */

interface IUsdcSource {
    function usdc() external view returns (IERC20);
}

interface IDiamondHolder {
    function diamond() external view returns (address);
}

interface IDeprecatable {
    function deprecated() external view returns (bool);
}

contract UserProxyV2 is IERC721Receiver, IERC1155Receiver {
    using SafeERC20 for IERC20;

    // ─── Errors ───────────────────────────────────────────────────────

    error OnlyIntegrator();
    error OnlyOwner();
    error TargetNotAllowed();
    error CallFailed(bytes reason);
    error Reentrancy();
    error USDCSweepBlocked();

    // V2-only errors
    error AlreadyInitialized();
    error SweepLocked();
    error NothingToSweep();
    error InvalidAddress();

    // ─── Events ───────────────────────────────────────────────────────

    event Executed(address indexed target, bytes data);
    event SweptERC20(address indexed token, address indexed to, uint256 amount);
    event SweptERC721(address indexed token, address indexed to, uint256 tokenId);
    event SweptERC1155(address indexed token, address indexed to, uint256 id, uint256 amount);

    // V2-only events
    event CashbackCredited(uint256 timestamp);
    event SweepStale(address indexed to, uint256 amount);

    // ─── Storage ──────────────────────────────────────────────────────

    /// @dev Transient storage (EIP-1153) — TSTORE/TLOAD on cancun. Saves
    ///      ~7k gas per `execute` versus a regular SSTORE-backed flag, and
    ///      auto-clears at end-of-tx so even an explicit reset is optional.
    bool transient _entered;

    /// @notice Activity clock — set by initialize(), bumped by execute() and
    ///         notifyCashbackCredit(). Used by sweepStale() to enforce the
    ///         90-day inactivity timelock.
    ///
    ///         Slot 0. V1 had no storage (all immutable args), so there is no
    ///         layout conflict.
    uint256 private _lastActivityTimestamp;

    // ─── Modifiers ────────────────────────────────────────────────────

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

    // ─── V2: Activity clock ───────────────────────────────────────────

    /// @notice One-shot init called by the V2 integrator immediately after the
    ///         clone is deployed. Anchors the activity clock.
    function initialize() external {
        if (msg.sender != integrator()) revert OnlyIntegrator();
        if (_lastActivityTimestamp != 0) revert AlreadyInitialized();
        _lastActivityTimestamp = block.timestamp;
    }

    /// @notice Bumps the activity clock after the Diamond deposits cashback
    ///         to this proxy. Callable by the deploying integrator or by the
    ///         Diamond address that the integrator exposes via diamond().
    function notifyCashbackCredit() external {
        address ig = integrator();
        if (msg.sender != ig && msg.sender != IDiamondHolder(ig).diamond()) {
            revert OnlyIntegrator();
        }
        _lastActivityTimestamp = block.timestamp;
        emit CashbackCredited(block.timestamp);
    }

    /// @notice Recovers proxy USDC after 90 days of inactivity OR when the
    ///         deploying integrator has been deprecated. Destination is at
    ///         the deployer's discretion.
    function sweepStale(address to) external {
        if (msg.sender != integrator()) revert OnlyIntegrator();
        if (to == address(0)) revert InvalidAddress();
        bool unlocked = IDeprecatable(integrator()).deprecated() ||
            block.timestamp >= _lastActivityTimestamp + 90 days;
        if (!unlocked) revert SweepLocked();

        address usdcAddr = address(IUsdcSource(integrator()).usdc());
        uint256 bal = IERC20(usdcAddr).balanceOf(address(this));
        if (bal == 0) revert NothingToSweep();

        _lastActivityTimestamp = block.timestamp;
        IERC20(usdcAddr).safeTransfer(to, bal);
        emit SweepStale(to, bal);
    }

    /// @notice Returns the activity-clock anchor.
    function lastActivityTimestamp() external view returns (uint256) {
        return _lastActivityTimestamp;
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

        _lastActivityTimestamp = block.timestamp; // bump on outbound activity

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
