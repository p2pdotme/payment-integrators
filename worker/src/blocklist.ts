/**
 * Blocking a repeat false claimant, and unblocking them.
 *
 * WHAT THIS IS FOR
 * Marking an order paid is a CLAIM, not a settlement — no USDC moves and the LP
 * settles against their own bank, so a liar cannot steal. What they can do,
 * free and anonymously, is burn the LP's escrowed capital and dispute time, eat
 * the merchant's daily allowance, and hold a link's use for the length of the
 * order. Three of those and they stop being a customer having a bad day.
 *
 * WHY THE BLOCK IS NOT ON THE LINK
 * The obvious design — three false claims and the LINK dies — hands every
 * merchant's links to anyone willing to tap three times. The griefing surface
 * it opens is worse than the one it closes. So the block lands on the CLAIMANT,
 * which only this service can identify, and the link stays open for the next
 * honest customer.
 *
 * WHAT AN IP IS AND IS NOT
 * This is friction, not identity, and it is worth being blunt about both
 * failure directions:
 *
 *   • It OVER-blocks. Mobile carriers put very large numbers of subscribers
 *     behind one address, so a single block can catch people who did nothing.
 *     In India that is the normal case, not an edge case. This is precisely why
 *     `unblock` exists and why blocks are listable — an operator has to be able
 *     to see and undo the damage.
 *
 *   • It UNDER-blocks. Anyone willing to change networks is past it in seconds.
 *
 * So it raises the cost of casual abuse and does nothing against a determined
 * attacker. The real guarantee remains that the claim moves no money.
 */

import type { Env } from "./config";

/**
 * A block does not expire.
 *
 * An earlier version lapsed after thirty days, which meant a patient abuser
 * simply waited — and waiting is free to someone whose attempts cost them
 * nothing. The only way out is now a person: an admin reviews the complaint and
 * lifts it.
 *
 * That puts real weight on the review path. A permanent block on a shared
 * carrier address stays wrong until somebody notices, so `listBlocked` is not a
 * nicety here — it is what stops this becoming a slow leak of customers nobody
 * can see.
 */

const blockKey = (ip: string) => `block:ip:${ip}`;

export interface BlockRecord {
  /** Unix seconds. */
  at: number;
  /** How many false claims earned it. */
  strikes: number;
  /** Free text for the operator — not shown to the blocked person. */
  reason: string;
}

/**
 * Is this address blocked, and why?
 *
 * Returns the record rather than a boolean so an operator reviewing a support
 * complaint can see WHEN and for HOW MANY, which is what tells them whether
 * they are looking at a fraudster or at a shared carrier address.
 */
export async function blockRecord(env: Env, ip: string): Promise<BlockRecord | null> {
  const raw = await env.KV.get(blockKey(ip));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BlockRecord;
  } catch {
    return null;
  }
}

/** Blocks an address. Idempotent — re-blocking refreshes the record. */
export async function blockIp(
  env: Env,
  ip: string,
  strikes: number,
  reason = "repeated false payment claims"
): Promise<void> {
  const rec: BlockRecord = { at: Math.floor(Date.now() / 1000), strikes, reason };
  // No expiry, deliberately — see the note above.
  await env.KV.put(blockKey(ip), JSON.stringify(rec));
}

/**
 * Lifts a block.
 *
 * Clears the strike count too. Leaving it would put the person one bad claim
 * from being blocked again, which is not what an operator means when they
 * decide someone was caught by mistake.
 */
export async function unblockIp(env: Env, ip: string): Promise<boolean> {
  const existed = (await env.KV.get(blockKey(ip))) !== null;
  await env.KV.delete(blockKey(ip));
  await env.KV.delete(`claim:strikes:${ip}`);
  return existed;
}

/**
 * Every current block.
 *
 * Exists so over-blocking is VISIBLE. A control that can catch innocent people
 * and cannot be audited is not a control, it is a liability.
 */
export async function listBlocked(
  env: Env,
  limit = 200
): Promise<Array<{ ip: string; record: BlockRecord | null }>> {
  const listed = await env.KV.list({ prefix: "block:ip:", limit });
  const out: Array<{ ip: string; record: BlockRecord | null }> = [];
  for (const k of listed.keys) {
    const ip = k.name.slice("block:ip:".length);
    out.push({ ip, record: await blockRecord(env, ip) });
  }
  return out;
}
