# Whitelist request: MerchantTerminalIntegrator (Base Sepolia)

This follows the fields in `docs/WHITELISTING.md` §3.

| Field | Value |
| --- | --- |
| **Network** | `baseSepolia` (chainId 84532) |
| **Integrator address** | `0xf865c81BE4C02CDB6115401CF451BfB4507C3C37` |
| **Pinned `proxyImpl`** | `0x5A8Cb2A2b20c31E6B5833b2ba20471Edb4C2eb47` |
| **`usdcThroughIntegrator`** | `false`. The Diamond pays the merchant proxy, and `onOrderComplete` pulls the funds into the integrator. |
| **Cancel callback** | **Must be ON.** See "Required Diamond settings" below. |
| **Deployer / super-admin** | `0x4f45446a6E934Fd03A353eC4DAc7Cd544f03d426` |
| **Commit** | see the head of PR #108, branch `Payment-Links` |
| **Runtime bytecode hash** | `0x3c4dc8ab1853c48b8dbbbb7afabeef7d7a73581436d01bf73a17016b3d4aaa44` |
| **Explorer verification** | Not yet submitted. See "Verification". |
| **Expected `circleId`(s)** | Supplied per order by the caller, not pinned in the contract. In use: the offramp circles for INR, BRL, ARS and VES. |
| **Operational contact** | forgebuilders@proton.me |

## Required Diamond settings

Two admin calls are needed on the Diamond:

```
registerIntegrator(0xf865c81BE4C02CDB6115401CF451BfB4507C3C37, 0x5A8Cb2A2b20c31E6B5833b2ba20471Edb4C2eb47, …)   // usdcThroughIntegrator = false
setIntegratorCancelCallback(0xf865c81BE4C02CDB6115401CF451BfB4507C3C37, true)
```

**The cancel callback is required, not optional.** When an order is cancelled, the Diamond calls `onOrderCancel`, and only that call gives back:

- the **link's use**, so a single-use invoice isn't used up by a customer who opened it and left;
- the merchant's **daily slot**, or their pending link reservation.

With the callback off, every abandoned tap on a single-use link uses that link up permanently, and `maxUses` counts abandoned attempts as well as payments.

Today the callback is **OFF** for the currently whitelisted integrator `0x4c4223DdfD0cc1a252013FBA4b8444eECda8A236` (checked with `getIntegratorConfig`: third field `cancelCallbackEnabled = 0`). Please also enable it there while that integrator is live:

```
setIntegratorCancelCallback(0x4c4223DdfD0cc1a252013FBA4b8444eECda8A236, true)
```

## Contracts deployed in the same run

| Contract | Address | `keccak256(runtime)` |
| --- | --- | --- |
| `MerchantTerminalIntegrator` | `0xf865c81BE4C02CDB6115401CF451BfB4507C3C37` | `0x3c4dc8ab1853c48b8dbbbb7afabeef7d7a73581436d01bf73a17016b3d4aaa44` |
| `LinkRouter` | `0x418F522Ca1c4e0ff8baFE0676189f23bb51Ce625` | `0xc647ab63c349fef296f1024844a7237a3885ca6930f108f081ff31fdf0d71e80` |
| `PaymentLinksLib` (library) | `0xc7DaC45d5516D1374466ADb69c577663Bd4Ae10D` | `0xf570d58cd954db7dd050ce0a63207ee7f7319dad3e9f2d952497ee7603105788` |
| `MerchantRegistryLib` (library) | `0x78057cf258E1E531B4da9061BE2C6F4091D1006e` | `0x0465203af2fe680ee5b2daf0674ab08ff4a1677c9457b6b49e550bb3b7b27020` |
| `SettlementLib` (library) | `0xD69ba40c5262A83699781502a63b758848B32448` | `0x54ceefc37877bc720ab406345e39e0b1bdf55507f4796b90890cfdad54f0a365` |
| `MerchantImportLib` (library, **new**) | `0x6E2C2bF7188A9e53A90f0fA253491ea89fc4152c` | `0x8d098eb4fac22a57e333a7898815eab1372d63228e3905b516d3b5fb070f58d5` |
| `SimpleERC721Client` (price source) | `0x55C8B5156526E6Ae630532eA5031632EE53945e8` | `0xd808a9ab79bbae4f66f3d5ec68033cd27309f2112cf15c90cae4f5f500907f99` |

