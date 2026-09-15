/**
 * Per-link wallet keys.
 *
 * WHAT REPLACED WHAT
 * There used to be one funded relayer key, held in configuration, signing for
 * every merchant. The review rejected it — single point of failure, no spending
 * limits, one nonce sequence that blocks under load — and rejected a pool of
 * such keys for the same reason: a funded key still sits on the payment path.
 *
 * Here there is no funded key at all. Each link gets its own account-abstraction
 * wallet whose gas a paymaster pays, so the wallet holds nothing and can hold
 * nothing. What we store is that wallet's signing key, and its entire authority
 * is calling `LinkRouter` for one link. Stealing it yields the key to an empty
 * box.
 *
 * WHAT IS AND IS NOT SECRET
 * Two independent things are needed to recover a link key: the master secret
 * AND read access to the key store. They are deliberately kept apart, which is
 * also why keys are never derived deterministically from the link id alone —
 * that would make the master secret sufficient on its own, and there would be
 * no store left to compromise separately.
 *
 * In production `LINK_KEY_MASTER` should be a handle to a managed key service
 * rather than raw material in configuration, so that every unwrap is logged and
 * the credential can be revoked in seconds. The interface below does not change
 * when that swap happens: only `importMaster` does.
 */

import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import type { Address, Hex } from "viem";
import type { Env } from "./config";

/** Wrapped key record as stored. Versioned so the format can move. */
interface StoredKey {
  v: 1;
  /** AES-GCM initialisation vector, base64. */
  iv: string;
  /** Ciphertext of the private key, base64. */
  ct: string;
  /** The OWNER of the account — the key we wrapped above. */
  owner: Address;
  /** The ACCOUNT address, which is what the Router is told about and what
   *  appears on-chain as the caller. This is NOT the owner: the owner is an
   *  ordinary key that could never have its gas sponsored, whereas the account
   *  is the smart account that key controls. Registering the owner by mistake
   *  produces a link that looks correctly configured and can never be paid.
   *
   *  Kept in clear: both are public on-chain anyway, and having them avoids an
   *  unwrap just to answer "which address is this link". */
  account: Address;
  /**
   * The merchant who provisioned this wallet.
   *
   * Kept so a retry can be told apart from someone else claiming the same link
   * id. A second mint would produce a different address, and `registerAgent` is
   * write-once — so handing back a fresh address on retry would strand the link
   * permanently.
   */
  minter?: Address;
}

const keyName = (linkId: string) => `linkkey:${linkId.toLowerCase()}`;

const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * Derives the per-link wrapping key.
 *
 * HKDF over the link id rather than using the master directly: one recovered
 * ciphertext then tells an attacker nothing about any other link, and rotating
 * the master needs no bulk re-encryption because links expire on their own.
 */
async function wrappingKey(env: Env, linkId: string): Promise<CryptoKey> {
  const master = await crypto.subtle.importKey("raw", unb64(env.LINK_KEY_MASTER), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(linkId.toLowerCase()),
      info: new TextEncoder().encode("p2p-link-wallet-v1"),
    },
    master,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Creates the wallet for a link and stores its key, wrapped.
 *
 * @param ttlSeconds How long the record lives, or undefined for no expiry —
 *        see `keyTtlFor`. It tracks the LINK's life exactly: a key that expired
 *        before its link would strand that link forever, because
 *        `registerAgent` is write-once and a new key means a new address.
 * @param resolveAccount Turns the generated owner key into the SMART ACCOUNT
 *        address that key controls. Injected rather than imported so this module
 *        stays free of chain access and testable without one; production passes
 *        `predictAccount` from `aa.ts`, which reads it from the factory.
 * @returns The ACCOUNT address — what the merchant registers on the Router, and
 *        what appears on-chain as the caller. Not the owner key's own address.
 */
export async function createLinkWallet(
  env: Env,
  linkId: string,
  ttlSeconds: number | undefined,
  resolveAccount: (owner: Address) => Promise<Address>,
  minter?: Address
): Promise<Address> {
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  const accountAddress = await resolveAccount(account.address);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await wrappingKey(env, linkId),
    new TextEncoder().encode(pk)
  );

  const rec: StoredKey = {
    v: 1,
    iv: b64(iv.buffer),
    ct: b64(ct),
    owner: account.address,
    account: accountAddress,
    minter,
  };
  // No TTL when the link never expires — see `keyTtlFor`.
  await env.KV.put(
    keyName(linkId),
    JSON.stringify(rec),
    ttlSeconds === undefined ? {} : { expirationTtl: ttlSeconds }
  );
  return accountAddress;
}

