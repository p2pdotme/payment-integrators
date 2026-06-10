# Offramp v2 — user-driven, voucher-attested, ONE Base tx

> Status: implemented on `feat/offramp-v2` (PR #14), deployed + E2E-verified on
> Base Sepolia. This doc is the authoritative spec for the v2 integrator ABI
> that the attester service (`tradestars-relayer`) and widget
> (`p2pdotme-checkout-widget`) build against.

## The core idea

The legacy TradeStars offramp places every SELL through a **shared system
proxy** driven end-to-end by the relayer. v2 flips it: the relayer has **no
on-chain write path at all**. When it observes a Solana tUSDC burn it only
**signs an EIP-712 `OfframpVoucher`** off-chain. The **user** then sends **one
Base tx** — `userRedeemAndStartOfframp` — that atomically verifies the voucher,
releases the burned amount from the vault into the **user's own per-user
proxy** (the same proxy keyed on their Base EOA that onramp uses, **pooling**
with any prior balance), and places the SELL through that proxy. Subsequent /
partial / retry draws come from the pooled balance via `userStartOfframp` — no
new voucher. The user drives deliver-UPI → retry from the widget (gaslessly,
via their paymaster). The proxy's USDC balance **is** the cashable balance.

```
            OLD (relayer-driven, system proxy)            v2 (voucher-attested, ONE user tx)
 burn ─▶ relayer: placeSellOrderForBurn ┐            relayer/attester: SIGNS OfframpVoucher (off-chain, no tx)
         poll / encrypt / deliverUpi    │ system     USER (gasless) — ONE Base tx:
         poll / reconcile               │ proxy        userRedeemAndStartOfframp(voucher, sig, principal ≤ balance)
         (manual replay on failure)     ┘              ├ verify sig + deadline + burn-dedupe
                                                       ├ vault.releaseForOfframp → USDC ▶ USER proxy (pooled)
                                                       └ SELL placed through the proxy — same tx
                                                      ↳ poll ACCEPTED → encrypt UPI client-side
                                                      ↳ userDeliverOfframpUpi(orderId, encUpi)
                                                      ↳ PAID → COMPLETED ✓ / CANCELLED → retry:
                                                        userStartOfframp(principal) — NO new voucher
```

## Why this fixes all three problems (one root cause)

| Symptom today | Root cause | v2 fix |
|---|---|---|
| History shows only onramp | SELL `order.user` = one shared system proxy; history is keyed on the user's address | SELL `order.user` = the user's **per-user proxy** (deterministic from their EOA); widget merges EOA + derived-proxy `getOrders` |
| Owner manually retriggers failed offramps | relayer workflow owns the whole lifecycle; failures need `replay:p2p-withdrawal` | cancel refunds land in the **user's proxy**; the user re-places/redraws from the widget — no owner/relayer |
| One relayer driving everything | relayer is the sequential driver and holds payout-encryption keys | relayer only **signs the voucher off-chain** (zero relayer txs, zero event-pickup wait); the user signs the single redeem+place tx, deliver, retry; payout is encrypted **client-side** |

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

// ── the burn attestation the attester (offrampRelayer key) signs OFF-CHAIN ──
// EIP-712 domain: name "TradeStarsOfframp", version "1", chainId, verifyingContract
// = the integrator. Single-use (deduped on solanaBurnTx), deadline-bounded,
// redeemable only by `user`. The attester NEVER sends a transaction.
struct OfframpVoucher {
    bytes32 solanaBurnTx;    // dedupe key
    bytes32 solanaUserPubkey;
    address user;            // Base EOA that may redeem; their proxy is funded
    uint256 amount;          // burned principal released from the vault (USDC, 6dp)
    uint256 deadline;        // unix seconds; attester re-signs if it lapses
}

// ── user-only, ONE Base tx: verify voucher → vault release → place SELL ──
// Atomic: any revert (e.g. the placement guard) rolls the whole tx back and the
// voucher stays unredeemed. `principal` may be ≤ voucher.amount (remainder stays
// pooled) or > it (if a prior pooled balance covers the difference) — placement
// is bounded only by the proxy balance, exactly like userStartOfframp.
// Voucher checks: sig recovers to offrampRelayer, deadline not passed, burn not
// already redeemed, amount ≤ maxUsdcPerOfframp, msg.sender == voucher.user.
function userRedeemAndStartOfframp(
    OfframpVoucher calldata voucher,
    bytes calldata signature,                 // attester's EIP-712 signature
    uint256 principal,
    bytes32 currency,
    uint256 fiatAmount,                       // SELL slippage floor; 0 = none
    uint256 circleId,                         // merchant circle (Base Sepolia: 1)
    uint256 preferredPaymentChannelConfigId,
    string calldata userPubKey                // user's relay pubkey (widget SDK identity)
) external returns (uint256 orderId);

// ── user-driven retry / subsequent partial draws (NO voucher) ──
// Draws `principal` from the caller's pooled proxy balance and places a SELL.
// Callable repeatedly (partial / multi-part / retry-after-cancel), ONE in-flight
// order at a time — the prior order must be terminal (COMPLETED or CANCELLED)
// before the next. Reverts OfframpInsufficientBalance unless
// proxyBalance >= principal + fee.
function userStartOfframp(
    uint256 principal,                        // any amount ≤ pooled proxy balance
    bytes32 currency,
    uint256 fiatAmount,
    uint256 circleId,
    uint256 preferredPaymentChannelConfigId,
    string calldata userPubKey
) external returns (uint256 orderId);

// Encrypted-UPI delivery (drives ACCEPTED → PAID). Diamond pulls actualUsdtAmount
// (= principal + fee) from the proxy, which userStartOfframp already guaranteed it
// holds. NO integrator-float subsidy; reverts if somehow short.
function userDeliverOfframpUpi(uint256 orderId, string calldata encUpi) external;

// ── permissionless: record terminal status + free the user's in-flight slot ──
function syncOfframp(uint256 orderId) external;

// ── views (widget reads these) ──
function availableOfframp(address user) external view returns (uint256);  // = proxy USDC balance (the pool)
function getUserAllocations(address user) external view returns (uint256[] memory); // audit/history
function getAllocation(uint256 allocationId) external view returns (OfframpAllocation memory);
function proxyAddress(address user) external view returns (address);       // deterministic per-user proxy
function allocations(uint256) external view returns (/* OfframpAllocation */);
function burnToAllocation(bytes32) external view returns (uint256);        // non-zero ⇒ voucher redeemed
function orderToUser(uint256) external view returns (address);             // orderId → proxy owner
function userActiveOrder(address) external view returns (uint256);         // current in-flight draw (0 = none)
function hashOfframpVoucher(OfframpVoucher calldata) external view returns (bytes32); // EIP-712 digest cross-check for off-chain signers

// ── events ──
event OfframpAllocated(uint256 indexed allocationId, address indexed user, address proxy, uint256 amount, bytes32 indexed solanaBurnTx, bytes32 solanaUserPubkey);
event OfframpOrderPlaced(uint256 indexed orderId, address indexed user, uint256 principal);  // a draw
event OfframpUpiDelivered(uint256 indexed orderId);
event OfframpSettled(uint256 indexed orderId, address indexed user);       // COMPLETED — fiat sent
event OfframpCancelled(uint256 indexed orderId, address indexed user);     // USDC back in proxy; retry/redraw
```

```solidity
// An allocation is a FUNDING record (dedup + audit), written when a voucher is
// redeemed — withdrawals are NOT tied to a single allocation; they draw from
// the pooled proxy balance.
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
gains a bypass: while the integrator is mid-placement (a transient
`_offrampPlacing` flag), it returns `true` — the draw is already bounded by the
attested voucher amount (≤ `maxUsdcPerOfframp`) + the proxy balance, so
per-user *buy* limits don't apply to an offramp SELL. The v1 relayer-driven
offramp (`placeSellOrderForBurn`/relayer `deliverOfframpUpi`/`reconcile`) and
the earlier relayer-funded `allocateOfframp` are both **removed**; the v1
integrator stays deployed for any in-flight legacy offramps. `offrampRelayer`
(+ `setOfframpRelayer`) is retained as the **attester key** — it authorises
voucher signatures and nothing else.

## Invariants & nuances

- **Voucher = the burn attestation.** Vault USDC moves only against a voucher
  signed by the attester key: single-use (`BurnAlreadyProcessed` on replay),
  deadline-bounded (`VoucherExpired` — ask the attester to re-sign),
  user-bound (`OnlyVoucherUser` — the SELL is placed as `msg.sender`), amount
  ≤ `maxUsdcPerOfframp`. A forged/tampered voucher fails `ECDSA.recover` →
  `InvalidVoucherSignature`. The redeem+place tx is **atomic**: if the
  placement leg reverts (zero principal, in-flight order, insufficient
  balance for principal+fee), the vault release rolls back too and the
  voucher stays unredeemed/reusable.
- **USDC trap intact.** Pooled USDC sits in the user's proxy and can leave only
  via the Diamond pulling it for a SELL (→ merchant → fiat to the user
  off-chain). It can never reach the user's EOA. `UserProxy.sol` is **not
  modified** (its bytecode is pinned into the Diamond's CREATE2 auth).
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
- **Retry / redraw — never needs a new voucher.** Cancel refunds
  (`principal + fee`) to the proxy; the burn stays deduped and the funds sit in
  the proxy, so the retry is just `userStartOfframp` once the prior order is
  terminal (COMPLETED or CANCELLED) — `syncOfframp` also frees the slot but
  isn't required.
- **No reclaim.** Allocated USDC stays in the user's proxy until they draw it
  down — there is no owner sweep/reclaim. (A reclaim-to-vault path was
  considered but dropped: it would strand the user, since the original burn is
  deduped and the proxy would be emptied, leaving recovery to an off-chain
  re-allocation. Re-add behind such an SOP only if vault-liquidity recovery from
  dormant allocations becomes necessary.)
- **Fee-not-ready guard** (the 2026-05-07 bug) is preserved (`userDeliverOfframpUpi`
  reverts `OfframpFeeNotReady` if `actualUsdtAmount` reads 0).
- **Burn-backed note.** *Vault* USDC is strictly burn-backed (it moves only
  against a signed voucher). But because the pool is the raw proxy balance,
  USDC sent *directly* to a proxy would also be cashable through
  `userStartOfframp`. Fine for testnet; for stricter production accounting add
  a thin per-user "allocated" ledger gating draws.

## Widget changes (`p2pdotme-checkout-widget`)

The `<Cashout>` machine is callback-shaped (SDK unchanged) — **the widget needs
NO code change for the voucher flow**; the voucher lives entirely inside the
host app's callback implementations:
1. Balance affordance via the host `fetchAvailableOfframp` callback. For the
   voucher flow the host returns `unredeemedVoucherAmount + proxyBalance` —
   before the first draw that's the voucher amount; after a cancel the
   refunded proxy balance carries it. No USDC approve in the TradeStars
   `placeCashout`.
2. `placeCashout` → host fetches the signed voucher from its backend and calls
   `userRedeemAndStartOfframp(voucher, sig, principal, …)`; on retry (voucher
   already redeemed — funds in the proxy) the host calls
   `userStartOfframp(principal, …)` instead. `deliverUpi` →
   `userDeliverOfframpUpi`; `reconcile` → `syncOfframp`.
3. Fee-aware amount: the widget reads the threshold + `getSmallOrderFixedFeeSell`
   and enforces `principal + fee <= balance` (shows "insufficient balance"
   otherwise) — matching the contract guard. The order id is parsed from the
   `OfframpOrderPlaced(orderId, user, principal)` event (orderId is topic[0]).
4. Retry-from-cancelled + multi-part: re-enter placement from `cancelled`; start
   the next part once the prior order is terminal.
5. `PaymentHistory`: query a second `getOrders({ userAddress: proxyAddress })`
   and merge/dedupe with the EOA's orders.

## Relayer changes (`tradestars-relayer`) — attester (signer-only)

`processP2PWithdrawal` collapses to a **pure off-chain signing step**: validate
the withdrawal record (wallet/amount/nonce/`baseAddress`), EIP-712-sign
`OfframpVoucher(burnTx, solPubkey, baseAddress, amount, deadline)` with the
attester key, and persist `{voucher, signature}` on the withdrawal record so
the product app can hand it to the widget/host. The relayer sends **no Base
transaction** — it needs no Base gas, no nonce management, no tx retry logic.
Drop merchant/terminal polling, payout decrypt/encrypt, `deliverOfframpUpi`,
`reconcile`, and the allocation tx path. Status →
`{ signing, signed, redeemed?, failed }` (`redeemed` optional — observable
on-chain via `burnToAllocation`). If a voucher's deadline lapses before the
user redeems, the relayer simply re-signs the same record. Deposit/onramp flow
untouched. **Gap to close in the product app:** the withdrawal record must
carry the user's **Base address** (`baseAddress`) — it becomes `voucher.user`,
the only wallet that can redeem.

## Base Sepolia coordinates (E2E)

```
Diamond    = 0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9
USDC (GG)  = 0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d   (6dp; deployer-minted)
chainId    = 84532   RPC = https://sepolia.base.org
superAdmin = relayer = deployer = 0x9DE9772AfCdf3AFa03CC689fE7AFA5b631088aB9
subgraph   = https://api.studio.thegraph.com/query/1745491/event-indexer/version/latest
sell circle = 1 (INR/BRL/IDR)   merchant: p2p-checkout/demo-merchant-bot (auto-accept + auto-complete)
Aave       = none on Sepolia → deploy MockAavePool + mock aUSDC with the vault

current voucher-flow deployment (2026-06-10):
  integrator = 0xadD13C5DB8aD6913E213fAa6572f9C79F1659D19
  proxyImpl  = 0x2F64Eea6f46fdbeA7C45196E180f01594D88B1D5
  vault      = 0x437D0d767DEC6741fB59b291Cb787BF933b349ac
  INR pricing: sellPrice 89, smallOrderThreshold 10 USDC, sell fee 0.125 USDC

superseded pooled-partial deployment (pre-voucher, allocateOfframp era):
  integrator = 0xF1d04b7a0Ae0030BcCF8859238f921862e2eB6e3
```

E2E (verified live 2026-06-10, order 240): deploy v2 (vault+integrator+mocks) →
`registerIntegrator(v2, true, proxyImpl)` → fund vault (`deposit`/owner `fund`)
→ attester **signs** `OfframpVoucher` off-chain → user sends **one tx**
`userRedeemAndStartOfframp(voucher, sig, principal)` (fee-aware: principal =
voucher − fee at/below threshold) → demo-merchant-bot accepts →
`userDeliverOfframpUpi` (dummy ciphertext; the bot doesn't decrypt) → bot
completes → `syncOfframp` → assert COMPLETED. Covered by the test suite
(`test/tradestars-v2-offramp.test.ts`, 48 cases): voucher
forge/tamper/expiry/replay/wrong-redeemer, atomic-rollback, multi-part draws
(e.g. 30/40/30), fee-from-balance, `OfframpInsufficientBalance`,
cancel→redraw, plus admin/BUY/guard branch coverage (contract 100% line / 91%
branch).