The four libraries are linked into the integrator by address and reached by `DELEGATECALL`, so their code runs in the integrator's own storage. The library addresses above were **confirmed in the integrator's deployed runtime bytecode**, not just copied from the deploy log.

## Constructor parameters and wiring

Constructor parameters:
- `diamond` = `0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9`
- `usdc` = `0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d`
- `extraOwners` = `[]`

Already set, and checked on-chain:
- **`setTrustedRelayer(0x418F…e625)`:** the integrator's `trustedRelayer()` reads the LinkRouter, and `LinkRouter.integrator()` reads the integrator back.
- **`setPreviousIntegrators([0x4c42…A236, 0x2Edc…fDd6, 0x10A0…eAf])`,** newest first. This can be set only once.
  - Merchants registered on those integrators are carried over on first use, including the **frozen** flag, instead of registering again.
  - Simulated on-chain against two real merchants: both import.
- **Limits (starting values):** per-tx cap 50 USDC for INR and 100 USDC otherwise; 25 orders a day; 600 s settlement lock.
  - **Limit range (see change 3):** starts at 1–25 orders a day and 1–100 USDC a sale (`limitBounds()`). Checked on-chain: `setDailyLimit(1000)` is refused as outside the range; an owner can widen the range with `setLimitBounds`, after which it is accepted; a merchant can change neither.
- **Admin roles copied** from the previous integrators at deployment (`scripts/lib/copyRoles.ts`): every current owner and VIEWER/SUPPORT/MANAGER/FINANCE, read from live state (a revoked admin is not copied). On Base Sepolia the only current role holder is the deployer, who is already root here, so nothing extra was granted.

## Changes since the currently whitelisted integrator (`0x4c42…`)

1. **Carry-over (`MerchantImportLib`).** Merchants of previous integrators are imported on `registerMerchant`, `userPlaceOrder`, `createLink`, or through the permissionless `importMerchant`.
   - The frozen flag is copied.
   - A merchant known to a previous integrator can't register fresh (`AlreadyRegistered`), so they can't leave a freeze behind by re-registering.
   - A sector the oldest integrator never had becomes "Unspecified".
   - Lowercase currencies are uppercased.
