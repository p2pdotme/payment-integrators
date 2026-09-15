/**
 * POST /api/pay/:linkId — the endpoint a walletless customer hits on Pay.
 *
 * The whole design in one sentence: the request body supplies a quantity and a
 * relay pubkey, and everything else about the payment is read from the chain.
 *
 * WHAT CHANGED WHEN THE RELAYER WALLET WENT AWAY
 * This endpoint no longer signs anything itself. It validates, then hands the
 * placement to `linkOps`, which drives the link's OWN account through the
 * Router. Gone with the funded key: the gas ceilings (the sponsorship policy
 * decides before the operation reaches the chain, not after money is spent),
 * the global nonce (each link's account has its own sequence, so one stuck
 * payment no longer blocks every later one), and the receipt wait (the
 * operation's own outcome flag is what says the order exists — a bundler hash
 * is not proof of anything).
 */

import { type Address, type Hex, type PublicClient } from "viem";
import {
  INTEGRATOR_ABI,
  REVERT_MESSAGES,
  CALL_FAILED_SELECTOR,
  productIdFor,
  type Env,
} from "./config";
import { publicClientFor, readLink, linkBlockedReason } from "./chain";
import { checkRateLimits } from "./limits";
import { placeOrder, simulatePlace } from "./linkOps";
import { publicKeyToAddress } from "viem/utils";
import { json, badRequest, clientIp, isHex32, normalizeLinkId } from "./http";
import { verifyTurnstile, turnstileTokenFrom } from "./turnstile";
import { mintClaimToken, storeClaim } from "./orderClaim";
import { blockedForFalseClaims } from "./claims";

interface PayBody {
  /** Units to buy. Ignored for a fixed-amount link, which pins its own total. */
  quantity?: number;
  /** The customer's ephemeral relay pubkey — the LP encrypts payment details to it. */
  pubKey?: string;
  /** Offramp circle resolved client-side from the subgraph. */
  circleId?: number;
  /** Cloudflare Turnstile token (AUDIT N2). Header `cf-turnstile-response` also works. */
  turnstileToken?: string;
}

