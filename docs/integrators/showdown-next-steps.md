# Showdown — integration next steps

Status doc for the team. Covers what's live, what blocks a real end-to-end transfer, and the work left across the contract, widget, SDK, and Solana side.

See [`showdown.md`](./showdown.md) for the contract design itself.

## Where we are

`ShowdownCheckoutIntegrator` is built, unit-tested (81 tests), deployed and whitelisted on Base Sepolia.

> ⚠️ **The deployed Sepolia build is stale.** The pre-prod audit ([`docs/reviews/PR-35-showdown-audit.md`](../reviews/PR-35-showdown-audit.md)) changed the limit model and the completion accounting, so the bytecode differs from `0x450642C7…`. That address still enforces the old flat $20/$50 with owner-raisable caps. **Re-deploy and re-whitelist before any further testing.**

|                  |                                                                      |
| ---------------- | -------------------------------------------------------------------- |
| Integrator       | `0x450642C7A1D21567814a0e262fF996aC63c0DB25`                         |
| proxyImpl        | `0xD6E7158270F622Af2ea9Ac6ECbcFD85EC2c71589`                         |
| Diamond          | `0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9`                         |
| Registration     | `isActive = true`, `usdcThroughIntegrator = false`                   |
| Bytecode hash    | `0xaa1bcc0265991096f3387a5a92141064dfc07a0ce40934564f4364bc403c73e1` |
| Deployer / owner | `0x9DE9772AfCdf3AFa03CC689fE7AFA5b631088aB9`                         |

Verified live on Base Sepolia (`scripts/local/smoke-showdown.ts`), not just in unit tests:

- The EIP-712 attestation domain binds to this contract + chain; a signed liveness/KYC attestation moves the tier.
- The on-chain tier ceilings hold: an attestor signing a `$1000` limit yields `grantedLimit = $1000` but `effectiveLimit` stays at the tier ceiling. _(Run against the old flat caps; re-run after the re-deploy to confirm the region matrix live.)_
- The full onramp path clears — proxy CREATE2 deploy → B2B gateway proxy-auth → `validateOrder` → `placeB2BOrder`. Simulated via `staticCall`, so no live order was placed and no merchant capacity was held.
- `$51` and zero-Solana-recipient orders are refused with `KycLimitExceeded` / `InvalidSolanaRecipient`.

## 1. The blocker: Base Sepolia can't actually bridge

