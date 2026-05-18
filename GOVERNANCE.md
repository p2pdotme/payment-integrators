# Governance

This document describes who decides what gets merged into this repo and what gets whitelisted on the P2P Diamond.

## Today (Phase 0)

**PR review**: P2P core maintainers. Two approving reviews required for any new integrator. Any change touching `contracts/interfaces/` or `contracts/base/` requires CODEOWNERS approval.

**Whitelist execution**: the Diamond owner (held by the P2P deployer key) submits the on-chain `registerIntegrator` transaction once a deployed contract is verified and matches the merged commit. There is no separate review layer between PR merge and on-chain whitelist — the P2P team performs both steps.

**Why this is OK for now**: until there are multiple external integrators in production, the surface for governance attacks is small and the speed benefit of direct review is high.

## Phase 1 — community reviewers (target: when 3+ external integrators are live)

- External reviewers added to CODEOWNERS for specific subdirectories (e.g. an auditor maintains review rights over a vault integrator they helped write).
- Snapshot space (`p2p.eth` or similar) used for off-chain signal on contentious whitelist requests.
- Diamond ownership moved behind a multisig (3-of-5 P2P + community reviewers).

## Phase 2 — timelock + multisig

- Whitelist transactions go through a Timelock contract with a 48-hour delay.
- Multisig holds the keys; community can monitor pending actions in the delay window.
- Anyone can cancel a pending whitelist if a security issue is discovered during the delay.

## Phase 3 — on-chain DAO

- Governance token or NFT-gated voting (TBD).
- Formal proposal lifecycle: discussion → snapshot → on-chain vote → execute.
- Whitelist additions, removals, and protocol-interface changes all flow through this.

## Out of scope

This document does not cover Diamond-level upgrades (facet additions, removals) — those are governed separately in the protocol repo. Integrator whitelist is the only governance surface this repo controls.
