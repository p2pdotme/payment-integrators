# stocks.me integrator

Buy **tokenized US equities on Solana** with local fiat. The user pays INR, BRL or another supported currency on the P2P network; the Diamond settles USDC on the integrator; the integrator burns it via Circle's [CCTP V2](https://www.circle.com/cross-chain-transfer-protocol) to a fixed treasury account on Solana. An off-chain worker then swaps that USDC into the chosen [xStock](https://xstocks.fi) and delivers it to the buyer's own Solana wallet.

The user signs **one gasless Base transaction** and nothing on Solana, ever.

## What it does, and how it differs from Showdown

The onramp leg is the same shape as [`ShowdownCheckoutIntegrator`](./showdown.md), which pioneered fiat → USDC-on-Solana on this protocol, and this contract is derived from it. The difference is what the user ends up holding:

| | Showdown | stocks.me |
| --- | --- | --- |
| Final asset | native USDC on Solana | a tokenized equity (AAPLx, TSLAx, NVDAx, SPYx) |
| CCTP `mintRecipient` | the **user's** USDC token account | a **fixed treasury** token account |
| Who completes delivery | nobody — the mint *is* delivery | an off-chain worker, via a DEX swap |
| Offramp | yes, two-way | no, one-way only |

That second row is the substantive design decision, and it is worth stating plainly.

### Why the mint recipient is a treasury account, not the buyer's

CCTP reverts on the Solana side if the `mintRecipient` token account does not exist when `receiveMessage` is called. A burn naming a non-existent account is **permanently unmintable** — the USDC is gone from Base and can never appear on Solana. Showdown carries `userRescueStuckBridge` with a 7-day delay for exactly this hazard.

Our recipient is an immutable treasury token account created once at setup, so it always exists and that failure mode is structurally unreachable. The buyer's own account is never a CCTP parameter; their Solana **wallet** address rides in the `StockDeliveryRequested` event as a delivery instruction, and the worker derives and creates their Token-2022 account when it delivers.

This also means the contract never needs to know anything about the equity. It moves USDC. Which stock, at what price, with what slippage guard, is entirely off-chain — so a new listing needs no redeploy, only `setStockEnabled`.

> **The buyer is trusting the operator for the final leg.** Between the CCTP mint and the swap, the USDC sits in an operator-controlled treasury. The contract cannot enforce delivery of the equity; it can only prove the USDC arrived. That is an honest limitation of ramping into a third-party asset rather than into USDC itself, and it is why the `ref` field exists — it binds each on-chain order to exactly one off-chain delivery record so the two ledgers can be reconciled by anyone reading the event log.

## Limits

| Constant | Value | Meaning |
| --- | --- | --- |
| `MAX_TX_LIMIT` | `50e6` | $50 ceiling on a single order |
| `MAX_DAILY_TX_COUNT` | `10` | orders per user per UTC day |
| `MAX_BRIDGE_FEE_BPS` | `10` | ceiling on the CCTP attestation fee |
| `RESCUE_DELAY` | `7 days` | before a buyer may reclaim a stuck order on Base |

`setTxLimit`, `setDailyTxCountLimit` and `setBridgeMaxFeeBps` revert with `AboveCeiling` past these, and so does the constructor. **The owner can tighten policy but never loosen it past what the bytecode commits to**, so the limits hold against a compromised owner key, not just a compromised operator. That matters because a whitelisted integrator bypasses the protocol's own volume limits and is trusted to enforce its own in `validateOrder`.

The shipped deployment launches tighter than the ceilings: $50/tx and 5/day.

There is deliberately **no KYC tier system**. Showdown needs one because it hands the user fungible USDC they can move anywhere; this integrator delivers a specific equity token to a specific pinned wallet. The `$50` per-transaction ceiling is the control, and it is immutable rather than attested.

### Daily counts are placements, not settlements

`validateOrder` debits the day's counter at placement. `onOrderCancel` releases it, keyed on `placementDay` so a cancel that crosses midnight cannot refund a slot from a day nothing reads any more. A double-cancel is tolerated and cannot underflow the counter — `IP2PIntegrator` asks for that tolerance explicitly, and the cross-integrator conformance suite checks for it.

