import { describe, it, expect, beforeEach } from "vitest";
import { encodeFunctionData } from "viem";
import { handleSponsorCheck, sponsoredOps } from "../src/sponsor";
import { LINK_ROUTER_ABI, type Env } from "../src/config";

/**
 * The sponsorship verifier.
 *
 * WHY THIS IS NOT A DASHBOARD SETTING
 * The provider's built-in rules are global: total spend, chain, and a contract
 * allowlist. There is no built-in per-link or per-wallet cap. So the per-link
 * ceiling this design relies on is enforced here, and the plan must not
 * describe it as a checkbox.
 *
 * WHAT IT BOUNDS
 * Cancelling a link order gives the link's use back — `onOrderCancel` does
 * `cl.uses--` — so place-then-cancel can be looped and `maxUses` caps
 * concurrent orders rather than total attempts. Requiring the customer's
 * signature to cancel already stops a stolen link key from driving that loop
 * alone; this counter is the backstop for losing both keys.
 *
 * WHAT IT IS NOT
 * An authorisation check. Refusal here means only "we will not pay for this".
 * The Router and the integrator still decide what is permitted, and these tests
 * are written so nobody later mistakes this for a security boundary.
 */

const LINK = "0x" + "ab".repeat(32);
const LINK2 = "0x" + "cd".repeat(32);
const SECRET = "s3cr3t-shared-with-the-provider";

function fakeEnv(over: Partial<Env> = {}): { env: Env; store: Map<string, string> } {
  const store = new Map<string, string>();
  const env = {
    CHAIN_ID: "8453",
    SPONSOR_VERIFIER_SECRET: SECRET,
    KV: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
      list: async () => ({ keys: [] }),
    } as unknown as KVNamespace,
    ...over,
  } as Env;
  return { env, store };
}

const placeCall = (linkId: string) =>
  encodeFunctionData({
    abi: LINK_ROUTER_ABI,
    functionName: "place",
    args: [
      linkId as `0x${string}`,
      "0x1111111111111111111111111111111111111111",
      1n,
      1n,
      ("0x" + "00".repeat(32)) as `0x${string}`,
      0n,
      "pk",
      "0x2222222222222222222222222222222222222222",
    ],
  });

const cancelCall = (linkId: string) =>
  encodeFunctionData({
    abi: LINK_ROUTER_ABI,
    functionName: "cancel",
    args: [linkId as `0x${string}`, 1n, "0x1234"],
  });

function ask(env: Env, callData: string, opts: { secret?: string; chainId?: number } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const secret = opts.secret === undefined ? SECRET : opts.secret;
  if (secret !== null) headers["X-Sponsor-Secret"] = secret;
  return handleSponsorCheck(
    new Request("https://w/api/sponsor-check", {
      method: "POST",
      headers,
      body: JSON.stringify({
        clientId: "cid",
        chainId: opts.chainId ?? 8453,
        userOp: { sender: "0x3333333333333333333333333333333333333333", callData },
      }),
    }),
    env
  );
}

const decide = async (r: Response) => (await r.json()) as { isAllowed: boolean; reason?: string };

