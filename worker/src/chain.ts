/**
 * Chain access. Two clients: a read client anyone can use, and a wallet client
 * that exists only to sign `relayerPlaceOrder`.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { INTEGRATOR_ABI, type Env } from "./config";

export function chainFor(env: Env) {
  const id = Number(env.CHAIN_ID);
  return defineChain({
    id,
    name: id === 8453 ? "Base" : "Base Sepolia",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [env.RPC_URL] } },
  });
}

export function publicClientFor(env: Env): PublicClient {
  return createPublicClient({ chain: chainFor(env), transport: http(env.RPC_URL) });
}

/**
 * @deprecated Nothing on the payment path calls this. The sender is now each
 * link's own account — see `linkOps`. It survives only for the `NonceManager`
 * durable object, which nothing instantiates, and goes when the keeper duty
 * moves to its own operator key.
 *
 * Throws a legible error rather than letting viem fail on `undefined`, because
 * the key is optional now and reaching this without one is a wiring mistake
 * worth naming.
 */
export function relayerFor(env: Env): { wallet: WalletClient; address: Address } {
  if (!env.RELAYER_PRIVATE_KEY) {
    throw new Error(
      "relayerFor() called without RELAYER_PRIVATE_KEY. Nothing on the payment " +
        "path needs it — the sender is each link's own account."
    );
  }
  const account = privateKeyToAccount(env.RELAYER_PRIVATE_KEY as Hex);
  return {
    wallet: createWalletClient({ account, chain: chainFor(env), transport: http(env.RPC_URL) }),
    address: account.address,
  };
}

export const LINK_STATUS_ACTIVE = 0;

export interface Link {
  owner: Address;
  amount: bigint;
  currency: Hex;
  expiresAt: bigint;
  /** How many SUCCESSFUL payments the link accepts. 0 = unlimited. */
  maxUses: number;
  status: number;
  uses: number;
  /** Marked-paid-then-cancelled claims. Advisory: the chain never blocks on it. */
  strikes: number;
}

/**
 * Reads a link straight from the chain.
 *
 * This is the security boundary of the pay endpoint: the customer's browser
 * supplies a linkId and a quantity, and NOTHING else about the payment is
 * taken from it. Amount, currency, owner, and status all come from here.
 *
 * Returns null when the link does not exist (getLink reverts LinkNotFound).
 */
export async function readLink(client: PublicClient, env: Env, linkId: Hex): Promise<Link | null> {
  try {
    const r = (await client.readContract({
      address: env.INTEGRATOR_ADDRESS as Address,
      abi: INTEGRATOR_ABI,
      functionName: "getLink",
      args: [linkId],
    })) as readonly [Address, bigint, Hex, bigint, number, number, number, number];

    return {
      owner: r[0],
      amount: r[1],
      currency: r[2],
      expiresAt: r[3],
      maxUses: r[4],
      status: r[5],
      uses: r[6],
      strikes: r[7],
    };
  } catch (err) {
    // A link that does not exist reverts LinkNotFound. Anything else — a
    // timeout, a rate-limited RPC, a bad URL — is OUR problem, and telling the
    // customer "this link was not found" sends them to argue with a merchant
    // about a link that is perfectly fine. Distinguish the two.
    const s = String((err as Error)?.message ?? err);
    if (s.includes("0x3b82cbf1") || s.includes("LinkNotFound")) return null;
    throw err;
  }
}

/**
 * Why a link cannot be paid right now, based on the link's own fields.
 *
 * Deliberately narrower than the contract's `isLinkActive`, which also sees
 * merchant- and contract-level gates (frozen, paused, link orders halted, a
 * cap lowered under a fixed amount). We do NOT re-implement those here: the
 * simulation in the pay path catches every one of them and yields a precise,
 * customer-readable message via `explainRevert`. Duplicating them would mean
 * two copies of the same rules drifting apart, which is exactly the failure
 * mode the shared `_placeOrder` helper exists to avoid on-chain.
 *
 * What this buys is a cheap early exit on the common cases — expired, revoked,
 * already paid — before we spend an RPC round-trip simulating.
 */
export function linkBlockedReason(link: Link, nowSec: number): string | null {
  if (link.status !== LINK_STATUS_ACTIVE) return "This payment link has been cancelled.";
  if (link.expiresAt !== 0n && BigInt(nowSec) > link.expiresAt)
    return "This payment link has expired.";
  // maxUses 0 means unlimited; otherwise the link is spent once `uses` reaches
  // it. `uses` counts SUCCESSFUL payments — a cancelled or abandoned order
  // releases its use on-chain, so an abandoned checkout never retires a link.
  if (link.maxUses !== 0 && link.uses >= link.maxUses)
    return "This payment link has already been used the maximum number of times.";
  return null;
}
