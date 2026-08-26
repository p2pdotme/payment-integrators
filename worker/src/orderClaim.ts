/**
 * Proof that you are the customer who started an order.
 *
 * WHY THIS EXISTS
 * `/api/relay-tx` advances an order — marks it paid, or cancels it. Every check
 * it made was about WHICH order: right target, right selector, right calldata
 * length, and a `orderToLink` lookup proving the order came from a link. None
 * was about WHICH CALLER, because the design had no notion of one.
 *
 * The orderId is public three ways over — indexed in `LinkOrderPlaced`,
 * sequential on the Diamond, and readable from `orderToLink`. So anyone who saw
 * one could cancel a stranger's order mid-payment, or mark it paid falsely. The
 * relayer paid the gas for them. Cancelling during ACCEPTED is the cruel case:
 * the customer's fiat has already left their bank, the order is dead, and
 * `relayerMarkPaid` will now revert — with no wallet, no merchant present, and
 * nothing on-chain to dispute against.
 *
 * The fix is a bearer token minted when the order is placed and required to
 * advance it. `/api/pay` returns it once, to the browser that caused the
 * placement; the pay page holds it for the life of the checkout and sends it
 * back on `/api/relay-tx`.
 *
 * Only the HASH is stored, so a KV dump does not let the holder move anyone's
 * order, and the comparison is constant-time so a timing signal cannot be used
 * to recover a token byte by byte.
 *
 * This is deliberately NOT an identity — the customer is anonymous by design and
 * has no wallet to sign with. It proves one thing only: you are the browser this
 * order was created for.
 */

import type { Env } from "./config";

/** 32 bytes, hex. Long enough that guessing is not a strategy. */
export function mintClaimToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Length-independent, branch-free compare. Both inputs are fixed-length hex. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const key = (orderId: bigint) => `claim:${orderId}`;

/**
 * Records the hash of the token that may advance this order.
 *
 * Called from the pay path once the orderId is known. The token itself is
 * returned to the caller and never persisted.
 */
export async function storeClaim(env: Env, orderId: bigint, token: string): Promise<void> {
  await env.KV.put(key(orderId), await sha256Hex(token), { expirationTtl: 2_592_000 });
}

/**
 * True when `token` is the one minted for this order.
 *
 * A missing record is a REFUSAL, not a pass. Orders placed before this shipped,
 * or whose record expired, cannot be advanced through the relay endpoint — they
 * fall back to expiring on the Diamond's own TTL. Failing open here would
 * reinstate exactly the hole this closes.
 */
export async function verifyClaim(
  env: Env,
  orderId: bigint,
  token: string | null
): Promise<boolean> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return false;
  const stored = await env.KV.get(key(orderId));
  if (!stored) return false;
  return constantTimeEqual(stored, await sha256Hex(token));
}

/**
 * Reads the token from a request.
 *
 * Header first (it keeps the secret out of bodies that get logged), body second
 * so a simple fetch without custom headers still works.
 */
export function claimFromRequest(req: Request, body: { claimToken?: unknown }): string | null {
  const header = req.headers.get("X-Payment-Claim");
  if (header) return header.trim().toLowerCase();
  if (typeof body.claimToken === "string") return body.claimToken.trim().toLowerCase();
  return null;
}
