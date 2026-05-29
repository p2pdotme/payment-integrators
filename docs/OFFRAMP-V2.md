# Offramp v2 — user-driven, per-user-proxy, relayer-as-allocator

> Status: implementation in progress on `feat/offramp-v2`. This doc is the
> authoritative spec for the v2 integrator ABI that the relayer
> (`tradestars-relayer`) and widget (`p2pdotme-checkout-widget`) build against.

## The core idea

Today the TradeStars offramp places every SELL through a **shared system proxy**
driven end-to-end by the relayer. v2 flips it: the relayer's **only** on-chain
job is a one-time **allocation** that moves vault USDC into the **user's own
per-user proxy** (the same proxy keyed on their Base EOA that onramp uses), and
the **user** drives place-SELL → deliver-UPI → retry from the widget (gaslessly,
via their paymaster).

```
            OLD (relayer-driven, system proxy)            v2 (user-driven, per-user proxy)
 burn ─▶ relayer: placeSellOrderForBurn ┐            relayer: allocateOfframp(userEOA, amt, burnTx)
         poll / encrypt / deliverUpi    │ system       └ vault.releaseForOfframp → USDC ▶ USER proxy
         poll / reconcile               │ proxy       ───────────────────────────────────────────
         (manual replay on failure)     ┘             USER (gasless): userStartOfframp(allocId)
                                                       ↳ poll ACCEPTED → encrypt UPI client-side
                                                       ↳ userDeliverOfframpUpi(orderId, encUpi)
                                                       ↳ PAID → COMPLETED ✓ / CANCELLED → retry
```

## Why this fixes all three problems (one root cause)

| Symptom today | Root cause | v2 fix |
|---|---|---|
| History shows only onramp | SELL `order.user` = one shared system proxy; history is keyed on the user's address | SELL `order.user` = the user's **per-user proxy** (deterministic from their EOA); widget merges EOA + derived-proxy `getOrders` |
| Owner manually retriggers failed offramps | relayer workflow owns the whole lifecycle; failures need `replay:p2p-withdrawal` | cancel refunds land in the **user's proxy**; the user re-places from the widget — no owner/relayer |
| One relayer driving everything | relayer is the sequential driver and holds payout-encryption keys | relayer only calls `allocateOfframp`; the user signs place/deliver/retry; payout is encrypted **client-side** |

## How it stays legal on the live Base Sepolia Diamond

Verified against `contracts-v4` + the live Diamond `0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9`:

- `placeB2BSellOrder(user, …)` records **`order.user` = the passed `user` param** (not `msg.sender`).
- The B2B CREATE2 auth requires `msg.sender` == `predictClone(proxyImpl, packed(proxy.owner(), integrator), salt = uint160(proxy.owner()), deployer = integrator)`. It keys on **`proxy.owner()`**, not on the passed `user`.
- So the integrator calls `placeB2BSellOrder(user = userProxy, …)` **through `userProxy`** (whose `owner()` = the user EOA). Auth passes (keyed on the EOA), and `order.user = userProxy` → the Diamond pulls/refunds USDC there and history is keyed per-user.
- **SELL has no `onOrderComplete` callback** (it fires for BUY only). v2 tracks terminal state via the permissionless `syncOfframp` reading `getOrdersById`.
- SELL settlement pulls `actualUsdtAmount = amount + smallOrderFixedFee` (fee only if `amount <= getSmallOrderThreshold(currency)`) from `order.user` at `setSellOrderUpi`; a failed/short transfer **auto-cancels** (does not revert). A cancelled-while-PAID SELL refunds `amount + fee` to `order.user` (= the proxy).
- No Aave on Base Sepolia → the vault supplies a `MockAavePool` + mock aUSDC (as v1 already does).

## Locked v2 integrator ABI (`TradeStarsCheckoutIntegratorV2`)

