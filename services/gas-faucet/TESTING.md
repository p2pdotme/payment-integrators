# Testing the gas sponsorship

## What can and cannot be tested where

| | Base Sepolia | Base mainnet |
|---|---|---|
| Gas faucet (the cold start) | ✅ fully | ✅ |
| Gasless bridge (`usePermit`) | ❌ impossible | ✅ |
| Robinhood gas top-up | ❌ impossible | ✅ |

**Bridging cannot be tested on testnet, and it is not a configuration
problem.** Relay's testnet API (`api.testnets.relay.link`) carries exactly two
chains — Base Sepolia and Sepolia — and Base Sepolia lists only `LRDS` and
`OMI`. There is no testnet USDC to send and no Robinhood testnet (46630) to
send it to. `RAMP_BRIDGE_AVAILABLE` is already `false` there by design, so the
bridge card correctly says so rather than offering a dead link.

Bridging and the gas top-up are therefore **mainnet-only tests**, and they are
cheap: bridging $5 with a $0.25 top-up costs about $0.33 all-in.

## Before anything: the attestor

The Sepolia integrator's on-chain attestor is
**`0xA0bE015133e4dc63c96EBFB6729D34050Ef33Eda`**, which matches
`GET https://passport-api.p2p.cool/v1/attestor` exactly. It is no longer the
deployer placeholder the older docs described.

Two consequences:

- `FAUCET_INTEGRATORS` must carry **that** attestor. Configure the deployer and
  every cold-start request fails `invalid_attestation`, which looks exactly
  like the faucet being broken.
- `scripts/local/e2e-own-sepolia.ts` can no longer mint its own attestations —
  it refuses loudly, which is correct. Sepolia end-to-end now runs through the
  real passport flow in own-app.

Re-check both before testing; they are the single most common way this fails:

```bash
curl -s https://passport-api.p2p.cool/v1/attestor
cast call 0x6e2Feec8434de08732D7ed5A0cDDd748dEFbB032 "attestor()(address)" \
  --rpc-url https://sepolia.base.org
```

## Path A — everything local (fastest, no deploy)

Tests the faucet, the attestation drip, and the buy — everything except
bridging.

```bash
# 1. faucet
cd payment-integrators/services/gas-faucet
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
FAUCET_PRIVATE_KEY=0x<funded key> \
FAUCET_INTEGRATORS='[{"chainId":84532,"address":"0x6e2Feec8434de08732D7ed5A0cDDd748dEFbB032","attestor":"0xA0bE015133e4dc63c96EBFB6729D34050Ef33Eda","label":"own-sepolia"}]' \
FAUCET_RPC_URLS='{"84532":"https://sepolia.base.org"}' \
ALLOWED_ORIGINS=http://localhost:3000 \
FAUCET_DB_PATH=./faucet.db \
.venv/bin/uvicorn faucet:app --port 8788

# 2. own-app, in .env.local
NEXT_PUBLIC_P2P_CHAIN=baseSepolia
NEXT_PUBLIC_P2P_GAS_FAUCET=http://localhost:8788

# 3. npm run dev
```

Then connect **a wallet with zero Base Sepolia ETH** — a fresh MetaMask account
is easiest — and run the passport flow. The drip fires just before
`submitPassportAttestation`.

Watch it happen:

```bash
curl "http://localhost:8788/v1/gas/status?chainId=84532\
&integrator=0x6e2Feec8434de08732D7ed5A0cDDd748dEFbB032&wallet=0x<your wallet>"
```

`wouldFund: true` before, `false` after.

## Path B — the deployed preview

The preview is running code from before any of this, and `NEXT_PUBLIC_*` is
**inlined at build time**, so the order matters:

1. Push the own-app branch → preview rebuilds with the new code.
2. Deploy the faucet (below) and note its public URL.
3. Set `NEXT_PUBLIC_P2P_GAS_FAUCET` in the preview environment.
4. **Redeploy again.** Setting the variable does nothing to an already-built
   bundle — this catches people out every time.
5. Set the faucet's `ALLOWED_ORIGIN_REGEX` to match the preview hostname.
   Preview URLs change per deployment, so an exact-match `ALLOWED_ORIGINS`
   list will not hold:

   ```
   ALLOWED_ORIGIN_REGEX=^https://own-app-[a-z0-9-]+\.vercel\.app$
   ```

If the drip silently does nothing on the preview, check the browser console for
a CORS rejection first — that is the usual cause, and the client swallows it by
design so the ramp keeps working.

## Funding the faucet

Each funded wallet costs one drip target plus a 21,000-gas transfer. On Base at
its usual 0.005 gwei that is **~0.00003 ETH (3×10¹³ wei) per wallet**.

