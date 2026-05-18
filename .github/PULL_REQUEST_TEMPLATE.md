<!--
Thanks for the PR. Fill out the relevant sections.
For a new integrator, every checkbox below must be ticked before maintainers can merge.
-->

## What this PR does

<!-- One paragraph. What does this integrator serve, and how is it different from existing ones? -->

## Type of change

- [ ] New integrator
- [ ] Fix to an existing integrator
- [ ] Docs only
- [ ] Tooling / CI / config
- [ ] Other (explain):

## Linked issues

<!-- For new integrators: link the "New integrator proposal" issue you opened first. -->

Closes #

## Security checklist (required for any contract change)

- [ ] Reentrancy considered on every external function
- [ ] `onOrderComplete` and `onOrderCancel` gated on `msg.sender == diamond`
- [ ] No `delegatecall` to attacker-controlled addresses
- [ ] No `selfdestruct`
- [ ] No upgradeability primitives
- [ ] Per-tx + daily limits enforced
- [ ] All USDC movements use `SafeERC20`
- [ ] Constructor parameters validated (`address(0)` checks)
- [ ] Events emitted for every state-changing function
- [ ] Uses canonical `UserProxy` (no fork)
- [ ] Slither produces no high-severity findings

## Tests

- [ ] Hardhat tests added/updated
- [ ] ≥ 90% line coverage, ≥ 80% branch coverage on touched contracts
- [ ] Tests cover: happy path, limit enforcement, access control, cancellation reversal
- [ ] `npx hardhat test` passes locally

## Docs

- [ ] `docs/integrators/<name>.md` added/updated
- [ ] Deploy script in `scripts/deploy-<name>.ts`
- [ ] README / INTEGRATORS table updated if relevant

## Whitelisting

<!-- After merge, file a separate "Whitelist request" issue with the deployed address. -->

- [ ] I will open a Whitelist request after merge (or)
- [ ] This PR is not deploying anything

## Notes for reviewers

<!-- Anything that needs special attention: novel custody flow, third-party dependencies, etc. -->
