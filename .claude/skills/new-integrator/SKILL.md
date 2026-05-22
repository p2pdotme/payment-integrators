---
name: new-integrator
description: Scaffold a new payment integrator in this repo from the canonical MyIntegrator template. Generates the contract, test file, deploy script, and docs page in the correct repo layout following CONTRIBUTING.md conventions. Use when starting a new integrator, adding integrator scaffolding, or creating a feature branch for a new merchant/protocol integration.
argument-hint: [name]
arguments: [name]
disable-model-invocation: true
allowed-tools: Read Write Edit Glob Grep Bash(git *) Bash(npm *) Bash(npx hardhat *) Bash(node *)
---

# Scaffold a new integrator

Scaffold a new integrator named `$name` under `contracts/integrators/<name>/`. This is a guided multi-step workflow that follows [CONTRIBUTING.md](../../../CONTRIBUTING.md). At every step, **default to the convention and soft-warn on deviation** — never hard-block.

## Step 0 — Preconditions

Run these and abort with a clear message if any fail:

- Confirm CWD is the `payment-integrators` repo: read `package.json` and check `"name": "@p2pdotme/payment-integrators"`. If not, tell the user "this skill only runs inside the payment-integrators repo" and stop.
- Confirm `git status` is clean OR the only diff is untracked `.claude/`. If there are unstaged changes, ask the user to commit or stash before continuing.
- Confirm the canonical template exists at `contracts/templates/MyIntegrator.sol`. If not, the repo is in an unexpected state — abort.

## Step 1 — Resolve the name

If `$name` is empty, ask: "What's the integrator name? Use kebab-case for the directory (e.g. `acme-checkout` → `contracts/integrators/acme-checkout/`)."

Derive these three forms and confirm with the user:

| Form | Example for `acme-checkout` | Used where |
|---|---|---|
| `kebab` | `acme-checkout` | directory, filenames, deploy script |
| `Pascal` | `AcmeCheckout` | Solidity contract name (`AcmeCheckoutCheckoutIntegrator` ← yes, doubled — see warn below) |
| `display` | `Acme Checkout` | docs page title, PR title |

**Soft-warn** if the user-supplied name doesn't match `^[a-z][a-z0-9-]{1,30}$`. The convention is lowercase kebab; warn but accept anything that's a valid filesystem identifier.

**Naming convention** for the Solidity contract: `<Pascal>CheckoutIntegrator.sol`. If `Pascal` already ends in `Checkout` (e.g. `LotPotCheckout`), the contract name would double up (`LotPotCheckoutCheckoutIntegrator`) — warn the user and offer to drop the suffix to `<Pascal>Integrator.sol` instead.

## Step 2 — Gather four facts

Ask the user, one question at a time, with sensible defaults. Show the default in `[brackets]` and accept enter-to-confirm.

1. **Display name** for docs and PR title [auto-derived from `Pascal`].
2. **Upstream flavor** — pick one:
   - `example` — direct fulfillment, no upstream protocol. Use [ExampleIntegrator](../../../contracts/integrators/ExampleIntegrator.sol) as the reference.
   - `lotpot` — credit/redemption pattern (USDC strands on proxy until upstream call succeeds). Use [LotPotCheckoutIntegrator](../../../contracts/integrators/lotpot/LotPotCheckoutIntegrator.sol) as the reference.
   - `tradestars` — vault-backed offramp (40/60 split, Aave yield). Use [TradeStarsCheckoutIntegrator](../../../contracts/integrators/tradestars/TradeStarsCheckoutIntegrator.sol) as the reference.
   - `custom` — keep the bare template TODOs intact, let the user fill them in.
3. **USDC routing** — `usdcThroughIntegrator: true | false`. Default `true` for `example` / `lotpot` flavor, `false` for direct-to-`recipientAddr` flows. Warn the user that this value is pinned at `registerIntegrator` time and cannot be changed without re-registration.
4. **Maintainer contact** — email or GitHub handle that goes in the docs page and (later) the whitelist request issue. Default to the `dev@p2p.me` alias used elsewhere in the repo.

## Step 3 — Scaffold files

Create these four files (skip any that already exist — warn instead of overwriting):

### `contracts/integrators/<kebab>/<Pascal>CheckoutIntegrator.sol`

Start from `contracts/templates/MyIntegrator.sol`. Substitute:

