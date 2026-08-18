# Own — Base mainnet launch plan

Companion to `own.md`, which describes the design. This is the ordered list of
what has to be true before real money moves, what is genuinely unverified, and
what to do when something goes wrong on day one.

Status as of 2026-08-14. Everything below was checked against live chains and
services on that date rather than carried over from earlier notes.

---

## 1. Does a change need a new integrator?

The question that decides how fast you can iterate after launch. The contract's
surface is small and, critically, **the bridge is not part of it**:

```
buyUsdc · submitPassportAttestation · validateOrder · onOrderComplete
onOrderCancel · setAttestor · setRegionCap · setDailyTxCountLimit
setBlocked · revokeEnrolment · pause · unpause · sweepUsdc
transferOwnership · acceptOwnership · renounceOwnership (always reverts)
+ views (incl. owner, pendingOwner)
```

Zero lines of code in `OwnCheckoutIntegrator.sol` mention bridging, Relay, USDG
or Robinhood Chain — only the NatSpec explaining why they are absent. That is
the direct payoff of the split-leg design: the Diamond settles to the buyer's
own wallet and the contract's job ends.

| change                                                                                                                       | needs a redeploy?                                |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **Anything about bridging** — Relay params, gas top-up sizing, `usePermit`, switching routers, a different destination token | **No.** Frontend deploy.                         |
| Gas faucet policy, caps, funding                                                                                             | **No.** Separate service.                        |
| Rotate the attestor                                                                                                          | **No.** `setAttestor`.                           |
| Lower a region cap or the daily count                                                                                        | **No.** `setRegionCap` / `setDailyTxCountLimit`. |
| Block a wallet, pause the ramp                                                                                               | **No.** `setBlocked` / `pause`.                  |
| **Raise** a cap above its `MAX_*` ceiling                                                                                    | **Yes** — ceilings are immutable.                |
| Change the owner                                                                                                             | **No.** `transferOwnership` + `acceptOwnership`. |
| Any contract logic change                                                                                                    | **Yes** — plus a fresh whitelist request.        |

So the bridge leg, which is the least-tested part of the system, is also the
part you can fix fastest. That asymmetry is deliberate and worth preserving.

---

## 2. Blocking, in order

### 2.1 Deploy script ABI — **fixed, verify before use**

`scripts/deploy-own.ts` declared a 4-field `getIntegratorConfig`. The deployed
Diamond returns **5** (contracts-v4 #362 inserted `cancelCallbackEnabled` third,
pushing `proxyImpl` to word 4). ethers silently drops the trailing word, so
`proxyImpl` read as `0x0`.

Consequence: `registerIntegrator` lands on chain, _then_ the post-check throws
`registered proxyImpl does not match the deployed one`. On a rerun the
"already locked" guard reads 0 too, so it does not fire. Verified against
mainnet:

```
STALE : proxyImpl=0x0000…0000        ← would abort the deploy
FIXED : proxyImpl=0x10597cde…0C50    ← matches word 4
```

Fixed here. **Eight other scripts still carry the stale ABI** — none on the
launch path, but they will misreport: `deploy-blackstripe`, `register-v2`,
`register-piker`, `deploy-usdc-direct-demo`, `deploy-showdown`,
`investabl-prod-stats`, `deploy-marketplace-demo`, `inspect-piker`.

This struct has now grown twice, both times mid-struct. Before any mainnet
deploy, count the words:

```bash
cast call $DIAMOND "getIntegratorConfig(address)" $INTEGRATOR --rpc-url $BASE_RPC
```

### 2.2 Attestor — read it from the service, never from a person

```bash
curl -s https://passport-api.p2p.cool/v1/attestor
```

Deploy with exactly that. A wrong attestor bricks the tier silently: every
`submitPassportAttestation` reverts `InvalidSignature`, and it only surfaces
when a real user first tries to verify. This has bitten three integrations
including this one. On mainnet `deploy-own.ts` refuses to run without `ATTESTOR`.

Assert after deploying:

```bash
cast call $INTEGRATOR "attestor()(address)" --rpc-url $BASE_RPC
```

### 2.3 A mainnet tenant, distinct from Sepolia

The EIP-712 domain carries `chainId` **and** `verifyingContract`, so a Sepolia
attestation cannot be replayed against the mainnet contract. A separate tenant
is mandatory, not housekeeping.

- `limit_usdc: 200`, not 100. The contract clamps INR to $100 itself; a tenant
  limit of 100 silently caps the abroad tier too.
- The attested limit is **per identity, not per tenant** — raising it later does
  nothing for already-enrolled users. Get it right before onboarding anyone.
- Register the app's origins on the proxy's `ALLOWED_ORIGINS` **and** the
  tenant's `redirect_uris` / `web_origins`. Both are checked, and `redirect_uris`
  match on host **and path**, exactly — register the trailing-slash form too.

### 2.4 Deploy from a multisig

Whatever signs the constructor owns `pause`, `setBlocked`, `setRegionCap` and
`sweepUsdc` until a two-step transfer completes (`transferOwnership`, then
`acceptOwnership` from the new key). Deploy with the Own multisig as
`DEPLOY_OWNER` anyway — a hot deployer key should never hold the levers, even
briefly.

### 2.5 Whitelist request

`docs/WHITELISTING.md`. Must register **`usdcThroughIntegrator = false`**. A
`true` here routes every buyer's settlement to a contract with no forwarding
path and strands it. The deploy script asserts the flag after registering, and
that assert reads word 1 — unaffected by the ABI bug above.

