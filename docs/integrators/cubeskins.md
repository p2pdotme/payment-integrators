# CubeSkins integrator

## Product

Onramp (PIX → USDC) for the [CubeSkins](https://cubeskins.club) CS2 skin marketplace.
Users pay in BRL via PIX; USDC settles on Base to the company treasury; the CubeSkins
backend marks the marketplace order as `paid` after indexing `CheckoutFulfilled`.

## External dependencies

| Network | Diamond | USDC |
|---|---|---|
| Base Sepolia (84532) | `0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9` | `0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d` |
| Base mainnet (8453) | TBD after whitelist | Base USDC |

## Order lifecycle

1. User creates a marketplace order on CubeSkins (Steam auth + trade URL).
2. Backend relayer (`onlyOwner`) calls `registerOrder(marketplaceOrderId, buyerWallet, usdcAmount, expiresAt)`.
3. User connects Privy embedded wallet and calls `userPlaceOrder` via the P2P Checkout widget.
4. User pays PIX off-chain; merchant network settles.
5. Diamond calls `onOrderComplete` → USDC transferred to `treasury` → `CheckoutFulfilled` emitted.
6. CubeSkins indexer verifies the event on-chain and sets `marketplace_orders.status = paid`.
7. Ops buys the skin on C5 and sends the Steam trade manually.

## Custody

- `usdcThroughIntegrator = true` at whitelist time.
- USDC exits the user proxy to the integrator, then `safeTransfer` to the immutable `treasury`.
- USDC never returns to the user EOA.

## Limits

Constructor defaults: **20 USDC / tx**, **5 orders / user / UTC day** (protocol starter caps).
Raise via P2P reputation / whitelist negotiation — CubeSkins ticket médio is ~R$2.500.

## Security

- Price and buyer wallet are set only by `registerOrder` (`onlyOwner`).
- `userPlaceOrder` reads `usdcAmount` from registration — not from calldata.
- `onOrderComplete` reverts on `AmountMismatch` if Diamond amount ≠ session amount.
- Backend marks paid only after confirming `CheckoutFulfilled` from the pinned integrator address.

## Operational notes

- Backend must call `cancelRegistration` when marketplace orders expire.
- Link Privy wallet to Steam user (EIP-191) before allowing P2P checkout.
- Request subgraph URL from P2P for widget circle routing (`subgraphUrl`).
