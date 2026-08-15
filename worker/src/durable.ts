/**
 * Two Durable Objects, each solving a different concurrency problem.
 */

import { limitsFor, type Env } from "./config";
import { publicClientFor, relayerFor } from "./chain";

/**
 * NonceManager — ONE global instance for the whole Worker.
 *
 * The relayer is a single EOA, so every payment it signs draws from one nonce
 * sequence. Two customers paying two DIFFERENT links in the same second would
 * otherwise both read the same pending nonce from the RPC, and the second
 * transaction would be silently dropped by the mempool — no error anywhere,
 * a customer watching a spinner that never resolves.
 *
 * Per-link locking cannot fix this: the collision is across links. It has to
 * be one lock for the whole account, which is what this is.
 *
 * Durable Objects are single-threaded per instance, so `allocate` is
 * serialized by construction.
 */
export class NonceManager {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/allocate") {
      let next = await this.state.storage.get<number>("nonce");

      // Cold start, or after a resync: trust the chain.
      if (next === undefined) next = await this.chainNonce();

      // Guard against drift: if the chain has moved past our counter (a
      // manual transaction, or a redeploy), jump forward rather than
      // re-issuing nonces that will bounce.
      const onChain = await this.maybeResync(next);
      if (onChain > next) next = onChain;

      await this.state.storage.put("nonce", next + 1);
      return Response.json({ nonce: next });
    }

    if (url.pathname === "/resync") {
      // Called after a send fails: discard our counter and re-read the chain
      // on the next allocate, so one bad transaction cannot wedge the queue.
      await this.state.storage.delete("nonce");
      return Response.json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  }

  private async chainNonce(): Promise<number> {
    const client = publicClientFor(this.env);
    const { address } = relayerFor(this.env);
    return client.getTransactionCount({ address, blockTag: "pending" });
  }

  /** Re-reads the chain at most once a minute — this is a safety net, not a poll. */
  private async maybeResync(current: number): Promise<number> {
    const last = (await this.state.storage.get<number>("lastCheck")) ?? 0;
    const now = Date.now();
    if (now - last < 60_000) return current;
    await this.state.storage.put("lastCheck", now);
    try {
      return await this.chainNonce();
    } catch {
      return current; // RPC hiccup — keep our own counter rather than stalling
    }
  }
}

/**
 * LinkLock — one instance per linkId.
 *
 * Stops a double-tap (or an impatient customer refreshing) from firing two
 * transactions for the same link. This is a COST optimization, not the safety
 * boundary: the contract's own `LinkAlreadyUsed` is what actually guarantees a
 * single-use link is never paid twice, even if this lock were bypassed
 * entirely.
 */
export class LinkLock {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const HOLD_MS = limitsFor(this.env).linkLockSeconds * 1000;

    if (url.pathname === "/acquire") {
      const until = (await this.state.storage.get<number>("until")) ?? 0;
      const now = Date.now();
      if (now < until) {
        return Response.json({ ok: false, retryInMs: until - now });
      }
      await this.state.storage.put("until", now + HOLD_MS);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/release") {
      await this.state.storage.delete("until");
      return Response.json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  }
}
