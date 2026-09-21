# Merchant link enumeration

How a merchant gets the list of payment links they own, why the obvious answer
is the wrong one, and what ships today.

Three places in `payqr/lib/paymentLinks.ts` pointed at this document before it
existed. This is that document.

## The problem

A merchant opens the payment-links page and expects to see their links. There is
no cheap way to produce that list.

Links live in `mapping(bytes32 => PaymentLink) links` on the integrator. A
mapping answers one question — *who owns THIS link* — and cannot answer the
reverse. Solidity mappings are not enumerable, and the storage layout keeps no
record of which keys were ever written. So `getLink(linkId)` is easy and
`getLinksFor(merchant)` does not exist at any price.

The only on-chain record of the reverse direction is the event log:

```solidity
event LinkCreated(bytes32 indexed linkId, address indexed owner, …);
```

`owner` is an indexed topic, so `eth_getLogs` filtered on it returns exactly the
right set. That is what the frontend did.

## Why the log scan is not good enough

It works, and it degrades **silently**, which is the part that matters.

`fetchMerchantLinkEvents` walks backwards from the chain tip in chunks. RPC
providers cap the block range per `eth_getLogs` call, and they disagree wildly
about the cap: Base Sepolia's public endpoint allows roughly 10,000 blocks, an
Alchemy key on the free tier allows **ten**. The scan adapts — it halves the
chunk on a range error and retries — but on a ten-block cap a 200,000-block
lookback becomes ~20,000 sequential requests, enough that the browser itself
starts refusing connections with `ERR_INSUFFICIENT_RESOURCES`.

So the scan carries `MAX_SCAN_REQUESTS`, and when it hits that ceiling it stops
and returns what it found. No error, no flag, no partial-result indicator. A
merchant whose oldest link fell outside the window is simply never shown it, and
nothing on the page suggests anything is missing. `maxLookbackBlocks` defaults to
2,000 specifically to keep the request count bounded — which on Base's ~2s
blocks is about **an hour of history**.

A merchant who cannot see a link cannot revoke it. That is the real cost.

## Option A — `getMerchantLinks` on the integrator

Add `mapping(address => bytes32[]) merchantLinks`, push on create, expose a
paginated `getMerchantLinks(owner, offset, limit)` view.

Trustless and exact. Also the most expensive option on every axis:

- A cold `SSTORE` for the array slot on every link creation, forever, paid by
  every merchant — to serve a dashboard read.
- The array only grows. Nothing removes an entry on revoke, because removal from
  a Solidity array is either O(n) or reorders the array under a paginating
  caller.
- The getter loads the array into memory before slicing. Past some link count it
  exceeds the block gas limit on an `eth_call`, and it does so for precisely the
  busiest merchants — the ones who need the list most.
- It is new bytecode: a fresh deploy and a fresh whitelist request.

`payqr/lib/paymentLinks.ts` already contains `fetchMerchantLinkIds`, written
speculatively against this shape. It is **not deployed** on any integrator, so
the call reverts and the caller falls through. Harmless to keep — it costs one
failed `eth_call` and starts working by itself if this ever ships.

## Option B — index `LinkCreated` in a subgraph

The event already carries everything needed, and a subgraph turns the reverse
lookup into one GraphQL query with no scanning and no range caps.

Blocked on someone else. The subgraph this app reads
(`NEXT_PUBLIC_SUBGRAPH_URL`) is the p2p protocol's own `event-indexer`. Its
schema exposes 104 entities, all Diamond-side — circles, orders, merchants,
metrics — and **none** of them index our integrator's events. Getting
`LinkCreated` in there means the p2p team adding this integrator to their
subgraph manifest, or us running a second subgraph and paying to host it.

Right answer eventually. Not one we can ship unilaterally.

## Option C — index in the relayer worker  ← **shipped**

The worker already holds every link. `handleProvisionWallet` mints the link's
wallet, and to do that it **verifies the merchant's signature first**
(`verifyMerchant`). At that moment it holds a proven merchant address and the
linkId in the same scope. One KV write there gives the reverse index.

```
mlink:<merchant-lowercase>:<linkId>  →  {"at": <unix seconds>}
```

`KV.list({ prefix })` then enumerates a merchant's links directly. No scanning,
no range caps, no contract change, nothing to whitelist.

Implementation: `worker/src/linkIndex.ts`, wired into `worker/src/provision.ts`,
served at `GET /api/merchants/:address/links`.

### What it is honest about

**It is incomplete, and it says so.** The index knows only links minted through
the worker since it shipped. Nothing backfills. `listMerchantLinks` returns
`indexedFrom` — the epoch at which indexing began — and the endpoint sets
`partial: true`, so a caller can distinguish "this merchant has two links" from
"this index only started watching on Tuesday". Presenting a partial list as
complete is the exact failure being fixed; repeating it quietly would be worse
than the scan.

The frontend therefore **merges** four sources rather than picking one:

1. `getMerchantLinks` — Option A, if it is ever deployed.
2. This index — everything since it shipped, from any device.
3. The log scan — only when the cheap sources return nothing.
4. `rememberedLinks` — ids this browser recorded at creation.

Each is partial in a different direction, so falling through to the first that
answers just picks one blind spot to keep. (2) is what covers the case neither
(3) nor (4) can: a link this merchant created on a **different device**, older
than the scan window.

Every field rendered still comes from `getLink` on-chain. The index supplies
ids and nothing else, so a stale id costs one lookup and is dropped, and the
worker cannot influence what a link claims to be.

### Why the endpoint is unauthenticated

Because a signature there would protect nothing and cost real usability.

`LinkCreated` declares `owner` as an indexed topic and `getLink` returns it —
merchant→links is already derivable by anyone with an archival RPC.
`worker/src/webhooks.ts` makes the same observation about link ownership being
public, and handles it the right way: it does not try to hide the owner, it
requires a signature for the one thing that actually matters, *writing*.

Requiring one to read would put a wallet prompt in front of the merchant's own
dashboard on every load, to guard data a log filter already yields. So the
endpoint is open and rate-limited, and the discipline sits on the response
instead: ids only. No amounts, no encrypted config, no payout handle, no wallet
key material — nothing that is not already a public topic.

## If Option B becomes available

Delete Option C's frontend source and query the subgraph. The worker index and
its endpoint can stay as a fallback, or go. Option A stays unbuilt unless a
trustless read is specifically required, in which case the gas cost and the
unbounded-array growth both need answering first.
