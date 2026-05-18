// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @title IMegapot
 * @notice Subset of the Megapot Jackpot interface used by
 *         LotPotCheckoutIntegrator. The struct shape MUST exactly match
 *         the on-chain contract — `normals` is a *dynamic* uint8 array
 *         (not fixed-size), and bonusball is a uint8. Different types
 *         would produce a different function selector and silently fail.
 *
 *         Verified against Base mainnet 0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2.
 */
interface IMegapot {
    struct Ticket {
        uint8[] normals;
        uint8 bonusball;
    }

    /// @notice Per-drawing state. Field order MUST match the on-chain
    ///         struct exactly — ABI decoding is positional. The integrator
    ///         only reads `ticketPrice`, `ballMax`, and `bonusballMax`, but
    ///         all fields are declared so the ABI encoding lines up.
    ///
    ///         `ballMax` and `bonusballMax` are the values `buyTickets`
    ///         validates fresh tickets against — they can change per drawing
    ///         and may be narrower than the global `normalBallMax()` /
    ///         `bonusballHardCap()` views the contract also exposes. The
    ///         integrator reads these per-drawing values exclusively.
    struct DrawingState {
        uint256 prizePool;
        uint256 ticketPrice;
        uint256 edgePerTicket;
        uint256 referralWinShare;
        uint256 referralFee;
        uint256 globalTicketsBought;
        uint256 lpEarnings;
        uint256 drawingTime;
        uint256 winningTicket;
        uint8 ballMax;
        uint8 bonusballMax;
        address payoutCalculator;
        bool jackpotLock;
    }

    function buyTickets(
        Ticket[] memory _tickets,
        address _recipient,
        address[] memory _referrers,
        uint256[] memory _referralSplit,
        bytes32 _source
    ) external returns (uint256[] memory ticketIds);

    function currentDrawingId() external view returns (uint256);
    function getDrawingState(uint256 _drawingId) external view returns (DrawingState memory);
}

/**
 * @title IBatchPurchaseFacilitator
 * @notice Subset of Megapot's BatchPurchaseFacilitator used by the LotPot
 *         integrator for orders ≥ minimumTicketCount() (currently 11). Direct
 *         `Jackpot.buyTickets` is capped at 10 tickets per call; larger orders
 *         must go through this contract.
 *
 *         Verified against Base mainnet 0x01774B531591b286b9f02C6Bc02ab3fD9526Aa76:
 *         - createBatchOrder is permissioned via an `isAllowed(msg.sender)`
 *           allowlist managed by Megapot's owner. The integrator address must
 *           be added to that allowlist before mainnet launch.
 *         - Fulfillment is asynchronous — Megapot's keeper later calls
 *           executeBatchOrder, which mints tickets to the recipient and emits
 *           BatchOrderExecuted with the resulting ticketIds.
 *         - USDC is pulled from msg.sender at createBatchOrder time (prepaid).
 *         - One active batch order per recipient at a time
 *           (ActiveBatchOrderExists if you re-create before execution).
 */
interface IBatchPurchaseFacilitator {
    function createBatchOrder(
        address _recipient,
        uint64 _dynamicTicketCount,
        IMegapot.Ticket[] memory _userStaticTickets,
        address[] memory _referrers,
        uint256[] memory _referralSplit
    ) external;

    function minimumTicketCount() external view returns (uint256);
    function isAllowed(address) external view returns (bool);
}
