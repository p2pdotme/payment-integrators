// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @notice The only thing a clone ever asks its integrator, at release time.
interface IFeeWalletSource {
    function feeWallet() external view returns (address);
}

/**
 * @title VendorEscrow
 * @notice One clone per vendor. Holds ONLY that vendor's USDC — no other
 *         vendor's money ever touches this balance. The Diamond pays each
 *         completed order straight here (`recipientAddr` = this clone,
 *         `usdcThroughIntegrator = false`), and the integrator then writes
 *         the order's record via `recordCompletion`.
 *
 *         Each record snapshots the fee in force when it was written (the
 *         vendor's `feeBps` and the fixed `feeFixed`) and its own `unlockAt`,
 *         so a later change of fee or retention never touches an order
 *         already recorded.
 *
 *         Invariant, local to each clone:
 *             usdc.balanceOf(this) >= pendingGross
 *         where `pendingGross` = sum of `gross` over records not yet
 *         released. `recordCompletion` enforces it on write: a record cannot
 *         be created for money that has not arrived.
 *
 *         No owner, no sweep, no refund, no delegatecall, no upgrade: USDC
 *         leaves only through `release` — net → `vendor()`, fee → the
 *         integrator's current fee wallet.
 *
 * @dev    Deployed as an EIP-1167 clone with immutable args:
 *             [vendor(20)][integrator(20)][usdc(20)]
 *         No constructor/initializer runs on a clone, which is why the
 *         reentrancy guard is the transient-storage variant (no storage slot
 *         to initialize).
 */
