# Zapp — fiat → USDC onramp (liveness)

Fiat on-ramp for [Zapp](https://justzappit.xyz), a privacy-first Zcash
wallet. Buyers pay local fiat (INR via UPI) and receive Base USDC **directly in
their own wallet**, gated on a single liveness attestation from the simple-kyc
service.

- Contract: `contracts/integrators/zapp/ZappCheckoutIntegrator.sol`
- Tests: `test/zapp-integrator.test.ts`
- Deploy: `scripts/deploy-zapp.ts`
- Maintainer: hello@justzappit.xyz

---

## 1. Why this integrator exists

Zapp's ramp runs on the **direct-user** path today: the user's own wallet
calls `placeOrder` on the Diamond, and order size is derived from the wallet's
Reputation Points. That path has a cold-start wall — a zero-RP wallet reverts
`USER_HAS_NO_REPUTATION`, so a first-time user must complete a full identity
verification (hosted KYC, ZKPassport, or a Reclaim social proof) before they can
move a single dollar.

A whitelisted integrator bypasses the protocol's RP limits and enforces its own
in `validateOrder` (`IB2BGateway.placeB2BSellOrder` documents this explicitly;
`docs/LIMITS-AND-RP.md` §"Overriding limits in a custom integrator" blesses
replacing the RP curve outright). That is what lets a **liveness** check — a
selfie, seconds, no documents — carry a small starting limit instead of a full
KYC redirect. Everything above that first $20 still routes through the existing
RP path.

This is the only reason the contract exists. It adds no product logic: nothing
is delivered, credited, or redeemed on settlement.

## 2. Where the money goes

The purchased USDC is delivered by the Diamond **directly to the buyer's own
Base wallet**.

- `buyUsdc` takes **no recipient parameter at all**. Every order pins
  `recipientAddr = msg.sender`, so a caller can only ever buy for themselves.
- Registration is **`usdcThroughIntegrator = false`**, so the Diamond pays the
  buyer directly.
- Neither this contract nor the buyer's `UserProxy` is ever in the settlement
  path. The proxy is used only as the authenticated _caller_ of `placeB2BOrder`
  (the B2B gateway is proxy-only); it never receives or holds USDC, so the
  proxy's USDC trap is not in play.

Because the integrator has **no custody at any point**, there is no rescue,
retry, or refund machinery in this contract, and no owner key that can move a
user's money. `sweepUsdc` exists solely to recover tokens mistakenly sent to the
contract address — in normal operation its balance is always zero.

If a completion callback ever describes something other than the order this
contract placed, it emits `SettlementRoutingAnomaly` and refuses to mark the
session settled, so the condition surfaces on the first order rather than the
hundredth.

That check does **not** rely on `recipientAddr`. The Diamond routes settlement on
`usdcThroughIntegrator` but passes `_order.recipientAddr` to the callback in both
branches, so under a mis-registration the callback still names the buyer while
the USDC is routed to the integrator — the argument looks correct in exactly the
case the alarm exists for. The routing limb therefore reads the Diamond's own
`getIntegratorConfig` flag, falling back to a balance comparison only when that
view is unreadable. The integrator's balance is emitted for diagnosis but is not
the signal: nothing here consumes the balance, so a stranger could donate one
order's worth and hold the alarm on until an owner swept.

### The swap to ZEC is not on-chain here

Zapp's Buy ZEC delivers shielded ZEC; this integrator delivers USDC on Base.
The swap from one to the other deliberately runs from the user's own Base
account in the app, after settlement, not from inside the contract. Swapping
here would mean taking custody of every buyer's proceeds and re-deriving each
user's share — reintroducing exactly the stranded-funds surface that direct
settlement avoids.

## 3. The gate: liveness, one tier

No ladder — no unverified path, no higher tier.

| tier     | per tx  | per day  |
| -------- | ------- | -------- |
| liveness | **$20** | 5 orders |

Effective cap is `min(attested limit, livenessTierCap)`. The service signs a
dollar limit into the attestation and the contract clamps it, so a compromised
attestor key cannot authorize more than policy.

### Immutable ceilings

Both numbers are **also immutable `MAX_*` constants in the bytecode**:

```solidity
uint256 public constant MAX_LIVENESS_TIER_CAP = 20e6;   // $20
uint256 public constant MAX_DAILY_TX_COUNT_LIMIT = 5;
```

`setLivenessTierCap` and `setDailyTxCountLimit` check against these, so no
limit can ever exceed its ceiling, whoever holds the owner key. Below the
ceiling a limit moves freely in both directions, so a cap lowered during an
incident can be restored without redeploying. The guarantee is the ceiling, not
monotonicity. A deploy may launch tighter than policy; it can never launch
looser.

The ceilings bound each wallet, not the number of wallets. That aggregate is
what the owner key can still reach, through the attestor — see §4.

### Attestation binding

The on-chain twin of simple-kyc's `LivenessAttestationVerifier`:

|                     |                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------ |
| typehash            | `LivenessAttestation(address wallet,bytes32 nullifier,uint256 limit,uint256 expiry)` |
| domain name         | `LivenessVerifier`, version `1`                                                      |
| `verifyingContract` | `address(this)`                                                                      |
| recovery            | `ecrecover`, high-`s` signatures rejected (EIP-2)                                    |

Binding `verifyingContract` to this deployment is what stops an attestation
minted for one integrator being replayed against another. The per-(tenant,
human) `nullifier` is single-use — the on-chain half of the Sybil defence, with
face dedup as the off-chain half. `domainSeparator()` is exposed so the service
and the frontend can assert they are signing for this exact deployment.

Register this contract's address as the tenant `contract_address` with the
liveness service, and read the attestor key from the service's own
`GET /v1/attestor` — never a relayed value. A wrong attestor bricks the tier
silently: every `submitLivenessAttestation` reverts `InvalidSignature`, and it
only surfaces when a real user first tries to verify.

Grants are **monotonic and do not lapse**: `expiry` is a claim-freshness
deadline, not an ongoing clock. That is safe because the nullifier is
single-use, so an expired grant could never be re-claimed anyway. `setBlocked`
is the lever for revoking a wallet.

## 4. Owner powers (the complete list)

| function                                      | effect                                                                  | bounded by                                                |
| --------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| `setPendingAttestor` → `applyPendingAttestor` | rotate the service signer; the new key takes effect 48 h after proposal | `ATTESTOR_ROTATION_DELAY`; `0` rejected; grants untouched |
| `cancelPendingAttestor`                       | withdraw a proposed rotation                                            | —                                                         |
| `setLivenessTierCap`                          | set the per-tx cap; `0` halts new orders                                | `MAX_LIVENESS_TIER_CAP`                                   |
| `setDailyTxCountLimit`                        | set placements/day; `0` rejected                                        | `MAX_DAILY_TX_COUNT_LIMIT`                                |
| `setBlocked`                                  | denylist a wallet (sanctions / confirmed fraud)                         | —                                                         |
| `pause` / `unpause`                           | halt new verifications, placement and validation                        | —                                                         |
| `sweepUsdc`                                   | recover stray tokens sent here by mistake                               | —                                                         |
| `transferOwnership` → `acceptOwnership`       | hand the owner role to another key, e.g. a multisig                     | the new owner must accept; `renounceOwnership` disabled   |

The owner **cannot** raise a limit past its ceiling, move a user's funds,
redirect settlement, or upgrade the contract. There is no proxy, no
`delegatecall`, and no `selfdestruct`.

The owner **can** mint grants, indirectly. The attestor decides who is verified,
so an owner that points it at a key of its own can sign attestations for any
number of fresh wallets, each good for $20 per order and 5 orders a day. Two
things constrain that:

- **Every rotation is public for 48 hours before it takes effect.**
  `setPendingAttestor` emits `AttestorProposed(attestor, readyAt)`, and nothing
  changes until `applyPendingAttestor` after `readyAt`. That is the window for
  anyone watching to flag it and for P2P to `deactivateIntegrator`. The delay
  makes a rotation visible; it does not prevent one.
- **The owner is a multisig.** Owner compromise is a superset of attestor
  compromise. Ownership is `Ownable2Step`, so it can move to a new key without
  redeploying, and `scripts/deploy-zapp.ts` refuses a mainnet `DEPLOY_OWNER`
  that has no contract code.

## 5. Order lifecycle

1. User completes the liveness check once and calls
   `submitLivenessAttestation(nullifier, limit, expiry, signature)` from their
   own wallet. One transaction, one time.
2. User calls `buyUsdc(amount, currency, circleId, pubKey, …)`. The contract
   deploys their `UserProxy` on first use and places a B2B BUY through it with
   `recipientAddr = their own address`.
3. The Diamond calls back into `validateOrder` synchronously — the authoritative
   gate. It re-checks verification, the cap, and the daily count, and consumes
   the daily slot. A placement that did not pass this callback is unwound
   (`OrderValidationMissing`).
4. User pays fiat off-chain (UPI) to the matched merchant.
5. On settlement the Diamond transfers the USDC straight to the user's wallet
   and calls `onOrderComplete`, which is bookkeeping only.

The daily counter is **placements** per day, not completions: it is deliberately
not released on cancellation, because a placement holds merchant capacity for
the life of the order whether or not it completes.

## 6. Limits / RP behaviour

Overrides the standard RP curve entirely (pattern 1 in `docs/LIMITS-AND-RP.md`).
There is no `baseTxLimit`, no `rpToUsdc`, and no RP tracking in this contract —
the attestation and the immutable ceilings are the whole rate-limit story.

For the widget's convenience view, `userTxLimit()` returns `livenessTierCap`.
Order IDs are decoded from the protocol's own `B2BOrderPlaced`; this integrator
emits `OnrampOrderCreated` rather than `CheckoutOrderCreated` because there is no
product being checked out (same choice as LotPot — see
`docs/INTEGRATORS.md` §"Widget compatibility surface").

## 7. Addresses

|                   | Base mainnet (8453)                          | Base Sepolia (84532)         |
| ----------------- | -------------------------------------------- | ---------------------------- |
| Integrator        | `<TBD — not yet deployed>`                   | `<TBD — not yet deployed>`   |
| `proxyImpl`       | `<TBD>`                                      | `<TBD>`                      |
| Diamond           | `0x4cad6eC90e65baBec9335cAd728DDC610c316368` | passed via `DIAMOND_ADDRESS` |
| USDC              | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | passed via `USDC_ADDRESS`    |
| Liveness attestor | `<TBD — from GET /v1/attestor>`              | `<TBD>`                      |

Deploy with `DRY_RUN=1` first; the script preflights code-at-address, token
decimals, and both ceilings before spending gas, then asserts
`usdcThroughIntegrator == false` after registration.

## 8. Launch dependencies

- [ ] Liveness attestor key, read from the service's own `GET /v1/attestor`,
      passed at deploy (a later rotation takes 48 hours)
- [ ] Zapp multisig as `DEPLOY_OWNER`
- [ ] This contract's address registered as the tenant `contract_address` with
      the liveness service
- [ ] Whitelist request approved and `registerIntegrator` executed with
      `usdcThroughIntegrator = false`
- [ ] Base Sepolia end-to-end run against the live Diamond
- [ ] Row added to `docs/INTEGRATORS.md` once deployed

## 9. Operational notes

- No keepers, no allowlists, no off-chain jobs. The contract is inert between
  user transactions.
- No upstream protocol dependency — nothing to mock, nothing to version-pin.
- The contract's USDC balance should be zero at all times. A non-zero balance
  means a stray transfer or a mis-registration; check for
  `SettlementRoutingAnomaly` before sweeping.
- Watch for `AttestorProposed`. An unexpected one is the 48-hour warning that
  the owner key is pointing the attestor somewhere new.
- Rotating away from a leaked attestor key takes the same 48 hours. Pause for
  the window: pause stops new verifications as well as orders, so nothing the
  old key signs lands. Wallets it verified before the pause can be stopped with
  `setBlocked`.
