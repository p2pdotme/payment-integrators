# Deployed integrators

This is the canonical list of integrators that are whitelisted on the P2P Diamond. Anything not on this list is **not** authorized to call `placeB2BOrder`, even if the source is in this repo.

## Base mainnet (chainId 8453)

| Integrator | Address | Source commit | Whitelisted since | Status |
|---|---|---|---|---|
| LotPot | `0xb901c3399ED225e4C6c7bfbd8DABA16BBF340132` | <!-- TODO: backfill from p2p-checkout commit SHA --> | <!-- TODO: YYYY-MM-DD --> | Production |

## Base Sepolia (chainId 84532)

| Integrator | Address | Source commit | Whitelisted since | Status |
|---|---|---|---|---|
| LotPot | <!-- TODO: fill from project_sepolia_addresses or skip if not whitelisted --> | <!-- TODO --> | <!-- TODO --> | Test |

## How this table is maintained

Each row corresponds to a `registerIntegrator` call on the Diamond. Adding or removing a row requires both the on-chain action and a corresponding PR updating this file. CI does not enforce this — reviewers do.

When updating this file:

- Use the deployed address checksummed (mixed case).
- `Source commit` is the short SHA of the commit whose bytecode hash matches the deployed contract.
- `Status` is one of: `Production`, `Test`, `Deprecated`, `Deregistered`.

If you've added a row, link the whitelist request issue in the PR description so reviewers can match the on-chain action to the docs update.
