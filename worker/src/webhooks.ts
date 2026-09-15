/**
 * Webhook registration and delivery.
 *
 * The single rule: a `payment.completed` webhook fires ONLY after this Worker
 * has independently confirmed the completion on-chain. A browser saying "I
 * paid" is not evidence, and a merchant's accounting must never act on one.
 *
 * Webhook URLs are stored in PLAINTEXT here rather than in the link's encrypted
 * config. The merchant's relay key lives in per-device localStorage and is
 * cleared on logout, so a config encrypted on their phone is unreadable on
 * their laptop — a merchant would lose the ability to manage webhooks for
 * links they created months ago. A webhook URL is an endpoint, not a secret;
 * the HMAC signature is what authenticates delivery.
 */

import { decodeEventLog, type Address, type Hex, type PublicClient } from "viem";
import { INTEGRATOR_ABI, limitsFor, type Env } from "./config";
import { publicClientFor } from "./chain";
import { json, badRequest, clientIp } from "./http";
import { checkRateLimits } from "./limits";
import { recordFalseClaim, clearMarkPaid } from "./claims";

interface RegisterBody {
  linkId?: string;
  url?: string;
  nonce?: string;
  signature?: string;
}

/**
 * The message the link owner signs to register a webhook.
 *
 * Includes the chain id and the integrator address so a signature captured on
 * testnet cannot be replayed against mainnet, and a nonce so it cannot be
 * replayed at all.
 */
export function registrationMessage(
  linkId: string,
  url: string,
  nonce: string,
  chainId: number,
  integrator: string
): string {
  return [
    "PayQR webhook registration",
    `link: ${linkId.toLowerCase()}`,
    `url: ${url}`,
    `nonce: ${nonce}`,
    `chain: ${chainId}`,
    `integrator: ${integrator.toLowerCase()}`,
  ].join("\n");
}

/**
 * POST /api/links — register a webhook URL for a link you own.
 *
 * OWNERSHIP IS PROVED BY SIGNATURE, NOT CLAIMED IN THE BODY.
 * This used to take a `merchant` field from the request and check it against
 * the link's on-chain owner. But that owner is public — an indexed field of
 * `LinkCreated`, and readable through `getLink` — so anyone could read an
 * event and register their own URL against someone else's link. They would
 * receive every payment notification for it AND, because the write was
 * unconditional, silently displace the merchant's own. A merchant whose
 * fulfilment is driven by that webhook simply stops shipping, with nothing to
 * tell them why.
 *
 * The HMAC on delivery never helped here: it authenticates the DELIVERY, not
 * the REGISTRATION.
 */
