# UserProxy pattern

This document explains why `UserProxy` exists, what its API actually is, and what an integrator may and may not do with it. Source: [`contracts/base/UserProxy.sol`](../contracts/base/UserProxy.sol).

> ### ⚠ The proxy implementation is **immutable** for the lifetime of an integrator registration
>
> When the protocol owner calls `registerIntegrator(integrator, usdcThroughIntegrator, proxyImpl)`, the `proxyImpl` address — and therefore the **bytecode** at that address — is pinned in the Diamond's `IntegratorConfig` for that integrator. The Diamond's CREATE2 authorization check computes the expected per-user proxy address from this pinned bytecode hash. If the bytecode changes (or you ship a fork of `UserProxy.sol`), every per-user proxy address shifts and the Diamond will reject every call from the new proxies as if they were unrelated contracts. Existing per-user proxies that were deployed against the old bytecode continue to work — the registration record is what got bricked, not their deployments.
>
> Concrete consequences:
>
> 1. **Do not fork `contracts/base/UserProxy.sol`.** Use it unmodified — same SPDX, same pragma, same imports, same compiler settings as in this repo. Reuse the artifact, do not recompile it with a different optimizer profile.
> 2. **Do not "upgrade" the proxy in place.** There is no upgrade primitive — the proxy has no admin, no `delegatecall` to an implementation slot. If you genuinely need new proxy behavior, deploy a new integrator contract with a new `proxyImpl` address and request a fresh `registerIntegrator`. The old integrator's users keep their old proxies.
> 3. **Verify bytecode parity before requesting whitelisting.** Run `solc --bin-runtime` (or the equivalent through Hardhat's `getDeployedCode`) against the version in this repo and against your deployed `proxyImpl`, and confirm the hashes match. The whitelist flow in [`WHITELISTING.md`](WHITELISTING.md) requires this hash to match the merged commit.
> 4. **Pin your compiler.** A Solidity patch-version bump (e.g. 0.8.28 → 0.8.29) can shift bytecode even when the source is identical. Hardhat's `solidity.version` setting and `solidity.settings.optimizer` must match what was used for the previously-whitelisted bytecode.
>
> Bottom line: treat `UserProxy.sol` and its compiled bytecode the same way you would treat an EIP-1167 minimal-proxy target — once a clone is deployed against it, the implementation is frozen for the lifetime of that registration.

## Two jobs

`UserProxy` does two things:

1. **Be the `msg.sender` to upstream protocols on behalf of the user**, so per-user state lives at a deterministic, per-user address.
2. **Trap USDC**. USDC on the proxy can only exit through `execute` calls the integrator drives. The user-initiated `sweepERC20` rejects USDC; `execute` does not auto-refund the remainder back to the user EOA.

## Why USDC is trapped

The B2B flow converts user-supplied fiat into USDC on Base. If a scammer onboarded as a business and used a tame-looking integrator to convert fiat → USDC, they would have a way to evade the consumer-side fraud checks the protocol applies to direct B2C orders. By forcing USDC to exit only through whatever protocol the integrator routes to, we make the conversion irreversibly tied to the deliverable (e.g. an NFT minted to the user EOA, or a credit consumed within the integrator's flow).

Practical implication: if your integrator strands USDC on a proxy (e.g. because Megapot rejected a batch order), you need a **credit-redemption path** that consumes that USDC by re-running the upstream call. You cannot refund it to the user EOA. See `LotPotCheckoutIntegrator` for a worked example.

## Two distinct roles

`UserProxy` distinguishes two addresses, both stored as immutable args inside the clone:

| Role | Returned by | Who is it? | What can they do? |
|---|---|---|---|
| **owner** | `owner()` | The **end-user EOA** | Call `sweepERC20/721/1155` to recover non-USDC assets stuck on the proxy. |
| **integrator** | `integrator()` | The **integrator contract** that deployed this proxy | Call `execute` and `transferERC20ToIntegrator` to drive USDC through the upstream protocol. |

Confusing these is a security-relevant bug. `execute` is gated on `msg.sender == integrator()`, **not** on the user EOA. Sweep functions are gated on `msg.sender == owner()`, **not** on the integrator.

## CREATE2 authorization

The Diamond authorizes a proxy as "this integrator's proxy for this user" by:

1. Reading the integrator's pinned `proxyImpl` from its `registerIntegrator` record.
2. Computing the deterministic clone address with `predictDeterministicAddressWithImmutableArgs(proxyImpl, abi.encodePacked(user, integrator), salt = user, deployer = integrator)`.
3. Requiring `msg.sender == predictedAddress`.

This means:

- **Every integrator must use `contracts/base/UserProxy.sol` unmodified**. If you fork it, the bytecode hash changes, the predicted address changes, and the Diamond will reject your proxy's calls.
- **The integrator's `proxyImpl` is pinned at registration time**. Changing it requires a re-registration, which is a governance action.
- **The salt is the user EOA only** (`bytes32(uint256(uint160(user)))`). The integrator's separation comes from the CREATE2 deployer being the integrator itself — different integrators with the same user have different proxy addresses.
- **The immutable args layout is `[owner(20)][integrator(20)]`**. `UserProxy.owner()` and `UserProxy.integrator()` read these fixed offsets via `Clones.fetchCloneArgs(address(this))`. Don't change the layout.

## API reference

### `execute(target, data, usdc, usdcAllowance) → bytes`

```solidity
function execute(
    address target,
    bytes calldata data,
    address usdc,
    uint256 usdcAllowance
) external nonReentrant returns (bytes memory result);
```

- **Caller**: must be `integrator()`. Reverts `OnlyIntegrator` otherwise.
- **Target restriction**: rejects `target == address(this)` and `target == integrator()` (`TargetNotAllowed`). Prevents recursive self-calls and integrator-to-itself bouncing.
- **USDC allowance**: if `usdcAllowance > 0`, `forceApprove(usdc, target, usdcAllowance)` is set before the call and reset to `0` after. If `usdcAllowance == 0`, no approval traffic — appropriate for placement-style calls like `IB2BGateway.placeB2BOrder` where the Diamond does not pull USDC.
- **No auto-refund**: any USDC remaining on the proxy after the call stays there. This is deliberate — the integrator must construct a recovery / credit-redemption path that consumes it via a subsequent `execute`.
- **Reentrancy**: `nonReentrant` modifier backed by transient storage (EIP-1153, requires Cancun-era EVM).

### `sweepERC20(token)`

```solidity
function sweepERC20(address token) external; // onlyOwner
```

- **Caller**: must be `owner()` (the end-user EOA).
- **Destination**: hard-coded to `msg.sender`. The user can't redirect the sweep elsewhere — they sweep to themselves only.
- **USDC blocked**: if `token == IUsdcSource(integrator()).usdc()`, reverts `USDCSweepBlocked`. The integrator's `usdc()` getter is the source of truth — every integrator must expose one as a public immutable.
- **No-op on zero balance**: silent return.

### `sweepERC721(token, tokenId)`

```solidity
function sweepERC721(address token, uint256 tokenId) external; // onlyOwner
```

- **Caller**: `owner()`.
- **Destination**: `msg.sender`. Uses `safeTransferFrom`.

### `sweepERC1155(token, id)`

```solidity
function sweepERC1155(address token, uint256 id) external; // onlyOwner
```

- **Caller**: `owner()`.
- **Destination**: `msg.sender`. Sweeps the proxy's full balance of that `id`. No-op on zero balance.

### `transferERC20ToIntegrator(token, amount)`

```solidity
function transferERC20ToIntegrator(address token, uint256 amount) external;
```

- **Caller**: must be `integrator()`.
- **Destination**: hard-coded to `integrator()`. The integrator cannot redirect the pull elsewhere through this function.
- **Use case**: needed when the integrator must be the on-chain caller of an upstream protocol that has an allowlist on `msg.sender` (e.g. Megapot's `BatchPurchaseFacilitator` which checks `isAllowed(msg.sender)`). Without this, the proxy can't get USDC to the integrator because `execute` rejects `target == integrator`.
- **Worst case** (compromised integrator key): the integrator drains the proxy's token balance to itself — same blast radius as `execute(target, transferData, …)`.

### Receiver hooks

`onERC721Received`, `onERC1155Received`, `onERC1155BatchReceived`, `supportsInterface` are all implemented so upstream protocols that mint to the proxy don't revert. The hooks return the expected selectors and otherwise do nothing — auto-forwarding inside the hook is unsafe (the original mint frame may still be open and many third-party mints emit / state-mutate after the hook returns). The user can sweep ERC-721/1155 receipts via the `sweep*` helpers.

## What the integrator must not do

- Fork `UserProxy.sol` with modified `execute` or sweep policy. The Diamond will reject the resulting proxy.
- Allow USDC to be swept back to the user EOA. Even by mistake — this is a security-critical invariant of the protocol.
- Bypass the per-user salt (e.g. by using a shared "company proxy"). Per-user proxies are how the Diamond meters per-user limits at the proxy level.
- Change the immutable-args layout. Other consumers (the Diamond's CREATE2 auth, the `owner()` / `integrator()` getters, the `IUsdcSource` resolution) depend on the `[owner(20)][integrator(20)]` byte layout.

## Operational notes

- The first order from a given user pays the gas to deploy that user's proxy clone (~50–80k gas for a `cloneDeterministicWithImmutableArgs`). Subsequent orders reuse the same proxy.
- The proxy holds USDC during the order's open window (PLACED → COMPLETED). For LotPot this window is bounded by the Diamond's order expiry. If your integrator's upstream is async (e.g. Megapot's `BatchPurchaseFacilitator`), the window extends until upstream fulfillment.
- The proxy is not a target of `validateOrder` or `onOrderComplete` — only the integrator is. The proxy is purely an execution / custody primitive.
- The `nonReentrant` modifier uses transient storage; if your custom integrator targets an EVM older than Cancun, you must use a fork of the proxy — but that breaks the Diamond's CREATE2 auth. The practical implication is: only deploy this stack on chains where the EVM is at Cancun or later.