/**
 * Unwraps a link's signing key.
 *
 * Returns null rather than throwing when the record is missing or unreadable.
 * A missing record is the ordinary end state of an expired link, not an error,
 * and callers must treat it as "this link can no longer be driven" — which is
 * exactly the intended behaviour.
 */
export async function linkSigner(env: Env, linkId: string) {
  const raw = await env.KV.get(keyName(linkId));
  if (!raw) return null;

  let rec: StoredKey;
  try {
    rec = JSON.parse(raw) as StoredKey;
    if (rec.v !== 1) return null;
  } catch {
    return null;
  }

  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(rec.iv) },
      await wrappingKey(env, linkId),
      unb64(rec.ct)
    );
    // AES-GCM is authenticated, so reaching here means the ciphertext was
    // produced under this master and this link id. A tampered record throws.
    return privateKeyToAccount(new TextDecoder().decode(pt) as Hex);
  } catch {
    return null;
  }
}

/** The ACCOUNT address for a link — the on-chain caller — without unwrapping
 *  the key. This is what `registerAgent` was given and what the Router checks. */
export async function linkWalletAddress(env: Env, linkId: string): Promise<Address | null> {
  const raw = await env.KV.get(keyName(linkId));
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as StoredKey).account;
  } catch {
    return null;
  }
}

/** The OWNER address for a link — the key that signs. Rarely needed; use
 *  `linkWalletAddress` for anything the chain will compare against. */
export async function linkOwnerAddress(env: Env, linkId: string): Promise<Address | null> {
  const raw = await env.KV.get(keyName(linkId));
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as StoredKey).owner;
  } catch {
    return null;
  }
}

/** Which merchant provisioned this link's wallet, if any. Used to tell a
 *  retry apart from someone else claiming the same link id. */
export async function mintedBy(env: Env, linkId: string): Promise<Address | null> {
  const raw = await env.KV.get(keyName(linkId));
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as StoredKey).minter ?? null;
  } catch {
    return null;
  }
}

/** Deletes a link's key. Used when a merchant revokes a link, so the wallet
 *  stops being drivable immediately rather than at expiry. */
export async function destroyLinkWallet(env: Env, linkId: string): Promise<void> {
  await env.KV.delete(keyName(linkId));
}

/**
 * How long a link's key should live: exactly as long as the link.
 *
 * WHY THERE IS NO CAP ANY MORE
 * There used to be a 30-day ceiling, on the reasoning that an indefinitely
 * valid signing key is what this design exists to remove. Round-3 review, M1,
 * showed that reasoning was wrong here and the cap was actively harmful:
 *
 *   • `createLink` permits `expiresAt = 0`, a link that never expires
 *   • the cap evicted its key at day 30
 *   • `registerAgent` is WRITE-ONCE, so a fresh key — which derives a different
 *     account address — can never be bound
 *
 * The link then reads ACTIVE on-chain and fails for every customer, forever,
 * with no way back. A comment here claimed the link "is re-issued while it
 * stays live"; no such path existed, and the write-once binding is precisely
 * what prevents one.
 *
 * The cap bought nothing to offset that. This key's entire power is placing an
 * order on ONE link, at a price the merchant fixed, and mark-paid and cancel
 * need the customer's signature on top. An indefinitely valid key to that is
 * exactly as dangerous as an indefinitely payable link — which is what the
 * merchant chose when they set no expiry. Capping the key BELOW the link's life
 * created a failure; it prevented nothing.
 *
 * So: no expiry on the link, no expiry on the key. Revoking the link deletes it
 * (`destroyLinkWallet`), which is the real off-switch.
 */
/**
 * Cloudflare KV refuses `expirationTtl` below 60 seconds, by throwing from
 * inside `put`. That makes it a value this function must never return.
 */
export const KV_MIN_TTL = 60;

export function keyTtlFor(
  expiresAt: bigint,
  now = Math.floor(Date.now() / 1000)
): number | undefined | null {
  // undefined => no expiry, matching a link that never expires.
  if (expiresAt === 0n) return undefined;
  const remaining = Number(expiresAt) - now;
  // null => ALREADY EXPIRED, refuse. Round-4 L6: this used to return 0, which
  // KV rejects, throwing out of `KV.put` into a route with no error boundary —
  // a 500 with no CORS headers, which the pay page can only surface as an
  // opaque network error. Refusing is also the correct answer on the merits:
  // an expired link cannot be paid, so there is nothing worth provisioning.
  if (remaining <= 0) return null;
  // A link expiring in under a minute is legal on-chain but not expressible as
  // a KV TTL. Round up rather than refuse — the key outliving its link by under
  // a minute is harmless, because expiry is enforced by the integrator on every
  // order, never by the lifetime of this record.
  return Math.max(KV_MIN_TTL, remaining);
}
