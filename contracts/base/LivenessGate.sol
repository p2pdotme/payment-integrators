// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/**
 * @title LivenessGate
 * @notice Reusable, opt-in anti-sybil gate. An inheriting integrator can require
 *         a verified simple-kyc *liveness* attestation (proof of a unique human)
 *         before an action is allowed.
 *
 *         Why this stops spam that rate limits can't: per-address limits (per-tx
 *         amount, daily count) reset the moment a bot spins up a fresh wallet,
 *         so a sybil farm multiplies them at will. A liveness attestation embeds
 *         a per-(tenant, human) `nullifier` that this contract spends exactly
 *         once, so one human can verify exactly one wallet here. A bot farm
 *         can't mint new faces, so the per-human limits actually bind.
 *
 *         BACKWARD-COMPATIBLE BY DEFAULT: `livenessRequired` starts false and
 *         `livenessAttestor` starts unset, so an integrator that inherits this
 *         behaves exactly as before. The gate only takes effect after the owner
 *         calls `setLivenessAttestor(...)` then `setLivenessRequired(true)`, and
 *         can be turned off again at any time.
 *
 *         TWO ARMED MODES (once `setLivenessRequired(true)`):
 *           - suspect-only (default, `livenessRequiredForAll == false`): only
 *             users flagged via `setLivenessSuspect`/`setLivenessSuspectBatch`
 *             must verify. Intended to be driven by the off-chain fraud engine
 *             (sybil-cluster membership, rapid-cancellation restriction), so
 *             honest users are never prompted. This is the "optional, enforced
 *             only on suspicion" policy.
 *           - verify-everyone (`setLivenessRequiredForAll(true)`): every user
 *             must verify. Escalation path — flip one flag, no re-wiring.
 *
 * @dev    The EIP-712 digest is byte-compatible with simple-kyc's reference
 *         `LivenessAttestationVerifier` and `UsdcDirectCheckoutIntegrator`:
 *         typehash `LivenessAttestation(address wallet,bytes32 nullifier,
 *         uint256 limit,uint256 expiry)`, domain name `LivenessVerifier`,
 *         version `1`, `verifyingContract = address(this)`,
 *         `chainId = block.chainid`. The signed `limit` (micro-USDC) is recorded
 *         in the event but NOT enforced here — inheriting contracts keep their
 *         own amount limits. Bind the attestation to the inheriting contract by
 *         registering its address as the liveness tenant's `contract_address`
 *         (on the matching chain) in simple-kyc.
 */
