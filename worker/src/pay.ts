/**
 * POST /api/pay/:linkId — the endpoint a walletless customer hits on Pay.
 *
 * The whole design in one sentence: the request body supplies a quantity and a
 * relay pubkey, and everything else about the payment is read from the chain.
 */

import { decodeEventLog, type Address, type Hex } from "viem";
import { INTEGRATOR_ABI, limitsFor, productIdFor, type Env } from "./config";
import { publicClientFor, relayerFor, readLink, linkBlockedReason } from "./chain";
import { checkRateLimits, reserveGas, releaseGas } from "./limits";
import { json, badRequest, clientIp, isHex32 } from "./http";

interface PayBody {
  /** Units to buy. Ignored for a fixed-amount link, which pins its own total. */
  quantity?: number;
  /** The customer's ephemeral relay pubkey — the LP encrypts payment details to it. */
  pubKey?: string;
  /** Offramp circle resolved client-side from the subgraph. */
  circleId?: number;
}

export async function handlePay(req: Request, env: Env, linkId: string): Promise<Response> {
  if (!isHex32(linkId)) return badRequest("That payment link address is not valid.");

  const limits = limitsFor(env);

  const body = (await req.json().catch(() => ({}))) as PayBody;
  const pubKey = typeof body.pubKey === "string" ? body.pubKey : "";
  if (!pubKey) return badRequest("Missing payment key. Please reload the page.");

  // 1 ── Rate limits, before any RPC call.
  const limited = await checkRateLimits(env, linkId, clientIp(req));
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

      const cap = await perTxCap(client, env, link.currency);
      if (cap > 0n && BigInt(q) * unit > cap) {
        return json({ error: "This amount is above the limit for this merchant." }, 409);
      }
      quantity = BigInt(q);
    }

    const { wallet, address: relayer } = relayerFor(env);
    const args = [
      linkId as Hex,
      env.CLIENT_ADDRESS as Address,
      productIdFor(env), // pinned by config; never caller-supplied
      quantity,
      link.currency,
      BigInt(body.circleId ?? 0),
      pubKey,
    ] as const;

    // 5 ── Simulate first. A revert here is the contract telling us the payment
    //      would fail, and costs nothing.
    let gas: bigint;
    try {
      const sim = await client.simulateContract({
        address: env.INTEGRATOR_ADDRESS as Address,
        abi: INTEGRATOR_ABI,
        functionName: "relayerPlaceOrder",
        args,
        account: relayer,
      });
      gas = await client.estimateContractGas({
        address: env.INTEGRATOR_ADDRESS as Address,
        abi: INTEGRATOR_ABI,
        functionName: "relayerPlaceOrder",
        args,
        account: relayer,
      });
      void sim;
    } catch (err) {
      return json({ error: explainRevert(err) }, 409);
    }

    // 6 ── Gas ceilings, reserved before sending.
    const capped = await reserveGas(env, gas);
    if (capped) return json({ error: capped }, 503);

    // 7 ── One nonce, allocated globally so two links cannot collide.
    const nonceStub = env.NONCE.get(env.NONCE.idFromName("relayer"));
    const { nonce } = (await (await nonceStub.fetch("https://nonce/allocate")).json()) as {
      nonce: number;
    };

    let hash: Hex;
    try {
      hash = await wallet.writeContract({
        address: env.INTEGRATOR_ADDRESS as Address,
        abi: INTEGRATOR_ABI,
        functionName: "relayerPlaceOrder",
        args,
        account: wallet.account!,
        chain: wallet.chain,
        nonce,
        gas: (gas * limits.gasBufferPct) / 100n,
      });
    } catch (err) {
      // Nothing was broadcast, so give the reservation back — otherwise a run
      // of RPC failures burns a whole day's budget with no transactions sent.
      await releaseGas(env, gas);
      // A failed send leaves a hole in the sequence — resync rather than
      // letting every later payment queue behind a nonce that never lands.
      await nonceStub.fetch("https://nonce/resync");
      return json({ error: explainRevert(err) }, 502);
    }

    // 8 ── Wait for the receipt ourselves. A returned hash is not proof the
    //      order exists; the log is.
    //
    //      A timeout here does NOT mean the payment failed — the transaction
    //      may still land. Hand the customer the hash so the page can keep
    //      watching, rather than telling them to retry and risking a second
    //      order for the same purchase.
    let receipt;
    try {
      receipt = await client.waitForTransactionReceipt({
        hash,
        timeout: limits.receiptTimeoutMs,
      });
    } catch {
      return json(
        {
          pending: true,
          txHash: hash,
          error: "This is taking longer than usual. Your payment is still being confirmed.",
        },
        202
      );
    }

    if (receipt.status !== "success") {
      return json({ error: "The payment could not be started. Please try again." }, 502);
    }

    const orderId = extractOrderId(receipt.logs, env);
    if (orderId === null) {
      return json({ error: "The payment could not be confirmed. Please try again." }, 502);
    }

    await env.KV.put(
      `order:${orderId}`,
      JSON.stringify({ linkId, merchant: link.owner, txHash: hash, at: Date.now() }),
      { expirationTtl: 2_592_000 }
    );

    return json({ orderId: orderId.toString(), txHash: hash });
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
      args: [1n],
    })) as bigint;
  } catch {
    return 0n;
  }
}

