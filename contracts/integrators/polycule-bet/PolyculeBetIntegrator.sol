// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IReputationManager } from "../../interfaces/IReputationManager.sol";
import { UserProxy } from "../../base/UserProxy.sol";

/**
 * @title PolyculeBetIntegrator
 * @notice p2p.me B2B on-ramp integrator for polycule.bet. Pins each user's
 *         USDC settlement destination on-chain so settled funds can only ever
 *         land at a pre-mapped address (the user's Polymarket bridge deposit
 *         address on Base). Polymarket's off-chain daemon then auto-bridges to
 *         Polygon and mints pUSD into the user's Polymarket Safe so the user
 *         can trade on Polymarket immediately after the fiat leg settles.
 *
 *         Registered with the Diamond as `usdcThroughIntegrator = true`: the
 *         Diamond transfers USDC to this contract on completion, and
 *         `onOrderComplete` forwards it to the currently mapped recipient.
 *         The per-user `UserProxy` is only used at placement time so the
 *         Diamond's CREATE2-auth recognises a per-user msg.sender — there is
 *         no client-delivery callback into the proxy.
 *
 *         Trust model: the recipient mapping is written by a custodial
 *         `registrar` key (HSM/KMS-bound) that polycule.bet's worker holds.
 *         The registrar only writes after the user passes off-chain auth
 *         (thirdweb JWT) AND the user's Polymarket bridge address has been
 *         derived. The `owner` is a multisig held by polycule.bet and only
 *         rotates the registrar / pulls funds stranded by a settlement-time
 *         revert / maintains the blocklist.
 *
 *         Blocking: the Diamond skips its user blacklist on B2B orders and
 *         leaves the check to `validateOrder`. This integrator refuses to
 *         place orders for a wallet that is blacklisted on the p2p.me
 *         ReputationManager (the same flag that blocks consumer BUY orders)
 *         or on this contract's own owner-set `blocked` list. Settlement is
 *         never gated: an order that was placed can still complete and pay out.
 */
