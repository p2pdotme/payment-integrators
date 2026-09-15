import { describe, it, expect, beforeEach, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import {
  handleRegisterMerchantWebhook,
  merchantRegistrationMessage,
  webhookUrlFor,
} from "../src/webhooks";
import type { Env } from "../src/config";

/**
 * Merchant-level webhooks, and which URL wins.
 *
 * WHY THIS EXISTS
 * Registration was per LINK. A merchant with five hundred links made five
 * hundred signed calls, and any link they forgot delivered nothing — silently,
 * which is the worst way for a notification system to fail. For the common case
 * ("tell my backend whenever I am paid") the link is the wrong unit.
 *
 * The per-link route stays and still wins, so a merchant routing one link
 * somewhere else does not lose the default for everything else.
 */

if (!(globalThis as any).crypto) (globalThis as any).crypto = webcrypto;

const MERCHANT = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
);
const STRANGER = privateKeyToAccount(
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"
);

const INTEGRATOR = "0x1111111111111111111111111111111111111111";
const CHAIN_ID = 8453;
const URL_OK = "https://merchant.example/hooks/p2p";
const LINK = "0x" + "ab".repeat(32);

let registered = new Set<string>();
/** Signature verification the mock reports. Real ECDSA by default. */
let verifyResult: boolean | null = null;

vi.mock("../src/chain", () => ({
  publicClientFor: () => ({
    chain: { id: CHAIN_ID },
    readContract: async ({ args }: any) => {
      const who = String(args[0]).toLowerCase();
      return ["0x", "shop", "0x", registered.has(who), false];
    },
    // Real verification unless a test overrides it — the ERC-1271 path cannot
    // be exercised without a contract, so `verifyResult` stands in for "the
    // account said yes", which is what a smart-account merchant produces.
    verifyMessage: async ({ address, message, signature }: any) => {
      if (verifyResult !== null) return verifyResult;
      const { verifyMessage } = await import("viem");
      return verifyMessage({ address, message, signature });
    },
  }),
}));

function fakeEnv(): { env: Env; store: Map<string, string> } {
  registered = new Set([MERCHANT.address.toLowerCase()]);
  verifyResult = null;

  const store = new Map<string, string>();
  const env = {
    CHAIN_ID: String(CHAIN_ID),
    INTEGRATOR_ADDRESS: INTEGRATOR,
    KV: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
      list: async () => ({ keys: [], list_complete: true }),
    } as unknown as KVNamespace,
  } as unknown as Env;
  return { env, store };
}

let nonceSeq = 0;

async function register(
  env: Env,
  who = MERCHANT,
  over: { url?: string; merchant?: string; nonce?: string } = {}
) {
  const url = over.url ?? URL_OK;
  const merchant = over.merchant ?? who.address;
  const nonce = over.nonce ?? `n-${nonceSeq++}`;
  const signature = await who.signMessage({
    message: merchantRegistrationMessage(merchant, url, nonce, CHAIN_ID, INTEGRATOR),
  });

  return handleRegisterMerchantWebhook(
    new Request("https://w/api/merchants/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.5" },
      body: JSON.stringify({ merchant, url, nonce, signature }),
    }),
    env
  );
}

describe("one webhook for every link a merchant owns", () => {
  let env: Env;
  let store: Map<string, string>;

  beforeEach(() => {
    ({ env, store } = fakeEnv());
  });

  it("registers a default for all of them", async () => {
    const res = await register(env);
    expect(res.status).toBe(200);
    expect(store.get(`hook:merchant:${MERCHANT.address.toLowerCase()}`)).toBe(URL_OK);
  });

  it("is used for a link with no URL of its own", async () => {
    await register(env);
    expect(await webhookUrlFor(env, LINK, MERCHANT.address)).toBe(URL_OK);
  });

  it("but the LINK's own URL wins where both are set", async () => {
    // A merchant routing one link through a different system must not lose the
    // default for everything else.
    await register(env);
    const perLink = "https://merchant.example/special";
    await env.KV.put(`hook:${LINK}`, perLink);
    expect(await webhookUrlFor(env, LINK, MERCHANT.address)).toBe(perLink);
  });

  it("returns null when neither is set, rather than guessing", async () => {
    expect(await webhookUrlFor(env, LINK, MERCHANT.address)).toBeNull();
  });

  // ─── Who may register ─────────────────────────────────────────────

  it("refuses a signature that is not the merchant's", async () => {
    const res = await register(env, STRANGER, { merchant: MERCHANT.address });
    expect(res.status).toBe(403);
    expect(store.get(`hook:merchant:${MERCHANT.address.toLowerCase()}`)).toBeUndefined();
  });

  it("refuses an address that is not a registered merchant", async () => {
    // Anyone can name any address; without this the endpoint is a free KV write
    // against an arbitrary key.
    const res = await register(env, STRANGER);
    expect(res.status).toBe(404);
  });

  it("accepts a smart account's ERC-1271 answer", async () => {
    // The merchant is a contract in production. Recovering the signature to an
    // EOA and comparing — which is what the per-link route used to do — refuses
    // every real merchant.
    verifyResult = true;
    const res = await register(env, STRANGER, { merchant: MERCHANT.address });
    expect(res.status).toBe(200);
  });

  // ─── The usual guards ─────────────────────────────────────────────

  it("refuses a replayed nonce", async () => {
    expect((await register(env, MERCHANT, { nonce: "same" })).status).toBe(200);
    expect((await register(env, MERCHANT, { nonce: "same" })).status).toBe(409);
  });

  it("refuses http, and a URL pointing back at us", async () => {
    expect((await register(env, MERCHANT, { url: "http://merchant.example/h" })).status).toBe(400);
    expect((await register(env, MERCHANT, { url: "https://w/loop" })).status).toBe(400);
  });

  it("refuses a malformed merchant or signature", async () => {
    expect((await register(env, MERCHANT, { merchant: "0x1234" })).status).toBe(400);
    const res = await handleRegisterMerchantWebhook(
      new Request("https://w/api/merchants/webhook", {
        method: "POST",
        body: JSON.stringify({
          merchant: MERCHANT.address,
          url: URL_OK,
          nonce: "n",
          signature: "0x00",
        }),
      }),
      env
    );
    expect(res.status).toBe(400);
  });

  it("binds the signature to chain and integrator", async () => {
    // A signature captured on testnet must not work against mainnet.
    const a = merchantRegistrationMessage(MERCHANT.address, URL_OK, "n", 8453, INTEGRATOR);
    const b = merchantRegistrationMessage(MERCHANT.address, URL_OK, "n", 1, INTEGRATOR);
    const c = merchantRegistrationMessage(
      MERCHANT.address,
      URL_OK,
      "n",
      8453,
      "0x9999999999999999999999999999999999999999"
    );
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});