function extractOrderId(
  logs: readonly { topics: readonly Hex[]; data: Hex; address: Address }[],
  env: Env
): bigint | null {
  const ours = env.INTEGRATOR_ADDRESS.toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== ours) continue;
    try {
      const ev = decodeEventLog({
        abi: INTEGRATOR_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (ev.eventName === "LinkOrderPlaced") {
        return (ev.args as unknown as { orderId: bigint }).orderId;
      }
    } catch {
      // Not one of ours — keep looking.
    }
  }
  return null;
}

/**
 * Reverts that reach us WRAPPED, keyed by the inner 4-byte selector.
 *
 * `validateOrder` runs inside the Diamond call, so its reverts come back as
 * `CallFailed(bytes)` and the error name is nowhere in the message — only the
 * selector is. These are exactly the guards a real customer is most likely to
 * hit (a merchant who is frozen, capped, or has used their daily quota), so
 * matching on the name alone would leave them with a generic message in the
 * cases that matter most.
 */
const WRAPPED_REVERTS: Record<string, string> = {
  "0xe2df7fb3": "This merchant cannot accept payments right now.",
  "0x49aeece1": "This amount is above the limit for this merchant.",
  "0xf402e5b1": "This merchant has reached today's payment limit. Please try again tomorrow.",
  "0xaba47339": "This merchant is not set up to accept payments.",
};

/**
 * Turns a contract revert into something a customer can act on.
 *
 * A person staring at a phone cannot do anything with "execution reverted", and
 * the merchant is not there to explain. Every message here is either an action
 * or an honest "not you, us".
 */
export function explainRevert(err: unknown): string {
  const s = String((err as Error)?.message ?? err);

  // Guards that live behind the Diamond call — the frozen switch, the per-tx
  // cap, the daily limit — surface as `CallFailed(bytes)` wrapping the inner
  // selector, so the error NAME never appears in the message. Decode the
  // wrapped selector first, or every one of these degrades to the generic
  // fallback and the customer is told nothing useful.
  for (const [selector, message] of Object.entries(WRAPPED_REVERTS)) {
    if (s.includes(selector)) return message;
  }

  if (s.includes("LinkExpired")) return "This payment link has expired.";
  if (s.includes("LinkAlreadyUsed")) return "This payment link has already been paid.";
  if (s.includes("LinkNotActive")) return "This payment link has been cancelled.";
  if (s.includes("LinkNotFound")) return "This payment link was not found.";
  if (s.includes("LinkAmountMismatch")) return "The amount has changed. Please reload the page.";
  if (s.includes("LinkOrdersDisabled"))
    return "Link payments are temporarily unavailable. Please try again later.";
  if (s.includes("MerchantIsFrozen")) return "This merchant cannot accept payments right now.";
  if (s.includes("DailyLimitReached"))
    return "This merchant has reached today's payment limit. Please try again tomorrow.";
  if (s.includes("ExceedsPerTxCap")) return "This amount is above the limit for this merchant.";
  if (s.includes("InvalidCurrency")) return "This link's currency is not supported right now.";
  if (s.includes("Paused")) return "Payments are temporarily paused. Please try again later.";
  if (s.includes("insufficient funds"))
    return "Payments are temporarily unavailable. Please try again shortly.";

  return "This payment could not be started. Please try again.";
}
