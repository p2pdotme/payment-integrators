// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { IMegapot } from "../integrators/lotpot/IMegapot.sol";
import { MockJackpotNFT } from "./MockJackpotNFT.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockMegapot
 * @notice Stand-in for Megapot's BaseJackpot in tests. Exposes the
 *         per-drawing state surface the integrator now reads from
 *         (`currentDrawingId`, `getDrawingState`), pulls USDC at the
 *         current drawing's price, validates ticket shape against the
 *         current drawing's ranges, and mints ticket NFTs to `_recipient`.
 *
 *         The `useSafeMint` toggle exercises both the `_mint` and
 *         `_safeMint` paths so the integrator's sweep logic is verified
 *         against either.
 *
 *         Test helpers:
 *         - `setTicketPrice` / `setBallMaxForTest` / `setBonusballMaxForTest`
 *           mutate the *current* drawing's state in place (simulates
 *           Megapot's owner reconfiguring without rolling the drawing).
 *         - `rolloverDrawing(price, ballMax, bonusballMax)` advances to a
 *           new drawing id with fresh values (simulates the daily rollover
 *           that can happen between placement and fulfillment).
 */
contract MockMegapot {
    using SafeERC20 for IERC20;

    error InvalidTicket();

    event BuyTicketsCalled(
        address indexed caller,
        address indexed recipient,
        uint256 quantity,
        bytes32 source
    );
    event DrawingRolled(
        uint256 indexed drawingId,
        uint256 ticketPrice,
        uint8 ballMax,
        uint8 bonusballMax
    );

    IERC20 public immutable usdc;
    MockJackpotNFT public immutable nft;
    bool public useSafeMint;

    address public lastCaller;
    address public lastRecipient;
    bytes32 public lastSource;
    uint256 public lastQuantity;
    IMegapot.Ticket[] public lastTickets;
    address[] public lastReferrers;
    uint256[] public lastReferralSplit;
    /// @dev If non-zero, buyTickets returns this many ticketIds regardless of
    ///      _tickets.length. Used in tests to exercise the integrator's
    ///      MegapotReturnMismatch guard against a buggy/upgraded Megapot.
    uint256 public returnLengthOverride;

    /// @dev If true, buyTickets reverts unconditionally. Used to exercise
    ///      the integrator's try/catch around the upstream call (e.g.
    ///      Megapot paused, mid-flight upgrade, ticket-shape rejection).
    bool public revertOnBuyTickets;

    /// @dev Per-drawing state, indexed by drawingId starting at 1. Only the
    ///      three fields the integrator reads (ticketPrice, ballMax,
    ///      bonusballMax) are populated; the rest are left at default
    ///      values so the ABI shape still encodes correctly.
    mapping(uint256 => IMegapot.DrawingState) private _drawings;
    uint256 public currentDrawingId;

    constructor(
        address _usdc,
        address _nft,
        uint256 _ticketPrice,
        uint8 _ballMax,
        uint8 _bonusballMax
    ) {
        usdc = IERC20(_usdc);
        nft = MockJackpotNFT(_nft);
        currentDrawingId = 1;
        _setDrawing(1, _ticketPrice, _ballMax, _bonusballMax);
    }

    // ─── Test helpers ─────────────────────────────────────────────────

    function setTicketPrice(uint256 price) external {
        _drawings[currentDrawingId].ticketPrice = price;
    }

    function setUseSafeMint(bool flag) external {
        useSafeMint = flag;
    }

    /// @dev Mutates the current drawing's `ballMax` in place. Tests use this
    ///      to simulate Megapot owner adjustments mid-drawing or to drive
    ///      the integrator's per-drawing ballMax read to a new value.
    function setBallMaxForTest(uint8 _ballMax) external {
        _drawings[currentDrawingId].ballMax = _ballMax;
    }

    /// @dev Mutates the current drawing's `bonusballMax` in place.
    function setBonusballMaxForTest(uint8 _bonusballMax) external {
        _drawings[currentDrawingId].bonusballMax = _bonusballMax;
    }

    /// @dev Advances `currentDrawingId` and seeds the new drawing with the
    ///      provided values. Used to exercise the integrator's rollover
    ///      handling — picks valid for drawing N may be invalid for N+1.
    function rolloverDrawing(uint256 ticketPrice, uint8 ballMax, uint8 bonusballMax) external {
        currentDrawingId += 1;
        _setDrawing(currentDrawingId, ticketPrice, ballMax, bonusballMax);
        emit DrawingRolled(currentDrawingId, ticketPrice, ballMax, bonusballMax);
    }

    function setReturnLengthOverride(uint256 n) external {
        returnLengthOverride = n;
    }

    function setRevertOnBuyTickets(bool flag) external {
        revertOnBuyTickets = flag;
    }

    function _setDrawing(
        uint256 id,
        uint256 ticketPrice,
        uint8 ballMax,
        uint8 bonusballMax
    ) internal {
        IMegapot.DrawingState storage d = _drawings[id];
        d.ticketPrice = ticketPrice;
        d.ballMax = ballMax;
        d.bonusballMax = bonusballMax;
    }

    // ─── IMegapot view surface ────────────────────────────────────────

    function getDrawingState(
        uint256 _drawingId
    ) external view returns (IMegapot.DrawingState memory) {
        return _drawings[_drawingId];
    }

    function buyTickets(
        IMegapot.Ticket[] memory _tickets,
        address _recipient,
        address[] memory _referrers,
        uint256[] memory _referralSplit,
        bytes32 _source
    ) external returns (uint256[] memory ticketIds) {
        if (revertOnBuyTickets) revert("MockMegapot: forced revert");
        uint256 quantity = _tickets.length;
        IMegapot.DrawingState memory d = _drawings[currentDrawingId];

        for (uint256 i = 0; i < quantity; i++) {
            _validate(_tickets[i], d.ballMax, d.bonusballMax);
        }

        usdc.safeTransferFrom(msg.sender, address(this), d.ticketPrice * quantity);

        delete lastTickets;
        // Mint via the NFT's auto-incrementing counter so we never collide
        // with IDs minted by sibling mocks (MockBatchPurchaseFacilitator,
        // older deploys, etc.) sharing this NFT.
        bool _useSafeMint = useSafeMint;
        uint256[] memory mintedIds = new uint256[](quantity);
        for (uint256 i = 0; i < quantity; i++) {
            lastTickets.push(_tickets[i]);
            mintedIds[i] = _useSafeMint ? nft.safeMintNext(_recipient) : nft.mintNext(_recipient);
        }

        // Default: one ID per ticket. Tests use returnLengthOverride to
        // simulate a buggy/upgraded Megapot returning a mismatched length.
        uint256 returnLen = returnLengthOverride == 0 ? quantity : returnLengthOverride;
        ticketIds = new uint256[](returnLen);
        for (uint256 i = 0; i < returnLen; i++) {
            // For the override path, pad past the actually-minted set with
            // the next sequential ID — values don't matter for the
            // integrator's length check.
            ticketIds[i] = i < quantity
                ? mintedIds[i]
                : (mintedIds[quantity - 1] + (i - quantity + 1));
        }

        lastCaller = msg.sender;
        lastRecipient = _recipient;
        lastSource = _source;
        lastQuantity = quantity;

        delete lastReferrers;
        delete lastReferralSplit;
        for (uint256 i = 0; i < _referrers.length; i++) {
            lastReferrers.push(_referrers[i]);
            lastReferralSplit.push(_referralSplit[i]);
        }

        emit BuyTicketsCalled(msg.sender, _recipient, quantity, _source);
    }

    function _validate(IMegapot.Ticket memory t, uint8 ballMax, uint8 bonusballMax) internal pure {
        if (t.normals.length != 5) revert InvalidTicket();
        uint8 prev = 0;
        for (uint256 i = 0; i < 5; i++) {
            uint8 n = t.normals[i];
            if (n == 0 || n > ballMax) revert InvalidTicket();
            if (n <= prev) revert InvalidTicket();
            prev = n;
        }
        if (t.bonusball == 0 || t.bonusball > bonusballMax) revert InvalidTicket();
    }

    function getLastTickets() external view returns (IMegapot.Ticket[] memory tickets) {
        tickets = new IMegapot.Ticket[](lastTickets.length);
        for (uint256 i = 0; i < lastTickets.length; i++) {
            tickets[i] = lastTickets[i];
        }
    }

    function getLastReferrers() external view returns (address[] memory) {
        return lastReferrers;
    }

    function getLastReferralSplit() external view returns (uint256[] memory) {
        return lastReferralSplit;
    }
}