The cancel-then-complete path re-charges the **current** day rather than `placementDay`, keeping over-counting as the safe direction.

## Stocks are a whitelist, not free-form

`stockEnabled[uint16]` gates which equities may be bought. `userBuyStock` reverts with `StockNotEnabled` for anything else, so a typo in a frontend cannot place an order for an asset the operator has no liquidity plan for.

The ids are **pinned forever** — they are emitted on-chain and an off-chain worker resolves them to mints. Renumbering would silently redirect deliveries.

## Solana recipients: two different things, do not confuse them

This contract holds two Solana addresses and they are not interchangeable.

- `treasuryUsdcAta` — the CCTP `mintRecipient`. An **associated token account**, immutable, must already exist. A wallet address here produces an unmintable burn.
- `Session.solanaWallet` — the buyer's **wallet** (the owner, not a token account), pinned at placement and emitted for the worker. The worker derives their Token-2022 account from it.

xStocks are SPL **Token-2022**, not classic SPL Token, so the buyer's equity account derives under a different program than their USDC account. That is an off-chain concern, but it is the most likely place for an integration to go wrong: deriving with the classic program id yields a valid-looking address that nobody owns.

## Bridge failure is fail-closed, not fund-loss

The burn runs through an external self-call under `try/catch`. The gateway also try/catches `onOrderComplete`, so a revert here would silently strand the delivered USDC with no session record — sweepable by the owner as surplus. Failing closed instead leaves the order `fulfilled` but `bridged == false`, with the amount reserved in `unbridgedTotal` and two recovery paths:

- `retryBridge(orderId)` — **permissionless**. Anyone may push a stuck order forward along its pinned path.
- `userRescueStuckBridge(orderId)` — after `RESCUE_DELAY`, the buyer and only the buyer may pull their USDC back on Base.

`withdrawUsdc` can only ever move the surplus above `unbridgedTotal`, so the owner sweep cannot touch funds reserved for an unbridged order. The invariant `bridgeReserveToken.balanceOf(this) >= unbridgedTotal` is what makes those three functions safe against each other, and `onOrderComplete` clamps the reserved amount to what is actually unreserved rather than trusting the reported figure — over-reserving would let one buyer's burn spend another's funds out of the pooled balance.

`StockDeliveryRequested` is emitted **before** the burn is attempted, so the worker is driven even when the bridge leg fails closed. Delivery is gated on the CCTP mint landing, never on that event alone.

## Bridge configuration: Fast Transfer, and quoting net

The constructor ships **Fast Transfer** — `bridgeMinFinalityThreshold = FINALITY_FAST (1000)` with `bridgeMaxFeeBps = 2`.

Fast needs **both** values set. Raising only the fee leaves every burn on Standard, and raising only the threshold makes the burn unsatisfiable; shipping them together removes a footgun that has no error message. `setBridgeMinFinalityThreshold` accepts only the two values CCTP defines and reverts with `InvalidFinalityThreshold` otherwise.

> **The mint is `amount − fee`, not `amount`.** Circle deducts its attestation fee from the burned amount. Measured on this deployment: a 2 USDC burn from Base Sepolia delivered **1.99974 USDC**, a fee of 260 micro-USDC — **1.3 bps**, matching Circle's published Fast rate. So unlike Showdown's shipped Standard default, this is not a distinction without a difference: **the frontend must quote the net amount, not the order amount.**

`_maxFeeFor` clamps the fee below `amount` so a misconfigured bps can never make the burn unsatisfiable, and returns 0 for a zero amount rather than underflowing — reachable because the delivery clamp can legitimately pin a session to 0.

## Token model, and the Base Sepolia caveat

CCTP burns only Circle-issued USDC. The Base Sepolia Diamond settles in a mock token (`GoofyGoober`, `0x4095fE…`) whose `burnLimitsPerMessage == 0`, so Circle's TokenMinter refuses it. A naive testnet deployment therefore gives a live order flow whose bridge leg always fails closed — honest, but it means testnet never exercises CCTP at all, which is the one leg that most needs exercising.

