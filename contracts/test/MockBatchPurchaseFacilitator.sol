// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { IMegapot } from "../integrators/lotpot/IMegapot.sol";
import { MockJackpotNFT } from "./MockJackpotNFT.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockBatchPurchaseFacilitator
 * @notice Stand-in for Megapot's BatchPurchaseFacilitator in tests / Sepolia.
 *
 *         Real mainnet contract is async (USDC pulled at create, tickets
 *         minted later by Megapot's keeper via executeBatchOrder). To keep
 *         the unit tests and Sepolia E2E driver simple, this mock is
 *         **synchronous**: createBatchOrder pulls USDC and immediately
 *         mints `_dynamicTicketCount` tickets to `_recipient`, mirroring
 *         what would happen after BatchOrderExecuted on mainnet.
 *
 *         An allowlist mirrors the real contract's `isAllowed(msg.sender)`
 *         check on createBatchOrder so tests can verify the integrator
 *         reverts when not allowed.
 */
contract MockBatchPurchaseFacilitator {
    using SafeERC20 for IERC20;

    error NotAllowed();
    error InvalidTicketCount();
    error InvalidStaticTicket();

    event BatchOrderCreated(
        address indexed payer,
        address indexed recipient,
        uint256 totalCost,
        uint256 dynamicTicketCount,
        uint256 staticTicketCount
    );
    /// @dev Mirrors the mainnet event, fired immediately because we're sync.
    event BatchOrderExecuted(address indexed user, uint256[] ticketIds, uint256 ticketsExecuted);

    IERC20 public immutable usdc;
    MockJackpotNFT public immutable nft;
    uint256 public ticketPrice;
    uint8 public ballMax;
    uint8 public bonusballMax;
    uint256 public minimumTicketCount;

    mapping(address => bool) public allowed;

    address public lastPayer;
    address public lastRecipient;
    uint256 public lastDynamicCount;
    uint256 public lastStaticCount;
    address[] public lastReferrers;
    uint256[] public lastReferralSplit;

    constructor(
        address _usdc,
        address _nft,
        uint256 _ticketPrice,
        uint8 _ballMax,
        uint8 _bonusballMax,
        uint256 _minimumTicketCount
    ) {
        usdc = IERC20(_usdc);
        nft = MockJackpotNFT(_nft);
        ticketPrice = _ticketPrice;
        ballMax = _ballMax;
        bonusballMax = _bonusballMax;
        minimumTicketCount = _minimumTicketCount;
    }

    function setTicketPrice(uint256 price) external {
        ticketPrice = price;
    }

    function setMinimumTicketCount(uint256 count) external {
        minimumTicketCount = count;
    }

    function addAllowed(address a) external {
        allowed[a] = true;
    }

    function removeAllowed(address a) external {
        allowed[a] = false;
    }

    function isAllowed(address a) external view returns (bool) {
        return allowed[a];
    }

    function createBatchOrder(
        address _recipient,
        uint64 _dynamicTicketCount,
        IMegapot.Ticket[] memory _userStaticTickets,
        address[] memory _referrers,
        uint256[] memory _referralSplit
    ) external {
        if (!allowed[msg.sender]) revert NotAllowed();

        uint256 staticCount = _userStaticTickets.length;
        uint256 totalCount = uint256(_dynamicTicketCount) + staticCount;
        if (totalCount < minimumTicketCount) revert InvalidTicketCount();
        // No staticCount cap — verified against mainnet
        // 0x01774B53…aa76: it accepts arbitrary _userStaticTickets.length;
        // the "≤10" in Megapot's docs is UI advice only.

        // Validate static tickets the same way Jackpot does.
        for (uint256 i = 0; i < staticCount; i++) {
            _validateTicket(_userStaticTickets[i]);
        }

        uint256 totalCost = ticketPrice * totalCount;
        usdc.safeTransferFrom(msg.sender, address(this), totalCost);

        // Synchronous mint — the real keeper would do this asynchronously.
        // Use the NFT's own counter (mintNext) so we never collide with
        // IDs minted by sibling mocks (MockMegapot, older redeploys of
        // this facilitator) sharing this NFT.
        uint256[] memory ticketIds = new uint256[](totalCount);
        for (uint256 i = 0; i < totalCount; i++) {
            ticketIds[i] = nft.mintNext(_recipient);
        }

        lastPayer = msg.sender;
        lastRecipient = _recipient;
        lastDynamicCount = _dynamicTicketCount;
        lastStaticCount = staticCount;

        delete lastReferrers;
        delete lastReferralSplit;
        for (uint256 i = 0; i < _referrers.length; i++) {
            lastReferrers.push(_referrers[i]);
            lastReferralSplit.push(_referralSplit[i]);
        }

        emit BatchOrderCreated(msg.sender, _recipient, totalCost, _dynamicTicketCount, staticCount);
        emit BatchOrderExecuted(_recipient, ticketIds, totalCount);
    }

    function getLastReferrers() external view returns (address[] memory) {
        return lastReferrers;
    }

    function getLastReferralSplit() external view returns (uint256[] memory) {
        return lastReferralSplit;
    }

    function _validateTicket(IMegapot.Ticket memory t) internal view {
        if (t.normals.length != 5) revert InvalidStaticTicket();
        uint8 prev = 0;
        for (uint256 i = 0; i < 5; i++) {
            uint8 n = t.normals[i];
            if (n == 0 || n > ballMax) revert InvalidStaticTicket();
            if (n <= prev) revert InvalidStaticTicket();
            prev = n;
        }
        if (t.bonusball == 0 || t.bonusball > bonusballMax) revert InvalidStaticTicket();
    }
}
