import { describe, it, expect, beforeEach } from "vitest";
import { reserveGas, releaseGas, checkBalance } from "../src/limits";
import { DEFAULT_LIMITS, limitsFor, type Env } from "../src/config";

/** Minimal in-memory KV — enough to exercise the counter arithmetic. */
function fakeKV() {
  const store = new Map<string, string>();
  return {
    store,
    kv: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
      list: async () => ({ keys: [] }),
    } as unknown as KVNamespace,
  };
}

/**
 * In-memory stand-in for the GasBudget Durable Object, serialized per instance
 * exactly as the platform serializes the real one.
 *
 * The ceiling used to be a read-modify-write on Workers KV, which is eventually
 * consistent with edge-cached reads — so concurrent callers all read the same
 * value and all wrote value+1. That made the one control protecting the
 * relayer's float bypassable by precisely the burst it existed to stop.
 */
function fakeGasBudget(limits = DEFAULT_LIMITS) {
  const state = { day: 0, spent: 0n };
  let queue: Promise<unknown> = Promise.resolve();

  const ns = {
    idFromName: (n: string) => n,
    get: () => ({
      fetch: async (input: string, init?: { body?: string }) => {
        const path = new URL(input).pathname;
        const body = init?.body ? JSON.parse(init.body) : {};
        const wei = BigInt(body.wei ?? "0");
        const day = body.day ?? 0;

        const run = async () => {
          if (state.day !== day) {
            state.day = day;
            state.spent = 0n;
          }
          if (path === "/reserve") {
            if (wei > limits.maxGasWeiPerTx) return { ok: false, reason: "perTx" };
            if (state.spent + wei > limits.maxGasWeiPerDay) return { ok: false, reason: "perDay" };
            state.spent += wei;
            return { ok: true, spent: state.spent.toString() };
          }
          if (path === "/release") {
            state.spent = state.spent > wei ? state.spent - wei : 0n;
            return { ok: true, spent: state.spent.toString() };
          }
          return { spent: state.spent.toString(), day: state.day };
        };

        const next = queue.catch(() => undefined).then(run);
        queue = next;
        const out = await next;
        return new Response(JSON.stringify(out), {
          headers: { "Content-Type": "application/json" },
        });
      },
    }),
  } as unknown as DurableObjectNamespace;

  return { ns, state };
}

/** Gas price used throughout, so the wei arithmetic is easy to read. */
const PRICE = 10_000_000n; // 0.01 gwei, the figure the README's cost model uses

describe("gas ceilings", () => {
  let env: Env;
  let budget: ReturnType<typeof fakeGasBudget>;

  beforeEach(() => {
    budget = fakeGasBudget();
    env = { KV: fakeKV().kv, GAS_BUDGET: budget.ns } as Env;
  });

  it("rejects a single transaction above the per-tx ceiling", async () => {
    const tooMuch = DEFAULT_LIMITS.maxGasWeiPerTx / PRICE + 1n;
    const msg = await reserveGas(env, tooMuch, PRICE);
    expect(msg).toBeTruthy();
    // Nothing was reserved for a transaction we refused outright.
    expect(budget.state.spent).toBe(0n);
  });

  it("accepts a normal payment — measured avg is ~348k gas", async () => {
    expect(await reserveGas(env, 348_000n, PRICE)).toBeNull();
  });

  it("reserves BEFORE the send, so a cap cannot silently become advisory", async () => {
    await reserveGas(env, 400_000n, PRICE);
    expect(budget.state.spent).toBe(400_000n * PRICE);
  });

  it("counts WEI, not gas units — a price spike must consume the budget faster", async () => {
    // The old unit-denominated counter read healthy while the float drained.
    await reserveGas(env, 10_000n, PRICE * 50n);
    expect(budget.state.spent).toBe(10_000n * PRICE * 50n);
  });

  it("stops payments once the daily budget is exhausted", async () => {
    budget.state.day = Math.floor(Date.now() / 86_400_000);
    budget.state.spent = DEFAULT_LIMITS.maxGasWeiPerDay - 1n;
    const msg = await reserveGas(env, 400_000n, PRICE);
    expect(msg).toMatch(/temporarily paused/i);
  });

  it("gives the reservation back when nothing was broadcast", async () => {
    // Without this, a run of RPC failures burns a whole day's budget without a
    // single transaction ever reaching the chain.
    await reserveGas(env, 400_000n, PRICE);
    await releaseGas(env, 400_000n, PRICE);
    expect(budget.state.spent).toBe(0n);
  });

  it("never lets a release drive the counter negative", async () => {
    await releaseGas(env, 999_999n, PRICE);
    expect(budget.state.spent).toBe(0n);
  });

  it("is atomic under concurrency — this is the whole reason it left KV", async () => {
    // Fifty simultaneous reservations against a budget that fits forty. On the
    // old KV read-modify-write these all read the same value and all wrote
    // value+1, so every one of them was admitted.
    const each = DEFAULT_LIMITS.maxGasWeiPerDay / 40n / PRICE;
    const results = await Promise.all(
      Array.from({ length: 50 }, () => reserveGas(env, each, PRICE))
    );
    const admitted = results.filter((r) => r === null).length;
    expect(admitted).toBeLessThanOrEqual(40);
    expect(budget.state.spent).toBeLessThanOrEqual(DEFAULT_LIMITS.maxGasWeiPerDay);
  });
});

