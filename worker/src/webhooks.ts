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

import {
  decodeEventLog,
  hashMessage,
  recoverAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
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

  let recovered: Address;
  try {
    recovered = await recoverAddress({
      hash: hashMessage(message),
      signature: signature as Hex,
    });
  } catch {
    return badRequest("Invalid signature.");
  }

  // The CURRENT owner, every time — a link that changed hands does not keep
  // honouring the previous owner's signature.
  if (recovered.toLowerCase() !== link[0].toLowerCase()) {
    return json({ error: "That signature is not from this link's owner." }, 403);
  }

  await env.KV.put(nonceKey, "1", { expirationTtl: 604_800 });
  await env.KV.put(`hook:${linkId}`, url);
  return json({ ok: true });
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

  // Filter to OrderCompleted at the node rather than pulling every event the
  // integrator emits and discarding most of them — this contract is chatty,
  // and an unfiltered range query is the thing that starts timing out first
  // under real volume.
  const completedEvent = INTEGRATOR_ABI.find(
    (e) => e.type === "event" && e.name === "OrderCompleted"
  ) as Extract<(typeof INTEGRATOR_ABI)[number], { type: "event" }>;

  const logs = await client.getLogs({
    address: env.INTEGRATOR_ADDRESS as Address,
    event: completedEvent,
    fromBlock: from,
    toBlock: to,
  });

  let queued = 0;
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
    if (ev.eventName !== "OrderCompleted") continue;

    const { orderId, merchant, amount } = ev.args as unknown as {
      orderId: bigint;
      merchant: Address;
      amount: bigint;
    };

    // Only link orders — a POS sale has no link at all.
    //
    // The KV record is written after the receipt lands, so a slow confirmation
    // (the 202 path) never writes it: the customer pays, the LP completes, and
    // the merchant's notification is silently dropped for the one order that
    // took longest. The binding is on-chain regardless, so fall back to it.
    const linkId = await linkIdFor(env, client, orderId);
    if (!linkId) continue;

    if (await env.KV.get(`hook:sent:${orderId}`)) continue;
    const url = await env.KV.get(`hook:${linkId}`);
    if (!url) continue;

    const payload = JSON.stringify({
      event: "payment.completed",
      linkId,
      orderId: orderId.toString(),
      merchant,
      amount: amount.toString(),
      txHash: log.transactionHash,
      at: new Date().toISOString(),
    });

    const item: Pending = { url, payload, attempt: 0, nextAt: Date.now() };
    await env.KV.put(`hook:q:${orderId}`, JSON.stringify(item), { expirationTtl: 172_800 });
    queued++;
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

  if (!list_complete) {
    console.warn(
      `[paylinks] webhook queue exceeds ${BATCH} this run; the remainder retries next tick`
    );
  }

  let delivered = 0;

  for (const k of keys) {
    const raw = await env.KV.get(k.name);
    if (!raw) continue;
    const item = JSON.parse(raw) as Pending;
    if (Date.now() < item.nextAt) continue;

    const orderId = k.name.slice("hook:q:".length);
    let ok = false;

    try {
      const signature = await sign(env.WEBHOOK_SIGNING_KEY, item.payload);
      const res = await fetch(item.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-PayQR-Signature": `sha256=${signature}`,
          "X-PayQR-Event": "payment.completed",
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
      await env.KV.put(`hook:sent:${orderId}`, "1", { expirationTtl: 2_592_000 });
      delivered++;
      continue;
    }

    item.attempt++;
    if (item.attempt >= BACKOFF_MS.length) {
      // Out of retries — keep it visible for manual replay rather than
      // dropping a real payment notification on the floor.
      await env.KV.delete(k.name);
      await env.KV.put(`hook:dead:${orderId}`, raw, { expirationTtl: 2_592_000 });
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
