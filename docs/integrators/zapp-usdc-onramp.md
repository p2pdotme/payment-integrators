# Zapp Base-USDC onramp

`ZappUsdcOnrampIntegrator` places P2P B2B BUY orders and delivers native Base
USDC directly to the caller's Zapp smart account. It does not use NEAR 1Click,
Zcash routing, a pooled vault, or an internal balance ledger.

## Settlement invariant

For every order:

```text
order.user          = msg.sender
order.recipientAddr = msg.sender
session.user        = msg.sender
```

The contract exposes no arbitrary recipient parameter. Register it with
`usdcThroughIntegrator=false`, so the Diamond transfers completed BUY proceeds
straight to `recipientAddr`. Neither the integrator nor its `UserProxy` receives
the purchased USDC.

```text
Zapp smart account -> integrator -> canonical UserProxy -> P2P Diamond

P2P completion     -> native Base USDC -> same Zapp smart account
```

The per-user proxy is still required for the Diamond's CREATE2 authentication.
In this integration it is a call adapter, not a settlement vault. It requires no
ETH and should have a zero USDC balance before and after a BUY.

## Zapp wallet

The on-chain user is Zapp's deterministic ERC-4337 smart account, controlled by
the EVM owner key derived locally from the user's Zcash seed. The app submits a
sponsored UserOperation from that account. The account may be counterfactual
before its first operation; once it calls the integrator it is deployed, and it
is the direct USDC recipient.

The backend never receives or stores the Zcash seed, EVM private key, or smart-
account signing material.

## Placement authorization

Each BUY requires an EIP-712 `PurchaseAuthorization` signed by Zapp's backend:

```solidity
PurchaseAuthorization(
    address user,
    uint256 amount,
    bytes32 currency,
    bytes32 pubKeyHash,
    uint256 circleId,
    uint256 preferredPaymentChannelConfigId,
    uint256 fiatAmountLimit,
    uint256 deadline,
    bytes32 nonce
)
```

The authorization is an application/risk gate, not an identity attestation. It
lets the backend limit access to supported app versions, corridors, circles,
and payment methods and reject obvious abuse before gas is spent. The contract
then enforces:

- `authorization.user == msg.sender`;
- exact signature binding of every P2P placement parameter;
- a short deadline and single-use authorization ID;
- nonzero immutable per-transaction, daily-count, daily-volume, and lifetime-
  volume limits;
- a global emergency pause.

The owner can rotate a compromised authorization signer and pause new orders.
It cannot raise the immutable volume limits after whitelist review. In-flight
completion and cancellation callbacks continue while paused.

This contract contains no KYC or liveness verifier. That does not bypass P2P or
jurisdictional policy: production activation still requires the separate P2P
whitelist decision and any eligibility controls required for the approved
circles.

## Order lifecycle

1. Zapp resolves the user's Base smart-account address.
2. The app asks the backend for a purchase authorization.
3. The backend authenticates the app session, applies product/risk rules, writes
   an order intent, and signs the exact placement parameters.
4. The app submits a sponsored UserOperation calling `buyUsdc`.
5. The integrator deploys/reuses the canonical per-user `UserProxy`; the proxy
   calls `placeB2BOrder` with the smart account as both user and recipient.
6. The user follows P2P's fiat payment flow.
7. On completion, the Diamond transfers USDC directly to the smart account and
   invokes the integrator's best-effort completion callback.
8. The backend independently reconciles Diamond order state and the USDC
   `Transfer` event, then notifies the app.

Recommended backend state machine:

```text
REQUESTED -> AUTHORIZED -> USEROP_SUBMITTED -> P2P_PLACED
          -> AWAITING_FIAT -> P2P_COMPLETED -> BASE_USDC_CONFIRMED

P2P_PLACED | AWAITING_FIAT -> CANCELLED
```

Do not treat `onOrderComplete` as the sole source of truth. The Diamond wraps
integrator callbacks in `try/catch`; protocol settlement can succeed even if the
callback does not update the local session. Reconciliation must check the
Diamond and Base token transfer directly.

## Off-chain data

The database supports workflow, idempotency, risk controls, reconciliation, and
support. It does not decide who owns pooled funds. Base USDC balances remain the
asset ledger.

Suggested tables:

### `wallets`

- internal user/install ID;
- smart-account address and owner EOA address;
- chain ID and account-factory version;
- first-seen and last-verified timestamps.

### `onramp_intents`

- internal intent ID;
- user and smart-account address;
- requested USDC amount, fiat currency, and selected corridor;
- authorization ID, nonce, deadline, and signer key version;
- P2P order ID and placement transaction hash;
- current state and timestamps.

Use unique constraints on authorization ID, nonce, P2P order ID, and transaction
hash. Never sign two different payloads with the same nonce.

### `risk_decisions`

- intent ID and policy version;
- device/app signals and velocity counters;
- approved/rejected result and reason codes;
- approved caps and corridor.

Avoid retaining raw sensitive device or payment data when a derived risk signal
or external provider reference is sufficient.

### `chain_events`

- chain ID, block number/hash, transaction hash, and log index;
- event type, P2P order ID, wallet, token, and amount;
- confirmation and canonical/reorg status.

The unique key `(chain_id, tx_hash, log_index)` makes ingestion idempotent.

### `outbox`

- state change to publish;
- push/webhook payload reference;
- delivery attempts and terminal status.

An outbox prevents a committed order update from losing its corresponding push
notification or worker job.

## Required services

- API/auth service for app sessions and intent creation;
- isolated authorization signer backed by KMS/HSM or equivalent key custody;
- Base RPC access and a reorg-aware event indexer;
- P2P order-status reconciliation worker;
- ERC-4337 bundler and funded paymaster for sponsored UserOperations;
- durable job queue and transactional outbox worker;
- push notification service;
- multisig for owner actions, secret manager, monitoring, alerts, and an
  incident runbook.

The service does not require a 1Click API key, cross-chain quote worker, ZEC
address service, conversion relayer, hot USDC wallet, liquidity pool, or per-user
gas funding.

## Deployment and whitelisting

Deploy with `scripts/deploy-zapp-usdc-onramp.ts`. The production owner should be
a multisig and the authorization signer should be a separately isolated key.

After merge and source verification, request registration with:

```solidity
registerIntegrator(integrator, false, proxyImpl);
```

The whitelist request must state the immutable limits, expected `circleId`
values, supported currencies, signer operations, monitoring, and emergency
contact. Complete an end-to-end Base Sepolia order before requesting mainnet
activation.