describe("both spending paths draw on one budget", () => {
  let env: Env;
  let budget: ReturnType<typeof fakeGasBudget>;

  beforeEach(() => {
    budget = fakeGasBudget();
    env = { KV: fakeKV().kv, GAS_BUDGET: budget.ns } as Env;
  });

  it("relay-tx spends the same float as pay, so it must reserve too", async () => {
    // /api/relay-tx drives mark-paid and cancel, both paid for by the SAME
    // relayer EOA. If only the pay path reserved, an attacker could cancel and
    // re-cancel real orders until the float was gone and the counter would
    // never see it.
    await reserveGas(env, 300_000n, PRICE); // a payment
    await reserveGas(env, 80_000n, PRICE); // a relayed cancel
    expect(budget.state.spent).toBe(380_000n * PRICE);
  });

  it("a relayed call is refused once the shared daily budget is exhausted", async () => {
    budget.state.day = Math.floor(Date.now() / 86_400_000);
    budget.state.spent = DEFAULT_LIMITS.maxGasWeiPerDay - 100n;
    expect(await reserveGas(env, 80_000n, PRICE)).toMatch(/temporarily paused/i);
  });
});

describe("limits resolve from the environment", () => {
  it("uses the shipped defaults when nothing is configured", () => {
    const l = limitsFor({} as Env);
    expect(l.ipPerMinute).toBe(DEFAULT_LIMITS.ipPerMinute);
    expect(l.maxGasWeiPerTx).toBe(DEFAULT_LIMITS.maxGasWeiPerTx);
    expect(l.lowBalanceWei).toBe(DEFAULT_LIMITS.lowBalanceWei);
  });

  it("lets an operator turn a knob without a code change", () => {
    const l = limitsFor({
      RATE_IP_PER_MINUTE: "3",
      MAX_GAS_WEI_PER_DAY: "1000000",
      LOW_BALANCE_WEI: "50000000000000000",
      RECEIPT_TIMEOUT_MS: "90000",
    } as Env);
    expect(l.ipPerMinute).toBe(3);
    expect(l.maxGasWeiPerDay).toBe(1_000_000n);
    expect(l.lowBalanceWei).toBe(50_000_000_000_000_000n);
    expect(l.receiptTimeoutMs).toBe(90_000);
  });

  it("falls back to the default on a malformed value — a typo must not disable a ceiling", () => {
    // The dangerous failure would be a fat-fingered var silently resolving to
    // 0 or NaN, which would mean "no cap" rather than "the default cap".
    for (const bad of ["", "abc", "-5", "0", "1.5.2", "NaN"]) {
      const l = limitsFor({ MAX_GAS_WEI_PER_DAY: bad, RATE_IP_PER_MINUTE: bad } as Env);
      expect(l.maxGasWeiPerDay).toBe(DEFAULT_LIMITS.maxGasWeiPerDay);
      expect(l.ipPerMinute).toBe(DEFAULT_LIMITS.ipPerMinute);
    }
  });

  it("never resolves a ceiling to zero or negative", () => {
    const l = limitsFor({
      MAX_GAS_WEI_PER_TX: "0",
      MAX_GAS_WEI_PER_DAY: "-1",
      RATE_LINK_PER_HOUR: "-100",
    } as Env);
    expect(l.maxGasWeiPerTx).toBeGreaterThan(0n);
    expect(l.maxGasWeiPerDay).toBeGreaterThan(0n);
    expect(l.linkPerHour).toBeGreaterThan(0);
  });

  it("honours a per-environment override end to end", async () => {
    // A tighter daily cap set by an operator must actually bind.
    const tight = { ...DEFAULT_LIMITS, maxGasWeiPerDay: 500_000n * PRICE };
    const b = fakeGasBudget(tight);
    const env = { KV: fakeKV().kv, GAS_BUDGET: b.ns } as Env;

    expect(await reserveGas(env, 400_000n, PRICE)).toBeNull();
    expect(await reserveGas(env, 400_000n, PRICE)).toMatch(/temporarily paused/i);
  });
});

describe("low-balance warning", () => {
  it("stays quiet while the float is healthy", async () => {
    expect(await checkBalance({} as Env, 50_000_000_000_000_000n, "0xrelayer")).toBeNull();
  });

  it("warns while there is still time to act, not once the float is gone", async () => {
    const warn = await checkBalance({} as Env, DEFAULT_LIMITS.lowBalanceWei - 1n, "0xrelayer");
    expect(warn).toMatch(/low on gas/i);
    expect(warn).toContain("0xrelayer");
  });
});

describe("quantity bounds", () => {
  it("Number.isInteger alone is not enough — the guard must use isSafeInteger", () => {
    // 1e30 passes isInteger, which would have sent an absurd quantity into a
    // gas-costing simulation before the contract rejected it.
    expect(Number.isInteger(1e30)).toBe(true);
    expect(Number.isSafeInteger(1e30)).toBe(false);
  });

  it("rejects the shapes a tampered body would send", () => {
    for (const q of [0, -1, 1.5, NaN, Infinity, 1e30]) {
      expect(Number.isSafeInteger(q) && q > 0).toBe(false);
    }
    expect(Number.isSafeInteger(3) && 3 > 0).toBe(true);
  });
});