export async function handlePay(req: Request, env: Env, rawLinkId: string): Promise<Response> {
  // Hex is case-insensitive, so normalise before anything keys off it — the
  // per-link lock, the rate limiter and the webhook lookup all use this string.
  const linkId = normalizeLinkId(rawLinkId);
  if (!isHex32(linkId)) return badRequest("That payment link address is not valid.");

  const body = (await req.json().catch(() => ({}))) as PayBody;
  const pubKey = typeof body.pubKey === "string" ? body.pubKey : "";
  if (!pubKey) return badRequest("Missing payment key. Please reload the page.");

  // The address that will be recorded on-chain as the only key allowed to mark
  // this order paid or cancel it.
  //
  // DERIVED from the key the browser already sends, rather than accepted as a
  // separate field. That is deliberate: the same key the LP encrypts payment
  // details to is then the key that must sign "I have paid". Two fields could
  // disagree — pointing settlement authority at a key the customer does not
  // hold — and nothing downstream would notice until a real payment was stuck.
  //
  // The FORMAT is checked here rather than left to the derivation, because
  // `publicKeyToAddress` does not validate: it returns a perfectly plausible
  // address for "0x1234" or for outright garbage. Deriving from a malformed key
  // would place an order whose recorded customer is an address NOBODY holds the
  // key for — payable, and then impossible to mark paid. The customer's fiat
  // would already have left their bank and the order would sit until TTL with
  // nothing anyone could do. So a bad key must be refused BEFORE an order
  // exists, not discovered after one does.
  //
  // Uncompressed secp256k1: 0x04 followed by 64 bytes of X and Y.
  const rawKey = (pubKey.startsWith("0x") ? pubKey.slice(2) : pubKey).toLowerCase();
  if (!/^04[0-9a-f]{128}$/.test(rawKey)) {
    return badRequest("That payment key is not valid. Please reload the page.");
  }

  let customerKey: Address;
  try {
    customerKey = publicKeyToAddress(`0x${rawKey}` as `0x${string}`);
  } catch {
    return badRequest("That payment key is not valid. Please reload the page.");
  }

  // 1 ── Human-cost gate, then rate limits — both before any RPC call.
  //
  // AUDIT N2. Order placement is anonymous and the relayer pays for it, so
  // counters alone ration the wrong thing: requests are free to the attacker
  // and every one that gets through costs us a real transaction and a real
  // slot out of the merchant's daily limit. Turnstile charges for the one
  // resource an attacker actually lacks. Verified before the rate-limit bump
  // so junk traffic cannot burn a merchant's per-link window either.
  const ip = clientIp(req);
  const human = await verifyTurnstile(env, turnstileTokenFrom(req, body), ip);
  if (!human.ok) return json({ error: human.message }, 403);

  // Someone already blocked for false claims does not get to place either.
  //
  // Blocking only mark-paid left them free to keep opening orders: each one
  // still consumed a merchant's daily allowance and held a link's use for the
  // order's lifetime, they just could not finish. Same cost to the merchant,
  // none to them. The check is per-ADDRESS, not per-profile, so a fresh profile
  // from the same device changes nothing.
  const banned = await blockedForFalseClaims(env, ip);
  if (banned) return json({ error: banned }, 403);

  const limited = await checkRateLimits(env, linkId, ip);
  if (limited) return json({ error: limited }, 429);

  // 2 ── Serialize concurrent taps on THIS link. Cost control; the contract's
  //      LinkAlreadyUsed is the real guarantee.
  //
  const lock = env.LINK_LOCK.get(env.LINK_LOCK.idFromName(linkId));
  const acquired = (await (await lock.fetch("https://lock/acquire")).json()) as { ok: boolean };
  if (!acquired.ok) {
    return json({ error: "This payment is already being processed." }, 409);
  }

  try {
    const client = publicClientFor(env);

    // 3 ── Read the link FROM CHAIN. Nothing financial comes from the body.
    const link = await readLink(client, env, linkId as Hex);
    if (!link) return json({ error: "This payment link was not found." }, 404);

    // 4 ── Fail fast on a link that cannot settle, before spending gas.
    const blocked = linkBlockedReason(link, Math.floor(Date.now() / 1000));
    if (blocked) return json({ error: blocked }, 409);

    // Quantity: pinned by the link when fixed, customer-chosen when variable.
    // Deriving it from the link's own amount means a tampered body cannot
    // under-pay a fixed link even before the contract rejects it.
    let quantity: bigint;
    if (link.amount !== 0n) {
      const unit = await unitPrice(client, env);
      if (unit === 0n) return json({ error: "This link is not payable right now." }, 409);
      if (link.amount % unit !== 0n) {
        return json({ error: "This link's amount is no longer valid." }, 409);
      }
      quantity = link.amount / unit;
    } else {
      // `Number.isInteger(1e30)` is true, so an integer check alone lets a
      // absurd quantity through to a gas-costing simulation. Bound it against
      // the merchant's own per-tx cap: anything above that is guaranteed to
      // revert, so there is no reason to pay to discover it.
      const q = Number(body.quantity ?? 0);
      if (!Number.isSafeInteger(q) || q <= 0) return badRequest("Please enter an amount.");

      const unit = await unitPrice(client, env);
      if (unit === 0n) return json({ error: "This link is not payable right now." }, 409);

      // validateOrder keys the per-tx cap off the merchant's REGISTERED
      // currency, never the link's — the exact trap createLink's own comment
      // warns about. Using link.currency here made the precheck disagree with
      // the contract, producing the confusing customer outcome this check
      // exists to prevent (an INR merchant keeps their INR cap on a BRL link).
      const cap = await perTxCap(client, env, await registeredCurrency(client, env, link.owner));
      if (cap > 0n && BigInt(q) * unit > cap) {
        return json({ error: "This amount is above the limit for this merchant." }, 409);
      }
      quantity = BigInt(q);
    }

    // Validated like `quantity`, and for the same reason: `BigInt(x)` throws on
    // anything non-integral, and this runs INSIDE the link lock — so a stray
    // "1.5" or "abc" became an uncaught 500 with no CORS headers, and left the
    // lock held until it expired.
    const rawCircle = body.circleId ?? 0;
    if (!Number.isSafeInteger(Number(rawCircle)) || Number(rawCircle) < 0) {
      return badRequest("That payment option is not valid.");
    }
    const circleId = BigInt(Number(rawCircle));

    // ─── 5 ── Send it, as the link's OWN account ────────────────────
    //
    // What is gone from here, and why:
    //   • the funded relayer wallet — the sender now holds nothing, so there is
    //     no balance to drain, monitor or refill;
    //   • the gas ceilings — the sponsorship policy decides before the
    //     operation reaches the chain, rather than us metering after the fact;
    //   • the global nonce — each link's account has its own sequence, so one
    //     stuck payment can no longer block every later one.
    //
    // What replaces the receipt wait is NOT weaker: `placeOrder` waits for the
    // operation's own outcome flag. A bundler hash is not proof of anything —
    // the EntryPoint catches a failed inner call and still reports success on
    // the transaction, so the flag is the only thing that says the order exists.
    const placeArgs = {
      client: env.CLIENT_ADDRESS as Address,
      productId: productIdFor(env), // pinned by config; never caller-supplied
      quantity,
      currency: link.currency,
      circleId,
      pubKey,
      // Recorded on-chain as the only key that may later mark this order paid
      // or cancel it. Without it, whoever holds the link key could advance or
      // cancel a stranger's in-flight payment.
      customer: customerKey,
    };

    // Ask the contract first. A revert here is the contract naming the problem
    // — expired, daily limit, amount mismatch — and the customer can act on
    // that. Sending anyway would turn all of them into "please try again".
    const wouldFail = await simulatePlace(env, linkId, placeArgs);
    if (wouldFail) return json({ error: explainRevert(wouldFail) }, 409);

    const placed = await placeOrder(env, linkId, placeArgs);

    if (!placed.ok || placed.orderId === undefined) {
      return json({ error: placed.error ?? "The payment could not be started." }, 502);
    }

    const orderId = placed.orderId;
    const hash = placed.txHash ?? placed.userOpHash!;

    await env.KV.put(
      `order:${orderId}`,
      JSON.stringify({ linkId, merchant: link.owner, txHash: hash, at: Date.now() }),
      { expirationTtl: 2_592_000 }
    );

    // Bind the order to THIS browser. The orderId is public — indexed in
    // LinkOrderPlaced, sequential on the Diamond, readable from orderToLink — so
    // without a token anyone who sees one can cancel or falsely mark paid a
    // stranger's in-flight payment through /api/relay-tx.
    const claimToken = mintClaimToken();
    await storeClaim(env, orderId, claimToken);

    return json({ orderId: orderId.toString(), txHash: hash, claimToken });
  } finally {
    await lock.fetch("https://lock/release");
  }
}

