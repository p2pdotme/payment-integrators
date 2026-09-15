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
| `POST /api/links/:linkId/wallet` | Merchant-signed. Mints the link's wallet and returns the account address to batch into `registerAgent`. **A link cannot be paid until this has run.** |
| `POST /api/pay/:linkId` | The customer taps Pay. Returns `{ orderId, txHash, claimToken }`. |
| `POST /api/relay-tx` | Mark paid / cancel. Requires the claim token AND the customer's EIP-712 signature. |
| `POST /api/links` | Registers a webhook URL for ONE link the caller owns. Wins over the merchant default. |
| `POST /api/merchants/webhook` | One callback for every link a merchant owns. Merchant-signed, ERC-1271 aware. |
| `POST /api/admin/blocks` | Operator blocklist — list, look up, block, unblock. Authorised against the integrator's own roles, not a shared secret. |
| `POST /api/sponsor-check` | The sponsorship provider's server verifier. Holds the per-link operation ceiling. **Fails closed without `SPONSOR_VERIFIER_SECRET`.** |
| `GET /health` | Liveness. |


### Webhook events

Merchants register a callback and receive signed deliveries. Custom business
logic — account activation, notifications, a token transfer — hangs off these,
so which event fires and when is the contract.

| event | fires on | means |
|---|---|---|
| `payment.placed` | a customer started paying | **NOT money.** Show a pending state; do not ship. |
| `payment.completed` | the LP confirmed real fiat and USDC settled | Money moved. Safe to activate, notify, transfer. |
| `payment.cancelled` | the order was abandoned or expired | Release whatever `placed` had you hold. |

`placed` and `completed` are deliberately separate events rather than one with
a status field: acting on the first is how a merchant ships goods for a payment
that never arrives.

Every delivery carries `X-PayQR-Event` and an `X-PayQR-Signature` HMAC over the
raw body, is retried with backoff, and is deduped per order AND event.
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

## Nonces: why there is no longer a global sequencer

When one funded EOA relayed every payment, all of them drew on a single nonce
sequence. Two customers paying two **different** links in the same second both
read the same pending nonce, and the second transaction was silently dropped —
no error, a customer watching a spinner forever. Per-link locking could not fix
it, because the collision was across links.

The Router removed the cause rather than managing it. Each link has its own
ERC-4337 account with its own nonce sequence, so one slow payment cannot block
any other. `NonceManager` survives in `durable.ts` for the deprecated relayer
path only; nothing on the payment path instantiates it, and it goes when
`RELAYER_PRIVATE_KEY` does.

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
| A 0.05 ETH paymaster deposit | **~14,000 payments** |

Gas comes out of the **paymaster's deposit**, not a relayer float — no key of
ours holds a balance, so the deposit at the provider is the only thing to top
up.

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
| `LINK_KEY_MASTER` | 32 random bytes, base64. Wraps every per-link wallet key. |
| `WEBHOOK_SIGNING_KEY` | HMAC key for outbound webhook signatures |
| `SPONSOR_VERIFIER_SECRET` | shared with the sponsorship provider; `/api/sponsor-check` fails CLOSED without it |
| `TURNSTILE_SECRET` | the human-cost gate; `REQUIRE_TURNSTILE=true` turns its absence into a loud 503 |
| `RELAYER_PRIVATE_KEY` | **deprecated and optional.** Not on the payment path. |

`LINK_KEY_MASTER` is what replaced the funded relayer key, and the difference is
the point: it holds no money, so losing it costs availability rather than funds.

Secrets are per-environment. Repeat each one with `--env production` or mainnet
ships without it.

**Wiring** — must be set before the first payment:

| | |
|---|---|
| `CHAIN_ID`, `RPC_URL` | which chain |
| `INTEGRATOR_ADDRESS` | our contract |
| `DIAMOND_ADDRESS` | the only target `/api/relay-tx` will forward to |
| `LINK_ROUTER_ADDRESS` | the LinkRouter, which is the integrator's `trustedRelayer` |
| `CLIENT_ADDRESS`, `PRODUCT_ID` | the pinned price source |
| `ALLOWED_ORIGINS` | empty = open, correct for a public pay page |

**Account abstraction** — every link payment is a sponsored user operation, so
these are required too. Each is silent when wrong: nothing reverts, nothing
logs, the payment simply never lands.

| | |
|---|---|
| `ENTRYPOINT_ADDRESS` | the 4337 singleton, already on Base. Do not deploy your own. |
| `ACCOUNT_FACTORY_ADDRESS` | the factory link accounts are derived from |
| `ACCOUNT_FACTORY_KIND` | `thirdweb` or `simple`. **Different selectors** — the wrong value calls a function the factory does not have. This shipped wrong once. |
| `BUNDLER_URL` | replaces the funded key AND the nonce manager |
| `PAYMASTER_URL`, `PAYMASTER_POLICY_ID` | who pays the gas |
| `MAX_SPONSORED_OPS_PER_LINK` | per-link lifetime ceiling, enforced by `/api/sponsor-check` — not a provider dashboard setting |

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
wrangler secret put LINK_KEY_MASTER      # 32 random bytes, base64
wrangler secret put WEBHOOK_SIGNING_KEY
wrangler secret put SPONSOR_VERIFIER_SECRET
wrangler secret put TURNSTILE_SECRET

# set the wiring and account-abstraction vars in wrangler.toml — see
# Configuration above. Repeat every secret with --env production.
wrangler deploy                    # testnet
wrangler deploy --env production   # mainnet
```

**On-chain, once** — deploy the Router and point the integrator at it:

```bash
INTEGRATOR=0x… npx hardhat run scripts/deploy-link-router.ts --network base
```

That deploys `LinkRouter` and calls `setTrustedRelayer(router)`. There is ONE
such slot, it means the link path, and it has no second role — merchants
deliver their own fiat payouts. Put the address it prints into
`LINK_ROUTER_ADDRESS` and redeploy the Worker; without it no link payment can
be placed at all. `SKIP_WIRE=1` deploys without wiring, for when the deployer
is not the manager.

**No key needs funding.** A link payment is placed by that link's own ERC-4337
account, which holds nothing before, during or after, and the paymaster pays
the gas. What can run dry is the paymaster's deposit, not a relayer float —
watch it at the provider, and check `GET /health`.

To roll link payments back, call `setLinkOrdersEnabled(false)` (MANAGER). Do
**not** clear `trustedRelayer` to do it.

## Tests

```bash
npm run typecheck
npm test
```

Covers the allowlist shape, selector correctness against real signatures, link
payability, and that no raw revert string ever reaches a customer.