| float | wallets it funds | ≈ USD (ETH $1,886) |
|---|---|---|
| 0.005 ETH | ~165 | $9 |
| 0.02 ETH | ~660 | $38 |
| 0.05 ETH | ~1,660 | $94 |

**Base Sepolia:** any Base Sepolia faucet (Coinbase Developer Platform, Alchemy)
gives 0.05–0.1 ETH/day — one grant covers well over a thousand test drips.

**Base mainnet:** send from any wallet. Start small; it is a hot key on a public
endpoint, not a treasury.

> Set `FAUCET_MAX_WEI_GLOBAL` to match the float you actually loaded. The
> default is 2×10¹⁷ wei (0.2 ETH/day), which is far more than a small float —
> so the circuit breaker would never trip before the wallet simply ran dry. For
> a 0.02 ETH float, `FAUCET_MAX_WEI_GLOBAL=10000000000000000` (0.01 ETH/day,
> ~330 wallets) leaves a day of headroom either way.

Watch the balance:

```bash
curl -s https://<faucet>/healthz | jq '{funder, funderBalanceWei, spentTodayWei}'
```

## Deploying to Railway

```bash
cd payment-integrators/services/gas-faucet
railway init --name p2p-gas-faucet
railway up

# key: generate it straight into Railway so it never lands in a shell history
railway variables --set "FAUCET_PRIVATE_KEY=$(python3 -c \
  "from eth_account import Account; print(Account.create().key.hex())")"

railway variables \
  --set 'FAUCET_INTEGRATORS=[{"chainId":84532,"address":"0x6e2Feec8434de08732D7ed5A0cDDd748dEFbB032","attestor":"0xA0bE015133e4dc63c96EBFB6729D34050Ef33Eda","label":"own-sepolia"}]' \
  --set 'FAUCET_RPC_URLS={"84532":"https://sepolia.base.org"}' \
  --set 'FAUCET_DB_PATH=/data/faucet.db' \
  --set 'ALLOWED_ORIGIN_REGEX=^https://own-app-[a-z0-9-]+\.vercel\.app$'

railway domain            # public URL
curl -s https://<url>/healthz | jq .funder    # ← fund this address
```

Two things that will bite otherwise:

- **Attach a volume mounted at `/data`.** Every daily cap is a sum over that
  SQLite file; on Railway's ephemeral filesystem it resets on each deploy and
  the caps reset with it.
- **One replica.** The service holds a single key and one nonce sequence, so a
  second instance races it. `Dockerfile` already pins `--workers 1`; keep the
  replica count at 1 too.

## Live deployment (Base Sepolia)

| | |
|---|---|
| URL | `https://gas-faucet-production.up.railway.app` |
| Railway project | `p2p-gas-faucet` / service `gas-faucet` |
| Funder | [`0x679472FBDD46f2cC3a5580540877c38372604ccb`](https://sepolia.basescan.org/address/0x679472FBDD46f2cC3a5580540877c38372604ccb) — 0.02 ETH, ~660 drips |
| Integrator | `0x6e2Feec8…`, attestor `0xA0bE0151…` (the live passport service) |
| Global cap | 0.01 ETH/day, sized to half the float |
| Volume | mounted at `/data`, ledger at `/data/faucet.db` |

The funder is a **dedicated throwaway key**, not the deployer and not the
super-admin mnemonic. That mnemonic is the integrator's immutable `owner`
(`pause`, `setBlocked`, `setRegionCap`, `sweepUsdc`); it must never sit in the
environment of a public HTTP service. Top the faucet up by *sending* it ETH.

> `PORT` is pinned to `8788` so the container, the Dockerfile's `EXPOSE`, and
> the Railway domain's target port all agree. Railway otherwise injects its own
> `PORT` (8080 in practice) and the generated domain 502s.

> The RPC is the public `sepolia.base.org`, which rate-limits and rejects some
> user agents. Fine for testing; point `FAUCET_RPC_URLS` at a dedicated
> endpoint before this carries real traffic.

## Verified

Base Sepolia, 2026-08-13, against `0x6e2Feec8…`:

- virgin wallet 0 wei → funded 3×10¹³ wei, tx
  [`0x3fb6033e…`](https://sepolia.basescan.org/tx/0x3fb6033e8078be42f6360c9e3cee367311cca1860dca2a7f9f1bcc8b28f083d4)
- immediate repeat request → `sufficient_balance`, no second payment
- attestation signed by anyone but the attestor → `403`
- unverified wallet, no attestation → `403`
- preview-style origin passes CORS, a foreign origin is refused `400`
