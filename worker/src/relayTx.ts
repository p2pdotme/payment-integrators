/**
 * POST /api/relay-tx — the two transactions the widget signs for itself.
 *
 * `<Checkout>` does not route everything through `placeOrder`. To mark an order
 * paid and to cancel one it calls `signer.sendTransaction` directly, targeting
 * the Diamond. A walletless customer has no signer to satisfy that, so the pay
 * page's signer stub forwards those calls here.
 *
 * THIS IS NO LONGER A FORWARDER, AND IT NEVER COULD HAVE BEEN.
 * The Diamond authorises both `paidBuyOrder` and `cancelOrder` against
 * `order.user`. For a link order that is the merchant's UserProxy — never this
 * relayer — so a forwarded transaction signed by the relayer EOA always
 * reverted `NotAuthorized()`. Every link payment stalled at PLACED after the
 * customer had already sent their fiat.
 *
 * So we translate INTENT instead of relaying BYTES: the widget's selector picks
 * one of exactly two functions on our own integrator, which reaches the Diamond
 * through the merchant's proxy. The security argument gets simpler as a result —
 * we are no longer reasoning about arbitrary calldata aimed at a contract we do
 * not control.
 *
 *   1. `to` must be the Diamond — that is what the widget targets.
 *   2. The selector must map to a known intent.
 *   3. Calldata must be exactly 36 bytes — selector plus one uint256.
 *   4. The order must belong to a LINK on our integrator, which is what binds
 *      the request to something the merchant actually authorised.
 */

import { decodeFunctionData, encodeFunctionData, type Address, type Hex } from "viem";
import { RELAY_INTENTS, ORDER_ID_ABI, INTEGRATOR_ABI, limitsFor, type Env } from "./config";
import { publicClientFor, relayerFor } from "./chain";
import { json, badRequest, clientIp, isAddress } from "./http";
import { checkRateLimits, reserveGas, releaseGas, gasPriceFor } from "./limits";
import { blockedForFalseClaims, falseClaimWarning, rememberMarkPaid } from "./claims";
import { explainRevert } from "./pay";

interface RelayBody {
  to?: string;
  data?: string;
}

const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

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

  // 2 ── Selector must map to an intent we are willing to act on.
  const intent = RELAY_INTENTS[data.slice(0, 10).toLowerCase()];
  if (!intent) return json({ error: "Unsupported request." }, 403);

  // 3 ── Exactly selector + one uint256. No trailing arguments.
  if (data.length !== 2 + 8 + 64) return json({ error: "Unsupported request." }, 403);

  let orderId: bigint;
  try {
    const decoded = decodeFunctionData({ abi: ORDER_ID_ABI, data: data as Hex });
    orderId = decoded.args[0] as bigint;
  } catch {
    return json({ error: "Unsupported request." }, 403);
  }

  const client = publicClientFor(env);

  // 4 ── The order must belong to a link we placed. `orderToLink` is set only by
  //      `relayerPlaceOrder`, so a POS order — or an order that is not ours at
  //      all — has no entry and is refused here as well as on-chain.
  const linkId = (await client
    .readContract({
      address: env.INTEGRATOR_ADDRESS as Address,
      abi: INTEGRATOR_ABI,
      functionName: "orderToLink",
      args: [orderId],
    })
    .catch(() => ZERO32)) as Hex;
  if (!linkId || linkId === ZERO32) return json({ error: "Unsupported request." }, 403);

  const ip = clientIp(req);

  // A customer who has already claimed "I have paid" on orders that then failed
  // to settle does not get to keep doing it. The chain records the strike for
  // the merchant to see; blocking the CLAIMANT has to happen here, because only
  // this service can see who is asking.
  if (intent === "markPaid") {
    const blocked = await blockedForFalseClaims(env, ip);
    if (blocked) return json({ error: blocked }, 429);
  }

  const limited = await checkRateLimits(env, `tx:${orderId}`, ip);
  if (limited) return json({ error: limited }, 429);

  const { wallet, address: relayer } = relayerFor(env);
  const functionName = intent === "markPaid" ? "relayerMarkPaid" : "relayerCancelOrder";

  // Simulate first: a revert here costs nothing and gives the customer a
  // message they can act on.
  const calldata = encodeFunctionData({
    abi: INTEGRATOR_ABI,
    functionName,
    args: [linkId, orderId],
  });

  let gas: bigint;
  try {
    await client.simulateContract({
      account: relayer,
      address: env.INTEGRATOR_ADDRESS as Address,
      abi: INTEGRATOR_ABI,
      functionName,
      args: [linkId, orderId],
    });
    gas = await client.estimateGas({
      account: relayer,
      to: env.INTEGRATOR_ADDRESS as Address,
      data: calldata,
    });
  } catch (err) {
    return json({ error: explainRevert(err) }, 409);
  }

  // Book what we will actually SEND, priced in wei — see limits.ts.
  const sendGas = (gas * limitsFor(env).gasBufferPct) / 100n;
  const gasPrice = await gasPriceFor(client);
  const capped = await reserveGas(env, sendGas, gasPrice);
  if (capped) return json({ error: capped }, 503);

  const nonceStub = env.NONCE.get(env.NONCE.idFromName("relayer"));
  const { nonce } = (await (await nonceStub.fetch("https://nonce/allocate")).json()) as {
    nonce: number;
  };

  try {
    const hash = await wallet.writeContract({
      account: wallet.account!,
      chain: wallet.chain,
      address: env.INTEGRATOR_ADDRESS as Address,
      abi: INTEGRATOR_ABI,
      functionName,
      args: [linkId, orderId],
      nonce,
      gas: sendGas,
    });

    if (intent === "markPaid") {
      // Remember who claimed payment, so the scheduled run can turn a later
      // cancellation into a strike against them rather than against the merchant.
      await rememberMarkPaid(env, orderId, ip);

      // One strike is a warning, not a refusal. Someone whose bank transfer
      // genuinely failed last time is far more likely than an attacker, and
      // telling them plainly is both fairer and more effective than silently
      // counting down to a block they never saw coming.
      const warning = await falseClaimWarning(env, ip);
      if (warning) return json({ hash, warning });
    }

    return json({ hash });
  } catch (err) {
    await releaseGas(env, sendGas, gasPrice);
    await nonceStub.fetch("https://nonce/resync");
    return json({ error: explainRevert(err) }, 502);
  }
}