export async function handleRegisterWebhook(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as RegisterBody;
  const linkId = String(body.linkId ?? "");
  const url = String(body.url ?? "");
  const nonce = String(body.nonce ?? "");
  const signature = String(body.signature ?? "");

  if (!/^0x[0-9a-fA-F]{64}$/.test(linkId)) return badRequest("Invalid link.");
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return badRequest("Invalid signature.");
  if (nonce.length === 0 || nonce.length > 128) return badRequest("Invalid nonce.");

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return badRequest("Enter a valid webhook URL.");
  }
  if (parsed.protocol !== "https:") return badRequest("Webhook URLs must use HTTPS.");

  // A webhook pointing back at this Worker turns delivery into a loop: the
  // merchant's own retry schedule quietly spends their rate limit and the
  // shared gas float. Self-inflicted, but nothing else here would stop it, and
  // there is no legitimate reason to register our own origin as a callback.
  if (isSelfTarget(parsed, req)) {
    return badRequest("That webhook URL points back at this service.");
  }

  // Unmetered before this point it was a free KV-write amplifier.
  const limited = await checkRateLimits(env, `hook:${linkId}`, clientIp(req));
  if (limited) return json({ error: limited }, 429);

  // One nonce, one registration.
  const nonceKey = `hook:nonce:${linkId}:${nonce}`;
  if (await env.KV.get(nonceKey)) return json({ error: "This request was already used." }, 409);

  const client = publicClientFor(env);
  const link = (await client
    .readContract({
      address: env.INTEGRATOR_ADDRESS as Address,
      abi: INTEGRATOR_ABI,
      functionName: "getLink",
      args: [linkId as Hex],
    })
    .catch(() => null)) as readonly [Address, ...unknown[]] | null;
  if (!link) return json({ error: "Link not found." }, 404);

  const message = registrationMessage(
    linkId,
    url,
    nonce,
    client.chain?.id ?? 0,
    env.INTEGRATOR_ADDRESS
  );

  // Verified AGAINST THE OWNER, not recovered to an address and compared.
  //
  // `recoverAddress` only understands EOAs. In production the merchant is a
  // smart account: a social login controls an owner key, but the address stored
  // as `link.owner` is the ACCOUNT. Recovering gave the key, the comparison
  // failed, and no real merchant could register a webhook at all — the same
  // shape of bug the provisioning endpoint had.
  //
  // `verifyMessage` on the public client asks a contract via ERC-1271 and does
  // ordinary recovery for an EOA, so both shapes work and the address checked
  // is the one the contract actually stores.
  let valid = false;
  try {
    valid = await client.verifyMessage({
      address: link[0],
      message,
      signature: signature as Hex,
    });
  } catch {
    return badRequest("Invalid signature.");
  }

  // The CURRENT owner, every time — a link that changed hands does not keep
  // honouring the previous owner's signature.
  if (!valid) {
    return json({ error: "That signature is not from this link's owner." }, 403);
  }

  await env.KV.put(nonceKey, "1", { expirationTtl: 604_800 });
  await env.KV.put(`hook:${linkId}`, url);
  return json({ ok: true });
}

/**
 * The message a MERCHANT signs to set a default webhook for all their links.
 *
 * Same shape as the per-link one, and for the same reasons: the chain id and
 * integrator stop a testnet signature being replayed against mainnet, and the
 * nonce stops it being replayed at all.
 */
export function merchantRegistrationMessage(
  merchant: string,
  url: string,
  nonce: string,
  chainId: number,
  integrator: string
): string {
  return [
    "PayQR merchant webhook registration",
    `merchant: ${merchant.toLowerCase()}`,
    `url: ${url}`,
    `nonce: ${nonce}`,
    `chain: ${chainId}`,
    `integrator: ${integrator.toLowerCase()}`,
  ].join("\n");
}

/**
 * POST /api/merchants/webhook — one callback for every link you own.
 *
 * WHY THIS EXISTS ALONGSIDE THE PER-LINK ROUTE
 * Registration was per LINK, so a merchant with five hundred links made five
 * hundred signed calls, and any link they forgot silently delivered nothing.
 * For the common case — "tell my backend whenever I am paid" — that is the
 * wrong unit.
 *
 * The per-link route stays, and still WINS when both are set: a merchant
 * running one link through a different system should not have to give up the
 * default for everything else.
 */
