# Whitelist request: MerchantTerminalIntegrator (Base Sepolia)

This follows the fields in `docs/WHITELISTING.md` §3.

| Field | Value |
| --- | --- |
| **Network** | `baseSepolia` (chainId 84532) |
| **Integrator address** | `0x63945885b00d003cd73e79705aab4c719c44eDAe` |
| **Pinned `proxyImpl`** | `0xBc9C3Cf06fdFc1ccEcb77e3e3D2195D0374e1882` |
| **`usdcThroughIntegrator`** | `false`. The Diamond pays the merchant proxy, and `onOrderComplete` pulls the funds into the integrator. |
| **Cancel callback** | **Must be ON.** See "Required Diamond settings" below. |
| **Deployer / super-admin** | `0x4f45446a6E934Fd03A353eC4DAc7Cd544f03d426` |
| **Commit** | see the head of PR #108, branch `Payment-Links` |
| **Runtime bytecode hash** | `0xcc53a221fa71ef0c812bacc7cbb80b0377319861a6dbc28c97e474181c3d0eb3` |
| **Explorer verification** | Not yet submitted. See "Verification". |
| **Expected `circleId`(s)** | Supplied per order by the caller, not pinned in the contract. In use: the offramp circles for INR, BRL, ARS and VES. |
| **Operational contact** | forgebuilders@proton.me |

## Required Diamond settings

Two admin calls are needed on the Diamond:

