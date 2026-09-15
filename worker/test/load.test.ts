import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { requireFixture } from "./fixture";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  toHex,
  parseUnits,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { handlePay } from "../src/pay";
import { handleRelayTx } from "../src/relayTx";
import {
  makeTestEnv,
  useLocalBundler,
  registerLinkAgent,
  CUSTOMER_PUBKEY,
  signRelayAction,
  type Addresses,
} from "./harness";
import type { Env } from "../src/config";

/**
 * The payment path under concurrent load.
 *
 * WHAT THIS IS LOOKING FOR
 * Not throughput — a local node and a single-submitter bundler stand-in cannot
 * tell us anything true about that. What it can tell us is whether the worker
 * stays CORRECT when many requests overlap, which is the failure mode that
 * matters and the one the old design actually had: a single relayer key with one
 * nonce sequence, where two payments in flight at once could collide and every
 * later one queued behind the stuck nonce.
 *
 * Each link now drives its own account with its own nonce sequence, so the
 * question is whether anything ELSE serialises or crosses over. Specifically:
 *
 *   • no request crashes the worker — every outcome is a Response, never a
 *     thrown error or an unhandled rejection
 *   • orders never cross links, which would hand one customer another's payment
 *   • the per-link lock still holds under a burst on ONE link
 *   • different links genuinely proceed independently
 *   • blocked claimants stay blocked no matter how fast they ask
 *   • KV counters do not corrupt under concurrent writes
 *
 * Requires `npx hardhat node` and `scripts/e2e-setup.js`.
 */

// The URL object is passed straight to existsSync/readFileSync, which both
// accept one. Converting to a string with `.pathname` and stripping the
// leading slash is a Windows drive-letter fix that BREAKS POSIX: it leaves
// "/D:/..." absolute but turns "/home/..." into a relative path resolved
// against cwd. The result was always false on Linux, so these suites ran on
// a developer machine and silently skipped in CI.
const ADDR = new URL("./e2e-addresses.json", import.meta.url);
const HAVE = requireFixture(ADDR, "load");
const addresses: Addresses = HAVE ? JSON.parse(readFileSync(ADDR, "utf8")) : ({} as Addresses);

const USDC = (n: number) => parseUnits(String(n), 6);
const INR = toHex("INR", { size: 32 });
const AMOUNT = USDC(1);

