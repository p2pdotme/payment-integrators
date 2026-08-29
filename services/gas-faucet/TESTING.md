# Testing the gas sponsorship

> The Sepolia integrator below is the **sponsored-attestation** deployment
> (5-param submit, PR #91). Pointing this service at a 4-param contract makes
> every sponsorship fail as a generic revert — if every submission returns
> simulation_reverted, check the integrator address before anything else.

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

## Before anything: the integrator must accept a sponsored submit

The service no longer carries an attestor address and no longer verifies
attestations off chain. The chain does both, so there is nothing here to keep
reconciled with a deployment. What replaced that as the single most common way
this fails is the function signature.

`POST /v1/attestation` encodes
`submitPassportAttestation(address,bytes32,uint256,uint256,bytes)`. An
integrator deployed before the sponsored-attestation change declares the
four-argument form without the leading `wallet`, which is a different selector.
Every submit then reverts in simulation and returns `400 simulation_reverted`,
which reads exactly like a bad signature.

Check the deployed integrator carries the five-argument selector before
testing anything else:

```bash
cast sig "submitPassportAttestation(address,bytes32,uint256,uint256,bytes)"
cast code <integrator> --rpc-url https://sepolia.base.org | grep -o ed740260
```

No output from the second command means the contract predates the change and
no cold start can succeed. Redeploy the integrator first, then point
`FAUCET_INTEGRATORS` at the new address.

## Path A — everything local (fastest, no deploy)

Tests the faucet, the attestation drip, and the buy — everything except
bridging.

```bash
# 1. faucet
cd payment-integrators/services/gas-faucet
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
FAUCET_PRIVATE_KEY=0x<funded key> \
FAUCET_INTEGRATORS='[{"chainId":84532,"address":"0x17DbCD059d0Ed2056aB1acD4DB4F29e61B78985d","label":"own-sepolia"}]' \
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
&integrator=0x17DbCD059d0Ed2056aB1acD4DB4F29e61B78985d&wallet=0x<your wallet>"
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

Watch the balance (the token goes in a header — a query string would land in
every access log between you and the service):

```bash
curl -s -H "X-Ops-Token: $FAUCET_OPS_TOKEN" https://<faucet>/v1/ops/health \
  | jq '{funder, funderBalanceWei, spentTodayWei, globalCapWei}'
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
  --set 'FAUCET_INTEGRATORS=[{"chainId":84532,"address":"0x17DbCD059d0Ed2056aB1acD4DB4F29e61B78985d","label":"own-sepolia"}]' \
  --set 'FAUCET_RPC_URLS={"84532":"https://sepolia.base.org"}' \
  --set 'FAUCET_DB_PATH=/data/faucet.db' \
  --set 'ALLOWED_ORIGIN_REGEX=^https://own-app-[a-z0-9-]+\.vercel\.app$'

railway domain            # public URL
curl -s -H "X-Ops-Token: <token>" https://<url>/v1/ops/health | jq .funder   # ← fund this address
```

Two things that will bite otherwise:

- **Attach a volume mounted at `/data`.** Every daily cap is a sum over that
  SQLite file; on Railway's ephemeral filesystem it resets on each deploy and
  the caps reset with it.
- **One replica.** The service holds a single key and one nonce sequence, so a
  second instance races it. `Dockerfile` already pins `--workers 1`; keep the
  replica count at 1 too.

## Live deployment

Deployment specifics — URL, funder address, float — are **not recorded here.**
This repository is public, and a page pairing a live endpoint with the hot
wallet that funds it and its current balance is a map nobody needs drawn for
them. The addresses are on chain regardless; assembling them into one page is
the part that was avoidable.

Ask the P2P side for the current deployment details, or read them from the
Railway project.

Two settings the service now enforces rather than documenting, because both
used to be correct only if an operator read a runbook:

- **`FAUCET_DB_PATH` must be absolute.** Every daily cap is a SUM over that
  file; on a container a relative path is ephemeral, so the caps reset on every
  deploy and nothing surfaces it. The service refuses to start otherwise.
  `FAUCET_ALLOW_EPHEMERAL_DB=1` overrides it for local runs and CI.
- **`/healthz` returns a status word only.** The funder address, its balance,
  the spend so far and the global cap moved to `/v1/ops/health`, which is
  absent unless `FAUCET_OPS_TOKEN` is set and matched. A default-open
  operational endpoint on a key-holding service is a live budget gauge for
  anyone who finds it.

## Verified

Base Sepolia, 2026-08-13, against `0x6e2Feec8…`:

- virgin wallet 0 wei → funded 3×10¹³ wei, tx
  [`0x3fb6033e…`](https://sepolia.basescan.org/tx/0x3fb6033e8078be42f6360c9e3cee367311cca1860dca2a7f9f1bcc8b28f083d4)
- immediate repeat request → `sufficient_balance`, no second payment
- unverified wallet → `403`
- preview-style origin passes CORS, a foreign origin is refused `400`