contract PolyculeBetIntegrator is IP2PIntegrator, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Immutables ───────────────────────────────────────────────────

    /// @notice p2p.me Diamond (B2B gateway).
    address public immutable diamond;

    /// @notice USDC token the Diamond pays this contract. Exposed publicly so
    ///         the canonical `UserProxy` can resolve it via `IUsdcSource` for
    ///         its USDC-sweep block (see contracts/base/UserProxy.sol).
    IERC20 public immutable usdc;

    /// @notice Canonical `UserProxy` implementation cloned per user via
    ///         CREATE2 + immutable args = `[owner, integrator]`. Deployed once
    ///         in the constructor. Submit this address alongside the integrator
    ///         address when filing the whitelist request — the Diamond pins
    ///         it in the `registerIntegrator` record for CREATE2 auth.
    address public immutable proxyImpl;

    /// @notice Admin key. Set at construction and not transferable — keep it
    ///         on a multisig.
    address public immutable owner;

    // ─── Storage ──────────────────────────────────────────────────────

    /// @notice The only address allowed to write `bridgeRecipientOf`. In
    ///         production this is the polycule.bet worker key that pushes the
    ///         Polymarket-derived bridge address after a user finishes
    ///         off-chain (thirdweb JWT) auth.
    address public registrar;

    /// @notice Per-user pinned settlement destination. `userPlaceOrder`
    ///         reverts if the caller has no entry; `onOrderComplete`
    ///         forwards USDC here. Lookup is keyed on `msg.sender` of
    ///         `userPlaceOrder` — the user's server-wallet smart account.
    mapping(address user => address recipient) public bridgeRecipientOf;

    /// @notice p2p.me ReputationManager whose `isBlacklisted` flag blocks
    ///         placement. `address(0)` disables the check (owner kill-switch).
    address public reputationManager;

    /// @notice Owner-set denylist, independent of the ReputationManager.
    mapping(address user => bool) public blocked;

    // ─── Events ───────────────────────────────────────────────────────

    event PolyculeOrderPlaced(
        uint256 indexed orderId,
        address indexed user,
        address indexed recipient,
        uint256 amount,
        bytes32 currency
    );

    event PolyculeOrderSettled(address indexed user, address indexed recipient, uint256 amount);

    event BridgeRecipientSet(address indexed user, address indexed recipient);
    event RegistrarUpdated(address indexed registrar);
    event UserProxyDeployed(address indexed user, address proxy);
    event UserBlocked(address indexed user, bool blocked);
    event ReputationManagerUpdated(address indexed reputationManager);

    // ─── Errors ───────────────────────────────────────────────────────

    error OnlyDiamond();
    error OnlyRegistrar();
    error OnlyOwner();
    error InvalidAmount();
    error InvalidAddress();
    error NoBridgeRecipient();
    error UserIsBlocked();

    // ─── Constructor ──────────────────────────────────────────────────

    constructor(
        address diamond_,
        address usdc_,
        address owner_,
        address registrar_,
        address reputationManager_
    ) {
        if (
            diamond_ == address(0) ||
            usdc_ == address(0) ||
            owner_ == address(0) ||
            registrar_ == address(0) ||
            reputationManager_.code.length == 0
        ) revert InvalidAddress();
        diamond = diamond_;
        usdc = IERC20(usdc_);
        owner = owner_;
        proxyImpl = address(new UserProxy());
        registrar = registrar_;
        reputationManager = reputationManager_;
        emit RegistrarUpdated(registrar_);
        emit ReputationManagerUpdated(reputationManager_);
    }

    modifier onlyDiamond() {
        if (msg.sender != diamond) revert OnlyDiamond();
        _;
    }

    modifier onlyRegistrar() {
        if (msg.sender != registrar) revert OnlyRegistrar();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    // ─── User entry point ─────────────────────────────────────────────

    /**
     * @notice Place a B2B BUY order. `msg.sender` is the buyer; their pinned
     *         recipient must already be set by the registrar. Reverts with
     *         `NoBridgeRecipient()` for unmapped wallets — placement is the
     *         authorization gate, since the registrar only maps users who
     *         passed off-chain auth. Reverts with `UserIsBlocked()` for a
     *         blocked wallet (see `isUserBlocked`); `validateOrder` re-checks
     *         when the Diamond calls back.
     */
    function userPlaceOrder(
        uint256 amount,
        bytes32 currency,
        string calldata pubKey,
        uint256 circleId,
        uint256 preferredPaymentChannelConfigId,
        uint256 fiatAmountLimit
    ) external returns (uint256 orderId) {
        if (amount == 0) revert InvalidAmount();

        address user = msg.sender;
        if (isUserBlocked(user)) revert UserIsBlocked();
        address recipient = bridgeRecipientOf[user];
        if (recipient == address(0)) revert NoBridgeRecipient();

        address userProxy = _ensureProxy(user);
        bytes memory data = abi.encodeCall(
            IB2BGateway.placeB2BOrder,
            (
                user,
                amount,
                currency,
                recipient,
                pubKey,
                circleId,
                preferredPaymentChannelConfigId,
                fiatAmountLimit
            )
        );
        bytes memory result = UserProxy(userProxy).execute(diamond, data, address(usdc), 0);
        orderId = abi.decode(result, (uint256));

        emit PolyculeOrderPlaced(orderId, user, recipient, amount, currency);
    }

    // ─── IP2PIntegrator callbacks ─────────────────────────────────────

    /// @inheritdoc IP2PIntegrator
    /// @dev The Diamond skips its own user blacklist on B2B orders, so this is
    ///      the authoritative block check. The recipient gate lives in
    ///      `userPlaceOrder`, the only path that reaches the Diamond through
    ///      this integrator's proxies.
    function validateOrder(
        address user,
        uint256 /* amount */,
        bytes32 /* currency */
    ) external view onlyDiamond returns (bool allowed) {
        return !isUserBlocked(user);
    }

    /// @inheritdoc IP2PIntegrator
    /// @dev Diamond has already transferred `amount` USDC to this contract by
    ///      the time this is called (registered with usdcThroughIntegrator =
    ///      true). Forward to the user's currently mapped recipient.
    ///
    ///      Trust note: `bridgeRecipientOf[user]` is read at settlement time,
    ///      not snapshotted at placement. A registrar that re-maps a user
    ///      between `userPlaceOrder` and this callback will divert in-flight
    ///      USDC to the new recipient. The trust model assumes the registrar
    ///      key is custodial (HSM/KMS-bound, rotated regularly).
    ///
    ///      If `safeTransfer` reverts (e.g. recipient is blacklisted by USDC
    ///      or rejects transfers), the Diamond catches the revert and
    ///      finalises protocol state regardless; the USDC stays on this
    ///      contract until `rescueStrandedUsdc` is invoked manually. We
    ///      accept this as the recovery channel rather than retaining a
    ///      per-order claimable mapping.
    function onOrderComplete(
        uint256 /* orderId */,
        address user,
        uint256 amount,
        address /* recipientAddrFromDiamond */
    ) external onlyDiamond nonReentrant {
        address dest = bridgeRecipientOf[user];
        if (dest == address(0)) revert NoBridgeRecipient();
        usdc.safeTransfer(dest, amount);
        emit PolyculeOrderSettled(user, dest, amount);
    }

    /// @inheritdoc IP2PIntegrator
    function onOrderCancel(uint256 /* orderId */) external onlyDiamond {}

    // ─── Registrar surface ────────────────────────────────────────────

    /// @notice Pin `user`'s settlement destination. Idempotent.
    function setBridgeRecipient(address user, address recipient) external onlyRegistrar {
        if (user == address(0) || recipient == address(0)) revert InvalidAddress();
        bridgeRecipientOf[user] = recipient;
        emit BridgeRecipientSet(user, recipient);
    }

    // ─── Admin ────────────────────────────────────────────────────────

    function setRegistrar(address registrar_) external onlyOwner {
        if (registrar_ == address(0)) revert InvalidAddress();
        registrar = registrar_;
        emit RegistrarUpdated(registrar_);
    }

    /// @notice Deny/allow a wallet (confirmed fraud, abuse). Stops new
    ///         placements only; orders already placed still settle.
    function setBlocked(address user, bool isBlocked) external onlyOwner {
        if (user == address(0)) revert InvalidAddress();
        blocked[user] = isBlocked;
        emit UserBlocked(user, isBlocked);
    }

    /// @notice Point the blacklist check at a new ReputationManager, or pass
    ///         `address(0)` to switch it off and rely on `blocked` alone.
    function setReputationManager(address reputationManager_) external onlyOwner {
        if (reputationManager_ != address(0) && reputationManager_.code.length == 0) {
            revert InvalidAddress();
        }
        reputationManager = reputationManager_;
        emit ReputationManagerUpdated(reputationManager_);
    }

    /// @notice Escape hatch for USDC stranded on this contract. The realistic
    ///         path is `onOrderComplete`'s `safeTransfer` reverting (recipient
    ///         is blacklisted by USDC or otherwise rejects) and the Diamond's
    ///         try/catch swallowing it so the protocol moves on. The Diamond
    ///         does not retry — owner pulls the funds and routes them
    ///         manually.
    ///
    ///         The `NoBridgeRecipient` guard in `onOrderComplete` is
    ///         defense-in-depth only: `setBridgeRecipient` rejects the zero
    ///         address and there is no clearing path, so once a user is
    ///         mapped the entry cannot revert to zero. The guard exists to
    ///         fail loudly if `onOrderComplete` is ever invoked for a user
    ///         that was never mapped (which `userPlaceOrder` prevents on the
    ///         happy path).
    function rescueStrandedUsdc(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert InvalidAddress();
        usdc.safeTransfer(to, amount);
    }

    // ─── Views ────────────────────────────────────────────────────────

    function proxyAddress(address user) public view returns (address) {
        return
            Clones.predictDeterministicAddressWithImmutableArgs(
                proxyImpl,
                _proxyArgs(user),
                _salt(user),
                address(this)
            );
    }

    function isProxyDeployed(address user) external view returns (bool) {
        return proxyAddress(user).code.length > 0;
    }

    function isRegistered(address user) external view returns (bool) {
        return bridgeRecipientOf[user] != address(0);
    }

    /// @notice True if `user` may not place orders: on the owner's `blocked`
    ///         list, or blacklisted on the ReputationManager.
    function isUserBlocked(address user) public view returns (bool) {
        return blocked[user] || _isBlacklisted(user);
    }

    // ─── Internal: blacklist ──────────────────────────────────────────

    /// @dev Fails OPEN: if the ReputationManager call reverts or returns an
    ///      unexpected shape, the wallet is treated as not blacklisted, so an
    ///      upgrade on the p2p.me side cannot halt every placement here. The
    ///      raw staticcall (rather than try/catch) is what makes a malformed
    ///      return non-fatal: a decode failure inside a `try` success branch
    ///      reverts the caller. The owner's `blocked` list is unaffected.
    function _isBlacklisted(address user) internal view returns (bool) {
        address rm = reputationManager;
        if (rm == address(0)) return false;
        (bool ok, bytes memory ret) = rm.staticcall(
            abi.encodeCall(IReputationManager.rmusers, (user))
        );
        if (!ok || ret.length < 96) return false;
        (, , uint256 isBlacklisted) = abi.decode(ret, (uint256, uint256, uint256));
        return isBlacklisted != 0;
    }

    // ─── Internal: proxy helpers ──────────────────────────────────────

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
