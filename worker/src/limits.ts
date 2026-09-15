/**
 * Rate limits and gas ceilings.
 *
 * Both are evaluated BEFORE anything is signed, so an abusive caller costs us a
 * read rather than a transaction. Neither is a correctness control — the
 * contract is — they bound cost and keep the relayer's float predictable.
 */

import { formatEther, type PublicClient } from "viem";
import { limitsFor, type Env } from "./config";

const utcDay = () => Math.floor(Date.now() / 86_400_000);

/**
 * Fixed-window counter on KV. Genuinely approximate: KV is eventually
 * consistent and its reads are edge-cached, so a burst can slip several past
 * the line before the window catches up.
 *
 * That is acceptable HERE and nowhere else. These two counters exist to blunt
 * casual spam, and the cost of leaking a few is a few wasted RPC reads. The
 * gas budget makes the opposite trade — see `reserveGas`.
 */
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
  const limits = limitsFor(env);

  const perIp = await bump(env.KV, `rl:ip:${ip}:${Math.floor(Date.now() / 60_000)}`, 120);
  if (perIp > limits.ipPerMinute) return "Too many attempts. Please wait a moment.";

  const perLink = await bump(
    env.KV,
    `rl:link:${linkId}:${Math.floor(Date.now() / 3_600_000)}`,
    7200
  );
  if (perLink > limits.linkPerHour) return "This link is receiving too many attempts.";

  return null;
}

/** Current gas price, with a floor so a zero reading cannot zero the budget. */
/**
 * Current gas price, for pricing a reservation in wei.
 *
 * Falls back HIGH, not low. A 1 wei fallback made both ceilings fail open at
 * exactly the wrong moment: a flaky RPC is when spend is least observable, and
 * pricing every reservation at 1 wei means the daily budget cannot be reached
 * no matter what leaves the float. Assuming an expensive block instead means
 * the worst case is refusing a payment we could have afforded, which is
 * recoverable — the opposite is not.
 */
export const FALLBACK_GAS_PRICE = 2_000_000_000n; // 2 gwei — well above Base's usual

export async function gasPriceFor(client: PublicClient): Promise<bigint> {
  try {
    const p = await client.getGasPrice();
    return p > 0n ? p : FALLBACK_GAS_PRICE;
  } catch {
    return FALLBACK_GAS_PRICE;
  }
}

/**
 * Reserves the COST of a transaction against the daily budget, in wei.
 *
 * Three things this gets right that the previous KV version did not:
 *
 *   • ATOMIC. The counter lives in a Durable Object, which is single-threaded
 *     per instance. The KV version was a read-modify-write on an eventually
 *     consistent store, so concurrent requests all read the same value and all
 *     wrote value+1 — bypassable by exactly the burst it was meant to stop.
 *   • BOOKS WHAT IS SENT. Callers pass the buffered gas they will actually
 *     send, not the raw estimate; the old version under-counted by the buffer
 *     on every single transaction.
 *   • PRICED IN WEI. The float is denominated in ETH, so the ceiling must be
 *     too. Counting gas UNITS lets a gas-price spike drain the balance while
 *     the counter still reads healthy.
 *
 * Reserve BEFORE sending: a transaction that is sent but not counted is how a
 * daily cap silently becomes advisory. We over-count on failure rather than
 * under-count on success, and `releaseGas` gives it back when the send never
 * happened.
 */
export interface GasScope {
  /** The link this spend is attributable to, if any. */
  linkId?: string;
  /** The merchant who owns that link, if known. */
  merchant?: string;
}

export async function reserveGas(
  env: Env,
  sendGas: bigint,
  gasPrice: bigint,
  scope: GasScope = {}
): Promise<string | null> {
  const wei = sendGas * gasPrice;
  const stub = env.GAS_BUDGET.get(env.GAS_BUDGET.idFromName("relayer"));
  const res = (await (
    await stub.fetch("https://gas/reserve", {
      method: "POST",
      body: JSON.stringify({
        wei: wei.toString(),
        day: utcDay(),
        linkId: scope.linkId,
        merchant: scope.merchant,
      }),
    })
  ).json()) as { ok: boolean; reason?: string };

  if (res.ok) return null;
  if (res.reason === "perTx") return "This payment could not be processed. Please try again.";
  // AUDIT N2. Distinguish "this link/merchant has had its share today" from
  // "the whole service is out of gas". The old message told a customer the
  // service was down when in fact one link had been hammered — which is both
  // wrong and the outcome an attacker was aiming for.
  if (res.reason === "perLinkDay") {
    return "This payment link has reached today's limit. Please try again tomorrow.";
  }
  if (res.reason === "perMerchantDay") {
    return "This merchant has reached today's payment limit. Please try again tomorrow.";
  }
  return "Payments are temporarily paused. Please try again later.";
}

/** Gives back a reservation for a transaction that was never broadcast. */
export async function releaseGas(
  env: Env,
  sendGas: bigint,
  gasPrice: bigint,
  scope: GasScope = {}
): Promise<void> {
  const stub = env.GAS_BUDGET.get(env.GAS_BUDGET.idFromName("relayer"));
  await stub.fetch("https://gas/release", {
    method: "POST",
    body: JSON.stringify({
      wei: (sendGas * gasPrice).toString(),
      day: utcDay(),
      linkId: scope.linkId,
      merchant: scope.merchant,
    }),
  });
}

/** Returns a human-readable warning when the float is running low, else null. */
export async function checkBalance(
  env: Env,
  balanceWei: bigint,
  relayerAddress: string
): Promise<string | null> {
  if (balanceWei >= limitsFor(env).lowBalanceWei) return null;
  return `Relayer ${relayerAddress} is low on gas: ${formatEther(balanceWei)} ETH remaining. Link payments will start failing when it runs dry.`;
}