**CCTP burns only Circle-issued USDC. Our Base Sepolia Diamond settles in a mock token** — `GoofyGoober` (`GG`, `0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d`), which is what `USDC_ADDRESS` points at. Circle's TokenMinter reports `burnLimitsPerMessage(GG) == 0`: it will not burn it. Circle's real Base Sepolia USDC is `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.

So on Sepolia the order flow, KYC tiers, proxy auth and full lifecycle are exercisable, but **every bridge attempt fails closed** — the order completes, the USDC is held and reserved in `unbridgedTotal`, and `retryBridge` / `userRescueStuckBridge` keep it recoverable. Nothing is lost; it just doesn't reach Solana.

The contract is single-token by design (`usdc` is both what the Diamond settles in and what CCTP burns) because on **mainnet those are the same token** and the whole problem disappears. Options, in rough order of preference:

1. **Go to Base mainnet** with real USDC — the design works as intended, no changes.
2. **Point a Sepolia Diamond at Circle's Base Sepolia USDC** and re-deploy the integrator against it. This is the only way to get a genuine testnet Base→Solana Devnet transfer through the full P2P flow.
3. **Prove the CCTP leg standalone** — a script that burns real Circle Sepolia USDC to Solana Devnet, outside the Diamond flow, to validate params (domain 5, ATA encoding, `maxFee = 0`) before mainnet. Cheap, and worth doing regardless.

**Decision needed:** which of these we're doing. Everything in §5 depends on it.

## 2. Verification + whitelist request

- **Basescan verification has not run** — there's no `BASESCAN_API_KEY` in `.env`. It's required by [`WHITELISTING.md`](../WHITELISTING.md) step 2 before a formal whitelist request. `scripts/local/deploy-showdown.ts` prints the exact `hardhat verify` command.
- The Sepolia registration was done directly by the super-admin (the deployer holds that role). A formal **Whitelist request** issue is still the right artifact for mainnet, and needs: network, integrator address, pinned `proxyImpl`, `usdcThroughIntegrator = false`, deployer, merged commit hash, bytecode hash, Etherscan link, expected `circleId`(s), and an operational contact.
- Reviewers should confirm `proxyImpl` matches the canonical `UserProxy` bytecode — that check is off-chain and is the actual security gate.

## 3. simple-kyc tenant registration

Both attestors are currently set to the **deployer key** so the demo can sign attestations locally. Before anything real:

1. Register the integrator address as the tenant `contract_address` in **both** the liveness and the KYC simple-kyc services, so they sign attestations bound to it.
2. Rotate the signers: `setLivenessAttestor(<liveness GET /v1/attestor>)`, `setKycAttestor(<kyc GET /v1/attestor>)`. Both are owner-settable, no redeploy.

The services can sign whatever dollar limit they like — the contract clamps to `tierCap[tier][region]`, so the tiers hold even if a signer key leaks. Adjust with `setTierCap(tier, region, cap)`, which can only ever move a cap _down_ from its immutable `MAX_*` ceiling; setting a cell to `0` disables that lane without touching anyone's attestation.

**Attestor values must come from the service's own `/v1/attestor` endpoint, never from a partner- or teammate-relayed value.** Both Showdown attestors were wrong once on Sepolia for exactly that reason (fixed 2026-07-25). `scripts/local/set-showdown-attestors.ts` fetches the signer from the service rather than taking it as an argument, which is the point of the script.

Attestation intake is byte-compatible with `UsdcDirectCheckoutIntegrator` (same typehashes, `KycVerifier` / `LivenessVerifier` domains, single-use per-(tenant, human) nullifiers), so any existing simple-kyc wiring carries over.

## 4. Widget work — `p2pdotme-checkout-widget` (`@p2pdotme/widgets`)

The offramp maps cleanly onto the existing `<Cashout>` host-callback shape; the onramp needs a new field.

**`<Checkout>` (onramp).** Calls `userBuyUsdcToSolana(amount, currency, solanaRecipient, circleId, pubKey, preferredPaymentChannelConfigId, fiatAmountLimit)`.

> ⚠️ **`solanaRecipient` is the user's USDC associated token account (ATA), not their wallet address**, encoded as bytes32 — and it must already exist on Solana or the mint can never be executed. This is the single easiest way to lose real money here. The widget must derive the ATA from the user's Solana wallet and **create it if absent** before placing the order. The contract rejects `bytes32(0)` but cannot tell a wallet address from an ATA.

**`<Cashout>` (offramp).** The existing `placeCashout` / `deliverUpi` / `reconcile` callbacks map to `userInitiateOfframp` / `deliverOfframpUpi` / `reconcile`. One important difference from the current offramp integrators: **there is no ERC-20 approve step**. Funds are not pulled from the user's Base wallet — they must already be sitting on the user's proxy, having been bridged from Solana. So the flow gains a prerequisite step:

1. Show `offrampMintRecipient(user)` — the bytes32 the user's Solana-side CCTP burn must name as `mintRecipient`.
2. User burns USDC on Solana to that address.
3. Deliver the attested message on Base (see §5) — `receiveFromSolana(message, attestation)` is a convenience passthrough on the integrator, or call MessageTransmitterV2 directly; it's permissionless either way.
4. Poll `bridgedBalance(user)` until it reflects, then `userInitiateOfframp(...)`.

Note the Diamond's fee comes off the same proxy balance, so the proxy needs **principal + fee** by delivery time, not just principal. `userInitiateOfframp` only checks the principal; `deliverOfframpUpi` reads the authoritative `actualUsdtAmount` and will revert with `InsufficientBridgedFunds` if the proxy is short. Worth surfacing headroom in the UI.

**KYC gate UI.** `submitLivenessAttestation` / `submitKycAttestation`, and read `effectiveLimit(user)` / `userTier(user)` to drive the cap shown and the upsell from $20 → $50.

**Escape hatch.** `userBridgeBackToSolana(amount, ata)` returns bridged-in funds to Solana instead of offramping — worth exposing for users who change their mind or whose tier doesn't cover the amount.

## 5. Attestation delivery — the missing service, and the launch blocker

**CCTP does not auto-deliver.** `depositForBurn` burns the USDC and emits a message; that is _all_ it does. It authorizes a mint — it does not perform one. The mint only happens when someone calls `receiveMessage(message, attestation)` on the **destination** chain. Nothing in the contract, on either side, does this. Without a service that does, an onramp burns on Base and **the user's USDC never appears on Solana**, while `unbridgedTotal` reads 0 and the integrator looks perfectly healthy.

**Sizing the risk correctly:** this is an _availability_ problem, not a _safety_ one. Showdown burns with `destinationCaller = bytes32(0)`, so delivery is permissionless, and Circle's attestations do not expire — anyone can submit a stale message months later and the mint still lands, to the recipient encoded in the message and nobody else. So funds are never lost. But an onramp that doesn't deliver is a user who paid fiat and has nothing, which is a support incident on day one.

### The three steps, per transfer

1. **Burn** — happens on-chain already (`_bridge` on Base; the user's wallet on Solana).
2. **Attest** — Circle's Iris service observes the burn, waits for the finality threshold, and signs the message. Nothing to build; just wait and poll.
3. **Deliver** — fetch `(message, attestation)` from Iris and submit `receiveMessage` on the destination. **This is the part that does not exist.**

### Iris API — verified 2026-07-27

|              |                                                                                       |
| ------------ | ------------------------------------------------------------------------------------- |
| Attestation  | `GET https://iris-api.circle.com/v2/messages/{sourceDomain}?transactionHash={txHash}` |
| Sandbox      | `https://iris-api-sandbox.circle.com` (same paths)                                    |
| Fee schedule | `GET https://iris-api.circle.com/v2/burn/USDC/fees/{srcDomain}/{dstDomain}`           |