```solidity
// ── relayer-only: the ONLY relayer write in the offramp path ──
// Pulls `amount` from the vault (releaseForOfframp) and transfers it to the
// user's per-user proxy. Dedupes on solanaBurnTx. Bounded by maxUsdcPerOfframp.
function allocateOfframp(
    address user,            // Base EOA (= proxy owner); allocation target
    uint256 amount,          // burned principal (USDC, 6dp)
    bytes32 solanaBurnTx,    // dedupe key
    bytes32 solanaUserPubkey
) external returns (uint256 allocationId);                 // onlyOfframpRelayer

// ── user-driven (msg.sender MUST == allocation.user) ──
// Places the SELL via the user's own proxy. order.user = that proxy.
// Re-callable after the prior order is CANCELLED (retry from the refunded balance).
function userStartOfframp(
    uint256 allocationId,
    bytes32 currency,
    uint256 fiatAmount,                       // SELL slippage floor; 0 = none
    uint256 circleId,                         // merchant circle (Base Sepolia: 1)
    uint256 preferredPaymentChannelConfigId,
    string calldata userPubKey                // user's relay pubkey (widget SDK identity)
) external returns (uint256 orderId);

// Encrypted-UPI delivery (drives ACCEPTED → PAID). Diamond pulls actualUsdtAmount
// from the proxy; integrator tops up any fee shortfall from its float.
function userDeliverOfframpUpi(uint256 orderId, string calldata encUpi) external;

// ── permissionless: record terminal status; settle on COMPLETED ──
function syncOfframp(uint256 orderId) external;

// ── owner break-glass: return an abandoned allocation's USDC to the vault ──
function reclaimAbandonedOfframp(uint256 allocationId) external;   // onlyOwner, after timeout

// ── views (widget reads these) ──
function availableOfframp(address user) external view returns (uint256);     // Σ unsettled allocation amounts
function pendingAllocations(address user) external view returns (uint256[] memory);
function getAllocation(uint256 allocationId) external view returns (OfframpAllocation memory);
function proxyAddress(address user) external view returns (address);          // deterministic per-user proxy
function allocations(uint256) external view returns (/* OfframpAllocation */);
function burnToAllocation(bytes32) external view returns (uint256);
function orderToAllocation(uint256) external view returns (uint256);

// ── events ──
event OfframpAllocated(uint256 indexed allocationId, address indexed user, address proxy, uint256 amount, bytes32 indexed solanaBurnTx, bytes32 solanaUserPubkey);
event OfframpOrderPlaced(uint256 indexed allocationId, uint256 indexed orderId, address indexed user, uint256 amount);
event OfframpUpiDelivered(uint256 indexed orderId);
event OfframpSettled(uint256 indexed allocationId, uint256 indexed orderId);     // COMPLETED — fiat sent
event OfframpCancelled(uint256 indexed allocationId, uint256 indexed orderId);   // USDC back in proxy; retryable
event OfframpReclaimed(uint256 indexed allocationId, uint256 amount);
```

```solidity
struct OfframpAllocation {
    address user;            // Base EOA = proxy owner
    uint256 amount;          // USDC moved into the proxy (burned principal)
    bytes32 solanaBurnTx;
    bytes32 solanaUserPubkey;
    uint64  allocatedAt;     // for abandonment reclaim
    uint256 activeOrderId;   // current in-flight SELL (0 = none)
    uint8   lastStatus;      // last status seen by syncOfframp (informational)
    bool    settled;         // COMPLETED (fiat sent) or reclaimed to vault
}
```

The v2 integrator keeps the v1 BUY surface unchanged (`userPlaceOrder`,
`onOrderComplete`, `onOrderCancel`, limits/RP, proxy helpers). `validateOrder`
gains a bypass: while the integrator is mid-`userStartOfframp` (a transient
`_offrampPlacing` flag), it returns `true` — the relayer already bounded the
draw via `maxUsdcPerOfframp` + the vault quota, so per-user *buy* limits don't
apply to an offramp SELL. The v1 relayer-driven offramp
(`placeSellOrderForBurn`/relayer `deliverOfframpUpi`/`reconcile`) is **removed**
in v2; the v1 integrator stays deployed for any in-flight legacy offramps.

## Invariants & nuances

