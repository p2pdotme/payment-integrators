# Whitelist request — MerchantTerminalIntegrator (Base Sepolia)

Fields per `docs/WHITELISTING.md` §3.

| Field | Value |
| --- | --- |
| **Network** | `baseSepolia` (chainId 84532) |
| **Integrator address** | `0x2Edcf5E918F181d8CE5b15827a78Ebd83A0efDd6` |
| **Pinned `proxyImpl`** | `0xf64845fED7a800CD0A115CedF04ACBb036593a90` |
| **`usdcThroughIntegrator`** | `false` — the Diamond pays the merchant proxy; `onOrderComplete` pulls into the integrator |
| **Deployer address** | `0x4f45446a6E934Fd03A353eC4DAc7Cd544f03d426` |
| **Commit hash** | `01d28f8` (branch `payments-pr`) |
| **Bytecode hash** | `0x63608b6aaf6acf9f2544fb4f6cdc6bb433600858340a4ec01ac638cd3f65917c` |
| **Explorer verification** | _not yet submitted — see "Verification" below_ |
| **Expected `circleId`(s)** | Caller-supplied per order, not pinned in the contract. In use: the offramp circles for INR, BRL, ARS and VES. |
| **Operational contact** | forgebuilders@proton.me |

## Side artifacts deployed in the same run

| Contract | Address | `keccak256(runtime)` |
| --- | --- | --- |
| `MerchantTerminalIntegrator` | `0x2Edcf5E918F181d8CE5b15827a78Ebd83A0efDd6` | `0x63608b6aaf6acf9f2544fb4f6cdc6bb433600858340a4ec01ac638cd3f65917c` |
| `LinkRouter` | `0x5D0f847DF5F9db0B631273e59Af57E19DF60CFb6` | `0x8dc5bea35569f70600ede849ee7bda7940ba66f3bb47b95350997f416580d226` |
| `PaymentLinksLib` (library) | `0xb8E8E9C1C94898004E2EcB7c4eae43E68fa08c12` | `0xaedd0a3201707b70c17fdc00133e6da20c80a880c1957c6b503a66ba8cb96fbf` |
| `MerchantRegistryLib` (library, **new**) | `0x5e96d5ebAF66b4d80e0126cBcdF4bF732f7F2207` | `0x49f58402c8078504e17d1fa00a6eff9fa92d2230129fef615bafd851bdb6152e` |
| `SettlementLib` (library, **new**) | `0x950824A8cF237f84658a93dF7f14d2226871c0f1` | `0xca140440053cf005414d511e100f8cafa50db65a9a61314197f452452f2d990c` |
| `SimpleERC721Client` (price source) | `0x506cB651737c91f4fFE568531AF2131D5Bec7fDa` | `0xec48b16ea4b31e239b2c430b096af179803092d185f1ba89a250fff25e973e69` |

The three libraries are linked into the integrator by address and reached by
`DELEGATECALL`, so their code executes in the integrator's own storage context.
The library addresses above were read back out of the deployed integrator's
runtime bytecode at its link sites, not taken from the deploy log.

## Constructor parameters

- `diamond` = `0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9`
- `usdc` = `0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d`
- `extraOwners` = `[]`

Read back and asserted after deployment: `usdc()`, `diamond()` and
`superAdmin()` all match, `ownerCount()` is 1. On-chain limits as deployed:
`PER_TX_CAP` 50.0 USDC, `DAILY_TX_LIMIT` 25/day, `SETTLEMENT_PERIOD` 600s.

## Wiring already done

`setTrustedRelayer(0x5D0f847DF5F9db0B631273e59Af57E19DF60CFb6)` — confirmed
on-chain in both directions: the integrator's `trustedRelayer()` reads the
LinkRouter and `LinkRouter.integrator()` reads back the integrator. The price
client's product 2 reads 1 (1e-6 USDC/unit).

## What changed since the previously whitelisted deployment

**This is not the same source.** The currently whitelisted integrator
(`0x10A08aa7D5078C7210Ba848941ACC36982701eAf`) predates three changes, and
reviewers should expect a real diff rather than an address rotation.

**1. Registration (breaking ABI).** `registerMerchant` and `registerMerchantRaw`
take a required `bytes32 businessSector`; `updateProfile` takes it too, so the
field can be corrected later. The encrypted payout handle is now OPTIONAL at
registration and required at the point of fiat withdrawal instead — a merchant
can open an account before choosing a cash-out rail, but cannot place a SELL
without one. `getMerchantInfo` returns a sixth value.

**2. Merchant link enumeration.** `createLink` now also appends the link id to
`mapping(address => bytes32[])`, exposed by `getMerchantLinks(owner, offset,
limit)` and `getMerchantLinkCount(owner)`. The array is append-only: nothing is
removed on revoke, because swap-and-pop would reorder the tail under a caller
paginating by offset and make it skip a link between pages. A revoked link stays
listed and reads REVOKED through `getLink`.

**3. A library extraction, forced by EIP-170.** The previous integrator sat at
24,515 of 24,576 bytes. Neither change above fit alone (533 and ~491 bytes over
respectively). `SettlementLib` now holds `creditBucket`, `compact` and
`deductUnlocked`; `MerchantRegistryLib` holds the currency codecs and
registration validation; `MerchantTypes` holds the structs so the libraries can
name them.

The bucket-merge logic was **copied, not rewritten** — including the round-1
FIX D and round-2 #7 comments that record two previously-found bugs in it. The
one structural difference: `totalOwed` did not move. Solidity cannot pass a
`uint256 storage` pointer to a plain state variable, and wrapping it in a struct
would relocate the number the solvency invariant is written against, so
`creditBucket` returns what it credited and the integrator applies it. There are
exactly three writes to `totalOwed` and all three are in the integrator.

## Test and audit state

904 passing, 42 pending, 0 failing. Coverage over the merchant-terminal suites:
`MerchantRegistryLib` 100% / 88.9% branch, `SettlementLib` 100% / 84.4%,
`MerchantTypes` 100%, `MerchantTerminalIntegrator` 96.4% / 82.2%.

Three defects were found and fixed during a self-audit of the changes above,
recorded here because two of them were invisible to the test suite:

1. The new payout-handle requirement was placed in `_checkWithdraw`, which
   `withdrawUSDC` shares — locking merchants out of their own USDC, a rail the
   handle has nothing to do with. Since registration now starts empty, that was
   every new merchant. Moved to `_withdrawFiat`, which both fiat entry points
   funnel through. No existing test caught it because all of them register WITH
   a handle.
2. `businessSector` was write-once: required at registration and absent from
   `updateProfile`, so a typo was permanent.
3. Two library getters were left unreachable after their callers were inlined —
   caught by coverage falling from 100% to 83%, not by any failing test.

The remaining uncovered branches in `SettlementLib` (the "no timestamp bump
needed" arms) require an incoming credit whose unlock time is older than its
merge host's, which cannot arise while buckets are created chronologically.

## Relationship to the existing deployment

`0x10A08aa7D5078C7210Ba848941ACC36982701eAf` stays live and should remain
whitelisted until traffic has moved — merchants hold balances on it and there is
no fund-migration path by design. A deregister request can follow.

## Verification

Not submitted for this deployment. `docs/WHITELISTING.md` §2 accepts Sourcify in
place of Etherscan, and an earlier deployment of this project verified there at
the **exact match** tier without an API key, so this is expected to be routine —
say the word and it will be submitted before review. Note that the three
libraries need verifying alongside the integrator.

A Basescan verification additionally needs a `BASESCAN_API_KEY`, which the
deployer does not currently hold.
