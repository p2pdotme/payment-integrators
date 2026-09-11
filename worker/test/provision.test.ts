import { describe, it, expect, beforeEach, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";
import { handleProvisionWallet } from "../src/provision";
import { linkWalletAddress, linkSigner, mintedBy } from "../src/linkWallet";
import type { Env } from "../src/config";

/**
 * Minting a link's wallet.
 *
 * WHY THIS ENDPOINT EXISTS AT ALL
 * Round-3 review, B1: nothing in production called `createLinkWallet`. The key
 * that every payment is signed with was written only by tests, so on a real
 * deployment `linkSigner` returned null and every payment answered "This
 * payment link is no longer active." And the merchant had no way to obtain the
 * account address `registerAgent` needs, because it was generated inside
 * `createLinkWallet` and returned only to its caller.
 *
 * So the interesting cases here are not the happy path. They are: who may mint,
 * what a retry does, and what happens when the link does not exist yet — which
 * is the NORMAL case, because the address is needed before the batch that
 * creates the link is signed.
 */

if (!(globalThis as any).crypto) (globalThis as any).crypto = webcrypto;

const MERCHANT = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
);
const OTHER_MERCHANT = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
);
const STRANGER = privateKeyToAccount(
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"
);

const INTEGRATOR = "0x1111111111111111111111111111111111111111";
const CHAIN_ID = 8453;
const LINK = ("0x" + "ab".repeat(32)) as `0x${string}`;

/** What the fake chain answers. */
let registered = new Set<string>();
let frozen = new Set<string>();
/** linkId -> owner, or absent to model a link that does not exist yet. */
let links = new Map<string, string>();
/** linkId -> expiresAt. Absent means 0n, a link that never expires. */
let linkExpiry = new Map<string, bigint>();
/** Set to fail the chain reads, for the RPC-outage cases. */
let rpcDown = false;

vi.mock("../src/chain", () => ({
  publicClientFor: () => ({
    // REAL signature verification — only the chain reads are stubbed. In
    // production this is the public client, which additionally asks a smart
    // account via ERC-1271; here every signer is an EOA, so plain recovery is
    // the same answer.
    verifyTypedData: async (a: any) => verifyTypedData(a),
    readContract: async ({ functionName, args }: any) => {
      if (rpcDown) throw new Error("rpc unreachable");
      if (functionName === "getLink") {
        const owner = links.get(String(args[0]).toLowerCase());
        // The integrator reverts LinkNotFound for a link that does not exist,
        // which is the case the merchant is in when minting before the batch.
        if (!owner) throw new Error("LinkNotFound");
        const expiresAt = linkExpiry.get(String(args[0]).toLowerCase()) ?? 0n;
        return [owner, 0n, "0x", expiresAt, 0, 0, 0, 0];
      }
      if (functionName === "getMerchantInfo") {
        const who = String(args[0]).toLowerCase();
        return ["0x", "shop", "0x", registered.has(who), frozen.has(who)];
      }
      throw new Error("unexpected read " + functionName);
    },
  }),
}));

vi.mock("../src/aa", () => ({
  // A distinct, deterministic account address per owner — the real factory does
  // the same, and conflating owner with account is the bug a test elsewhere pins.
  predictAccount: async (_env: Env, owner: `0x${string}`) =>
    ("0xacc0" + owner.slice(6)) as `0x${string}`,
}));

const nowSec = () => Math.floor(Date.now() / 1000);

function fakeEnv(): { env: Env; store: Map<string, string> } {
  registered = new Set([MERCHANT.address.toLowerCase(), OTHER_MERCHANT.address.toLowerCase()]);
  frozen = new Set();
  links = new Map();
  linkExpiry = new Map();
  rpcDown = false;

  const store = new Map<string, string>();
  const env = {
    CHAIN_ID: String(CHAIN_ID),
    INTEGRATOR_ADDRESS: INTEGRATOR,
    LINK_KEY_MASTER: Buffer.from(new Uint8Array(32).fill(3)).toString("base64"),
    KV: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
      list: async () => ({ keys: [] }),
    } as unknown as KVNamespace,
  } as unknown as Env;
  return { env, store };
}

