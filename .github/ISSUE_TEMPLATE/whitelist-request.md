---
name: Whitelist request
about: Request whitelisting of a deployed integrator on the P2P Diamond
title: "[Whitelist] <Integrator Name> on <network>"
labels: ["whitelist"]
---

## Integrator

- **Name**:
- **Source path**: `contracts/integrators/<...>`
- **Merged commit SHA**:

## Deployment

- **Network**: `base` / `baseSepolia`
- **Deployed address**: `0x...`
- **Deployer address**: `0x...`
- **Constructor args used**:
- **Block / tx hash of deployment**:

## Verification

- **Etherscan / Basescan link**: <full URL with verified source>
- **Sourcify link** (optional):
- **Runtime bytecode hash**: `0x...` <!-- cast code <addr> | cast keccak -->
- **Pinned proxyImpl**: `0x...` <!-- the UserProxy implementation address the integrator deployed -->

## Operational params

- **Expected `circleId`(s)**:
- **Owner address** (integrator owner):
- **Maintainer contact** (for incident response):

## Pre-flight

- [ ] Bytecode hash matches the merged commit
- [ ] Etherscan source verified
- [ ] (mainnet only) Sepolia version has been live with successful E2E orders
- [ ] Any upstream allowlists (e.g. Megapot batch facilitator) have been set up

## Notes
