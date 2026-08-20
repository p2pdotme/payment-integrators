# Worker tests

```
limits.test.ts     10  gas ceilings, quantity bounds        (no chain)
relayTx.test.ts    15  allowlist shape, revert messages     (no chain)
e2e.test.ts        23  the real payment path                (needs a chain)
                   ──
                   48
```

## Unit tests

```bash
npm test
```

`limits` and `relayTx` need nothing running. They pin the things that are cheap
to get wrong and expensive to discover late: that the allowlisted selectors
really are `cancelOrder` and `paidBuyOrder`, that `submitLivenessAttestation`
is *not* on the list, that a gas reservation is released when nothing was
broadcast, and that no raw revert string can reach a customer.

## End-to-end

`e2e.test.ts` drives the **real handlers** — `handlePay`, `handleRelayTx` —
with real `Request` objects, a real RPC, real signing, and real receipts. Only
the Cloudflare bindings are substituted, and the Durable Object stand-ins run
the same one-request-at-a-time logic the platform provides, so the concurrency
tests exercise the real behaviour rather than a mock of it.

```bash
# 1. a local chain
cd ../payment-integrators
npx hardhat node

# 2. deploy + register a merchant + appoint and fund the relayer
npx hardhat run scripts/e2e-setup.js --network localhost

# 3. run
cd ../worker
npx vitest run test/e2e.test.ts
```

Step 2 writes `test/e2e-addresses.json`. Re-run it after restarting the node.

The suite is re-runnable against a long-lived node: link ids are namespaced per
run, and each request gets its own source IP so the per-IP limiter doesn't trip
partway through and mask a real failure.

### What it proves

| | |
|---|---|
| **The payment works** | A walletless customer pays; the order is recorded against the link's owner. The merchant signed nothing. |
| **The body cannot move money** | A tampered `quantity` on a fixed link is ignored — the amount comes from the chain. `1e30` is rejected before any gas is spent. |
| **Concurrency** | Two customers, two different links, same instant — both succeed. This is the nonce bug the global sequencer exists to prevent. A double-tap on one link places exactly one order. |
| **Lifecycle** | Revoked links stop paying immediately, with no cache to go stale. Expired links refuse. Single-use links consume. |
| **relay-tx is narrow** | Rejects a non-Diamond target, a non-allowlisted selector, an order we never placed, and calldata with a trailing argument. |
| **The relayer's boundary** | Never a registered merchant; holds zero USDC through a real payment. |
| **Settlement parity** | A link sale lands as *pending* under the normal lock, then unlocks on the ordinary schedule. |

### Two bugs this suite caught

**Wrapped reverts reached the customer as gibberish.** `validateOrder`'s guards
— frozen merchant, per-tx cap, daily limit — run inside the Diamond call, so
they surface as `CallFailed(bytes)` with only the inner selector. The error
name is nowhere in the message, so matching on names left a customer who hit a
real daily limit staring at "This payment could not be started."

It surfaced because the test merchant genuinely exhausted their 25/day quota
mid-run. `explainRevert` now decodes the wrapped selector first.

**Link ids collided on re-run.** Fixed ids only work against a fresh chain;
the second run failed with `LinkExists`. Namespaced per run.
