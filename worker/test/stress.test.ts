import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
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
import {
  makeTestEnv,
  useLocalBundler,
  registerLinkAgent,
  CUSTOMER_PUBKEY,
  type Addresses,
} from "./harness";
import type { Env } from "../src/config";

/**
 * STRESS — the same properties as `load.test.ts`, several times harder.
 *
 * WHY A SEPARATE FILE
 * `load.test.ts` runs 24 payments across 12 links. That is enough to show the
 * old single-nonce bug is gone, but it is a modest number to rest a concurrency
 * claim on: at two payments per link a per-link serialisation fault has very
 * little room to show itself, and a counter that corrupts once in a hundred
 * writes is unlikely to be caught at all.
 *
 * This file pushes the same invariants harder — wider fan-out, deeper bursts,
 * and repeated waves against ONE link so per-link state is written many times
 * over rather than twice. It asserts nothing new. It gives the existing claims
 * more chances to be false.
 *
 * WHAT IT CANNOT TELL YOU
 * Nothing about throughput or latency. The chain is a local node and the bundler
 * is a single-submitter stand-in, so any timing here is an artefact of the
 * fixture. Only the correctness results mean anything.
 *
 * Requires `npx hardhat node` and `scripts/e2e-setup.js`.
 */

const ADDR = new URL("./e2e-addresses.json", import.meta.url);
const HAVE = requireFixture(ADDR, "stress");
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

const ORDER_TO_LINK_ABI = [
  {
    type: "function",
    name: "orderToLink",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "bytes32" }],
  },
] as const;

