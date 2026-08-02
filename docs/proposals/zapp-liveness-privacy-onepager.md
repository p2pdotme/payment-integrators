# Zapp × P2P | Private Liveness (one-pager, for sign-off)

**Who:** Zapp, a privacy-first Zcash wallet, integrating the Base USDC onramp
(`docs/integrators/zapp-usdc-onramp.md`).
**Full detail:** `docs/proposals/zapp-liveness-privacy.md`.

## The problem

The $20 liveness tier asks our users to upload a selfie to a P2P-run server,
which stores a face template joined to their wallet address
(`liveness_identities.wallet_pubkey`).

We cannot ship that. People choose Zapp so their addresses are not tied to their
identity. A face-to-address table is the strongest such tie there is, and once it
exists it is subpoenable, breachable, and permanent.

## The ask

Two changes. Neither touches a line of Solidity. Neither weakens the Sybil gate.

1. Let Zapp self-host the liveness verifier and be its own attestor.
2. Add unlinkable issuance to `simple-kyc-oss` so **no** operator, P2P or Zapp,
   holds a face-to-wallet join. We will write it.

## Proposed agreements, react 👍 / 👎 per row

| # | Topic | Proposal |
|---|-------|----------|
| 1 | **Self-hosted attestor** | Zapp runs its own `liveness_verifier` instance and its own attestor key, then calls `setLivenessAttestor(<our signer>)` on our integrator. Already supported: the attestor is an owner-settable address. |
| 2 | **Unlinkable issuance** | Split enrollment from redemption with a blind signature so the server never joins a template to an address. Zapp implements it as a PR to `simple-kyc-oss`, opt-in per tenant, default off. |
| 3 | **Sybil property** | Unchanged. One human, one claim per contract, still enforced by the single-use on-chain nullifier. We are not asking to weaken the gate. |
| 4 | **Contract** | Unchanged. Same EIP-712 struct, same `LivenessVerifier` domain, same immutable ceilings. No re-audit, no re-whitelist. |
| 5 | **Caps** | Unchanged. $20 per tx, 5 orders/day, immutable ceilings. |
| 6 | **Face data** | Never leaves the device in a form any operator can join to an address. The selfie is still processed server-side for dedup and still discarded; only the template persists, now with no wallet column. |
| 7 | **Fallback if (1) is refused** | We ask instead that our backend-signed `PurchaseAuthorization` serve as the $20 gate. Weaker on Sybil, but no biometrics collected by anyone. |

## Why this is worth P2P's time

- **Liability drops.** Today P2P holds biometric templates joined to addresses
  across every tenant. Your own README puts that under DPDP, LGPD, and NDPA with
  the deployer carrying the obligation. After this change there is no join to
  hand over.
- **It is not a Zapp special case.** Every integrator on the $20 tier gets it,
  and any of them can stay on the current mode.
- **The gate is identical.** We are not trading Sybil resistance for privacy. The
  contract still spends one nullifier per human per contract.
- **We write the code**, upstream, with tests, in your repo.

## Open decisions

- Do you want unlinkable mode upstream in `simple-kyc-oss`, or as a Zapp-only
  deployment flag?
- Does the reputation layer already expose a document-based zk path (ZKPassport,
  Anon Aadhaar)? For tiers above $20 we would rather build against that than add a
  second biometric surface. (A zk circuit over the biometric itself does not work;
  the technical doc §7 says why, since it is the obvious first question.)
- Enclave-side embedding (operator cannot read the selfie at all) is the stronger
  version of the same idea. Worth a phase 2, or out of scope?
- ArcFace `buffalo_l` is licensed non-commercial-research-only and is the default
  matcher. This blocks commercial use for both of us regardless of this proposal.
  What is the plan?