/** The merchant's per-transaction ceiling for this currency, or 0 if unreadable. */
async function perTxCap(
  client: ReturnType<typeof publicClientFor>,
  env: Env,
  currency: Hex
): Promise<bigint> {
  try {
    return (await client.readContract({
      address: env.INTEGRATOR_ADDRESS as Address,
      abi: INTEGRATOR_ABI,
      functionName: "perTxCap",
      args: [currency],
    })) as bigint;
  } catch {
    return 0n; // unreadable — let the contract be the judge
  }
}

async function unitPrice(client: ReturnType<typeof publicClientFor>, env: Env): Promise<bigint> {
  try {
    return (await client.readContract({
      address: env.CLIENT_ADDRESS as Address,
      abi: [
        {
          type: "function",
          name: "getProductPrice",
          stateMutability: "view",
          inputs: [{ type: "uint256" }],
          outputs: [{ type: "uint256" }],
        },
      ] as const,
      functionName: "getProductPrice",
      // The SAME product the order is placed against. Hardcoding 1 meant that
      // with PRODUCT_ID set to anything else, quantity was derived from product
      // 1's price while the order was placed against a different product:
      // fixed links then revert LinkAmountMismatch, variable links charge the
      // wrong total.
      args: [productIdFor(env)],
    })) as bigint;
  } catch {
    return 0n;
  }
}

