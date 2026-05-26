// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title GrantVault
 * @notice Generic USDC holding contract: passive balance + a release
 *         authority gated to whitelisted spenders. First consumer is the
 *         LotPot buyer-cashback growth campaign, where two instances are
 *         deployed — a primary "grant" vault (funded by the grant-giving
 *         party, e.g. Megapot) and a fallback vault (funded by P2P
 *         treasury). The configured integrator is added as an approved
 *         spender; on each ticket purchase that consumes issued credit,
 *         the integrator calls `release(proxy, amount)` and the vault
 *         transfers USDC to the user's proxy so it can be spent on
 *         tickets in the same tx.
 *
 *         Vault owners can `withdraw` their USDC at any time — there is
 *         no timelock. The consuming integrator should degrade to partial
 *         fulfillment if a vault is empty or has revoked the spender.
 *         Funds in the vault are NOT user property; they are protocol /
 *         grant-team property until redeemed.
 *
 * @dev    Inbound USDC is via plain `usdc.transfer(vault, ...)`. There is
 *         no special deposit method — the vault is a passive balance plus
 *         a release authority.
 */
contract GrantVault {
    using SafeERC20 for IERC20;

    // ─── Errors ───────────────────────────────────────────────────────

    error OnlyOwner();
    error OnlyApprovedSpender();
    error InvalidAddress();
    error InvalidAmount();

    // ─── Events ───────────────────────────────────────────────────────

    event SpenderSet(address indexed spender, bool approved);
    event Released(address indexed spender, address indexed to, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event OwnershipTransferred(address indexed from, address indexed to);

    // ─── Storage ──────────────────────────────────────────────────────

    /// @notice The USDC token this vault holds.
    IERC20 public immutable USDC;

    /// @notice Current owner. Can withdraw, set spenders, and transfer ownership.
    address public owner;

    /// @notice Whitelist of contracts authorized to call `release`.
    mapping(address => bool) public approvedSpender;

    // ─── Construction ─────────────────────────────────────────────────

    constructor(IERC20 _usdc, address _owner) {
        if (address(_usdc) == address(0) || _owner == address(0)) revert InvalidAddress();
        USDC = _usdc;
        owner = _owner;
        emit OwnershipTransferred(address(0), _owner);
    }

    // ─── Modifiers ────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyApprovedSpender() {
        if (!approvedSpender[msg.sender]) revert OnlyApprovedSpender();
        _;
    }

    // ─── Owner: Spender Management ────────────────────────────────────

    /// @notice Whitelist (or remove) a contract authorized to call `release`.
    function setApprovedSpender(address spender, bool approved) external onlyOwner {
        if (spender == address(0)) revert InvalidAddress();
        approvedSpender[spender] = approved;
        emit SpenderSet(spender, approved);
    }

    // ─── Owner: Withdrawal ────────────────────────────────────────────

    /// @notice Owner pull-out — no timelock. Vault funds are not user
    ///         property; the owner can reclaim them at any time.
    function withdraw(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        USDC.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    // ─── Owner: Ownership Transfer ────────────────────────────────────

    /// @notice Hand off ownership. Useful for migrating to a multisig.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }

    // ─── Spender: Release ─────────────────────────────────────────────

    /// @notice Pay out USDC to a destination address. Reverts if the
    ///         vault's balance is insufficient (SafeERC20 propagates).
    /// @param to     Recipient — typically the user's LotPot UserProxy.
    /// @param amount USDC amount to release.
    function release(address to, uint256 amount) external onlyApprovedSpender {
        if (to == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        USDC.safeTransfer(to, amount);
        emit Released(msg.sender, to, amount);
    }
}
