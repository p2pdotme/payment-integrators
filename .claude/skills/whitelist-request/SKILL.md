---
name: whitelist-request
description: File a Whitelist Request GitHub issue for a deployed integrator. Verifies on-chain bytecode matches the merged commit, gathers operational params, renders the .github/ISSUE_TEMPLATE/whitelist-request.md template, and opens the issue via gh. Use after deploying + verifying an integrator on Basescan, when ready to request whitelisting on the P2P Diamond.
argument-hint: [address] [chain]
arguments: [address, chain]
disable-model-invocation: true
allowed-tools: Read Glob Grep Bash(git *) Bash(gh *) Bash(cast *) Bash(npx hardhat *) Bash(node *) Bash(jq *)
---

# File a whitelist request

File a GitHub issue requesting whitelisting of the deployed integrator at `$address` on chain `$chain`. Follows the [WHITELISTING.md](../../../docs/WHITELISTING.md) flow and uses the [whitelist-request.md](../../../.github/ISSUE_TEMPLATE/whitelist-request.md) issue template.

## Step 0 — Preconditions

- Confirm CWD is the `payment-integrators` repo (`package.json` name is `@p2pdotme/payment-integrators`). If not, abort.
- Confirm `gh` CLI is authed: `gh auth status`. If not, tell the user to run `gh auth login` and stop.
- Confirm the issue template exists at `.github/ISSUE_TEMPLATE/whitelist-request.md`. If not, abort.

## Step 1 — Resolve address + chain

If `$address` is empty, ask: "What's the deployed integrator address? (0x… checksum)."

