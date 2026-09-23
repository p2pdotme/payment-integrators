# Merchant Terminal — audit, September 2026

**Scope:** `contracts/integrators/merchant-terminal/`: `MerchantTerminalIntegrator.sol`, `LinkRouter.sol`, `PaymentLinksLib.sol`, `SettlementLib.sol`, `MerchantRegistryLib.sol` and `MerchantTypes.sol` (3,453 lines).

**Contract changes: none.** This document only suggests fixes. Every finding marked **PoC** has a test in `test/AuditFindingsMerchantTerminal.ts` that currently passes because it asserts the problem. When you ship a fix, flip that assertion.

**Test status:** 916 passing (the 908 that already existed, plus 8 PoCs), 42 pending.

## Summary

| ID | Severity | Title | PoC |
|----|----------|-------|-----|
| H-1 | High (trust) | A MANAGER can make itself `trustedRelayer`, which bypasses LinkRouter and lets it choose where a merchant's fiat payout goes | ✔ |
| M-1 | Medium | Abandoned link checkouts use up the merchant's daily limit, which blocks their POS sales too | ✔ |
| M-2 | Medium | The offramp fee is charged twice when `setSellOrderUpi` leaves the SELL in ACCEPTED and delivery is retried | ✔ |
| L-1 | Low | `revokeLink` and `resetLinkStrikes` accept owners only, not the admin roles their docs name | ✔ |
| L-2 | Low | Currency codes are not normalised, so `"inr"` registers as its own currency with the 100 USDC cap | ✔ |
| L-3 | Low | Shop name, payout blob, link config and pubKey have no length limit, and sponsored gas pays for them | ✔ |
| L-4 | Low | A single-use link stays blocked by an abandoned order until the Diamond's TTL runs out | — |
| L-5 | Low | LinkRouter's claim that "a compromised backend cannot advance a payment" is broader than what the code guarantees | — |
| I-1 | Info | A merchant who registered without a payout handle cannot edit their shop name or sector | ✔ |
| I-2 | Info | `trustedRelayer` is one slot shared by LinkRouter and the payout keeper | — |
| I-3 | Info | Recovering a stranded link BUY leaves its false-claim strike in place | — |
| I-4 | Info | Centralisation: escheat, `skimExcess` and an uncapped `setPerTxCap` | — |
| I-5 | Info | Stale comment in `transferOwnership` | — |

## What is solid

Several areas held up under review:

- **Solvency invariant.** `balanceOf(this) >= totalOwed` holds on every path. Fees are charged to the merchant who withdraws, not to the pool.
- **Capped proxy sweeps.** Every recovery path goes through `_sweepCapped`, so the amount swept always equals the amount credited, and one merchant's pot cannot absorb another's.
- **Settlement buckets.** A merge never crosses the locked/unlocked line, and `compact` is stable.
- **Reentrancy.** There are two separate guards, one for entrypoints and one for Diamond callbacks. The `relayerCancelOrder → onOrderCancel` case is handled correctly.
- **Link orders.** `validateOrder` resolves the proxy back to the merchant, so link orders get the same cap, freeze and daily checks as POS orders. `consume` follows checks-effects-interactions, and the currency is pinned per link.
- **LinkRouter.** It has no custody, no admin and no upgrade path. EIP-712 signatures are bound per action, and malleable signatures are rejected.
- **Admin controls.** The super-admin handoff is two-step and expires. The last owner cannot be removed, and escheat requires 90 days of continuous freeze.

---

## H-1: A MANAGER can take over `trustedRelayer`

**Where:** `setTrustedRelayer` (`onlyRole(Role.MANAGER)`), `relayerPlaceOrder`, `relayerMarkPaid`, `relayerCancelOrder`, `deliverFiatPayout` and `sweepStrandedBuy`.

`trustedRelayer` is the integrator's only gate on the link entrypoints. The role docs describe MANAGER as a "config" tier. However, a MANAGER can call `setTrustedRelayer(self)`, and that one call gives it all of the following:

1. **It bypasses LinkRouter completely.** LinkRouter's central promise is that cancel and mark-paid need the customer's own signature. The integrator does not know that promise exists, so the new "relayer" can cancel or mark paid any link order directly (**PoC H-1**). It can also place orders on any link.
2. **It passes `deliverFiatPayout` authorisation.** The caller supplies `encPayout`, which is the payload the LP decrypts to find out where to send the fiat. A caller who picks the payload picks the destination (**PoC H-1b**). Owners already hold this power by design, and after this change so does anyone at MANAGER level.

**Suggested fix:**

- Make `setTrustedRelayer` `onlySuperAdmin`. Better still, add a delay: a pending value that only takes effect after 48 hours, with an event, so a bad change can be noticed and reversed.
- Split the slot into two:
  - `linkRouter`, settable by the super-admin only and effectively set once;
  - `payoutKeeper`, used for `deliverFiatPayout`.

  This split also fixes I-2.
- In `deliverFiatPayout`, when `msg.sender != w.merchant`, require an EIP-712 signature from the merchant over `(orderId, keccak256(encPayout))`. Merchants are ERC-1271 smart accounts, so verify with OpenZeppelin `SignatureChecker`. With this in place, no keeper, owner or manager can choose where the fiat goes.

**Until a fix ships:** grant MANAGER only to keys you would trust with payouts, and keep the super-admin on a multisig.

## M-1: Link traffic uses up the merchant's POS daily limit

**Where:** `validateOrder`, which increments `dailyTxCount` for link orders, and `onOrderCancel`.

