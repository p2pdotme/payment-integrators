# LotPot Buyer USDC Cashback — Credit Ledger + Vault Design

**Date:** 2026-05-21
**Repos touched:** `contracts-v4` (Diamond), `payment-integrators` (LotPot V2 + vault)

## Goal

Run a growth campaign that nudges non-B2B P2P users into LotPot by issuing a **USDC cashback** (initial rate 2%, super-admin tunable up to 10%) on every completed non-B2B P2P BUY order. The cashback is delivered as **on-chain credit** that can only be redeemed for Megapot lottery tickets via the LotPot V2 integrator. Megapot funds the campaign; P2P provides backstop liquidity.

## Architecture

```
P2P BUY completes (contracts-v4 Diamond)
  └─> OrderFlowHelper.handleLotpotBuyerCashback(orderId)
        └─> try lotpotIntegrator.issueCredit(user, amount) {} catch {}
              └─> issuedCredit[user] += amount
                  emit CreditIssued(user, amount)

User places LotPot ticket order (LotPotCheckoutIntegratorV2)
  └─> _route(quantity, ...)
        ├─> proxyBal  = usdc.balanceOf(proxy)
        ├─> issued    = issuedCredit[user]
        ├─> totalPrice = quantity * ticketPrice
        ├─> if (proxyBal + issued >= totalPrice):
        │     need   = max(0, totalPrice - proxyBal)
        │     pulled = _pullFromVaults(need, proxy)         [grant vault first, fallback next]
        │     issuedCredit[user] -= pulled
        │     if (proxyBal + pulled >= totalPrice):
        │       _redeemFromCredit(...)                       [no Diamond order — synchronous]
        │       return 0
        │     // vaults dry — fall through to delta path with partial pull
        ├─> delta = totalPrice - proxyBal - pulled
        └─> _placeOrder(proxy, delta, ...)                   [Diamond B2B order for the delta]

Vault model (LotpotGrantVault — one contract, two deployments):
  • Megapot deploys + funds + owns the grant vault (primary)
  • P2P deploys + funds + owns the fallback vault (backstop)
  • Each owner whitelists the integrator via setApprovedSpender(integrator, true)
  • Integrator pulls via vault.release(proxy, amount)
  • Either owner can withdraw their USDC anytime
```

## Why this shape

1. **Cost shifting** — Megapot funds the campaign (their product gets the ticket-purchase funnel). P2P only backstops.
2. **Capital efficient** — USDC sits in vaults until actually consumed; user proxies hold nothing between purchases.
3. **No parked-USDC complexity** — credit is just a ledger entry, so no sweep/timelock/abandoned-funds machinery is needed.
4. **No accounting hygiene** — since issued credit consumes nothing until tickets are bought, no expiry or revocation logic is required. Pure additive counter per user.
5. **Graceful degradation** — if both vaults are dry, the user still completes their purchase: pull what's available, decrement credit by that amount, place a Diamond order for the larger delta.

## Components

### `LotpotGrantVault.sol` (payment-integrators, new)

USDC holding contract. Source is deployed twice (Megapot-owned primary; P2P-owned fallback).

```solidity
contract LotpotGrantVault {
    IERC20 public immutable usdc;
    address public owner;
    mapping(address => bool) public approvedSpender;

    function setApprovedSpender(address spender, bool approved) external onlyOwner;
    function release(address to, uint256 amount) external onlyApprovedSpender;
    function withdraw(address to, uint256 amount) external onlyOwner;
    function transferOwnership(address newOwner) external onlyOwner;

    event SpenderSet(address indexed spender, bool approved);
    event Released(address indexed to, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event OwnershipTransferred(address indexed from, address indexed to);
}
```

Inbound USDC is via plain `usdc.transfer(vault, ...)` — no special deposit method.

### `LotPotCheckoutIntegratorV2.sol` (payment-integrators, new)

Fresh V2 integrator. V1 (`LotPotCheckoutIntegrator.sol`) stays untouched.

**Storage additions vs V1:**

```solidity
mapping(address => uint256) public issuedCredit;        // per-user accumulating ledger
mapping(address => bool)    public creditIssuer;        // whitelisted callers (init: Diamond)
address public grantVault;                              // primary, Megapot-funded
address public fallbackVault;                           // secondary, P2P-funded
```

**New external functions:**

```solidity
function issueCredit(address user, uint256 amount) external;       // onlyCreditIssuer
function setCreditIssuer(address issuer, bool approved) external;  // onlyOwner
function setVaults(address grant, address fallback_) external;     // onlyOwner
function previewAvailableCredit(address user) external view
    returns (uint256 onProxy, uint256 issued, uint256 grantAvail, uint256 fallbackAvail);
```

