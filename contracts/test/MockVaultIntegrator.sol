// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Minimal stand-in for the integrator, used ONLY by PayQRVault unit tests.
///      It exposes a `vault()` getter (so the vault's setIntegrator mutual-
///      handshake passes) and a `doPull` that forwards to the vault's `pull`
///      exactly as the real integrator's _vaultPull does. Keeping this tiny and
///      separate lets the vault tests exercise the airtight link with a real
///      contract caller without pulling in the whole MerchantTerminalIntegrator.
interface IVaultPull {
    function pull(address to, uint256 amount) external;
}

contract MockVaultIntegrator {
    address public vault;

    /// @notice Point this mock at the vault it will pull from. In production the
    ///         integrator's `vault` is set via constructor/setVault; here it's
    ///         open so a test can wire the handshake in either order.
    function setVault(address v) external {
        vault = v;
    }

    /// @notice Forward a pull to the vault, mirroring the integrator's _vaultPull.
    function doPull(address to, uint256 amount) external {
        IVaultPull(vault).pull(to, amount);
    }
}