export async function handleRegisterMerchantWebhook(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as {
    merchant?: string;
    url?: string;
    nonce?: string;
    signature?: string;
  };
  const merchant = String(body.merchant ?? "");
  const url = String(body.url ?? "");
  const nonce = String(body.nonce ?? "");
  const signature = String(body.signature ?? "");

  if (!/^0x[0-9a-fA-F]{40}$/.test(merchant)) return badRequest("Invalid merchant.");
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return badRequest("Invalid signature.");
  if (nonce.length === 0 || nonce.length > 128) return badRequest("Invalid nonce.");

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return badRequest("Enter a valid webhook URL.");
  }
  if (parsed.protocol !== "https:") return badRequest("Webhook URLs must use HTTPS.");
  if (isSelfTarget(parsed, req)) {
    return badRequest("That webhook URL points back at this service.");
  }

  const limited = await checkRateLimits(env, `hook:m:${merchant.toLowerCase()}`, clientIp(req));
  if (limited) return json({ error: limited }, 429);

  const nonceKey = `hook:mnonce:${merchant.toLowerCase()}:${nonce}`;
  if (await env.KV.get(nonceKey)) return json({ error: "This request was already used." }, 409);

  const client = publicClientFor(env);

  // Must be a registered merchant. Anyone can name any address, so without this
  // the endpoint is a free KV write against an arbitrary key.
  const info = (await client
    .readContract({
      address: env.INTEGRATOR_ADDRESS as Address,
      abi: MERCHANT_INFO_ABI,
      functionName: "getMerchantInfo",
      args: [merchant as Address],
    })
    .catch(() => null)) as readonly [Hex, string, Hex, boolean, boolean] | null;
  if (!info || !info[3]) return json({ error: "Not a registered merchant." }, 404);

  const message = merchantRegistrationMessage(
    merchant,
    url,
    nonce,
    client.chain?.id ?? 0,
    env.INTEGRATOR_ADDRESS
  );

  // ERC-1271 aware, because the merchant is a smart account — see the per-link
  // route for what recovering to an EOA instead cost us.
  let valid = false;
  try {
    valid = await client.verifyMessage({
      address: merchant as Address,
      message,
      signature: signature as Hex,
    });
  } catch {
    return badRequest("Invalid signature.");
  }
  if (!valid) return json({ error: "That signature is not from this merchant." }, 403);

  await env.KV.put(nonceKey, "1", { expirationTtl: 604_800 });
  await env.KV.put(`hook:merchant:${merchant.toLowerCase()}`, url);
  return json({ ok: true, merchant, scope: "all links" });
}

const MERCHANT_INFO_ABI = [
  {
    type: "function",
    name: "getMerchantInfo",
    stateMutability: "view",
    inputs: [{ name: "merchant", type: "address" }],
    outputs: [
      { name: "encPayoutId", type: "bytes" },
      { name: "shopName", type: "string" },
      { name: "currency", type: "bytes32" },
      { name: "isRegistered", type: "bool" },
      { name: "isFrozen", type: "bool" },
    ],
  },
] as const;

/**
 * Where a notification for this link should go.
 *
 * The link's own URL wins, so a merchant can route one link somewhere else
 * without losing the default for everything else.
 */
export async function webhookUrlFor(
  env: Env,
  linkId: string,
  merchant: string
): Promise<string | null> {
  return (
    (await env.KV.get(`hook:${linkId}`)) ??
    (await env.KV.get(`hook:merchant:${merchant.toLowerCase()}`))
  );
}

/**
 * Whether a registered callback would loop back into this Worker.
 *
 * Host comparison only — resolving names is not available here, and Cloudflare's
 * edge already blocks private and link-local ranges, so the gap actually worth
 * closing is the self-referential one.
 */
function isSelfTarget(target: URL, req: Request): boolean {
  try {
    const self = new URL(req.url);
    return target.host.toLowerCase() === self.host.toLowerCase();
  } catch {
    return false;
  }
}

/** HMAC-SHA256 over the raw body, hex-encoded. */
async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const BACKOFF_MS = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000];

interface Pending {
  url: string;
  payload: string;
  attempt: number;
  nextAt: number;
}

/**
 * Scans for LinkOrderPlaced → OrderCompleted and queues a webhook for each
 * newly completed link order. Confirmation comes from the CHAIN, never from a
 * client ping.
 */
/**
 * Which link an order came from.
 *
 * Prefers the record the pay path writes, and falls back to the contract,
 * which is the authority: `orderToLink` is set inside `relayerPlaceOrder`, so
 * it exists for every link order whether or not the service managed to record
 * it. A POS order has no entry and returns null, which is how link orders are
 * told apart from counter sales.
 */
