import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/config";

/**
 * THE ERROR BOUNDARY AROUND THE ROUTE TABLE.
 *
 * WHY THIS FILE EXISTS
 * Round-4 L6, in its general form. `fetch` applies the CORS headers AFTER the
 * route handler returns:
 *
 *     res = await route(...)
 *     for (const [k, v] of Object.entries(cors)) res.headers.set(k, v)
 *
 * So any handler that THREW skipped that loop entirely and escaped the function.
 * The runtime's own 500 carries no CORS headers, and a response with no
 * `Access-Control-Allow-Origin` is one the pay page's JavaScript cannot read at
 * all — `fetch` rejects before the status is visible. The customer sees an
 * opaque network error, indistinguishable from the Worker being down, for what
 * may be a perfectly diagnosable bug.
 *
 * L6 was one instance of this (an out-of-range KV TTL throwing inside `put`),
 * but the shape is general, so the fix belongs around the whole table rather
 * than in any single route — and it needs its own test, because no suite
 * exercised the `fetch` handler at all.
 *
 * The two properties that matter are asserted below: a throw becomes a JSON 500,
 * and it still carries CORS.
 */

const ORIGIN = "https://pay.example.com";

// `/api/pay` is the route to force this through, and deliberately not
// `/health`: health already catches its own errors and answers 503, so it would
// prove nothing about the boundary. This mock makes the handler throw the way a
// genuine bug would — L6's own case was `KV.put` throwing on an out-of-range
// TTL, several frames deep inside a handler that did not expect it.
vi.mock("../src/pay", () => ({
  handlePay: async () => {
    throw new Error("boom — simulated unhandled failure");
  },
}));

function fakeEnv(): Env {
  return {
    ALLOWED_ORIGINS: ORIGIN,
    CHAIN_ID: "8453",
    INTEGRATOR_ADDRESS: "0x1111111111111111111111111111111111111111",
    KV: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [] }),
    } as unknown as KVNamespace,
  } as unknown as Env;
}

describe("the fetch error boundary (round-4 L6, generalised)", () => {
  let worker: { fetch: (req: Request, env: Env) => Promise<Response> };

  beforeEach(async () => {
    worker = (await import("../src/index")).default as any;
  });

  it("turns an unhandled throw into a JSON 500 rather than escaping", async () => {
    const res = await worker.fetch(
      new Request("https://w/api/pay/0xabc", {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: "{}",
      }),
      fakeEnv()
    );

    expect(res.status).toBe(500);
    // A readable message, and NOT the exception text — the detail goes to the
    // log, not to whoever is probing.
    const body = (await res.json()) as any;
    expect(body.error).toBeTypeOf("string");
    expect(body.error).not.toContain("boom");
  });

  it("still applies CORS to that 500 — the whole point of the boundary", async () => {
    const res = await worker.fetch(
      new Request("https://w/api/pay/0xabc", {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: "{}",
      }),
      fakeEnv()
    );

    // Without this header the pay page cannot read the response at all, so the
    // status above would never reach the customer. This assertion is the one
    // that would have failed before the fix.
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });

  it("still applies CORS to an ordinary 404", async () => {
    // Regression fence: the refactor that added the boundary moved the route
    // table into its own function, and the header loop had to stay on the
    // OUTSIDE of it. A 404 losing CORS would mean it did not.
    const res = await worker.fetch(
      new Request("https://w/nope", { method: "POST", headers: { Origin: ORIGIN } }),
      fakeEnv()
    );

    expect(res.status).toBe(404);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });

  it("answers preflight before reaching the route table", async () => {
    const res = await worker.fetch(
      new Request("https://w/api/pay/0xabc", {
        method: "OPTIONS",
        headers: { Origin: ORIGIN },
      }),
      fakeEnv()
    );

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });
});