Worth knowing: prod Investabl is registered `true`, so do not assume the
platform default is what you want. Read the live config.

### 2.6 Circle IDs

Confirm the mainnet `circleId` for every fiat currency at launch, and that each
has live merchants. An unset circle defaults to `1` in the app, which on
mainnet is very unlikely to be the right rail.

---

## 3. What is genuinely unverified

Be honest about this list — it is what will break first.

### 3.1 The bridge leg has never run

Relay carries no testnet USDC on Base Sepolia and no Robinhood testnet, so the
entire second leg reaches production unexercised. Not a configuration gap, a
structural one.

**Do a real mainnet run before announcing.** $5 with a $0.25 gas top-up costs
about $0.33 all-in. Check:

- the quote returns a single `signature` step, not `approve` + `deposit`
- `fees.gas.amountUsd` is `0`
- the EIP-3009 signature posts to `/execute/permits` with the signature **in the
  query string**, and `/intents/status` reaches `success`
- USDG lands at the same address on 4663
- the gas top-up arrives as native ETH, and `currencyGasTopup.amount` matches
  what the UI promised

Since none of this needs a contract change (§1), a failure here is a frontend
fix, not a relaunch.

### 3.2 Wallet gas sponsorship is not uniform

Observed on Sepolia, same transaction:

- MetaMask: _"Network fee: Paid by MetaMask"_ — sponsors via EIP-7702
- Keplr: _"Insufficient balance to cover the fees"_, Approve greyed out

So the faucet is load-bearing for some wallets and dead weight for others, and
you cannot tell which in advance. Worth considering `wallet_getCapabilities`
(EIP-5792) so wallets that can sponsor do, with the faucet as fallback — that
also shrinks the faucet's budget exposure.

### 3.3 Faucet caps are over-provisioned

The attestation path allows 1.6×10¹⁵ wei per nullifier per day — about 53 drips.
The legitimate need is **one, ever**: enough gas to submit the attestation, after
which `verified()` answers. One human can only ever have one verified wallet
(the nullifier is single-use on chain), so funding 53 wallets serves no purpose.

Nobody can steal from the faucet — drips only go to the wallet the attestation
binds. The exposure is denial of service: roughly 7 KYC'd humans could exhaust a
day's global budget and leave real users unfunded until 00:00 UTC.

**Before mainnet:** make the nullifier cap a lifetime limit (~2 drips), and
alert when the global cap is approached so exhaustion is visible rather than
silently degrading onboarding.

### 3.4 Faucet hostname

`*.up.railway.app` is on consumer DNS blocklists — a router on the test network
refused to resolve it, which presented as `ERR_NAME_NOT_RESOLVED` and no gas,
with the client failing open and saying nothing to the user. A custom domain
(`gas-faucet.p2p.cool`) is provisioned and awaiting DNS. **Use it in production**;
some fraction of real users' resolvers will do the same thing.

---

## 4. Order of operations

1. Fix and re-verify the deploy ABI (§2.1). ✅ done
2. `GET /v1/attestor`; record the value.
3. `DRY_RUN=1` deploy on mainnet — prints resolved config, deploys nothing.
4. Deploy from the multisig with `ATTESTOR` set. Verify on Basescan.
5. Assert `attestor()`, `owner()`, `maxRegionCap()`, `usdcThroughIntegrator=false`.
6. Whitelist request; confirm registration reads back correctly with the fixed ABI.
7. Create the mainnet tenant (§2.3). Confirm `domainSeparator()` matches what the
   service signs for.
8. Point the faucet at mainnet: `FAUCET_INTEGRATORS` with the new address and its
   attestor, a **persistent volume**, one replica, caps sized to the float, and
   the custom domain.
9. Update own-app: integrator address in the per-chain book,
   `NEXT_PUBLIC_P2P_CHAIN=base`, `NEXT_PUBLIC_P2P_GAS_FAUCET`, circle IDs. Rebuild
   — `NEXT_PUBLIC_*` is inlined at build time.
10. **One real end-to-end with your own money**: fiat → USDC → bridge → USDG,
    from a wallet with zero ETH.
11. Only then, open it up.

---

## 5. Day-one operations

**Watch:** faucet `/healthz` (`funderBalanceWei`, `spentTodayWei` against the
cap) · `SettlementRoutingAnomaly` on the integrator — it can only fire on a
mis-registration or a mis-described completion, so any occurrence is an
incident, and since 2026-08-17 it reads this contract's USDC balance rather
than the callback's `recipientAddr`, which the Diamond passes unchanged in
both routing branches and which therefore could never have caught one ·
`OwnershipTransferStarted` / `OwnershipTransferred` on the integrator — no one
should ever see these outside a planned handover, so an unplanned occurrence
means the owner key is compromised and the contract is being seized ·
completion rate versus the 1.57% organic baseline.

**Levers, in escalating order:** `setBlocked` one wallet · `setRegionCap(region, lower)`
· `setRegionCap(region, 0)` to stop one region · `pause()` to stop all new
placements. None affect orders already in flight, and none can move user funds.

**What you cannot do:** raise a cap above its ceiling or recover a user's
funds — by construction. Settlement goes directly to the buyer, so there is
nothing to recover and no key that could.

**Expect a low completion rate.** Every integrator on mainnet loses 8–87% of
paid orders against a 1.57% organic baseline; Investabl's first two days ran
16.7% against a 60.4% peer figure, and the contract was clean — matching and UPI
were the failures. Budget for that being the launch story rather than anything
on chain.
