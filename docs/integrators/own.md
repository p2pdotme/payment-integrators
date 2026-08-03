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
only surfaces when a real user first tries to verify. This has bitten two prior
integrations. On mainnet the script refuses to run without it; on Base Sepolia
it falls back to the deployer so the E2E can mint test attestations, and says so
loudly.

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
| Owner / attestor | `0x9DE9772AfCdf3AFa03CC689fE7AFA5b631088aB9` ⚠️ deployer placeholder |
| Registered | `isActive=true`, `usdcThroughIntegrator=false` ✅ |
| Caps | $100 India / $200 Abroad / 5 per day — all at their ceilings |

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

> **Short order TTL.** Orders on this deployment expire quickly, measured from
> *placement*, not acceptance. Any delay between placing and calling
> `paidBuyOrder` — even re-reading the order record, which lags on this RPC —
> burns the window and reverts `OrderExpired()` (`0xc56873ba`). The E2E script
> therefore places and pays in one tight loop. Orders **585** and **586** were
> lost to this before the loop was tightened and are still holding merchant
> capacity; clear them with demo-merchant-bot `cancel-hanging-orders`.

---

## 6. Frontend integration

Own's app wires this up in `own-protocol/app`:

1. `POST {liveness-api}/v1/widget/public-sessions` → open `widget_url` (popup).
2. On return, `POST {liveness-api}/v1/widget/attestation {code}` →
   `{nullifier, limit, expiry, signature}`.
3. User's wallet calls `submitPassportAttestation(nullifier, limit, expiry, signature)`.
4. Gate the UI on `effectiveLimit(user, currency) >= amount` and
   `getRemainingDailyCount(user) > 0`, then `buyUsdc(...)`.
5. On settlement, offer the Relay bridge leg (Base USDC → Robinhood USDG).

Useful views: `effectiveLimits(user)` returns both region caps in one call;
`domainSeparator()` lets the service and the frontend assert they are signing
for this exact deployment.

---

## 7. Launch dependencies

- [ ] **Passport attestation backend.** The live service at
      `liveness-api.p2p.cool` signs the `LivenessVerifier` domain (liveness
      only). This contract verifies `KycVerifier` — the passport+liveness
      domain, which is what justifies $100/$200 rather than $20/$50. That
      backend must exist and expose `/v1/attestor` before mainnet. **This is the
      launch blocker**, and it is the same one Showdown is waiting on.
- [ ] Rotate `attestor` off the deployer placeholder (`setAttestor`).
- [ ] Create the Own tenant on the service (`slug`, `limit_usdc: 100`,
      `chain_id`, `contract_address`, `redirect_uris`, `web_origins`), and add
      those origins to `LIVENESS_CORS_ORIGINS`.
      Note: the attested limit is **per-identity**, not per-tenant — raising a
      tenant's `limit_usdc` does nothing for already-enrolled users.
- [ ] Deploy on Base mainnet from an Own multisig (`owner` is immutable),
      verify on Basescan, and open a whitelist request (`docs/WHITELISTING.md`).
- [ ] Confirm the mainnet `circleId` for each fiat currency Own will offer.
