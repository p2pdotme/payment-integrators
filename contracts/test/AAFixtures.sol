// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/**
 * @title AAFixtures
 * @notice Pulls the REAL ERC-4337 reference contracts into the build so the
 *         payment-link end-to-end suite can run a genuine sponsored user
 *         operation locally.
 *
 * WHY THE REAL ONES
 * The relayer-removal design rests on three claims that are only meaningful if
 * account abstraction actually behaves as assumed: that a link's wallet can
 * sign while holding no balance, that its address is known before it exists,
 * and that a sponsor — not the sender — pays. A mock EntryPoint would let all
 * three pass by construction, which is exactly the failure mode that let the
 * original `paidBuyOrder` bug through: a mock that encoded our belief about a
 * protocol rather than the protocol.
 *
 * WHAT MAPS TO WHAT IN PRODUCTION
 *   EntryPoint            → the same singleton, already deployed on Base
 *   SimpleAccountFactory  → the account factory. Both this and thirdweb's
 *                           derive addresses with CREATE2 from a salt, so an
 *                           address is computable before deployment and the
 *                           account is created lazily by `initCode` on first
 *                           use. That is the property the design depends on.
 *   VerifyingPaymaster    → sponsorship gated by an OFF-CHAIN signer, which is
 *                           how the provider's server verifier works: our
 *                           endpoint decides per operation, and only an
 *                           approved one gets paid for.
 *
 * These are test fixtures. Nothing here ships.
 */

import { EntryPoint } from "@account-abstraction/contracts/core/EntryPoint.sol";
import { SimpleAccountFactory } from "@account-abstraction/contracts/samples/SimpleAccountFactory.sol";
import { VerifyingPaymaster } from "@account-abstraction/contracts/samples/VerifyingPaymaster.sol";

// Referencing the types is what makes Hardhat compile and emit artifacts for
// them; the contracts are deployed by name from the test suite.
contract AAFixtures {
    EntryPoint private _entryPoint;
    SimpleAccountFactory private _factory;
    VerifyingPaymaster private _paymaster;
}
