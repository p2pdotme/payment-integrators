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
import { limitsFor } from "./config";
import { publicClientFor, relayerFor } from "./chain";
import { checkBalance } from "./limits";
import { handlePay } from "./pay";
import { handleRelayTx } from "./relayTx";
import { handleRegisterWebhook, scanAndQueue, deliverQueued, sweepFalseClaims } from "./webhooks";
import { json, corsHeaders } from "./http";
import { turnstileEnabled } from "./turnstile";

export { LinkLock, NonceManager, GasBudget } from "./durable";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const origin = req.headers.get("Origin");
    const cors = corsHeaders(env, origin);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    const path = url.pathname;

    let res: Response;

    if (req.method === "GET" && path === "/health") {
      res = await health(env);
    } else if (req.method === "POST" && path.startsWith("/api/pay/")) {
      res = await handlePay(req, env, path.slice("/api/pay/".length));
    } else if (req.method === "POST" && path === "/api/relay-tx") {
      res = await handleRelayTx(req, env);
    } else if (req.method === "POST" && path === "/api/links") {
      res = await handleRegisterWebhook(req, env);
    } else {
      res = json({ error: "Not found." }, 404);
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

          const client = publicClientFor(env);
          const { address } = relayerFor(env);
          const balance = await client.getBalance({ address });
          const warning = await checkBalance(env, balance, address);
          if (warning) console.warn(`[paylinks] ${warning}`);

          console.log(
            `[paylinks] queued=${queued} delivered=${delivered} strikes=${strikes} balance=${balance} wei`
          );
        } catch (err) {
          console.error("[paylinks] scheduled run failed:", err);
        }
      })()
    );
  },
};

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
    const { address } = relayerFor(env);
    const [block, balance] = await Promise.all([
      client.getBlockNumber(),
      client.getBalance({ address }),
    ]);
    return json({
      ok: true,
      lowBalance: balance < limitsFor(env).lowBalanceWei,
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
