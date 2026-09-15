import { describe, it, expect, beforeEach, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { blockIp, unblockIp, blockRecord, listBlocked } from "../src/blocklist";
import {
  blockedForFalseClaims,
  falseClaimWarning,
  rememberMarkPaid,
  recordFalseClaim,
  MAX_FALSE_CLAIMS,
} from "../src/claims";
import { handleAdmin } from "../src/admin";
import type { Env } from "../src/config";

/**
 * Blocking a repeat false claimant, and who may undo it.
 *
 * The block itself is a trade, not a guarantee. An IP is not a person: it
 * OVER-blocks, because mobile carriers put very many subscribers behind one
 * address, and it UNDER-blocks, because changing networks defeats it in
 * seconds. It buys friction against casual abuse and nothing against a
 * determined attacker.
 *
 * That trade is only acceptable because an operator can see the blocks and lift
 * them — so the review path is tested at least as carefully as the block path,
 * including who is allowed to walk it.
 *
 * Authority comes from the CONTRACT, not from a shared secret: the super-admin
 * and every owner read as FINANCE, an admin assigned on-chain gains access, and
 * one removed loses it. The chain read is stubbed here; the role semantics it
 * models are the integrator's own `roleOf`.
 */

// Hardhat account keys — public by design, and the addresses are what matter.
const OWNER = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
);
const SUPPORT_ADMIN = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
);
const VIEWER = privateKeyToAccount(
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
);
const STRANGER = privateKeyToAccount(
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"
);

const INTEGRATOR = "0x1111111111111111111111111111111111111111";
const CHAIN_ID = 8453;

/** What the contract would answer for `roleOf`. 4 FINANCE, 2 SUPPORT, 1 VIEWER. */
const roles = new Map<string, number>();
let roleReadFails = false;

// Stubs the ONE chain read  makes. The signature verification and
// the tier comparison are real.
vi.mock("../src/chain", () => ({
  publicClientFor: () => ({
    readContract: async ({ args }: any) => {
      if (roleReadFails) throw new Error("rpc down");
      return roles.get(String(args[0]).toLowerCase()) ?? 0;
    },
  }),
}));

const IP = "203.0.113.7";
const OTHER = "203.0.113.9";

let nonceSeq = 0;
const nowSec = () => Math.floor(Date.now() / 1000);

