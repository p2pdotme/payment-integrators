# Whitelist request: MerchantTerminalIntegrator (Base Sepolia)

This follows the fields in `docs/WHITELISTING.md` §3.

| Field | Value |
| --- | --- |
| **Network** | `baseSepolia` (chainId 84532) |
| **Integrator address** | `0x6D6E52c92f59381c2dD993D6B73e76DB78e40853` |
| **Pinned `proxyImpl`** | `0xCc25BfE000ff490A5fb0Be4941b0B5670cAd2aF6` |
| **`usdcThroughIntegrator`** | `false`. The Diamond pays the merchant proxy, and `onOrderComplete` pulls the funds into the integrator. |
| **Cancel callback** | **Must be ON.** See "Required Diamond settings" below. |
| **Deployer / super-admin** | `0x4f45446a6E934Fd03A353eC4DAc7Cd544f03d426` |
| **Commit** | `4ea5ea2` (PR #108, branch `Payment-Links`) |
| **Runtime bytecode hash** | `0x1ca7e361adf0e22b93ea2f3c8c3f5a92d636ed6aefe9d2e26f2e8e64e185db76` |
| **Explorer verification** | Not yet submitted. See "Verification". |
| **Expected `circleId`(s)** | Supplied per order by the caller, not pinned in the contract. In use: the offramp circles for INR, BRL, ARS and VES. |
| **Operational contact** | forgebuilders@proton.me |

## Required Diamond settings

Two admin calls are needed on the Diamond:

```
registerIntegrator(0x6D6E52c92f59381c2dD993D6B73e76DB78e40853, 0xCc25BfE000ff490A5fb0Be4941b0B5670cAd2aF6, …)   // usdcThroughIntegrator = false
setIntegratorCancelCallback(0x6D6E52c92f59381c2dD993D6B73e76DB78e40853, true)
```

**The cancel callback is required, not optional.** When an order is cancelled, the Diamond calls `onOrderCancel`, and only that call gives back:

- the **link's use**, so a single-use invoice isn't used up by a customer who opened it and left;
- the merchant's **daily slot**, or their pending link reservation.

With the callback off, every abandoned tap on a single-use link uses that link up permanently, and `maxUses` counts abandoned attempts as well as payments.

Today the callback is **OFF** for the currently whitelisted integrator `0x4c4223DdfD0cc1a252013FBA4b8444eECda8A236` (checked with `getIntegratorConfig`: `cancelCallbackEnabled = false`). Please also enable it there while that integrator is live:

```
setIntegratorCancelCallback(0x4c4223DdfD0cc1a252013FBA4b8444eECda8A236, true)
```

## Contracts deployed in the same run

| Contract | Address | `keccak256(runtime)` |
| --- | --- | --- |
| `MerchantTerminalIntegrator` | `0x6D6E52c92f59381c2dD993D6B73e76DB78e40853` | `0x1ca7e361adf0e22b93ea2f3c8c3f5a92d636ed6aefe9d2e26f2e8e64e185db76` |
| `LinkRouter` | `0xD7c219bBC72B54498d27D3468AFb209Fa5546b73` | `0x15d961d4b80faa80cb9bcf368731c5fe8621401ad33532c5edcf1f7403494714` |
| `PaymentLinksLib` (library) | `0x1DFD8f5E96264b82F6018B7679D7De04efe0D154` | `0xc47ef8bf39b7a8d2d9e6cbc014338f6bf3addaf08be250995c1334829100561e` |
| `MerchantRegistryLib` (library) | `0xd59Bd7Ba66E865344577F3875b01E71e17046ad0` | `0xc462c8c7871b348af1e77567a7524bfbd959045ca45bd3dd0b6c25185c0160f7` |
| `SettlementLib` (library) | `0x814CA86FFa75cD0E70B6398CD967B83027622B26` | `0xfd0f54862ccd508190c2c903265fe08bb0c4da63c7ff2cccd042f68b12bed1ef` |
| `MerchantImportLib` (library, **new**) | `0x2AFF384946Cc90223BD857c0D7EE3E97f877799B` | `0x8d4d5a123c5a81d11de3dccf584caeb6a49cf5f4bd0bafbc74f5a8db249f10df` |
| `SimpleERC721Client` (price source) | `0x45DC87fA24e86C7F2b4d94e16fBA576Bc0f0edD1` | `0xbbf839ee55a1061911357464b7f0d33ea936aa21a04db51f401b37d5fc2c81f3` |

The four libraries are linked into the integrator by address and reached by `DELEGATECALL`, so their code runs in the integrator's own storage. The library addresses above were **confirmed in the integrator's deployed runtime bytecode**, not just copied from the deploy log.

## Constructor parameters and wiring

Constructor parameters:
- `diamond` = `0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9`
- `usdc` = `0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d`
- `extraOwners` = `[]`

Already set, and checked on-chain:
- **`setTrustedRelayer(0xD7c2…6b73)`:** the integrator's `trustedRelayer()` reads the LinkRouter, and `LinkRouter.integrator()` reads the integrator back.
- **`setPreviousIntegrators([0x4c42…A236, 0x2Edc…fDd6, 0x10A0…eAf])`,** newest first. This can be set only once.
  - Merchants registered on those integrators are carried over on first use, including the **frozen** flag, instead of registering again.
  - Simulated on-chain against two real merchants: both import.
- **Limits:** per-tx cap 50 USDC for INR and 100 USDC otherwise; 25 orders a day; 600 s settlement lock.
  - These values are now **hard ceilings**. Checked on-chain: `setDailyLimit(26)` and `setPerTxCap(INR, 101 USDC)` both revert, even for the super-admin.

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
3. **Hard ceilings** (review #4): `setPerTxCap` ≤ 100 USDC and `setDailyLimit` ≤ 25. They can be lowered, never raised.
4. **Size:** the back-compat shims `transferOwnership`, `addAdmin`, `removeAdmin` and the public `toCurrency` / `fromCurrency` wrappers were removed. Use `addOwner`, `setRole`, `transferSuperAdmin` and `getMerchantCurrency` instead. The integrator is 24,228 / 24,576 bytes.

## Operational notes

- **The super-admin must be a multisig before mainnet.** It sets `trustedRelayer` and the previous-integrator list, both root-of-trust powers. On this testnet deployment it is the deployer EOA.
- **Freeze on every live integrator.** Carry-over copies a freeze once, at import. A merchant frozen on an old integrator after being imported stays unfrozen on the new one, and the reverse is also true. To unfreeze an imported merchant on the new integrator, call `importMerchant(merchant)` then `unfreezeMerchant(merchant)`.
- **Relayer bounds** (`p2pdotme/payer-relayer`, reviewed separately). On top of the on-chain limits above, the relayer enforces:
  - a per-link cap on sponsored operations per UTC day (default 60, `MAX_SPONSORED_OPS_PER_LINK`), through the thirdweb server verifier;
  - rate limits per IP, per link, and per IP-and-link;
  - a proof-of-work human check on `/api/pay`.

## Test state

- **Contracts:** 950 passing, 0 failing, 42 pending (the live-Diamond conformance tests, which skip without an RPC).
- **Relayer:** 308 passing against this code on a local chain, including the end-to-end and concurrency suites.
- **Coverage run:** the opcode-scan test (review #5) now passes under coverage.

## Relationship to the existing deployments

`0x4c4223…A236` stays live and whitelisted until traffic has moved. Merchants hold balances there, and by design there is no fund-migration path. The app shows and withdraws balances from every previous integrator. A deregister request can follow once it has drained.

## Verification

Not yet submitted. Sourcify (exact match) is expected to be routine. The four libraries need verifying alongside the integrator.
