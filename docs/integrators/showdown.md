# Showdown integrator

A two-way fiat ↔ USDC ramp for [Showdown](https://showdown.gg) whose user-facing asset lives on **Solana**, bridged with Circle's [Cross-Chain Transfer Protocol V2](https://www.circle.com/cross-chain-transfer-protocol).

## What it does

- **Onramp (fiat → USDC on Solana).** The user pays local fiat on the P2P network. The Diamond delivers the purchased USDC to the integrator, which immediately burns it via CCTP and authorizes an equivalent mint to the user's Solana USDC account. The final product the user holds is native USDC on Solana — no wrapped asset, no third-party bridge.
- **Offramp (USDC on Solana → fiat).** The user burns USDC on Solana with CCTP, naming their Base-side `UserProxy` as the `mintRecipient`. Once it lands there, they place a SELL on the Diamond funded from that proxy balance and receive fiat.

Both directions are gated by tiered simple-kyc attestations, because both convert between fiat and USDC the user actually controls.

## Limits

The per-tx cap is a function of the KYC tier **and** the settlement region:

| Tier | Attestation         | India (INR) | Abroad   |
| ---- | ------------------- | ----------- | -------- |
| 0    | none                | blocked     | blocked  |
| 1    | liveness            | **$20**     | **$50**  |
| 2    | passport + liveness | **$100**    | **$200** |

Plus **5 orders per user per UTC day**, budgeted _separately_ for each direction — 5 onramps and, independently, 5 offramps.

The effective cap is `min(attested limit, tierCap[tier][region])`. The simple-kyc service signs a dollar limit into the attestation, and the contract clamps it to its own per-(tier, region) ceiling. Tiers stack monotonically: claiming a higher tier raises the cap, claiming a lower one never lowers it. The same matrix applies to onramp and offramp.

### The ceilings are immutable

Each of those five numbers is _also_ fixed in the bytecode as a `MAX_*` constant:

| Constant                       | Value   |
| ------------------------------ | ------- |
| `MAX_TIER_CAP_LIVENESS_INDIA`  | `20e6`  |
| `MAX_TIER_CAP_LIVENESS_ABROAD` | `50e6`  |
| `MAX_TIER_CAP_KYC_INDIA`       | `100e6` |
| `MAX_TIER_CAP_KYC_ABROAD`      | `200e6` |
| `MAX_DAILY_TX_COUNT_LIMIT`     | `5`     |

`setTierCap(tier, region, cap)` and `setDailyTxCountLimit(count)` revert with `CapExceedsCeiling` above these, and so does the constructor. **The owner can tighten policy but never loosen it past what the bytecode commits to** — so the limits hold against a compromised _owner_ key, not just a compromised attestor key. That matters because a whitelisted integrator bypasses the protocol's own RP / daily / monthly / yearly volume limits and is trusted to enforce its own in `validateOrder` (see `IB2BGateway`).

Setting a cell to `0` disables that (tier, region) lane without touching anyone's attestation — the per-lane kill switch. `setDailyTxCountLimit(0)` is rejected: it used to mean "unlimited", which would have been a way around the ceiling.

### Region comes from the order's currency

`regionFor(currency)` returns India for `INR` and Abroad for everything else. This is a **payment-rail gate, not a nationality gate**: the user chooses the currency, so the real constraint is which fiat rail they can actually settle on. `validateOrder` receives the currency from the Diamond, so the region resolves at the authoritative gate, not just at the entrypoint. If a nationality gate is ever needed it belongs in the attestation, which would mean a new EIP-712 typehash and coordinated simple-kyc work.

### Blocking

`setUserBlocked(user, bool)` zeroes a wallet's effective limit in both directions. It is a **binary gate only** — limits themselves come solely from the KYC tier and the region ceiling, never from a per-user owner setting.

A block deliberately does **not** gate `userBridgeBackToSolana` or `userRescueStuckBridge`: those move only the user's own already-paid-for funds back out. A block stops new conversions; it never seizes or strands anything.

### Daily counts are placements, not settlements

The live Diamond does not call `onOrderCancel` — the selector is absent from every mainnet facet, and the hook exists only on the unmerged `feat/integrator-on-order-cancel` branch. Until that ships, a cancelled or expired order **keeps its slot**. This is the safe direction (a slot can never be freed early, so the cap can't be exceeded), but a user whose orders keep failing is locked out until the next UTC day — and 00:00 UTC is 05:30 IST, mid-morning in India. Worth surfacing in the UI at 5/day.

Attestation intake (`submitLivenessAttestation` / `submitKycAttestation`) is byte-compatible with `UsdcDirectCheckoutIntegrator` — same EIP-712 typehashes, `KycVerifier` / `LivenessVerifier` domains, and per-(tenant, human) single-use nullifiers.

## Custody flow

**Onramp.** The order is placed with `recipientAddr = address(this)`, so completion routes USDC to the integrator, which burns it. The user's proxy is only the authenticated caller — it never touches the onramp's USDC.

**Offramp.** The SELL is placed with `order.user` = the seller's own proxy. The Diamond pulls USDC from that proxy at `setSellOrderUpi`, and a cancel-while-PAID refunds straight back to it. The seller's funds never transit the integrator.

The integrator only ever custodies USDC in one narrow window: between an onramp's completion and its burn. That balance is tracked in `unbridgedTotal`, and `withdrawUsdc` is hard-bounded by it — **the owner cannot touch a buyer's in-flight funds**, only genuine surplus.

Unbridged onramps share that one pooled balance, so the invariant `usdc.balanceOf(integrator) >= unbridgedTotal` is what keeps `withdrawUsdc`, `retryBridge` and `userRescueStuckBridge` safe against each other. Two guards in `onOrderComplete` hold it:

- **`recipientAddr` must be the integrator.** The onramp pins it at placement; if a routing change ever sent the USDC elsewhere, reverting is correct — nothing arrived here, so nothing should be reserved here.
- **The session is re-pinned to the amount actually delivered** (emitting `OnrampAmountAdjusted`). Here a revert would be _wrong_: the USDC did arrive, and the gateway swallows integrator reverts, so it would be left with no session record — i.e. sweepable by the owner as "surplus". Sibling integrators (LotPot, Investabl) revert with `AmountMismatch` instead; they can, because they don't pool user funds.

## Solana recipients are token accounts, not wallets

`solanaRecipient` must be the user's USDC **associated token account (ATA)**, encoded as bytes32 — _not_ their wallet address — and it must already exist on Solana. Circle's docs: _"the `mintRecipient` should be a hex encoded USDC token account address. The token account must exist at the time `receiveMessage` is called on Solana or else this instruction will revert."_

A wallet address here produces a burn on Base whose mint can never be executed on Solana. The address is pinned at order time and cannot be changed afterwards by anyone, including the owner.

For the offramp direction, use `offrampMintRecipient(user)` — it returns the user's proxy already encoded as the bytes32 the Solana-side burn expects.

## Bridge failure is fail-closed, not fund-loss

The burn runs inside `onOrderComplete` through an external self-call under `try/catch`. The gateway also try/catches the callback, so a revert here would silently strand the delivered USDC with no session record. Instead the order stays `fulfilled` but `bridged == false`, its USDC reserved in `unbridgedTotal`, and recovery is available:

- **`retryBridge(orderId)`** — permissionless. The destination and amount were pinned at order time, so the caller can't redirect anything; they only pay gas. Reverts bubble so you can see why CCTP refused.
- **`userRescueStuckBridge(orderId)`** — buyer-only, and only after `BRIDGE_RESCUE_DELAY` (7 days). Pulls the USDC to the buyer's own wallet. This is never an owner power. It hands the buyer Base-side USDC rather than the Solana USDC they ordered — a deliberate trade against permanent loss, bounded by their tier cap and unreachable while CCTP is healthy. Note the bound is now up to $200 per order rather than $50 — this is the one path where USDC reaches a user's EOA, so it is the one place the `UserProxy` USDC-trap is deliberately relaxed.
- **`userBridgeBackToSolana(amount, ata)`** — returns bridged-in funds sitting on a proxy back to Solana instead of offramping them.

## Bridge configuration

| Setting                      | Default | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bridgeMinFinalityThreshold` | `2000`  | Standard Transfer — finalized, free, ~13–19 min from Base. `1000` = Fast Transfer (seconds, charges a fee).                                                                                                                                                                                                                                                                                                                                                                     |
| `bridgeMaxFeeBps`            | `0`     | `maxFee = 0` is valid while Circle's `minimumFee` is 0. Verified against the live fee schedule for **Base → Solana on mainnet** (2026-07-27): `0` at finality 2000, `1.3` bps at 1000 — so the shipped defaults work on mainnet, and Fast Transfer needs only `setBridgeMaxFeeBps(≥ 2)`. Bounded by `MAX_BRIDGE_MAX_FEE_BPS = 100` (1%), ~77× the live Fast fee — ample headroom while ruling out an owner routing an arbitrary share of every burn to the attestation service. |

Both are owner-settable, and a burn that fails on fee grounds lands in the retry path rather than losing funds.

## Token model, and the Base Sepolia caveat

`usdc` is simultaneously the token the Diamond settles in **and** the token CCTP burns. These coincide on Base mainnet, where the Diamond settles in Circle USDC.

**They do not coincide on Base Sepolia.** That Diamond settles in a mock token (`GoofyGoober`, `0x4095fE…`), and Circle's TokenMinter reports `burnLimitsPerMessage(GG) == 0` — it will not burn it. On Sepolia the order flow, KYC tiers, proxy auth, and full lifecycle are live and exercisable, but every bridge attempt fails closed into fulfilled-but-unbridged. The CCTP leg itself is covered by the unit tests (`MockTokenMessengerV2` reproduces Circle's exact require ladder, including the unsupported-token case). Deploy against a Diamond that settles in real USDC to bridge for real.

`scripts/local/deploy-showdown.ts` reports whether the configured token is CCTP-burnable before deploying.

## Registration

Register with **`usdcThroughIntegrator = false`**. The onramp pins `recipientAddr = address(this)`, so completion routes USDC to the integrator without needing the flag; the offramp SELL pulls from `order.user` (the seller's proxy) and never routes completion USDC back through the integrator.

## Reference

|                                         |                                              |
| --------------------------------------- | -------------------------------------------- |
| CCTP domain — Base                      | `6`                                          |
| CCTP domain — Solana                    | `5`                                          |
| TokenMessengerV2 (all EVM testnets)     | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| MessageTransmitterV2 (all EVM testnets) | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |
| Circle USDC, Base Sepolia               | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

Domain IDs are identical on mainnet and testnet.
