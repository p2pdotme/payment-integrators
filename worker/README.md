# Payment links relayer

Places orders on a merchant's behalf when a walletless customer pays a link.

The merchant is asleep, the customer has no wallet, and someone has to sign a
transaction. This Worker holds a wallet that can call exactly three functions on
our integrator — `relayerPlaceOrder` — and is never a registered merchant, so
it has no path to anyone's funds.

**The service is convenience; the contract is truth.** Every check here also
exists on-chain. Doing it here saves a doomed transaction's gas and lets us
return a message a customer can act on.

## Endpoints

| | |
|---|---|
| `POST /api/pay/:linkId` | The customer taps Pay. Returns `{ orderId, txHash }`. |
| `POST /api/relay-tx` | Forwards the two transactions the widget signs itself. |
| `POST /api/links` | Registers a webhook URL for a link the caller owns. |
| `GET /health` | Relayer address, gas balance, low-balance flag. |

### The pay path

```
1  rate limit          KV, before any RPC
2  lock this link      a double-tap cannot fire twice
3  READ LINK FROM CHAIN    ← nothing financial comes from the request body
4  fail fast           active? unexpired? amount payable?
5  simulate            a revert here costs nothing
6  gas ceilings        per-tx limit + daily cap, reserved before sending
7  allocate nonce      one global sequencer
8  send, await receipt decode orderId from the log
```

Step 3 is the security boundary. If a browser sends `{ amount: 1 }` hoping to
pay ₹1 for a ₹3,000 order, we never read that field. And if this Worker were
fully compromised, the contract still rejects a mismatched amount with
`LinkAmountMismatch`.

## Why a global nonce sequencer

The relayer is one EOA, so every payment draws from one nonce sequence. Two
customers paying two **different** links in the same second would otherwise
both read the same pending nonce, and the second transaction would be silently
dropped — no error, a customer watching a spinner forever.

Per-link locking cannot fix this; the collision is across links. `NonceManager`
is a single Durable Object instance for the whole Worker, so allocation is
serialized by construction.

## The relay-tx allowlist

`<Checkout>` does not route everything through `placeOrder`. Some actions it
signs itself. Verified against the shipped **@p2pdotme/widgets 1.7.1** bundle,
which makes exactly three such calls:

| Call | Target | |
|---|---|---|
| `cancelOrder(uint256)` | Diamond | ✅ forwarded |
| `paidBuyOrder(uint256)` | Diamond | ✅ forwarded |
| `submitLivenessAttestation(...)` | **integrator** | ❌ never forwarded |

The third only fires when the host passes a `liveness` config prop. The pay
page does not pass one, so it is unreachable — and it stays off the allowlist
regardless, because it targets our own integrator.

Four independent checks, any one of which blocks the dangerous cases:

1. `to` must be exactly the Diamond — our integrator is unreachable.
2. The selector must be one of the two above.
3. Calldata must be exactly 36 bytes — selector plus one `uint256`.
4. The decoded `orderId` must already be recorded on our contract.

**Re-run the probe on every widget upgrade.** A minor version can add a fourth
call, and the failure mode is a payment that hangs after the customer's money
has already moved.

## Webhooks

`payment.completed`, HMAC-SHA256 signed in `X-PayQR-Signature`. Retries at
1m / 5m / 30m / 2h / 12h, then dead-letters to `hook:dead:<orderId>` for manual
replay.

A webhook fires **only after this Worker confirms the completion on-chain**.
A browser saying "I paid" is not evidence.

Webhook URLs are stored in plaintext KV rather than the link's encrypted
config: the merchant's relay key lives in per-device localStorage and is
cleared on logout, so a config encrypted on their phone is unreadable on their
laptop. A webhook URL is an endpoint, not a secret — the HMAC is what
authenticates delivery.

## What KV holds

Only non-financial, mutable data: webhook registrations, rate-limit counters,
the log cursor, and delivery/dead-letter records. Amount, currency, status, and
owner live **only** on-chain, because the customer's anonymous browser must be
able to verify them with no merchant signature available, and because
revocation must be race-free.

## Operating cost

Measured from the contract's own gas report:

