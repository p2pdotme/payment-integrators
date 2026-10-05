# UnifyVault B2B Direct USDC Integrator

## Overview

`UnifyVaultCheckoutIntegrator` is a direct B2B checkout and cashout integrator for the UnifyVault platform on Base, supporting bidirectional fiat-crypto flows:

- **BUY Flow**: INR/UPI → P2P.me → USDC → user's wallet (EOA)
- **SELL Flow**: USDC (user's wallet) → P2P.me → INR/UPI (user's bank account)

## Architectural Design

- **Registration Policy**: `usdcThroughIntegrator = false`.
- **Zero Custody**: The integrator never holds user funds or custody balances.
  - On BUY orders: `recipientAddr = user` (the user's wallet address). The P2P Diamond delivers purchased USDC straight to the user's EOA upon order settlement.
  - On SELL orders: The P2P Diamond pulls USDC from `order.user` (the user's wallet address) during `setSellOrderUpi`.
- **Deterministic Proxy Routing**: Orders are routed through per-user deterministic `UserProxy` clones via CREATE2.
- **Identity Gating**: Gated by P2P.me Simple KYC EIP-712 attestations (Liveness tier and KYC passport tier).
- **Sybil Resistance**: Single-use nullifiers per human tenant prevent multi-claiming.
- **Conformance Ratchet (#77)**: Conforms to all repo-wide invariants:
  - Immutable ceilings (`MAX_PER_TX_USDC = 2,000 USDC`, `MAX_DAILY_COUNT = 100`, `MAX_DAILY_VOLUME = 10,000 USDC`).
  - Transient storage (EIP-1153) reentrancy protection on all value-moving entrypoints.
  - Attestor setters reject `address(0)`.
  - Repeat cancellation tolerance (`onOrderCancel` idempotency).

## Interface

### User Entrypoints

- `userBuyUsdc(uint256 amount, bytes32 currency, uint256 circleId, string pubKey, uint256 preferredPaymentChannelConfigId, uint256 fiatAmountLimit)`
- `userPlaceSellOrder(uint256 amountUsdc, bytes32 currency, string userPubKey, uint256 circleId, uint256 preferredPaymentChannelConfigId, uint256 fiatAmountLimit)`
- `userSellUsdc(...)` (ergonomic alias)

### Attestation Entrypoints

- `submitLivenessAttestation(bytes32 nullifier, uint256 limit, uint256 expiry, bytes signature)`
- `submitKycAttestation(bytes32 nullifier, uint256 limit, uint256 expiry, bytes signature)`

### Diamond Callbacks

- `validateOrder(address user, uint256 amount, bytes32 currency) returns (bool)`
- `onOrderComplete(uint256 orderId, address user, uint256 amount, address recipientAddr)`
- `onOrderCancel(uint256 orderId)`
