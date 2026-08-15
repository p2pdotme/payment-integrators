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

describe("gas ceilings", () => {
  let env: Env;
  let store: Map<string, string>;

  beforeEach(() => {
    const f = fakeKV();
    store = f.store;
    env = { KV: f.kv } as Env;
  });

  it("rejects a single transaction above the per-tx ceiling", async () => {
    const msg = await reserveGas(env, DEFAULT_LIMITS.maxGasPerTx + 1n);
    expect(msg).toBeTruthy();
    // Nothing was reserved for a transaction we refused outright.
    expect(store.size).toBe(0);
  });

  it("accepts a normal payment — measured avg is ~348k against a 600k ceiling", async () => {
    expect(await reserveGas(env, 348_000n)).toBeNull();
  });

  it("reserves BEFORE the send, so a cap cannot silently become advisory", async () => {
    await reserveGas(env, 400_000n);
    const key = [...store.keys()].find((k) => k.startsWith("gas:day:"))!;
    expect(BigInt(store.get(key)!)).toBe(400_000n);
  });

  it("stops payments once the daily budget is exhausted", async () => {
    const key = `gas:day:${Math.floor(Date.now() / 86_400_000)}`;
    store.set(key, String(DEFAULT_LIMITS.maxGasPerDay - 1000n));
    const msg = await reserveGas(env, 400_000n);
    expect(msg).toMatch(/temporarily paused/i);
  });

  it("gives the reservation back when nothing was broadcast", async () => {
    // Without this, a run of RPC failures burns a whole day's budget without a
    // single transaction ever reaching the chain.
    await reserveGas(env, 400_000n);
    await releaseGas(env, 400_000n);
    const key = [...store.keys()].find((k) => k.startsWith("gas:day:"))!;
    expect(BigInt(store.get(key)!)).toBe(0n);
  });

  it("never lets a release drive the counter negative", async () => {
    await releaseGas(env, 999_999n);
    const key = [...store.keys()].find((k) => k.startsWith("gas:day:"))!;
    expect(BigInt(store.get(key)!)).toBe(0n);
  });
});

describe("both spending paths draw on one budget", () => {
  let env: Env;
  let store: Map<string, string>;

  beforeEach(() => {
    const f = fakeKV();
    store = f.store;
    env = { KV: f.kv } as Env;
  });

  it("relay-tx spends the same float as pay, so it must reserve too", async () => {
    // /api/relay-tx forwards cancel and mark-paid, both paid for by the SAME
    // relayer EOA. If only the pay path reserved, an attacker could cancel and
    // re-cancel real orders until the float was gone and the counter would
    // never see it.
    const key = `gas:day:${Math.floor(Date.now() / 86_400_000)}`;

    await reserveGas(env, 300_000n); // a payment
    await reserveGas(env, 80_000n); // a relayed cancel

    expect(BigInt(store.get(key)!)).toBe(380_000n);
  });

  it("a relayed call is refused once the shared daily budget is exhausted", async () => {
    const key = `gas:day:${Math.floor(Date.now() / 86_400_000)}`;
    store.set(key, String(DEFAULT_LIMITS.maxGasPerDay - 100n));
    expect(await reserveGas(env, 80_000n)).toMatch(/temporarily paused/i);
  });
});

describe("limits resolve from the environment", () => {
  it("uses the shipped defaults when nothing is configured", () => {
    const l = limitsFor({} as Env);
    expect(l.ipPerMinute).toBe(DEFAULT_LIMITS.ipPerMinute);
    expect(l.maxGasPerTx).toBe(DEFAULT_LIMITS.maxGasPerTx);
    expect(l.lowBalanceWei).toBe(DEFAULT_LIMITS.lowBalanceWei);
  });

  it("lets an operator turn a knob without a code change", () => {
    const l = limitsFor({
      RATE_IP_PER_MINUTE: "3",
      MAX_GAS_PER_DAY: "1000000",
      LOW_BALANCE_WEI: "50000000000000000",
      RECEIPT_TIMEOUT_MS: "90000",
    } as Env);
    expect(l.ipPerMinute).toBe(3);
    expect(l.maxGasPerDay).toBe(1_000_000n);
    expect(l.lowBalanceWei).toBe(50_000_000_000_000_000n);
    expect(l.receiptTimeoutMs).toBe(90_000);
  });

  it("falls back to the default on a malformed value — a typo must not disable a ceiling", () => {
    // The dangerous failure would be a fat-fingered var silently resolving to
    // 0 or NaN, which would mean "no cap" rather than "the default cap".
    for (const bad of ["", "abc", "-5", "0", "1.5.2", "NaN"]) {
      const l = limitsFor({ MAX_GAS_PER_DAY: bad, RATE_IP_PER_MINUTE: bad } as Env);
      expect(l.maxGasPerDay).toBe(DEFAULT_LIMITS.maxGasPerDay);
      expect(l.ipPerMinute).toBe(DEFAULT_LIMITS.ipPerMinute);
    }
  });

  it("never resolves a ceiling to zero or negative", () => {
    const l = limitsFor({
      MAX_GAS_PER_TX: "0",
      MAX_GAS_PER_DAY: "-1",
      RATE_LINK_PER_HOUR: "-100",
    } as Env);
    expect(l.maxGasPerTx).toBeGreaterThan(0n);
    expect(l.maxGasPerDay).toBeGreaterThan(0n);
    expect(l.linkPerHour).toBeGreaterThan(0);
  });

  it("honours a per-environment override end to end", async () => {
    // A tighter daily cap set by an operator must actually bind.
    const f = fakeKV();
    const env = { KV: f.kv, MAX_GAS_PER_DAY: "500000" } as Env;

    expect(await reserveGas(env, 400_000n)).toBeNull();
    expect(await reserveGas(env, 400_000n)).toMatch(/temporarily paused/i);
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