**Modified `_route`:** prepend the issuedCredit + vault-pull logic in front of the existing credit-netting branch. The two existing fulfillment paths (`_redeemFromCredit` direct ≤10, batch >10) are unchanged — once USDC is on the proxy, current code works.

**New internal helper:** `_pullFromVaults(uint256 needed, address to) returns (uint256 pulled)` — tries grant vault first, then fallback. Each vault call wrapped in try/catch so a misconfigured / paused vault degrades gracefully to partial fulfillment.

**No UserProxyV2** — V1 `UserProxy.sol` is unchanged and reused as the V2 integrator's `proxyImpl`.

**Constructor** is V1's shape — `(diamond, usdc, megapot, batchFacilitator, jackpotNft, baseTxLimit, dailyTxCountLimit, source)`. Vaults and credit issuers are configured post-deploy via owner calls.

### Diamond changes (contracts-v4)

| Change | Description |
|---|---|
| `P2pConfigStorage.LotpotBuyerCashbackConfig` | Storage struct + Layout field (appended) |
| `SetterFacet.setLotpotBuyerCashback(uint16, address)` | Super-admin gated; caps at 1000 bps |
| `GetterFacet.getLotpotBuyerCashbackConfig()` | Returns the config |
| `OrderFlowHelper.handleLotpotBuyerCashback(orderId)` | Single try/catch around `ILotpotCreditIssuer.issueCredit(user, amount)` |
| `OrderFlowHelper.completeOrder` | Hook fires only on direct (non-B2B) BUY completion |
| `interfaces/ILotpotCreditIssuer.sol` | Narrow Diamond-side interface (single function) |

**Event:** `BuyerLotpotCashback(uint256 indexed orderId, address indexed user, uint256 amount)` — no `proxy` field (credit is ledger-only).

## Error handling

| Failure | Behavior |
|---|---|
| Config disabled (`percentageBps == 0` or `lotpotIntegrator == address(0)`) | Silent return |
| Cashback amount rounds to 0 | Silent return |
| `integrator.issueCredit` reverts | `emit CashbackTransferFailed`, order completes normally |
| Vault-pull reverts during purchase | Partial fulfillment: credit unchanged for the failed pull amount; Diamond order placed for the larger delta |
| Both vaults empty | Partial fulfillment as above |
| `release` on insufficient vault balance | Reverts the inner vault call; outer try/catch in integrator falls through |

## Admin & ops surface

| Action | Who | How |
|---|---|---|
| Configure cashback rate + integrator | Diamond super-admin | `Diamond.setLotpotBuyerCashback(bps, integrator)` |
| Whitelist a credit issuer | V2 integrator owner | `integrator.setCreditIssuer(addr, true/false)` |
| Configure vault addresses | V2 integrator owner | `integrator.setVaults(grant, fallback)` |
| Approve integrator as vault spender | Vault owner | `vault.setApprovedSpender(integrator, true)` |
| Withdraw vault funds | Vault owner | `vault.withdraw(to, amount)` |

## Rollout sequence

1. Deploy `LotpotGrantVault` for P2P's fallback (P2P treasury owns + funds).
2. Share `LotpotGrantVault.sol` with Megapot team; they deploy + own + fund the primary grant vault.
3. Deploy `LotPotCheckoutIntegratorV2`.
4. Owner: `setVaults(megapotGrantVault, p2pFallbackVault)` and `setCreditIssuer(diamondAddr, true)`.
5. Megapot vault owner: `setApprovedSpender(v2IntegratorAddr, true)`.
6. P2P fallback vault owner: `setApprovedSpender(v2IntegratorAddr, true)`.
7. Diamond cut: add the new selectors (feature stays dormant — config defaults to zero).
8. Super-admin: `Diamond.setLotpotBuyerCashback(200, v2IntegratorAddr)` — cashback live.
9. Frontend cuts over to V2 integrator address.
10. Subgraph ships handlers for `CreditIssued`, `BuyerLotpotCashback`, `Released`, `Withdrawn`, `SpenderSet`.

## Explicit non-decisions

- **No issued-credit revocation.** Credits don't consume USDC until tickets are bought, so "revoking" is operationally moot.
- **No credit expiry.** Same rationale.
- **Vault owners can drain anytime.** By design — Megapot may want to recall unspent grant funds; P2P may want to rebalance the backstop. Integrator handles vault-empty gracefully via partial fulfillment.
- **No timelock on `setApprovedSpender` revocation.** Vault owner can revoke instantly; integrator's vault pull degrades to partial fulfillment.
- **No on-chain link from vault to the integrator.** Integrator points at vaults (via `setVaults`); vaults just whitelist callers. Allows one vault to back multiple integrators in the future.
- **No `BuyerLotpotCashback.proxy` event field.** Credit is ledger-only; no proxy address exists at issuance time.
