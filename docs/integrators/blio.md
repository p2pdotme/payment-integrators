# BlioCheckoutIntegrator

Consumer checkout for **blio.me Premium**. Users pay in **local fiat**
(Pago Móvil, PIX, SPEI, …) and the Diamond settles **USDC on Base** straight
into the blio treasury. Premium itself is granted **off-chain** by blio's
backend, which watches `BlioOrderCompleted`.

- **Source:** `contracts/integrators/blio/BlioCheckoutIntegrator.sol`
- **Registration:** `usdcThroughIntegrator = false`
- **Diamond:** `0x4cad6eC90e65baBec9335cAd728DDC610c316368` (Base mainnet) ·
  `0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9` (Base Sepolia)
- **USDC (Base):** `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`

## What product does this integrator serve?

A **digital subscription** ("Premium"). Products are `productId`s with a USDC
price set by the owner (`setProductPrice`, `setProductActive`). There is no
on-chain `ICheckoutClient`: entitlement is a blio database row credited from
the completion event. The integrator's on-chain job is only the protocol
lifecycle (validate → complete / cancel) plus emitting the event blio consumes.

## External protocols / dependencies

None beyond the P2P Diamond and USDC. No third-party client contract, no vault,
no bridges, no oracles.

## Order lifecycle (user POV)

1. User picks a currency (e.g. **VEN / Pago Móvil**) and calls
   `userPlaceOrder(productId, quantity, currency, circleId, pubKey, …)`.
2. The integrator deploys the user's `UserProxy` (CREATE2) and places the order
   through it. `recipientAddr` is pinned to the immutable **treasury**.
3. The user pays the merchant in local fiat off-chain.
4. On settlement the Diamond transfers USDC **directly to the treasury** and
   calls `onOrderComplete`, which emits `BlioOrderCompleted`.
5. blio's backend indexes `BlioOrderCompleted` and grants Premium.

There is **no on-chain receipt**. The on-chain order records intent
(`BlioOrderCreated`); the entitlement is the `BlioOrderCompleted` event.

## Custody flow

**None.** `recipientAddr = treasury` and `usdcThroughIntegrator = false`, so no
order USDC ever sits on the integrator or the `UserProxy`. `sweepUsdc` is a
recovery hatch for stray tokens only, not a withdrawal path. `onOrderComplete`
reads the Diamond's `usdcThroughIntegrator` flag (word 1 of
`getIntegratorConfig`) and emits `SettlementRoutingAnomaly` — and does **not**
fulfil — if a mis-registration ever routes settlement back to the integrator.

## Limits / RP behavior

Standard, no RP ladder:

- Per-tx cap: `baseTxLimit` (6-dec USDC), optionally tightened per currency via
  `maxTxLimit[currency]`.
- Daily count: `dailyTxCountLimit` placements per user per UTC day, released on
  cancellation (keyed on the placement-day snapshot).

## Operational notes

- **`owner`** controls products, limits, pause and `sweepUsdc`; **`treasury`**
  receives settlement. Both should be the **blio multisig**.
- Product prices are set per deployment/chain — remember to `setProductActive`
  after `setProductPrice`.
- **Off-chain fulfilment:** an indexer must map `BlioOrderCompleted(orderId,
user, productId, quantity, usdcAmount)` → Premium in blio's database.
- **Widget:** mount `@p2pdotme/widgets` `<Checkout>` with a `placeOrder`
  callback that encodes `userPlaceOrder`, and `usdcAmount` = `productPrice ×
quantity`. The widget decodes the order id from `BlioOrderCreated` (or falls
  back to the Diamond's `B2BOrderPlaced`).

## Deploy

```bash
TREASURY=0x... DEPLOY_OWNER=0x... BASE_TX_LIMIT=50000000 DAILY_TX_COUNT_LIMIT=10 \
  npx hardhat run scripts/deploy-blio.ts --network baseSepolia   # then --network base
```

The script asserts `usdcThroughIntegrator == false` after registration and
prints the verify command.