/** Signs an operator request the way the admin panel would. */
async function signAdmin(
  env: Env,
  who: ReturnType<typeof privateKeyToAccount>,
  msg: { action: string; ip?: string; reason?: string },
  over: { expiry?: number; integrator?: string; nonce?: string } = {}
) {
  const expiry = over.expiry ?? nowSec() + 120;
  const ip = msg.ip ?? "";
  // Unique per request unless a test pins it, which is how the replay case
  // below is exercised.
  const nonce = over.nonce ?? `n-${nonceSeq++}-${Math.random().toString(36).slice(2)}`;
  const signature = await who.signTypedData({
    domain: {
      name: "P2P Merchant Terminal Admin",
      version: "1",
      chainId: CHAIN_ID,
      verifyingContract: (over.integrator ?? INTEGRATOR) as `0x${string}`,
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
    message: { action: msg.action, ip, expiry: BigInt(expiry), nonce },
  });
  return { ...msg, signer: who.address, signature, expiry, nonce };
}

/** Signs and sends one operator request. */
async function admin(
  env: Env,
  who: ReturnType<typeof privateKeyToAccount>,
  msg: { action: string; ip?: string; reason?: string },
  over: { expiry?: number; integrator?: string; nonce?: string } = {}
) {
  const body = await signAdmin(env, who, msg, over);
  return handleAdmin(
    new Request("https://w/api/admin/blocks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env
  );
}

function fakeEnv(over: Partial<Env> = {}): { env: Env; store: Map<string, string> } {
  roles.clear();
  roles.set(OWNER.address.toLowerCase(), 4); // super-admin / owner
  roles.set(SUPPORT_ADMIN.address.toLowerCase(), 2);
  roles.set(VIEWER.address.toLowerCase(), 1);

  const store = new Map<string, string>();
  const env = {
    CHAIN_ID: String(CHAIN_ID),
    INTEGRATOR_ADDRESS: INTEGRATOR,
    KV: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
      list: async ({ prefix = "", limit = 1000 } = {}) => ({
        keys: [...store.keys()]
          .filter((k) => k.startsWith(prefix))
          .slice(0, limit)
          .map((name) => ({ name })),
      }),
    } as unknown as KVNamespace,
    ...over,
  } as Env;
  return { env, store };
}
describe("earning a block", () => {
  let env: Env;

  beforeEach(() => {
    ({ env } = fakeEnv());
  });

  const falseClaim = async (orderId: bigint, ip = IP) => {
    await rememberMarkPaid(env, orderId, ip);
    await recordFalseClaim(env, orderId);
  };

  it("lets an honest customer through untouched", async () => {
    expect(await blockedForFalseClaims(env, IP)).toBeNull();
    expect(await falseClaimWarning(env, IP)).toBeNull();
  });

  it("warns but does not block before the limit", async () => {
    // A failed bank transfer is far more likely than fraud, so the early
    // strikes tell the person plainly rather than counting down in silence.
    for (let i = 1; i < MAX_FALSE_CLAIMS; i++) {
      await falseClaim(BigInt(i));
      expect(await blockedForFalseClaims(env, IP)).toBeNull();
      expect(await falseClaimWarning(env, IP)).toContain("more time");
    }
  });

  it("blocks on the third false claim", async () => {
    for (let i = 1; i <= MAX_FALSE_CLAIMS; i++) await falseClaim(BigInt(i));
    expect(await blockedForFalseClaims(env, IP)).toBeTruthy();
    expect(await blockRecord(env, IP)).not.toBeNull();
    expect((await blockRecord(env, IP))!.strikes).toBe(MAX_FALSE_CLAIMS);
  });

  it("survives the strike counter expiring — waiting does not clear it", async () => {
    // The counter forgets after a day. A day is a cheap wait for someone whose
    // attempts cost them nothing, so the durable record is what actually holds.
    const { env: e, store } = fakeEnv();
    for (let i = 1; i <= MAX_FALSE_CLAIMS; i++) {
      await rememberMarkPaid(e, BigInt(i), IP);
      await recordFalseClaim(e, BigInt(i));
    }
    store.delete(`claim:strikes:${IP}`); // as TTL expiry would
    expect(await blockedForFalseClaims(e, IP)).toBeTruthy();
  });

  it("does not touch anyone else", async () => {
    for (let i = 1; i <= MAX_FALSE_CLAIMS; i++) await falseClaim(BigInt(i));
    expect(await blockedForFalseClaims(env, OTHER)).toBeNull();
  });

  it("is keyed on the address, so a fresh profile changes nothing", async () => {
    // The whole point of blocking here rather than on an account: there is no
    // account, and a new one is free to create.
    for (let i = 1; i <= MAX_FALSE_CLAIMS; i++) await falseClaim(BigInt(i));
    expect(await blockedForFalseClaims(env, IP)).toBeTruthy();
  });

  it("says nothing an abuser can tune against", async () => {
    for (let i = 1; i <= MAX_FALSE_CLAIMS; i++) await falseClaim(BigInt(i));
    const msg = (await blockedForFalseClaims(env, IP))!;
    // No strike count, no duration, no "blocked" — telling them what tripped it
    // tells them what to avoid. It points at a human instead.
    expect(msg).not.toMatch(/block|strike|\d+ (day|hour)/i);
    expect(msg).toContain("merchant");
  });
});

describe("lifting a block", () => {
  let env: Env;

  beforeEach(async () => {
    ({ env } = fakeEnv());
    await blockIp(env, IP, 3);
  });

  it("unblocks, and clears the strikes with it", async () => {
    // Leaving the count would put a wrongly-blocked person one claim from being
    // blocked again — not what an operator means by "unblock".
    await env.KV.put(`claim:strikes:${IP}`, "3");
    const res = await admin(env, OWNER, { action: "unblock", ip: IP });

    expect(res.status).toBe(200);
    expect(await blockedForFalseClaims(env, IP)).toBeNull();
    expect(await env.KV.get(`claim:strikes:${IP}`)).toBeNull();
  });

  it("records WHICH wallet acted", async () => {
    // The reason a shared secret was not good enough: "someone with the
    // password did this" is not an answer when the action is overriding a
    // fraud decision.
    const body = (await (await admin(env, OWNER, { action: "unblock", ip: IP })).json()) as any;
    expect(body.by).toBe(OWNER.address);
  });

  it("lists blocks so over-blocking is visible", async () => {
    await blockIp(env, OTHER, 5, "manual");
    const body = (await (await admin(env, OWNER, { action: "list" })).json()) as any;
    const ips = body.blocks.map((b: any) => b.ip);
    expect(ips).toContain(IP);
    expect(ips).toContain(OTHER);
  });

  it("lets an operator block by hand", async () => {
    const res = await admin(env, OWNER, {
      action: "block",
      ip: OTHER,
      reason: "confirmed abuse",
    });
    expect(res.status).toBe(200);
    expect((await blockRecord(env, OTHER))!.reason).toBe("confirmed abuse");
  });

  it("reports honestly when there was nothing to unblock", async () => {
    const body = (await (await admin(env, OWNER, { action: "unblock", ip: OTHER })).json()) as any;
    expect(body.unblocked).toBe(false);
  });

  it("rejects anything that is not an address", async () => {
    for (const bad of ["", "not-an-ip", "1.2.3", "'; DROP", "a".repeat(200)]) {
      expect((await admin(env, OWNER, { action: "unblock", ip: bad })).status).toBe(400);
    }
  });
});

describe("reviewing a complaint about one person", () => {
  let env: Env;

  beforeEach(() => {
    ({ env } = fakeEnv());
  });

  const lookup = (who = OWNER) => admin(env, who, { action: "lookup", ip: IP });

  it("answers for one address, with when and how many", async () => {
    await blockIp(env, IP, 3);
    const body = (await (await lookup()).json()) as any;

    expect(body.blocked).toBe(true);
    expect(body.record.strikes).toBe(3);
    expect(body.record.at).toBeGreaterThan(0);
  });

  it("says plainly when someone is NOT blocked", async () => {
    const body = (await (await lookup()).json()) as any;
    expect(body.blocked).toBe(false);
    expect(body.record).toBeNull();
    expect(body.strikes).toBe(0);
  });

  it("shows strikes even before a block, so a near-miss is visible", async () => {
    await rememberMarkPaid(env, 1n, IP);
    await recordFalseClaim(env, 1n);

    const body = (await (await lookup()).json()) as any;
    expect(body.blocked).toBe(false);
    expect(body.strikes).toBe(1);
  });

  it("supports the whole flow: blocked, reviewed, lifted, paying again", async () => {
    // Exactly the sequence a support ticket follows.
    for (let i = 1; i <= MAX_FALSE_CLAIMS; i++) {
      await rememberMarkPaid(env, BigInt(i), IP);
      await recordFalseClaim(env, BigInt(i));
    }
    expect(await blockedForFalseClaims(env, IP)).toBeTruthy();

    const review = (await (await lookup()).json()) as any;
    expect(review.blocked).toBe(true);
    expect(review.record.strikes).toBe(MAX_FALSE_CLAIMS);

    await admin(env, OWNER, { action: "unblock", ip: IP });

    expect(await blockedForFalseClaims(env, IP)).toBeNull();
    expect(((await (await lookup()).json()) as any).strikes).toBe(0);
  });
});

describe("who the contract says may do this", () => {
  let env: Env;

  beforeEach(async () => {
    ({ env } = fakeEnv());
    await blockIp(env, IP, 3);
  });

  const unblock = (who: ReturnType<typeof privateKeyToAccount>) =>
    admin(env, who, { action: "unblock", ip: IP });

  it("admits the super-admin, who reads as FINANCE", async () => {
    // The super-admin is always also an owner, so `roleOf` reports 4. They get
    // this access without anyone granting it separately — which is the point.
    expect((await unblock(OWNER)).status).toBe(200);
  });

  it("admits an admin the super-admin assigned", async () => {
    // Authority here FOLLOWS authority on the contract: assign SUPPORT on-chain
    // and they can review blocks, with nothing to configure here.
    expect((await unblock(SUPPORT_ADMIN)).status).toBe(200);
  });

  it("refuses a wallet with no role", async () => {
    expect((await unblock(STRANGER)).status).toBe(404);
    expect(await blockRecord(env, IP)).not.toBeNull();
  });

  it("refuses VIEWER — reading the contract is not acting on it", async () => {
    expect((await unblock(VIEWER)).status).toBe(404);
    expect(await blockRecord(env, IP)).not.toBeNull();
  });

  it("refuses a wallet removed from the role since it last acted", async () => {
    // Revocation is the whole advantage over a shared secret: taking the role
    // away on-chain takes this away too, with nothing to rotate.
    expect((await unblock(SUPPORT_ADMIN)).status).toBe(200);
    await blockIp(env, IP, 3);
    roles.set(SUPPORT_ADMIN.address.toLowerCase(), 0);
    expect((await unblock(SUPPORT_ADMIN)).status).toBe(404);
  });
});

describe("the signature itself", () => {
  let env: Env;

  beforeEach(async () => {
    ({ env } = fakeEnv());
    await blockIp(env, IP, 3);
  });

  it("refuses an expired one", async () => {
    const res = await admin(env, OWNER, { action: "unblock", ip: IP }, { expiry: nowSec() - 1 });
    expect(res.status).toBe(404);
    expect(await blockRecord(env, IP)).not.toBeNull();
  });

  it("refuses one valid for absurdly long", async () => {
    // A signature good for a year is a bearer token wearing a timestamp.
    const res = await admin(
      env,
      OWNER,
      { action: "unblock", ip: IP },
      { expiry: nowSec() + 31_536_000 }
    );
    expect(res.status).toBe(404);
  });

  it("cannot be replayed against a DIFFERENT address", async () => {
    // The signature covers the ip. Capturing an unblock for one address must
    // not become an unblock for any address.
    await blockIp(env, OTHER, 3);
    const signed = await signAdmin(env, OWNER, { action: "unblock", ip: IP });

    const res = await handleAdmin(
      new Request("https://w/api/admin/blocks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...signed, ip: OTHER }),
      }),
      env
    );
    expect(res.status).toBe(404);
    expect(await blockRecord(env, OTHER)).not.toBeNull();
  });

  it("cannot be replayed as a DIFFERENT action", async () => {
    const signed = await signAdmin(env, OWNER, { action: "lookup", ip: IP });
    const res = await handleAdmin(
      new Request("https://w/api/admin/blocks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...signed, action: "unblock" }),
      }),
      env
    );
    expect(res.status).toBe(404);
    expect(await blockRecord(env, IP)).not.toBeNull();
  });

  it("cannot be replayed against a different integrator", async () => {
    // The domain binds the verifying contract, so a signature from a testnet
    // deployment is not a signature here.
    const signed = await signAdmin(
      env,
      OWNER,
      { action: "unblock", ip: IP },
      {
        integrator: "0x9999999999999999999999999999999999999999",
      }
    );
    const res = await handleAdmin(
      new Request("https://w/api/admin/blocks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signed),
      }),
      env
    );
    expect(res.status).toBe(404);
  });

  it("refuses a REPLAYED signature, even inside the window", async () => {
    // What the expiry alone left open: within 300s a captured signature could
    // be replayed for the same (action, ip). Harmless for an unblock, less so
    // for a block.
    const signed = await signAdmin(env, OWNER, { action: "unblock", ip: IP });
    const send = () =>
      handleAdmin(
        new Request("https://w/api/admin/blocks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(signed),
        }),
        env
      );

    expect((await send()).status).toBe(200);
    await blockIp(env, IP, 3);
    // Same bytes, second time: refused.
    expect((await send()).status).toBe(404);
    expect(await blockRecord(env, IP)).not.toBeNull();
  });

  it("does not burn a nonce on a request that was refused anyway", async () => {
    // Otherwise a stranger could exhaust an operator's nonces by guessing.
    const n = "fixed-nonce-for-this-test";
    expect((await admin(env, STRANGER, { action: "unblock", ip: IP }, { nonce: n })).status).toBe(
      404
    );
    expect((await admin(env, OWNER, { action: "unblock", ip: IP }, { nonce: n })).status).toBe(200);
  });

  it("refuses a forged signature claiming to be the owner", async () => {
    const signed = await signAdmin(env, STRANGER, { action: "unblock", ip: IP });
    const res = await handleAdmin(
      new Request("https://w/api/admin/blocks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...signed, signer: OWNER.address }),
      }),
      env
    );
    expect(res.status).toBe(404);
  });

  it("answers 404 for every failure, never distinguishing them", async () => {
    // A different status for "bad signature" and "no role" tells a prober which
    // half to work on.
    const cases = [
      admin(env, STRANGER, { action: "unblock", ip: IP }),
      admin(env, OWNER, { action: "unblock", ip: IP }, { expiry: nowSec() - 1 }),
      admin(env, OWNER, { action: "nonsense", ip: IP }),
    ];
    for (const c of cases) expect((await c).status).toBe(404);
  });

  it("refuses when the chain cannot be read, rather than opening", async () => {
    // An unreadable RPC must not become an open door on an endpoint that can
    // lift a fraud block.
    roleReadFails = true;
    try {
      expect((await admin(env, OWNER, { action: "unblock", ip: IP })).status).toBe(404);
    } finally {
      roleReadFails = false;
    }
  });
});
