# BlioCheckoutIntegrator

Consumer checkout for **blio.me Premium**. Users pay in **local fiat**
(Pago Móvil, PIX, SPEI, …) and the Diamond settles **USDC on Base** directly
into the blio Safe. Premium itself is granted **off-chain** by blio's backend,
which consumes `BlioOrderCompleted`.

- **Source:** `contracts/integrators/blio/BlioCheckoutIntegrator.sol`
- **Registration:** `usdcThroughIntegrator = false`, `cancelCallbackEnabled = false`
- **Diamond:** `0x4cad6eC90e65baBec9335cAd728DDC610c316368` (Base mainnet) ·
  `0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9` (Base Sepolia)
- **USDC (Base):** `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- **Settlement token (Base Sepolia):** `0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d`
  (`GG` mock, 6 decimals — the token the Sepolia Diamond settles in; it is
  **not** Circle USDC)
- **Recipient / treasury:** `0xFB25b3BFc8eCEA01eC70763f92fBc8B3079bdf47` (blio Safe)

## Architecture

Settlement is direct: there is no intermediate contract, no revenue-share layer and no custody. Every order pins
`recipientAddr` to the immutable Safe, so the USDC transfer from the Diamond
goes **straight to the Safe** and the integrator never holds user funds.

```
buyer EOA ──userPlaceOrder──▶ BlioCheckoutIntegrator
                                   │  placeB2BOrder(..., recipientAddr = Safe)
                                   ▼
                                 Diamond ──USDC──▶ blio Safe
                                   │
                                   └─ onOrderComplete ──▶ BlioOrderCompleted
                                                              │
                                                              ▼
                                                   blio backend → Premium
