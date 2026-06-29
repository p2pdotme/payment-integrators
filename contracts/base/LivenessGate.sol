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
    /// @notice When true, gated actions require the caller to be liveness-verified.
    bool public livenessRequired;
    /// @notice Whether an address has spent a valid liveness attestation here.
    mapping(address => bool) public livenessVerified;
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

    /// @notice Whether `user` satisfies the current liveness policy. Always true
    ///         while the gate is off (`livenessRequired == false`).
    function _livenessOk(address user) internal view returns (bool) {
        return !livenessRequired || livenessVerified[user];
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
