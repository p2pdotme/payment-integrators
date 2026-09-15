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

import { decodeFunctionData, type Address, type Hex } from "viem";
import { RELAY_INTENTS, ORDER_ID_ABI, INTEGRATOR_ABI, LINK_ROUTER_ABI, type Env } from "./config";
import { publicClientFor } from "./chain";
import { json, badRequest, clientIp, isAddress } from "./http";
import { claimFromRequest, verifyClaim } from "./orderClaim";
import { checkRateLimits } from "./limits";
import { markPaid, cancelOrder } from "./linkOps";
import { linkWalletAddress } from "./linkWallet";
import { verifyTurnstile, turnstileTokenFrom } from "./turnstile";
import { blockedForFalseClaims, falseClaimWarning, rememberMarkPaid } from "./claims";
import { explainRevert } from "./pay";

interface RelayBody {
  to?: string;
  data?: string;
  /** Proof the caller is the customer this order was placed for. */
  claimToken?: string;
  /**
   * The customer signing over THIS action and THIS order, EIP-712.
   *
   * The claim token proves the request came from the browser that placed the
   * order. This proves it to the CHAIN, which is stronger: the Router refuses
   * to advance or cancel without a signature from the key recorded at
   * placement, so a full compromise of this worker still cannot settle.
   */
  signature?: string;
  /** Cloudflare Turnstile token (AUDIT N2). Header `cf-turnstile-response` also works. */
  turnstileToken?: string;
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

  // 5 ── The caller must be the customer this order was placed for.
  //
  // Everything above establishes WHICH order. This establishes WHICH CALLER,
  // and without it the endpoint advances anyone's order for anyone who asks:
  // cancel a stranger mid-payment (their fiat has left their bank, the order is
  // dead, markPaid now reverts, and they have no wallet to dispute with), or
  // mark an unpaid order PAID so the LP finds nothing and the strike lands on
  // the merchant. A missing record refuses — failing open would reinstate the
  // hole, and such orders can still expire on the Diamond's own TTL.
  if (!(await verifyClaim(env, orderId, claimFromRequest(req, body)))) {
    return json({ error: "This payment session is no longer valid." }, 403);
  }

  const ip = clientIp(req);

  // AUDIT N2. Same human-cost gate as /api/pay. This endpoint also spends the
  // relayer's gas, and a bot that can advance orders for free is a cheaper
  // denial of service than one that can only place them.
  const human = await verifyTurnstile(env, turnstileTokenFrom(req, body), ip);
  if (!human.ok) return json({ error: human.message }, 403);

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

  // 6 ── The customer's own signature over THIS action and THIS order.
  //
  // The claim token above proves the request came from the browser that placed
  // the order. This proves it to the CHAIN, which is a different and stronger
  // thing: the Router will not advance or cancel an order without a signature
  // from the key recorded when it was placed. So a compromise of this worker —
  // every link key and the master secret — still cannot settle anything,
  // because that key was generated in the customer's browser and never left it.
  const signature = typeof body.signature === "string" ? body.signature : "";
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return json({ error: "Please reload the page and try again." }, 400);
  }

  // Simulate first: a revert here costs nothing and gives the customer a
  // message they can act on, rather than a generic failure after the fact.
  try {
    await client.simulateContract({
      account: (await linkAccountFor(env, linkId)) ?? undefined,
      address: env.LINK_ROUTER_ADDRESS as Address,
      abi: LINK_ROUTER_ABI,
      functionName: intent === "markPaid" ? "markPaid" : "cancel",
      args: [linkId, orderId, signature as Hex],
    });
  } catch (err) {
    return json({ error: explainRevert(err) }, 409);
  }

  // 7 ── Drive it as the link's OWN account. No funded key, no shared nonce,
  //      and no gas ceiling to book against — the sponsorship policy decides
  //      before the operation reaches the chain.
  const result =
    intent === "markPaid"
      ? await markPaid(env, linkId, orderId, signature as Hex)
      : await cancelOrder(env, linkId, orderId, signature as Hex);

  if (!result.ok) {
    return json({ error: result.error ?? "This payment could not be processed." }, 502);
  }

  const hash = result.txHash ?? result.userOpHash!;

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
}

/** The link's account, for simulating as the caller that will really send. */
async function linkAccountFor(env: Env, linkId: string): Promise<Address | null> {
  return (await linkWalletAddress(env, linkId)) as Address | null;
}
