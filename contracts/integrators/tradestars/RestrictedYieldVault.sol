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
 *           - Operator (the offramp integrator) can draw up to 100% of
 *             principal to fund SELL orders. Refunds (cancelled offramps)
 *             are returned via `returnFromOfframp`.
 *
 *         P2P entitlement share:
 *           - 2.5% of cumulative onramp + offramp volume accrues to a
 *             P2P-controlled beneficiary, withdrawable via `p2pWithdraw`.
 *           - The P2P share is *part of* the owner's 40% bucket, not
 *             additional to it: combined `ownerWithdrawnPrincipal +
 *             p2pWithdrawn` cannot exceed 40% × principal.
 *           - `p2pEntitled` ticks up on `deposit` and `releaseForOfframp`,
 *             and ticks down on `returnFromOfframp` (cancelled offramp
 *             refund) so the accumulator reflects net completed volume.
 */
contract RestrictedYieldVault is IRestrictedYieldVault {
    using SafeERC20 for IERC20;

    error OnlyOwner();
    error OnlyOperator();
    error OnlyPendingOwner();
    error InvalidAddress();
    error InvalidAmount();
    error ExceedsOwnerQuota();
    error ExceedsOfframpQuota();
    /// @notice Owner's 40% quota is theoretical and computed against
    ///         `totalPrincipal`. The pool is shared with the offramp
    ///         operator (which can draw up to 100% of principal), so the
    ///         actual aUSDC balance may be below the owner's quota when
    ///         offramp activity has drained the vault. This error is
    ///         raised when the request is inside the quota but exceeds
    ///         the on-chain balance — distinct from `ExceedsOwnerQuota`,
    ///         which means the owner asked above 40% in the first place.
    error InsufficientFunds();
    /// @notice `p2pWithdraw` caller is not the configured beneficiary.
    error OnlyP2PBeneficiary();
    /// @notice `p2pWithdraw` requested more than the accrued net share.
    error ExceedsP2PEntitlement();
    /// @notice `setP2PBeneficiary` called when one is already configured.
    ///         The setter is one-shot to preserve the trust assumption
    ///         that the recipient cannot be redirected after the vault
    ///         starts accruing entitlement.
    error P2PBeneficiaryAlreadySet();

    event Deposited(address indexed from, uint256 amount, uint256 newPrincipal);
    event OwnerWithdrew(
        address indexed to,
        uint256 amount,
        uint256 fromYield,
        uint256 fromPrincipal
    );
    event OfframpReleased(address indexed operator, uint256 amount);
    event OfframpReturned(address indexed operator, uint256 amount);
    /// @notice Emitted when the current owner nominates a new owner. The
    ///         nominee must call `acceptOwnership` to complete the transfer.
    event OwnerProposed(address indexed proposed);
    event OwnerUpdated(address indexed newOwner);
    event OperatorUpdated(address indexed newOperator);
    /// @notice Emitted when P2P entitlement accrues on deposit/release, or
    ///         is reversed on returnFromOfframp. `delta` is signed via
    ///         `isCredit`: true = ticked up, false = ticked down.
    event P2PEntitlementUpdated(uint256 volume, uint256 share, bool isCredit);
    event P2PWithdrew(address indexed to, uint256 amount);
    event P2PBeneficiarySet(address indexed beneficiary);

    IERC20 public immutable usdc;
    IERC20 public immutable aUsdc;
    IAavePool public immutable aave;
    /// @notice Bps (out of 10_000) of `totalPrincipal` reserved for the
    ///         owner's withdrawal quota. The rest backs the offramp pool.
    uint256 public constant OWNER_PRINCIPAL_BPS = 4000; // 40%
    /// @notice Bps (out of 10_000) of cumulative onramp + offramp volume
    ///         that accrues to P2P. Lives inside the owner's 40% bucket
    ///         (i.e., counts against `OWNER_PRINCIPAL_BPS`, doesn't add to it).
    uint256 public constant P2P_BPS = 250; // 2.5%

    address public owner;
    /// @notice 2-step ownership transfer: the proposed owner must call
    ///         `acceptOwnership` to complete the rotation. Closes the typo
    ///         risk that would otherwise brick the vault (custody-bearing
    ///         contract).
    address public pendingOwner;
    address public offrampOperator;
    /// @notice Recipient of accrued P2P share. May be address(0) at deploy
    ///         (entitlement still accrues correctly); set once via
    ///         `setP2PBeneficiary` once the P2P address is known.
    address public p2pBeneficiary;

    uint256 public override totalPrincipal;
    uint256 public override ownerWithdrawnPrincipal;
    uint256 public override offrampWithdrawn;
    /// @notice Cumulative 2.5% accrual against deposit + release volume,
    ///         net of returned-on-cancel volume. Monotonic intent — clamped
    ///         to zero on the (degenerate) case where returns exceed prior
    ///         credits.
    uint256 public p2pEntitled;
    /// @notice Cumulative USDC withdrawn to the beneficiary via `p2pWithdraw`.
    uint256 public p2pWithdrawn;

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != offrampOperator) revert OnlyOperator();
        _;
    }

    constructor(address _usdc, address _aUsdc, address _aave, address _p2pBeneficiary) {
        if (_usdc == address(0) || _aUsdc == address(0) || _aave == address(0))
            revert InvalidAddress();
        usdc = IERC20(_usdc);
        aUsdc = IERC20(_aUsdc);
        aave = IAavePool(_aave);
        owner = msg.sender;
        // p2pBeneficiary may be address(0) at construction — entitlement
        // still accrues, but `p2pWithdraw` reverts until set. Allows the
        // vault to be deployed before the P2P treasury address is known.
        if (_p2pBeneficiary != address(0)) {
            p2pBeneficiary = _p2pBeneficiary;
            emit P2PBeneficiarySet(_p2pBeneficiary);
        }
    }

    // ─── Deposits ────────────────────────────────────────────────────

    function deposit(uint256 amount) external {
        if (amount == 0) revert InvalidAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        totalPrincipal += amount;
        usdc.forceApprove(address(aave), amount);
        aave.supply(address(usdc), amount, address(this), 0);
        _creditP2P(amount);
        emit Deposited(msg.sender, amount, totalPrincipal);
    }

    // ─── Owner withdraw ──────────────────────────────────────────────

    function ownerWithdraw(uint256 amount) external onlyOwner {
        if (amount == 0) revert InvalidAmount();

        uint256 yield = getYield();
        uint256 principalQuota = (totalPrincipal * OWNER_PRINCIPAL_BPS) / 10_000;
        // Owner and P2P share the 40% principal bucket. Combined cumulative
        // principal draws cannot exceed the bucket.
        uint256 combinedDrawn = ownerWithdrawnPrincipal + p2pWithdrawn;
        uint256 remainingPrincipalQuota = principalQuota > combinedDrawn
            ? principalQuota - combinedDrawn
            : 0;
        uint256 maxWithdraw = remainingPrincipalQuota + yield;
        if (amount > maxWithdraw) revert ExceedsOwnerQuota();

        // Since the offramp operator can drain up to 100% of principal,
        // the theoretical quota may exceed the actual aUSDC balance.
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
        // Quota check uses the raw principal headroom rather than
        // `offrampQuota()` so the two failure modes stay distinguishable:
        // ExceedsOfframpQuota means the operator asked above cumulative
        // principal drawn, InsufficientFunds means the owner has pulled
        // their 40% and there isn't enough liquid balance to service this.
        uint256 q = totalPrincipal > offrampWithdrawn ? totalPrincipal - offrampWithdrawn : 0;
        if (amount > q) revert ExceedsOfframpQuota();
        if (amount > aUsdc.balanceOf(address(this))) revert InsufficientFunds();
        offrampWithdrawn += amount;
        aave.withdraw(address(usdc), amount, msg.sender);
        _creditP2P(amount);
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
        // Reverse the P2P credit for the cancelled portion. If P2P already
        // withdrew against this volume, `p2pEntitled` ticks down below
        // `p2pWithdrawn`; `p2pAvailable()` clamps to zero and P2P has to
        // earn the balance back from future net volume.
        _debitP2P(amount);
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

    // ─── P2P entitlement ─────────────────────────────────────────────

    function _creditP2P(uint256 volume) internal {
        uint256 share = (volume * P2P_BPS) / 10_000;
        if (share == 0) return;
        p2pEntitled += share;
        emit P2PEntitlementUpdated(volume, share, true);
    }

    function _debitP2P(uint256 volume) internal {
        uint256 share = (volume * P2P_BPS) / 10_000;
        if (share == 0) return;
        p2pEntitled = share > p2pEntitled ? 0 : p2pEntitled - share;
        emit P2PEntitlementUpdated(volume, share, false);
    }

    /// @notice One-shot setter for the P2P beneficiary, used when the
    ///         vault was deployed before the address was known. Callable
    ///         by owner only, and only while `p2pBeneficiary` is unset —
    ///         once set, the recipient cannot be redirected, preserving
    ///         the "no rug-pull of accrued P2P share" invariant.
    function setP2PBeneficiary(address b) external onlyOwner {
        if (p2pBeneficiary != address(0)) revert P2PBeneficiaryAlreadySet();
        if (b == address(0)) revert InvalidAddress();
        p2pBeneficiary = b;
        emit P2PBeneficiarySet(b);
    }

    /// @notice Withdraw accrued P2P share. Bounded by the unclaimed
    ///         entitlement, the available aUSDC balance, and the
    ///         owner-side 40% bucket (which P2P shares).
    function p2pWithdraw(uint256 amount) external {
        if (msg.sender != p2pBeneficiary) revert OnlyP2PBeneficiary();
        if (amount == 0) revert InvalidAmount();

        uint256 available = p2pEntitled > p2pWithdrawn ? p2pEntitled - p2pWithdrawn : 0;
        if (amount > available) revert ExceedsP2PEntitlement();

        // Sharing the 40% bucket with the owner — neither side can push
        // combined principal draws above the cap. If owner has already
        // taken their share, P2P waits for more onramps to grow the cap.
        uint256 principalQuota = (totalPrincipal * OWNER_PRINCIPAL_BPS) / 10_000;
        uint256 combinedDrawn = ownerWithdrawnPrincipal + p2pWithdrawn;
        uint256 remainingBucket = principalQuota > combinedDrawn
            ? principalQuota - combinedDrawn
            : 0;
        if (amount > remainingBucket) revert ExceedsOwnerQuota();

        if (amount > aUsdc.balanceOf(address(this))) revert InsufficientFunds();

        p2pWithdrawn += amount;
        aave.withdraw(address(usdc), amount, msg.sender);
        emit P2PWithdrew(msg.sender, amount);
    }

    /// @notice Effective USDC the P2P beneficiary can withdraw right now —
    ///         the accrued net entitlement, bounded by the owner's
    ///         shared bucket and the actual aUSDC balance.
    function p2pAvailable() external view returns (uint256) {
        uint256 entitled = p2pEntitled > p2pWithdrawn ? p2pEntitled - p2pWithdrawn : 0;

        uint256 principalQuota = (totalPrincipal * OWNER_PRINCIPAL_BPS) / 10_000;
        uint256 combinedDrawn = ownerWithdrawnPrincipal + p2pWithdrawn;
        uint256 remainingBucket = principalQuota > combinedDrawn
            ? principalQuota - combinedDrawn
            : 0;

        uint256 bound = entitled < remainingBucket ? entitled : remainingBucket;
        uint256 bal = aUsdc.balanceOf(address(this));
        return bound < bal ? bound : bal;
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
        uint256 combinedDrawn = ownerWithdrawnPrincipal + p2pWithdrawn;
        uint256 remaining = principalQuota > combinedDrawn ? principalQuota - combinedDrawn : 0;
        uint256 theoretical = remaining + getYield();
        uint256 bal = aUsdc.balanceOf(address(this));
        return theoretical < bal ? theoretical : bal;
    }

    /// @notice Effective USDC the operator can release right now — the
    ///         remaining principal headroom (totalPrincipal − offrampWithdrawn)
    ///         bounded by the actual aUSDC balance.
    function offrampQuota() public view returns (uint256) {
        uint256 q = totalPrincipal > offrampWithdrawn ? totalPrincipal - offrampWithdrawn : 0;
        uint256 bal = aUsdc.balanceOf(address(this));
        return q < bal ? q : bal;
    }
}
