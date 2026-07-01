# FundingAlphaXIntegrator

P2P integrator for **FundingAlphaX**'s "Pay with UPI" challenge-purchase flow.
A buyer pays local fiat (UPI) through P2P; the protocol settles USDC on Base;
this integrator forwards that USDC to a per-order **NowPayments** deposit
address. NowPayments converts it to USDT-BSC and fires FundingAlphaX's existing
webhook, which activates the trading challenge and pays the affiliate commission
— off-chain, unchanged.

## What product does it serve?

FundingAlphaX is a proprietary-trading firm. Customers buy a **trading challenge**
(an evaluation account). UPI is the dominant payment rail for the firm's India
audience, but those buyers are **walletless** (no Base wallet). This integrator
lets them pay fiat via P2P and have the settled USDC routed into FundingAlphaX's
existing crypto-payment pipeline without the buyer ever touching a wallet.

## External dependencies

| Dependency | Role | Base mainnet | Base Sepolia (testing) |
|---|---|---|---|
| **NowPayments** | Off-chain custodial off-ramp. Per-order USDC-on-Base deposit address; converts USDC→USDT-BSC and fires FundingAlphaX's webhook. | off-chain API (no on-chain contract) | off-chain API |
| USDC | Settlement token | `0x833589fCD6EDb6E08f4c7C32D4f71b54bdA02913` | P2P testing token (e.g. `0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d`) |

NowPayments is an **off-chain** dependency — there is no third-party on-chain
contract in the path, so no upstream-protocol mock is needed beyond the repo's
`MockDiamond` / `MockUSDC`. The integrator's only on-chain counterparties are the
P2P Diamond and the user's `UserProxy`.

## Order lifecycle (from the user's POV)

1. The buyer picks "Pay with UPI" in the FundingAlphaX app and is shown a fiat amount.
2. **Off-chain:** the FundingAlphaX backend creates a NowPayments USDC-on-Base
   invoice → a per-order deposit address + exact USDC amount.
3. **On-chain:** the backend (`operator`) calls `placeChallengeOrder(user, amount,
   nowpaymentsRecipient, currency, circleId, pubKey)`. The integrator places a B2B
   BUY order on the Diamond via the buyer's `UserProxy`, with `recipientAddr = the
   proxy`. (`user` is a per-buyer address the backend manages; the buyer has no wallet.)
4. The buyer completes the UPI fiat payment through P2P's checkout (off-chain).
5. P2P settles USDC to the proxy and the Diamond calls `onOrderComplete`. The
   integrator pulls the USDC off the proxy and `safeTransfer`s the realized amount
   to the NowPayments deposit address.
6. NowPayments converts USDC→USDT-BSC and fires FundingAlphaX's webhook → the
   challenge activates and the affiliate commission pays out (all pre-existing).

## Non-standard custody flow (please note for review)

Two things differ from `ExampleIntegrator` / `LotPotCheckoutIntegratorV2`:

1. **Operator-driven placement.** `placeChallengeOrder` is `onlyOperator`, not an
   end-user-driven `userPlaceOrder`. FundingAlphaX buyers are walletless, so the
   trusted backend hot key places orders on their behalf. The operator can **only
   place capped orders** — it cannot move funds or change admin settings (those are
   `onlyOwner`, owner = a multisig + timelock).
2. **Settled USDC is forwarded OUT** to an external, **operator-pinned** NowPayments
   deposit address (an off-chain custodial off-ramp), rather than being spent on an
   on-chain product or trapped on the proxy. This is the deliberate difference from
   LotPot (which traps proxy USDC to close a fiat→USDC fraud-bypass surface).

   Mitigations: the recipient is set by the trusted operator (never the buyer), so
   funds can't be redirected by a user; a hard **per-tx cap** plus **per-user
   daily-count** bound blast radius; the forward is immediate (no pooling); and the
   integrator is immutable (no upgradeability). NowPayments is a regulated payment
   processor, not an arbitrary EOA.

   **Open question for maintainers:** is forwarding settled USDC to a custodial
   off-ramp deposit address acceptable under the protocol's anti-fraud-bypass
   posture, and should this integrator be registered with `usdcThroughIntegrator =
   false` (we set `recipientAddr = proxy`, like LotPot, then pull in
   `onOrderComplete`)?

## Limits / RP behavior

Custom limit shape (not RP-based):

- **Per-tx cap** (`maxPerTxUsdc`, 6-dec) — enforced both in `placeChallengeOrder`
  and in `validateOrder`. Owner-tunable via `setMaxPerTxUsdc`.
- **Per-user daily count** (`maxDailyCountPerUser`) — consumed in `validateOrder`
  (gated `onlyDiamond` so it can't be griefed) and released in `onOrderCancel`,
  keyed on the placement-day snapshot. Owner-tunable via `setMaxDailyCountPerUser`.

Note: because buyers are walletless, `user` is a per-buyer address the backend
manages; the daily-count is therefore per managed identity. RP-based per-currency
limits are not used — the absolute per-tx cap is the primary ceiling.

## Operational notes

- **Roles:** `owner` (multisig + timelock — custody/admin), `operator` (backend hot
  key — placement only, capped). `setOperator` rotates the hot key.
- **Pausable:** `pause()` blocks new placements and forces `validateOrder` → false.
- **Recovery:** `recoverStuckOrder(orderId)` re-pulls and forwards if a completion
  ever reverted and left USDC on the proxy; `rescueERC20` sweeps stray tokens. Both
  `onlyOwner`.
- **Whitelisting:** deploy → verify on Basescan → transferOwnership to the multisig
  → file a Whitelist request issue with the integrator + `proxyImpl` addresses.

## Maintainer / contact

FundingAlphaX team — see the linked proposal issue for the incident-response contact.