```

The on-chain job is only the protocol lifecycle (validate → complete / cancel)
plus emitting the event blio consumes. Entitlement is a database row in blio,
not an on-chain token.

## Products and limits

Products are `productId`s with a USDC price set by the owner
(`setProductPrice`, `setProductActive`). blio uses `productId` 1–4 for its
Premium plans. On mainnet the owner is the blio Safe, so those calls are queued
as a Safe Transaction Builder batch; direct EOA execution is only supported on
Base Sepolia with an EOA owner (see **Configure products** below).

Per-transaction ceilings are compiled into the bytecode and seeded in the
constructor. The owner can move a live limit anywhere inside `[0, ceiling]`
(raise or lower it), but can never exceed the compiled ceiling:

| Currency class | Tier | Per-tx cap |
| --- | --- | ---: |
| `INR` | Liveness | **20 USDC** |
| `INR` | Passport | **100 USDC** |
| Every other currency | Liveness | **50 USDC** |
| Every other currency | Passport | **200 USDC** |

All non-INR currencies share the `OTHER_CURRENCY` bucket (`bytes32(0)`).

**Currency allowlist.** Only exact, owner-approved labels can be placed
(`allowedCurrency`, `setCurrencyAllowed(bytes32,bool)` +
`CurrencyAllowlistUpdated`). The constructor enables the canonical
`bytes32("INR")` and the `bytes32(0)` wildcard; every other fiat (BRL/PIX/…)
must be opted in. A non-allowed label reverts `CurrencyNotAllowed` in
`userPlaceOrder`, so look-alikes such as `keccak("INR")`, `"inr"` or `"INR "`
can no longer fall into the looser OTHER bucket.

**Daily limit:** `dailyTxCountLimit = 5` **placements per user per UTC day**.
The counter is incremented in `validateOrder`, i.e. when the order is placed,
not when it settles.

## Attestation (KYC gate)

A buyer with no attestation has `Tier.None` and a **zero** limit. The checkout
fails closed: `userPlaceOrder` reverts with `NotAttested` until a valid
signature is submitted.

p2p uses **two independent signers** and **two EIP-712 domains**, so a liveness
signature can never be replayed as KYC (or the reverse):

| Service | Function | Attestor | Domain name | Type |
| --- | --- | --- | --- | --- |
| Liveness | `submitLivenessAttestation(nullifier, limit, expiry, signature)` | `livenessAttestor` (`0x6cC7…2978`) | `LivenessVerifier` | `LivenessAttestation(address wallet,bytes32 nullifier,uint256 limit,uint256 expiry)` |
| Passport/KYC | `submitKycAttestation(wallet, nullifier, limit, expiry, signature)` | `kycAttestor` (`0xA0bE…3Eda`) | `KycVerifier` | `KycAttestation(address wallet,bytes32 nullifier,uint256 limit,uint256 expiry)` |

`verifyingContract = <integrator address>`, `version = "1"`,
`chainId = block.chainid`. Both domain separators are exposed
(`livenessDomainSeparator()`, `kycDomainSeparator()`) and are computed once in
the constructor as immutables.

- **Tiers:** `1 = Liveness`, `2 = Passport`. Grants are monotonic: an
  attestation can raise the tier but never lower it (`TierDowngrade`).
- **Attestors:** immutable, non-zero and distinct (constructor reverts
  `InvalidAddress` otherwise). Rotating one requires a redeploy — no owner key
  can mint tiers after the fact.
- **`limit`:** the signed per-tx ceiling (6dp). The effective limit is the
  signed value only when it is **below** the policy for that currency/tier;
  `0` or anything **above** the policy falls back to the policy. It can never
  widen a cap, so passport stays at **100** (INR) / **200** (other).
- **`expiry`:** the service's short-lived claim deadline. p2p issues claims
  with `expiry = issuedAt + 1 hour`; the contract accepts them when they are
  strictly in the future and at most `MAX_ATTESTATION_DEADLINE` (**2 hours**)
  ahead, or the call reverts `DeadlineTooFar`. The recorded tier is
  **independent of the claim**: it lives for `ATTESTATION_TTL` (**180 days**)
  from acceptance. Past the TTL `_tierOf` reports `None` (zero limit,
  `NotAttested` on placement) and the buyer must be re-attested.
- **`wallet`:** liveness binds `msg.sender`; KYC binds the explicit `wallet`
  argument, so a relayer (e.g. the gas service) may land it without changing
  the grant.
- **Nullifier:** p2p's nullifier is stable per person (and per contract) and is
  **bound to the wallet** (`nullifierWallet`), not single-use. The same wallet
  may re-attest after the TTL or upgrade liveness → passport with the same
  nullifier; presenting it from **another wallet** reverts with
  `NullifierUsed`.

Signing sketch (ethers):

```ts
const livenessDomain = {
  name: "LivenessVerifier",
  version: "1",
  chainId,
  verifyingContract: integrator,
};
const kycDomain = {
  name: "KycVerifier",
  version: "1",
  chainId,
  verifyingContract: integrator,
};

const fields = [
  { name: "wallet", type: "address" },
  { name: "nullifier", type: "bytes32" },
  { name: "limit", type: "uint256" },
  { name: "expiry", type: "uint256" },
];

const livenessSignature = await livenessSigner.signTypedData(
  livenessDomain,
  { LivenessAttestation: fields },
  { wallet, nullifier, limit, expiry }
);

