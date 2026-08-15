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

import { decodeEventLog, type Address, type Hex } from "viem";
import { INTEGRATOR_ABI, limitsFor, type Env } from "./config";
import { publicClientFor } from "./chain";
import { json, badRequest } from "./http";

interface RegisterBody {
  linkId?: string;
  url?: string;
  merchant?: string;
}

/** POST /api/links — register a webhook URL for a link the caller owns. */
export async function handleRegisterWebhook(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as RegisterBody;
  const linkId = String(body.linkId ?? "");
  const url = String(body.url ?? "");
  const merchant = String(body.merchant ?? "");

  if (!/^0x[0-9a-fA-F]{64}$/.test(linkId)) return badRequest("Invalid link.");
  if (!/^0x[0-9a-fA-F]{40}$/.test(merchant)) return badRequest("Invalid merchant address.");

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return badRequest("Enter a valid webhook URL.");
  }
  if (parsed.protocol !== "https:") return badRequest("Webhook URLs must use HTTPS.");

  // Ownership is checked against the chain, not against the request.
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
  if (link[0].toLowerCase() !== merchant.toLowerCase()) {
    return json({ error: "You do not own this link." }, 403);
  }

  await env.KV.put(`hook:${linkId}`, url);
  return json({ ok: true });
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

    // Only link orders — a POS sale has no linkId recorded here.
    const meta = await env.KV.get(`order:${orderId}`);
    if (!meta) continue;
    const { linkId } = JSON.parse(meta) as { linkId: string };

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
