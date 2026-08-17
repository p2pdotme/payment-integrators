# Proposal: private liveness for the $20 tier

**From:** Zapp (privacy-first Zcash wallet), integrating `ZappUsdcOnrampIntegrator`.
**Sign-off sheet:** `docs/proposals/zapp-liveness-privacy-onepager.md`.
**Code referenced:** `p2pdotme/simple-kyc-oss` @ `liveness_verifier/`.

## 1. What we are asking for

Zapp cannot send users' face data to a server that stores it against their wallet
address. That is the single link our product exists to prevent. We are not asking
to skip the identity gate. We are asking to change where the data lives and to
remove the join, with the Sybil property untouched.

Two changes:

- **A.** Zapp self-hosts `liveness_verifier` and is its own attestor. No code change.
- **B.** `simple-kyc-oss` gains an unlinkable issuance mode so no operator holds a
  face-to-wallet join. Zapp writes it, upstream, opt-in per tenant.

## 2. What happens today

```
POST /v1/onboard {wallet}            session is bound to the address up front
POST /v1/sessions/{id}/liveness      frames + selfie_b64  ->  dedup  ->  approved
POST /v1/sessions/{id}/attestation   EIP-712(wallet, nullifier, limit, expiry)
```

One session, one connection, so the server learns the face and the address
together. It then persists both in the same row:

- `liveness_verifier/app/models.py:98` `LivenessIdentity` holds
  `biometric_template` (the ArcFace embedding) alongside `wallet_pubkey`.
- `liveness_verifier/app/models.py:103` `uq_identity_tenant_wallet` enforces one
  face to one address per tenant.

The selfie itself is handled well: processed in-request, never written, no object
storage in the service. Our objection is not the image. It is the durable
template-to-address row.

## 3. Change A: self-hosted attestor

No code change is required. `setLivenessAttestor` takes any address, we own our
integrator, and a tenant is a `(chain_id, contract_address)` row. Zapp runs the
service, holds the attestor key, and P2P's contract trusts our signer the same way
it trusts yours.

This is a trust shift, not a privacy win, and we are not pretending otherwise. It
makes Zapp the data controller under DPDP, LGPD, and NDPA, which is a cost we
accept. On its own it is not sufficient, which is why it comes with B.

## 4. Change B: unlinkable issuance

Split the single session into enrollment and redemption, joined by a blind
signature. Opt-in per tenant, default off, existing tenants unaffected.

```
Phase 1, enrollment. No wallet is ever sent.
  POST /v1/onboard {tenant}                 session, no address
  POST /v1/sessions/{id}/liveness           frames + selfie -> dedup -> approved
  POST /v1/sessions/{id}/token {blinded}    server blind-signs; identity marked issued

Phase 2, redemption. Fresh connection, later.
  POST /v1/attestation {token, sig, wallet} verify sig; spend token;
                                            nullifier = HMAC(secret, tenant:serial);
                                            sign EIP-712(wallet, nullifier, limit, expiry)
```

After this, server state is two tables with nothing joining them: identities hold
a template and an issued flag with no address, spent tokens hold a serial and an
address with no template. The blinding is what prevents the server from
correlating the two, so it can answer "is this a unique human" and "does wallet X
get an attestation" without ever answering both about the same person.

One token per identity, so one human still gets one claim. RSA blind signatures
are sufficient and boring; no new cryptographic assumptions.

Network-level linkage has to be closed too, or timing and IP put the join back.
Zapp routes redemption over Tor after a delay. Any tenant enabling this mode
should do the same.

## 5. What does not change

- The contract. Same EIP-712 struct, same `LivenessVerifier` domain, same
  typehash, same `MAX_LIVENESS_TIER_CAP`. No re-audit, no re-whitelist.
- The nullifier. Still `bytes32`, still one-way, still per-tenant, still spent
  once on-chain.
- The Sybil gate. Liveness scoring, 1:N dedup, thresholds, and the escalation clip
  path are all untouched.
- Caps. $20 per transaction, 5 orders per day, immutable ceilings.

## 6. The wallet column is not load-bearing

Worth stating plainly because it makes B cheaper than it looks. The property
"one human, one claim per contract" is already enforced on-chain: the contract
spends the nullifier and reverts `NullifierAlreadySpent` on a second claim.
`uq_identity_tenant_wallet` and the `duplicate_person` branch at
`verification.py:172` are belt-and-braces on top of a guarantee the chain already
provides. Dropping the address from the identity row costs no security.

The one behaviour it does provide is idempotency: re-verifying the same wallet
with the same face returns approve rather than reject. Under unlinkable mode the
server cannot see that, so the equivalent is a re-issue path, which we handle in
§9.

## 7. Why not a ZK circuit over the biometric

We looked at this first and it does not work. Recording why, since it is the
obvious question.