const kycSignature = await kycSigner.signTypedData(
  kycDomain,
  { KycAttestation: fields },
  { wallet, nullifier, limit, expiry }
);
```

## End-to-end flow

1. **Attestation (off-chain → on-chain).** The KYC/liveness provider issues a
   signed attestation; blio (or a relayer) submits it and the buyer's tier is
   recorded.
2. **Placement.** The widget calls
   `userPlaceOrder(productId, quantity, currency, circleId, pubKey, preferredPaymentChannelConfigId, fiatAmountLimit)`.
   The integrator deploys the buyer's `UserProxy` (CREATE2) and places the order
   through it, with `recipientAddr = Safe`.
3. **Fiat payment.** The buyer pays the merchant off-chain in local currency.
4. **Settlement.** The Diamond transfers USDC **directly to the Safe** and calls
   `onOrderComplete`. The integrator verifies that user, amount and
   `recipientAddr` match the recorded session, then emits
   `BlioOrderCompleted(orderId, user, productId, quantity, usdcAmount)`.
5. **Premium (off-chain).** blio's backend indexes `BlioOrderCompleted` and
   credits Premium in its database.

There is **no on-chain receipt**. `BlioOrderCreated` records intent; only
`BlioOrderCompleted` grants entitlement. If the Diamond reports settlement
through the integrator instead of the Safe, the contract emits
`SettlementRoutingAnomaly` and deliberately does **not** emit the completion
event — reconcile manually and alert.

## Cancellation and the daily quota

`cancelCallbackEnabled` stays **`false`**. The Diamond only calls
`onOrderCancel` when that flag is enabled, and blio does not need it:

- The daily counter measures **placements**, so a cancellation or expiry does
  **not** release the slot. Cancel-and-retry still consumes the buyer's
  allowance. Releasing it in `onOrderCancel` would be best-effort at most
  (the callback may never arrive) and gameable.
- An admin can re-open a CANCELLED order and complete it (dispute path). The
  contract handles that: `onOrderComplete` ignores the `cancelled` flag and
  still emits `BlioOrderCompleted`, so a reopened order can grant Premium.
- `onOrderCancel` is idempotent and never reverts; a missing callback only
  affects off-chain bookkeeping, not entitlement.

## Mainnet requirements

- **Owner and treasury = blio Safe.** `owner` controls products, limits and
  pause; `treasury` receives settlement. Both should be the Safe
  (`0xFB25…`). The deploy script refuses to default the owner to the deployer
  EOA on mainnet.
- **Attestors.** Two non-zero, distinct signers must be provided via
  `LIVENESS_ATTESTOR` and `KYC_ATTESTOR` (from
  `https://liveness-api.p2p.cool/v1/attestor` and
  `https://passport-api.p2p.cool/v1/attestor`). Both are immutable per
  deployment.
- **On-chain verification.** Verify the integrator source (Blockscout or
  Etherscan) with the exact constructor arguments, then read
  `diamond()`, `usdc()`, `treasury()`, `livenessAttestor()`, `kycAttestor()`,
  `proxyImpl()`,
  `dailyTxCountLimit()` and the four `limitFor()` entries and confirm they
  match the policy. Confirm the Diamond registration is
  `usdcThroughIntegrator = false` and `cancelCallbackEnabled = false`.
- **Widget fraud filter.** INR BUY orders are not auto-approved: the pay page
  must pass the p2p fraud-screening prop and an approved screening record keyed
  by order id. Use the customer's ephemeral key (the same one used for
  `pubKey`) to sign the screening message, and allow the pay-page origin in the
  fraud engine's CORS. Testnet demos do not enforce this.
- **Relay `pubKey`.** Every placement carries the P2P `pubKey` used for
  merchant communication. The relay must supply a valid, stable key (it is
  forwarded opaquely by the contract and read by the merchant), and the buyer's
  `user` must remain the account that can sign `paidBuyOrder` / `cancelOrder`.
- **Registration is admin-gated.** `registerIntegrator` is
  `onlySuperAdmin`; the p2p admin performs it, or the deployer may use
  `REGISTER=1` when it holds that role. Base Sepolia exposes the 3-argument
  form `registerIntegrator(integrator, usdcThroughIntegrator, proxyImpl)`;
  Base mainnet exposes the 4-argument form with `cancelCallbackEnabled`. The
  deploy script selects the right ABI for the chain and falls back to the other
  signature if the call fails before submission.

## Deploy

Base Sepolia (`84532`) and Base mainnet (`8453`) presets supply `DIAMOND_ADDRESS`
and `USDC_ADDRESS`, so they are not needed in the command. On Sepolia the
settlement token is the `GG` mock above, not Circle USDC.

