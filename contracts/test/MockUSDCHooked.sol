// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { MockUSDCBlacklistable } from "./MockUSDCBlacklistable.sol";

/**
 * @title MockUSDCHooked
 * @notice Test-only USDC variant that, after crediting a transfer, pings the
 *         recipient with an empty low-level call IF the recipient is a
 *         contract. This does NOT model real Circle USDC — FiatTokenV2 has
 *         no transfer hooks, so a plain transfer/transferFrom never yields
 *         control back to the recipient, and `release`'s only external
 *         call (`usdc.safeTransfer`) is genuinely not a live reentrancy
 *         vector against the real token.
 *
 *         It exists purely to give VendorEscrow.release's
 *         `nonReentrant` guard a real callback surface to defend in tests —
 *         defense-in-depth verification: if USDC were ever swapped for a
 *         token with hook semantics (or wrapped in one), the guard must
 *         still hold.
 */
contract MockUSDCHooked is MockUSDCBlacklistable {
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (to.code.length > 0) {
            (bool ok, ) = to.call("");
            ok; // ignore — a hook failure must never block the underlying transfer
        }
    }
}
