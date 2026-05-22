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
| TradeStars | <!-- TODO: backfill `0x64400FDa…` from p2p-checkout --> | <!-- TODO --> | <!-- TODO --> | Partner testing |

## How this table is maintained

Each row corresponds to a `registerIntegrator` call on the Diamond. Adding or removing a row requires both the on-chain action and a corresponding PR updating this file. CI does not enforce this — reviewers do.

When updating this file:

- Use the deployed address checksummed (mixed case).
- `Source commit` is the short SHA of the commit whose bytecode hash matches the deployed contract.
- `Status` is one of: `Production`, `Test`, `Deprecated`, `Deregistered`.

If you've added a row, link the whitelist request issue in the PR description so reviewers can match the on-chain action to the docs update.

## Widget compatibility surface

The [`@p2pdotme/checkout-widget`](https://github.com/p2pdotme/checkout-widget) reads a small slice of the integrator + Diamond surface to derive the order ID after `placeOrder` and to preview limits before submission. New integrators should follow these conventions if they want to plug in with zero widget-side changes.

### Events the widget decodes

The widget's `parseOrderIdFromReceipt` helper walks the transaction logs and stops at the first event it can decode in this order:

1. **`B2BOrderPlaced`** — emitted by the Diamond's `B2BGatewayFacet` on every `placeB2BOrder` / `placeB2BSellOrder`. Integrators do **not** emit this themselves; it comes from the protocol.

   ```solidity
   event B2BOrderPlaced(
       uint256 indexed orderId,
       address indexed integrator,
       address indexed user,
       uint256 amount
   );
   ```

2. **`CheckoutOrderCreated`** — the canonical V2 integrator-side event. Recommended shape for any new integrator that wants the widget to decode its order ID without falling back to the Diamond event:

   ```solidity
   event CheckoutOrderCreated(
       uint256 indexed orderId,
       address indexed user,
       address indexed client,
       uint256 productId,
       uint256 usdcAmount
   );
   ```

If your integrator emits a differently-shaped event (or no event at all), the widget will still work via the `B2BOrderPlaced` fallback — but a host using your integrator will not be able to read product-level metadata from a single `parseOrderIdFromReceipt` call.

> **Note on the current `ExampleIntegrator`:** its `CheckoutOrderCreated` currently has 6 fields (it adds `quantity` and renames `usdcAmount` → `totalUsdcAmount`), which means the topic hash differs from what the widget decodes — hosts using it fall through to the `B2BOrderPlaced` Diamond event. New integrators should prefer the 5-field shape above if widget compatibility matters. The `ExampleIntegrator` shape is preserved for backward compatibility with hosts that already index it.

> **Note on `LotPotCheckoutIntegrator`:** it emits `LotPotOrderCreated` rather than `CheckoutOrderCreated`. Hosts that need product-level metadata for LotPot should index `LotPotOrderCreated` directly; the widget itself relies on the `B2BOrderPlaced` fallback for the order ID.

### Optional view: `userTxLimit()`

The widget exports `fetchUserTxLimit(integratorAddress)` as a convenience for hosts that want to show a per-tx cap in the UI before the user submits. It calls a parameterless view:

```solidity
function userTxLimit() external view returns (uint256); // 6-dec USDC
```

This is **optional**. If your integrator does not expose it, the call reverts and the host falls back to its own copy of the limit (e.g. read from `baseTxLimit()` and adjusted client-side). Integrators in this repo currently expose:

- `baseTxLimit()` — parameterless, returns the unadjusted per-tx USDC cap (auto-generated public getter for the `baseTxLimit` storage variable).
- `getUserTxLimit(address user, bytes32 currency)` — RP- and currency-adjusted per-user cap (the authoritative one `validateOrder` uses internally).

If you want the one-call widget convenience without forcing hosts to know about RP, add a thin alias:

```solidity
function userTxLimit() external view returns (uint256) {
    return baseTxLimit;
}
```

or, if your integrator has a meaningful default currency / caller-derived limit, expose that.