```bash
# Base Sepolia — use test accounts for recipient/owner; presets fill Diamond + USDC.
RECIPIENT_ADDR=0xYourSepoliaTestAccount \
LIVENESS_ATTESTOR=0x6cC780E44f9Ac850e6D6B8f52A5663286F1A2978 \
KYC_ATTESTOR=0xA0bE015133e4dc63c96EBFB6729D34050Ef33Eda \
DEPLOY_OWNER=0xYourSepoliaTestAccount \
  npx hardhat run scripts/deploy-blio.ts --network baseSepolia

# Base mainnet — recipient and owner are the blio Safe.
RECIPIENT_ADDR=0xFB25b3BFc8eCEA01eC70763f92fBc8B3079bdf47 \
LIVENESS_ATTESTOR=0x6cC780E44f9Ac850e6D6B8f52A5663286F1A2978 \
KYC_ATTESTOR=0xA0bE015133e4dc63c96EBFB6729D34050Ef33Eda \
DEPLOY_OWNER=0xFB25b3BFc8eCEA01eC70763f92fBc8B3079bdf47 \
  npx hardhat run scripts/deploy-blio.ts --network base

# Deploy and register (requires the Diamond super-admin key; REGISTER=1 because
# Hardhat rejects custom --flags):
RECIPIENT_ADDR=0x... \
LIVENESS_ATTESTOR=0x6cC780E44f9Ac850e6D6B8f52A5663286F1A2978 \
KYC_ATTESTOR=0xA0bE015133e4dc63c96EBFB6729D34050Ef33Eda \
DEPLOY_OWNER=0x... REGISTER=1 \
  npx hardhat run scripts/deploy-blio.ts --network baseSepolia
```

Add `DRY_RUN=1` to run the preflight without deploying. Defaults:
`DAILY_TX_COUNT_LIMIT=5` and the 20/50/100/200 matrix. On Base mainnet
`RECIPIENT_ADDR` defaults to the blio Safe. `TREASURY` is accepted as a legacy
alias. The script verifies the limits on-chain after deployment, checks that
`cancelCallbackEnabled` stays `false` after registration, warns if
`usdcThroughIntegrator` is ever observed as non-false, and prints both the
Etherscan and Blockscout verification commands.

## Configure products

`set-blio-products.ts` is idempotent: it only queues calls whose on-chain value
differs from the target. `MODE=safe` writes a Safe Transaction Builder JSON;
`MODE=direct` sends the transactions and is refused on mainnet or when the
owner has code.

```bash
# Base Sepolia, owner = EOA signer
INTEGRATOR=0x... MODE=direct \
  npx hardhat run scripts/set-blio-products.ts --network baseSepolia

# Base mainnet, owner = blio Safe
INTEGRATOR=0x... MODE=safe \
  npx hardhat run scripts/set-blio-products.ts --network base
```

The mainnet command writes `blio-products-safe-8453.json` (override with
`SAFE_BATCH_OUT`). Pass `SAFE_ADDRESS=0x...` to assert it matches `owner()`.
Then:

1. Open the blio Safe → **Apps → Transaction Builder**.
2. Load/import the JSON batch (it contains up to 8 calls: price + activation per
   product, only for values that differ).
3. Review the decoded `setProductPrice` / `setProductActive` calls.
4. Collect the Safe signatures and execute.
5. Re-run the same `MODE=safe` command: it should report that nothing is left
   to change (and generate no batch).

## Off-chain integration

- Index `BlioOrderCompleted` and grant Premium exactly once per `orderId`.
  Do not grant on `BlioOrderCreated`.
- Alert on `SettlementRoutingAnomaly`; it means the session was not fulfilled
  and no completion event follows.
- Tolerate missing `BlioOrderCancelled`: the Diamond may never emit it with
  `cancelCallbackEnabled = false`.

## What changed from the previous version

- The previous **intermediate treasury contract** was removed. The Safe is the
  immutable `treasury`, so settlement is a single direct USDC transfer.
- The **revenue-share layer** was removed, along with its
  parameters and deploy steps.
- No order funds ever pass through the integrator or the `UserProxy`; the only
  USDC recovery lever is for stray tokens, not a withdrawal path.
- The deploy script no longer configures intermediate-treasury addresses, and
  defaults to the 20/50/100/200 limits with 5 placements per day.
