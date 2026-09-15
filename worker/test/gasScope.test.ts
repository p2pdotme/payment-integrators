/**
 * AUDIT N2 — per-link and per-merchant gas sub-budgets, and the Turnstile gate.
 *
 * These drive the REAL `GasBudget` Durable Object against an in-memory
 * DurableObjectState, not a hand-written stand-in that reimplements its rules.
 * Every blocker in this review so far has been a case of a test double
 * disagreeing with the thing it stood for — MockDiamond without the
 * `order.user` gate, the memory DO that serialised whole calls and hid the
 * nonce race. A fake that reimplements the ceiling logic can only ever prove
 * the fake is self-consistent.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { GasBudget } from "../src/durable";
import { DEFAULT_LIMITS, type Env } from "../src/config";
import { verifyTurnstile, turnstileEnabled, turnstileRequired } from "../src/turnstile";

/** Minimal in-memory DurableObjectState: just the storage surface the DO uses. */
function memoryState() {
  const map = new Map<string, unknown>();
  return {
    storage: {
      get: async <T>(key: string) => map.get(key) as T | undefined,
      put: async (key: string, value: unknown) => {
        map.set(key, value);
      },
      delete: async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k);
      },
      list: async <T>({ prefix }: { prefix: string }) => {
        const out = new Map<string, T>();
        for (const [k, v] of map) if (k.startsWith(prefix)) out.set(k, v as T);
        return out;
      },
    },
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
    _map: map,
  } as unknown as DurableObjectState & { _map: Map<string, unknown> };
}

const PRICE = 10_000_000n; // 0.01 gwei — the figure the README's cost model uses

function budgetFor(env: Partial<Env> = {}) {
  const state = memoryState();
  const budget = new GasBudget(state, env as Env);
  const call = async (
    path: "reserve" | "release" | "read",
    body: Record<string, unknown>
  ): Promise<{ ok?: boolean; reason?: string; spent?: string }> => {
    const res = await budget.fetch(
      new Request(`https://gas/${path}`, { method: "POST", body: JSON.stringify(body) })
    );
    return res.json();
  };
  return { state, call };
}

const LINK_A = "0xaaaa";
const LINK_B = "0xbbbb";
const MERCHANT_A = "0x1111111111111111111111111111111111111111";
const MERCHANT_B = "0x2222222222222222222222222222222222222222";

