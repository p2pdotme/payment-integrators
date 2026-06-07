// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IRestrictedYieldVault } from "./IRestrictedYieldVault.sol";

/**
 * @dev Subset of the Aave V3 Pool interface we need. Production deployment
 *      uses the canonical Aave V3 Pool on Base; tests use a mock that
 *      implements the same shape.
 */
interface IAavePool {
    function supply(
        address asset,
        uint256 amount,
        address onBehalfOf,
        uint16 referralCode
    ) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

/**
 * @title RestrictedYieldVault
 * @notice Custodies USDC for the TradeStars-style flow. Deposits supply
 *         USDC to Aave (via aUSDC) so the principal earns yield while
 *         held. Withdrawals draw down from Aave automatically.
 *
 *         Principal access:
 *           - Owner withdraws up to 40% of principal + 100% of yield.
 *           - Operator (the offramp integrator) can draw up to the vault's
 *             full aUSDC balance to fund SELL orders — there is no cumulative
 *             cap, so offramp volume may exceed onramp (totalPrincipal) when
 *             backed by Aave yield or owner-supplied liquidity (`fund`).
 *             Refunds (cancelled offramps) are returned via `returnFromOfframp`.
 *
 *         P2P fee accrual (accounting only — settled off-chain):
 *           - Onramp volume (deposits) and offramp volume (releases) accrue
 *             a P2P fee at independently owner-configurable rates
 *             (`p2pOnrampBps` / `p2pOfframpBps`, both default 2.5%) into two
 *             ledgers, `p2pOnrampAccrued` and `p2pOfframpAccrued`.
 *           - This is *bookkeeping only*: the vault never pays it out
 *             on-chain and it does NOT reduce the owner's 40% bucket. An
 *             off-chain biller reads the ledgers / `p2pAccrued()` (and the
 *             `P2PFeeAccrued` event stream) to invoice the TradeStars
 *             owner, who settles the bill off-chain monthly.
 *           - The offramp ledger ticks up on `releaseForOfframp` and down
 *             on `returnFromOfframp` (cancelled offramp refund) so it
 *             reflects net completed offramp volume. Reversals use the
 *             offramp rate in force at refund time, so prefer changing
 *             rates when no offramps are in flight (the event stream
 *             records the exact per-move fee regardless).
 */
contract RestrictedYieldVault is IRestrictedYieldVault {
    using SafeERC20 for IERC20;

    error OnlyOwner();
    error OnlyOperator();
    error OnlyPendingOwner();
    error InvalidAddress();
    error InvalidAmount();
    error ExceedsOwnerQuota();
    /// @notice Owner's 40% quota is theoretical and computed against
    ///         `totalPrincipal`. The pool is shared with the offramp
    ///         operator (which can draw the full balance), so the actual
    ///         aUSDC balance may be below the owner's quota when offramp
    ///         activity has drained the vault. This error is raised when
    ///         the request is inside the quota but exceeds the on-chain
    ///         balance — distinct from `ExceedsOwnerQuota`, which means the
    ///         owner asked above 40% in the first place.
    error InsufficientFunds();
    /// @notice `setP2PFeeBps` given a rate above `MAX_P2P_BPS`.
    error InvalidFeeBps();

    event Deposited(address indexed from, uint256 amount, uint256 newPrincipal);
    event OwnerWithdrew(
        address indexed to,
        uint256 amount,
        uint256 fromYield,
        uint256 fromPrincipal
    );
    event OfframpReleased(address indexed operator, uint256 amount);
    event OfframpReturned(address indexed operator, uint256 amount);
    /// @notice Emitted when the owner injects extra offramp liquidity via
    ///         `fund` — not counted as onramp volume, so no P2P fee accrues.
    event Funded(address indexed from, uint256 amount);
    /// @notice Emitted when the current owner nominates a new owner. The
    ///         nominee must call `acceptOwnership` to complete the transfer.
    event OwnerProposed(address indexed proposed);
    event OwnerUpdated(address indexed newOwner);
    event OperatorUpdated(address indexed newOperator);
    /// @notice Emitted when a P2P fee ledger moves. `isCredit` is true when
    ///         the ledger ticked up (deposit / release), false when it
    ///         ticked down (cancelled-offramp refund). `isOfframp` selects
    ///         the leg: false = onramp ledger, true = offramp ledger. The
    ///         off-chain biller reconstructs the running bill from this
    ///         event stream.
    event P2PFeeAccrued(uint256 volume, uint256 fee, bool isCredit, bool isOfframp);
    /// @notice Emitted when the owner updates the onramp/offramp fee rates.
    event P2PFeeBpsUpdated(uint256 onrampBps, uint256 offrampBps);

    IERC20 public immutable usdc;
    IERC20 public immutable aUsdc;
    IAavePool public immutable aave;
    /// @notice Bps (out of 10_000) cap on the owner's *cumulative* principal
    ///         withdrawals. Not a reservation — the operator may draw the
    ///         vault's full balance for offramps, so this bounds the owner's
    ///         total exposure, not their instantaneous availability.
    uint256 public constant OWNER_PRINCIPAL_BPS = 4000; // 40%
    /// @notice Hard ceiling on the configurable P2P fee rates (100%).
    uint256 public constant MAX_P2P_BPS = 10_000;

    address public owner;
    /// @notice 2-step ownership transfer: the proposed owner must call
    ///         `acceptOwnership` to complete the rotation. Closes the typo
    ///         risk that would otherwise brick the vault (custody-bearing
    ///         contract).
    address public pendingOwner;
    address public offrampOperator;

    /// @notice Owner-configurable P2P fee rates (bps out of 10_000),
    ///         independent per leg. Both default to 2.5%. Accounting only —
    ///         settled off-chain, never touches on-chain quotas.
    uint256 public p2pOnrampBps = 250; // 2.5%
    uint256 public p2pOfframpBps = 250; // 2.5%

    uint256 public override totalPrincipal;
    uint256 public override ownerWithdrawnPrincipal;
    uint256 public override offrampWithdrawn;
    /// @notice Running onramp (deposit) fee ledger.
    uint256 public p2pOnrampAccrued;
    /// @notice Running offramp (release) fee ledger, net of cancelled
    ///         offramp refunds. Clamped to zero if returns ever exceed
    ///         prior credits.
    uint256 public p2pOfframpAccrued;

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != offrampOperator) revert OnlyOperator();
        _;
    }

    constructor(address _usdc, address _aUsdc, address _aave) {
        if (_usdc == address(0) || _aUsdc == address(0) || _aave == address(0))
            revert InvalidAddress();
        usdc = IERC20(_usdc);
        aUsdc = IERC20(_aUsdc);
        aave = IAavePool(_aave);
        owner = msg.sender;
    }

    // ─── Deposits ────────────────────────────────────────────────────

    function deposit(uint256 amount) external {
        if (amount == 0) revert InvalidAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        totalPrincipal += amount;
        usdc.forceApprove(address(aave), amount);
        aave.supply(address(usdc), amount, address(this), 0);
        _creditOnrampFee(amount);
        emit Deposited(msg.sender, amount, totalPrincipal);
    }

    /// @notice Owner-only. Supply USDC as extra offramp liquidity WITHOUT
    ///         counting it as onramp volume — no P2P fee accrues and
    ///         `totalPrincipal` is unchanged. The funded amount surfaces as
    ///         `getYield` (balance above principal), so the owner can reclaim
    ///         any unused portion via `ownerWithdraw` (yield is paid out
    ///         before principal), while it stays fully available to the
    ///         operator for offramp settlement. Use this to back offramps
    ///         that exceed onramp volume (e.g. users won more than they
    ///         onramped).
    function fund(uint256 amount) external onlyOwner {
        if (amount == 0) revert InvalidAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        usdc.forceApprove(address(aave), amount);
        aave.supply(address(usdc), amount, address(this), 0);
        emit Funded(msg.sender, amount);
    }

    // ─── Owner withdraw ──────────────────────────────────────────────

    function ownerWithdraw(uint256 amount) external onlyOwner {
        if (amount == 0) revert InvalidAmount();

        uint256 yield = getYield();
        uint256 principalQuota = (totalPrincipal * OWNER_PRINCIPAL_BPS) / 10_000;
        uint256 remainingPrincipalQuota = principalQuota > ownerWithdrawnPrincipal
            ? principalQuota - ownerWithdrawnPrincipal
            : 0;
        uint256 maxWithdraw = remainingPrincipalQuota + yield;
        if (amount > maxWithdraw) revert ExceedsOwnerQuota();

        // Since the offramp operator can drain the full balance, the
        // theoretical quota may exceed the actual aUSDC balance.
        // Surface that as a clean revert instead of letting the call
        // reach Aave and fail with an opaque low-level error.
        if (amount > aUsdc.balanceOf(address(this))) revert InsufficientFunds();

        // Yield first, then principal.
        uint256 fromYield = amount > yield ? yield : amount;
        uint256 fromPrincipal = amount - fromYield;
        ownerWithdrawnPrincipal += fromPrincipal;

        aave.withdraw(address(usdc), amount, msg.sender);
        emit OwnerWithdrew(msg.sender, amount, fromYield, fromPrincipal);
    }

    // ─── Offramp operator pull / refund ──────────────────────────────

    function releaseForOfframp(uint256 amount) external onlyOperator {
        if (amount == 0) revert InvalidAmount();
        // No cumulative cap: offramp is bounded only by the vault's live
        // aUSDC balance. Net offramp volume MAY exceed cumulative onramp
        // (totalPrincipal) when funded by Aave yield or owner-supplied
        // liquidity (`fund`) — e.g. when users won more than they onramped.
        if (amount > aUsdc.balanceOf(address(this))) revert InsufficientFunds();
        offrampWithdrawn += amount;
        aave.withdraw(address(usdc), amount, msg.sender);
        _creditOfframpFee(amount);
        emit OfframpReleased(msg.sender, amount);
    }

    function returnFromOfframp(uint256 amount) external onlyOperator {
        if (amount == 0) revert InvalidAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        // Net offrampWithdrawn back down. Excess returns (paying back more
        // than was pulled, e.g. yield via Aave between cycles) are tolerated
        // by clamping at zero.
        offrampWithdrawn = amount > offrampWithdrawn ? 0 : offrampWithdrawn - amount;
        usdc.forceApprove(address(aave), amount);
        aave.supply(address(usdc), amount, address(this), 0);
        // Reverse the offramp fee accrual for the cancelled portion so the
        // off-chain bill only reflects net completed offramp volume.
        _debitOfframpFee(amount);
        emit OfframpReturned(msg.sender, amount);
    }

    // ─── Admin ───────────────────────────────────────────────────────

    function setOfframpOperator(address op) external onlyOwner {
        if (op == address(0)) revert InvalidAddress();
        offrampOperator = op;
        emit OperatorUpdated(op);
    }

    /// @notice Nominate a new owner. The nominee becomes owner only after
    ///         they call `acceptOwnership` from the proposed address — a
    ///         one-step transfer to a wrong address would brick the vault
    ///         (it holds principal + accrues yield from Aave).
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        pendingOwner = newOwner;
        emit OwnerProposed(newOwner);
    }

    /// @notice Complete a pending ownership transfer. Caller must be the
    ///         address nominated via `transferOwnership` — proves they
    ///         control the destination key.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert OnlyPendingOwner();
        address newOwner = pendingOwner;
        owner = newOwner;
        pendingOwner = address(0);
        emit OwnerUpdated(newOwner);
    }

    // ─── P2P fee ledger (accounting only) ─────────────────────────────

    /// @notice Owner sets the per-leg P2P fee rates (bps out of 10_000).
    ///         Takes effect for volume accrued after the call; in-flight
    ///         offramps reverse at the new rate, so prefer quiet windows.
    function setP2PFeeBps(uint256 onrampBps, uint256 offrampBps) external onlyOwner {
        if (onrampBps > MAX_P2P_BPS || offrampBps > MAX_P2P_BPS) revert InvalidFeeBps();
        p2pOnrampBps = onrampBps;
        p2pOfframpBps = offrampBps;
        emit P2PFeeBpsUpdated(onrampBps, offrampBps);
    }

    /// @dev Accrue the onramp fee on deposit `volume`. Bookkeeping only.
    function _creditOnrampFee(uint256 volume) internal {
        uint256 fee = (volume * p2pOnrampBps) / 10_000;
        if (fee == 0) return;
        p2pOnrampAccrued += fee;
        emit P2PFeeAccrued(volume, fee, true, false);
    }

    /// @dev Accrue the offramp fee on release `volume`. Bookkeeping only.
    function _creditOfframpFee(uint256 volume) internal {
        uint256 fee = (volume * p2pOfframpBps) / 10_000;
        if (fee == 0) return;
        p2pOfframpAccrued += fee;
        emit P2PFeeAccrued(volume, fee, true, true);
    }

    /// @dev Reverse the offramp fee when `volume` is refunded on cancel.
    ///      Clamps at zero if returns ever exceed prior credits.
    function _debitOfframpFee(uint256 volume) internal {
        uint256 fee = (volume * p2pOfframpBps) / 10_000;
        if (fee == 0) return;
        p2pOfframpAccrued = fee > p2pOfframpAccrued ? 0 : p2pOfframpAccrued - fee;
        emit P2PFeeAccrued(volume, fee, false, true);
    }

    /// @notice Total P2P fee accrued across both legs, net of cancelled
    ///         offramps. Convenience sum of the two ledgers for the bill.
    function p2pAccrued() external view override returns (uint256) {
        return p2pOnrampAccrued + p2pOfframpAccrued;
    }

    // ─── Views ───────────────────────────────────────────────────────

    function getYield() public view returns (uint256) {
        uint256 bal = aUsdc.balanceOf(address(this));
        return bal > totalPrincipal ? bal - totalPrincipal : 0;
    }

    /// @notice Effective USDC the owner can withdraw right now — the
    ///         theoretical (40% + yield) headroom bounded by the actual
    ///         aUSDC balance. Off-chain callers should treat this as a
    ///         hard ceiling; the on-chain function distinguishes the
    ///         two failure modes via `ExceedsOwnerQuota` vs
    ///         `InsufficientFunds`.
    function ownerQuota() external view returns (uint256) {
        uint256 principalQuota = (totalPrincipal * OWNER_PRINCIPAL_BPS) / 10_000;
        uint256 remaining = principalQuota > ownerWithdrawnPrincipal
            ? principalQuota - ownerWithdrawnPrincipal
            : 0;
        uint256 theoretical = remaining + getYield();
        uint256 bal = aUsdc.balanceOf(address(this));
        return theoretical < bal ? theoretical : bal;
    }

    /// @notice USDC the operator can release right now — simply the vault's
    ///         live aUSDC balance. Offramp has no cumulative cap, so it may
    ///         draw yield and owner-funded liquidity, not just principal.
    function offrampQuota() public view returns (uint256) {
        return aUsdc.balanceOf(address(this));
    }
}