async function linkIdFor(env: Env, client: PublicClient, orderId: bigint): Promise<string | null> {
  const meta = await env.KV.get(`order:${orderId}`);
  if (meta) {
    try {
      const { linkId } = JSON.parse(meta) as { linkId?: string };
      if (linkId) return linkId.toLowerCase();
    } catch {
      // fall through to the chain
    }
  }

  const onChain = (await client
    .readContract({
      address: env.INTEGRATOR_ADDRESS as Address,
      abi: INTEGRATOR_ABI,
      functionName: "orderToLink",
      args: [orderId],
    })
    .catch(() => null)) as string | null;

  if (!onChain || /^0x0{64}$/.test(onChain)) return null;

  // Cache the recovered binding so the next scan does not pay for it again.
  await env.KV.put(`order:${orderId}`, JSON.stringify({ linkId: onChain.toLowerCase() }), {
    expirationTtl: 2_592_000,
  });
  return onChain.toLowerCase();
}

export async function scanAndQueue(env: Env): Promise<number> {
  const client = publicClientFor(env);
  const latest = await client.getBlockNumber();
  const from = BigInt(
    (await env.KV.get("hook:cursor")) ?? String(latest > 5000n ? latest - 5000n : 0n)
  );
  if (from >= latest) return 0;

  // Cloudflare-friendly window; the cursor makes this resumable.
  const span = limitsFor(env).logScanBlocks;
  const to = from + span > latest ? latest : from + span;

  // Filter at the node rather than pulling every event the integrator emits and
  // discarding most of them — this contract is chatty, and an unfiltered range
  // query is the thing that starts timing out first under real volume.
  const wanted = INTEGRATOR_ABI.filter(
    (e) =>
      e.type === "event" &&
      (e.name === "OrderCompleted" || e.name === "OrderCancelled" || e.name === "LinkOrderPlaced")
  ) as Extract<(typeof INTEGRATOR_ABI)[number], { type: "event" }>[];

  let queued = 0;
  for (const eventAbi of wanted) {
    const logs = await client.getLogs({
      address: env.INTEGRATOR_ADDRESS as Address,
      event: eventAbi,
      fromBlock: from,
      toBlock: to,
    });

    for (const log of logs) {
      let ev;
      try {
        ev = decodeEventLog({
          abi: INTEGRATOR_ABI,
          data: log.data,
          topics: log.topics as [Hex, ...Hex[]],
        });
      } catch {
        continue;
      }

      const a = ev.args as Record<string, unknown>;
      let event: string;
      let orderId: bigint;
      let merchant: Address;
      let amount: bigint | undefined;
      let linkId: string | null = null;

      if (ev.eventName === "OrderCompleted") {
        // The only one that means MONEY MOVED: the LP confirmed real fiat and
        // USDC settled. Safe to hang an activation or a token transfer off.
        event = "payment.completed";
        orderId = a.orderId as bigint;
        merchant = a.merchant as Address;
        amount = a.amount as bigint;
      } else if (ev.eventName === "OrderCancelled") {
        // Abandoned or expired. What a builder needs to release a held seat or
        // clear a pending row — without it they can only guess from silence.
        event = "payment.cancelled";
        orderId = a.orderId as bigint;
        merchant = a.merchant as Address;
      } else if (ev.eventName === "LinkOrderPlaced") {
        // A customer started paying. NOT money — deliberately a separate event
        // from completed, because acting on this one is how a merchant ships
        // goods for a payment that never arrives.
        event = "payment.placed";
        orderId = a.orderId as bigint;
        merchant = a.merchant as Address;
        amount = a.amount as bigint;
        linkId = String(a.linkId);

        // Remember the binding NOW, because it will not survive.
        //
        // `onOrderComplete` and `onOrderCancel` both `delete orderToLink[orderId]`
        // in the same transaction that emits their event. So by the time this
        // scan sees OrderCompleted, the on-chain binding `linkIdFor` falls back
        // to is already gone — and its other source, the `order:` record, is
        // written by `handlePay` only after a receipt lands, which the slow
        // 202 path never reaches.
        //
        // Both sources absent means the COMPLETION webhook is dropped: the one
        // event a merchant hangs fulfilment off, lost precisely for the payment
        // that took longest. Writing it here makes the placement the source of
        // truth, which is the one moment the link id is guaranteed present.
        await env.KV.put(
          `order:${orderId}`,
          JSON.stringify({ linkId: linkId.toLowerCase(), merchant }),
          { expirationTtl: 2_592_000 }
        );
      } else {
        continue;
      }

      // Only link orders — a POS sale has no link at all.
      //
      // The KV record is written after the receipt lands, so a slow
      // confirmation (the 202 path) never writes it: the customer pays, the LP
      // completes, and the merchant's notification is silently dropped for the
      // one order that took longest. The binding is on-chain regardless, so
      // fall back to it.
      linkId = linkId ?? (await linkIdFor(env, client, orderId));
      if (!linkId) continue;

      // Deduped per ORDER AND EVENT. Keying on the order alone would let the
      // first notification suppress every later one, so a merchant who got
      // "placed" would never hear that it completed.
      const sentKey = `hook:sent:${event}:${orderId}`;
      if (await env.KV.get(sentKey)) continue;

      const url = await webhookUrlFor(env, linkId, merchant);
      if (!url) continue;

      const payload = JSON.stringify({
        event,
        linkId,
        orderId: orderId.toString(),
        merchant,
        ...(amount === undefined ? {} : { amount: amount.toString() }),
        txHash: log.transactionHash,
        at: new Date().toISOString(),
      });

      const item: Pending = { url, payload, attempt: 0, nextAt: Date.now() };
      await env.KV.put(`hook:q:${event}:${orderId}`, JSON.stringify(item), {
        expirationTtl: 172_800,
      });
      queued++;
    }
  }

  await env.KV.put("hook:cursor", String(to));
  return queued;
}