abstract contract LivenessGate {
    // ─── Errors ───────────────────────────────────────────────────────

    error LivenessAttestorNotSet();
    error LivenessAttestationExpired();
    error LivenessNullifierAlreadySpent();
    error LivenessInvalidSignature();
    error NotLivenessVerified();

    // ─── Events ───────────────────────────────────────────────────────

    event LivenessAttestorUpdated(address indexed attestor);
    event LivenessRequiredUpdated(bool required);
    event LivenessRequiredForAllUpdated(bool requiredForAll);
    event LivenessSuspectUpdated(address indexed user, bool suspect);
    event LivenessVerified(
        address indexed user,
        bytes32 indexed nullifier,
        uint256 limit,
        uint256 expiry
    );

    // ─── EIP-712 constants ────────────────────────────────────────────

    /// @dev keccak256("LivenessAttestation(address wallet,bytes32 nullifier,uint256 limit,uint256 expiry)")
    bytes32 private constant _LIVENESS_TYPEHASH =
        keccak256(
            "LivenessAttestation(address wallet,bytes32 nullifier,uint256 limit,uint256 expiry)"
        );
    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
    bytes32 private constant _LIVENESS_DOMAIN_NAME = keccak256(bytes("LivenessVerifier"));
    bytes32 private constant _DOMAIN_VERSION = keccak256(bytes("1"));

    // ─── State ────────────────────────────────────────────────────────

    /// @notice secp256k1 signer of the liveness service's attestations
    ///         (simple-kyc liveness verifier, GET /v1/attestor). Unset = gate off.
    address public livenessAttestor;
    /// @notice Master switch. When false the gate is fully off. When true the
    ///         gate is armed but, by default, only applies to users flagged
    ///         `livenessSuspect` — see `livenessRequiredForAll`.
    bool public livenessRequired;
    /// @notice When true, an armed gate applies to EVERY user (compulsory mode).
    ///         When false (default), an armed gate applies only to users flagged
    ///         via `setLivenessSuspect`. Flip this on to escalate to
    ///         verify-everyone without touching the rest of the wiring.
    bool public livenessRequiredForAll;
    /// @notice Whether an address has spent a valid liveness attestation here.
    mapping(address => bool) public livenessVerified;
    /// @notice Users flagged as suspicious (e.g. by the off-chain fraud engine:
    ///         sybil-cluster membership, rapid-cancellation restriction). While
    ///         the gate is armed in suspect-only mode, only these users must
    ///         verify; everyone else is unaffected.
    mapping(address => bool) public livenessSuspect;
    /// @notice Per-(tenant, human) nullifiers already consumed on this contract.
    mapping(bytes32 => bool) public livenessNullifierSpent;

    // ─── Admin (authorized by the inheriting contract) ────────────────

    /// @dev Inheriting contract restricts the admin setters (e.g. to its owner).
    function _authorizeLivenessAdmin() internal view virtual;

    function setLivenessAttestor(address attestor) external {
        _authorizeLivenessAdmin();
        livenessAttestor = attestor;
        emit LivenessAttestorUpdated(attestor);
    }

    function setLivenessRequired(bool required) external {
        _authorizeLivenessAdmin();
        livenessRequired = required;
        emit LivenessRequiredUpdated(required);
    }

    /// @notice Escalate an armed gate from suspect-only to verify-everyone (or
    ///         back). No effect while `livenessRequired == false`.
    function setLivenessRequiredForAll(bool requiredForAll) external {
        _authorizeLivenessAdmin();
        livenessRequiredForAll = requiredForAll;
        emit LivenessRequiredForAllUpdated(requiredForAll);
    }

    /// @notice Flag/unflag a single user as suspicious. Intended to be driven by
    ///         the off-chain fraud engine's operator wallet from fingerprint-
    ///         cluster / rapid-cancellation signals. Idempotent.
    function setLivenessSuspect(address user, bool suspect) external {
        _authorizeLivenessAdmin();
        livenessSuspect[user] = suspect;
        emit LivenessSuspectUpdated(user, suspect);
    }

    /// @notice Batch variant of {setLivenessSuspect} — one tx to flag many fresh
    ///         sybil wallets at once (the fraud engine sees ~50/week).
    function setLivenessSuspectBatch(
        address[] calldata users,
        bool suspect
    ) external {
        _authorizeLivenessAdmin();
        for (uint256 i = 0; i < users.length; i++) {
            livenessSuspect[users[i]] = suspect;
            emit LivenessSuspectUpdated(users[i], suspect);
        }
    }

    // ─── Verification ─────────────────────────────────────────────────

    /**
     * @notice Verify and record a liveness attestation for `msg.sender`, marking
     *         them liveness-verified and spending the nullifier (one human, one
     *         wallet on this contract).
     * @param nullifier Per-(tenant, human) Sybil nullifier from the service.
     * @param limit     Attested amount (micro-USDC) — recorded in the event only.
     * @param expiry    Unix seconds; the attestation must be claimed before this.
     * @param signature 65-byte secp256k1 signature (r ‖ s ‖ v) from the service.
     */
    function submitLivenessAttestation(
        bytes32 nullifier,
        uint256 limit,
        uint256 expiry,
        bytes calldata signature
    ) external {
        if (livenessAttestor == address(0)) revert LivenessAttestorNotSet();
        if (block.timestamp >= expiry) revert LivenessAttestationExpired();
        if (livenessNullifierSpent[nullifier]) revert LivenessNullifierAlreadySpent();

        bytes32 digest = _livenessDigest(msg.sender, nullifier, limit, expiry);
        if (_recoverLiveness(digest, signature) != livenessAttestor)
            revert LivenessInvalidSignature();

        livenessNullifierSpent[nullifier] = true;
        livenessVerified[msg.sender] = true;
        emit LivenessVerified(msg.sender, nullifier, limit, expiry);
    }

    /// @notice Whether `user` satisfies the current liveness policy.
    ///         - gate off (`!livenessRequired`)                        → always ok
    ///         - already verified                                     → ok
    ///         - armed, suspect-only mode, user not flagged           → ok
    ///         - armed + (verify-everyone OR user flagged suspect)    → must verify
    function _livenessOk(address user) internal view returns (bool) {
        if (!livenessRequired) return true;
        if (livenessVerified[user]) return true;
        return !livenessRequiredForAll && !livenessSuspect[user];
    }

    // ─── Internals: EIP-712 ───────────────────────────────────────────

    function _livenessDigest(
        address wallet,
        bytes32 nullifier,
        uint256 limit,
        uint256 expiry
    ) private view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                _EIP712_DOMAIN_TYPEHASH,
                _LIVENESS_DOMAIN_NAME,
                _DOMAIN_VERSION,
                block.chainid,
                address(this)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(_LIVENESS_TYPEHASH, wallet, nullifier, limit, expiry)
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _recoverLiveness(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) revert LivenessInvalidSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        // Reject the high-`s` half (EIP-2) so a signature is a unique id.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0)
            revert LivenessInvalidSignature();
        if (v != 27 && v != 28) revert LivenessInvalidSignature();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert LivenessInvalidSignature();
        return signer;
    }
}
