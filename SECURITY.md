# Security policy

## Reporting a vulnerability

**Do not file public GitHub issues for security vulnerabilities.**

Email: **dev@p2p.me**

You may also use GitHub's [private security advisory](https://github.com/p2pdotme/payment-integrators/security/advisories/new) feature, which is preferred if you want an audit trail in the repo itself. Both routes reach the maintainer team.

Please include:

- A clear description of the issue
- The integrator + commit hash affected
- Proof-of-concept code or a reproduction
- Your proposed severity (informational / low / medium / high / critical)
- Whether the issue affects code that is already deployed to mainnet

We aim to acknowledge within 72 hours and follow up with a remediation plan within 7 days.

## Scope

In-scope:

- Any contract in `contracts/integrators/` or `contracts/base/`
- The interfaces in `contracts/interfaces/`
- The reference `UserProxy` and any integrator that uses it

Out-of-scope:

- The P2P Diamond protocol itself (separate repo, separate disclosure)
- Test mocks under `contracts/test/`
- Anything in `docs/` or `scripts/` that isn't a deployed contract
- Issues that depend on the user signing a malicious payload they shouldn't have signed

## Bounty

The P2P team may award a discretionary bounty for high-severity, externally-reported issues. There is no formal program yet — this is at maintainer discretion.

## Disclosure

We follow coordinated disclosure: we will work with you on a fix, then publish a post-mortem once the fix is deployed and (where applicable) the affected integrator has been re-whitelisted.

## Already-deployed integrators

The integrators table in [`docs/INTEGRATORS.md`](docs/INTEGRATORS.md) lists deployed addresses. If you have found an issue affecting an address there, please flag the severity clearly so we can prioritise.
