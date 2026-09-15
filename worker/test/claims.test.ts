import { describe, it, expect, beforeEach } from "vitest";
import {
  blockedForFalseClaims,
  falseClaimWarning,
  rememberMarkPaid,
  recordFalseClaim,
  clearMarkPaid,
  claimantOf,
  MAX_FALSE_CLAIMS,
} from "../src/claims";
import type { Env } from "../src/config";

/**
 * False "I have paid" claims.
 *
 * A lying customer cannot steal — PAID moves no USDC, and the LP settles
 * against their own bank. What they CAN do is burn the LP's escrowed capital
 * and dispute time for free: no wallet, no gas, no identity.
 *
 * The contract counts strikes per LINK so the merchant can see it, and
 * deliberately never blocks on them — two strikes freezing a link would let
 * anyone kill any merchant's link with two taps. Blocking the CLAIMANT is this
 * module's job, because only the service can see who is asking.
 */
function fakeEnv(): { env: Env; store: Map<string, string> } {
  const store = new Map<string, string>();
  const env = {
    KV: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
      list: async () => ({ keys: [] }),
    } as unknown as KVNamespace,
  } as Env;
  return { env, store };
}

const IP = "203.0.113.7";
const OTHER_IP = "203.0.113.9";

describe("false payment claims", () => {
  let env: Env;

  beforeEach(() => {
    env = fakeEnv().env;
  });

  it("lets an honest customer through with no warning", async () => {
    expect(await blockedForFalseClaims(env, IP)).toBeNull();
    expect(await falseClaimWarning(env, IP)).toBeNull();
  });

  it("warns after the first broken claim, but still lets them pay", async () => {
    await rememberMarkPaid(env, 1n, IP);
    await recordFalseClaim(env, 1n);

    // A failed bank transfer is far more likely than an attacker, so the first
    // one is a warning rather than a refusal.
    expect(await blockedForFalseClaims(env, IP)).toBeNull();
    const warning = await falseClaimWarning(env, IP);
    expect(warning).toMatch(/never received/i);
    expect(warning).toMatch(new RegExp(`${MAX_FALSE_CLAIMS - 1} more time`, "i"));
  });

  it("blocks once the allowance is used up, in words a person can act on", async () => {
    for (let i = 1n; i <= BigInt(MAX_FALSE_CLAIMS); i++) {
      await rememberMarkPaid(env, i, IP);
      await recordFalseClaim(env, i);
    }

    const blocked = await blockedForFalseClaims(env, IP);
    expect(blocked).toMatch(/could not confirm your previous payments/i);
    expect(blocked).toMatch(/contact the merchant/i);
    // Past the limit there is nothing left to warn about.
    expect(await falseClaimWarning(env, IP)).toBeNull();
  });

  it("charges the claimant, not the merchant and not a bystander", async () => {
    // Driven off MAX_FALSE_CLAIMS: this test is about WHO is charged, not about
    // where the threshold sits, so it should not fail when that moves.
    for (let i = 0; i < MAX_FALSE_CLAIMS; i++) {
      await rememberMarkPaid(env, BigInt(42 + i), IP);
      await recordFalseClaim(env, BigInt(42 + i));
    }

    expect(await blockedForFalseClaims(env, IP)).toBeTruthy();
    // Someone else on the same link is unaffected — this is the whole reason
    // the block lives here rather than on the link itself.
    expect(await blockedForFalseClaims(env, OTHER_IP)).toBeNull();
  });

  it("costs nothing when the claim turns out to be honest", async () => {
    await rememberMarkPaid(env, 7n, IP);
    await clearMarkPaid(env, 7n);

    // The order later cancels for an unrelated reason; there is no claimant on
    // record any more, so nobody is charged.
    expect(await recordFalseClaim(env, 7n)).toBeNull();
    expect(await blockedForFalseClaims(env, IP)).toBeNull();
  });

  it("ignores a cancellation for an order nobody claimed", async () => {
    // Most cancellations are ordinary abandonment, not a false claim.
    expect(await recordFalseClaim(env, 999n)).toBeNull();
    expect(await blockedForFalseClaims(env, IP)).toBeNull();
  });

  it("remembers who claimed which order", async () => {
    await rememberMarkPaid(env, 5n, IP);
    expect(await claimantOf(env, 5n)).toBe(IP);
    expect(await claimantOf(env, 6n)).toBeNull();
  });
});
