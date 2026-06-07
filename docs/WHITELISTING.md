# Whitelisting

**PR merge ≠ whitelisting.** This document describes how a merged integrator becomes a live integrator on the P2P Diamond.

## Why two steps

Merging code into `main` says: "this contract is reviewed, tested, and conforms to the protocol." Whitelisting on the Diamond says: "this exact deployed bytecode is allowed to call `placeB2BOrder`." Keeping them separate means:

- A code review never directly grants on-chain power.
- Multiple deployments of the same code can be whitelisted independently (e.g. one on Sepolia for testing, one on mainnet for production).
- A compromise of the repo doesn't auto-grant a malicious integrator access to the Diamond.

## The flow

### 1. Deploy

After your PR is merged:

```bash
cd payment-integrators
git pull
npm install
DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x... \
  npx hardhat run scripts/deploy-<your-name>.ts --network base
```

Log the deployed integrator address and any side artifacts (proxy implementation, etc.). The deployer key becomes the integrator's owner.

### 2. Verify on Etherscan / Sourcify

```bash
npx hardhat verify --network base <integrator-address> <constructor args>
```

The source on Etherscan must match the merged commit. Reviewers will diff the verified source against the commit hash.

### 3. Open a "Whitelist request" issue

Use the **"Whitelist request"** issue template. Required fields:

- **Network**: `base` or `baseSepolia`
- **Integrator address**: `0x...`
- **Pinned `proxyImpl`**: `0x...` — output of `cast call <integrator> "proxyImpl()(address)" --rpc-url <rpc>`
- **`usdcThroughIntegrator`**: `true` or `false` — pinned at registration. `true` routes BUY proceeds to the integrator on completion (e.g. LotPot, TradeStars); `false` routes direct to the order's `recipientAddr`. Must match what the integrator's `onOrderComplete` was coded to expect.
- **Deployer address**: `0x...`
- **Merged commit hash**: short SHA, e.g. `8f89206`
- **Bytecode hash**: `keccak256(<runtime bytecode>)` — paste output of `cast code <addr> | cast keccak`
- **Etherscan verification link**: full URL
- **Expected `circleId`(s)**: integer(s) the integrator will pass to `placeB2BOrder`
- **Operational contact**: how to reach you for incident response

### 4. P2P team verifies + whitelists

Reviewers:

1. Pull the merged commit, compile, compare bytecode hash against the deployed contract.
2. Confirm verified source on Etherscan matches the merged commit.
3. Confirm the integrator's pinned `proxyImpl` matches the canonical `UserProxy` bytecode. This is an **off-chain review check** — the Diamond does not re-verify proxy bytecode on `registerIntegrator`; it only stores the address. If a non-canonical `proxyImpl` is registered, the CREATE2 auth path still works (clones of the non-canonical impl will pass `msg.sender` derivation) but the proxy's USDC-trapping behavior would be whatever the non-canonical impl implements. The off-chain bytecode-match is therefore the actual security gate.
4. Confirm constructor parameters (Diamond address, USDC address, per-tx and daily limits, etc.) are correct.
5. Submit `registerIntegrator(integrator, usdcThroughIntegrator, proxyImpl)` on the Diamond (gated by `onlySuperAdmin`).

**`proxyImpl` is set-once per integrator.** Re-registering the same integrator address with a different `proxyImpl` reverts with `B2BProxyImplLocked` — this is the on-chain enforcement that prevents a registered integrator from later rotating its proxy implementation under existing clones. The other fields (`isActive`, `usdcThroughIntegrator`) can be re-asserted by calling `registerIntegrator` again with the same `proxyImpl`. To take an integrator offline, use `deactivateIntegrator(integrator)`; in-flight orders continue to complete, only new placements fail.

### 5. Smoke-test on Sepolia first

For mainnet whitelisting, P2P will typically require:

- A working Sepolia deployment whitelisted on the Sepolia Diamond.
- At least one successful end-to-end order on Sepolia, including `onOrderComplete` callback execution.

If you're targeting mainnet directly without a Sepolia pre-flight, expect reviewers to push back.

## Removal / replacement

Integrators are immutable. To "upgrade" an integrator:

1. Open a PR with the new version (different filename or new subdirectory if substantive changes).
2. After merge, deploy the new contract.
3. Open a whitelist request for the new address.
4. Optionally, open a separate "deregister request" for the old address — P2P will deregister once you've migrated traffic.

Do not attempt to use a proxy pattern to make the integrator upgradeable. The Diamond's CREATE2 auth would still work, but you'd be giving yourself a privileged surface that the security model doesn't account for. Immutability is a deliberate constraint of this repo.

## Emergency deregistration

If a security issue is discovered in a live integrator, P2P maintainers can deregister it from the Diamond unilaterally. This is a one-way action — re-registration requires a fresh whitelist request. We will notify the integrator owner before deregistering whenever possible, but a critical bug may trigger immediate action.
