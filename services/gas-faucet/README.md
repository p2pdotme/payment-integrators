# P2P gas faucet

Drips native gas to verified on-ramp buyers so they can afford the
transactions their own purchase requires.

Every P2P checkout integrator has the same hole. A user shows up to buy their
first stablecoin with fiat — so they hold no ETH — and then needs to send:

| call | gas (measured, Base Sepolia) | who must send it |
|---|---|---|
| `submitPassportAttestation` | 99,644 | the buyer, once per wallet |
| `buyUsdc` | 1,107,487 first / 987,781 after | the buyer |
| `paidBuyOrder` | ~150,000 | **the buyer — enforced on chain** |

At Base's prevailing 0.005 gwei that is about **1.5 cents for the whole
journey**. This was never a cost problem. It is a chicken-and-egg problem: the
on-ramp is the thing that would have given them the gas.

## Why a drip and not a relayer

`paidBuyOrder` is the constraint. `contracts-v4`'s `OrderFlowHelper` accepts it
only from `_order.user` or a protocol admin, and that call is the buyer's own
attestation that they moved fiat — sending it for them would fabricate a
payment claim. It has to come from their wallet, so their wallet needs gas.

The alternatives were weighed and rejected:

- **ERC-2771 meta-transactions** on the integrator would cover
  `submitPassportAttestation` and `buyUsdc`, but not `paidBuyOrder`. A new
  contract, a re-audit and a re-whitelist to only shrink the problem.
- **ERC-4337** would cover everything, but it moves the user to a smart
  account with a different address — and that address becomes `_order.user`,
  the address the attestation binds to, and the key for the integrator's
  per-wallet daily limits. Workable, but a migration.
- **EIP-7702** would also cover everything, and an earlier version of this
  section rejected it for "changing every user's address". **That was wrong**
  — it is true of 4337 and false of 7702, where the EOA keeps its address and
  inner calls still see the user as `msg.sender`. The real objections are
  narrower: wallet support for signing the authorization is uneven, and a
  delegated EOA carries a one-in-flight-transaction limit on Base. Recorded
  properly because somebody will re-evaluate this from this paragraph in six
  months, and the wrong reason would have sent them the wrong way.

## What stops it being a free ETH tap

A wallet is funded only when it is **verified on chain**:

- **`verified(wallet)` true on the integrator** is the one drip gate. There is
  no off-chain credential and no attestation in the drip request — the chain
  is the authority.
- **`blocked(wallet)`** is refused, and that read fails **closed**: an RPC
  fault refuses rather than funding through it. It is the operator's only
  revocation lever, so it does not get to be best-effort.

Verification itself is landed by this service — `POST /v1/attestation` — which
is what dissolved the cold start rather than funding around it. Since the
contract's `submitPassportAttestation` takes the wallet as a parameter, anyone
may submit, so the service pays the gas to land it. It does **not** verify the
attestation: it simulates the exact call first (an invalid signature, a spent
nullifier, an expired attestation all revert in the free `eth_call` and are
refused for the price of a rate slot), then broadcasts. The chain is the only
verifier, so the class of bug where an off-chain EIP-712 copy drifts from the
contract — wrong attestor, wrong canonicalisation — cannot exist. There is no
attestor config anywhere.

Then the caps, all per UTC day:

| cap | default | why |
|---|---|---|
| per wallet, count | 4 drips | bounds a loop |
| per wallet, value | 8×10¹⁴ wei | bounds one wallet |
| **per nullifier, value** | 1.6×10¹⁵ wei | a nullifier is per-(tenant, human); a sponsored submit records it, and drips are booked against it |
| global | 2×10¹⁷ wei | circuit breaker over the float (unscoped by chain — one process, one key, one float), enforced on the drip AND sponsor paths. **Set `FAUCET_MAX_WEI_GLOBAL` to the float actually loaded** — the default is far above any realistic float, so left alone the breaker cannot trip before the wallet runs dry, and the service warns at startup when it is unset |

A drip is **booked before it is sent**, not after. Every cap is a SUM or COUNT
over the ledger, so the row that feeds those caps is written before the ETH
moves — and if that write fails (a full disk, a volume remounted read-only)
the request refuses with `503 ledger_unavailable` having spent nothing, rather
than paying out while the caps silently read stale zeros. An uncapped faucet
is worse than an unavailable one. A send that then fails releases the
reservation; a send that succeeds links its tx to the row.

