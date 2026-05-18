# UserProxy pattern

This document explains why `UserProxy` exists, what its bytecode guarantees, and what an integrator may and may not do with it.

## Two jobs

`UserProxy` does two things:

1. **Be the `msg.sender` to upstream protocols on behalf of the user**, so per-user state lives at a deterministic, per-user address.
2. **Trap USDC**. USDC on the proxy can only exit through `execute` calls the integrator approves to an upstream protocol. The user-initiated `sweepERC20` rejects USDC; `execute` does not auto-refund the remainder back to the user EOA.

## Why USDC is trapped

The B2B flow converts user-supplied fiat into USDC on Base. If a scammer onboarded as a business and used a tame-looking integrator to convert fiat → USDC, they would have a way to evade the consumer-side fraud checks the protocol applies to direct B2C orders. By forcing USDC to exit only through whatever protocol the integrator routes to, we make the conversion irreversibly tied to the deliverable (e.g. an NFT minted to the user EOA, or a credit consumed within the integrator's flow).

Practical implication: if your integrator strands USDC on a proxy (e.g. because Megapot rejected a batch order), you need a **credit-redemption path** that consumes that USDC by re-running the upstream call. You cannot refund it to the user EOA. See `LotPotCheckoutIntegrator` for a worked example.

## CREATE2 authorization

The Diamond authorizes a proxy as "this integrator's proxy for this user" by:

1. Reading the integrator's pinned `proxyImpl` from its `registerIntegrator` record.
2. Computing `Clones.predictDeterministicAddress(proxyImpl, salt = user, deployer = integrator)`.
3. Requiring `msg.sender == predictedAddress`.

This means:

- **Every integrator must use `contracts/base/UserProxy.sol` unmodified**. If you fork it, the bytecode hash changes, the predicted address changes, and the Diamond will reject your proxy's calls.
- **The integrator's `proxyImpl` is pinned at registration time**. Changing it requires a re-registration, which is a governance action.
- **The salt is the user's EOA address**. There is exactly one proxy per (integrator, user) pair.

## What the proxy supports

`UserProxy` exposes:

- `execute(target, data, value)` — owner (= the integrator)-gated arbitrary call. This is how the integrator routes through to Megapot, marketplace clients, etc.
- `sweepERC20(token, to)` — user-initiated sweep of any **non-USDC** ERC-20 (e.g. partial fills, airdrops). USDC is explicitly rejected.
- `sweepERC721(token, tokenId, to)` and `sweepERC1155(token, id, amount, to)` — user-initiated NFT sweep. Useful if the upstream protocol minted to `msg.sender` instead of an explicit recipient.
- ERC-721 / ERC-1155 receiver hooks — so upstream protocols that mint to the proxy don't revert. The integrator can then sweep, or expose a different recovery path.

USDC is special: there is no user-initiated USDC sweep, and `execute` does not return unspent USDC to the user EOA. **All USDC outflows from the proxy must go through `execute` calls the integrator constructs.**

## What the integrator may not do

- Fork `UserProxy.sol` with a modified `execute` or sweep policy. The Diamond will reject the resulting proxy.
- Allow USDC to be swept back to the user EOA. Even by mistake — this is a security-critical invariant.
- Bypass the per-user salt (e.g. by using a shared "company proxy"). Per-user proxies are how the Diamond meters per-user limits at the proxy level.

## Operational notes

- The first order from a given user pays the gas to deploy that user's proxy clone (~50–80k gas for a `Clones.clone`). Subsequent orders reuse the same proxy.
- The proxy holds USDC during the order's open window (PLACED → COMPLETED). For LotPot this window is bounded by the Diamond's order expiry. If your integrator's upstream is async (e.g. Megapot's `BatchPurchaseFacilitator`), the window extends until upstream fulfillment.
- The proxy is not a target of `validateOrder` or `onOrderComplete` — only the integrator is. The proxy is purely an execution / custody primitive.