async function sign(
  who: ReturnType<typeof privateKeyToAccount>,
  linkId: string,
  over: { expiry?: number; integrator?: string; chainId?: number } = {}
) {
  const expiry = over.expiry ?? nowSec() + 120;
  const signature = await who.signTypedData({
    domain: {
      name: "P2P Merchant Terminal Admin",
      version: "1",
      chainId: over.chainId ?? CHAIN_ID,
      verifyingContract: (over.integrator ?? INTEGRATOR) as `0x${string}`,
    },
    types: {
      LinkWallet: [
        { name: "linkId", type: "bytes32" },
        { name: "expiry", type: "uint256" },
      ],
    },
    primaryType: "LinkWallet",
    message: { linkId: linkId as `0x${string}`, expiry: BigInt(expiry) },
  });
  return { signer: who.address, signature, expiry };
}

async function provision(
  env: Env,
  who: ReturnType<typeof privateKeyToAccount>,
  linkId = LINK,
  over: Parameters<typeof sign>[2] = {},
  bodyOver: Record<string, unknown> = {}
) {
  const body = { ...(await sign(who, linkId, over)), ...bodyOver };
  return handleProvisionWallet(
    new Request(`https://w/api/links/${linkId}/wallet`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    linkId
  );
}

describe("minting a link's wallet", () => {
  let env: Env;

  beforeEach(() => {
    ({ env } = fakeEnv());
  });

  it("mints for a registered merchant before the link exists", async () => {
    // The NORMAL case. The address is needed before the batch that creates the
    // link is signed, so ownership cannot be checked against link.owner yet.
    const res = await provision(env, MERCHANT);
    const body = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(body.account).toMatch(/^0xacc0/);
    expect(body.existing).toBe(false);
    // The ordering constraint is stated in the response, because getting it
    // wrong is silent: omit registerAgent and the link looks correct forever.
    expect(body.next).toContain("createLink");
    expect(body.next).toContain("registerAgent");
  });

  it("writes a key the payment path can actually unwrap", async () => {
    // The whole point of B1: without this record every payment fails with
    // "this link is no longer active".
    await provision(env, MERCHANT);
    expect(await linkSigner(env, LINK)).not.toBeNull();
    expect(await linkWalletAddress(env, LINK)).toMatch(/^0xacc0/);
    expect(await mintedBy(env, LINK)).toBe(MERCHANT.address);
  });

  it("returns the SAME address on retry, rather than minting again", async () => {
    // registerAgent is write-once. A retry after a dropped response that handed
    // back a fresh address would strand the link permanently.
    const first = (await (await provision(env, MERCHANT)).json()) as any;
    const second = (await (await provision(env, MERCHANT)).json()) as any;

    expect(second.account).toBe(first.account);
    expect(second.existing).toBe(true);
  });

  it("prefers the link's own owner once the link exists", async () => {
    // Stronger than the registered-merchant check, so it is used when available.
    links.set(LINK.toLowerCase(), OTHER_MERCHANT.address);
    expect((await provision(env, OTHER_MERCHANT)).status).toBe(200);
  });

  // ─── Who may mint ─────────────────────────────────────────────────

  it("refuses a wallet that is not a registered merchant", async () => {
    expect((await provision(env, STRANGER)).status).toBe(403);
    expect(await linkSigner(env, LINK)).toBeNull();
  });

  it("refuses a FROZEN merchant", async () => {
    // They cannot take payments, so issuing a link wallet only creates
    // something that fails later, after a customer has already engaged with it.
    frozen.add(MERCHANT.address.toLowerCase());
    expect((await provision(env, MERCHANT)).status).toBe(403);
  });

  it("refuses a merchant who does not own an EXISTING link", async () => {
    links.set(LINK.toLowerCase(), OTHER_MERCHANT.address);
    expect((await provision(env, MERCHANT)).status).toBe(403);
  });

  it("refuses a second merchant claiming a link id already minted", async () => {
    // Not a security hole — link ids are merchant-derived — but overwriting
    // would strand whatever the first merchant registered.
    await provision(env, MERCHANT);
    const res = await provision(env, OTHER_MERCHANT);
    expect(res.status).toBe(409);
    expect(await mintedBy(env, LINK)).toBe(MERCHANT.address);
  });

  it("refuses a FROZEN merchant even on a link they already own", async () => {
    // The frozen check used to run only on the not-yet-created path, so a
    // merchant frozen AFTER creating a link could still mint for it — and
    // frozen merchants cannot take payments, so the wallet only fails later.
    links.set(LINK.toLowerCase(), MERCHANT.address);
    frozen.add(MERCHANT.address.toLowerCase());
    expect((await provision(env, MERCHANT)).status).toBe(403);
  });

  it("refuses everything when the chain is unreadable", async () => {
    // An earlier version caught the getLink failure and fell through to the
    // weaker "is a registered merchant" check — so an RPC blip on someone
    // else's EXISTING link let a different merchant mint for it. They could not
    // registerAgent, but they occupied the record and the real owner's link id
    // was dead. An outage must not widen who may mint.
    rpcDown = true;
    expect((await provision(env, MERCHANT)).status).toBe(403);
    expect(await linkSigner(env, LINK)).toBeNull();
  });

  it("does not let an RPC blip hand someone else's link to another merchant", async () => {
    // The concrete shape of the bug above.
    links.set(LINK.toLowerCase(), OTHER_MERCHANT.address);
    rpcDown = true;
    expect((await provision(env, MERCHANT)).status).toBe(403);

    // And with the chain readable, ownership is enforced as it should be.
    rpcDown = false;
    expect((await provision(env, MERCHANT)).status).toBe(403);
    expect((await provision(env, OTHER_MERCHANT)).status).toBe(200);
  });

  // ─── The signature ────────────────────────────────────────────────

  it("refuses an unsigned request", async () => {
    const res = await handleProvisionWallet(
      new Request(`https://w/api/links/${LINK}/wallet`, {
        method: "POST",
        body: JSON.stringify({ signer: MERCHANT.address }),
      }),
      env,
      LINK
    );
    expect(res.status).toBe(403);
  });

  it("refuses a signature for a DIFFERENT link", async () => {
    // The linkId is inside the signature. Without that, a captured signature
    // mints a wallet for any link the holder names — and the address is the
    // whole authorisation, since it is what gets bound on-chain.
    const other = ("0x" + "cd".repeat(32)) as `0x${string}`;
    const signed = await sign(MERCHANT, other);
    const res = await handleProvisionWallet(
      new Request(`https://w/api/links/${LINK}/wallet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signed),
      }),
      env,
      LINK
    );
    expect(res.status).toBe(403);
  });

  it("refuses an expired signature, and one valid absurdly long", async () => {
    expect((await provision(env, MERCHANT, LINK, { expiry: nowSec() - 1 })).status).toBe(403);
    expect((await provision(env, MERCHANT, LINK, { expiry: nowSec() + 31_536_000 })).status).toBe(
      403
    );
  });

  it("refuses a signature bound to another integrator or chain", async () => {
    expect(
      (
        await provision(env, MERCHANT, LINK, {
          integrator: "0x9999999999999999999999999999999999999999",
        })
      ).status
    ).toBe(403);
    expect((await provision(env, MERCHANT, LINK, { chainId: 1 })).status).toBe(403);
  });

  it("refuses a forged signer field", async () => {
    const signed = await sign(STRANGER, LINK);
    const res = await handleProvisionWallet(
      new Request(`https://w/api/links/${LINK}/wallet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...signed, signer: MERCHANT.address }),
      }),
      env,
      LINK
    );
    expect(res.status).toBe(403);
  });

  it("rejects a link id that is not 32 bytes", async () => {
    const res = await handleProvisionWallet(
      new Request("https://w/api/links/0x1234/wallet", { method: "POST", body: "{}" }),
      env,
      "0x1234"
    );
    expect(res.status).toBe(400);
  });

  // ─── Round-4 L6 ───────────────────────────────────────────────────

  it("refuses an already-expired link instead of throwing an illegal KV TTL", async () => {
    // L6. `keyTtlFor` returned 0 for an expired link, and Cloudflare KV rejects
    // any expirationTtl below 60 by THROWING from inside `put`. The route had no
    // try/catch, so this surfaced as a bare 500 with no CORS headers — which the
    // pay page cannot read at all, and so reports as an opaque network error.
    //
    // Reachable on the RE-provision path: the first-time path passes 0n (the
    // link does not exist yet) and is fine, but a merchant re-provisioning a
    // link that has since expired lands here.
    links.set(LINK.toLowerCase(), MERCHANT.address);
    linkExpiry.set(LINK.toLowerCase(), BigInt(nowSec() - 60));

    const res = await provision(env, MERCHANT);
    expect(res.status).toBe(410);
    expect((await res.json()) as any).toMatchObject({
      error: expect.stringContaining("expired"),
    });
  });

  it("mints for a link expiring within KV's 60-second floor", async () => {
    // The other half of L6. A link expiring in 30 seconds is legal on-chain but
    // not expressible as a KV TTL, so the TTL rounds up rather than refusing —
    // a live link must stay provisionable.
    links.set(LINK.toLowerCase(), MERCHANT.address);
    linkExpiry.set(LINK.toLowerCase(), BigInt(nowSec() + 30));

    const res = await provision(env, MERCHANT);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).account).toMatch(/^0xacc0/);
  });

  // ─── Round-4 L7 ───────────────────────────────────────────────────

  it("rate limits provisioning per MERCHANT, not per IP", async () => {
    // L7. The route costs two RPC reads and, since round-3 M1 removed the key
    // TTL cap, writes a KV record with NO expiry for a link with expiresAt = 0.
    // It is signature-gated, so the world cannot reach it — but one compromised
    // merchant key could otherwise write unbounded permanent records.
    //
    // Keyed on the merchant because that is the axis the signature establishes.
    // An IP bucket would be the wrong one: many merchants behind one carrier NAT
    // is the case that must not be punished.
    const { MAX_PROVISIONS_PER_MERCHANT_HOUR } = await import("../src/provision");
    const hour = Math.floor(Date.now() / 3_600_000);
    const key = `rl:provision:${MERCHANT.address.toLowerCase()}:${hour}`;
    await env.KV.put(key, String(MAX_PROVISIONS_PER_MERCHANT_HOUR));

    const res = await provision(env, MERCHANT, ("0x" + "cd".repeat(32)) as `0x${string}`);
    expect(res.status).toBe(429);

    // A DIFFERENT merchant is unaffected — the bucket is per-merchant.
    const other = await provision(
      env,
      OTHER_MERCHANT,
      ("0x" + "ef".repeat(32)) as `0x${string}`
    );
    expect(other.status).toBe(200);
  });

  it("does not consume the rate limit on an idempotent retry", async () => {
    // A retry after a dropped response returns the existing record BEFORE the
    // counter is touched. Otherwise a merchant retrying a flaky request would
    // burn their own allowance for work that was already done.
    const first = await provision(env, MERCHANT);
    expect(first.status).toBe(200);

    const hour = Math.floor(Date.now() / 3_600_000);
    const key = `rl:provision:${MERCHANT.address.toLowerCase()}:${hour}`;
    const afterFirst = await env.KV.get(key);

    const retry = await provision(env, MERCHANT);
    expect(((await retry.json()) as any).existing).toBe(true);
    expect(await env.KV.get(key)).toBe(afterFirst);
  });
});