Sums meter **amount sent plus the transaction's actual fee** (booked from the
receipt), scoped per chain for the per-wallet/per-identity sums. The nullifier
is stored canonically (`bytes.fromhex` ignores whitespace and case, so one
identity would otherwise hold several spellings) and recalled on the drip path
so the per-identity budget binds.

### What the caps do and do not bound

Worst case for a determined attacker who really did pass a passport check is
their own per-identity cap, which is cents.

That is one attacker out of three. These caps are enforced by the same process
that holds the key, using a SQLite file beside it. **Against a leaked key or
code execution in this container they are irrelevant and the whole float goes.**
That is the reason the float is small and the dependency list is pinned, not
the caps.

## Sizing

The drip target is **derived from the live base fee**, not configured as a
fixed number of wei:

```
target = base_fee × FAUCET_GAS_UNITS × FAUCET_SAFETY_FACTOR
         clamped to [FAUCET_MIN_TARGET_WEI, FAUCET_MAX_TARGET_WEI]
floor  = target / 2          # top up below this, leave alone above
```

A fixed constant is wrong within a week — too small after any fee rise, which
strands users mid-order, and needlessly generous the rest of the time. The
ceiling is the real protection: it is what stops a gas spike turning each drip
into actual money.

At Base's usual fee this lands at 1.5×10¹³ wei (~$0.03, about two full
journeys). Two, not four: the first drip must cover the whole first journey
plus retry headroom, but the client re-asks the faucet before every subsequent
order, so a smaller drip just means more automatic top-ups — invisible to the
user, and half the price on every cap and the float.

## Not in the funds path

The faucet sends native gas to the user's own address and nothing else. It
holds no USDC, has no relationship to settlement, and cannot influence where an
order pays out. Its key is a hot key holding a small float — keep it small and
refill it, rather than funding it once and forgetting.

**Callers must fail open.** If the faucet is down, verification and purchase
still work for anyone already holding gas. A client that blocks its ramp on a
faucet error has made a convenience into a dependency.

## Sponsoring verification — POST /v1/attestation

The service lands `submitPassportAttestation(wallet, …)` on-chain itself,
paying the gas. It does **not** verify the attestation: the contract does,
first in a free simulation (an invalid submission is refused for the price of
a rate-limit slot, costing this service nothing) and then for real. This is
what deleted the entire off-chain verifier — the EIP-712 re-implementation,
the attestor config, the reconciliation machinery — and with it the
misconfiguration class where the faucet and the contract disagreed about the
signer.

The key therefore now signs ONE kind of contract call. That widens what it
used to be able to do (bare transfers only), and the widening is bounded at a
single choke point: `send_call` refuses any calldata that is not a
`submitPassportAttestation`, targets only allowlisted integrators, carries no
value, and clamps gas. Worst case for a leaked key is unchanged — the float,
plus submitting valid attestations the contract accepts from anyone anyway.

## Observability

One structured line per decision, on stdout, which is where Railway collects
it. `event=` is always first, so `grep event=refused` and
`grep reason=invalid_attestation` both work.

```
event=startup   funder=0x… integrators=1 chains=8453 db=/data/faucet.db docs=off
event=integrator label=own chain=8453 address=0x…
event=refused   reason=invalid_signature wallet=0x60907330… integrator=own detail=…
event=declined  reason=sufficient_balance wallet=0x… balance_wei=… target_wei=…
event=funding   wallet=0x… amount_wei=30000000000000
event=funded    wallet=0x… tx=0x3fb6033e… fee_wei=… outcome=success
event=low_balance funder_balance_wei=… drips_left=42
event=rate_limited scope=wallet wallet=0x…
event=fee_clamped drip_id=… reported_fee_wei=… ceiling_wei=…
```

Alert on `event=low_balance` (the float is running out; heal by sending ETH)
and on a run of `event=chain_unreachable` (the RPC is down; every request
fails until it recovers).

The service had none of this. It matters because the client fails open by
contract: a refused sponsorship, a dead RPC and an empty float all look, from
outside, like nothing happening. `event=refused reason=<the chain's verdict>`
is the line that tells a rejected attestation apart from an outage, and
`event=chain_unreachable` names the outage — with the RPC URL scrubbed, since
a keyed provider URL is a credential.

Never logged: signatures, the private key, or a full nullifier. The nullifier
is a per-(tenant, human) pseudonym and is truncated — enough to correlate one
person's requests during an incident, not enough to be a bearer token if the
logs leak. Tests assert all three.

