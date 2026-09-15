/**
 * PayQR payment-links relayer.
 *
 * Places orders on a merchant's behalf when a walletless customer pays a link.
 * The wallet it holds can call exactly one function on our integrator —
 * `relayerPlaceOrder` — and is never a registered merchant, so it has no path
 * to anyone's funds. See the contract's own guards for the real boundary; this
 * service is convenience and cost control.
 */

import type { Env } from "./config";
import { publicClientFor } from "./chain";
import { handlePay } from "./pay";
import { handleRelayTx } from "./relayTx";
import {
  handleRegisterWebhook,
  handleRegisterMerchantWebhook,
  scanAndQueue,
  deliverQueued,
  sweepFalseClaims,
} from "./webhooks";
import { json, corsHeaders } from "./http";
import { turnstileEnabled } from "./turnstile";
import { handleSponsorCheck } from "./sponsor";
import { handleAdmin } from "./admin";
import { handleProvisionWallet } from "./provision";

export { LinkLock, NonceManager, GasBudget } from "./durable";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const origin = req.headers.get("Origin");
    const cors = corsHeaders(env, origin);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    const path = url.pathname;

    let res: Response;

    try {
      res = await route(req, env, path);
    } catch (err) {
      // ROUND-4 L6, generalised. CORS headers are applied below, AFTER the
      // handler returns — so ANY throw in ANY route escaped this function
      // entirely and reached the browser as a bare 500 with no CORS headers.
      // The pay page cannot read such a response at all: it surfaces as an
      // opaque network error, indistinguishable from the Worker being down.
      //
      // L6 was one instance (an out-of-range KV TTL throwing inside `put`), but
      // the shape is general, so the boundary belongs here rather than around
      // any single route. Log the detail; tell the caller nothing but that it
      // failed.
      console.error(`[paylinks] unhandled error on ${req.method} ${path}:`, err);
      res = json({ error: "Something went wrong. Please try again." }, 500);
    }

    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },

  /** Every 5 minutes: confirm completions, deliver webhooks, watch the float. */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const queued = await scanAndQueue(env);
          const delivered = await deliverQueued(env);
          const strikes = await sweepFalseClaims(env);

          // The relayer balance check is gone with the relayer. Watching a
          // wallet whose emptiness is the design told an operator nothing, and
          // made RELAYER_PRIVATE_KEY a hard requirement for a cron that no
          // longer needs it. What needs watching now is the sponsorship budget,
          // which lives at the provider.
          console.log(`[paylinks] queued=${queued} delivered=${delivered} strikes=${strikes}`);
        } catch (err) {
          console.error("[paylinks] scheduled run failed:", err);
        }
      })()
    );
  },
};

/** The route table itself. Kept separate so `fetch` can wrap it in one place. */
async function route(req: Request, env: Env, path: string): Promise<Response> {
    let res: Response;

    if (req.method === "GET" && path === "/health") {
      res = await health(env);
    } else if (req.method === "POST" && path.startsWith("/api/pay/")) {
      res = await handlePay(req, env, path.slice("/api/pay/".length));
    } else if (req.method === "POST" && path === "/api/relay-tx") {
      res = await handleRelayTx(req, env);
    } else if (req.method === "POST" && /^\/api\/links\/[^/]+\/wallet$/.test(path)) {
      // Mints the wallet a link is driven by, and returns the address the
      // merchant batches into registerAgent. Without this nothing in
      // production ever creates a link wallet, and every payment fails with
      // "this link is no longer active" (round-3 B1).
      res = await handleProvisionWallet(
        req,
        env,
        path.slice("/api/links/".length, -"/wallet".length)
      );
    } else if (req.method === "POST" && path === "/api/merchants/webhook") {
      // One callback for every link a merchant owns. The per-link route still
      // wins where both are set.
      res = await handleRegisterMerchantWebhook(req, env);
    } else if (req.method === "POST" && path === "/api/links") {
      res = await handleRegisterWebhook(req, env);
    } else if (path === "/api/admin/blocks") {
      // Operator only. Authorised against the INTEGRATOR'S OWN ROLES — the
      // super-admin and every owner qualify, an admin assigned on-chain gains
      // access, one removed loses it. No shared secret to distribute or rotate,
      // and every action is attributable to a wallet rather than to whoever had
      // the password. See adminAuth.ts.
      res = await handleAdmin(req, env);
    } else if (req.method === "POST" && path === "/api/sponsor-check") {
      // Called by the sponsorship provider, not by users. This is where the
      // per-link ceiling lives — the built-in rules are global only, so it is
      // not a dashboard setting and must not be described as one.
      res = await handleSponsorCheck(req, env);
    } else {
      res = json({ error: "Not found." }, 404);
    }

    return res;
}

/**
 * Liveness only.
 *
 * This endpoint is public, so it deliberately does NOT report the relayer's
 * address or its exact balance: together those tell an attacker precisely how
 * much gas it would take to drain the float, and when they have succeeded.
 * `lowBalance` is the one bit operations actually needs, and it is already
 * logged with full detail by the scheduled run.
 */
async function health(env: Env): Promise<Response> {
  try {
    const client = publicClientFor(env);
    const block = await client.getBlockNumber();

    // No relayer balance any more, and no `lowBalance` flag.
    //
    // Round-3 review, L4: reporting one was actively misleading. The relayer
    // key is not on the payment path — the sender is each link's own account,
    // which holds nothing by design — so a "low balance" signal described a
    // wallet whose emptiness is the point, and an operator watching it would be
    // watching the wrong thing. It also made `RELAYER_PRIVATE_KEY` a hard
    // requirement for liveness on a deployment that no longer needs it for
    // payments.
    //
    // What still needs watching is the SPONSORSHIP budget, which lives at the
    // provider and is not ours to report here.
    return json({
      ok: true,
      block: block.toString(),
      // AUDIT N2. Whether the human-cost gate is actually live is not
      // something an operator should have to infer from a deploy log. It is
      // a boolean, not the secret, so it leaks nothing an attacker could not
      // learn by sending one request.
      turnstile: turnstileEnabled(env),
    });
  } catch {
    // Never echo the upstream error — it can carry the RPC URL and key material
    // from a viem request dump.
    return json({ ok: false }, 503);
  }
}