Both confirmed live against the real service (a bogus hash returns a structured `404 {"error":"Message not found for provided parameters"}`, i.e. the route resolves). Source domain is **6** for a Base burn, **5** for a Solana burn. Poll until the message reports complete, then submit. This supersedes the earlier note that the endpoints were unconfirmed.

**Fee schedule for Base → Solana, live today:**

```
[{"finalityThreshold":1000,"minimumFee":1.3},   // Fast:     1.3 bps
 {"finalityThreshold":2000,"minimumFee":0}]     // Standard: free
```

So the contract's shipped defaults (`bridgeMinFinalityThreshold = 2000`, `bridgeMaxFeeBps = 0`) are **valid on mainnet today** — previously only verified on Sepolia. Switching to Fast needs `setBridgeMaxFeeBps(≥ 2)` to clear the 1.3 bps minimum, comfortably inside the immutable `MAX_BRIDGE_MAX_FEE_BPS = 100` ceiling. A burn whose `maxFee` is under Circle's minimum reverts _at burn time_ ("Insufficient max fee") and lands in the retry path — it does not lose funds.

### Onramp delivery (Base → Solana) — the harder half

- **Trigger:** the integrator's `BridgedToSolana(orderId, user, amount, solanaRecipient, maxFee)`.
- **Message bytes:** from the `MessageSent(bytes message)` log that MessageTransmitterV2 emits in the same transaction — the integrator does not return or store it, so the watcher must read the receipt logs.
- **Deliver on Solana:** `receiveMessage` on MessageTransmitterV2 `CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC` (with TokenMessengerMinterV2 `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe`). This is a real Solana transaction: several PDAs to derive plus the recipient's ATA in the account list, per Circle's `solana-cctp-contracts` IDL.
- **Costs SOL**, paid by whoever submits — budget a funded Solana keypair.
- **Latency:** Standard Transfer finality from Base is ~13–19 min, so the watcher must be durable across restarts, not an in-memory timer.

### Offramp delivery (Solana → Base) — the easier half

- **Trigger:** the user's Solana burn naming `offrampMintRecipient(user)` as `mintRecipient`. A Helius webhook is the natural watcher — the same shape `tradestars-relayer` used.
- **Deliver on Base:** `receiveMessage(message, attestation)`, either directly on MessageTransmitterV2 or through the integrator's `receiveFromSolana` passthrough (identical effect; the passthrough exists so the widget has one ABI).
- **Costs Base ETH.** Cheap.
- Then the funds sit on the user's proxy and `bridgedBalance(user)` reflects them.

### Who builds it — three options

1. **Own relayer.** Full control, handles both directions, works whether or not the user is still on the page. Needs: an event watcher per chain, a durable retry queue, a funded Solana keypair + Base EOA, and monitoring. Closest reference is `tradestars-relayer` (Base event → Solana action, Helius webhook → lifecycle).
2. **Client-side, in the widget.** The user already has a Solana wallet — they can sign `receiveMessage` themselves. Near-zero infra, but it breaks if they close the tab, and ~15 min of Standard finality makes that likely.
3. **Circle's forwarding service.** No infra at all. **Confirm it covers Solana as a destination and the pricing at our volume** — that is the open question.

**Recommendation: 2 + 1 as a backstop.** Let the widget attempt delivery so the happy path is instant and free, and run a sweeper that periodically re-scans for burns with no matching mint and submits them. Because delivery is permissionless and attestations never expire, the backstop can be simple and can run on a cron — it never races the widget destructively, it just delivers whatever is outstanding. That gets the launch-blocking property (nothing stays undelivered) without making the first version of the relayer load-bearing.

