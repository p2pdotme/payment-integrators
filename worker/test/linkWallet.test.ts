import { describe, it, expect, beforeEach } from "vitest";
import { webcrypto } from "node:crypto";
import {
  mintedBy,
  createLinkWallet,
  linkSigner,
  linkWalletAddress,
  linkOwnerAddress,
  destroyLinkWallet,
  keyTtlFor,
  KV_MIN_TTL,
} from "../src/linkWallet";
import type { Env } from "../src/config";

/**
 * Per-link wallet keys.
 *
 * WHAT THESE KEYS ARE WORTH
 * Nothing, and that is the design. The old relayer key was funded and signed
 * for every merchant, which is what the review rejected. These sign for one
 * link, hold no balance, and cannot pay their own gas — a paymaster does. So
 * the interesting properties to assert are not "the key is well protected" but
 * "the key is correctly scoped and correctly disposable".
 *
 * The one property that IS about protection: recovering a key requires both the
 * master secret and the stored record. These tests hold the store and vary the
 * master, and vice versa, to show neither alone is enough.
 */

if (!(globalThis as any).crypto) (globalThis as any).crypto = webcrypto;

const MASTER_A = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
const MASTER_B = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");

/**
 * Stands in for the account factory.
 *
 * Returns an address that is DIFFERENT from the owner, deliberately: the real
 * factory does too, and conflating the two produces a link that looks
 * correctly configured and can never be paid. Several tests below exist only
 * to pin that distinction.
 */
const fakeFactory = async (owner: `0x${string}`): Promise<`0x${string}`> =>
  ("0xacc0" + owner.slice(6)) as `0x${string}`;

const LINK = "0x" + "ab".repeat(32);
const LINK2 = "0x" + "cd".repeat(32);

function fakeEnv(master = MASTER_A): { env: Env; store: Map<string, string> } {
  const store = new Map<string, string>();
  const env = {
    LINK_KEY_MASTER: master,
    KV: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
      list: async () => ({ keys: [] }),
    } as unknown as KVNamespace,
  } as Env;
  return { env, store };
}

describe("per-link wallet keys", () => {
  let env: Env;
  let store: Map<string, string>;

  beforeEach(() => {
    ({ env, store } = fakeEnv());
  });

  it("creates a wallet and can sign with it again later", async () => {
    const account = await createLinkWallet(env, LINK, 3600, fakeFactory);
    const signer = await linkSigner(env, LINK);
    expect(signer).not.toBeNull();
    // The signer owns the account; it is not the account. Comparing the two
    // is the mistake this distinction exists to prevent.
    expect(signer!.address).toBe(await linkOwnerAddress(env, LINK));
    expect(account).toBe(await linkWalletAddress(env, LINK));
  });

  it("gives every link a different wallet", async () => {
    const a = await createLinkWallet(env, LINK, 3600, fakeFactory);
    const b = await createLinkWallet(env, LINK2, 3600, fakeFactory);
    // Scope is exact because the addresses differ. A key leaked from one link
    // is the wrong address for any other, which is what the Router checks.
    expect(a).not.toBe(b);
  });

  it("never writes the private key in the clear", async () => {
    await createLinkWallet(env, LINK, 3600, fakeFactory);
    const raw = store.get(`linkkey:${LINK}`)!;
    const signer = await linkSigner(env, LINK);
    // The wrapped record must not contain the key material it protects. The
    // owner ADDRESS is fine to store — it is public; the private key is not.
    expect(raw).not.toContain(signer!.privateKey ?? "\u0000never");
    expect(JSON.parse(raw).ct).toBeTruthy();
    expect(JSON.parse(raw).v).toBe(1);
  });

  it("exposes the ACCOUNT address without unwrapping the key", async () => {
    const addr = await createLinkWallet(env, LINK, 3600, fakeFactory);
    expect(await linkWalletAddress(env, LINK)).toBe(addr);
  });

  it("returns the ACCOUNT address, never the owner key's own address", async () => {
    // The bug this pins: registering the owner instead of the account gives a
    // link that passes every check we make locally and can never be paid,
    // because the address that actually calls the Router is the account.
    const account = await createLinkWallet(env, LINK, 3600, fakeFactory);
    const owner = await linkOwnerAddress(env, LINK);
    const signer = await linkSigner(env, LINK);

    expect(owner).toBe(signer!.address);
    expect(account).not.toBe(owner);
    expect(account).toBe(await fakeFactory(owner!));
  });

  // ─── Neither secret is sufficient alone ────────────────────────────

  it("a stolen store is useless without the master secret", async () => {
    await createLinkWallet(env, LINK, 3600, fakeFactory);

    // Same records, different master. This is an attacker who exfiltrated the
    // key store but not the managed-key credential.
    const other = fakeEnv(MASTER_B);
    for (const [k, v] of store) await other.env.KV.put(k, v);

    expect(await linkSigner(other.env, LINK)).toBeNull();
  });

  it("a stolen master is useless without the stored record", async () => {
    // Keys are never derived deterministically from the link id, precisely so
    // that the master alone is not enough — there is always a second thing to
    // steal.
    await createLinkWallet(env, LINK, 3600, fakeFactory);
    const emptyStore = fakeEnv(MASTER_A);
    expect(await linkSigner(emptyStore.env, LINK)).toBeNull();
  });

  it("refuses a record wrapped for a different link", async () => {
    // The link id is the HKDF salt, so a record moved between links fails
    // authentication rather than yielding some other link's signer.
    await createLinkWallet(env, LINK, 3600, fakeFactory);
    store.set(`linkkey:${LINK2}`, store.get(`linkkey:${LINK}`)!);
    expect(await linkSigner(env, LINK2)).toBeNull();
  });

  it("refuses a tampered record rather than returning a junk signer", async () => {
    await createLinkWallet(env, LINK, 3600, fakeFactory);
    const rec = JSON.parse(store.get(`linkkey:${LINK}`)!);
    const ct = Buffer.from(rec.ct, "base64");
    ct[0] ^= 0xff;
    rec.ct = ct.toString("base64");
    store.set(`linkkey:${LINK}`, JSON.stringify(rec));

    // AES-GCM is authenticated, so this fails closed.
    expect(await linkSigner(env, LINK)).toBeNull();
  });

  it("treats a missing record as 'no longer drivable', not as an error", async () => {
    // The ordinary end state of an expired link. Callers must get null, not a
    // throw, so an expired link degrades quietly instead of 500ing.
    expect(await linkSigner(env, LINK)).toBeNull();
    expect(await linkWalletAddress(env, LINK)).toBeNull();
  });

  it("destroy makes the wallet immediately undrivable", async () => {
    await createLinkWallet(env, LINK, 3600, fakeFactory);
    await destroyLinkWallet(env, LINK);
    expect(await linkSigner(env, LINK)).toBeNull();
  });

  it("records which merchant provisioned it", async () => {
    // Needed to tell a retry apart from someone else claiming the same link id.
    // A second mint would produce a different address, and `registerAgent` is
    // write-once — so handing back a fresh address on retry strands the link.
    const merchant = "0x1234567890123456789012345678901234567890" as const;
    await createLinkWallet(env, LINK, 3600, fakeFactory, merchant);
    expect(await mintedBy(env, LINK)).toBe(merchant);
    expect(await mintedBy(env, LINK2)).toBeNull();
  });

  it("is case-insensitive about the link id", async () => {
    const account = await createLinkWallet(
      env,
      LINK.toUpperCase().replace("0X", "0x"),
      3600,
      fakeFactory
    );
    const signer = await linkSigner(env, LINK);
    expect(signer).not.toBeNull();
    expect(account).toBe(await linkWalletAddress(env, LINK));
  });
});