2. **Daily limit for link orders** (PR #108 review #3).
   - A link order takes a **pending reservation** for the UTC day, and placement requires `paid + pending < dailyLimit`.
   - Mark-paid turns the reservation into a counted sale.
   - A cancel, or a completion without mark-paid, releases it.
   - Link sales are bounded on-chain again, and pending link orders never block counter (POS) sales.
3. **A min/max range around the limits (review #4), adjustable, in two tiers.**
   - `setLimitBounds(minDaily, maxDaily, minCap, maxCap)`, for **FINANCE admins, owners and the super-admin**, sets the range. `limitBounds()` reads it. It starts at 1–25 orders a day and 1–100 USDC a sale.
   - `setDailyLimit` / `setPerTxCap`, for **MANAGER admins and above**, move the limits only inside that range (`LimitOutOfBounds` otherwise). A MANAGER can move a limit but never its max.
   - Narrowing the range takes effect at once: the live daily limit is pulled into it, and every per-tx cap (defaults and existing overrides) is clamped on read.
   - Every change emits `LimitBoundsSet` / `DailyLimitSet` / `PerTxCapSet`, and before mainnet the super-admin (who grants the roles) is a multisig.
   - **Difference from audit F1:** the range is adjustable by the top admin tier rather than an immutable `MAX_*` constant, so the business can grow limits without a redeploy. This is the owner's choice and needs P2P sign-off.
4. **Carried-over currencies re-checked.** An imported code is uppercased; one still not A–Z (e.g. "US$") is not carried over, and that merchant registers fresh with a valid code — unless frozen on the old integrator, in which case it is imported frozen so the freeze can't be escaped.
5. **Super-admin → multisig tooling.** `deploy-link-router.ts` (after `setTrustedRelayer`) proposes the handoff to `SUPER_ADMIN_MULTISIG`; both deploy scripts refuse to run on mainnet without it and reject an EOA, a non-Safe or a 1-of-N Safe. The printed Safe batch is `acceptSuperAdmin()` + `removeOwner(deployer)`, so the deployer key ends with no access. `scripts/handoff-super-admin.ts ACTION=status` confirms it.
6. **Size:**
   - The back-compat shims `transferOwnership`, `addAdmin`, `removeAdmin` and the public `toCurrency` / `fromCurrency` wrappers were removed. Use `addOwner`, `setRole`, `transferSuperAdmin` and `getMerchantCurrency` instead.
   - The limit logic lives in `MerchantRegistryLib`.
   - The redundant getters `perTxCapOverride`, `lockPeriodOverride`, `PER_TX_CAP_INR` and `PER_TX_CAP_DEFAULT` are internal. Use `perTxCap(currency)` and `lockPeriod(currency)` instead.
   - The integrator is 24,503 / 24,576 bytes.

## Operational notes

- **The super-admin must be a multisig before mainnet — now enforced by the deploy tooling** (see change 5). It sets `trustedRelayer` and the previous-integrator list, both root-of-trust powers. On this testnet deployment it is still the deployer EOA; handing it over is one command plus one Safe batch.
- **Freeze on every live integrator.** Carry-over copies a freeze once, at import. A merchant frozen on an old integrator after being imported stays unfrozen on the new one, and the reverse is also true. To unfreeze an imported merchant on the new integrator, call `importMerchant(merchant)` then `unfreezeMerchant(merchant)`.
- **Relayer bounds** (`p2pdotme/payer-relayer`, reviewed separately). On top of the on-chain limits above, the relayer enforces:
  - a per-link cap on sponsored operations per UTC day (default 60, `MAX_SPONSORED_OPS_PER_LINK`), through the thirdweb server verifier;
  - rate limits per IP, per link, and per IP-and-link;
  - a proof-of-work human check on `/api/pay`.

## Test state

- **Contracts:** 962 passing, 0 failing, 42 pending (the live-Diamond conformance tests, which skip without an RPC).
- **Relayer:** 308 passing against this code on a local chain, including the end-to-end and concurrency suites.
- **Fork of Base Sepolia, against the REAL Diamond and THIS deployment** (`scripts/fork-e2e.ts` with `FORK_INTEGRATOR=0xf865…3C37`: the exact bytecode above, 45 checks, all passing). On a local fork, with the two whitelist calls above made by impersonating the Diamond super-admin:
  - a counter sale and a payment-link sale placed, accepted by a real P2P merchant (`0xa8e6…Cdd9c`, INR circle 1), marked paid and completed; the merchant is credited exactly;
  - a customer cancel through the real Diamond runs `onOrderCancel` and returns the link's use (the cancel-callback requirement, demonstrated);
  - link sales stop at the daily limit;
  - a MANAGER can't pass the max or change the range; a FINANCE admin widens it and the MANAGER then raises the limit; narrowing it pulls the limits back at once;
  - a real merchant of `0x4c42` is carried over with no registration; a merchant frozen on `0x4c42` arrives frozen;
  - roles are copied from the three real previous integrators;
  - the super-admin is handed to a real Safe v1.4.1 (2-of-3), after which the deployer key cannot set the relayer, add owners or change limits, and the Safe can.
- **The deploy scripts themselves** were run on the fork end to end (integrator, role copy, router, handoff proposal and Safe batch) before the live deploy.
- **Coverage run:** the opcode-scan test (review #5) passes under coverage.

## Relationship to the existing deployments

`0x4c4223…A236` stays live and whitelisted until traffic has moved. Merchants hold balances there, and by design there is no fund-migration path. The app shows and withdraws balances from every previous integrator. A deregister request can follow once it has drained.

## Verification

Not yet submitted. Sourcify (exact match) is expected to be routine. The four libraries need verifying alongside the integrator.
