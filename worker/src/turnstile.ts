/**
 * Cloudflare Turnstile — the human-cost gate on the two endpoints that spend
 * the relayer's money.
 *
 * WHY THIS EXISTS (AUDIT N2)
 * `/api/pay` places a real on-chain order for anyone who POSTs, and the
 * relayer pays for it. Counters cannot fix that, because the thing being
 * rationed is free to the attacker and expensive to us:
 *
 *   • 25 taps from a couple of IPs exhaust one merchant's daily order limit
 *     for the whole UTC day. Every real customer then sees "reached today's
 *     payment limit".
 *   • One IP at the old 10/min across a few public links is ~600 placements
 *     an hour. The daily float covers on the order of a thousand, so a single
 *     machine could darken every link on the service before lunch — the
 *     budget built to protect the float being the cheapest way to switch it
 *     off.
 *   • Every spam order is a real B2B order an LP may accept and escrow
 *     against. A flood of never-paid orders is how an integrator teaches LPs
 *     to stop accepting it.
 *
 * A rate limit rations requests. What is actually scarce here is a human, so
 * that is what to charge for. Turnstile is free, runs natively on Workers,
 * and does not ask the customer to identify themselves — which matters,
 * because anonymity is the feature.
 *
 * This is a COST control, not an authorisation one. Authorisation for
 * advancing an order is the per-order claim token in `orderClaim.ts`; the
 * contract remains the only thing enforcing correctness.
 */

import type { Env } from "./config";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface TurnstileResult {
  ok: boolean;
  /** Customer-facing message when `ok` is false. Never leaks detail. */
  message?: string;
}

/** Is the gate configured? `/health` reports this so nobody has to guess. */
export function turnstileEnabled(env: Env): boolean {
  return Boolean(env.TURNSTILE_SECRET);
}

/** Should an unconfigured gate refuse service rather than wave traffic past? */
export function turnstileRequired(env: Env): boolean {
  return String(env.REQUIRE_TURNSTILE ?? "").toLowerCase() === "true";
}

/**
 * Verifies a Turnstile token server-side.
 *
 * Returns ok when the gate is not configured, so local dev and the e2e suite
 * run unchanged — unless REQUIRE_TURNSTILE is set, which is how a production
 * deploy is stopped from silently running without it.
 *
 * FAILS CLOSED on a verification error. An unreachable Turnstile endpoint is
 * indistinguishable from one being bypassed, and the thing being protected is
 * a spend. Refusing a payment we could have served is recoverable; draining
 * the float is not.
 */
export async function verifyTurnstile(
  env: Env,
  token: string | undefined,
  ip: string
): Promise<TurnstileResult> {
  if (!turnstileEnabled(env)) {
    if (turnstileRequired(env)) {
      // Deliberately loud: this is a misconfiguration, not a user error.
      console.error("REQUIRE_TURNSTILE is set but TURNSTILE_SECRET is missing — refusing.");
      return { ok: false, message: "Payments are temporarily unavailable." };
    }
    return { ok: true };
  }

  if (!token) {
    return { ok: false, message: "Please complete the verification and try again." };
  }

  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET as string);
  form.append("response", token);
  if (ip && ip !== "unknown") form.append("remoteip", ip);

  try {
    const res = await fetch(VERIFY_URL, { method: "POST", body: form });
    const body = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
    if (body.success) return { ok: true };

    // Log the codes, tell the customer nothing useful to an attacker.
    console.warn(`turnstile rejected: ${(body["error-codes"] ?? []).join(",") || "no reason"}`);
    return { ok: false, message: "Verification failed. Please try again." };
  } catch (err) {
    console.error(`turnstile verification unreachable: ${(err as Error).message}`);
    return { ok: false, message: "Payments are temporarily unavailable." };
  }
}

/** Pulls the token from the header the pay page sets, or the JSON body. */
export function turnstileTokenFrom(
  req: Request,
  body: { turnstileToken?: unknown }
): string | undefined {
  const header = req.headers.get("cf-turnstile-response");
  if (header) return header;
  return typeof body.turnstileToken === "string" ? body.turnstileToken : undefined;
}