```
registerIntegrator(0x63945885b00d003cd73e79705aab4c719c44eDAe, 0xBc9C3Cf06fdFc1ccEcb77e3e3D2195D0374e1882, …)   // usdcThroughIntegrator = false
setIntegratorCancelCallback(0x63945885b00d003cd73e79705aab4c719c44eDAe, true)
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
| `MerchantTerminalIntegrator` | `0x63945885b00d003cd73e79705aab4c719c44eDAe` | `0xcc53a221fa71ef0c812bacc7cbb80b0377319861a6dbc28c97e474181c3d0eb3` |
| `LinkRouter` | `0xE7444923cf5471750b0FCb65d1fe9DcEA7486246` | `0xd1e779fd27740b19da55a13f6926afb1a614971264a691d757ce7fab6dd43f70` |
| `PaymentLinksLib` (library) | `0x3d4bBD29E27Cbe9DA86812e1AB540BB118636ab9` | `0x18421a60952488886d4740385b5abc1359fd5cdb9d634383a1315e637b9cc54e` |
| `MerchantRegistryLib` (library) | `0x1313a34b96f59bc59d503D700bFFDf7972A43e56` | `0xc462c8c7871b348af1e77567a7524bfbd959045ca45bd3dd0b6c25185c0160f7` |
| `SettlementLib` (library) | `0x11Ec9ed02445d84ab3D6CED4104925E5e7c48307` | `0xe7b07dccdbd5a6c018e05e79e1fcd16b36384bd9ef53234bd793b569e1202fd2` |
| `MerchantImportLib` (library, **new**) | `0x3D0Fa855F3De3Da94c7877222845cF54cE027afe` | `0xb15de812348e7f6987d1362b5800c3fac7eb4460fa91730fe8c0856de9a15f0c` |
| `SimpleERC721Client` (price source) | `0xd2CcDb0862Da4CF4058f24b93574DFFFd5EC5Bf1` | `0xf43d0cf7f016552c9de4fd8b5870a573e4afd7cc5c9f9170c6662a87336fe021` |

The four libraries are linked into the integrator by address and reached by `DELEGATECALL`, so their code runs in the integrator's own storage. The library addresses above were **confirmed in the integrator's deployed runtime bytecode**, not just copied from the deploy log.

## Constructor parameters and wiring

Constructor parameters:
- `diamond` = `0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9`
- `usdc` = `0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d`
- `extraOwners` = `[]`

Already set, and checked on-chain:
- **`setTrustedRelayer(0xE744…7246)`:** the integrator's `trustedRelayer()` reads the LinkRouter, and `LinkRouter.integrator()` reads the integrator back.
- **`setPreviousIntegrators([0x4c42…A236, 0x2Edc…fDd6, 0x10A0…eAf])`,** newest first. This can be set only once.
  - Merchants registered on those integrators are carried over on first use, including the **frozen** flag, instead of registering again.
  - Simulated on-chain against two real merchants: both import.
- **Limits (starting values):** per-tx cap 50 USDC for INR and 100 USDC otherwise; 25 orders a day; 600 s settlement lock.
  - **No hard ceiling** (owner decision, see change 3 below). A MANAGER, FINANCE or owner can raise or lower them. Checked on-chain with `eth_call`: `setDailyLimit(1000)` and `setPerTxCap(INR, 1000 USDC)` are accepted from an owner and refused from a merchant.
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
3. **Limits are uncapped — owner decision on review #4.** The integrator's owner chose that the business sets the limits with no hard ceiling, so `setPerTxCap` and `setDailyLimit` accept any value above zero. What bounds them instead: only MANAGER/FINANCE/owners can change them, every change emits `PerTxCapSet` / `DailyLimitSet`, and before mainnet the super-admin (who grants those roles) is a multisig. **This needs explicit sign-off from P2P**, since audit F1 asked for immutable `MAX_*` ceilings.
5. **Carried-over currencies re-checked.** An imported code is uppercased; one still not A–Z (e.g. "US$") is not carried over, and that merchant registers fresh with a valid code — unless frozen on the old integrator, in which case it is imported frozen so the freeze can't be escaped.
6. **Super-admin → multisig tooling.** `deploy-link-router.ts` (after `setTrustedRelayer`) proposes the handoff to `SUPER_ADMIN_MULTISIG`; both deploy scripts refuse to run on mainnet without it and reject an EOA, a non-Safe or a 1-of-N Safe. The printed Safe batch is `acceptSuperAdmin()` + `removeOwner(deployer)`, so the deployer key ends with no access. `scripts/handoff-super-admin.ts ACTION=status` confirms it.
4. **Size:** the back-compat shims `transferOwnership`, `addAdmin`, `removeAdmin` and the public `toCurrency` / `fromCurrency` wrappers were removed. Use `addOwner`, `setRole`, `transferSuperAdmin` and `getMerchantCurrency` instead. The integrator is 24,185 / 24,576 bytes.

## Operational notes

- **The super-admin must be a multisig before mainnet — now enforced by the deploy tooling** (see change 6). It sets `trustedRelayer` and the previous-integrator list, both root-of-trust powers. On this testnet deployment it is still the deployer EOA; handing it over is one command plus one Safe batch.
- **Freeze on every live integrator.** Carry-over copies a freeze once, at import. A merchant frozen on an old integrator after being imported stays unfrozen on the new one, and the reverse is also true. To unfreeze an imported merchant on the new integrator, call `importMerchant(merchant)` then `unfreezeMerchant(merchant)`.
- **Relayer bounds** (`p2pdotme/payer-relayer`, reviewed separately). On top of the on-chain limits above, the relayer enforces:
  - a per-link cap on sponsored operations per UTC day (default 60, `MAX_SPONSORED_OPS_PER_LINK`), through the thirdweb server verifier;
  - rate limits per IP, per link, and per IP-and-link;
  - a proof-of-work human check on `/api/pay`.

## Test state

- **Contracts:** 957 passing, 0 failing, 42 pending (the live-Diamond conformance tests, which skip without an RPC).
- **Relayer:** 308 passing against this code on a local chain, including the end-to-end and concurrency suites.
- **Fork of Base Sepolia, against the REAL Diamond** (`scripts/fork-e2e.ts`, 40 checks, all passing). On a local fork, with the two whitelist calls above made by impersonating the Diamond super-admin:
  - a counter sale and a payment-link sale placed, accepted by a real P2P merchant (`0xa8e6…Cdd9c`, INR circle 1), marked paid and completed; the merchant is credited exactly;
  - a customer cancel through the real Diamond runs `onOrderCancel` and returns the link's use (the cancel-callback requirement, demonstrated);
  - link sales stop at the daily limit, and resume after an admin raises it;
  - a real merchant of `0x4c42` is carried over with no registration; a merchant frozen on `0x4c42` arrives frozen;
  - roles are copied from the three real previous integrators;
  - the super-admin is handed to a real Safe v1.4.1 (2-of-3), after which the deployer key cannot set the relayer, add owners or change limits, and the Safe can.
- **The deploy scripts themselves** were run on the fork end to end (integrator, role copy, router, handoff proposal and Safe batch) before the live deploy.
- **Coverage run:** the opcode-scan test (review #5) passes under coverage.

## Relationship to the existing deployments

`0x4c4223…A236` stays live and whitelisted until traffic has moved. Merchants hold balances there, and by design there is no fund-migration path. The app shows and withdraws balances from every previous integrator. A deregister request can follow once it has drained.

## Verification

Not yet submitted. Sourcify (exact match) is expected to be routine. The four libraries need verifying alongside the integrator.