describe("N2 · per-link and per-merchant gas sub-budgets", () => {
  it("stops one link before it can spend the whole day's float", async () => {
    const { call } = budgetFor();
    const perCall = DEFAULT_LIMITS.maxGasWeiPerLinkPerDay / 4n;

    for (let i = 0; i < 4; i++) {
      const res = await call("reserve", {
        wei: perCall.toString(),
        day: 1,
        linkId: LINK_A,
        merchant: MERCHANT_A,
      });
      expect(res.ok, `reservation ${i + 1} should fit`).toBe(true);
    }

    const over = await call("reserve", {
      wei: perCall.toString(),
      day: 1,
      linkId: LINK_A,
      merchant: MERCHANT_A,
    });
    expect(over.ok).toBe(false);
    expect(over.reason).toBe("perLinkDay");
  });

  it("leaves every OTHER link payable when one is exhausted — the point of the fix", async () => {
    const { call } = budgetFor();
    const perCall = DEFAULT_LIMITS.maxGasWeiPerLinkPerDay;

    // Link A takes its entire daily slice in one go.
    expect(
      (
        await call("reserve", {
          wei: perCall.toString(),
          day: 1,
          linkId: LINK_A,
          merchant: MERCHANT_A,
        })
      ).ok
    ).toBe(true);
    expect(
      (await call("reserve", { wei: "1000", day: 1, linkId: LINK_A, merchant: MERCHANT_A })).reason
    ).toBe("perLinkDay");

    // A different merchant's link is untouched. Before this fix, link A could
    // consume the global budget and this would have failed too.
    const other = await call("reserve", {
      wei: (348_000n * PRICE).toString(),
      day: 1,
      linkId: LINK_B,
      merchant: MERCHANT_B,
    });
    expect(other.ok).toBe(true);
  });

  it("stops one merchant across ALL of their links, not just one", async () => {
    const { call } = budgetFor();
    // Each link stays inside its own slice; together they exceed the merchant's.
    const slice = DEFAULT_LIMITS.maxGasWeiPerLinkPerDay;
    expect(
      (
        await call("reserve", {
          wei: slice.toString(),
          day: 1,
          linkId: LINK_A,
          merchant: MERCHANT_A,
        })
      ).ok
    ).toBe(true);
    expect(
      (
        await call("reserve", {
          wei: slice.toString(),
          day: 1,
          linkId: LINK_B,
          merchant: MERCHANT_A,
        })
      ).ok
    ).toBe(true);

    const third = await call("reserve", {
      wei: slice.toString(),
      day: 1,
      linkId: "0xcccc",
      merchant: MERCHANT_A,
    });
    expect(third.ok).toBe(false);
    expect(third.reason).toBe("perMerchantDay");
  });

  it("does not charge a scope for a reservation it refused", async () => {
    // Ordering matters: the link slice is checked first and the merchant slice
    // second, so a merchant-level refusal must not leave the link charged.
    const { call, state } = budgetFor();
    const slice = DEFAULT_LIMITS.maxGasWeiPerLinkPerDay;

    await call("reserve", { wei: slice.toString(), day: 1, linkId: LINK_A, merchant: MERCHANT_A });
    await call("reserve", { wei: slice.toString(), day: 1, linkId: LINK_B, merchant: MERCHANT_A });

    const refused = await call("reserve", {
      wei: slice.toString(),
      day: 1,
      linkId: "0xdddd",
      merchant: MERCHANT_A,
    });
    expect(refused.reason).toBe("perMerchantDay");

    const linkD = state._map.get("scope:link:0xdddd") as { spent: string } | undefined;
    expect(linkD, "the refused link must not have been charged").toBeUndefined();
  });

  it("gives a scoped reservation back on release", async () => {
    const { call, state } = budgetFor();
    const wei = (348_000n * PRICE).toString();
    await call("reserve", { wei, day: 1, linkId: LINK_A, merchant: MERCHANT_A });
    await call("release", { wei, day: 1, linkId: LINK_A, merchant: MERCHANT_A });

    expect((state._map.get("scope:link:0xaaaa") as { spent: string }).spent).toBe("0");
    expect((state._map.get("budget") as { spent: string }).spent).toBe("0");
  });

  it("resets scopes on a new UTC day and sweeps the stale keys", async () => {
    const { call, state } = budgetFor();
    const slice = DEFAULT_LIMITS.maxGasWeiPerLinkPerDay;
    await call("reserve", { wei: slice.toString(), day: 1, linkId: LINK_A, merchant: MERCHANT_A });
    expect(
      (await call("reserve", { wei: "1000", day: 1, linkId: LINK_A, merchant: MERCHANT_A })).reason
    ).toBe("perLinkDay");

    // Tomorrow: payable again, and yesterday's keys are gone rather than
    // accumulating one per link per day forever in DO storage, which has no TTL.
    const tomorrow = await call("reserve", {
      wei: slice.toString(),
      day: 2,
      linkId: LINK_A,
      merchant: MERCHANT_A,
    });
    expect(tomorrow.ok).toBe(true);

    const scopeKeys = [...state._map.keys()].filter((k) => k.startsWith("scope:"));
    for (const k of scopeKeys) {
      expect((state._map.get(k) as { day: number }).day).toBe(2);
    }
  });

  it("still enforces the global ceiling when no scope is supplied", async () => {
    const { call } = budgetFor();
    const res = await call("reserve", {
      wei: (DEFAULT_LIMITS.maxGasWeiPerDay + 1n).toString(),
      day: 1,
    });
    expect(res.ok).toBe(false);
    // perTx is checked first and is the smaller ceiling, so that is the reason.
    expect(res.reason).toBe("perTx");
  });
});

describe("N2 · Turnstile gate", () => {
  const ip = "203.0.113.7";
  afterEach(() => vi.unstubAllGlobals());

  it("is a no-op when no secret is configured, so dev and CI run unchanged", async () => {
    const env = {} as Env;
    expect(turnstileEnabled(env)).toBe(false);
    expect(await verifyTurnstile(env, undefined, ip)).toEqual({ ok: true });
  });

  it("refuses service when REQUIRE_TURNSTILE is set but the secret is missing", async () => {
    // The whole point: a production deploy cannot silently ship with the gate
    // open just because someone forgot to set the secret.
    const env = { REQUIRE_TURNSTILE: "true" } as Env;
    expect(turnstileRequired(env)).toBe(true);
    const res = await verifyTurnstile(env, "anything", ip);
    expect(res.ok).toBe(false);
  });

  it("rejects a request with no token once the gate is live", async () => {
    const env = { TURNSTILE_SECRET: "s" } as Env;
    const res = await verifyTurnstile(env, undefined, ip);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/verification/i);
  });

  it("accepts a token Cloudflare confirms", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ success: true })))
    );
    expect(await verifyTurnstile({ TURNSTILE_SECRET: "s" } as Env, "tok", ip)).toEqual({
      ok: true,
    });
  });

  it("rejects a token Cloudflare refuses, without leaking why", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] })
          )
      )
    );
    const res = await verifyTurnstile({ TURNSTILE_SECRET: "s" } as Env, "tok", ip);
    expect(res.ok).toBe(false);
    expect(res.message).not.toMatch(/invalid-input-response/);
  });

  it("FAILS CLOSED when Cloudflare is unreachable", async () => {
    // An unreachable verifier is indistinguishable from a bypassed one, and
    // what is behind the gate is a spend. Refusing a payment we could have
    // served is recoverable; draining the float is not.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );
    const res = await verifyTurnstile({ TURNSTILE_SECRET: "s" } as Env, "tok", ip);
    expect(res.ok).toBe(false);
  });
});
