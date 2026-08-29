// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { IMerchantTerminalLinks } from "../../interfaces/IMerchantTerminalLinks.sol";

/**
 * @title LinkRouter
 * @notice The integrator's `trustedRelayer` for payment links, replacing the
 *         funded relayer EOA.
 *
 * WHY THIS CONTRACT EXISTS
 * A customer paying a link has no wallet and no gas, so something must sign the
 * on-chain steps for them. Until now that was a single funded key: a single
 * point of failure, with no spending limits, and one nonce sequence that blocks
 * under load. A pool of such keys was rejected for the same reason — it
 * multiplies the funding problem instead of removing it.
 *
 * The observation that removes it entirely: `relayerPlaceOrder` resolves the
 * merchant from `link.owner`, never from `msg.sender`. The caller therefore
 * needs no merchant authority and no balance — it only needs to be the
 * *expected* address for that link. So each link gets its own account-abstraction
 * wallet which holds nothing, ever, and whose gas is paid by a paymaster.
 * Stealing that wallet's key yields the key to an empty box.
 *
 * WHAT THIS CONTRACT CANNOT DO — and these are structural, not policy:
 *   • It has no `receive`, no `fallback`, and no `payable` function, so it
 *     cannot accept native value. A call carrying value reverts.
 *   • It holds no token balance and contains no token interface, so it has no
 *     instruction able to transfer, approve, or permit anything.
 *   • It has no `delegatecall`, no `selfdestruct`, and no arbitrary-call entry
 *     point, so its behaviour cannot be redirected after deployment.
 *   • It has no owner, no admin, no proxy and no upgrade path. The integrator
 *     address is immutable.
 *   • Its entire reach into custody code is `IMerchantTerminalLinks` — three
 *     link calls. It cannot name a withdrawal, a profile edit, or the Diamond.
 *
 * TWO CREDENTIALS, NEITHER SUFFICIENT ALONE
 * Placing an order needs the link's wallet key, which our backend holds.
 * Marking paid or cancelling needs BOTH that key and a signature from the
 * customer who placed that specific order — a key generated in their browser
 * which we never hold. So a total compromise of our backend can place unwanted
 * orders and nothing else: it cannot advance or cancel anyone's payment, and it
 * cannot move any asset.
 */
