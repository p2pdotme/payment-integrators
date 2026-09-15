/**
 * Who is allowed to touch the blocklist.
 *
 * WHY THIS IS NOT A SHARED SECRET
 * A secret in configuration is one string that everyone with deploy access
 * holds, that nobody can be individually revoked from, and that leaves no trace
 * of WHO acted. For an endpoint whose whole purpose is reviewing a decision and
 * overriding it, "someone with the secret did this" is not good enough.
 *
 * The integrator already answers this question. It has a super-admin — the
 * single unremovable root — who assigns admins by tier, and `roleOf` reports the
 * effective tier of any address, with owners reading as FINANCE. So the operator
 * signs with the same wallet that already governs the contract, and authority
 * here follows authority there: add an admin on-chain and they can review blocks;
 * remove them and they cannot. Nothing to distribute, nothing to rotate, and the
 * signature says which person acted.
 *
 * THE TIER
 * SUPPORT, matching where the contract puts freezing a merchant — the same
 * shape of action: reversible, operational, no funds. The super-admin and every
 * owner clear it automatically by reading as FINANCE.
 *
 * WHAT THE SIGNATURE COVERS
 * The action, the address it concerns, an expiry, and a nonce. A signature that
 * named only the signer would be a bearer token: capture one unblock request
 * and you could replay it for any address, forever.
 *
 * The nonce closes what the expiry alone left open. Within the window a
 * captured signature could be replayed for the same (action, ip) — harmless for
 * an unblock, less so for a block. Each nonce is single-use and remembered for
 * the length of the window, which is exactly as long as a signature can be
 * valid, so the store never grows beyond that.
 */

import { verifyTypedData, type Address, type Hex } from "viem";
import { publicClientFor } from "./chain";
import type { Env } from "./config";

/** SUPPORT. Below this, an address may read the contract but not act on it. */
export const MIN_ADMIN_TIER = 2;

/** How long a signed request stays valid. Long enough for a human clicking a
 *  button, short enough that a captured one is quickly worthless. */
export const AUTH_WINDOW_SECONDS = 300;

const ROLE_ABI = [
  {
    type: "function",
    name: "roleOf",
    stateMutability: "view",
    inputs: [{ name: "who", type: "address" }],
    outputs: [{ type: "uint8" }],
  },
] as const;

export interface AdminAuth {
  /** The wallet that signed. */
  signer: Address;
  /** Their on-chain tier: 0 NONE, 1 VIEWER, 2 SUPPORT, 3 MANAGER, 4 FINANCE. */
  tier: number;
}

export interface AdminRequest {
  signer?: string;
  signature?: string;
  action?: string;
  ip?: string;
  /** Unix seconds. The signature is void after this. */
  expiry?: number;
  /** Single-use. Any string the caller has not used before. */
  nonce?: string;
}

/**
 * Verifies a signed operator request against the contract's own roles.
 *
 * Returns null when the request is not authorised, for any reason. Callers must
 * answer identically in every case — distinguishing "bad signature" from
 * "insufficient tier" tells an attacker which half to work on.
 */
export async function verifyAdmin(env: Env, req: AdminRequest): Promise<AdminAuth | null> {
  const { signer, signature, action, ip, expiry, nonce } = req;
  if (!signer || !signature || !action || typeof expiry !== "number") return null;
  if (!nonce || nonce.length > 128) return null;

  // Expiry first: it is free, and it is the check most likely to fail on a
  // replayed request.
  const now = Math.floor(Date.now() / 1000);
  if (expiry <= now) return null;
  // Also refuse an expiry far in the future — a signature valid for a year is a
  // bearer token wearing a timestamp.
  if (expiry > now + AUTH_WINDOW_SECONDS) return null;

  const chainId = Number(env.CHAIN_ID);

  let ok = false;
  try {
    ok = await verifyTypedData({
      address: signer as Address,
      // Bound to this chain AND this integrator, so a signature from a testnet
      // deployment cannot be replayed against production.
      domain: {
        name: "P2P Merchant Terminal Admin",
        version: "1",
        chainId,
        verifyingContract: env.INTEGRATOR_ADDRESS as Address,
      },
      types: {
        AdminAction: [
          { name: "action", type: "string" },
          { name: "ip", type: "string" },
          { name: "expiry", type: "uint256" },
          { name: "nonce", type: "string" },
        ],
      },
      primaryType: "AdminAction",
      message: { action, ip: ip ?? "", expiry: BigInt(expiry), nonce: nonce ?? "" },
      signature: signature as Hex,
    });
  } catch {
    return null;
  }
  if (!ok) return null;

  // The signature proves WHO. The chain decides WHETHER.
  let tier = 0;
  try {
    tier = Number(
      await publicClientFor(env).readContract({
        address: env.INTEGRATOR_ADDRESS as Address,
        abi: ROLE_ABI,
        functionName: "roleOf",
        args: [signer as Address],
      })
    );
  } catch {
    // An unreadable chain must not become an open door. Refusing here means a
    // support action waits for the RPC to come back, which is the right way
    // round for an endpoint that can lift a fraud block.
    return null;
  }

  if (tier < MIN_ADMIN_TIER) return null;

  // Burn the nonce LAST, so a request that was going to be refused anyway does
  // not consume one. Remembered only for the window, because a signature cannot
  // outlive it.
  const seen = `admin:nonce:${signer.toLowerCase()}:${nonce}`;
  if (await env.KV.get(seen)) return null;
  await env.KV.put(seen, "1", { expirationTtl: AUTH_WINDOW_SECONDS });

  return { signer: signer as Address, tier };
}