Validate the address is 20 bytes hex. **Soft-warn** if not checksummed but accept it (we'll normalise via `cast` later).

If `$chain` is empty, ask: "Which chain? `base` (mainnet, 8453) or `base-sepolia` (84532)?" Default to `base-sepolia` for new deployments.

## Step 2 — Verify bytecode parity

This is the most important step — the entire point of the whitelist preflight check.

1. Fetch the on-chain runtime bytecode. Prefer `cast`; fall back to a Hardhat one-liner if `cast` isn't installed:

   ```bash
   # Preferred:
   cast code <address> --rpc-url <rpc-for-chain>

   # Fallback (no cast):
   npx hardhat console --network <chain> --no-compile
   > await ethers.provider.getCode("<address>")
   ```

   Pick the RPC from `hardhat.config.ts` for the named chain.

2. Compute the keccak256 hash of the on-chain bytecode:

   ```bash
   cast code <address> --rpc-url <rpc> | cast keccak
   ```

3. Find the matching compiled artifact. Grep `artifacts/contracts/integrators/**/*.json` for an artifact whose `deployedBytecode` hash (keccak of the bytecode-without-metadata bytes) matches the on-chain hash. The artifact's `contractName` tells you which integrator this is.

   **Important caveat:** Solidity embeds a metadata hash in the deployed bytecode (the trailing IPFS/swarm hash, typically the last ~53 bytes). For a faithful comparison, either:
   - Compare the bytecode-without-the-metadata-suffix on both sides (strip the last 53 bytes), OR
   - Accept that the hash will differ if anything in the compilation inputs (source paths, optimizer settings, compiler patch version) changed, and report this clearly.

   For the whitelist issue, report **both**: the raw on-chain hash AND the artifact's hash. If they match exactly: great. If they only match modulo the metadata suffix: report this as "metadata-stripped match" — the protocol team can decide whether that's acceptable.

4. Resolve the **merged commit SHA** that produced this artifact. The simplest heuristic:
   - Look at `git log --oneline -- contracts/integrators/<dir>/` and pick the most recent commit on `main` that touched the integrator's directory.
   - If the user is on a feature branch with uncommitted changes that affect the integrator, **warn loudly** — the deployed bytecode almost certainly does not match the branch HEAD, and the whitelist request will be rejected.

## Step 3 — Resolve the proxyImpl

Every integrator deploys its own canonical UserProxy implementation in the constructor (`proxyImpl = address(new UserProxy())`). Read it from the deployed contract:

```bash
cast call <integrator-address> "proxyImpl()(address)" --rpc-url <rpc>
```

Record this — it goes in the issue body as the `Pinned proxyImpl` field, and the Diamond stores it as part of the `registerIntegrator` record for the CREATE2-auth path.

## Step 4 — Gather operational params

Ask the user, one at a time, with sensible defaults:

1. **Integrator display name** [auto-derive from the artifact's `contractName`, stripping the `CheckoutIntegrator` suffix].
2. **Deployer address** [pull from the deployment tx if you can find it; otherwise ask].
3. **Constructor args** [if the user has the deploy tx hash, decode them via `cast` — otherwise ask].
4. **Block + tx hash of deployment** [optional but helpful — ask].
5. **Etherscan / Basescan verification URL** [required; refuse to file the issue without it].
6. **Sourcify URL** [optional].
7. **Expected `circleId`(s)** — one or more numeric IDs. Read [docs/INTEGRATORS.md](../../../docs/INTEGRATORS.md) for context on what a circleId is if the user is unsure.
8. **Owner address** of the integrator (the address that called `setBaseTxLimit` / `setMaxTxLimit` / etc.) — read via `cast call <addr> "owner()(address)"`.
9. **Maintainer contact** for incident response — default `dev@p2p.me`.

## Step 5 — Render the issue body

Read `.github/ISSUE_TEMPLATE/whitelist-request.md`, strip the frontmatter (the `--- ... ---` block at the top), and substitute every placeholder. The template's structure must be preserved — reviewers expect the same section headers in the same order.

Fill in the four pre-flight checkboxes with `[x]` only if you can verify them:

- `Bytecode hash matches the merged commit` — `[x]` only if Step 2 produced a clean match (or metadata-stripped match the user confirmed). Otherwise leave `[ ]` and add a note under the checkbox.
- `Etherscan source verified` — `[x]` if the user provided a Basescan URL with "Contract" tab and "Source" code visible.
- `(mainnet only) Sepolia version has been live with successful E2E orders` — only relevant for `base` requests. For `base-sepolia`, change this line to a note instead of a checkbox.
- `Any upstream allowlists have been set up` — leave `[ ]` and ask the user; this is integrator-specific (e.g. LotPot needs Megapot's `BatchPurchaseFacilitator` allowlist).

Write the rendered body to `/tmp/whitelist-request-<short-sha>-<address-prefix>.md` and let the user inspect it before filing.

## Step 6 — File the issue

Confirm with the user that the rendered body looks correct, then:

```bash
gh issue create \
  --title "[Whitelist] <Display Name> on <chain>" \
  --body-file /tmp/whitelist-request-<...>.md \
  --label whitelist
```

Do NOT use `--template whitelist-request.md` — that opens an interactive editor and would discard the rendered body. The `--body-file` path is what we want.

**Do not** auto-assign reviewers or add labels other than `whitelist` — that's the protocol team's call.

## Step 7 — Hand off

Return the issue URL. Print next-step guidance:

1. Link the issue from the integrator's PR (if not already merged) or from any follow-up PRs.
2. The protocol team will verify bytecode independently before submitting the on-chain `registerIntegrator` tx.
3. Once registered, update `docs/INTEGRATORS.md` with the row (address, source commit, whitelisted-since date, status). This is enforced by reviewer eyes, not CI — see the "How this table is maintained" note in that doc.
4. For mainnet whitelists, expect a 7-day review window; for Sepolia, same-day is normal.

## Failure modes — what to do

| Symptom | Action |
|---|---|
| Bytecode hash mismatch (not even metadata-stripped match) | Stop. The deployment doesn't match any commit in this repo. Ask the user which branch + commit they deployed from. |
| `cast` not installed | Use the Hardhat fallback in Step 2. Do not silently use a less-rigorous check. |
| User isn't on `main` and the diff touches the integrator | Refuse to proceed until the integrator's PR is merged. The protocol team will not whitelist code that isn't on main. |
| `gh` not authed | Print the body to stdout instead, with `gh issue create --title ... --body-file ...` as a copy-paste command the user can run after authing. |
| Issue template missing | Abort — the repo is in an unexpected state. |
