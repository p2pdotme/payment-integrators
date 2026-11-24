// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { MockDiamond } from "./MockDiamond.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/**
 * @notice MockDiamond plus the merchant-side surface CashbookRampIntegrator calls:
 *         registerFor / stakeFor (an integrator opening or topping up someone
 *         else's merchant account, pulling the USDC from the integrator), the
 *         merchant read, the stake floor, the max buy, the merchant blacklist,
 *         the unstake flag and the order's integrator.
 *
 *         registerFor / stakeFor are not on contracts-v4 `dev` yet (they are
 *         proposed in p2pdotme/contracts-v4 "feat(onboard): let anyone register
 *         or stake for a merchant"). Their reverts here mirror that branch:
 *         MerchantAlreadyRegistered on a second register, StakeAmountTooLow below
 *         the floor, RegistrationNotSigned without the merchant's EIP-712
 *         signature over registrationDigest (same domain and type as #518:
 *         "P2PMerchantRegistration" v1, this chain, this contract; anyone may
 *         call registerFor with it), and only an active integrator may call
 *         stakeFor. Both also apply _stake's own checks: the merchant
 *         blacklist, a pending unstake, and stake + amount at least the floor
 *         (a top-up too).
 *
 *         NOT modelled: the Diamond's shared reentrancy lock. On the real
 *         Diamond, completeOrder holds it while it calls onOrderComplete, so a
 *         registerFor from inside the hook reverts. This mock would allow it,
 *         which is why the integrator's own design (record in the hook, stake in
 *         a second transaction) is proven on a fork, not here.
 */
contract MockCashbookDiamond is MockDiamond {
    using SafeERC20 for IERC20;

    error NotActiveIntegrator();
    error RegistrationNotSigned();
    error MerchantAlreadyRegistered();
    error MerchantNotRegistered();
    error StakeAmountTooLow();
    error CurrencyMismatch();
    error MerchantBlacklisted();
    error UnstakeRequestPending();

    struct MerchantDetails {
        uint256 stake;
        bool isOnline;
        uint256 totalVolume;
        uint256 withdrawnAmount;
        uint256 lastVolumeResetTimestamp;
        uint256 accruedFees;
        bool isRegistered;
        bytes32 currency;
    }

    struct StakeConfigHead {
        uint256 minCircleAdminP2PStake;
        uint256 minMerchantUSDCStake;
    }

    mapping(address => MerchantDetails) internal merchants;
    mapping(address => uint256) public merchantCircle;
    mapping(bytes32 => uint256) public floorOf;
    mapping(bytes32 => uint256) public maxBuyOf;
    mapping(bytes32 => uint256) public maxSellOf;
    mapping(address => bool) public merchantBlacklisted;
    mapping(address => bool) public unstakeRequested;

    /// @notice A call made back into `reenterTarget` from inside the Diamond
    ///         calls the integrator makes mid-transaction, to prove its guard.
    address public reenterTarget;
    bytes public reenterData;

    event MockRegisteredFor(address merchant, uint256 circleId, uint256 stake, bytes32 currency);
    event MockStakedFor(address merchant, uint256 amount, bytes32 currency);

    constructor(address _usdc) MockDiamond(_usdc) {}

    // ─── Test setters ─────────────────────────────────────────────────

    function setFloor(bytes32 currency, uint256 floor) external {
        floorOf[currency] = floor;
    }

    function setMaxBuy(bytes32 currency, uint256 max) external {
        maxBuyOf[currency] = max;
    }

    function setMaxSell(bytes32 currency, uint256 max) external {
        maxSellOf[currency] = max;
    }

    function setMerchantBlacklisted(address merchant, bool v) external {
        merchantBlacklisted[merchant] = v;
    }

    function setUnstakeRequested(address merchant, bool v) external {
        unstakeRequested[merchant] = v;
    }

    /// @notice An account opened somewhere else (merchant-app, another integrator).
    function setMerchant(address merchant, uint256 stake, bytes32 currency) external {
        merchants[merchant] = MerchantDetails(stake, true, 0, 0, 0, 0, true, currency);
    }

    /// @notice Rewrite a BUY's recipient, to model an order no honest path makes.
    function setOrderRecipient(uint256 orderId, address recipientAddr) external {
        orders[orderId].recipientAddr = recipientAddr;
    }

    /// @notice Every call below that the integrator makes while holding its
    ///         reentrancy guard calls `target` with `data` first. 0 turns it off.
    function setReenter(address target, bytes calldata data) external {
        reenterTarget = target;
        reenterData = data;
    }

    /// @dev A static call, so the view functions can use it too. The guard
    ///      refuses before any state change, so it answers a static call the
    ///      same as a call; the refusal is bubbled up unchanged.
    function _reenter() internal view {
        if (reenterTarget == address(0)) return;
        (bool ok, bytes memory r) = reenterTarget.staticcall(reenterData);
        if (!ok) {
            assembly {
                revert(add(r, 32), mload(r))
            }
        }
    }

    // ─── The surface the integrator calls ─────────────────────────────

    function registrationDigest(
        address merchant,
        uint256 circleId,
        bytes32 currency,
        string memory telegramId
    ) public view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("P2PMerchantRegistration")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "RegisterFor(address merchant,uint256 circleId,bytes32 currency,string telegramId)"
                ),
                merchant,
                circleId,
                currency,
                keccak256(bytes(telegramId))
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function registerFor(
        address merchant,
        uint256 circleId,
        uint256 stakeAmount,
        string calldata telegramId,
        bytes32 currency,
        bytes calldata signature
    ) external {
        _reenter();
        if (
            !SignatureChecker.isValidSignatureNow(
                merchant,
                registrationDigest(merchant, circleId, currency, telegramId),
                signature
            )
        ) revert RegistrationNotSigned();
        if (merchants[merchant].isRegistered) revert MerchantAlreadyRegistered();
        if (merchantBlacklisted[merchant]) revert MerchantBlacklisted();
        if (stakeAmount < floorOf[currency]) revert StakeAmountTooLow();
        usdc.safeTransferFrom(msg.sender, address(this), stakeAmount);
        merchants[merchant] = MerchantDetails(stakeAmount, true, 0, 0, 0, 0, true, currency);
        merchantCircle[merchant] = circleId;
        emit MockRegisteredFor(merchant, circleId, stakeAmount, currency);
    }

    function stakeFor(address merchant, uint256 stakeAmount, bytes32 currency) external {
        _reenter();
        if (!activeIntegrators[msg.sender]) revert NotActiveIntegrator();
        MerchantDetails storage m = merchants[merchant];
        if (!m.isRegistered) revert MerchantNotRegistered();
        if (merchantBlacklisted[merchant]) revert MerchantBlacklisted();
        if (unstakeRequested[merchant]) revert UnstakeRequestPending();
        if (m.stake + stakeAmount < floorOf[currency]) revert StakeAmountTooLow();
        if (m.currency != currency) revert CurrencyMismatch();
        usdc.safeTransferFrom(msg.sender, address(this), stakeAmount);
        m.stake += stakeAmount;
        emit MockStakedFor(merchant, stakeAmount, currency);
    }

    function getMerchantDetails(address merchant) external view returns (MerchantDetails memory) {
        return merchants[merchant];
    }

    function getStakeConfig(bytes32 currency) external view returns (StakeConfigHead memory) {
        return StakeConfigHead(0, floorOf[currency]);
    }

    function getMaxBuyTxLimit(bytes32 currency) external view returns (uint256) {
        _reenter();
        return maxBuyOf[currency];
    }

    function getMaxSellTxLimit(bytes32 currency) external view returns (uint256) {
        _reenter();
        return maxSellOf[currency];
    }

    function isBlacklisted(address merchant) external view returns (bool) {
        return merchantBlacklisted[merchant];
    }

    function getUnstakeRequested(address merchant) external view returns (bool) {
        return unstakeRequested[merchant];
    }

    function getOrderIntegrator(uint256 orderId) external view returns (address) {
        _reenter();
        return orders[orderId].integrator;
    }

    /// @dev Mirrors the Diamond's OrderFlowHelper.getDayKey (ts / 1 days).
    function getDayKey(uint256 ts) external pure returns (uint256) {
        return ts / 1 days;
    }
}
