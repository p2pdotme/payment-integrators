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

A wallet is funded only when a real human is established behind it:

- **A passport attestation**, verified here against the identical EIP-712
  message the contract checks — same `KycVerifier` domain, same typehash,
  `verifyingContract` pinned to the integrator, same low-`s` rejection, and a
  refusal of `limit: 0` (a wallet that could never buy). This is the cold-start
  path: the wallet has no gas, so it cannot have submitted on chain yet.

  The signer it verifies against is **the contract's own `attestor()`**, read
  from chain and cached five minutes — because that is the signer the funded
  submit will be held to. The configured value is only the fallback when the
  chain cannot be read, and any disagreement between the two is logged as
  `event=attestor_mismatch`: it means either the config or the deployment is
  wrong, and every operator believes the other one. A config-only attestor
  silently rejecting every cold start has bitten two prior integrations.

  An attestation whose nullifier is already spent on chain is refused too —
  one passport verifies exactly one wallet, ever, so funding a second cold
  start on the same identity pays for a submit that must revert.
- **`verified(wallet)` already true** on the integrator. Every later drip
  takes this path and needs no bearer credential at all.

`blocked(wallet)` is refused on both paths, and that read fails **closed** — an
RPC fault refuses the request rather than funding through it. It is the
operator's only revocation lever, so it does not get to be best-effort.

Then three ceilings, all per UTC day:

| cap | default | why |
|---|---|---|
| per wallet, count | 4 drips | bounds a loop |
| per wallet, value | 8×10¹⁴ wei | bounds one wallet |
| **per nullifier, value** | 1.6×10¹⁵ wei | a nullifier is per-(tenant, human), so one person spreading across many wallets shares one budget |
| global | 2×10¹⁷ wei | circuit breaker over the float (unscoped by chain — one process, one key, one float) |

A drip is **booked before it is sent**, not after. Every cap is a SUM or
COUNT over the ledger, so the row that feeds those caps is written before the
ETH moves — and if that write fails (a full disk, a volume remounted
read-only) the request refuses with `503 ledger_unavailable` having spent
nothing, rather than paying out while the caps silently read stale zeros. An
uncapped faucet is worse than an unavailable one. A send that then fails
releases the reservation; a send that succeeds links its tx to the row.

Sums meter **amount sent plus the transaction's actual fee** (booked from the
receipt), and the per-wallet/per-identity sums are scoped per chain. The
funder-balance check provisions a worst-case fee ceiling before agreeing to a
drip, so the float cannot be drained below what the ledger claims by fees
nobody counted.

The per-nullifier cap is defence in depth. The primary control is now on
chain: the faucet reads `nullifierSpent` and refuses an attestation whose
identity has already verified a wallet, because the contract makes a nullifier
globally single-use and one passport therefore verifies exactly one wallet
ever. Without that read the faucet paid for cold start after cold start on the
same identity, each into a `submitPassportAttestation` that reverts — money
out, user still stuck.

The nullifier is canonicalised before it is used as a ledger key (`bytes.fromhex`
ignores whitespace and case, so one identity had many spellings), and on the
`verified()` path — where the caller sends no attestation — it is recalled from
the ledger. Otherwise omitting one optional field bought a second, uncounted
wallet allowance.

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
event=integrator label=own chain=8453 address=0x… attestor=0x…
event=refused   reason=invalid_attestation wallet=0x60907330… integrator=own detail=…
event=declined  reason=sufficient_balance wallet=0x… balance_wei=… target_wei=…
event=funding   wallet=0x… amount_wei=30000000000000
event=funded    wallet=0x… tx=0x3fb6033e… fee_wei=… outcome=success
event=attestor_mismatch integrator=own configured=0x… onchain=0x…
event=low_balance funder_balance_wei=… drips_left=42
event=rate_limited scope=wallet wallet=0x…
```

Alert on `event=low_balance` (the float is running out; heal by sending ETH)
and on `event=attestor_mismatch` (cold starts are about to fail for whichever
side is wrong).
```

The service had none of this. It matters for one failure in particular: a
wrong `attestor` rejects **every** cold-start request, and from outside — with
a client that fails open by contract — that is indistinguishable from the
faucet being down. It has bitten two prior integrations. `event=refused
reason=invalid_attestation` is the line that tells them apart, and the startup
banner prints the resolved attestor to compare against the service's own
`GET /v1/attestor`.

Never logged: signatures, the private key, or a full nullifier. The nullifier
is a per-(tenant, human) pseudonym and is truncated — enough to correlate one
person's requests during an incident, not enough to be a bearer token if the
logs leak. Tests assert all three.

## API

```
GET  /healthz
GET  /v1/gas/status?chainId=&integrator=&wallet=
POST /v1/gas/request
```

```jsonc
// POST /v1/gas/request
{
  "chainId": 8453,
  "integrator": "0x…",
  "wallet": "0x…",
  // Only on the first request, before the wallet can afford to submit it.
  "attestation": { "nullifier": "0x…", "limit": 100000000,
                   "expiry": 1786614997, "signature": "0x…" }
}
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
FAUCET_INTEGRATORS='[{"chainId":8453,"address":"0x…","attestor":"0x…","label":"own"}]'
FAUCET_RPC_URLS='{"8453":"https://mainnet.base.org"}'
ALLOWED_ORIGINS=https://ownfinance.org
FAUCET_DB_PATH=/data/faucet.db    # must be a persistent volume
```

> `attestor` **must** be read from the verification service's own
> `GET /v1/attestor` — never a value relayed by a partner or a teammate. A
> wrong attestor here rejects every cold-start request, which looks exactly
> like the faucet being down. This has bitten two prior integrations.

Optional, all with working defaults: `FAUCET_GAS_UNITS`,
`FAUCET_SAFETY_FACTOR`, `FAUCET_MIN_TARGET_WEI`, `FAUCET_MAX_TARGET_WEI`,
`FAUCET_MAX_DRIPS_PER_WALLET`, `FAUCET_MAX_WEI_PER_WALLET`,
`FAUCET_MAX_WEI_PER_NULLIFIER`, `FAUCET_MAX_WEI_GLOBAL`.

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
