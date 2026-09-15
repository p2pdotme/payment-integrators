// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/**
 * @title PaymentLinksLib
 * @notice Payment-link storage and lifecycle, extracted from
 *         `MerchantTerminalIntegrator` into an external (delegatecall) library.
 *
 * WHY THIS IS A LIBRARY, NOT INLINE CODE
 * The integrator sits against the 24,576-byte EIP-170 ceiling: with the link
 * feature inline it measured 24,296 bytes, and the fix that makes link orders
 * actually reach PAID needs ~1,125 more. It does not fit at ANY optimizer
 * setting (measured: 24,714 bytes even at `runs: 1`). Moving these four entry
 * points out reclaims roughly 1.4KB.
 *
 * Because these are `public` library functions they are reached by DELEGATECALL,
 * so every `storage` reference below resolves in the INTEGRATOR's storage, and
 * every event is emitted with the INTEGRATOR's address as the emitter. Nothing
 * about custody, accounting, or the observable event stream moves.
 */
library PaymentLinksLib {
    // ─── Types ────────────────────────────────────────────────────────

    /// @dev ACTIVE = payable; REVOKED is terminal (a revoked link never
    ///      returns to ACTIVE — the merchant creates a new one instead).
    enum LinkStatus {
        ACTIVE,
        REVOKED
    }

    struct PaymentLink {
        address owner; //      20 ─┐
        uint96 amount; //      12 ─┘ slot 0 — 0 = customer enters the amount
        uint64 expiresAt; //    8 ─┐ 0 = never expires
        uint32 uses; //         4  │ SUCCESSFUL orders (released again on cancel)
        uint32 maxUses; //      4  │ 0 = unlimited; 1 = the old `singleUse`
        uint16 strikes; //      2  │ marked-paid-then-cancelled, i.e. false claims
        LinkStatus status; //   1 ─┘ slot 1 — 19 of 32 bytes used
        bytes32 currency; //        slot 2 — pinned at creation
    }

    /// @dev Integrator state the link rules depend on, read by the caller and
    ///      passed in. A library cannot see `merchants`/`registered`/`perTxCap`
    ///      without either duplicating that layout or taking it as an argument;
    ///      taking it keeps this library ignorant of merchant bookkeeping.
    struct MerchantView {
        bool registered;
        bool frozen;
        uint256 perTxCap; // keyed off the merchant's REGISTERED currency
    }

    // ─── Errors ───────────────────────────────────────────────────────

    error LinkExists();
    error LinkNotFound();
    error LinkNotActive();
    error LinkExpired();
    error LinkAlreadyUsed();
    error LinkAmountMismatch();
    error NotLinkOwner();
    error NotRegistered();
    error MerchantIsFrozen();
    error InvalidCurrency();
    error ExceedsPerTxCap();

    // ─── Events ───────────────────────────────────────────────────────

    /// @param encryptedConfig Opaque blob, encrypted client-side to the
    ///        merchant's own relay key: their internal order reference and
    ///        free-form description. Emitted, never stored — the merchant's
    ///        own client reads it back from logs.
    event LinkCreated(
        bytes32 indexed linkId,
        address indexed owner,
        uint96 amount,
        bytes32 currency,
        uint64 expiresAt,
        uint32 maxUses,
        bytes encryptedConfig
    );
    event LinkRevoked(bytes32 indexed linkId, address indexed revokedBy);
    event LinkStrikesReset(bytes32 indexed linkId, uint16 clearedCount);

    // ─── Ids ──────────────────────────────────────────────────────────

    /// @notice The id `createLink` should be given. Derives from the merchant's
    ///         own address, so two merchants choosing the same salt still get
    ///         different ids and cannot collide with each other by accident.
    /// @dev Does NOT make the id unguessable, and the earlier claim that it did
    ///      was wrong: an observer watching the mempool copies the id straight
    ///      out of the pending call — they never need to derive it. Front-running
    ///      a creation to grief it with `LinkExists` therefore remains possible
    ///      in principle. It is low risk on Base, whose sequencer mempool is
    ///      private, and closing it properly means taking `salt` and deriving
    ///      inside `createLink` so the id is never in calldata at all — which
    ///      does not currently fit in this contract's remaining size.
    function computeLinkId(address merchant, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(merchant, salt));
    }

    // ─── Lifecycle ────────────────────────────────────────────────────

    /**
     * @notice Create a shareable payment link.
     * @param linkId Derived by the caller as keccak256(merchant, salt), so an
     *        observer cannot front-run a creation with the same id and grief it.
     * @param amount Total in USDC (6dp). 0 = customer-entered, bounded at pay
     *        time by the merchant's per-tx cap.
     * @param maxUses How many SUCCESSFUL payments this link may take. 0 =
     *        unlimited. A cancelled order releases its use, so an abandoned
     *        checkout never consumes the link permanently.
     */
    function create(
        mapping(bytes32 => PaymentLink) storage links,
        bytes32 linkId,
        uint96 amount,
        bytes32 currency,
        uint64 expiresAt,
        uint32 maxUses,
        MerchantView memory mv,
        bytes calldata encryptedConfig
    ) public {
        if (!mv.registered) revert NotRegistered();
        // A frozen merchant cannot be paid (validateOrder blocks it), so letting
        // them mint links would only produce ones that fail in front of a
        // customer. Keeps the freeze switch meaning the same thing everywhere.
        if (mv.frozen) revert MerchantIsFrozen();
        if (linkId == bytes32(0)) revert LinkNotFound();
        if (links[linkId].owner != address(0)) revert LinkExists();
        if (currency == bytes32(0)) revert InvalidCurrency();
        // A link already expired at creation could never be paid.
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert LinkExpired();
        // A fixed amount above the per-tx cap would create a link that always
        // reverts at PAY time — in front of the customer, with the merchant
        // absent. Fail here instead, where the merchant can see and fix it.
        // The cap is keyed off the merchant's REGISTERED currency because that
        // is what `validateOrder` enforces at pay time (an INR merchant keeps
        // their INR cap even on a BRL link).
        if (amount != 0 && uint256(amount) > mv.perTxCap) revert ExceedsPerTxCap();

        links[linkId] = PaymentLink({
            owner: msg.sender,
            amount: amount,
            expiresAt: expiresAt,
            uses: 0,
            maxUses: maxUses,
            strikes: 0,
            status: LinkStatus.ACTIVE,
            currency: currency
        });

        emit LinkCreated(linkId, msg.sender, amount, currency, expiresAt, maxUses, encryptedConfig);
    }

    /**
     * @notice Permanently deactivate a link. Owner or admin only — deliberately
     *         NOT the relayer, which has no authority over link lifecycle.
     * @dev Allows revoking an EXPIRED or used-up link: those are unpayable
     *      anyway, and a merchant tidying their list should not hit an error for
     *      closing something already closed. Only a SECOND revoke is rejected,
     *      so the event stream never reports the same revocation twice.
     */
    function revoke(
        mapping(bytes32 => PaymentLink) storage links,
        bytes32 linkId,
        bool callerIsAdmin
    ) public {
        PaymentLink storage link = links[linkId];
        if (link.owner == address(0)) revert LinkNotFound();
        if (link.owner != msg.sender && !callerIsAdmin) revert NotLinkOwner();
        if (link.status == LinkStatus.REVOKED) revert LinkNotActive();

        link.status = LinkStatus.REVOKED;
        emit LinkRevoked(linkId, msg.sender);
    }

    /**
     * @notice Clear a link's false-claim strikes. Owner or admin only.
     *
     * Strikes exist so a merchant can SEE that a link is attracting false
     * "I have paid" claims. They deliberately do NOT block the link on-chain:
     * if two strikes froze a link, anyone could kill any merchant's link with
     * two taps, which is a worse griefing surface than the one it closes.
     * Throttling the person making the claims belongs in the relayer service,
     * which can see an IP and a session; the chain cannot.
     */
    function resetStrikes(
        mapping(bytes32 => PaymentLink) storage links,
        bytes32 linkId,
        bool callerIsAdmin
    ) public {
        PaymentLink storage link = links[linkId];
        if (link.owner == address(0)) revert LinkNotFound();
        if (link.owner != msg.sender && !callerIsAdmin) revert NotLinkOwner();

        uint16 cleared = link.strikes;
        link.strikes = 0;
        emit LinkStrikesReset(linkId, cleared);
    }

    // ─── Views ────────────────────────────────────────────────────────

    /**
     * @notice Whether a link can be paid right now — the pay page's precheck.
     *
     * Deliberately checks MORE than the link's own fields. The link's state can
     * be perfect while the payment is still guaranteed to fail: the merchant may
     * have been frozen since creation, link orders may be halted, the contract
     * may be paused, or an admin may have lowered the per-tx cap below a fixed
     * link's amount. Every one of those reverts inside `relayerPlaceOrder` — in
     * front of a customer, with no merchant present to explain.
     *
     * Not covered: the merchant's daily count, which is only knowable against
     * the current UTC day and is better surfaced to the merchant than guessed at.
     */
    function isActive(
        mapping(bytes32 => PaymentLink) storage links,
        bytes32 linkId,
        bool contractPaused,
        bool linkOrdersOn,
        MerchantView memory mv
    ) public view returns (bool) {
        PaymentLink storage link = links[linkId];
        if (link.owner == address(0)) return false;
        if (link.status != LinkStatus.ACTIVE) return false;
        if (link.expiresAt != 0 && block.timestamp > link.expiresAt) return false;
        if (link.maxUses != 0 && link.uses >= link.maxUses) return false;

        if (contractPaused) return false;
        if (!linkOrdersOn) return false;
        if (!mv.registered || mv.frozen) return false;
        if (link.amount != 0 && uint256(link.amount) > mv.perTxCap) return false;

        return true;
    }

    // ─── Pay-time guard ───────────────────────────────────────────────

    /**
     * @notice Validate a link at payment time and consume one use.
     * @dev Consumes the use BEFORE the caller's external call (CEI), so the
     *      allowance is spent the moment it is committed — independent of any
     *      reentrancy guard.
     */
    function consume(
        mapping(bytes32 => PaymentLink) storage links,
        bytes32 linkId,
        bytes32 currency,
        uint256 total
    ) public returns (address merchant, uint96 fixedAmount) {
        PaymentLink storage link = links[linkId];
        if (link.owner == address(0)) revert LinkNotFound();
        if (link.status != LinkStatus.ACTIVE) revert LinkNotActive();
        if (link.expiresAt != 0 && block.timestamp > link.expiresAt) revert LinkExpired();
        if (link.maxUses != 0 && link.uses >= link.maxUses) revert LinkAlreadyUsed();
        // Pinned at creation: even a compromised relayer cannot re-price the
        // link into another currency's cap / lock-period regime.
        if (currency != link.currency) revert InvalidCurrency();

        fixedAmount = link.amount;
        // A fixed-amount link must match EXACTLY. A variable link (amount == 0)
        // is bounded by the merchant's per-tx cap in validateOrder.
        if (fixedAmount != 0 && total != uint256(fixedAmount)) revert LinkAmountMismatch();

        unchecked {
            link.uses++;
        }
        merchant = link.owner;
    }
}
