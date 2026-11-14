// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { UserProxy } from "../../base/UserProxy.sol";

/**
 * @title LinkDisputeLib
 * @notice Disputes on payment-link orders, for `MerchantTerminalIntegrator`.
 *
 * WHY
 * The Diamond accepts `raiseDispute` and `appealDispute` only from `order.user`,
 * and a link order's `order.user` is the merchant's PROXY, which has no key. The
 * proxy obeys only the integrator (`UserProxy.execute` checks `msg.sender ==
 * integrator`), so the integrator keeps the one entry point and its checks —
 * `linkDispute`, which raises or appeals, for the customer (through the
 * LinkRouter) or the merchant — and this library makes the proxy call the
 * Diamond.
 *
 * INTERNAL, NOT DEPLOYED
 * Every function here is `internal`, so it is compiled into the integrator: no
 * extra contract to deploy or link, and the proxy still sees the integrator as
 * its caller. (A deployed library was measured larger: encoding the library
 * call costs more than the code it moves out.) `callDiamond` is the integrator's
 * one proxy hop, shared with mark-paid and cancel, so it exists once.
 *
 * The Diamond keeps every rule of its own: only a BUY cancelled after being
 * marked paid, only 15 min to 24 h after placement, only once, and only from
 * that order's own proxy (another merchant's order is refused there); and for
 * an appeal, only while one is due, and never past tier 3.
 */
library LinkDisputeLib {
    /// @notice Call the Diamond AS `proxy` — the `order.user` of the merchant's
    ///         link orders, and the only caller the Diamond accepts for them.
    ///         No USDC allowance: none of these calls moves funds.
    /// @dev The integrator's one proxy hop (`_viaProxy`): mark-paid, cancel, and
    ///      both dispute actions (raise and appeal, from `linkDispute`) pass
    ///      through here with the call already encoded, so the integrator stays
    ///      under EIP-170.
    function callDiamond(address proxy, address diamond, address usdc, bytes memory data) internal {
        UserProxy(proxy).execute(diamond, data, usdc, 0);
    }
}
