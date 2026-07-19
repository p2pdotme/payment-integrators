// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/**
 * @title ZappUsdcOnrampIntegrator
 * @notice Strict Base-USDC onramp for Zapp smart accounts.
 *
 *         The caller is both the P2P order user and its settlement recipient.
 *         There is no arbitrary recipient parameter: a valid Zapp smart-account
 *         call can only buy USDC for itself. With `usdcThroughIntegrator=false`,
 *         the Diamond transfers completed-order USDC directly to that account.
 *         Neither this contract nor its canonical UserProxy holds BUY proceeds.
 *
 *         Each placement also requires a short-lived EIP-712 authorization from
 *         Zapp's backend. The authorization is an application/risk gate, not a
 *         KYC attestation. It binds the user and every P2P order parameter, while
 *         immutable on-chain per-transaction, daily, and lifetime limits bound
 *         the signer's authority.
 */
contract ZappUsdcOnrampIntegrator is IP2PIntegrator, EIP712 {
    // ─── Errors ───────────────────────────────────────────────────────

    error OnlyDiamond();
    error OnlyOwner();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidLimit();
    error InvalidAuthorization();
    error InvalidAuthorizationSignature();
    error AuthorizationExpired();
    error AuthorizationAlreadyUsed();
    error DailyCountLimitExceeded();
    error DailyVolumeLimitExceeded();
    error LifetimeVolumeLimitExceeded();
    error ContractPaused();
    error OrderValidationMissing();
    error OrderIdAlreadyUsed();

    // ─── Events ───────────────────────────────────────────────────────

    event AuthorizationSignerUpdated(address indexed signer);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event UserProxyDeployed(address indexed user, address proxy);
    event OrderValidated(
        address indexed user,
        uint256 indexed day,
        uint256 usdcAmount,
        bytes32 indexed authorizationId
    );
    event UsdcOnrampOrderCreated(
        uint256 indexed orderId,
        address indexed user,
        uint256 usdcAmount,
        bytes32 currency,
        bytes32 authorizationId
    );
    event UsdcOnrampOrderFulfilled(
        uint256 indexed orderId,
        address indexed user,
        uint256 usdcAmount,
        bytes32 authorizationId
    );
    event UsdcOnrampOrderCancelled(
        uint256 indexed orderId,
        address indexed user,
        uint256 usdcAmount,
        bytes32 authorizationId
    );
    event CompletionCallbackMismatch(
        uint256 indexed orderId,
        address indexed expectedUser,
        address callbackUser,
        uint256 callbackAmount,
        address callbackRecipient
    );

    // ─── EIP-712 ─────────────────────────────────────────────────────

    /// @dev keccak256 of PurchaseAuthorization(address user,uint256 amount,
    ///      bytes32 currency,bytes32 pubKeyHash,uint256 circleId,uint256
    ///      preferredPaymentChannelConfigId,uint256 fiatAmountLimit,uint256
    ///      deadline,bytes32 nonce).
    bytes32 public constant PURCHASE_AUTHORIZATION_TYPEHASH =
        0xb378b8ffb18213b200a9eeeef78311343ddd0ed3eafc789a5c13f8d136054799;

    struct PurchaseAuthorization {
        address user;
        uint256 amount;
        bytes32 currency;
        bytes32 pubKeyHash;
        uint256 circleId;
        uint256 preferredPaymentChannelConfigId;
        uint256 fiatAmountLimit;
        uint256 deadline;
        bytes32 nonce;
    }

    struct Session {
        address user;
        bool fulfilled;
        bool cancelled;
        uint32 placementDay;
        uint256 amount;
        bytes32 authorizationId;
    }

    struct PendingPlacement {
        address user;
        uint256 amount;
        bytes32 currency;
        bytes32 authorizationId;
        bytes32 nonce;
        bool validated;
    }

    // ─── Immutable configuration ─────────────────────────────────────

    address public immutable diamond;
    IERC20 public immutable usdc;
    address public immutable owner;
    address public immutable proxyImpl;
    uint256 public immutable perTxUsdcLimit;
    uint256 public immutable dailyTxCountLimit;
    uint256 public immutable dailyUsdcVolumeLimit;
    uint256 public immutable lifetimeUsdcVolumeLimit;

    // ─── Mutable emergency configuration ─────────────────────────────

    address public authorizationSigner;
    bool public paused;

    // ─── State ────────────────────────────────────────────────────────

    mapping(bytes32 => bool) public usedNonces;
    mapping(address => mapping(uint256 => uint256)) public userDailyCount;
    mapping(address => mapping(uint256 => uint256)) public userDailyVolume;
    mapping(address => uint256) public userLifetimeVolume;
    mapping(uint256 => Session) public sessions;
    PendingPlacement private _pendingPlacement;

    modifier onlyDiamond() {
        if (msg.sender != diamond) revert OnlyDiamond();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    constructor(
        address _diamond,
        address _usdc,
        address _owner,
        address _authorizationSigner,
        uint256 _perTxUsdcLimit,
        uint256 _dailyTxCountLimit,
        uint256 _dailyUsdcVolumeLimit,
        uint256 _lifetimeUsdcVolumeLimit
    ) EIP712("ZappUsdcOnramp", "1") {
        if (
            _diamond == address(0) ||
            _usdc == address(0) ||
            _owner == address(0) ||
            _authorizationSigner == address(0)
        ) revert InvalidAddress();
        if (
            _perTxUsdcLimit == 0 ||
            _dailyTxCountLimit == 0 ||
            _dailyUsdcVolumeLimit < _perTxUsdcLimit ||
            _lifetimeUsdcVolumeLimit < _dailyUsdcVolumeLimit
        ) revert InvalidLimit();

        diamond = _diamond;
        usdc = IERC20(_usdc);
        owner = _owner;
        authorizationSigner = _authorizationSigner;
        perTxUsdcLimit = _perTxUsdcLimit;
        dailyTxCountLimit = _dailyTxCountLimit;
        dailyUsdcVolumeLimit = _dailyUsdcVolumeLimit;
        lifetimeUsdcVolumeLimit = _lifetimeUsdcVolumeLimit;
        proxyImpl = address(new UserProxy());
    }

    // ─── Emergency administration ────────────────────────────────────

    function setAuthorizationSigner(address signer) external onlyOwner {
        if (signer == address(0)) revert InvalidAddress();
        authorizationSigner = signer;
        emit AuthorizationSignerUpdated(signer);
    }

    function pause() external onlyOwner {
        if (paused) return;
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        if (!paused) return;
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ─── Views ────────────────────────────────────────────────────────

    function authorizationId(
        PurchaseAuthorization calldata authorization
    ) public view returns (bytes32) {
        return _hashTypedDataV4(_authorizationStructHash(authorization));
    }

    function proxyAddress(address user) public view returns (address) {
        return
            Clones.predictDeterministicAddressWithImmutableArgs(
                proxyImpl,
                _proxyArgs(user),
                _salt(user),
                address(this)
            );
    }

    function getRemainingDailyCount(address user) external view returns (uint256) {
        uint256 count = userDailyCount[user][_currentDay()];
        if (count >= dailyTxCountLimit) return 0;
        return dailyTxCountLimit - count;
    }

    /** @notice Optional checkout-widget compatibility view. */
    function userTxLimit() external view returns (uint256) {
        return perTxUsdcLimit;
    }

    function getRemainingLifetimeVolume(address user) external view returns (uint256) {
        uint256 volume = userLifetimeVolume[user];
        if (volume >= lifetimeUsdcVolumeLimit) return 0;
        return lifetimeUsdcVolumeLimit - volume;
    }

    function getSession(uint256 orderId) external view returns (Session memory) {
        return sessions[orderId];
    }

    // ─── User-facing onramp ──────────────────────────────────────────

    /**
     * @notice Buy Base USDC for the calling account. The Diamond recipient is
     *         always `msg.sender`; callers cannot redirect settlement.
     */
    function buyUsdc(
        PurchaseAuthorization calldata authorization,
        string calldata pubKey,
        bytes calldata signature
    ) external returns (uint256 orderId) {
        if (paused) revert ContractPaused();
        _validateAuthorizationFields(authorization, pubKey);

        bytes32 id = authorizationId(authorization);
        if (usedNonces[authorization.nonce]) revert AuthorizationAlreadyUsed();
        (address recovered, ECDSA.RecoverError recoverError, ) = ECDSA.tryRecoverCalldata(
            id,
            signature
        );
        if (recoverError != ECDSA.RecoverError.NoError || recovered != authorizationSigner)
            revert InvalidAuthorizationSignature();

        usedNonces[authorization.nonce] = true;
        _pendingPlacement = PendingPlacement({
            user: msg.sender,
            amount: authorization.amount,
            currency: authorization.currency,
            authorizationId: id,
            nonce: authorization.nonce,
            validated: false
        });

        orderId = _placeOrder(authorization, pubKey);
        if (!_pendingPlacement.validated) revert OrderValidationMissing();
        delete _pendingPlacement;

        if (sessions[orderId].user != address(0)) revert OrderIdAlreadyUsed();
        sessions[orderId] = Session({
            user: msg.sender,
            fulfilled: false,
            cancelled: false,
            placementDay: uint32(_currentDay()),
            amount: authorization.amount,
            authorizationId: id
        });

        emit UsdcOnrampOrderCreated(
            orderId,
            msg.sender,
            authorization.amount,
            authorization.currency,
            id
        );
    }

    // ─── IP2PIntegrator callbacks ─────────────────────────────────────

    function validateOrder(
        address user,
        uint256 amount,
        bytes32 currency
    ) external onlyDiamond returns (bool allowed) {
        PendingPlacement storage pending = _pendingPlacement;
        if (
            paused ||
            pending.user == address(0) ||
            pending.validated ||
            pending.user != user ||
            pending.amount != amount ||
            pending.currency != currency ||
            usedNonces[pending.nonce] == false
        ) return false;
        if (amount == 0 || amount > perTxUsdcLimit) return false;

        uint256 day = _currentDay();
        uint256 count = userDailyCount[user][day];
        uint256 dailyVolume = userDailyVolume[user][day];
        uint256 lifetimeVolume = userLifetimeVolume[user];
        if (count >= dailyTxCountLimit) return false;
        if (dailyVolume + amount > dailyUsdcVolumeLimit) return false;
        if (lifetimeVolume + amount > lifetimeUsdcVolumeLimit) return false;

        pending.validated = true;
        userDailyCount[user][day] = count + 1;
        userDailyVolume[user][day] = dailyVolume + amount;
        userLifetimeVolume[user] = lifetimeVolume + amount;
        emit OrderValidated(user, day, amount, pending.authorizationId);
        return true;
    }

    function onOrderComplete(
        uint256 orderId,
        address user,
        uint256 amount,
        address recipientAddr
    ) external onlyDiamond {
        Session storage session = sessions[orderId];
        if (session.user == address(0) || session.fulfilled || session.cancelled) return;
        if (session.user != user || session.amount != amount || recipientAddr != session.user) {
            emit CompletionCallbackMismatch(orderId, session.user, user, amount, recipientAddr);
            return;
        }

        session.fulfilled = true;
        emit UsdcOnrampOrderFulfilled(
            orderId,
            session.user,
            session.amount,
            session.authorizationId
        );
    }

    function onOrderCancel(uint256 orderId) external onlyDiamond {
        Session storage session = sessions[orderId];
        if (session.user == address(0) || session.fulfilled || session.cancelled) return;
        session.cancelled = true;

        uint256 day = uint256(session.placementDay);
        uint256 count = userDailyCount[session.user][day];
        uint256 dailyVolume = userDailyVolume[session.user][day];
        uint256 lifetimeVolume = userLifetimeVolume[session.user];
        if (count > 0) userDailyCount[session.user][day] = count - 1;
        userDailyVolume[session.user][day] = dailyVolume > session.amount
            ? dailyVolume - session.amount
            : 0;
        userLifetimeVolume[session.user] = lifetimeVolume > session.amount
            ? lifetimeVolume - session.amount
            : 0;

        emit UsdcOnrampOrderCancelled(
            orderId,
            session.user,
            session.amount,
            session.authorizationId
        );
    }

    // ─── Internals ────────────────────────────────────────────────────

    function _validateAuthorizationFields(
        PurchaseAuthorization calldata authorization,
        string calldata pubKey
    ) internal view {
        if (
            authorization.user != msg.sender ||
            authorization.currency == bytes32(0) ||
            authorization.circleId == 0 ||
            bytes(pubKey).length == 0 ||
            authorization.pubKeyHash != keccak256(bytes(pubKey)) ||
            authorization.nonce == bytes32(0)
        ) revert InvalidAuthorization();
        if (authorization.amount == 0 || authorization.amount > perTxUsdcLimit) {
            revert InvalidAmount();
        }
        if (authorization.deadline <= block.timestamp) revert AuthorizationExpired();

        uint256 day = _currentDay();
        if (userDailyCount[msg.sender][day] >= dailyTxCountLimit) {
            revert DailyCountLimitExceeded();
        }
        if (userDailyVolume[msg.sender][day] + authorization.amount > dailyUsdcVolumeLimit)
            revert DailyVolumeLimitExceeded();
        if (userLifetimeVolume[msg.sender] + authorization.amount > lifetimeUsdcVolumeLimit)
            revert LifetimeVolumeLimitExceeded();
    }

    function _placeOrder(
        PurchaseAuthorization calldata authorization,
        string calldata pubKey
    ) internal returns (uint256) {
        address proxy = _ensureProxy(msg.sender);
        bytes memory data = abi.encodeCall(
            IB2BGateway.placeB2BOrder,
            (
                msg.sender,
                authorization.amount,
                authorization.currency,
                msg.sender,
                pubKey,
                authorization.circleId,
                authorization.preferredPaymentChannelConfigId,
                authorization.fiatAmountLimit
            )
        );
        bytes memory result = UserProxy(proxy).execute(diamond, data, address(usdc), 0);
        return abi.decode(result, (uint256));
    }

    function _authorizationStructHash(
        PurchaseAuthorization calldata authorization
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    PURCHASE_AUTHORIZATION_TYPEHASH,
                    authorization.user,
                    authorization.amount,
                    authorization.currency,
                    authorization.pubKeyHash,
                    authorization.circleId,
                    authorization.preferredPaymentChannelConfigId,
                    authorization.fiatAmountLimit,
                    authorization.deadline,
                    authorization.nonce
                )
            );
    }

    function _currentDay() internal view returns (uint256) {
        return block.timestamp / 1 days;
    }

    function _salt(address user) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(user)));
    }

    function _proxyArgs(address user) internal view returns (bytes memory) {
        return abi.encodePacked(user, address(this));
    }

    function _ensureProxy(address user) internal returns (address proxy) {
        proxy = proxyAddress(user);
        if (proxy.code.length == 0) {
            address deployed = Clones.cloneDeterministicWithImmutableArgs(
                proxyImpl,
                _proxyArgs(user),
                _salt(user)
            );
            assert(deployed == proxy);
            emit UserProxyDeployed(user, proxy);
        }
    }
}
