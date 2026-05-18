# ExampleIntegrator

Reference integrator. **Not deployed to mainnet.** Lives here as the canonical starting point for new integrator authors.

## What it shows

The minimum a "standard" integrator needs to do:

- Register business clients + their products.
- Validate orders against per-tx + daily-count limits.
- Place B2B orders on the Diamond via a per-user `UserProxy`.
- Receive `onOrderComplete` and route USDC into the client's `onCheckoutPayment`.
- Receive `onOrderCancel` and release the daily-count debit.

There's nothing exotic: no async fulfillment, no credit redemption, no upstream protocol with its own pricing.

## When to fork this

If your integrator:

- Routes USDC to a business client contract that delivers a product (NFT mint, balance credit, etc.)
- Uses the standard per-tx + daily-count limit shape
- Doesn't require user-supplied parameters beyond `(client, productId, quantity)`

then fork `ExampleIntegrator` directly. Rename the file, change the contract name, update tests, ship.

## When not to fork this

If your integrator:

- Routes through a third-party protocol with its own pricing (like LotPot through Megapot)
- Needs async fulfillment (Diamond's BUY → upstream's batch order → eventual mint)
- Needs a custom limit shape (KYC-tier-based, not RP-based)
- Needs to support a SELL / offramp flow

then look at `LotPotCheckoutIntegrator` or open a "New integrator proposal" issue to discuss the right starting point.

## Reference business client

`contracts/examples/SimpleERC721Client.sol` is a worked `ICheckoutClient` that mints ERC-721 tokens when `onCheckoutPayment` fires. The Example integrator's test wires the two together end to end.