Every link order places immediately and uses one of the merchant's `dailyLimit` slots (25 per day). A customer who opens the pay page and then leaves creates an order that nobody marks paid. The relayer cannot cancel it without the customer's signature, so it sits in PLACED until the Diamond's TTL. Twenty-five abandoned checkouts, whether real or scripted past the relayer's human check, lock the merchant out of their own counter sales for the rest of the UTC day (**PoC M-1**).

**Suggested fix (pick one):**

- Keep a separate counter and limit for link orders (`linkDailyTxCount`, `linkDailyLimit`), so links cannot starve POS sales.
- Or count only link orders that reach PAID: take the slot in `relayerMarkPaid` instead of at placement. The per-transaction cap still applies at placement.
- Also let the link agent cancel an unpaid order without the customer's signature once it is older than N minutes and has not been marked paid. LinkRouter would need to store the placement time. This also fixes L-4.

**Operational stop-gap:** raise the limit with `setDailyLimit`. On the relayer side, keep the per-link, per-IP pending-order limits strict.

## M-2: The offramp fee is charged twice when delivery is retried

**Where:** `deliverFiatPayout`.

When `setSellOrderUpi` returns success but the order stays ACCEPTED, the function rolls back `upiDelivered` and keeps everything else:

- the fee debit (`_deductUnlocked(m, topUp)`);
- the fee transfer to the proxy;
- `w.feeAdvanced = topUp`.

A retry passes the ACCEPTED check again, charges the fee a second time, and overwrites `feeAdvanced` instead of adding to it. Any later reconcile then re-credits only one fee. The second fee is left on the proxy, where no path attributes it to the merchant (**PoC M-2**, which uses the mock's existing `setForceSellUpiNoOp` branch).

The sibling integrator (`showdown`, #96) already treats this "neither PAID nor CANCELLED" outcome as its own case. This one does not.

**Suggested fix:** revert unless `postStatus` is `STATUS_PAID` or `STATUS_CANCELLED`, so the whole call, including the fee, rolls back and a retry starts clean. An alternative is to size the top-up as `needed - (w.amount + w.feeAdvanced)` and use `feeAdvanced += topUp`.

## L-1: `revokeLink` accepts owners only

`revokeLink` and `resetLinkStrikes` pass `isOwner[msg.sender]` as `callerIsAdmin`. The NatSpec says "Owner or admin", and a SUPPORT-tier operator responding to a phishing link would expect to be able to revoke it. Even a FINANCE admin cannot (**PoC L-1**).

**Fix:** pass `uint8(_tier(msg.sender)) >= uint8(Role.SUPPORT)`.

## L-2: Currency codes are not normalised

`toCurrency` and `validateRegistration` accept any 1–31 non-NUL bytes. `"inr"` and `"INR"` are therefore different currencies, and `perTxCap("inr")` falls through to the 100 USDC default (**PoC L-2**). Orders in `"inr"` would probably find no circle, but the cap and lock rules still diverge from what the operator intended.

**Fix:** require `[A-Z]{3}` in `validateRegistration`, or at least uppercase ASCII letters.

## L-3: Unbounded user-supplied data

The following fields have no length cap:

- `shopName` and `encPayoutId`, which are stored;
- `encryptedConfig`, which is emitted in an event;
- `pubKey`, which is forwarded to the Diamond.

Merchant transactions are paymaster-sponsored, so the operator pays for a 20 KB shop name (**PoC L-3**). The paymaster's per-operation gas limit bounds this, but that limit is off-chain and project-wide.

**Fix:** add length checks. Suggested limits: shop name 64 bytes, payout blob 512, link config 1 KB, pubKey 200.

## L-4: A single-use link is blocked by an abandoned order

`consume` takes the use at placement, and only `onOrderCancel` gives it back. Only the customer can sign a cancel, so a visitor who abandons the page holds a single-use link until the Diamond's TTL. During that time the real payer is told the link has already been used.

**Fix:** use the timed agent-cancel described under M-1.

## L-5: LinkRouter's trust claim is broader than the code

The LinkRouter header says a compromised backend "cannot advance or cancel anyone's payment". That is true for orders that real customers placed. However, `place` records whatever `customer` address the agent passes in. A backend holding the link keys can therefore place orders with a customer key it controls, then mark them paid or cancel them. That gives it:

- false "I have paid" claims against LPs, which cost reputation and strikes but no funds;
- unlimited place/cancel loops, where each cancel returns the daily slot and the link use.

**Fix:** reword the claim. Keep the relayer's per-link sponsored-operation ceiling, which already bounds these loops.

## Informational

- **I-1:** `updateProfile` requires a non-empty `encPayoutId`. A merchant who registered without one therefore cannot correct their shop name or sector without also choosing a payout rail (**PoC I-1**). Accept empty as "unchanged".
- **I-2:** `trustedRelayer` is currently set to the LinkRouter, which cannot call `deliverFiatPayout`. Keeper-driven fiat delivery is therefore off, and each merchant's own app must deliver. H-1's split fixes this.
- **I-3:** When `onOrderComplete` reverts for a link order, `sweepStrandedBuy` credits the merchant but never clears `orderToLink` or releases the strike from mark-paid. The link then shows a false claim for a payment that was real.
- **I-4:** Centralisation, by design but worth documenting to merchants:
  - SUPPORT can freeze a merchant, and 90 days later the super-admin can escheat the whole balance to any address.
  - `skimExcess` is super-admin only.
  - `setPerTxCap` has no upper bound.

  Recommendation: put the super-admin behind a multisig with a timelock.
- **I-5:** The `transferOwnership` comment mentions a "drop-caller branch below" that no longer exists.
- **Minor:** `uses++` in `consume` is `unchecked` and wraps at 2³² on unlimited links. This is harmless because `maxUses == 0` never compares against it.
