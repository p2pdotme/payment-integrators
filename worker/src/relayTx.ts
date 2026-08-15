/**
 * POST /api/relay-tx — forwards the two transactions the widget signs itself.
 *
 * `<Checkout>` does not route everything through `placeOrder`. For cancelling
 * an order and for marking one paid it calls `signer.sendTransaction` directly,
 * targeting the Diamond. A walletless customer has no signer to satisfy that,
 * so the pay page's signer stub forwards those calls here.
 *
 * This is deliberately NOT a general relay. Four independent checks, each of
 * which alone would prevent the dangerous cases:
 *
 *   1. `to` must be exactly the Diamond — it can never reach our integrator,
 *      so `relayerPlaceOrder` and every withdrawal function are out of reach.
 *   2. The 4-byte selector must be one of exactly two allowlisted functions,
 *      verified against the shipped widget bundle (see config.ts).
 *   3. The calldata must be exactly 36 bytes — selector plus one uint256, so
 *      no extra arguments can ride along.
 *   4. The decoded orderId must already be recorded on OUR contract. An
 *      attacker cannot use this to touch an order we never placed.
 */

import { decodeFunctionData, type Address, type Hex } from "viem";
import { RELAY_SELECTORS, ORDER_ID_ABI, type Env } from "./config";
import { publicClientFor, relayerFor, orderIsOurs } from "./chain";
import { json, badRequest, clientIp, isAddress } from "./http";
import { checkRateLimits, reserveGas, releaseGas } from "./limits";
import { explainRevert } from "./pay";

interface RelayBody {
  to?: string;
  data?: string;
}

export async function handleRelayTx(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as RelayBody;
  const to = String(body.to ?? "");
  const data = String(body.data ?? "");

  if (!isAddress(to) || !/^0x[0-9a-fA-F]*$/.test(data)) {
    return badRequest("Invalid request.");
  }

  // 1 ── Target must be the Diamond, nothing else.
  if (to.toLowerCase() !== env.DIAMOND_ADDRESS.toLowerCase()) {
    return json({ error: "Unsupported request." }, 403);
  }

  // 2 ── Selector must be allowlisted.
  const selector = data.slice(0, 10).toLowerCase();
  if (!RELAY_SELECTORS[selector]) {
    return json({ error: "Unsupported request." }, 403);
  }

  // 3 ── Exactly selector + one uint256. No trailing arguments.
  if (data.length !== 2 + 8 + 64) {
    return json({ error: "Unsupported request." }, 403);
  }

  // 4 ── The order must be one we placed.
  let orderId: bigint;
  try {
    const decoded = decodeFunctionData({ abi: ORDER_ID_ABI, data: data as Hex });
    orderId = decoded.args[0] as bigint;
  } catch {
    return json({ error: "Unsupported request." }, 403);
  }

  const client = publicClientFor(env);
  if (!(await orderIsOurs(client, env, orderId))) {
    return json({ error: "Unsupported request." }, 403);
  }

  const limited = await checkRateLimits(env, `tx:${orderId}`, clientIp(req));
  if (limited) return json({ error: limited }, 429);

  // Forwarded. Same nonce discipline as the pay path — this is the same EOA.
  const { wallet, address: relayer } = relayerFor(env);
  const nonceStub = env.NONCE.get(env.NONCE.idFromName("relayer"));
  const { nonce } = (await (await nonceStub.fetch("https://nonce/allocate")).json()) as {
    nonce: number;
  };

  let gas: bigint;
  try {
    gas = await client.estimateGas({
      account: relayer,
      to: to as Address,
      data: data as Hex,
    });
  } catch (err) {
    return json({ error: explainRevert(err) }, 409);
  }

  // This path spends the SAME relayer float as /api/pay, so it has to draw on
  // the same budget. Without this the daily cap is bypassable: an attacker
  // cancels and re-cancels real orders until the gas is gone, and the counter
  // never sees it.
  const capped = await reserveGas(env, gas);
  if (capped) return json({ error: capped }, 503);

  try {
    const hash = await wallet.sendTransaction({
      account: wallet.account!,
      chain: wallet.chain,
      to: to as Address,
      data: data as Hex,
      nonce,
      gas: (gas * 120n) / 100n,
    });

    return json({ hash });
  } catch (err) {
    await releaseGas(env, gas);
    await nonceStub.fetch("https://nonce/resync");
    return json({ error: explainRevert(err) }, 502);
  }
}