/**
 * Delivers everything due, with backoff and a dead-letter for the rest.
 *
 * Capped at 50 per run to stay inside the Worker's CPU budget. Anything beyond
 * that waits for the next cron tick rather than being dropped — but a queue
 * that is persistently at the cap is a backlog, so say so out loud instead of
 * letting it look like everything was delivered.
 */
export async function deliverQueued(env: Env): Promise<number> {
  const BATCH = limitsFor(env).webhookBatch;
  const { keys, list_complete } = (await env.KV.list({
    prefix: "hook:q:",
    limit: BATCH,
  })) as { keys: { name: string }[]; list_complete: boolean };

  // Explicitly false, not merely falsy: an undefined from a KV implementation
  // that does not report it is not a backlog, and warning about one sends an
  // operator looking for a problem that is not there.
  if (list_complete === false) {
    console.warn(
      `[paylinks] webhook queue exceeds ${BATCH} this run; the remainder retries next tick`
    );
  }

  // A missing signing key is OUR misconfiguration, not the merchant's endpoint
  // being down — and treating it as the latter is how it stays hidden.
  //
  // `sign` throws "Zero-length key is not supported" without one. That lands in
  // the per-delivery catch below, counts as a failed attempt, burns the backoff
  // schedule and dead-letters the notification. Every webhook dies silently,
  // and the only visible symptom is merchants reporting they never hear from
  // us. Stopping here leaves the queue intact, so nothing is lost and the
  // deliveries go out once the key is set.
  if (!env.WEBHOOK_SIGNING_KEY) {
    console.error(
      "[paylinks] WEBHOOK_SIGNING_KEY is not set — refusing to deliver. " +
        "The queue is preserved; set the secret and deliveries resume."
    );
    return 0;
  }

  let delivered = 0;

  for (const k of keys) {
    const raw = await env.KV.get(k.name);
    if (!raw) continue;
    const item = JSON.parse(raw) as Pending;
    if (Date.now() < item.nextAt) continue;

    // "hook:q:<event>:<orderId>" — the queue key carries both, because the
    // scan dedupes on the pair. Keying on the order alone would let the first
    // notification suppress every later one, so a merchant who heard "placed"
    // would never hear that it completed.
    const suffix = k.name.slice("hook:q:".length);

    // The event is also read back out of the payload rather than parsed from
    // the key, so the header a merchant filters on always matches the body they
    // verify the signature over.
    let eventName = "payment.completed";
    try {
      eventName = String((JSON.parse(item.payload) as { event?: string }).event ?? eventName);
    } catch {
      /* payload is ours; fall back to the default rather than dropping it */
    }

    let ok = false;

    try {
      const signature = await sign(env.WEBHOOK_SIGNING_KEY, item.payload);
      const res = await fetch(item.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-PayQR-Signature": `sha256=${signature}`,
          "X-PayQR-Event": eventName,
        },
        body: item.payload,
        signal: AbortSignal.timeout(10_000),
      });
      ok = res.ok;
    } catch {
      ok = false;
    }

    if (ok) {
      await env.KV.delete(k.name);
      await env.KV.put(`hook:sent:${suffix}`, "1", { expirationTtl: 2_592_000 });
      delivered++;
      continue;
    }

    item.attempt++;
    if (item.attempt >= BACKOFF_MS.length) {
      // Out of retries — keep it visible for manual replay rather than
      // dropping a real payment notification on the floor.
      await env.KV.delete(k.name);
      await env.KV.put(`hook:dead:${suffix}`, raw, { expirationTtl: 2_592_000 });
      continue;
    }
    item.nextAt = Date.now() + BACKOFF_MS[item.attempt];
    await env.KV.put(k.name, JSON.stringify(item), { expirationTtl: 172_800 });
  }

  return delivered;
}

