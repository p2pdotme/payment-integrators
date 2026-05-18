# Contributing

Thanks for your interest in adding an integrator to the P2P protocol. This document is the source of truth for how PRs are structured, reviewed, and merged.

## TL;DR

- One integrator per PR.
- Use the canonical `UserProxy` — do not fork it.
- Tests, deploy script, and a `docs/integrators/<name>.md` must accompany every new integrator.
- All checks in `.github/PULL_REQUEST_TEMPLATE.md` must be ticked.
- CI (compile, test, solhint, slither) must pass.

## Before you start

Open an issue using the **"New integrator proposal"** template so we can sanity-check fit before you spend time. Tell us:

- What product / business client this integrator serves
- Why the existing integrators don't fit
- Anything non-standard (custom auth, vault, async fulfillment, ...)

## Branching + commit style

- Branch from `main`. Name: `feat/integrator-<short-name>` or `fix/<short-name>-<what>`.
- One logical change per commit. Squash if your branch grew noisy — keep `main` history readable.
- Commit message format follows [Conventional Commits](https://www.conventionalcommits.org/):
  - `feat(integrator): add <Name>`
  - `fix(<name>): <what>`
  - `docs(<name>): <what>`
  - `test(<name>): <what>`
- PR title mirrors the lead commit. Keep it under 72 chars.

## PR structure

For a new integrator, your PR should contain:

```
contracts/integrators/<name>/
├── <Name>CheckoutIntegrator.sol
└── <any helper interfaces / structs>
test/
└── <name>-integrator.test.ts
scripts/
└── deploy-<name>.ts
docs/integrators/
└── <name>.md
```

Mocks for upstream protocols you depend on go under `contracts/test/`. Do not import upstream protocol contracts at compile time unless they live in a versioned npm package you list in `package.json` (and that addition is justified in the PR description).

## Required for every integrator

### Code

- **SPDX license header**: `// SPDX-License-Identifier: Apache-2.0` (must match repo license).
- **Solidity pragma**: `^0.8.20` minimum. Use `^0.8.28` if you need a 0.8.28-only feature.
- **NatSpec** on every external function and on the contract itself.
- **Implements `IP2PIntegrator`** correctly. The Diamond will call `validateOrder`, `onOrderComplete`, and `onOrderCancel` — all three must be wired.
- **Use the canonical `UserProxy`** at `contracts/base/UserProxy.sol`. Per-user state and CREATE2 deployments must match the bytecode the Diamond expects. Forking the proxy will fail `registerIntegrator`.
- **No upgradeability**. Integrators are immutable contracts. If you need to ship a new version, deploy a new integrator and request re-whitelisting.
- **No `selfdestruct`**, no `delegatecall` to user-controlled addresses.
- **Reentrancy**: follow checks-effects-interactions, or use OpenZeppelin's `ReentrancyGuard` on any external function that touches accounting state then makes a token call.
- **Access control**: clearly mark `onlyOwner` / `onlyDiamond` paths. `onOrderComplete` and `onOrderCancel` MUST gate on `msg.sender == diamond`.
- **Gas-bounded loops**: the Diamond's `_assignMerchantsForB2BOrder` already loops over merchants. Don't compound it with unbounded loops in `validateOrder` or `onOrderComplete`.
- **Use `SafeERC20`** for all USDC movements.

### Tests

- Hardhat + Mocha + Chai.
- ≥ 90% line coverage, ≥ 80% branch coverage (`npx hardhat coverage`).
- Tests run against the provided mocks (`MockDiamond`, `MockUSDC`, ...). If your integrator depends on an external protocol, add a focused mock under `contracts/test/`.
- Cover at least: happy-path order placement, `onOrderComplete` accounting, `onOrderCancel` reversal, per-tx limit enforcement, daily-count enforcement, access control on every privileged function, replay/reentrancy of the completion callback.

### Docs

`docs/integrators/<name>.md` should answer:

- What product does this integrator serve?
- What external protocols does it depend on, and at what addresses (mainnet + Sepolia)?
- What's the order lifecycle from the user's POV?
- Any non-standard custody flow (e.g. LotPot's credit redemption)
- Limits / RP behavior — does it follow the standard or override?
- Operational notes (allowlists, keepers, etc.)

### Deploy script

`scripts/deploy-<name>.ts` must:

- Read all addresses from env vars (no hardcoding).
- Log the deployed integrator address and any side artifacts (proxy impl, etc.).
- Print Etherscan/Sourcify verification commands.

## Security checklist (also in the PR template)

- [ ] Reentrancy considered on every external function
- [ ] `onOrderComplete` and `onOrderCancel` gated on `msg.sender == diamond`
- [ ] No `delegatecall` to attacker-controlled addresses
- [ ] No `selfdestruct`
- [ ] No upgradeability primitives (no proxy, no `delegatecall`-to-impl)
- [ ] Per-tx + daily limits enforced
- [ ] All USDC movements use `SafeERC20`
- [ ] Constructor parameters validated (`address(0)` checks, range checks)
- [ ] Events emitted for every state-changing function
- [ ] Slither produces no high-severity findings on your contract
- [ ] Tests cover happy path + every revert + access-control negatives
- [ ] No new external runtime dependencies without justification

## Tooling

```bash
npm install
npm run compile           # hardhat compile
npm test                  # hardhat test
npm run lint              # solhint
npm run format            # prettier write
npm run format:check      # prettier check (CI runs this)
```

Slither is run automatically in CI. To run locally:

```bash
pip install slither-analyzer
slither contracts/integrators/<your-name>
```

## Review process

1. CI must be green.
2. CODEOWNERS approval required for any change to `contracts/interfaces/` or `contracts/base/`.
3. Two maintainer approvals are the **target policy** for new integrators. Until a second maintainer is added to [`CODEOWNERS`](.github/CODEOWNERS), one approval is sufficient in practice — the gap is tracked there as a TODO. Branch protection in GitHub settings is what actually enforces the count.
4. Maintainers may request a security review for non-trivial integrators (anything touching custody, vaults, async fulfillment, or cross-protocol routing).

## After merge

Merging puts your code in the repo. To go live on mainnet:

1. Deploy + verify on Etherscan / Sourcify.
2. Open a **"Whitelist request"** issue with deployed address, bytecode hash, expected `circleId`(s), and verification links.
3. P2P team verifies bytecode matches the merged commit, then submits the whitelist transaction.

See [`docs/WHITELISTING.md`](docs/WHITELISTING.md) for the full flow.

## Code of Conduct

Be respectful. Disagreement is fine; personal attacks are not. Maintainers reserve the right to close issues / PRs that violate this.
