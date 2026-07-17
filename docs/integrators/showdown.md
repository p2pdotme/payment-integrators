# Showdown integrator

A two-way fiat ↔ USDC ramp for [Showdown](https://showdown.gg) whose user-facing asset lives on **Solana**, bridged with Circle's [Cross-Chain Transfer Protocol V2](https://www.circle.com/cross-chain-transfer-protocol).

## What it does

- **Onramp (fiat → USDC on Solana).** The user pays local fiat on the P2P network. The Diamond delivers the purchased USDC to the integrator, which immediately burns it via CCTP and authorizes an equivalent mint to the user's Solana USDC account. The final product the user holds is native USDC on Solana — no wrapped asset, no third-party bridge.
- **Offramp (USDC on Solana → fiat).** The user burns USDC on Solana with CCTP, naming their Base-side `UserProxy` as the `mintRecipient`. Once it lands there, they place a SELL on the Diamond funded from that proxy balance and receive fiat.

Both directions are gated by tiered simple-kyc attestations, because both convert between fiat and USDC the user actually controls.

## KYC tiers

| Tier | Attestation | Per-tx cap |
| --- | --- | --- |
| 0 | none | blocked entirely |
| 1 | liveness | **$20** (`tierCap[1]`) |
| 2 | passport + liveness | **$50** (`tierCap[2]`) |

The effective cap is `min(attested limit, tierCap[tier])`. The simple-kyc service signs a dollar limit into the attestation, and the contract clamps it to its own per-tier ceiling — so the $20/$50 tiers hold **even if an attestor key is compromised**, and the caps are auditable on-chain rather than living in service config. Tiers stack monotonically: claiming a higher tier raises the cap, claiming a lower one never lowers it. The same cap applies to onramp and offramp.

Attestation intake (`submitLivenessAttestation` / `submitKycAttestation`) is byte-compatible with `UsdcDirectCheckoutIntegrator` — same EIP-712 typehashes, `KycVerifier` / `LivenessVerifier` domains, and per-(tenant, human) single-use nullifiers.

## Custody flow

**Onramp.** The order is placed with `recipientAddr = address(this)`, so completion routes USDC to the integrator, which burns it. The user's proxy is only the authenticated caller — it never touches the onramp's USDC.

**Offramp.** The SELL is placed with `order.user` = the seller's own proxy. The Diamond pulls USDC from that proxy at `setSellOrderUpi`, and a cancel-while-PAID refunds straight back to it. The seller's funds never transit the integrator.

The integrator only ever custodies USDC in one narrow window: between an onramp's completion and its burn. That balance is tracked in `unbridgedTotal`, and `withdrawUsdc` is hard-bounded by it — **the owner cannot touch a buyer's in-flight funds**, only genuine surplus.

## Solana recipients are token accounts, not wallets

`solanaRecipient` must be the user's USDC **associated token account (ATA)**, encoded as bytes32 — *not* their wallet address — and it must already exist on Solana. Circle's docs: *"the `mintRecipient` should be a hex encoded USDC token account address. The token account must exist at the time `receiveMessage` is called on Solana or else this instruction will revert."*

A wallet address here produces a burn on Base whose mint can never be executed on Solana. The address is pinned at order time and cannot be changed afterwards by anyone, including the owner.

For the offramp direction, use `offrampMintRecipient(user)` — it returns the user's proxy already encoded as the bytes32 the Solana-side burn expects.

## Bridge failure is fail-closed, not fund-loss

The burn runs inside `onOrderComplete` through an external self-call under `try/catch`. The gateway also try/catches the callback, so a revert here would silently strand the delivered USDC with no session record. Instead the order stays `fulfilled` but `bridged == false`, its USDC reserved in `unbridgedTotal`, and recovery is available:

- **`retryBridge(orderId)`** — permissionless. The destination and amount were pinned at order time, so the caller can't redirect anything; they only pay gas. Reverts bubble so you can see why CCTP refused.
- **`userRescueStuckBridge(orderId)`** — buyer-only, and only after `BRIDGE_RESCUE_DELAY` (7 days). Pulls the USDC to the buyer's own wallet. This is never an owner power. It hands the buyer Base-side USDC rather than the Solana USDC they ordered — a deliberate trade against permanent loss, bounded by their tier cap and unreachable while CCTP is healthy.
- **`userBridgeBackToSolana(amount, ata)`** — returns bridged-in funds sitting on a proxy back to Solana instead of offramping them.

## Bridge configuration

| Setting | Default | Notes |
| --- | --- | --- |
| `bridgeMinFinalityThreshold` | `2000` | Standard Transfer — finalized, free, ~13–19 min from Base. `1000` = Fast Transfer (seconds, charges a fee). |
| `bridgeMaxFeeBps` | `0` | `maxFee = 0` is valid while the messenger's `minFee` is 0, which is the case on Base Sepolia today. Raise it if Circle starts enforcing a minimum, or when using Fast Transfers. |

Both are owner-settable, and a burn that fails on fee grounds lands in the retry path rather than losing funds.

## Token model, and the Base Sepolia caveat

`usdc` is simultaneously the token the Diamond settles in **and** the token CCTP burns. These coincide on Base mainnet, where the Diamond settles in Circle USDC.

**They do not coincide on Base Sepolia.** That Diamond settles in a mock token (`GoofyGoober`, `0x4095fE…`), and Circle's TokenMinter reports `burnLimitsPerMessage(GG) == 0` — it will not burn it. On Sepolia the order flow, KYC tiers, proxy auth, and full lifecycle are live and exercisable, but every bridge attempt fails closed into fulfilled-but-unbridged. The CCTP leg itself is covered by the unit tests (`MockTokenMessengerV2` reproduces Circle's exact require ladder, including the unsupported-token case). Deploy against a Diamond that settles in real USDC to bridge for real.

`scripts/local/deploy-showdown.ts` reports whether the configured token is CCTP-burnable before deploying.

## Registration

Register with **`usdcThroughIntegrator = false`**. The onramp pins `recipientAddr = address(this)`, so completion routes USDC to the integrator without needing the flag; the offramp SELL pulls from `order.user` (the seller's proxy) and never routes completion USDC back through the integrator.

## Reference

| | |
| --- | --- |
| CCTP domain — Base | `6` |
| CCTP domain — Solana | `5` |
| TokenMessengerV2 (all EVM testnets) | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| MessageTransmitterV2 (all EVM testnets) | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |
| Circle USDC, Base Sepolia | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

Domain IDs are identical on mainnet and testnet.