/**
 * Turns a broken "I have paid" claim into a strike against whoever made it.
 *
 * An order that was marked paid and then CANCELLED is the definition of a false
 * claim: the LP settles against their own bank, so a cancellation after a claim
 * means the money never arrived. An order that COMPLETED proves the claim was
 * honest, and the record is simply dropped.
 *
 * The contract already counts strikes per LINK, which is what the merchant needs
 * to see. This counts them per CLAIMANT, which is what actually stops a repeat
 * abuser — and it can only be done here, because the chain cannot see an IP.
 *
 * Runs on the schedule rather than inline: the outcome of a claim is not known
 * until the LP acts, which is minutes later.
 */
export async function sweepFalseClaims(env: Env): Promise<number> {
  const client = publicClientFor(env);
  const latest = await client.getBlockNumber();
  const from = BigInt(
    (await env.KV.get("claim:cursor")) ?? String(latest > 5000n ? latest - 5000n : 0n)
  );
  if (from >= latest) return 0;

  const span = limitsFor(env).logScanBlocks;
  const to = from + span > latest ? latest : from + span;

  const events = INTEGRATOR_ABI.filter(
    (e) => e.type === "event" && (e.name === "OrderCancelled" || e.name === "OrderCompleted")
  ) as Extract<(typeof INTEGRATOR_ABI)[number], { type: "event" }>[];

  let strikes = 0;
  for (const event of events) {
    const logs = await client.getLogs({
      address: env.INTEGRATOR_ADDRESS as Address,
      event,
      fromBlock: from,
      toBlock: to,
    });

    for (const log of logs) {
      let ev;
      try {
        ev = decodeEventLog({
          abi: INTEGRATOR_ABI,
          data: log.data,
          topics: log.topics as [Hex, ...Hex[]],
        });
      } catch {
        continue;
      }
      const orderId = (ev.args as unknown as { orderId?: bigint }).orderId;
      if (orderId === undefined) continue;

      if (ev.eventName === "OrderCancelled") {
        const ip = await recordFalseClaim(env, orderId);
        if (ip) {
          strikes++;
          console.warn(`[paylinks] false payment claim on order ${orderId} from ${ip}`);
        }
      } else if (ev.eventName === "OrderCompleted") {
        await clearMarkPaid(env, orderId);
      }
    }
  }

  await env.KV.put("claim:cursor", String(to));
  return strikes;
}