| | |
|---|---|
| `relayerPlaceOrder` | ~348k gas avg, ~398k max |
| At 0.01 gwei on Base | **~$0.01 per payment** |
| A 0.05 ETH float | **~14,000 payments** |

Those figures assume Base's usual gas price. The ceilings below are denominated
in **wei**, not gas units, precisely so that assumption is not load-bearing: a
price spike buys fewer payments out of the same budget instead of quietly
draining more value than intended.

One cost this does NOT capture: on Base the L1 data fee is often the larger
half of a transaction's real cost, and `gasPrice * gas` does not include it. The
wei budget therefore under-counts what actually leaves the float. Treat the
daily ceiling as a floor on protection rather than an exact spend cap.

The daily gas cap (`LIMITS.maxGasWeiPerDay`) bounds a spam campaign to roughly
1,600 payments' worth of spend per UTC day at Base's usual gas price. Balance warnings fire at 0.015 ETH —
while there is still time to act, not once the float is gone.

## Configuration

Everything an operator might need to change at 3am is a var, not a constant.
A rate limit, a gas ceiling, a receipt timeout — none of them require a code
change and a redeploy to turn down.

**Secrets** — `wrangler secret put`, never in `wrangler.toml`:

| | |
|---|---|
| `RELAYER_PRIVATE_KEY` | the relayer EOA's key |
| `WEBHOOK_SIGNING_KEY` | HMAC key for outbound webhook signatures |

**Wiring** — must be set before the first payment:

| | |
|---|---|
| `CHAIN_ID`, `RPC_URL` | which chain |
| `INTEGRATOR_ADDRESS` | our contract |
| `DIAMOND_ADDRESS` | the only target `/api/relay-tx` will forward to |
| `CLIENT_ADDRESS`, `PRODUCT_ID` | the pinned price source |
| `ALLOWED_ORIGINS` | empty = open, correct for a public pay page |

**Operational limits** — all optional; unset, the defaults in
`src/config.ts` apply. Those defaults are sized from the contract's own
measured gas report rather than guessed.

| | default | |
|---|---|---|
| `RATE_IP_PER_MINUTE` | 10 | first line against spam, before any RPC |
| `RATE_LINK_PER_HOUR` | 20 | a link is a public endpoint |
| `MAX_GAS_PER_TX` | 600,000 | anomaly detector — measured max is ~398k |
| `MAX_GAS_WEI_PER_DAY` | 0.01 ETH | ~1,600 payments at 0.01 gwei |
| `GAS_BUFFER_PCT` | 120 | head-room over the estimate |
| `LOW_BALANCE_WEI` | 0.015 ETH | ~4,300 payments of runway left |
| `RECEIPT_TIMEOUT_MS` | 45,000 | raise on a slow RPC |
| `LOG_SCAN_BLOCKS` | 800 | per scheduled run |
| `WEBHOOK_BATCH` | 50 | deliveries per run |
| `LINK_LOCK_SECONDS` | 60 | how long a link is held mid-payment |

A malformed value **falls back to its default** rather than throwing or
resolving to zero. A fat-fingered var must never be the reason a spend cap
stops applying.

`wrangler.toml` carries a `[env.production]` block for mainnet, where gas is
real money and the daily cap starts tighter.

## Setup

```bash
npm install

wrangler kv namespace create KV          # put the id in wrangler.toml
wrangler secret put RELAYER_PRIVATE_KEY
wrangler secret put WEBHOOK_SIGNING_KEY

# set INTEGRATOR_ADDRESS / DIAMOND_ADDRESS / CLIENT_ADDRESS in wrangler.toml
wrangler deploy                    # testnet
wrangler deploy --env production   # mainnet
```

On-chain, once: `setLinkRelayer(<relaying key>, true)` for each key in the pool
— these are SEPARATE from `setTrustedRelayer`, which now carries only the fiat
keeper duty — then fund each address
with a small ETH float. Confirm with `GET /health`.

If the relayer runs dry, link payments fail visibly with no risk to funds — it
never holds or touches merchant USDC.

## Tests

```bash
npm run typecheck
npm test
```

Covers the allowlist shape, selector correctness against real signatures, link
payability, and that no raw revert string ever reaches a customer.
