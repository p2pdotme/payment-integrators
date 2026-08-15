/**
 * Rate limits and gas ceilings.
 *
 * Both are evaluated BEFORE anything is signed, so an abusive caller costs us
 * a KV read rather than a transaction. Neither is a correctness control — the
 * contract is — they bound cost and keep the relayer's float predictable.
 */

import { formatEther } from "viem";
import { LIMITS, type Env } from "./config";

const utcDay = () => Math.floor(Date.now() / 86_400_000);

/** Fixed-window counter. Approximate at boundaries, which is fine for spam. */
async function bump(kv: KVNamespace, key: string, ttl: number): Promise<number> {
  const n = Number((await kv.get(key)) ?? "0") + 1;
  await kv.put(key, String(n), { expirationTtl: ttl });
  return n;
}

export async function checkRateLimits(
  env: Env,
  linkId: string,
  ip: string
): Promise<string | null> {
  const perIp = await bump(env.KV, `rl:ip:${ip}:${Math.floor(Date.now() / 60_000)}`, 120);
  if (perIp > LIMITS.ipPerMinute) return "Too many attempts. Please wait a moment.";

  const perLink = await bump(
    env.KV,
    `rl:link:${linkId}:${Math.floor(Date.now() / 3_600_000)}`,
    7200
  );
  if (perLink > LIMITS.linkPerHour) return "This link is receiving too many attempts.";

  return null;
}

/**
 * Reserves gas against the daily budget.
 *
 * Reserve BEFORE sending: a transaction that is sent but not counted is how a
 * daily cap silently becomes advisory. We over-count on failure rather than
 * under-count on success — the safe direction.
 *
 * Pair with `releaseGas` when the send never happens, so a run of RPC failures
 * cannot exhaust a day's budget without a single transaction being broadcast.
 */
export async function reserveGas(env: Env, estimate: bigint): Promise<string | null> {
  if (estimate > LIMITS.maxGasPerTx) {
    return "This payment could not be processed. Please try again.";
  }

  const key = `gas:day:${utcDay()}`;
  const spent = BigInt((await env.KV.get(key)) ?? "0");
  if (spent + estimate > LIMITS.maxGasPerDay) {
    return "Payments are temporarily paused. Please try again later.";
  }

  await env.KV.put(key, String(spent + estimate), { expirationTtl: 172_800 });
  return null;
}

/** Gives back a reservation for a transaction that was never broadcast. */
export async function releaseGas(env: Env, estimate: bigint): Promise<void> {
  const key = `gas:day:${utcDay()}`;
  const spent = BigInt((await env.KV.get(key)) ?? "0");
  const next = spent > estimate ? spent - estimate : 0n;
  await env.KV.put(key, String(next), { expirationTtl: 172_800 });
}

/** Returns a human-readable warning when the float is running low, else null. */
export async function checkBalance(
  balanceWei: bigint,
  relayerAddress: string
): Promise<string | null> {
  if (balanceWei >= LIMITS.lowBalanceWei) return null;
  return `Relayer ${relayerAddress} is low on gas: ${formatEther(balanceWei)} ETH remaining. Link payments will start failing when it runs dry.`;
}
