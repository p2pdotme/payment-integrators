/** Small HTTP helpers shared by every route. */

import type { Env } from "./config";

export function corsHeaders(env: Env, origin: string | null): Record<string, string> {
  const allowed = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // With no allowlist configured the pay page is public by design — a customer
  // may open a link from anywhere. Set ALLOWED_ORIGINS to lock it to your own
  // domains once they are known.
  const allow = allowed.length === 0 ? "*" : allowed.includes(origin ?? "") ? origin! : allowed[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

export function badRequest(message: string): Response {
  return json({ error: message }, 400);
}

export function clientIp(req: Request): string {
  return req.headers.get("CF-Connecting-IP") ?? req.headers.get("X-Forwarded-For") ?? "unknown";
}

/** A 0x-prefixed 32-byte hex string. */
export function isHex32(s: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(s);
}

export function isAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}
