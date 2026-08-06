# Own Finance — fiat → USDC onramp (passport + liveness)

`contracts/integrators/own/OwnCheckoutIntegrator.sol`

Own Finance ([ownfinance.org](https://ownfinance.org)) gives users tokenized
real-world asset exposure on **Robinhood Chain (4663)**, where the payment token
is **USDG**. This integrator is the fiat on-ramp that feeds it: a user pays fiat
through the P2P merchant network and receives USDC **directly in their own Base
wallet**, then bridges it to USDG themselves.

---

## 1. Where the money goes

```
   fiat (INR / other)
        │
        ▼   P2P merchant network  ──  this integrator gates the order
   ┌─────────────────┐
   │ Base            │   Diamond settles  →  the BUYER'S OWN WALLET
   │ USDC            │   (recipientAddr = msg.sender, usdcThroughIntegrator=false)
   └─────────────────┘
        │
        ▼   Relay (relay.link) — user signs from their own wallet
   ┌─────────────────┐
   │ Robinhood 4663  │   USDG  →  the SAME wallet
   │ USDG            │
   └─────────────────┘
```

**The integrator is never in the funds path.** Every order pins `recipientAddr`
to `msg.sender`, and the integrator is registered `usdcThroughIntegrator = false`,
so the Diamond pays the buyer directly. Neither this contract nor the buyer's
`UserProxy` ever holds the proceeds — which is why there is no rescue, retry, or
refund machinery in here, and no owner key that can move a user's money.

### Why the bridge is not on-chain here

Bridging from inside the contract would require taking custody of every buyer's
proceeds, pooling them, and re-deriving each user's share — reintroducing the
whole class of stranded-funds failures (`unbridgedTotal`, `retryBridge`,
`userRescueStuckBridge`) that direct settlement avoids entirely.

So leg 2 runs from the user's own wallet, through **Relay** — the same router
Own's perps-margin bridge already uses. Verified live (Aug 2026):

| | |
|---|---|
| Route | Base `8453` USDC `0x8335…2913` → Robinhood `4663` USDG `0x5fc5…d168` |
| Both legs | `supportsBridging: true` on Relay's `/chains` feed |
| Live quote | 100 USDC in → **99.947424 USDG** out, ETA ~2s, impact −0.07% |
| Steps | `approve`, `deposit` — two wallet confirmations |
| Recipient | a parameter — set to the user's own address |

> Relay does **not** list Base Sepolia (84532) or Robinhood testnet (46630), so
> the bridge leg cannot run on testnet. This is expected, and it is why the
> Sepolia E2E asserts only the settlement leg.

---

## 2. The gate: passport + liveness, one tier

A wallet transacts only after presenting a **passport + liveness** attestation
signed by the simple-kyc service. There is no lower tier — no liveness-only
path, no unverified path.

"Passport + liveness" is **one tier from one service**, not two integrations
stitched together: simple-kyc's own pipeline runs the document check, an active
liveness challenge, a 1:1 face match against the passport portrait, and a 1:N
dedup, then signs a single `KycVerifier` attestation covering all of it. There
is a *separate* liveness-only service signing `LivenessVerifier` for the $20
tier — this contract has nothing to do with it, and conflating the two is the
single most common integration failure here (see §6).

| tier | India (INR) | Abroad |
|---|---|---|
| passport + liveness | **$100** / tx | **$200** / tx |

plus **5 orders per wallet per day**. Maximum exposure per wallet per day is
therefore $500 (India) / $1,000 (abroad).

The effective cap is `min(attested limit, regionCap[region])`: the service signs
a dollar limit into the attestation, and the contract clamps it to an on-chain
per-region ceiling. **A compromised attestor key cannot authorize more than the
region allows.**

### Region is settlement geography, not nationality

`region` is derived from the order's fiat currency — which rail the money lands
on. `INR` settles in India and takes the India column; every other currency
takes the Abroad column. It is not a claim about who the buyer is. A nationality
gate, if one is ever wanted, belongs in the attestation.

### Immutable ceilings

Every number above is **also** a `MAX_*` constant compiled into the bytecode:

```solidity
MAX_REGION_CAP_INDIA     = 100e6;   // $100
MAX_REGION_CAP_ABROAD    = 200e6;   // $200
MAX_DAILY_TX_COUNT_LIMIT = 5;
```

`setRegionCap` and `setDailyTxCountLimit` check against these, so the owner can
only ever make the contract **more** restrictive. The policy holds against a
compromised **owner** key, not merely a compromised attestor — which matters
because a whitelisted integrator that can raise its own caps is a risk to the
protocol, not just to Own.

### Attestation binding

EIP-712, domain `KycVerifier` / version `1`, **`verifyingContract = address(this)`**.
That last binding is what stops an attestation minted for one integrator being
replayed against another. The nullifier is per-(tenant, human) and single-use,
which is the Sybil gate.

Grants are monotonic and do not lapse: `expiry` is a claim-freshness deadline,
not an ongoing clock. Revocation is `setBlocked`.

---

## 3. Owner powers (the complete list)

| Power | Bounded by |
|---|---|
| `setAttestor` | — (rotate the service signer; existing grants stand) |
| `setRegionCap` | `MAX_REGION_CAP_*` — lower only |
| `setDailyTxCountLimit` | `MAX_DAILY_TX_COUNT_LIMIT` — lower only, never 0 |
| `setBlocked` | — (denylist a wallet) |
| `pause` / `unpause` | — (stops new placements) |
| `sweepUsdc` | see below |

`owner` is **immutable** — set at construction, never transferable. Use a
multisig.

**`sweepUsdc` does not touch user funds.** By construction this contract's USDC
balance is always zero, because settlement goes straight to the buyer. A
non-zero balance means a stray transfer or a mis-registration, and in both cases
the funds are otherwise stuck. `SettlementRoutingAnomaly` fires on the first
mis-routed completion, so the condition is visible before any balance
accumulates.

---

## 4. Deployment

```bash
DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x... ATTESTOR=0x... \
  npx hardhat run scripts/deploy-own.ts --network base
```

Add `DRY_RUN=1` to run every preflight check and print the resolved config
without deploying. Base mainnet Diamond/USDC are presets; Base Sepolia needs
both passed explicitly.

**`ATTESTOR` must be read from the service's own `GET /v1/attestor`** — never a
value relayed by a partner or a teammate. A wrong attestor bricks the tier
silently: every `submitPassportAttestation` reverts `InvalidSignature`, and it
only surfaces when a real user first tries to verify. This has now bitten three
integrations, **including this one** — the Sepolia deployment sat on the deployer
placeholder until §5's rotation. On mainnet the script refuses to run without it;
on Base Sepolia it falls back to the deployer so the E2E can mint test
attestations, and says so loudly. Treat that fallback as a debt to settle before
anyone but the E2E script touches the deployment, and verify with a live
`attestor()` read rather than by trusting the deploy log.

The script registers with `usdcThroughIntegrator = false` and **asserts the flag
afterwards**. A `true` here would route every buyer's settlement to the
integrator, which has no forwarding path — the funds would strand.

---

## 5. Base Sepolia deployment (live)

| | |
|---|---|
| Integrator | [`0x6e2Feec8434de08732D7ed5A0cDDd748dEFbB032`](https://sepolia.basescan.org/address/0x6e2Feec8434de08732D7ed5A0cDDd748dEFbB032) |
| `proxyImpl` | `0xF7dC3a639bc7d7500a4D1B93D7877DbbA008A6D3` |
| Diamond | `0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9` |
| Settlement token | `0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d` (GG mock, 6dp) |
| Owner | `0x9DE9772AfCdf3AFa03CC689fE7AFA5b631088aB9` (deployer; immutable) |
| Attestor | `0xA0bE015133e4dc63c96EBFB6729D34050Ef33Eda` ✅ the live service's signer |
| Registered | `isActive=true`, `usdcThroughIntegrator=false` ✅ |
| Caps | $100 India / $200 Abroad / 5 per day — all at their ceilings |
| Tenant | `own-passport` on the passport service — `limit_usdc` 200 |

The attestor was deployed as the deployer placeholder and **rotated 2026-08-06**
to the passport service's signer in
[`0xf5a790a6…`](https://sepolia.basescan.org/tx/0xf5a790a67e1916e233a02c5a05dad7d059729976928130b26a1de9ece91269fa)
(block 45131429). Until that landed every `submitPassportAttestation` would have
reverted `InvalidSignature` — the silent failure §4 warns about, which this
deployment duly walked into.

Digest interop is **proven**, not assumed: the contract's `domainSeparator()`
equals `hashDomain({name:"KycVerifier", version:"1", chainId:84532,
verifyingContract:<integrator>})` computed independently off-chain. Re-run that
comparison after any redeploy — it is a free `eth_call` and it is the check that
would have caught both prior integrations' mismatches.

`limit_usdc` is **200**, not the 100 an earlier draft of §7 specified. The
contract takes `min(attested, regionCap[region])`, so a tenant attesting 100
would silently cap the abroad rail at $100 rather than the $200 the table in §2
promises. India still clamps to $100 on-chain, which is the intended shape:
**let the contract's immutable ceilings be the binding constraint, not the
service's attested figure.**

### End-to-end result

`npx hardhat run scripts/local/e2e-own-sepolia.ts --network baseSepolia`

Order **587**, 2026-08-03:

```
[poll] 08:39:40 → PLACED
[poll] 08:39:48 → ACCEPTED     (merchant 0xa8e665Ac…)
       marking fiat paid…
[poll] 08:39:51 → PAID
[poll] 08:39:58 → COMPLETED

user      : 5.875 → 7.875  (+2.0)
integrator: 0.0
proxy     : 0.0
session.settled: true
```

The buyer received the full amount in their own wallet; the integrator and the
user's proxy both held nothing. That assertion is the point of the test.

### Order TTL — measured

A buy order is payable for **~5 minutes from PLACEMENT**, not from merchant
acceptance. Measured 2026-08-04 with `scripts/local/measure-order-ttl.ts`, which
probes `paidBuyOrder` via free `eth_call`:

```
t+283s  ACCEPTED  paidBuyOrder → OK
t+310s  ACCEPTED  paidBuyOrder → EXPIRED
```

Past that, `paidBuyOrder` reverts `OrderExpired()` (`0xc56873ba`). Two
consequences:

- **Scripts** must place and pay in one tight loop — even re-reading the order
  record (which lags on this RPC) can burn the window. Orders **585** and **586**
  were lost this way and are still holding merchant capacity; clear them with
  demo-merchant-bot `cancel-hanging-orders`.
- **Real users** get ~5 minutes to open their banking app, pay, and confirm.
  That is tight but workable, so no protocol change is needed — but a client
  MUST show the deadline and MUST NOT send `paidBuyOrder` on the user's behalf.
  That call is the buyer's attestation that the money moved; sending it
  automatically to beat the clock fabricates a payment claim.

---

## 6. Frontend integration

Own's app wires this up in `own-protocol/app` (`src/lib/kycClient.ts`):

1. `POST {passport-proxy}/v1/widget/public-sessions` → open `widget_url` (popup).
2. On return, `POST {passport-proxy}/v1/widget/attestation {code}` →
   `{nullifier, limit, expiry, signature}`.
3. User's wallet calls `submitPassportAttestation(nullifier, limit, expiry, signature)`.
4. Gate the UI on `effectiveLimit(user, currency) >= amount` and
   `getRemainingDailyCount(user) > 0`, then `buyUsdc(...)`.
5. On settlement, offer the Relay bridge leg (Base USDC → Robinhood USDG).

Useful views: `effectiveLimits(user)` returns both region caps in one call;
`domainSeparator()` lets the service and the frontend assert they are signing
for this exact deployment.

### Passport is not liveness — three places integrations get this wrong

The passport and liveness services are separate deployments with near-identical
APIs. That resemblance is a trap: **every** one of these failures surfaces only
*after* the user has completed a full passport scan. All three hit
`own-protocol/app#66`, which was written from a liveness integration.

| | |
|---|---|
| **Host** | The passport service is `passport-proxy.p2p.cool` (widget endpoints) / `passport-api.p2p.cool` (`/v1/attestor`). `liveness-api.p2p.cool` signs `LivenessVerifier`; this contract verifies `KycVerifier`, so pointing there reverts every submit with `InvalidSignature`. |
| **postMessage** | The passport wizard posts `verify:complete` / `verify:error` — **not** `liveness:complete`. A host waiting on the wrong name never resolves; the popup only settles when the user gives up. |
| **`country`** | The passport session endpoint **requires** ISO 3166-1 alpha-2 and 422s without it, before it even consults the redirect_uri allowlist. The liveness endpoint has no such field. |

Two further details, both learned the hard way:

- The wizard's `handBackError` sends **`state: null`** while `handBackSuccess`
  passes the real state. Gate the *code* on a state match — it is a bearer token
  — but **not** the error, or every failure is silently swallowed.
- The service covers eight markets (`IN NG BR MX CO AR VE ID`) against p2p.me's
  ten fiat rails. **ECU and PEN have no country policy**, so a ramp offering
  them must block verification for those rails rather than guess a code. The
  `country` may be derived from the selected rail: the service reads it as the
  user's market and never checks it against the document — the passport's
  issuing country comes from the MRZ the wizard itself reads.

The attestor preflight is worth wiring: read `attestor()` on-chain, compare to
`GET /v1/attestor`, and refuse to start if they differ. Note that the
key-holding proxy exposes only the two widget endpoints, so that lookup goes to
`passport-api.p2p.cool` directly.

---

## 7. Launch dependencies

- [x] ~~**Passport attestation backend.**~~ **Corrected 2026-08-06 — this was
      never a blocker.** An earlier draft of this doc claimed the passport
      backend did not exist and named it *the* launch blocker. It does exist:
      `simple-kyc` is that service, it signs the `KycVerifier` domain this
      contract verifies, and it has been doing so for other integrators. What
      was actually missing was a **tenant**, which is a minutes-long
      registration, not a service to build. The confusion came from
      `liveness-api.p2p.cool` being the only p2p.cool host most integrations had
      seen. Showdown's blocker was the same mistake.
- [x] Rotate `attestor` off the deployer placeholder (`setAttestor`) — done on
      Base Sepolia 2026-08-06, see §5. **Still required on any new deployment**:
      the deploy script falls back to the deployer on testnet by design.
- [x] Create the Own tenant on the service (`own-passport`, `limit_usdc: 200` —
      see §5 for why 200 and not 100), and add the app's origins to the proxy's
      `ALLOWED_ORIGINS` **and** the tenant's own `redirect_uris` / `web_origins`.
      Both allowlists are checked, and `redirect_uris` match on host **and
      path**, exactly — register the trailing-slash form too.
      Note: the attested limit is **per-identity**, not per-tenant — raising a
      tenant's `limit_usdc` does nothing for already-enrolled users, so get it
      right before onboarding anyone real.
- [ ] Deploy on Base mainnet from an Own multisig (`owner` is immutable),
      verify on Basescan, and open a whitelist request (`docs/WHITELISTING.md`).
- [ ] Create the **mainnet** tenant bound to that deployment. The EIP-712 domain
      carries `chainId` + `verifyingContract`, so a Sepolia attestation cannot be
      replayed against the mainnet contract — a separate tenant is mandatory, not
      housekeeping.
- [ ] Confirm the mainnet `circleId` for each fiat currency Own will offer.