describe("sponsorship verifier", () => {
  let env: Env;

  beforeEach(() => {
    ({ env } = fakeEnv());
  });

  it("sponsors a normal link payment", async () => {
    expect((await decide(await ask(env, placeCall(LINK)))).isAllowed).toBe(true);
  });

  it("counts each sponsored operation against that link", async () => {
    await ask(env, placeCall(LINK));
    await ask(env, cancelCall(LINK));
    expect(await sponsoredOps(env, LINK)).toBe(2);
  });

  it("bounds the place-and-cancel loop at the ceiling", async () => {
    const e = fakeEnv({ MAX_SPONSORED_OPS_PER_LINK: "3" }).env;
    for (let i = 0; i < 3; i++) {
      expect((await decide(await ask(e, placeCall(LINK)))).isAllowed).toBe(true);
    }
    // The loop cannot run forever, even holding both the link key and a
    // customer key.
    const refused = await decide(await ask(e, cancelCall(LINK)));
    expect(refused.isAllowed).toBe(false);
    expect(refused.reason).toContain("allowance");
  });

  it("meters links independently, so one link cannot exhaust another", async () => {
    const e = fakeEnv({ MAX_SPONSORED_OPS_PER_LINK: "1" }).env;
    expect((await decide(await ask(e, placeCall(LINK)))).isAllowed).toBe(true);
    expect((await decide(await ask(e, placeCall(LINK)))).isAllowed).toBe(false);
    // A different link still has its full allowance.
    expect((await decide(await ask(e, placeCall(LINK2)))).isAllowed).toBe(true);
  });

  // ─── Refusals ──────────────────────────────────────────────────────

  it("refuses an operation it cannot attribute to a link", async () => {
    // Not a Router call. The provider's contract allowlist should already have
    // stopped this, but the verifier must not depend on that being configured
    // right — an undecodable call is one whose cost we cannot bound.
    const r = await decide(await ask(env, "0xdeadbeef"));
    expect(r.isAllowed).toBe(false);
    expect(r.reason).toContain("recognised");
  });

  it("refuses when there is no call data at all", async () => {
    expect((await decide(await ask(env, ""))).isAllowed).toBe(false);
  });

  it("refuses the wrong chain", async () => {
    const r = await decide(await ask(env, placeCall(LINK), { chainId: 1 }));
    expect(r.isAllowed).toBe(false);
    expect(r.reason).toContain("chain");
  });

  it("refuses a caller without the shared secret", async () => {
    // Otherwise an outsider could burn a link's allowance by calling this
    // endpoint directly, without ever sending a transaction.
    const r = await decide(await ask(env, placeCall(LINK), { secret: "wrong" }));
    expect(r.isAllowed).toBe(false);
    expect(r.reason).toBe("unauthorized");
  });

  it("refuses a caller presenting no secret", async () => {
    const r = await decide(await ask(env, placeCall(LINK), { secret: null as any }));
    expect(r.isAllowed).toBe(false);
  });

  it("does not spend the allowance on a refused request", async () => {
    await ask(env, placeCall(LINK), { secret: "wrong" });
    await ask(env, "0xdeadbeef");
    expect(await sponsoredOps(env, LINK)).toBe(0);
  });

  it("refuses a malformed body rather than throwing", async () => {
    const r = await handleSponsorCheck(
      new Request("https://w/api/sponsor-check", {
        method: "POST",
        headers: { "X-Sponsor-Secret": SECRET },
        body: "not json",
      }),
      env
    );
    expect((await decide(r)).isAllowed).toBe(false);
  });

  it("always answers 200 so the provider reads the decision, not an error", async () => {
    // A non-200 would look like an outage to the provider, whose fallback may
    // be to sponsor anyway or to fail the payment. Answer clearly instead.
    expect((await ask(env, placeCall(LINK))).status).toBe(200);
    expect((await ask(env, "0xdeadbeef")).status).toBe(200);
    expect((await ask(env, placeCall(LINK), { secret: "wrong" })).status).toBe(200);
  });

  it("FAILS CLOSED when no secret is configured", async () => {
    // This test asserted the opposite, and the inversion is the finding.
    //
    // Running unauthenticated when the variable is unset is exactly the hole
    // the secret exists to close: this file's own header says an outsider must
    // not be able to "exhaust a link's budget without ever sending a
    // transaction", and an unset variable permitted precisely that. An
    // incomplete deploy removed the gate silently, because wrangler.toml lists
    // the secret only as something to `wrangler secret put`.
    const e = fakeEnv({ SPONSOR_VERIFIER_SECRET: undefined }).env;
    const r = await decide(await ask(e, placeCall(LINK), { secret: null as any }));
    expect(r.isAllowed).toBe(false);
  });

  it("an unauthenticated caller cannot spend a link's allowance", async () => {
    // The attack the previous behaviour allowed, stated directly: 20 POSTs and
    // every real payment on that link is refused for the counter's whole life.
    const e = fakeEnv({ SPONSOR_VERIFIER_SECRET: undefined }).env;
    for (let i = 0; i < 25; i++) await ask(e, placeCall(LINK), { secret: null as any });
    expect(await sponsoredOps(e, LINK)).toBe(0);
  });
});