## API

```
GET  /healthz                                   liveness word only
GET  /v1/gas/status?chainId=&integrator=&wallet=
POST /v1/gas/request
POST /v1/attestation                            sponsor a verification
GET  /v1/ops/health                             operators; X-Ops-Token or Authorization: Bearer
```

Every error body is a fixed word (`chain_unreachable`, `send_failed`,
`not_verified`, …) — never the node's message. `/v1/gas/status` answers
`temporarily_unavailable` where the funding path would say `faucet_empty` or
`global_daily_budget_reached`: it needs no verified wallet, so it does not get
to be a gauge of the float.

```jsonc
// POST /v1/gas/request
{
  "chainId": 8453,
  "integrator": "0x…",
  "wallet": "0x…"
}
// Verification is a SEPARATE endpoint — POST /v1/attestation with
// {chainId, integrator, wallet, nullifier, limit, expiry, signature} — which
// the service submits on-chain for the wallet. The drip request carries no
// attestation; its only gate is verified(wallet).
```

```jsonc
{ "funded": true, "reason": "funded", "balanceWei": "0",
  "targetWei": "30000000000000", "amountWei": "30000000000000",
  "txHash": "0x…", "pending": false }
```

`funded: false` is a normal answer, not an error — read `reason`
(`sufficient_balance`, `wallet_daily_count_reached`,
`identity_daily_budget_reached`, `global_daily_budget_reached`,
`faucet_empty`). `403` means the caller could not establish a human.

## Configuration

```bash
FAUCET_PRIVATE_KEY=0x…            # hot key, small float
FAUCET_INTEGRATORS='[{"chainId":8453,"address":"0x…","label":"own"}]'
FAUCET_RPC_URLS='{"8453":"https://base-mainnet.g.alchemy.com/v2/<key>"}'   # keyed; the URL is a secret
ALLOWED_ORIGINS=https://ownfinance.org
FAUCET_DB_PATH=/data/faucet.db    # must be a persistent volume
FAUCET_MAX_WEI_GLOBAL=…           # size to the float actually loaded
FAUCET_OPS_TOKEN=…                # /v1/ops/health; sent as a HEADER, never a query string
```

> There is no `attestor` setting. The chain verifies every attestation — in
> simulation before any gas is spent, and for real after — so there is no
> signer for this service to hold or to get wrong. An `attestor` key in an old
> config is ignored.

`FAUCET_TRUSTED_PROXIES` (default `1`, Railway's edge) is how many proxies
append to `X-Forwarded-For` in front of this process; the per-IP limiter keys
on the hop that many from the right, never the leftmost, which is the
caller's own claim. Set `0` when nothing proxies the service.

Optional, all with working defaults: `FAUCET_GAS_UNITS`,
`FAUCET_SAFETY_FACTOR`, `FAUCET_MIN_TARGET_WEI`, `FAUCET_MAX_TARGET_WEI`,
`FAUCET_MAX_DRIPS_PER_WALLET`, `FAUCET_MAX_WEI_PER_WALLET`,
`FAUCET_MAX_WEI_PER_NULLIFIER`, `FAUCET_RATE_IP_PER_MIN`,
`FAUCET_RATE_WALLET_PER_MIN`, `FAUCET_TRUSTED_PROXIES`.

**`FAUCET_DB_PATH` must be on a persistent volume.** The ledger is what every
daily cap is computed from; a faucet that forgets what it paid out is a faucet
whose caps reset on every deploy.

## Running

```bash
pip install -r requirements.txt
uvicorn faucet:app --port 8788
pytest test_faucet.py
```

Deploy like `simple-kyc/kyc-proxy` — same Dockerfile shape, same `$PORT`
convention. **One worker.** The service holds a single key and one nonce
sequence; a second process would race it.

## Verified

Live on Base Sepolia, 2026-08-13, against the deployed `OwnCheckoutIntegrator`
`0x6e2Feec8434de08732D7ed5A0cDDd748dEFbB032`:

- a brand-new wallet at 0 wei was funded 3×10¹³ wei — landed in
  [`0x3fb6033e…`](https://sepolia.basescan.org/tx/0x3fb6033e8078be42f6360c9e3cee367311cca1860dca2a7f9f1bcc8b28f083d4)
- asking again immediately returned `sufficient_balance`, no second payment
- an attestation signed by anyone other than the attestor: `403`
- an unverified wallet with no attestation: `403`
