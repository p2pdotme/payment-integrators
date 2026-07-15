# Showdown — integration next steps

Status doc for the team. Covers what's live, what blocks a real end-to-end transfer, and the work left across the contract, widget, SDK, and Solana side.

See [`showdown.md`](./showdown.md) for the contract design itself.

## Where we are

`ShowdownCheckoutIntegrator` is built, unit-tested (54 tests), deployed and whitelisted on Base Sepolia.

| | |
| --- | --- |
| Integrator | `0x450642C7A1D21567814a0e262fF996aC63c0DB25` |
| proxyImpl | `0xD6E7158270F622Af2ea9Ac6ECbcFD85EC2c71589` |
| Diamond | `0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9` |
| Registration | `isActive = true`, `usdcThroughIntegrator = false` |
| Bytecode hash | `0xaa1bcc0265991096f3387a5a92141064dfc07a0ce40934564f4364bc403c73e1` |
| Deployer / owner | `0x9DE9772AfCdf3AFa03CC689fE7AFA5b631088aB9` |

Verified live on Base Sepolia (`scripts/local/smoke-showdown.ts`), not just in unit tests:

- The EIP-712 attestation domain binds to this contract + chain; a signed liveness/KYC attestation moves the tier.
- The on-chain tier ceilings hold: an attestor signing a `$1000` limit yields `grantedLimit = $1000` but `effectiveLimit = $20` (liveness) / `$50` (KYC).
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

The services can sign whatever dollar limit they like — the contract clamps to `tierCap[1] = $20` / `tierCap[2] = $50`, so the tiers hold even if a signer key leaks. Adjust with `setTierCap(tier, cap)`; setting a cap to `0` disables that tier without touching anyone's attestation.

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

## 5. Solana side + attestation delivery — the missing service

**CCTP does not auto-deliver.** A burn only authorizes a mint; someone must fetch the attestation from Circle's attestation (Iris) API and submit `receiveMessage` on the destination chain. Without this, an onramp burns on Base and **the user's USDC never appears on Solana**. This is required work, not a nice-to-have.

- **Onramp (Base → Solana):** watch `BridgedToSolana(orderId, user, amount, solanaRecipient, maxFee)`, fetch the attestation for that burn, submit `receiveMessage` to the Solana `MessageTransmitterV2` program. Standard Transfer finality from Base is ~13–19 minutes.
- **Offramp (Solana → Base):** watch the Solana burn, fetch the attestation, submit on Base. Permissionless, so a relayer can do it for the user.

The shape is close to what `tradestars-relayer` already did (Base event → Solana action, Helius webhook → drives the SELL lifecycle), so that's the reference even though TradeStars itself was removed. Circle also offers a forwarding service — worth evaluating before we build a relayer.

**To confirm before building:** the exact Iris endpoint + auth for V2 testnet, and whether Circle's forwarding service covers Solana for our volume. I did not verify these against the docs (the API page 404'd), so treat any endpoint you find in older notes as unconfirmed.

Solana program IDs (mainnet and devnet share these): MessageTransmitterV2 `CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC`, TokenMessengerMinterV2 `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe`.

## 6. Transfer speed / fees

Defaults are Standard Transfer, free: `bridgeMinFinalityThreshold = 2000`, `bridgeMaxFeeBps = 0` (`maxFee = 0` is valid while the messenger's `minFee` is 0, which it is on Base Sepolia today). If ~15 min is too slow for the product, switch to Fast Transfer — `setBridgeMinFinalityThreshold(1000)` plus a non-zero `setBridgeMaxFeeBps(...)`, since Fast charges. **Product decision:** is free-and-slow acceptable, or do we pay for seconds?

## 7. Monitoring

- **`BridgeFailed(orderId, reason)`** — a burn was refused. Alert on this; it's the signal that funds are accumulating undelivered.
- **`unbridgedTotal`** — USDC held and owed to Solana. Should sit at ~0 in healthy operation. Anything persistent means bridges are failing.
- `retryBridge(orderId)` is permissionless and bubbles the CCTP revert reason, so it doubles as the diagnostic.

## 8. Custody / owner powers — for reviewer sign-off

- The owner **cannot touch in-flight funds**: `withdrawUsdc` is hard-bounded by `unbridgedTotal` and can only sweep genuine surplus.
- The stuck-bridge escape is **buyer-only, after 7 days** (`userRescueStuckBridge`) — never an owner power. It returns Base-side USDC rather than the Solana USDC ordered: a deliberate trade against permanent loss, bounded by the tier cap, unreachable while CCTP is healthy.
- The Solana destination is **pinned at order time** and cannot be redirected by anyone, including the owner — which is why `retryBridge` is safe to leave permissionless.
- Owner powers are: attestor rotation, tier caps, daily count, offramp kill switch + relayer, bridge fee/finality, and surplus sweep. No upgradeability — the integrator is immutable by repo policy.

## Open decisions

1. **Which network do we actually bridge on** (§1) — mainnet, a USDC-settling Sepolia Diamond, or standalone proof first.
2. **Who delivers attestations** (§5) — Circle's forwarding service vs. our own relayer.
3. **Fast vs Standard transfers** (§6).
4. **Who owns the Solana ATA creation UX** (§4) — widget vs. Showdown's own app.
