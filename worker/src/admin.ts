/**
 * Operator endpoints for the blocklist.
 *
 * WHY UNBLOCKING IS NOT OPTIONAL
 * The blocklist keys on an IP address, and an IP address is not a person.
 * Mobile carriers put very large numbers of subscribers behind one address —
 * in India that is the normal case — so a block earned by one abuser can catch
 * people who have done nothing. That is not a flaw to be argued away; it is the
 * cost of the control, and it is only acceptable because an operator can SEE
 * the blocks and LIFT them.
 *
 * A blocking rule with no reviewable list and no undo is not a fraud control,
 * it is a way to lose customers quietly.
 *
 * WHO MAY DO IT
 * The contract's own admins — see `adminAuth`. Authority here follows authority
 * there: the super-admin and every owner qualify automatically, an admin
 * assigned on-chain gains access, and one removed loses it. No secret to
 * distribute, nothing to rotate, and every action is attributable to a wallet
 * rather than to "whoever had the password".
 */

import type { Env } from "./config";
import { json } from "./http";
import { unblockIp, blockIp, blockRecord, listBlocked } from "./blocklist";
import { verifyAdmin, type AdminRequest } from "./adminAuth";

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-fA-F:]{2,45}$/;

/** Rejects anything that is not plausibly an address, so a stray value cannot
 *  write junk keys into the store. */
const looksLikeIp = (s: string) => IPV4.test(s) || IPV6.test(s);

/**
 * Everything unauthorised gets the same answer, and it is 404.
 *
 * Not 401: that confirms the endpoint exists. And the same response whether the
 * signature was malformed, expired, or from a wallet with no role — telling a
 * prober which half to work on is telling them how to get in.
 */
const notFound = () => json({ error: "Not found." }, 404);

/**
 * The operator API. Every request carries a signature; see `adminAuth`.
 *
 *   POST /api/admin/blocks   { action: "list" }               every block
 *   POST /api/admin/blocks   { action: "lookup", ip }         one address
 *   POST /api/admin/blocks   { action: "unblock", ip }        lift
 *   POST /api/admin/blocks   { action: "block", ip, reason }  by hand
 *
 * POST throughout, including for reads: the signature travels in the body, and
 * a signed payload does not belong in a URL where it lands in logs and history.
 */
export async function handleAdmin(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return notFound();

  const body = (await req.json().catch(() => ({}))) as AdminRequest & { reason?: string };
  const action = String(body.action ?? "");
  const ip = String(body.ip ?? "").trim();

  // Actions that name an address must do so before the signature is checked —
  // the signature COVERS the address, so a malformed one could never have been
  // signed correctly anyway.
  const needsIp = action === "lookup" || action === "unblock" || action === "block";
  if (needsIp && !looksLikeIp(ip)) return json({ error: "Provide a valid ip." }, 400);

  const auth = await verifyAdmin(env, { ...body, ip: needsIp ? ip : "" });
  if (!auth) return notFound();

  if (action === "list") {
    // The audit view. A control that can catch innocent people and cannot be
    // reviewed is a liability, not a control.
    return json({ blocks: await listBlocked(env), by: auth.signer });
  }

  if (action === "lookup") {
    // A complaint arrives about ONE person, so the review starts with one
    // lookup rather than reading a list of two hundred hoping to spot them.
    const record = await blockRecord(env, ip);
    return json({
      ip,
      blocked: record !== null,
      record,
      // Shown even with no block: someone on two strikes who is already
      // complaining is worth seeing before they reach three.
      strikes: Number((await env.KV.get(`claim:strikes:${ip}`)) ?? "0"),
      by: auth.signer,
    });
  }

  if (action === "unblock") {
    const existed = await unblockIp(env, ip);
    // The strike count goes too. Leaving it would put a wrongly-blocked person
    // one claim from being blocked again, which is not what an operator means
    // by "unblock".
    return json({ ip, unblocked: existed, by: auth.signer });
  }

  if (action === "block") {
    await blockIp(env, ip, 0, String(body.reason ?? `blocked by ${auth.signer}`));
    return json({ ip, blocked: true, record: await blockRecord(env, ip), by: auth.signer });
  }

  return notFound();
}
