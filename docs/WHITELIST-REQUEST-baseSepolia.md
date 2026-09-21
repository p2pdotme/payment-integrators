# Whitelist request — MerchantTerminalIntegrator (Base Sepolia)

Fields per `docs/WHITELISTING.md` §3.

| Field | Value |
| --- | --- |
| **Network** | `baseSepolia` (chainId 84532) |
| **Integrator address** | `0x03670F6896d564cCA9D862d35Be2CcfB0060dC78` |
| **Pinned `proxyImpl`** | `0x13f07F7f6eC427A6D8C49b43DD3c982d47d9d6b9` |
| **`usdcThroughIntegrator`** | `false` — the Diamond pays the merchant proxy; `onOrderComplete` pulls into the integrator |
| **Deployer address** | `0x4f45446a6E934Fd03A353eC4DAc7Cd544f03d426` |
| **Commit hash** | `3771a44` (branch `payments-pr`) |
| **Bytecode hash** | `0x1e35db18d471226279c23cd795221233d7b98e07276eb2fe2db99d40b7b1e453` |
| **Explorer verification** | _pending — see "Verification" below_ |
| **Expected `circleId`(s)** | Caller-supplied per order, not pinned in the contract. In use: the offramp circles for INR, BRL, ARS and VES. |
| **Operational contact** | forgebuilders@proton.me |

## Side artifacts deployed in the same run

| Contract | Address | `keccak256(runtime)` |
| --- | --- | --- |
| `MerchantTerminalIntegrator` | `0x03670F6896d564cCA9D862d35Be2CcfB0060dC78` | `0x1e35db18d471226279c23cd795221233d7b98e07276eb2fe2db99d40b7b1e453` |
| `LinkRouter` | `0x451E1146b41D2f0DDfD59469720ceB9535af6EA1` | `0x2a57e009fdb01b472b5eeb6a2565235c363da0e3a57daffb131007646e294d55` |
| `PaymentLinksLib` (external library) | `0x83116f463A8f09806721e35452be3328c0F4DAB9` | `0xf63688ba1d38a12603f96853a01bd9a16943c9039b8c9fcfc6141e9041312284` |
| `SimpleERC721Client` (price source) | `0x9E7cF48F6BA13AFd74729A0987b532F4EbAabf83` | `0xad155a2ccd62538dcfce7f3ed50ef367baa59f7a6943f8d650a508bd6cb168ea` |

## Constructor parameters

- `diamond` = `0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9`
- `usdc` = `0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d`
- `extraOwners` = `[]`

Both addresses are read back and asserted by the deploy script after deployment (`usdc()` and `diamond()` equal the constructor args), and re-confirmed independently afterwards. On-chain limits as deployed: `PER_TX_CAP` 50.0 USDC, `DAILY_TX_LIMIT` 25/day, `SETTLEMENT_PERIOD` 600s. `superAdmin()` is the deployer; `ownerCount()` is 1.

## Wiring already done

`setTrustedRelayer(0x451E1146b41D2f0DDfD59469720ceB9535af6EA1)` — confirmed on-chain in both directions: the integrator's `trustedRelayer()` reads the LinkRouter, and `LinkRouter.integrator()` reads back the integrator. The price client's product 2 is priced at 1 (1e-6 USDC/unit), confirmed by reading `getProductPrice(2)`.

## Relationship to the existing whitelisted deployment

This replaces `0x10A08aa7D5078C7210Ba848941ACC36982701eAf` (currently `isActive: true`), which stays live so merchants can drain balances held on it — there is no fund-migration path and none is needed.

Reviewers diffing the two should know up front: the contract **source is unchanged** from the currently-whitelisted deployment. This redeploy carries no Solidity change and was requested operationally. The two differ only in address, immutables and the new `proxyImpl`.

## Prior end-to-end evidence (§5)

Two orders settled end-to-end on Base Sepolia against a previous deployment of this same source, including `onOrderComplete` execution: orders **750** and **759**. An equivalent run against this deployment will follow once it is whitelisted.

## Verification

Not yet submitted for this deployment. `docs/WHITELISTING.md` §2 accepts Sourcify in place of Etherscan, and the previous deployment of this identical source verified on Sourcify at the **exact match** tier (runtime bytecode, creation bytecode and metadata hash all matching) — so verification here is expected to be routine. Say the word and it will be submitted before review.

A Basescan verification needs a `BASESCAN_API_KEY`, which the deployer does not currently hold.
