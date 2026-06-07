# payment-integrators

Open source Solidity integrators for the **P2P B2B checkout protocol**.

P2P is a B2B checkout layer that lets businesses accept local fiat payments (UPI, PIX, SPEI, …) and settle in USDC on Base. An **integrator** is a contract that sits between an end-user and the P2P Diamond protocol, enforcing app-specific rules (per-tx limits, daily caps, product-quantity logic, custom routing) and delivering the on-chain side of the purchase once fiat settles.

This repository is the canonical home for:

- The protocol-side interfaces every integrator must satisfy
- The reference `UserProxy` (CREATE2 per-user proxy) every integrator must use
- A worked `ExampleIntegrator` to fork from
- Production integrators (currently: `LotPotCheckoutIntegrator`)
- The CONTRIBUTING + WHITELISTING process for getting a new integrator approved on the Diamond

## Accepted integrators

| Name | Location | Network | Status | Whitelisted address |
|---|---|---|---|---|
| LotPot | `contracts/integrators/lotpot/LotPotCheckoutIntegrator.sol` | Base mainnet | Production | [`0xb901c3399ED225e4C6c7bfbd8DABA16BBF340132`](https://basescan.org/address/0xb901c3399ED225e4C6c7bfbd8DABA16BBF340132) |
| polycule.bet | `contracts/integrators/polycule-bet/PolyculeBetIntegrator.sol` | Base mainnet | Pending whitelisting | TBD |
| Example | `contracts/integrators/ExampleIntegrator.sol` | — | Reference (not whitelisted) | n/a |

> PR merge ≠ whitelisting. The Diamond holds an explicit allowlist that gates which integrator contracts can place B2B orders. See [docs/WHITELISTING.md](docs/WHITELISTING.md).

## Repository layout

```
contracts/
├── interfaces/        Protocol surface — changes require core review
├── base/UserProxy.sol The canonical per-user CREATE2 proxy
├── integrators/       New integrators go here, one subfolder per integrator
├── examples/          Reference business clients (SimpleERC721Client)
├── templates/         Starter contracts to copy from (MyIntegrator.sol)
└── test/              Mocks used by hardhat tests (Diamond, USDC, Megapot, ...)

test/                  Hardhat tests (one file per integrator)
scripts/               Deploy + smoke + inspect helpers
docs/                  Architecture, proxy pattern, limits, whitelisting
```

## Quick start

```bash
git clone https://github.com/p2pdotme/payment-integrators.git
cd payment-integrators
npm install
npx hardhat compile
npx hardhat test
```

## Authoring a new integrator

1. Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/PROXY-PATTERN.md`](docs/PROXY-PATTERN.md).
2. Copy [`contracts/templates/MyIntegrator.sol`](contracts/templates/MyIntegrator.sol) into `contracts/integrators/<your-name>/`.
3. Implement `IP2PIntegrator`. Use the canonical `UserProxy` — do not fork it.
4. Add hardhat tests using the provided mocks.
5. Open a PR. Follow [`CONTRIBUTING.md`](CONTRIBUTING.md).
6. Once merged, request whitelisting per [`docs/WHITELISTING.md`](docs/WHITELISTING.md).

### Claude Code skills (optional, accelerator)

If you use [Claude Code](https://docs.claude.com/en/docs/claude-code), this repo ships two bundled skills that automate the scaffolding + whitelist flow. They auto-load when you start `claude` inside the repo — no install step.

- **`/new-integrator <name>`** — scaffolds the contract, test file, deploy script, and docs page from the canonical template, following CONTRIBUTING.md conventions. Defaults to convention, soft-warns on deviation, never auto-commits or auto-pushes.
- **`/whitelist-request <address> <chain>`** — after you've deployed + verified on Basescan, verifies on-chain bytecode parity against the merged commit, renders the [whitelist-request issue template](.github/ISSUE_TEMPLATE/whitelist-request.md), and opens the issue via `gh`.

Source: [`.claude/skills/new-integrator/SKILL.md`](.claude/skills/new-integrator/SKILL.md), [`.claude/skills/whitelist-request/SKILL.md`](.claude/skills/whitelist-request/SKILL.md). Both are intentionally manual-invocation only (`disable-model-invocation: true`) so Claude never triggers them without you typing the slash command.

## Governance

Today: maintainers from the P2P team review PRs; the Diamond owner submits whitelist transactions. Tomorrow: community reviewers + multisig + on-chain governance. See [`GOVERNANCE.md`](GOVERNANCE.md) for the roadmap.

## Security

Responsible disclosure: see [`SECURITY.md`](SECURITY.md). Do not file public issues for vulnerabilities — email instead.

## License

[Apache 2.0](LICENSE).
