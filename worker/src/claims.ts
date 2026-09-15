/**
 * False "I have paid" claims.
 *
 * Marking an order PAID is a CLAIM, not a settlement — no USDC moves, and the
 * LP still settles against their own bank. So a lying customer cannot steal;
 * what they can do is waste the LP's escrowed capital and dispute time, consume
 * the merchant's daily allowance, and hold a link's use for the length of the
 * order. All of that is free to them: no wallet, no gas, no identity.
 *
 * The contract counts strikes per LINK, which is what the merchant needs to
 * SEE. It deliberately does not block on them: if two strikes froze a link,
 * anyone could kill any merchant's link with two taps — a worse griefing
 * surface than the one it closes.
 *
 * Blocking therefore happens HERE, against the claimant, because only this
 * service can see who is asking. Each bad claim earns a warning; the third
 * stops them, at BOTH endpoints — a blocked claimant cannot place an order
 * either, or they would keep consuming merchants' daily allowance while merely
 * being unable to finish.
 *
 * An IP is a weak identifier and this is deliberately not presented as a
 * security control — it is friction, sized to the harm. The real guarantee is
 * that the claim moves no money.
 */

import type { Env } from "./config";
import { blockIp, blockRecord } from "./blocklist";

const STRIKE_TTL = 86_400; // a day's memory, then a clean slate
const MARK_TTL = 172_800; // long enough for the scheduled run to see the outcome

export const MAX_FALSE_CLAIMS = 3;

const strikeKey = (ip: string) => `claim:strikes:${ip}`;
const markKey = (orderId: bigint) => `claim:mark:${orderId}`;

/**
 * Returns a customer-facing message when this claimant has used up their
 * allowance, else null. The first strike is silent here — it is surfaced as a
 * warning at claim time by `falseClaimWarning`.
 */
export async function blockedForFalseClaims(env: Env, ip: string): Promise<string | null> {
  // The durable block outlives the strike counter, so waiting a day does not
  // clear it. An operator can lift it — see `unblockIp`.
  if (await blockRecord(env, ip)) return BLOCKED_MESSAGE;

  const n = Number((await env.KV.get(strikeKey(ip))) ?? "0");
  if (n < MAX_FALSE_CLAIMS) return null;
  return BLOCKED_MESSAGE;
}

/**
 * Deliberately vague, and pointed at a human.
 *
 * It does not say "you are blocked", how many strikes, or how long — telling an
 * abuser exactly what tripped the rule is telling them exactly what to avoid.
 * It names the merchant as the route out, because a wrongly-blocked customer
 * needs a person, not a retry.
 */
const BLOCKED_MESSAGE =
  "We could not confirm your previous payments, so this payment cannot be completed from here. Please contact the merchant.";

/** A warning to show alongside a successful claim, or null. */
export async function falseClaimWarning(env: Env, ip: string): Promise<string | null> {
  const n = Number((await env.KV.get(strikeKey(ip))) ?? "0");
  if (n === 0) return null;
  const left = MAX_FALSE_CLAIMS - n;
  if (left <= 0) return null;
  return `A previous payment you marked as sent was never received. If this happens ${left} more time, you will not be able to mark payments from here.`;
}

/** Records who claimed payment on an order, for the scheduled run to judge. */
export async function rememberMarkPaid(env: Env, orderId: bigint, ip: string): Promise<void> {
  await env.KV.put(markKey(orderId), ip, { expirationTtl: MARK_TTL });
}

/** Who claimed payment on this order, if anyone. */
export async function claimantOf(env: Env, orderId: bigint): Promise<string | null> {
  return await env.KV.get(markKey(orderId));
}

/**
 * The order was marked paid and then cancelled — the claim was false. Charge it
 * to the claimant and forget the order.
 *
 * Not atomic (KV), and deliberately so: over- or under-counting a strike by one
 * under a race changes nothing that matters, unlike the gas budget, which is
 * why that one lives in a Durable Object.
 */
export async function recordFalseClaim(env: Env, orderId: bigint): Promise<string | null> {
  const ip = await claimantOf(env, orderId);
  if (!ip) return null;
  const n = Number((await env.KV.get(strikeKey(ip))) ?? "0") + 1;
  await env.KV.put(strikeKey(ip), String(n), { expirationTtl: STRIKE_TTL });
  await env.KV.delete(markKey(orderId));

  // At the limit, write a durable block. The strike counter alone forgets after
  // a day, which means a patient abuser simply waits — and a day is a cheap
  // wait for someone whose attempts cost them nothing.
  if (n >= MAX_FALSE_CLAIMS) {
    await blockIp(env, ip, n);
  }
  return ip;
}

/** The claim settled honestly — drop the record without charging anyone. */
export async function clearMarkPaid(env: Env, orderId: bigint): Promise<void> {
  await env.KV.delete(markKey(orderId));
}
