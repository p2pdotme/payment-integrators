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
3. Confirm the integrator's pinned `proxyImpl` matches the canonical `UserProxy` bytecode (this is what the Diamond's CREATE2 auth path checks).
4. Confirm constructor parameters (Diamond address, USDC address, source tag, etc.) are correct.
5. Submit the `registerIntegrator(integrator, proxyImpl, source)` call on the Diamond.

The Diamond will reject the registration if the `proxyImpl` bytecode does not match the canonical `UserProxy`. This is by design — it's the protocol-side guarantee that whitelisted integrators have not subtly modified the proxy's USDC-trapping behavior.

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