- Contract name `MyIntegrator` → the resolved Solidity name.
- Update the NatSpec `@title` and `@notice` to describe THIS integrator (not the template).
- For `example`/`lotpot`/`tradestars` flavors, replace the TODO blocks with the corresponding sections from the reference contract. **Read the reference file in full**, port only what's relevant (don't blindly copy storage layouts or events for unrelated flows), and keep imports limited to what's actually used.
- For `custom`, keep the TODO blocks in place and add a one-line comment at the top: `// SCAFFOLDED BY /new-integrator — fill in TODOs before review.`
- SPDX line must be `// SPDX-License-Identifier: Apache-2.0` — this is non-negotiable for the repo and is what CI checks.
- Pragma `^0.8.20` unless the user explicitly needs a newer version (warn if they ask for `^0.8.28` — it works but only the TradeStars flow currently uses it, see CONTRIBUTING.md §Code).

### `test/<kebab>-integrator.test.ts`

Reference: [test/example-integrator.test.ts](../../../test/example-integrator.test.ts). Generate a test file that:
- Deploys MockDiamond + MockUSDC + the new integrator in `before`/`beforeEach`.
- Covers the eight scenarios from CONTRIBUTING.md §Tests: happy-path placement, `onOrderComplete` accounting, `onOrderCancel` reversal, per-tx limit, daily-count limit, access control on every `onlyOwner`/`onlyDiamond`/`onlyDiamond` function, replay/reentrancy on the completion callback.
- Each `it()` should be a real assertion, not a placeholder. If you genuinely cannot infer the assertion (e.g. for `custom` flavor TODOs), write `it.skip("…", () => { /* TODO */ })` so the test file compiles and runs but the missing coverage is visible.

### `scripts/deploy-<kebab>.ts`

Reference: [scripts/deploy-example.ts](../../../scripts/deploy-example.ts). Generate a script that:
- Reads all addresses from env vars (no hardcoding — `process.env.DIAMOND_ADDRESS`, etc.).
- Logs the deployed integrator address and the pinned `proxyImpl` (the integrator's constructor deploys this).
- Prints the Etherscan verification command at the end.
- Does NOT submit a registration call — that's a governance action, not part of the deploy script.

### `docs/integrators/<kebab>.md`

Reference: [docs/integrators/example.md](../../../docs/integrators/example.md) and [docs/integrators/tradestars.md](../../../docs/integrators/tradestars.md) for tone. Generate a docs page that answers:
- What product / business client this integrator serves
- External protocols + addresses (mainnet + Sepolia) — leave `<TBD>` placeholders if the user doesn't have addresses yet
- Order lifecycle from the user's POV
- Any non-standard custody / credit / async flow
- Limits / RP behavior — does it follow the standard or override?
- Operational notes
- Maintainer contact (from Step 2)

## Step 4 — Compile + test

Run, in order. On failure, show the error and ask whether to drop into a fix loop or hand off to the user.

```bash
npx hardhat compile
npm test
```

For `custom` flavor with skipped tests, `npm test` will pass but report skipped — that's fine, surface the count to the user.

## Step 5 — Format + branch

Run `npm run format` (the pre-commit hook will format on commit too, but doing it now means the user sees clean diffs in their editor).

Create the branch — convention is `feat/integrator-<kebab>`:

```bash
git checkout -b feat/integrator-<kebab>
```

**Soft-warn** if the user wants a different branch name; accept whatever they pass.

## Step 6 — Hand off

**Do NOT commit. Do NOT push. Do NOT open a PR.** Those are the user's decisions to make after they review the scaffolded files.

Print a checklist of next steps:

1. Review the generated files. The contract, test, deploy script, and docs all have placeholder content that needs your judgment.
2. Fill in any TODOs (`grep -rn "TODO" contracts/integrators/<kebab>/ test/<kebab>-integrator.test.ts scripts/deploy-<kebab>.ts docs/integrators/<kebab>.md`).
3. Run `npx hardhat coverage` to confirm you're over the 90% line / 80% branch gates required by CI.
4. When ready: commit using conventional-commit style (`feat(integrator): add <DisplayName>`), push, open a PR using the PR template. The security checklist in the PR template is the hard gate — every box must be ticked.
5. After merge: run `/whitelist-request <deployed-address> <chain>` to file the whitelist issue once you've deployed and verified on Basescan.

Report a summary of what was created (file paths + line counts) and any warnings raised during the workflow.