contract LinkRouter is EIP712 {
    // ─── Immutable wiring ─────────────────────────────────────────────

    /// @notice The integrator this Router speaks for. Immutable: a Router is
    ///         deployed per integrator rather than re-pointed, so there is no
    ///         setter and therefore no admin to compromise.
    IMerchantTerminalLinks public immutable integrator;

    // ─── Storage ──────────────────────────────────────────────────────

    /// @notice linkId => the account-abstraction wallet allowed to drive it.
    /// @dev This binding is what makes scoping exact. The wallet for link A is
    ///      a different address from the wallet for link B, so a leaked key
    ///      cannot act on any other link — not because a permission list
    ///      forbids it, but because it is the wrong address.
    ///
    ///      Write-once. Re-pointing a live link would let a merchant (or anyone
    ///      who compromised a merchant) swap the signer out from under orders
    ///      already in flight. Recovery from a suspected key leak is to revoke
    ///      the link and issue a new one, which is a single tap and costs the
    ///      merchant nothing.
    mapping(bytes32 => address) public linkAgent;

    /// @dev orderId => the customer key that placed it, and the link it belongs
    ///      to. `customer` is the gate on mark-paid and cancel; `linkId` gives a
    ///      clear revert when an order and link are mismatched, ahead of the
    ///      integrator's own `orderToLink` check.
    struct Order {
        address customer;
        bytes32 linkId;
    }
    mapping(uint256 => Order) public orders;

    /// @dev Reentrancy flag. `place` cannot follow checks-effects-interactions
    ///      because the orderId it must record only exists after the external
    ///      call. Transient storage (EIP-1153) rather than a storage slot: the
    ///      flag never needs to outlive the transaction.
    bool private transient _locked;

    // ─── Typed data ───────────────────────────────────────────────────

    /// @dev Distinct type hashes per action, each binding the order. A
    ///      signature authorising a cancel therefore cannot be replayed as a
    ///      mark-paid, nor moved to another order. The EIP-712 domain binds the
    ///      chain id and this contract's address, so it cannot be replayed on
    ///      another chain or against another deployment. No nonce is needed:
    ///      both actions are terminal for an order, so a replay reverts
    ///      downstream on state that has already moved.
    bytes32 private constant MARK_PAID_TYPEHASH =
        keccak256("MarkPaid(bytes32 linkId,uint256 orderId)");
    bytes32 private constant CANCEL_TYPEHASH = keccak256("Cancel(bytes32 linkId,uint256 orderId)");

    // ─── Events ───────────────────────────────────────────────────────

    event AgentRegistered(bytes32 indexed linkId, address indexed agent, address indexed merchant);
    event OrderPlaced(bytes32 indexed linkId, uint256 indexed orderId, address customer);
    event OrderMarkedPaid(bytes32 indexed linkId, uint256 indexed orderId);
    event OrderCancelled(bytes32 indexed linkId, uint256 indexed orderId);

    // ─── Errors ───────────────────────────────────────────────────────

    error ZeroAddress();
    error NotLinkOwner();
    error AgentAlreadySet();
    error NotLinkAgent();
    error UnknownOrder();
    error OrderLinkMismatch();
    error BadCustomerSignature();
    error Reentrancy();

    // ─── Guard ────────────────────────────────────────────────────────

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    // ─── Construction ─────────────────────────────────────────────────

    constructor(address integrator_) EIP712("P2P LinkRouter", "1") {
        if (integrator_ == address(0)) revert ZeroAddress();
        integrator = IMerchantTerminalLinks(integrator_);
    }

    // ─── Registration ─────────────────────────────────────────────────

    /**
     * @notice Bind a link to the wallet allowed to drive it.
     * @dev Called by the MERCHANT, batched into the same operation that creates
     *      the link, so it costs them no extra step. Authorisation is the link's
     *      own owner as recorded on-chain — we read it from the integrator
     *      rather than trusting the caller's claim.
     *
     *      Note what this does NOT require: the wallet does not have to exist
     *      yet. Account-abstraction addresses are deterministic, so the merchant
     *      registers a computed address and the wallet is deployed lazily on the
     *      first payment. A link nobody ever pays deploys nothing.
     */
    function registerAgent(bytes32 linkId, address agent) external {
        if (agent == address(0)) revert ZeroAddress();
        (address owner, , , , , , , ) = integrator.getLink(linkId);
        if (msg.sender != owner) revert NotLinkOwner();
        if (linkAgent[linkId] != address(0)) revert AgentAlreadySet();
        linkAgent[linkId] = agent;
        emit AgentRegistered(linkId, agent, owner);
    }

    // ─── Payment path ─────────────────────────────────────────────────

    /**
     * @notice Place an order on this link, on the absent merchant's behalf.
     * @param customer The customer's own key, generated in their browser. It is
     *        recorded here and is the ONLY key that can later mark this order
     *        paid or cancel it.
     * @dev Every link rule — status, expiry, use count, currency, exact amount,
     *      merchant registered, not frozen, per-transaction cap, daily count —
     *      is enforced by the integrator on the call below. This function
     *      deliberately re-checks none of them: duplicating those rules here
     *      would create a second place for them to drift.
     */
    function place(
        bytes32 linkId,
        address client,
        uint256 productId,
        uint256 quantity,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey,
        address customer
    ) external nonReentrant returns (uint256 orderId) {
        if (msg.sender != linkAgent[linkId]) revert NotLinkAgent();
        if (customer == address(0)) revert ZeroAddress();

        orderId = integrator.relayerPlaceOrder(
            linkId,
            client,
            productId,
            quantity,
            currency,
            circleId,
            pubKey
        );

        orders[orderId] = Order({ customer: customer, linkId: linkId });
        emit OrderPlaced(linkId, orderId, customer);
    }

    /**
     * @notice Mark an order paid — the customer's "I have paid" tap.
     * @param signature The customer's signature over this exact action and
     *        order. Without it the link wallet's key alone can do nothing here.
     * @dev This is the check that makes a compromised backend harmless on the
     *      settlement path. Whoever holds every link wallet key still cannot
     *      advance a payment, because the authorising key was generated in the
     *      customer's browser and never left it.
     */
    function markPaid(
        bytes32 linkId,
        uint256 orderId,
        bytes calldata signature
    ) external nonReentrant {
        _authorise(linkId, orderId, MARK_PAID_TYPEHASH, signature);
        integrator.relayerMarkPaid(linkId, orderId);
        emit OrderMarkedPaid(linkId, orderId);
    }

    /**
     * @notice Cancel an order the customer abandoned.
     * @dev Also customer-signed, and for a sharper reason than mark-paid: cancel
     *      destroys an in-flight order. Left open to the link wallet alone, a
     *      leaked key could cancel a genuine customer's order out from under
     *      them after their bank transfer had already left. Requiring the
     *      order's own customer to sign closes that.
     */
    function cancel(
        bytes32 linkId,
        uint256 orderId,
        bytes calldata signature
    ) external nonReentrant {
        _authorise(linkId, orderId, CANCEL_TYPEHASH, signature);
        integrator.relayerCancelOrder(linkId, orderId);
        emit OrderCancelled(linkId, orderId);
    }

    // ─── Views ────────────────────────────────────────────────────────

    /// @notice The customer key that placed an order, or zero if unknown.
    function orderCustomer(uint256 orderId) external view returns (address) {
        return orders[orderId].customer;
    }

    /// @notice The EIP-712 digest a customer signs to mark an order paid.
    ///         Exposed so the pay page and tests derive it from the contract
    ///         rather than reimplementing the encoding.
    function markPaidDigest(bytes32 linkId, uint256 orderId) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(MARK_PAID_TYPEHASH, linkId, orderId)));
    }

    /// @notice The EIP-712 digest a customer signs to cancel an order.
    function cancelDigest(bytes32 linkId, uint256 orderId) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CANCEL_TYPEHASH, linkId, orderId)));
    }

    // ─── Internal ─────────────────────────────────────────────────────

    /// @dev The three checks shared by mark-paid and cancel: the caller is this
    ///      link's wallet, the order really belongs to this link, and the
    ///      order's own customer signed this exact action.
    function _authorise(
        bytes32 linkId,
        uint256 orderId,
        bytes32 typeHash,
        bytes calldata signature
    ) private view {
        if (msg.sender != linkAgent[linkId]) revert NotLinkAgent();

        Order storage o = orders[orderId];
        if (o.customer == address(0)) revert UnknownOrder();
        if (o.linkId != linkId) revert OrderLinkMismatch();

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(typeHash, linkId, orderId)));
        // ECDSA.recover reverts on a malformed or malleable (high-s) signature
        // rather than returning a junk address, so a bad signature can never be
        // mistaken for a valid one from an unexpected signer.
        if (ECDSA.recover(digest, signature) != o.customer) revert BadCustomerSignature();
    }
}