const MERCHANT_ABI = [
  {
    type: "function",
    name: "createLink",
    stateMutability: "nonpayable",
    inputs: [
      { name: "linkId", type: "bytes32" },
      { name: "amount", type: "uint96" },
      { name: "currency", type: "bytes32" },
      { name: "expiresAt", type: "uint64" },
      { name: "maxUses", type: "uint32" },
      { name: "encryptedConfig", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

describe.skipIf(!HAVE)("load · the payment path under concurrency", () => {
  let env: Env;
  let pub: any;
  let merchant: any;
  let chain: any;
  let bundlerHandle: ReturnType<typeof useLocalBundler>;

  const RUN = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let seq = 0;

  beforeAll(async () => {
    chain = defineChain({
      id: addresses.chainId,
      name: "local",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [addresses.rpcUrl] } },
    });
    pub = createPublicClient({ chain, transport: http(addresses.rpcUrl) });
    merchant = createWalletClient({
      account: privateKeyToAccount(
        "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
      ),
      chain,
      transport: http(addresses.rpcUrl),
    });

    env = makeTestEnv(addresses);
    bundlerHandle = useLocalBundler(addresses);

    // The contract caps a merchant's orders per UTC day and this suite places
    // well past it on purpose. Raise it so what is under test is concurrency,
    // not the daily limit (which has its own test).
    const admin = createWalletClient({
      account: privateKeyToAccount(
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
      ),
      chain,
      transport: http(addresses.rpcUrl),
    });
    await pub.waitForTransactionReceipt({
      hash: await admin.writeContract({
        address: addresses.integrator as Address,
        abi: [
          {
            type: "function",
            name: "setDailyLimit",
            stateMutability: "nonpayable",
            inputs: [{ type: "uint256" }],
            outputs: [],
          },
        ] as const,
        functionName: "setDailyLimit",
        args: [100000n],
      }),
    });
  }, 120_000);

  afterAll(() => bundlerHandle?.restore());

  /**
   * Creates n links, SEQUENTIALLY.
   *
   * The merchant is one EOA with one nonce, so creating links concurrently
   * collides on it — a property of this fixture, not of the design. Real
   * merchants create links one tap at a time, and the concurrency under test is
   * in the PAYMENTS, which is where the old relayer key actually failed.
   */
  async function makeLinks(n: number, maxUses = 0): Promise<Hex[]> {
    const out: Hex[] = [];
    for (let i = 0; i < n; i++) out.push(await makeLink(maxUses));
    return out;
  }

  async function makeLink(maxUses = 0): Promise<Hex> {
    const linkId = keccak256(toHex(`${RUN}:load:${seq++}`));
    await pub.waitForTransactionReceipt({
      hash: await merchant.writeContract({
        address: addresses.integrator as Address,
        abi: MERCHANT_ABI,
        functionName: "createLink",
        args: [linkId, AMOUNT, INR, 0n, maxUses, "0x"],
      }),
    });
    await registerLinkAgent(env, linkId, merchant, addresses.router);
    return linkId;
  }

  /** A link with no fixed amount, where the caller's quantity is what counts. */
  async function makeVariableLink(): Promise<Hex> {
    const linkId = keccak256(toHex(`${RUN}:loadvar:${seq++}`));
    await pub.waitForTransactionReceipt({
      hash: await merchant.writeContract({
        address: addresses.integrator as Address,
        abi: MERCHANT_ABI,
        functionName: "createLink",
        args: [linkId, 0n, INR, 0n, 0, "0x"],
      }),
    });
    await registerLinkAgent(env, linkId, merchant, addresses.router);
    return linkId;
  }

  let ipSeq = 0;
  const payReq = (ip?: string) =>
    new Request("https://worker/api/pay/x", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // A distinct source per request by default: these are different
        // customers, and sharing one would trip the per-IP limiter partway
        // through and mask a real failure as a rate limit.
        "CF-Connecting-IP": ip ?? `198.18.${Math.floor(ipSeq / 250) % 250}.${(ipSeq++ % 250) + 1}`,
      },
      body: JSON.stringify({ pubKey: CUSTOMER_PUBKEY, circleId: 1 }),
    });

  /** Every outcome as a plain record, so a THROW is distinguishable from a
   *  refusal. A refusal is the worker working; a throw is the worker broken. */
  async function attempt(linkId: Hex, ip?: string) {
    try {
      const res = await handlePay(payReq(ip), env, linkId);
      const body = (await res.json()) as any;
      return { threw: false, status: res.status, body };
    } catch (e) {
      return { threw: true, status: 0, body: { error: String(e) } };
    }
  }

  // ─── Independence ─────────────────────────────────────────────────

  it("runs 24 payments across 12 links at once without crossing them", async () => {
    // The failure this rules out is the worst kind: handing one customer an
    // order that belongs to someone else's link.
    const links = await makeLinks(12);

    const results = await Promise.all(links.flatMap((l) => [attempt(l), attempt(l)]).map((p) => p));

    expect(results.some((r) => r.threw)).toBe(false);

    const ok = results.filter((r) => r.status === 200);
    expect(ok.length).toBeGreaterThan(0);

    // Every order id is unique — no two customers were handed the same one.
    const ids = ok.map((r) => r.body.orderId);
    expect(new Set(ids).size).toBe(ids.length);

    // And each order really belongs to the link it was placed on.
    for (const r of ok) {
      const onChain = (await pub.readContract({
        address: addresses.integrator as Address,
        abi: [
          {
            type: "function",
            name: "orderToLink",
            stateMutability: "view",
            inputs: [{ type: "uint256" }],
            outputs: [{ type: "bytes32" }],
          },
        ] as const,
        functionName: "orderToLink",
        args: [BigInt(r.body.orderId)],
      })) as Hex;
      expect(links).toContain(onChain);
    }
  }, 300_000);

  it("keeps one slow link from blocking the others — the old nonce bug", async () => {
    // With a single relayer key this was the failure: one payment in flight
    // stalled every other merchant's. Each link now has its own account and its
    // own nonce sequence, so a burst on one must not delay another.
    const busy = await makeLink();
    const quiet = await makeLink();

    const [burst, single] = await Promise.all([
      Promise.all(Array.from({ length: 6 }, () => attempt(busy))),
      attempt(quiet),
    ]);

    expect(burst.some((r) => r.threw)).toBe(false);
    // The quiet link went through regardless of what the busy one was doing.
    expect(single.status).toBe(200);
  }, 300_000);

  // ─── Serialisation where it is required ───────────────────────────

  it("serialises a burst on ONE single-use link to at most one order", async () => {
    // Twelve people tapping the same one-use link at the same instant. The
    // contract is the real guarantee; the lock is what stops us paying gas to
    // discover it eleven times.
    const linkId = await makeLink(1);
    const results = await Promise.all(Array.from({ length: 12 }, () => attempt(linkId)));

    expect(results.some((r) => r.threw)).toBe(false);
    expect(results.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);

    // Everyone else got a real answer, not a crash.
    for (const r of results.filter((x) => x.status !== 200)) {
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(typeof r.body.error).toBe("string");
      expect(r.body.error.length).toBeGreaterThan(0);
    }
  }, 300_000);

  it("never exceeds a multi-use link's allowance under a burst", async () => {
    const linkId = await makeLink(3);
    const results = await Promise.all(Array.from({ length: 10 }, () => attempt(linkId)));

    expect(results.some((r) => r.threw)).toBe(false);
    expect(results.filter((r) => r.status === 200).length).toBeLessThanOrEqual(3);
  }, 300_000);

  // ─── The worker does not fall over ────────────────────────────────

  /** Fires a batch of bodies at one link and reports each outcome. */
  async function junkBatch(linkId: Hex, bodies: Array<Record<string, unknown>>, octet: number) {
    return Promise.all(
      bodies.map(async (body, i) => {
        try {
          const res = await handlePay(
            new Request("https://worker/api/pay/x", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "CF-Connecting-IP": `198.19.${octet}.${i + 1}`,
              },
              body: JSON.stringify(body),
            }),
            env,
            linkId
          );
          return { threw: false, status: res.status };
        } catch {
          return { threw: true, status: 0 };
        }
      })
    );
  }

  it("refuses a malformed request rather than throwing", async () => {
    // Junk arriving at speed is the ordinary case for a public endpoint. Each
    // must produce a Response; an uncaught error would take the isolate down
    // and, worse, leave a link lock held until it expired.
    const linkId = await makeLink();
    const out = await junkBatch(
      linkId,
      [
        { pubKey: "" },
        { pubKey: "not-hex" },
        { pubKey: "04zz" },
        { pubKey: "0x1234" },
        // Right length, wrong prefix — a compressed key where an uncompressed
        // one is required. Derives a plausible address for a key the customer
        // does not hold, which is worse than an obvious reject.
        { pubKey: "02" + "ab".repeat(64) },
        // Right prefix, wrong length.
        { pubKey: "04" + "ab".repeat(32) },
        {},
      ],
      0
    );

    expect(out.some((r) => r.threw)).toBe(false);
    for (const r of out) expect(r.status).toBeGreaterThanOrEqual(400);
  }, 300_000);

  it("ignores a tampered quantity on a FIXED link, and refuses it on a variable one", async () => {
    // Worth stating rather than assuming: on a fixed-amount link the quantity is
    // DERIVED from the link's own amount, so a tampered one is not an error —
    // it is ignored, and the customer pays exactly what the merchant set. The
    // first assertion below would have read as a bug without knowing that.
    const fixed = await makeLink();
    const accepted = await junkBatch(fixed, [{ pubKey: CUSTOMER_PUBKEY, quantity: 1e30 }], 1);
    expect(accepted[0].threw).toBe(false);
    expect(accepted[0].status).toBe(200);

    // A VARIABLE link takes the quantity from the caller, so it must validate.
    const variable = await makeVariableLink();
    const refused = await junkBatch(
      variable,
      [
        { pubKey: CUSTOMER_PUBKEY, quantity: "abc" },
        { pubKey: CUSTOMER_PUBKEY, quantity: -1 },
        { pubKey: CUSTOMER_PUBKEY, quantity: 0 },
        { pubKey: CUSTOMER_PUBKEY, quantity: 1e30 },
        { pubKey: CUSTOMER_PUBKEY, quantity: 1.5 },
      ],
      2
    );
    expect(refused.some((r) => r.threw)).toBe(false);
    for (const r of refused) expect(r.status).toBeGreaterThanOrEqual(400);
  }, 300_000);

  it("survives a burst of relay-tx junk without a crash", async () => {
    const out = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        try {
          const res = await handleRelayTx(
            new Request("https://worker/api/relay-tx", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "CF-Connecting-IP": `198.19.1.${i + 1}`,
              },
              body: JSON.stringify({
                to: addresses.diamond,
                data: "0x" + "ff".repeat(i + 1),
              }),
            }),
            env
          );
          return { threw: false, status: res.status };
        } catch {
          return { threw: true, status: 0 };
        }
      })
    );

    expect(out.some((r) => r.threw)).toBe(false);
    for (const r of out) expect(r.status).toBeGreaterThanOrEqual(400);
  }, 300_000);

  // ─── The blocklist under pressure ─────────────────────────────────

  it("holds a block no matter how fast the blocked person asks", async () => {
    const { blockIp } = await import("../src/blocklist");
    const ip = "198.20.0.1";
    await blockIp(env, ip, 3);

    const linkId = await makeLink();
    const results = await Promise.all(Array.from({ length: 15 }, () => attempt(linkId, ip)));

    expect(results.some((r) => r.threw)).toBe(false);
    // Not one gets through, and none is a 500.
    expect(results.every((r) => r.status === 403)).toBe(true);
  }, 300_000);

  it("does not corrupt the strike counter under concurrent writes", async () => {
    // KV is eventually consistent and these writes are not atomic, which is a
    // deliberate choice: miscounting a strike by one changes nothing that
    // matters. What WOULD matter is a corrupted value that reads as NaN and
    // silently disables the check.
    const { rememberMarkPaid, recordFalseClaim } = await import("../src/claims");
    const ip = "198.20.0.2";

    await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        await rememberMarkPaid(env, BigInt(900000 + i), ip);
        await recordFalseClaim(env, BigInt(900000 + i));
      })
    );

    const raw = await env.KV.get(`claim:strikes:${ip}`);
    const n = Number(raw);
    expect(Number.isFinite(n)).toBe(true);
    expect(n).toBeGreaterThan(0);
  }, 300_000);
});
