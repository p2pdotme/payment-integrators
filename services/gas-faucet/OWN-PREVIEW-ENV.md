# Env for Own's preview deployment

Base Sepolia. Hand this to whoever owns the preview environment.

## The only new variable

```bash
NEXT_PUBLIC_P2P_GAS_FAUCET=https://gas-faucet-production.up.railway.app
```

That is the whole change. Everything else below is the existing ramp config,
listed so it can be checked rather than re-entered.

> **`NEXT_PUBLIC_*` is inlined at build time.** Setting this on an existing
> deployment does nothing — the value has to be present when the bundle is
> built. After adding it, **trigger a fresh deploy**. This is the single most
> common reason the drip appears to do nothing.

## Full Base Sepolia ramp block

```bash
# ── which chain the fiat leg settles on ──────────────────────────────────
NEXT_PUBLIC_P2P_CHAIN=baseSepolia
# Optional. Unset uses Base Sepolia's public endpoint, which rate-limits.
NEXT_PUBLIC_P2P_RPC_URL=

# ── passport verification ────────────────────────────────────────────────
# Defaults are already correct; listed so they can be confirmed.
NEXT_PUBLIC_P2P_KYC_API=https://passport-proxy.p2p.cool
NEXT_PUBLIC_P2P_KYC_PUBLIC_API=https://passport-api.p2p.cool
NEXT_PUBLIC_P2P_TENANT=own-passport

# ── gas sponsorship (NEW) ────────────────────────────────────────────────
# Lets a buyer with zero Base ETH pay for submitPassportAttestation, buyUsdc
# and paidBuyOrder. Unset = no faucet; the ramp still works for anyone who
# already holds gas, so this is never required for the app to function.
NEXT_PUBLIC_P2P_GAS_FAUCET=https://gas-faucet-production.up.railway.app

# ── order routing ────────────────────────────────────────────────────────
# Must be a circle with live merchants. Circle 1 is what the Sepolia E2E used.
NEXT_PUBLIC_P2P_CIRCLE_INR=1

# ── optional ─────────────────────────────────────────────────────────────
NEXT_PUBLIC_P2P_ORDER_TTL_S=300          # measured; leave alone
NEXT_PUBLIC_P2P_FIAT_TOLERANCE_BPS=200   # 2% rate-drift headroom
NEXT_PUBLIC_P2P_SUBGRAPH_URL=            # unset = no pending-order banner
NEXT_PUBLIC_P2P_SUPPORT_BRIDGE=          # unset = no support launcher
```

## What to expect on the preview

Connect a wallet holding **zero Base Sepolia ETH** — a fresh account is
easiest, since the whole point is the cold start.

1. Run the passport flow. Just before the wallet prompt for
   `submitPassportAttestation`, the app calls the faucet with the attestation
   it just received. ~0.00003 ETH arrives; the wallet prompt then succeeds
   instead of failing on insufficient funds.
2. Before each buy it asks again, without the attestation — by then
   `verified()` is true on chain and that is proof enough.

Watch a wallet's status directly:

```bash
curl "https://gas-faucet-production.up.railway.app/v1/gas/status\
?chainId=84532&integrator=0x6e2Feec8434de08732D7ed5A0cDDd748dEFbB032\
&wallet=0x<wallet>"
```

Faucet health and remaining budget:

```bash
curl -s https://gas-faucet-production.up.railway.app/healthz
```

## If the drip seems to do nothing

In order of likelihood:

1. **The build predates the variable.** Redeploy. See the note above.
2. **CORS.** The browser console will show it. Currently allowed:
   `localhost:3000`, `ownfinance.org`, and any `*.vercel.app` host. If the
   preview lives somewhere else, that origin needs adding.
3. **The wallet already has gas** — then nothing *should* happen. `/v1/gas/status`
   returns `wouldFund: false` with `reason: sufficient_balance`.
4. **Daily cap hit.** 4 drips per wallet per UTC day. `/v1/gas/status` shows
   `dripsToday`.
5. **Faucet dry.** `/healthz` → `funderBalanceWei`. Top up by sending ETH to
   `0x679472FBDD46f2cC3a5580540877c38372604ccb`.

The client fails open by design: if the faucet is unreachable the ramp carries
on and the wallet's own error surfaces. So a silent no-op is expected
behaviour, not a crash — check `/v1/gas/status` rather than waiting for an
error in the UI.

## What cannot be tested on this preview

**Bridging, and the Robinhood gas top-up.** Relay carries no testnet USDC on
Base Sepolia and no Robinhood testnet at all, so there is no route to quote.
The bridge card correctly says bridging isn't available from this network.
Both are mainnet-only tests — about $0.33 all-in for a $5 bridge with a $0.25
gas top-up.