**Minimum to launch:** the backstop sweeper for the onramp direction. Everything else can follow.

### Monitoring

- `BridgedToSolana` **without** a matching Solana mint inside ~30 min → the delivery alert. This is the one that means users are missing funds.
- `BridgeFailed(orderId, reason)` → the burn itself was refused; funds are safe and reserved, `retryBridge` is permissionless and bubbles the reason.
- `unbridgedTotal` → should sit near 0. Anything persistent means burns are failing.
- `OnrampAmountAdjusted` → should never fire; means the Diamond delivered an amount other than the one placed.

## 6. Transfer speed / fees

Defaults are Standard Transfer, free: `bridgeMinFinalityThreshold = 2000`, `bridgeMaxFeeBps = 0`. Circle's live fee schedule for Base → Solana confirms `minimumFee = 0` at threshold 2000, so **the defaults are valid on mainnet today** (§5) — previously this was only known for Base Sepolia. Fast Transfer costs 1.3 bps and needs `setBridgeMinFinalityThreshold(1000)` plus `setBridgeMaxFeeBps(≥ 2)`, comfortably inside the immutable `MAX_BRIDGE_MAX_FEE_BPS = 100` ceiling. **Product decision:** is ~13–19 min acceptable, or do we pay ~$0.03 on a $200 transfer for seconds?

## 7. Monitoring

- **`BridgeFailed(orderId, reason)`** — a burn was refused. Alert on this; it's the signal that funds are accumulating undelivered.
- **`unbridgedTotal`** — USDC held and owed to Solana. Should sit at ~0 in healthy operation. Anything persistent means bridges are failing.
- `retryBridge(orderId)` is permissionless and bubbles the CCTP revert reason, so it doubles as the diagnostic.

## 8. Custody / owner powers — for reviewer sign-off

- The owner **cannot touch in-flight funds**: `withdrawUsdc` is hard-bounded by `unbridgedTotal` and can only sweep genuine surplus.
- The stuck-bridge escape is **buyer-only, after 7 days** (`userRescueStuckBridge`) — never an owner power. It returns Base-side USDC rather than the Solana USDC ordered: a deliberate trade against permanent loss, bounded by the tier cap, unreachable while CCTP is healthy.
- The Solana destination is **pinned at order time** and cannot be redirected by anyone, including the owner — which is why `retryBridge` is safe to leave permissionless.
- Owner powers are: attestor rotation, tier caps, daily count, offramp kill switch + relayer, bridge fee/finality, and surplus sweep. No upgradeability — the integrator is immutable by repo policy.

## 9. Limits (settled 2026-07-27)

Enforced as a (tier × region) matrix, region derived from the order's fiat currency (`INR` → India, everything else → Abroad):

| Tier                | India | Abroad |
| ------------------- | ----- | ------ |
| liveness            | $20   | $50    |
| passport + liveness | $100  | $200   |

Plus 5 orders/day per user, budgeted separately for onramp and offramp. Every one of those five numbers is an immutable `MAX_*` constant in the bytecode; the owner may lower a cap but can never raise one past policy. See [`showdown.md`](./showdown.md#limits).

Consequences to carry into the widget:

- **Quote the region-correct cap.** `effectiveLimits(user)` returns `(india, abroad)` in one call; `effectiveLimit(user, currency)` is the exact figure for a given order. The old one-argument `effectiveLimit(user)` is **gone** — an ABI break.
- **`tierCap` is now `tierCap(tier, region)`.** Same for the smoke and attestor scripts, already updated.
- **Surface the daily budget.** `getRemainingDailyCount(user)` and `getRemainingOfframpDailyCount(user)`. At 5/day, and with cancels not releasing slots (§below), a user can hit the wall in an afternoon.
- **Blocked users.** `blocked(user)` is a binary owner gate; the entrypoints revert `UserIsBlocked`. Show it distinctly from "not verified" — the fix is different.

## Open decisions

1. **Which network do we actually bridge on** (§1) — mainnet, a USDC-settling Sepolia Diamond, or standalone proof first.
2. **Who delivers attestations** (§5) — **the launch blocker.** Recommendation is widget-side delivery plus a backstop sweeper; the open question is whether Circle's forwarding service covers Solana at our volume, which would remove the work entirely.
3. **Fast vs Standard transfers** (§6).
4. **Who owns the Solana ATA creation UX** (§4) — widget vs. Showdown's own app.
5. **Who holds the mainnet `owner` key** — decided: a **Showdown multisig**. `owner` is immutable with no transfer and no renounce, so the deploy must be sent _from_ that multisig. See the audit's deploy gates.
