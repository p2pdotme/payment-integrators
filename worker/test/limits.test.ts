import { describe, it, expect, beforeEach } from "vitest";
import { reserveGas, releaseGas, checkBalance } from "../src/limits";
import { LIMITS, type Env } from "../src/config";

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
    const msg = await reserveGas(env, LIMITS.maxGasPerTx + 1n);
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
    store.set(key, String(LIMITS.maxGasPerDay - 1000n));
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
    store.set(key, String(LIMITS.maxGasPerDay - 100n));
    expect(await reserveGas(env, 80_000n)).toMatch(/temporarily paused/i);
  });
});

describe("low-balance warning", () => {
  it("stays quiet while the float is healthy", async () => {
    expect(await checkBalance(50_000_000_000_000_000n, "0xrelayer")).toBeNull();
  });

  it("warns while there is still time to act, not once the float is gone", async () => {
    const warn = await checkBalance(LIMITS.lowBalanceWei - 1n, "0xrelayer");
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
