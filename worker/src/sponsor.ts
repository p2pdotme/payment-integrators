/**
 * The sponsorship verifier.
 *
 * WHY THIS ENDPOINT EXISTS
 * Gas is sponsored, so no wallet in this system holds a balance and none can
 * run dry. But the built-in sponsorship rules are global — total spend, chain,
 * and a contract allowlist. There is NO built-in per-link or per-wallet cap, so
 * the per-link ceiling this design relies on is not a dashboard checkbox and
 * must not be presented as one. It lives here.
 *
 * The provider calls this before sponsoring anything, passing the operation
 * itself, and we answer allow or refuse.
 *
 * WHAT THIS BOUNDS
 * Cancelling a link order gives the link's consumed use back
 * (`onOrderCancel` does `cl.uses--`), so place-then-cancel can be repeated:
 * `maxUses` caps concurrent orders, not total attempts. That is the one
 * genuinely unbounded action in the current contract. Requiring the customer's
 * signature to cancel already means a stolen link key cannot drive the loop on
 * its own — this counter is the backstop for the case where both keys are lost.
 *
 * WHAT THIS IS NOT
 * It is not an authorisation check. A refusal here only means "we will not pay
 * for this"; the Router and the integrator still decide what is allowed. Do not
 * move security rules into this file — a sponsorship decision must never be the
 * only thing standing between an attacker and an action.
 */

import { decodeFunctionData, type Hex } from "viem";
import { LINK_ROUTER_ABI, type Env } from "./config";
import { json } from "./http";

/** The provider's request. `userOp.callData` is what we decode. */
interface VerifyRequest {
  clientId?: string;
  chainId?: number;
  userOp?: {
    sender?: string;
    callData?: string;
    [k: string]: unknown;
  };
}

const opsKey = (linkId: string) => `sponsor:ops:${linkId.toLowerCase()}`;

/** Default ceiling on sponsored operations per link, over the link's lifetime. */
const DEFAULT_MAX_OPS_PER_LINK = 20;

/**
 * Pulls the linkId out of a Router call.
 *
 * Every Router entry point takes `linkId` first, which is deliberate: it means
 * one decode covers all of them and there is no call shape we sponsor without
 * knowing which link it belongs to. An operation we cannot attribute to a link
 * is refused rather than allowed — see the caller.
 */
function linkIdOf(callData: Hex): string | null {
  try {
    const { args } = decodeFunctionData({ abi: LINK_ROUTER_ABI, data: callData });
    const first = (args as readonly unknown[])?.[0];
    return typeof first === "string" && first.startsWith("0x") && first.length === 66
      ? first.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

const deny = (reason: string) => json({ isAllowed: false, reason }, 200);

/**
 * POST /api/sponsor-check
 *
 * Called by the sponsorship provider, not by users. Authenticated with a shared
 * secret header so an outsider cannot spend our per-link allowance by calling
 * this directly — that would let them exhaust a link's budget without ever
 * sending a transaction.
 */
export async function handleSponsorCheck(req: Request, env: Env): Promise<Response> {
  // FAILS CLOSED when unset.
  //
  // This used to run unauthenticated with no secret configured, which is
  // exactly the hole the secret exists to close — round-3 review, M2. The
  // header of this file already said an outsider must not be able to "exhaust a
  // link's budget without ever sending a transaction", and an unset variable
  // permitted precisely that: DEFAULT_MAX_OPS_PER_LINK unauthenticated POSTs
  // naming a link, and every real payment on it refused for the counter's whole
  // 30-day life.
  //
  // Turnstile fails open, for a reason that does not apply here: leaving that
  // off degrades a spam control on a path that is otherwise safe. The admin
  // routes already fail closed. This was the odd one out.
  if (!env.SPONSOR_VERIFIER_SECRET) return deny("verifier not configured");

  const got = req.headers.get("X-Sponsor-Secret");
  // Length check first so the comparison below is over equal-length strings.
  if (!got || got.length !== env.SPONSOR_VERIFIER_SECRET.length) {
    return deny("unauthorized");
  }
  let diff = 0;
  for (let i = 0; i < got.length; i++) {
    diff |= got.charCodeAt(i) ^ env.SPONSOR_VERIFIER_SECRET.charCodeAt(i);
  }
  if (diff !== 0) return deny("unauthorized");

  let body: VerifyRequest;
  try {
    body = (await req.json()) as VerifyRequest;
  } catch {
    return deny("malformed request");
  }

  // Chain. The provider enforces this too, but a mismatch here means something
  // is misconfigured and we would rather not pay for it.
  if (body.chainId !== undefined && Number(body.chainId) !== Number(env.CHAIN_ID)) {
    return deny("wrong chain");
  }

  const callData = body.userOp?.callData;
  if (!callData || !callData.startsWith("0x")) return deny("no call data");

  // Refuse anything we cannot attribute to a link. The provider's contract
  // allowlist should already have limited this to the Router, but this endpoint
  // must not depend on that being configured correctly — a call shape we cannot
  // decode is one whose cost we cannot bound.
  const linkId = linkIdOf(callData as Hex);
  if (!linkId) return deny("not a recognised link operation");

  const cap = Number(env.MAX_SPONSORED_OPS_PER_LINK || DEFAULT_MAX_OPS_PER_LINK);
  const used = Number((await env.KV.get(opsKey(linkId))) ?? "0");
  if (used >= cap) return deny(`link exhausted its sponsorship allowance (${cap})`);

  // Not atomic, and deliberately so — but the earlier note here understated it.
  // KV's consistency window is up to ~60s, not one operation, so a concurrent
  // burst overshoots this ceiling by considerably more than one. That is
  // acceptable for a blunt backstop whose job is to stop an unbounded loop
  // rather than to meter spend: the bound that matters is the provider's own
  // global spend limit, which IS authoritative. Making this strictly atomic
  // would put a Durable Object on the sponsorship path — cost and latency on
  // every payment — to sharpen an instrument that does not need to be sharp.
  await env.KV.put(opsKey(linkId), String(used + 1), { expirationTtl: 30 * 24 * 60 * 60 });

  return json({ isAllowed: true }, 200);
}

/** How much of its allowance a link has spent. For the merchant view and for
 *  incident response — a link burning through its budget is fraud signal we
 *  did not have when gas came from a shared float. */
export async function sponsoredOps(env: Env, linkId: string): Promise<number> {
  return Number((await env.KV.get(opsKey(linkId))) ?? "0");
}