contract VendorEscrow is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    // ─── Errors ───────────────────────────────────────────────────────

    error OnlyIntegrator();
    error InvalidAmount();
    error InvalidFeeBps();
    error AlreadyRecorded();
    error Unfunded();
    error UnknownRecord();
    error StillLocked();

    // ─── Events ───────────────────────────────────────────────────────

    event Recorded(
        uint256 indexed orderId,
        uint256 gross,
        uint256 feeBps,
        uint256 feeFixed,
        uint256 unlockAt
    );
    event Released(uint256 indexed orderId, uint256 net, uint256 fee);

    // ─── State ────────────────────────────────────────────────────────

    /// @dev One slot. `gross` is never 0 for a recorded order, so it doubles
    ///      as the "exists" flag.
    struct Record {
        uint128 gross; // USDC as delivered by the Diamond
        uint64 unlockAt;
        uint16 feeBps; // snapshot at record time
        uint32 feeFixed; // snapshot at record time, USDC units (6 decimals)
        bool released;
    }

    /// @notice orderId => its record. `gross == 0` means not recorded here.
    mapping(uint256 => Record) public records;

    /// @notice Gross amount of recorded orders not yet released.
    uint256 public pendingGross;

    // ─── Immutable args ───────────────────────────────────────────────

    /// @notice The vendor this clone pays: the only destination of `net`.
    /// @return a  Immutable arg 0.
    function vendor() public view returns (address a) {
        bytes memory args = Clones.fetchCloneArgs(address(this));
        assembly {
            a := shr(96, mload(add(args, 0x20)))
        }
    }

    /// @notice The integrator that deployed this clone: the only one allowed
    ///         to write records, and the source of the fee wallet.
    /// @return a  Immutable arg 1.
    function integrator() public view returns (address a) {
        bytes memory args = Clones.fetchCloneArgs(address(this));
        assembly {
            a := shr(96, mload(add(args, 0x34))) // 0x20 + 20
        }
    }

    /// @notice The token this clone holds and pays out.
    /// @return t  Immutable arg 2.
    function usdc() public view returns (IERC20 t) {
        bytes memory args = Clones.fetchCloneArgs(address(this));
        assembly {
            t := shr(96, mload(add(args, 0x48))) // 0x20 + 40
        }
    }

    modifier onlyIntegrator() {
        if (msg.sender != integrator()) revert OnlyIntegrator();
        _;
    }

    // ─── Integrator-only write ────────────────────────────────────────

    /**
     * @notice Writes the record for an order whose USDC already landed here.
     *         Reverts if this clone's balance does not cover the new record
     *         on top of every pending one — the per-escrow invariant is
     *         checked at the only point where pendingGross grows.
     * @param orderId   The Diamond's order id; recorded once.
     * @param gross     USDC units the Diamond delivered.
     * @param feeBps    The vendor's percentage in force, in basis points.
     * @param feeFixed  The fixed fee in force, in USDC units.
     * @param unlockAt  UNIX time from which `release` may pay it.
     */
    function recordCompletion(
        uint256 orderId,
        uint256 gross,
        uint256 feeBps,
        uint256 feeFixed,
        uint256 unlockAt
    ) external onlyIntegrator {
        if (gross == 0) revert InvalidAmount();
        if (feeBps > 10_000) revert InvalidFeeBps();

        Record storage r = records[orderId];
        if (r.gross != 0) revert AlreadyRecorded();

        uint256 newPending = pendingGross + gross;
        if (usdc().balanceOf(address(this)) < newPending) revert Unfunded();

        r.gross = SafeCast.toUint128(gross);
        r.unlockAt = SafeCast.toUint64(unlockAt);
        r.feeBps = uint16(feeBps);
        r.feeFixed = SafeCast.toUint32(feeFixed);
        pendingGross = newPending;

        emit Recorded(orderId, gross, feeBps, feeFixed, unlockAt);
    }

    // ─── Payout ───────────────────────────────────────────────────────

    /**
     * @notice Permissionless: the keeper, the vendor or anyone may trigger
     *         it, but `net` always goes to `vendor()` (an immutable arg) and
     *         `fee` to the integrator's fee wallet, read now — so rotating
     *         the fee wallet takes effect without touching any clone.
     *
     *         Tolerant of already-released ids: skipped, never paid twice —
     *         also when the same id appears twice in one call. That lets the
     *         keeper and the vendor race on the same orders without either
     *         tx failing. Strict on everything else: an id unknown to THIS
     *         clone (including another vendor's order) or still locked
     *         reverts the whole call.
     *
     *         Fee per order = `feeFixed` + `gross × feeBps / 10 000`, capped
     *         at `gross` (the fixed part may have risen between placement and
     *         completion). ONE division, net by subtraction, so
     *         fee + net == gross exactly and no dust is ever left behind.
     *         At most two transfers per call; a zero side is skipped.
     * @param orderIds  Orders recorded on this clone and already unlocked.
     */
    function release(uint256[] calldata orderIds) external nonReentrant {
        uint256 totalGross = 0;
        uint256 totalFee = 0;

        for (uint256 i = 0; i < orderIds.length; i++) {
            Record storage r = records[orderIds[i]];
            uint256 gross = r.gross;
            if (gross == 0) revert UnknownRecord();
            if (r.released) continue;
            if (block.timestamp < r.unlockAt) revert StillLocked();

            r.released = true;

            uint256 fee = r.feeFixed + (gross * r.feeBps) / 10_000;
            if (fee > gross) fee = gross;
            uint256 net = gross - fee;
            totalGross += gross;
            totalFee += fee;

            emit Released(orderIds[i], net, fee);
        }

        if (totalGross == 0) return;
        pendingGross -= totalGross;

        IERC20 token = usdc();
        uint256 totalNet = totalGross - totalFee;
        if (totalNet > 0) token.safeTransfer(vendor(), totalNet);
        if (totalFee > 0) token.safeTransfer(IFeeWalletSource(integrator()).feeWallet(), totalFee);
    }

    // ─── Views ────────────────────────────────────────────────────────

    /// @notice The record of an order on this clone.
    /// @param orderId  The Diamond's order id.
    /// @return The record; `gross == 0` if not recorded here.
    function getRecord(uint256 orderId) external view returns (Record memory) {
        return records[orderId];
    }
}