- **USDC trap intact.** Allocated USDC sits in the user's proxy and can leave only
  via (a) the Diamond pulling it for the SELL (→ merchant → fiat to the user
  off-chain) or (b) `transferERC20ToIntegrator` → vault on reclaim. It can never
  reach the user's EOA. `UserProxy.sol` is **not modified** (its bytecode is
  pinned into the Diamond's CREATE2 auth).
- **Fee policy.** Allocation = `burned`; SELL `amount = burned`; the small-order
  fee (if any) is fronted from the integrator's USDC float at deliver time
  (reverts `OfframpInsufficientPool` if short) — same economics as v1. On
  cancel-while-PAID the refund (`amount+fee`) lands back in the proxy, so retries
  self-fund the fee. Above-threshold amounts have fee 0 (used in the E2E).
- **Retry.** Cancel refunds to the proxy; `userStartOfframp` is re-callable once
  the prior order is `CANCELLED`. One in-flight order per allocation.
- **Abandonment.** `reclaimAbandonedOfframp` (owner-only, after
  `offrampAbandonTimeout`, and only when no order is in-flight) returns the
  proxy's USDC to the vault.
- **Fee-not-ready guard** (the 2026-05-07 bug) is preserved.

## Widget changes (`p2pdotme-checkout-widget`)

The `<Cashout>` machine is ~80% reusable. Changes (host-callback-shaped, SDK
unchanged):
1. Balance affordance = allocation (`availableOfframp(user)` via a host
   `fetchAvailableOfframp` callback/prop), not `balanceOf`. No USDC approve in
   the TradeStars `placeCashout`.
2. `placeCashout` → `userStartOfframp(allocationId, …)`; `deliverUpi` →
   `userDeliverOfframpUpi`; `reconcile` → `syncOfframp`.
3. Retry-from-cancelled in `offramp-machine.ts` (store `feeUsdc`, add
   `retryPlace` + `canRetryPlace`, re-enter placement from `cancelled`).
4. `PaymentHistory`: query a second `getOrders({ userAddress: proxyAddress })`
   and merge/dedupe with the EOA's orders.

## Relayer changes (`tradestars-relayer`)

`processP2PWithdrawal` collapses to one step: `allocateOfframp(baseAddress,
amount, burnTx, solPubkey)`. Drop merchant/terminal polling, payout
decrypt/encrypt, `deliverOfframpUpi`, `reconcile`. Shrink `WithdrawalRecord`
(add `baseAddress` + `baseAllocationId/Tx`; drop the place/deliver/reconcile tx
fields + `payoutAddressEncrypted`); status → `{ allocated, failed }`. Drop the
`P2P_OFFRAMP_RELAY_*` + `P2P_WITHDRAWAL_ENCRYPTION_KEY` secrets from the
withdrawal path. Deposit/onramp flow untouched. **Gap to close in the product
app:** the withdrawal record must carry the user's **Base address**
(`baseAddress`) so the relayer can allocate to the right proxy.

## Base Sepolia coordinates (E2E)

```
Diamond   = 0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9
USDC (GG) = 0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d   (6dp; deployer-minted)
chainId   = 84532   RPC = https://sepolia.base.org
superAdmin = relayer = deployer = 0x9dE9772afcDF3afA03cC689FE7afa5b631088aB9
subgraph  = https://api.studio.thegraph.com/query/1745491/event-indexer/version/latest
sell circle = 1 (INR/BRL/IDR)   merchant: p2p-checkout/demo-merchant-bot (auto-accept + auto-complete)
Aave      = none on Sepolia → deploy MockAavePool + mock aUSDC with the vault
```

E2E: deploy v2 (vault+integrator+mocks) → `registerIntegrator(v2, true, proxyImpl)`
→ fund vault with GG → `allocateOfframp` (relayer) → `userStartOfframp` (user) →
demo-merchant-bot accepts → `userDeliverOfframpUpi` (dummy ciphertext; the bot
doesn't decrypt) → bot completes → `syncOfframp` → assert COMPLETED. Plus a
cancel→retry path.
