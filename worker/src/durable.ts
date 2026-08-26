/**
 * Three Durable Objects, each solving a different concurrency problem.
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
/**
 * How long the chain may lag our counter before we treat it as a hole rather
 * than a transaction still in flight. Generous: re-issuing a nonce that is
 * genuinely pending would replace a real payment.
 */
const STUCK_NONCE_MS = 300_000;

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
      let issued = 0;

      // blockConcurrencyWhile is what actually makes this atomic.
      //
      // A Durable Object's input gate closes around STORAGE operations, not
      // around fetch(). The chain reads below sit between the get and the put,
      // so without this the gate reopens mid-sequence: two concurrent
      // allocations both read N and both are handed N. One transaction is then
      // silently dropped — the customer gets a hash that never lands, and its
      // gas reservation is never released. The in-memory test double
      // serialises whole calls, so the 50-way race test cannot see this.
      await this.state.blockConcurrencyWhile(async () => {
        let next = await this.state.storage.get<number>("nonce");

        // Cold start, or after a resync: trust the chain.
        if (next === undefined) next = await this.chainNonce();

        // Drift in either direction. Forward: someone sent a manual
        // transaction, or we redeployed — jump ahead rather than re-issuing
        // nonces that will bounce. Backward: a broadcast transaction was
        // dropped (fee spike, eviction) and left a hole that every later
        // payment queues behind. That one only heals if we come back down.
        const onChain = await this.maybeResync(next);
        if (onChain !== next && onChain >= 0) next = onChain;

        await this.state.storage.put("nonce", next + 1);
        issued = next;
      });

      return Response.json({ nonce: issued });
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

  /**
   * Re-reads the chain periodically — a safety net, not a poll.
   *
   * Returns the chain's value in BOTH directions. Only ever moving forward
   * meant a dropped broadcast left a permanent hole: our counter sat one (or
   * more) above what the chain had actually accepted, and every subsequent
   * payment queued behind a nonce that would never land, until an operator
   * noticed and filled it by hand.
   *
   * Coming back down is only safe once the gap has PERSISTED — a pending
   * transaction legitimately makes the chain count lag ours for a few seconds,
   * and resyncing then would re-issue a nonce that is still in flight.
   */
  private async maybeResync(current: number): Promise<number> {
    const last = (await this.state.storage.get<number>("lastCheck")) ?? 0;
    const now = Date.now();
    if (now - last < 60_000) return current;
    await this.state.storage.put("lastCheck", now);

    let onChain: number;
    try {
      onChain = await this.chainNonce();
    } catch {
      return current; // RPC hiccup — keep our own counter rather than stalling
    }

    if (onChain > current) return onChain; // drift forward: always follow
    if (onChain === current) {
      await this.state.storage.delete("gapSince");
      return current;
    }

    // The chain is BEHIND us. Normal while a transaction is pending; a stuck
    // hole if it stays that way. Only heal once it has been stuck a while.
    const gapSince = (await this.state.storage.get<number>("gapSince")) ?? 0;
    if (gapSince === 0) {
      await this.state.storage.put("gapSince", now);
      return current;
    }
    if (now - gapSince < STUCK_NONCE_MS) return current;

    await this.state.storage.delete("gapSince");
    return onChain;
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

/**
 * GasBudget — ONE global instance, guarding the relayer's float.
 *
 * This was a read-modify-write on Workers KV, which is eventually consistent
 * with edge-cached reads: fifty simultaneous requests all read the same value
 * and all write value+1. The counter said 1; fifty transactions went out. A
 * ceiling that only holds when nobody is pushing on it is not a ceiling, and
 * this particular one is the only thing between a spam wave and a drained
 * float.
 *
 * A Durable Object is single-threaded per instance, so reserve/release are
 * serialized by construction.
 *
 * Two further corrections over the KV version:
 *   • It books what is actually SENT (estimate x gasBufferPct), not the raw
 *     estimate — the old version systematically under-counted by the buffer.
 *   • It counts WEI, not gas units. The budget exists to protect a balance
 *     denominated in ETH; a gas-price spike drains that balance while a
 *     unit-denominated counter still reads healthy.
 */
export class GasBudget {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  /** Reads one day-stamped counter, treating a stale day as zero. */
  private async readCounter(key: string, day: number): Promise<bigint> {
    const stored = await this.state.storage.get<{ day: number; spent: string }>(key);
    if (!stored || stored.day !== day) return 0n;
    return BigInt(stored.spent);
  }

  private async writeCounter(key: string, day: number, spent: bigint): Promise<void> {
    await this.state.storage.put(key, { day, spent: spent.toString() });
  }

  /**
   * Drops per-link and per-merchant counters left over from previous days.
   *
   * Storage in a DO has no TTL, so without this the scoped counters grow by
   * one key per active link per day forever. Runs only when the global day
   * rolls over, so it is once a day rather than once a request.
   */
  private async sweepStaleScopes(day: number): Promise<void> {
    const entries = await this.state.storage.list<{ day: number; spent: string }>({
      prefix: "scope:",
    });
    const stale: string[] = [];
    for (const [key, value] of entries) {
      if (!value || value.day !== day) stale.push(key);
    }
    if (stale.length) await this.state.storage.delete(stale);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { maxGasWeiPerTx, maxGasWeiPerDay, maxGasWeiPerLinkPerDay, maxGasWeiPerMerchantPerDay } =
      limitsFor(this.env);
    const body = (await req.json().catch(() => ({}))) as {
      wei?: string;
      day?: number;
      linkId?: string;
      merchant?: string;
    };
    const wei = BigInt(body.wei ?? "0");
    const day = body.day ?? 0;

    // AUDIT N2. The global ceiling bounded total spend but not blast radius:
    // one merchant's links could consume the entire day's float and darken
    // every other merchant until UTC midnight. These scope the same budget so
    // an attacker can only take down what they are already attacking.
    const scopes: { key: string; ceiling: bigint; reason: string }[] = [];
    if (body.linkId) {
      scopes.push({
        key: `scope:link:${body.linkId.toLowerCase()}`,
        ceiling: maxGasWeiPerLinkPerDay,
        reason: "perLinkDay",
      });
    }
    if (body.merchant) {
      scopes.push({
        key: `scope:merchant:${body.merchant.toLowerCase()}`,
        ceiling: maxGasWeiPerMerchantPerDay,
        reason: "perMerchantDay",
      });
    }

    const stored = await this.state.storage.get<{ day: number; spent: string }>("budget");
    const dayRolled = !stored || stored.day !== day;
    let spent = dayRolled ? 0n : BigInt(stored.spent);
    if (dayRolled) await this.sweepStaleScopes(day);

    if (url.pathname === "/reserve") {
      if (wei > maxGasWeiPerTx) {
        return Response.json({ ok: false, reason: "perTx" });
      }
      if (spent + wei > maxGasWeiPerDay) {
        return Response.json({ ok: false, reason: "perDay" });
      }

      // Check every scope BEFORE incrementing any of them, so a refusal on
      // the second scope cannot leave the first one charged for a payment
      // that never happened.
      const next: { key: string; value: bigint }[] = [];
      for (const scope of scopes) {
        const used = await this.readCounter(scope.key, day);
        if (used + wei > scope.ceiling) {
          return Response.json({ ok: false, reason: scope.reason });
        }
        next.push({ key: scope.key, value: used + wei });
      }

      spent += wei;
      await this.writeCounter("budget", day, spent);
      for (const n of next) await this.writeCounter(n.key, day, n.value);
      return Response.json({ ok: true, spent: spent.toString() });
    }

    if (url.pathname === "/release") {
      spent = spent > wei ? spent - wei : 0n;
      await this.writeCounter("budget", day, spent);
      for (const scope of scopes) {
        const used = await this.readCounter(scope.key, day);
        await this.writeCounter(scope.key, day, used > wei ? used - wei : 0n);
      }
      return Response.json({ ok: true, spent: spent.toString() });
    }

    if (url.pathname === "/read") {
      return Response.json({ spent: spent.toString(), day });
    }

    return new Response("Not found", { status: 404 });
  }
}
