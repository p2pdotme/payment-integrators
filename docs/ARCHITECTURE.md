# Architecture

## What an integrator does

An **integrator** is the contract that sits between a user-facing checkout flow and the P2P Diamond. From the protocol's perspective, the integrator is the entity calling `placeB2BOrder` — the Diamond enforces protocol-level invariants, the integrator enforces app-specific ones.

```
┌──────────┐    userPlaceOrder      ┌────────────┐  placeB2BOrder  ┌─────────┐
│   User   │ ─────────────────────▶ │ Integrator │ ──────────────▶ │ Diamond │
└──────────┘                        └────────────┘                 └─────────┘
                                          ▲                              │
                                          │ onOrderComplete              │
                                          └──────────────────────────────┘
                                            (called after fiat settles)
                                          │
                                          ▼
                                    ┌────────────┐ onCheckoutPayment ┌────────┐
                                    │ UserProxy  │ ────────────────▶ │ Client │
                                    └────────────┘                   └────────┘
```

## Lifecycle

1. **User calls `userPlaceOrder`** on the integrator with: client, productId, quantity, currency, circleId, encrypted pubkey.
2. The integrator deploys a **per-user `UserProxy`** via `Clones.cloneDeterministicWithImmutableArgs` if one doesn't exist yet. The clone's address is deterministic: CREATE2 with deployer = the integrator contract, salt = the user EOA, and 40 bytes of immutable args = `(user, integrator)` packed. Per-(integrator, user) separation comes from the deployer being the integrator — the salt itself is user-only.
3. The proxy calls `IB2BGateway.placeB2BOrder` on the Diamond. **The proxy is `msg.sender` to the Diamond**, which is the address the Diamond authorizes via its CREATE2-auth path (re-derives the predicted address from the integrator's pinned `proxyImpl`, the user salt, and the packed args).
4. Diamond assigns merchants for the order.
5. User pays fiat off-chain → merchant marks ACCEPTED → user marks PAID → merchant marks COMPLETED.
6. Diamond calls `integrator.onOrderComplete(orderId, user, amount, recipientAddr)`.
7. Integrator routes USDC into the business client by calling `client.onCheckoutPayment(user, usdcAmount, productId, quantity)`. The client delivers the product (mint NFTs, credit balances, etc.).

If the order is cancelled at any point (expiry, dispute, manual), Diamond calls `integrator.onOrderCancel(orderId)`. The integrator should reverse any per-user accounting it consumed during `validateOrder` (e.g. release the daily-count debit).

## Why `UserProxy` exists

Two reasons:

1. **CREATE2 authentication**: The Diamond authorizes integrators by verifying that `msg.sender` matches the CREATE2 address derived from the pinned `proxyImpl`, the immutable args `(user, integrator)`, and the user-only salt — with the integrator contract as the deployer. This lets the Diamond verify *which integrator deployed which proxy* without maintaining a separate per-proxy allowlist. This is why `UserProxy.sol` must not be forked — its bytecode and immutable-args layout must match what the Diamond expects when the integrator was registered.
2. **Fraud-bypass closure**: USDC stranded on a proxy cannot be swept out by the user. It can only be consumed by the upstream protocol the integrator routes to. This closes a path where a scammer could use a B2B integration to convert fiat → USDC while evading consumer-side fraud checks. See [`PROXY-PATTERN.md`](PROXY-PATTERN.md) for the full reasoning.

## Where state lives

- **Per-user RP, daily-count counters**: on the integrator.
- **Per-product price**: on the business client (`ICheckoutClient.getProductPrice`).
- **USDC custody during an open order**: on the per-user `UserProxy`.
- **Order state machine (PLACED → ACCEPTED → PAID → COMPLETED)**: on the Diamond.

## Required interface

Every integrator must implement [`IP2PIntegrator`](../contracts/interfaces/IP2PIntegrator.sol):

- `validateOrder(user, amount, currency)` — called by the Diamond at `placeB2BOrder` time to apply integrator-specific limits before the order is recorded. Reverting blocks the order.
- `onOrderComplete(orderId, user, amount, recipientAddr)` — called by the Diamond when fiat settles. Integrator routes USDC to the client and triggers delivery.
- `onOrderCancel(orderId)` — called by the Diamond on cancellation. Integrator should release whatever consumable state it debited in `validateOrder`.

These are the protocol's contract with the integrator. Everything else (per-tx limits, RP curve, quantity, credit redemption, …) is an integrator-private concern.

## Where each integrator differs

- **ExampleIntegrator**: vanilla flow. Per-product price, per-tx limits, daily count, no exotic routing.
- **LotPotCheckoutIntegrator**: replaces "client delivers product" with "Megapot mints lottery tickets to user EOA". Adds a credit-redemption path that lets stranded USDC be redeemed for tickets without re-placing a Diamond order.

When designing a new integrator, the question to answer is: *what changes for me on the `onOrderComplete` side?* If you're just routing USDC to a client, copy `ExampleIntegrator`. If you're routing through a third-party protocol with its own pricing / inventory / NFT receipt logic, use `LotPotCheckoutIntegrator` as a more elaborate reference.