So this contract separates the **settlement** token from the **burn** token:

- `usdc` — what the Diamond settles in.
- `bridgeReserveToken` — what CCTP burns.

When they differ, `receiptMode` is `true`: settlement arrives as the mock token and is treated as a receipt, while an equal amount is burned from a pre-funded reserve of **real Circle testnet USDC** (`0x036CbD…`, from [faucet.circle.com](https://faucet.circle.com)) held by the integrator. The real CCTP path then runs end to end on testnet.

`receiptMode` is **derived, not configurable** — `bridgeReserveToken != usdc` — and the deploy script refuses a mainnet deployment where they differ. On mainnet the Diamond settles in canonical USDC, the two are the same address, and receipt mode is off and unreachable.

> Receipt mode means the integrator must be **pre-funded** with the burn token. Without a reserve, a settled order completes and fails closed into `BridgeFailed`. This is a funding step, not a configuration step, and it is easy to forget.

## Registration

Register with **`usdcThroughIntegrator = false`**. The onramp pins `recipientAddr = address(this)` inside `placeB2BOrder`, so completion already routes the purchased USDC here without the flag — the same arrangement as Showdown. `onOrderComplete` asserts `recipientAddr == address(this)` and reverts otherwise: a mismatch means the USDC is *not* here, so recording it would reserve funds that never arrived.

## Reference

### Base Sepolia deployment (live)

| | |
| --- | --- |
| Integrator | [`0xd2507c02B01dbd00eA778CA91Bb4aAeC7200fd27`](https://sepolia.basescan.org/address/0xd2507c02B01dbd00eA778CA91Bb4aAeC7200fd27) |
| `proxyImpl` | `0x85452590794e3Be0Ed6D2C5Ddf52e990D6F5b489` |
| Diamond | `0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9` |
| Settlement token | `0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d` (mock) |
| Burn token | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (Circle testnet USDC) |
| TokenMessengerV2 | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| `receiptMode` | `true` |
| Limits | $50/tx, 5/day |

Note the TokenMessenger address **differs between Base mainnet (`0x28b5a0e9…`) and Base Sepolia (`0x8FE6B999…`)**. Circle's docs page lists the testnet set; the deploy script carries both as per-chain presets.

### Measured end-to-end result

Base Sepolia → Solana devnet, burning the reserve token:

| Step | Result |
| --- | --- |
| `depositForBurn` (2 USDC, Fast) | success |
| Circle attestation | complete in **12.7 s** |
| `receive_message` on Solana | success, 866-byte transaction |
| Treasury received | **1.99974 USDC** (fee 260, = 1.3 bps) |

> `receive_message` does **not fit in a legacy transaction.** A CCTP V2 message is ~377 bytes and the instruction touches 18 unique accounts, giving ~1264 bytes against the 1232-byte limit. Dropping the compute-budget instruction saves about 9 bytes, so there is no way to squeeze under — the account keys must go into an Address Lookup Table, which brings the same transaction to 866 bytes. The 15 tabled accounts are fixed per (cluster, mint, source domain), so one table serves every delivery.

### Owner powers, complete list

`setStockEnabled`, `setTxLimit`, `setDailyTxCountLimit`, `setBridgeMaxFeeBps`, `setBridgeMinFinalityThreshold`, `withdrawUsdc` (surplus only). All bounded by the immutable ceilings above. There is no pause, no upgrade path, and no way for the owner to redirect a placed order — `solanaWallet`, `stockId` and `ref` are pinned at placement and the CCTP recipient is immutable in the bytecode.

### Disclosures the frontend must carry

xStocks are issuer-backed tokens tracking a share price, **not** share ownership: no voting rights, no direct dividend entitlement. The mints carry a `permanentDelegate` and a `freezeAuthority`, so the issuer can freeze an account or claw tokens back, and a `pausableConfig` that can halt transfers. They are geo-restricted and not available to US persons, and issuer redemption is gated to KYC'd qualified investors. On-chain trading is 24/7 but issuance and redemption are 24/5, so off-hours prices are derived and spreads are wider.