**A proof cannot vouch for its own input.** ZK proves a computation ran correctly
on some input. It cannot prove that input came from a live face in front of a real
camera rather than a photo, a deepfake, or a vector the user typed. Feed a
circuit a synthetic embedding and you get a perfectly valid proof of nothing.
Binding the input to a real sensor requires hardware attestation, which is
Google's or Apple's trust root. ZK relocates the trusted party here, it does not
remove it.

**Face ID and BiometricPrompt cannot help.** Neither exposes a template. The API
surface is "the user authenticated", plus optionally a hardware-backed key gated
on that. So there is nothing to prove anything *about*. Signing a challenge with a
biometric-gated Secure Enclave key proves presence and device continuity, not
uniqueness: one person with ten devices is ten identities. That is zero Sybil
resistance, which is the only property the tier is buying.

**Uniqueness is a claim about other people's data.** Proving "my face is not
within threshold of any enrolled template" is 1:N, so the prover needs the
enrolled set. That means publishing everyone's templates, and O(N) constraints per
proof because the comparison is fuzzy rather than an exact-match set membership.
Neither is viable.

**Where ZK genuinely does work is over a signed document.** A passport NFC chip or
an Aadhaar credential carries a government signature, so a circuit can prove
possession and emit a deterministic nullifier without revealing the document. The
uniqueness work was done by the issuer, which is exactly the part a biometric
circuit cannot do for itself. That is a real and deployed pattern, but it requires
a document, which is the thing the no-document $20 tier exists to avoid. It is a
different tier, not a replacement for this one. See §10.

**ZK could replace our blind signature**, via a Semaphore-style anonymous
credential with the nullifier derived in-circuit. Same privacy outcome, more
moving parts, a trusted setup or a proving system to maintain, and a much larger
client. We propose the blind signature and are happy to revisit.

## 8. Work split

**Zapp**
- Blind-signature issuance and redemption endpoints in `liveness_verifier/`,
  behind a per-tenant flag, with tests to the repo's coverage gate.
- Schema migration: `token_issued` on the identity, a `spent_tokens` table, and
  `wallet_pubkey` made nullable for tenants in unlinkable mode.
- Client implementation and the Tor-routed redemption path.
- Self-hosted deployment, key custody, and the attestor address for our tenant.

**P2P**
- Review and merge the `simple-kyc-oss` PR.
- Accept a Zapp-operated attestor for our integrator at whitelist review.
- Confirm the caps and the tenant registration for `ZappUsdcOnrampIntegrator`.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Timing or IP correlates the two phases | Redeem over Tor after a delay. Documented as a requirement of the mode, not an optional extra. |
| User loses the token and cannot re-enroll, since dedup now rejects them as a duplicate | Re-issue path: a fresh liveness session that dedups to the same identity gets a new token, but only while the previous one is unspent. One claim is preserved. |
| A tenant enables the mode but leaks the address at enrollment anyway | The endpoint rejects a wallet field in unlinkable mode rather than ignoring it. |
| Attestor key custody moves to Zapp | Same file-based key seam as today. Both parties want the KMS signer that `BUILD_PLAN.md` already lists as a production blocker. |
| ArcFace `buffalo_l` is non-commercial-research-only and is the default matcher | Pre-existing and independent of this proposal, but it blocks commercial use for both parties. Needs a decision either way. |

## 10. Open decisions

1. Unlinkable mode upstream in `simple-kyc-oss`, or a Zapp-only deployment flag?
2. Is a Zapp-operated attestor acceptable at whitelist review, and under what
   conditions?
3. Enclave-side embedding, where the operator cannot read the selfie at all even
   in memory, is the stronger version of the same goal. Phase 2, or out of scope?
4. **The zk document path, and whether RP can reach an integrator at all.** We
   checked before asking. The client plumbing exists
   (`prepareSubmitAnonAadharProofTx`, `isAadharVerified`, `getAadhaarRp`), but
   Aadhaar sits behind `HIDE_AADHAAR_VERIFICATION = true` in `user-app-client`,
   and we did not find the selector on mainnet. Separately, and this matters more:
   RP is integrator-private by design. `docs/ARCHITECTURE.md:43` puts per-user RP
   on the integrator, `:56` calls the RP curve an integrator-private concern,
   there is no `IReputationManager` in `contracts/interfaces/`, and no integrator
   in this repo reads the reputation layer. So even a fully live zk document path
   would not move an integrator's cap today. What is the roadmap for both?
5. **Is a B2B BUY still gated Diamond-side at `buyLimit = 0` for an unreputed
   wallet?** `LIMITS-AND-RP.md` notes the Diamond enforces protocol limits
   independently, and our on-chain reads suggested BUY is reputation-gated. If
   that still holds, the binding limit for an onramp is yours and no
   integrator-side change reaches it. This blocks us whichever way the rest of the
   proposal lands, so we would like this answer first.
6. If change A is refused: can our backend-signed `PurchaseAuthorization` serve as
   the $20 gate instead? It is weaker on Sybil and we would rather not, but it
   collects no biometrics at all, which beats collecting them badly.
