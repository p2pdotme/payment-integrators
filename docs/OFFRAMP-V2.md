# Offramp v2 — user-driven, per-user-proxy, pooled partial cash-outs

> Status: implemented on `feat/offramp-v2` (PR #14), deployed + E2E-verified on
> Base Sepolia. This doc is the authoritative spec for the v2 integrator ABI
> that the relayer (`tradestars-relayer`) and widget (`p2pdotme-checkout-widget`)
> build against.

## The core idea

Today the TradeStars offramp places every SELL through a **shared system proxy**
driven end-to-end by the relayer. v2 flips it: the relayer's **only** on-chain
job is **allocation** — it moves vault USDC into the **user's own per-user
proxy** (the same proxy keyed on their Base EOA that onramp uses), **pooling** it
with any prior allocation. The **user** then draws **any principal up to their
pooled proxy balance, in as many parts as they like** (one in-flight at a time),
driving place-SELL → deliver-UPI → retry from the widget (gaslessly, via their
paymaster). The proxy's USDC balance **is** the cashable balance.

```
            OLD (relayer-driven, system proxy)            v2 (user-driven, per-user proxy, pooled)
 burn ─▶ relayer: placeSellOrderForBurn ┐            relayer: allocateOfframp(userEOA, amt, burnTx)
         poll / encrypt / deliverUpi    │ system       └ vault.releaseForOfframp → USDC ▶ USER proxy (pooled)
         poll / reconcile               │ proxy       ───────────────────────────────────────────
         (manual replay on failure)     ┘             USER (gasless), repeatable per part:
                                                       userStartOfframp(principal ≤ balance)
                                                       ↳ poll ACCEPTED → encrypt UPI client-side
                                                       ↳ userDeliverOfframpUpi(orderId, encUpi)
                                                       ↳ PAID → COMPLETED ✓ / CANCELLED → retry/redraw
```

## Why this fixes all three problems (one root cause)

| Symptom today | Root cause | v2 fix |
|---|---|---|
| History shows only onramp | SELL `order.user` = one shared system proxy; history is keyed on the user's address | SELL `order.user` = the user's **per-user proxy** (deterministic from their EOA); widget merges EOA + derived-proxy `getOrders` |
| Owner manually retriggers failed offramps | relayer workflow owns the whole lifecycle; failures need `replay:p2p-withdrawal` | cancel refunds land in the **user's proxy**; the user re-places/redraws from the widget — no owner/relayer |
| One relayer driving everything | relayer is the sequential driver and holds payout-encryption keys | relayer only calls `allocateOfframp`; the user signs place/deliver/retry; payout is encrypted **client-side** |

## How it stays legal on the live Base Sepolia Diamond

Verified against `contracts-v4` + the live Diamond `0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9`:

- `placeB2BSellOrder(user, …)` records **`order.user` = the passed `user` param** (not `msg.sender`).
- The B2B CREATE2 auth requires `msg.sender` == `predictClone(proxyImpl, packed(proxy.owner(), integrator), salt = uint160(proxy.owner()), deployer = integrator)`. It keys on **`proxy.owner()`**, not on the passed `user`.
- So the integrator calls `placeB2BSellOrder(user = userProxy, …)` **through `userProxy`** (whose `owner()` = the user EOA). Auth passes (keyed on the EOA), and `order.user = userProxy` → the Diamond pulls/refunds USDC there and history is keyed per-user.
- **SELL has no `onOrderComplete` callback** (it fires for BUY only). v2 tracks terminal state via the permissionless `syncOfframp` reading `getOrdersById`.
- SELL settlement pulls `actualUsdtAmount = principal + smallOrderFixedFee` (fee only if `principal <= getSmallOrderThreshold(currency)`, inclusive — mirrors `libOrderProcessorFacet.isOrderSmall`) from `order.user` at `setSellOrderUpi`. v2 **pre-checks** the proxy holds `principal + fee` before placing (see fee policy below), so this pull is never short. A cancelled-while-PAID SELL refunds `principal + fee` to `order.user` (= the proxy).
- Live-Diamond getter note: `getSmallOrderFixedFee` (unified) **reverts** on this deployment; `getSmallOrderFixedFeeSell` works. `_sellFee` tries the per-type SELL getter first and falls back to the unified one, so a single build works pre/post-V22.
- No Aave on Base Sepolia → the vault supplies a `MockAavePool` + mock aUSDC (as v1 already does).

## v2 integrator ABI (`TradeStarsCheckoutIntegratorV2`)

```solidity
// Minimal view surface the integrator reads on the Diamond to price the SELL fee.
interface IDiamondSmallOrderFees {
    function getSmallOrderThreshold(bytes32 currency) external view returns (uint256);
    function getSmallOrderFixedFeeSell(bytes32 currency) external view returns (uint256);
    function getSmallOrderFixedFee(bytes32 currency) external view returns (uint256); // fallback
}

// ── relayer-only: the ONLY relayer write in the offramp path ──
// Pulls `amount` from the vault (releaseForOfframp) and transfers it to the
// user's per-user proxy, POOLING with any prior allocation. Dedupes on
// solanaBurnTx. Bounded by maxUsdcPerOfframp (per-allocation cap).
function allocateOfframp(
    address user,            // Base EOA (= proxy owner); allocation target
    uint256 amount,          // burned principal (USDC, 6dp)
    bytes32 solanaBurnTx,    // dedupe key
    bytes32 solanaUserPubkey
) external returns (uint256 allocationId);                 // onlyOfframpRelayer

// ── user-driven (msg.sender owns the proxy the draw is placed through) ──
// Draws `principal` from the caller's pooled proxy balance and places a SELL.
// Callable repeatedly (partial / multi-part), ONE in-flight order at a time —
// the prior order must be terminal (COMPLETED or CANCELLED) before the next.
// Reverts OfframpInsufficientBalance unless proxyBalance >= principal + fee.
function userStartOfframp(
    uint256 principal,                        // any amount ≤ pooled proxy balance
    bytes32 currency,
    uint256 fiatAmount,                       // SELL slippage floor; 0 = none
    uint256 circleId,                         // merchant circle (Base Sepolia: 1)
    uint256 preferredPaymentChannelConfigId,
    string calldata userPubKey                // user's relay pubkey (widget SDK identity)
) external returns (uint256 orderId);

// Encrypted-UPI delivery (drives ACCEPTED → PAID). Diamond pulls actualUsdtAmount
// (= principal + fee) from the proxy, which userStartOfframp already guaranteed it
// holds. NO integrator-float subsidy; reverts if somehow short.
function userDeliverOfframpUpi(uint256 orderId, string calldata encUpi) external;

// ── permissionless: record terminal status + free the user's in-flight slot ──
function syncOfframp(uint256 orderId) external;

// ── owner break-glass: return a user's abandoned proxy balance to the vault ──
function reclaimAbandonedOfframp(address user) external;   // onlyOwner, after timeout, no in-flight

// ── views (widget reads these) ──
function availableOfframp(address user) external view returns (uint256);  // = proxy USDC balance (the pool)
function getUserAllocations(address user) external view returns (uint256[] memory); // audit/history
function getAllocation(uint256 allocationId) external view returns (OfframpAllocation memory);
function proxyAddress(address user) external view returns (address);       // deterministic per-user proxy
function allocations(uint256) external view returns (/* OfframpAllocation */);
function burnToAllocation(bytes32) external view returns (uint256);
function orderToUser(uint256) external view returns (address);             // orderId → proxy owner
function userActiveOrder(address) external view returns (uint256);         // current in-flight draw (0 = none)
function lastAllocatedAt(address) external view returns (uint64);          // drives the reclaim timeout

// ── events ──
event OfframpAllocated(uint256 indexed allocationId, address indexed user, address proxy, uint256 amount, bytes32 indexed solanaBurnTx, bytes32 solanaUserPubkey);
event OfframpOrderPlaced(uint256 indexed orderId, address indexed user, uint256 principal);  // a draw
event OfframpUpiDelivered(uint256 indexed orderId);
event OfframpSettled(uint256 indexed orderId, address indexed user);       // COMPLETED — fiat sent
event OfframpCancelled(uint256 indexed orderId, address indexed user);     // USDC back in proxy; retry/redraw
event OfframpReclaimed(address indexed user, uint256 amount);
```

```solidity
// An allocation is a FUNDING record (dedup + audit) — withdrawals are NOT tied
// to a single allocation; they draw from the pooled proxy balance.
struct OfframpAllocation {
    address user;            // Base EOA = proxy owner
    uint256 amount;          // USDC moved into the proxy (burned principal)
    bytes32 solanaBurnTx;
    bytes32 solanaUserPubkey;
    uint64  allocatedAt;
}
```

The v2 integrator keeps the v1 BUY surface unchanged (`userPlaceOrder`,
`onOrderComplete`, `onOrderCancel`, limits/RP, proxy helpers). `validateOrder`
gains a bypass: while the integrator is mid-`userStartOfframp` (a transient
`_offrampPlacing` flag), it returns `true` — the relayer already bounded the
pooled balance via `maxUsdcPerOfframp` + the vault quota, so per-user *buy*
limits don't apply to an offramp SELL. The v1 relayer-driven offramp
(`placeSellOrderForBurn`/relayer `deliverOfframpUpi`/`reconcile`) is **removed**
in v2; the v1 integrator stays deployed for any in-flight legacy offramps.

## Invariants & nuances

- **USDC trap intact.** Pooled USDC sits in the user's proxy and can leave only
  via (a) the Diamond pulling it for a SELL (→ merchant → fiat to the user
  off-chain) or (b) `transferERC20ToIntegrator` → vault on reclaim. It can never
  reach the user's EOA. `UserProxy.sol` is **not modified** (its bytecode is
  pinned into the Diamond's CREATE2 auth).
- **Pooled balance / partial draws.** `availableOfframp(user)` = the proxy's USDC
  balance. The user draws any `principal` ≤ that balance, in as many parts as
  they like; each completed draw debits `principal + fee` from the proxy and the
  balance ticks down. One in-flight draw at a time.
- **Fee policy — funded from the balance, never subsidised.** The small-order fee
  (`principal <= getSmallOrderThreshold(currency)` ⇒ `getSmallOrderFixedFeeSell`,
  else 0) is paid out of the user's pooled balance. `userStartOfframp` reverts
  **`OfframpInsufficientBalance`** unless `proxyBalance >= principal + fee`, so a
  draw that would leave the fee uncovered is rejected **up front** (no late
  `setSellOrderUpi` failure, no integrator float). This removes the v1
  unfunded-fee failure mode (`OfframpInsufficientPool`). Consequence: you cannot
  cash out the *full* balance when it is at/below the threshold — withdraw
  `balance − fee` (the widget's "insufficient balance" guard mirrors the
  contract). Above-threshold draws have fee 0.
- **Retry / redraw.** Cancel refunds (`principal + fee`) to the proxy;
  `userStartOfframp` is callable again once the prior order is terminal
  (COMPLETED or CANCELLED) — `syncOfframp` also frees the slot but isn't required.
- **Abandonment.** `reclaimAbandonedOfframp(user)` (owner-only, after
  `offrampAbandonTimeout` from the user's last allocation, and only when no draw
  is in-flight) returns the proxy's remaining USDC to the vault.
- **Fee-not-ready guard** (the 2026-05-07 bug) is preserved (`userDeliverOfframpUpi`
  reverts `OfframpFeeNotReady` if `actualUsdtAmount` reads 0).
- **Burn-backed note.** Because the pool is the raw proxy balance, USDC sent
  *directly* to a proxy would also be cashable (i.e. not strictly tied to a
  Solana burn). Fine for the relayer-funded testnet flow; for stricter
  production accounting add a thin per-user "allocated" ledger gating draws.

## Widget changes (`p2pdotme-checkout-widget`)

The `<Cashout>` machine is callback-shaped (SDK unchanged):
1. Balance affordance = the pool (`availableOfframp(user)` via a host
   `fetchAvailableOfframp` callback/prop), not `balanceOf`. No USDC approve in
   the TradeStars `placeCashout`.
2. `placeCashout` → `userStartOfframp(principal = entered amount, …)` (any amount
   ≤ balance); `deliverUpi` → `userDeliverOfframpUpi`; `reconcile` → `syncOfframp`.
3. Fee-aware amount: the widget reads the threshold + `getSmallOrderFixedFeeSell`
   and enforces `principal + fee <= balance` (shows "insufficient balance"
   otherwise) — matching the contract guard. The order id is parsed from the
   `OfframpOrderPlaced(orderId, user, principal)` event (orderId is topic[0]).
4. Retry-from-cancelled + multi-part: re-enter placement from `cancelled`; start
   the next part once the prior order is terminal.
5. `PaymentHistory`: query a second `getOrders({ userAddress: proxyAddress })`
   and merge/dedupe with the EOA's orders.

## Relayer changes (`tradestars-relayer`)

`processP2PWithdrawal` collapses to one step: `allocateOfframp(baseAddress,
amount, burnTx, solPubkey)` — unchanged by the pooled model (allocation is
still a single funding write). Drop merchant/terminal polling, payout
decrypt/encrypt, `deliverOfframpUpi`, `reconcile`. Shrink `WithdrawalRecord`
(add `baseAddress` + `baseAllocationId/Tx`; drop the place/deliver/reconcile tx
fields + `payoutAddressEncrypted`); status → `{ allocating, allocated, failed }`.
Drop the `P2P_OFFRAMP_RELAY_*` + `P2P_WITHDRAWAL_ENCRYPTION_KEY` secrets from the
withdrawal path. Deposit/onramp flow untouched. **Gap to close in the product
app:** the withdrawal record must carry the user's **Base address**
(`baseAddress`) so the relayer can allocate to the right proxy.

## Base Sepolia coordinates (E2E)

```
Diamond    = 0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9
USDC (GG)  = 0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d   (6dp; deployer-minted)
chainId    = 84532   RPC = https://sepolia.base.org
superAdmin = relayer = deployer = 0x9DE9772AfCdf3AFa03CC689fE7AFA5b631088aB9
subgraph   = https://api.studio.thegraph.com/query/1745491/event-indexer/version/latest
sell circle = 1 (INR/BRL/IDR)   merchant: p2p-checkout/demo-merchant-bot (auto-accept + auto-complete)
Aave       = none on Sepolia → deploy MockAavePool + mock aUSDC with the vault

current pooled-partial deployment:
  integrator = 0xF1d04b7a0Ae0030BcCF8859238f921862e2eB6e3
  proxyImpl  = 0x1C3386457b6a15ee273160ed772B14DE0285d4A1
  vault      = 0x59B90CCda791aCd14d2cc1C3B5644d8e9B0A5Af1
  INR pricing: sellPrice 89, smallOrderThreshold 10 USDC, sell fee 0.125 USDC
```

E2E: deploy v2 (vault+integrator+mocks) → `registerIntegrator(v2, true, proxyImpl)`
→ fund vault (`deposit`/owner `fund`) → `allocateOfframp` (relayer) →
`userStartOfframp(principal)` (user) → demo-merchant-bot accepts →
`userDeliverOfframpUpi` (dummy ciphertext; the bot doesn't decrypt) → bot
completes → `syncOfframp` → assert COMPLETED. Covered by the test suite
(`test/tradestars-v2-offramp.test.ts`, 44 cases): multi-part draws (e.g.
30/40/30), fee-from-balance, `OfframpInsufficientBalance`, cancel→redraw,
per-user reclaim, plus admin/BUY/guard branch coverage (contract 100% line /
91% branch).