describe("key lifetime", () => {
  const NOW = 1_800_000_000;

  it("matches the link's own expiry when that is sooner", () => {
    expect(keyTtlFor(BigInt(NOW + 3600), NOW)).toBe(3600);
  });

  it("gives a never-expiring link a key with NO expiry", () => {
    // This asserted a 30-day cap, and the cap was a bug — round-3 M1.
    //
    // `createLink` permits expiresAt = 0. Capping the key at 30 days evicted it
    // while the link was still ACTIVE, and `registerAgent` is WRITE-ONCE, so a
    // fresh key — which derives a different account address — could never be
    // bound. The link then failed for every customer, forever, with no way back.
    //
    // The cap bought nothing to offset that: this key can only place an order on
    // one link at a price the merchant fixed, and settling needs the customer's
    // signature on top. It is exactly as dangerous as the link being payable,
    // which is what the merchant chose.
    expect(keyTtlFor(0n, NOW)).toBeUndefined();
  });

  it("follows a distant expiry rather than capping it", () => {
    const year = 365 * 24 * 3600;
    expect(keyTtlFor(BigInt(NOW + year), NOW)).toBe(year);
  });

  it("REFUSES an already-expired link rather than returning an illegal TTL", () => {
    // This asserted `0`, and `0` was a bug — round-4 L6.
    //
    // Cloudflare KV rejects any expirationTtl below 60 by THROWING from inside
    // `put`. Zero therefore never expressed "expire immediately"; it threw out
    // of the provisioning route, which had no error boundary, and reached the
    // pay page as a bare 500 with no CORS headers — unreadable by the browser,
    // and so indistinguishable from the Worker being down.
    //
    // `null` instead, and the caller refuses with a 410. That is also the right
    // answer on the merits: an expired link cannot be paid, so there is nothing
    // worth provisioning a wallet for.
    expect(keyTtlFor(BigInt(NOW - 1), NOW)).toBeNull();
  });

  it("never returns a TTL below KV's 60-second floor", () => {
    // The other half of L6, and the one that could bite a LIVE link: a link
    // expiring in 30 seconds is perfectly legal on-chain but not expressible as
    // a KV TTL. Round up rather than refuse — the key outliving its link by
    // under a minute is harmless, because expiry is enforced by the integrator
    // on every order, never by the lifetime of this record.
    expect(keyTtlFor(BigInt(NOW + 1), NOW)).toBe(KV_MIN_TTL);
    expect(keyTtlFor(BigInt(NOW + 59), NOW)).toBe(KV_MIN_TTL);
    expect(keyTtlFor(BigInt(NOW + 61), NOW)).toBe(61);
  });
});
