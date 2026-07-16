# Investabl Challenge

`InvestablChallengeCheckoutIntegrator` lets an [Investabl](https://investabl.ai)
user pay local fiat (INR via UPI) to buy a prop-trading **challenge**.

## Product

The "product" is a prop-firm challenge account (a simulated-balance evaluation).
It is granted **off-chain** in Investabl's backend and is non-transferable — the
user never receives spendable USDC. This is the low-fraud goods/service model, so
orders need no reputation or ZK-KYC.

## External protocols + addresses

No upstream protocol beyond the P2P Diamond. Investabl's backend consumes the
`ChallengePurchased` event to grant the challenge.

| | Base Mainnet | Base Sepolia |
|---|---|---|
| P2P Diamond | `0x4cad6eC90e65baBec9335cAd728DDC610c316368` | `0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d` |
| Integrator | `<TBD after deploy>` | `<TBD after deploy>` |

## Order lifecycle (user POV)

1. User taps **"Pay with UPI"** in Investabl checkout. Their embedded (Privy)
   wallet calls `buyChallenge(amount, "INR", circleId, pubKey, …, sessionRef)`.
   The call places a B2B BUY order through the user's `UserProxy` with
   `recipientAddr = the integrator`.
2. User pays INR off-chain (UPI) to the matched liquidity provider.
3. On settlement the Diamond delivers the purchased USDC to the integrator and
   calls `onOrderComplete`, which emits `ChallengePurchased(orderId, user,
   amount, sessionRef)`.
4. Investabl's backend watches that event and grants the challenge, mapping
   `sessionRef` back to the checkout session.

## Custody / fund flow

`usdcThroughIntegrator = true`, `recipientAddr = address(this)`. Purchased USDC
accrues on the integrator and leaves **only** via the owner's `sweepUsdc(amount)`
to `treasury` (default: owner). It is then bridged to Investabl's Arbitrum
treasury out of band (CCTP). USDC is never routed to a user EOA.

## Limits / RP

Overrides the RP model with a simple **absolute cap** (see
[LIMITS-AND-RP.md](../LIMITS-AND-RP.md) §"Overriding limits"):

- `perTxUsdcCap` — absolute per-tx USDC ceiling. Default **50 USDC** (P2P's
  no-KYC ceiling). The $15 challenge sits well under it, so any brand-new wallet
  can buy immediately with no KYC.
- `dailyTxCountLimit` — max challenge orders per user per UTC day (default 10),
  reserved in `validateOrder`, released in `onOrderCancel`.

No reputation points, no per-currency rate, no ZK-KYC.

## Operational notes

- Sweep proceeds periodically with `sweepUsdc`; point `treasury` at a Base
  address you control (`setTreasury`).
- `perTxUsdcCap` / `dailyTxCountLimit` are owner-tunable; keep the cap ≤ 50 USDC
  to remain in the no-KYC lane.
- The Diamond callback is best-effort (try/catch). `onOrderComplete` only emits
  the grant event and finalizes bookkeeping — it makes no external calls, so it
  cannot strand a completion.

## Maintainer contact

dev@p2p.me · Investabl: engineering@investabl.ai