describe.skipIf(!HAVE)("stress · the payment path, harder", () => {
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

    // Same reason as load.test.ts: the daily cap has its own test, and is not
    // what is under examination here.
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
        args: [1000000n],
      }),
    });
  }, 300_000);

  afterAll(() => bundlerHandle?.restore());

  async function makeLink(maxUses = 0): Promise<Hex> {
    const linkId = keccak256(toHex(RUN + ":stress:" + seq++));
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

  /** Links are created SEQUENTIALLY — one merchant EOA, one nonce. */
  async function makeLinks(n: number, maxUses = 0): Promise<Hex[]> {
    const out: Hex[] = [];
    for (let i = 0; i < n; i++) out.push(await makeLink(maxUses));
    return out;
  }

  let ipSeq = 0;
  const payReq = () =>
    new Request("https://worker/api/pay/x", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // A distinct source per request: these are different customers, and
        // sharing one would trip the per-IP limiter partway through and mask a
        // real failure as a rate limit.
        "CF-Connecting-IP":
          "198.18." + (Math.floor(ipSeq / 250) % 250) + "." + ((ipSeq++ % 250) + 1),
      },
      body: JSON.stringify({ pubKey: CUSTOMER_PUBKEY, circleId: 1 }),
    });

  /** Every outcome as a record, so a THROW stays distinguishable from a refusal. */
  async function attempt(linkId: Hex) {
    try {
      const res = await handlePay(payReq(), env, linkId);
      const body = (await res.json()) as any;
      return { threw: false, status: res.status, body, linkId };
    } catch (e) {
      return { threw: true, status: 0, body: { error: String(e) }, linkId };
    }
  }

  /** Which link an order really belongs to, read back from the chain. */
  async function linkOf(orderId: string | number): Promise<Hex> {
    return (await pub.readContract({
      address: addresses.integrator as Address,
      abi: ORDER_TO_LINK_ABI,
      functionName: "orderToLink",
      args: [BigInt(orderId)],
    })) as Hex;
  }

  // ─── Wide fan-out ─────────────────────────────────────────────────

  it("120 concurrent payments across 40 links — none crosses, none duplicates", async () => {
    // Five times the fan-out of load.test.ts, three payments deep per link, all
    // released at once. The invariant that matters most: an order handed to a
    // customer must belong to the link they actually paid on.
    const links = await makeLinks(40);

    const results = await Promise.all(links.flatMap((l) => [attempt(l), attempt(l), attempt(l)]));

    // Not one request may throw. A refusal is the worker working; a throw is the
    // worker broken, and under load that distinction is the whole point.
    expect(results.filter((r) => r.threw).map((t) => t.body.error)).toEqual([]);

    const ok = results.filter((r) => r.status === 200);

    // EXACTLY ONE PER LINK, and the rest refused with 409.
    //
    // Worth stating precisely rather than asserting `> 0`, because it documents
    // a real property: `pay` takes a per-link lock and a caller that cannot get
    // it is REFUSED immediately, not queued (`pay.ts:116`). So three customers
    // tapping the same link in the same instant produce one order and two
    // "already being processed" answers — even on an unlimited-use link, where
    // all three could legitimately have succeeded a moment apart.
    //
    // For a single-use link that is exactly right. For a busy shop's standing
    // link it is a throughput ceiling of one payment per link per request, and
    // the message the other customers see describes SOMEONE ELSE's payment.
    // Deliberate ("cost control; the contract's LinkAlreadyUsed is the real
    // guarantee"), and out of scope to change here — but pinned down so that if
    // it ever becomes a queue instead, this test says so.
    expect(ok.length).toBe(links.length);
    const refused = results.filter((r) => r.status === 409);
    expect(ok.length + refused.length).toBe(results.length);

    // No order id issued twice.
    const ids = ok.map((r) => r.body.orderId);
    expect(new Set(ids).size).toBe(ids.length);

    // Each order belongs to the link it was placed on — checked per request
    // against THAT request's link, not merely "is one of ours", which would pass
    // even if two links had swapped orders with each other.
    const crossed: string[] = [];
    for (const r of ok) {
      const actual = await linkOf(r.body.orderId);
      if (actual.toLowerCase() !== r.linkId.toLowerCase()) {
        crossed.push("order " + r.body.orderId + " placed on " + r.linkId + " but bound to " + actual);
      }
    }
    expect(crossed).toEqual([]);
  }, 900_000);

  // ─── Deep burst on one link ───────────────────────────────────────

  it("a 50-deep burst on ONE single-use link still yields at most one order", async () => {
    // load.test.ts fires twelve. Fifty gives the per-link lock a far better
    // chance to be caught leaking a second order through.
    const linkId = await makeLink(1);
    const results = await Promise.all(Array.from({ length: 50 }, () => attempt(linkId)));

    expect(results.filter((r) => r.threw)).toEqual([]);
    expect(results.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);

    // And everyone refused got a real message rather than a crash.
    for (const r of results.filter((x) => x.status !== 200)) {
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(typeof r.body.error).toBe("string");
      expect(r.body.error.length).toBeGreaterThan(0);
    }
  }, 900_000);

  it("a 40-deep burst never exceeds a 5-use link's allowance", async () => {
    const linkId = await makeLink(5);
    const results = await Promise.all(Array.from({ length: 40 }, () => attempt(linkId)));

    expect(results.filter((r) => r.threw)).toEqual([]);
    expect(results.filter((r) => r.status === 200).length).toBeLessThanOrEqual(5);
  }, 900_000);

  // ─── Sustained waves ──────────────────────────────────────────────

  it("survives repeated waves against the same link without drifting", async () => {
    // The case a single burst cannot reach: per-link state written over and over
    // again. A counter that corrupts once in a while shows up here and nowhere
    // else in the suite.
    const linkId = await makeLink(6);

    let granted = 0;
    for (let wave = 0; wave < 6; wave++) {
      const results = await Promise.all(Array.from({ length: 12 }, () => attempt(linkId)));
      expect(results.filter((r) => r.threw)).toEqual([]);
      granted += results.filter((r) => r.status === 200).length;
    }

    // 72 attempts against a 6-use link. The contract is the authority, so the
    // allowance must hold however the waves interleaved.
    expect(granted).toBeLessThanOrEqual(6);
  }, 900_000);

  it("mixed traffic: a deep burst on one link does not starve 20 others", async () => {
    // The old single-nonce failure, at scale: one hot link must not queue every
    // other merchant's customers behind it.
    const hot = await makeLink();
    const others = await makeLinks(20);

    const [burst, singles] = await Promise.all([
      Promise.all(Array.from({ length: 30 }, () => attempt(hot))),
      Promise.all(others.map((l) => attempt(l))),
    ]);

    expect(burst.filter((r) => r.threw)).toEqual([]);
    expect(singles.filter((r) => r.threw)).toEqual([]);

    // Every quiet link got through while the hot one was saturated. Listing the
    // failures rather than counting them so a regression names itself.
    const failed = singles.filter((r) => r.status !== 200);
    expect(failed.map((f) => f.linkId + ": " + f.body.error)).toEqual([]);
  }, 900_000);
});