/**
 * The merchant's REGISTERED currency — the one validateOrder keys limits off.
 * Falls back to the link's currency only if the read fails, which keeps the
 * precheck advisory rather than turning an RPC hiccup into a refusal.
 */
async function registeredCurrency(client: PublicClient, env: Env, merchant: Address): Promise<Hex> {
  try {
    const info = (await client.readContract({
      address: env.INTEGRATOR_ADDRESS as Address,
      abi: INTEGRATOR_ABI,
      functionName: "getMerchantInfo",
      args: [merchant],
    })) as readonly [Hex, string, Hex, boolean, boolean];
    return info[2];
  } catch {
    return "0x0000000000000000000000000000000000000000000000000000000000000000";
  }
}

/**
 * Turns a contract revert into something a customer can act on.
 *
 * A person staring at a phone cannot do anything with "execution reverted",
 * and the merchant is not there to explain. Every message here is either an
 * action or an honest "not you, us".
 *
 * WHY THIS READS DATA AND NOT THE MESSAGE
 * This used to match error NAMES inside `err.message`. That worked only
 * against a hardhat node, which decodes names from its own artifacts and
 * prints them. Public RPCs return `execution reverted` plus raw data, so in
 * production every branch fell through to the generic line — and the failures
 * a customer is most likely to hit (expired, used up, revoked, frozen,
 * over-cap, daily limit) all told them nothing they could act on.
 *
 * Selectors are the one thing every RPC returns, so they are what we key on.
 */
export function explainRevert(err: unknown): string {
  const selector = revertSelector(err);
  if (selector && REVERT_MESSAGES[selector]) return REVERT_MESSAGES[selector];

  const s = String((err as Error)?.message ?? err);
  if (s.includes("insufficient funds"))
    return "Payments are temporarily unavailable. Please try again shortly.";

  return "This payment could not be started. Please try again.";
}

/**
 * Digs the 4-byte revert selector out of a viem error.
 *
 * `validateOrder` runs INSIDE the Diamond call, so its reverts come back
 * wrapped: `UserProxy` catches them and re-reverts `CallFailed(bytes)` with the
 * original revert as the payload. The outer selector is therefore always
 * CallFailed and tells us nothing — the useful one is the first four bytes of
 * that payload, which is where the frozen switch, the per-tx cap and the daily
 * limit actually live.
 */
function revertSelector(err: unknown): string | null {
  const data = revertData(err);
  if (!data || data.length < 10) return null;

  const outer = data.slice(0, 10).toLowerCase();
  if (outer !== CALL_FAILED_SELECTOR) return outer;

  // CallFailed(bytes): head is [offset][length][payload…]. The inner selector
  // is the first word of the payload.
  const body = data.slice(10);
  if (body.length < 128 + 8) return outer;
  const inner = "0x" + body.slice(128, 136);
  return inner.toLowerCase();
}

/** The raw revert payload, wherever this particular error put it. */
function revertData(err: unknown): string | null {
  const seen = new Set<unknown>();
  let node: unknown = err;

  // viem nests the cause chain differently per transport and per call type
  // (simulate vs estimateGas vs write), so walk it rather than guessing.
  while (node && typeof node === "object" && !seen.has(node)) {
    seen.add(node);
    const n = node as { data?: unknown; cause?: unknown; raw?: unknown };

    for (const candidate of [n.data, n.raw]) {
      if (typeof candidate === "string" && candidate.startsWith("0x") && candidate.length >= 10) {
        return candidate;
      }
      if (candidate && typeof candidate === "object") {
        const d = (candidate as { data?: unknown }).data;
        if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) return d;
      }
    }
    node = n.cause;
  }

  // Last resort: some providers only surface the payload inside the message.
  const m = String((err as Error)?.message ?? "").match(/0x[0-9a-fA-F]{8,}/);
  return m ? m[0] : null;
}
