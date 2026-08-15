import { describe, it, expect, beforeAll } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  encodeFunctionData,
  parseUnits,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import addresses from "./e2e-addresses.json";
import { handlePay } from "../src/pay";
import { handleRelayTx } from "../src/relayTx";
import { INTEGRATOR_ABI, type Env } from "../src/config";
import { readLink, linkBlockedReason } from "../src/chain";
import { makeTestEnv, mineBlocks, increaseTime } from "./harness";

/**
 * End-to-end against a real chain.
 *
 * This drives the ACTUAL Worker handlers — `handlePay`, `handleRelayTx` — with
 * real HTTP Requests, a real RPC, real signing, and real receipts. The only
 * simulated pieces are the Cloudflare bindings (KV, Durable Objects), which the
 * harness reimplements faithfully enough that the concurrency behaviour under
 * test is the real behaviour.
 *
 * If this passes, the walletless payment path works.
 */

const chain = defineChain({
  id: addresses.chainId,
  name: "local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [addresses.rpcUrl] } },
});

const pub = createPublicClient({ chain, transport: http(addresses.rpcUrl) });

// Hardhat account #1 — the merchant. Only used to create links, exactly as the
// merchant's own sponsored transaction would.
const MERCHANT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const merchantWallet = createWalletClient({
  account: privateKeyToAccount(MERCHANT_KEY),
  chain,
  transport: http(addresses.rpcUrl),
});

const INR = toHex("INR", { size: 32 });
const PUBKEY = "04" + "ab".repeat(64);
const USDC = (n: number) => parseUnits(String(n), 6);

let env: Env;

/**
 * Link ids must be unique per run: the contract refuses to overwrite an
 * existing link (LinkExists), so a fixed id would only work against a fresh
 * chain. This keeps the suite re-runnable against a long-lived node.
 */
const RUN = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** Creates a link the way the merchant's browser would. */
async function createLink(opts: {
  id: string;
  amount: bigint;
  expiresAt?: bigint;
  singleUse?: boolean;
  currency?: Hex;
}): Promise<Hex> {
  const linkId = keccak256(toHex(`${RUN}:${opts.id}`));
  const hash = await merchantWallet.writeContract({
    address: addresses.integrator as Address,
    abi: [
      {
        type: "function",
        name: "createLink",
        stateMutability: "nonpayable",
        inputs: [
          { name: "linkId", type: "bytes32" },
          { name: "amount", type: "uint96" },
          { name: "currency", type: "bytes32" },
          { name: "expiresAt", type: "uint64" },
          { name: "singleUse", type: "bool" },
          { name: "encryptedConfig", type: "bytes" },
        ],
        outputs: [],
      },
    ] as const,
    functionName: "createLink",
    args: [
      linkId,
      opts.amount,
      opts.currency ?? INR,
      opts.expiresAt ?? 0n,
      opts.singleUse ?? false,
      "0x" as Hex,
    ],
    account: merchantWallet.account!,
    chain,
  });
  await pub.waitForTransactionReceipt({ hash });
  return linkId;
}

/**
 * Exactly what the customer's browser POSTs when they tap Pay.
 *
 * Each request gets its own source IP by default — these are different
 * customers, and sharing one would trip the per-IP rate limit partway through
 * the suite and mask real failures. Pass a fixed `ip` to test the limiter.
 */
let ipCounter = 0;
function payRequest(body: Record<string, unknown> = {}, ip?: string): Request {
  const from = ip ?? `203.0.113.${(ipCounter++ % 200) + 1}`;
  return new Request("https://worker/api/pay/x", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": from },
    body: JSON.stringify({ pubKey: PUBKEY, circleId: 1, ...body }),
  });
}

beforeAll(async () => {
  env = makeTestEnv(addresses);

  // The contract caps a merchant at 25 orders per UTC day, and link payments
  // count toward it — correct behaviour, but this suite places more than that.
  // Raise the ceiling so the tests exercise the payment path rather than
  // repeatedly re-proving the daily limit (which has its own dedicated test).
  const admin = createWalletClient({
    account: privateKeyToAccount(
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
    ),
    chain,
    transport: http(addresses.rpcUrl),
  });
  const hash = await admin.writeContract({
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
    args: [5000n],
    account: admin.account!,
    chain,
  });
  await pub.waitForTransactionReceipt({ hash });
});

describe("E2E · the walletless payment path", () => {
  it("a customer with no wallet pays a link and an order really exists on-chain", async () => {
    const linkId = await createLink({ id: "e2e-happy", amount: USDC(3), singleUse: true });

    const res = await handlePay(payRequest(), env, linkId);
    const body = (await res.json()) as { orderId?: string; txHash?: string; error?: string };

    expect(res.status, `unexpected: ${JSON.stringify(body)}`).toBe(200);
    expect(body.orderId).toBeDefined();
    expect(body.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    // The order is recorded against the LINK'S OWNER — the merchant never
    // signed anything, and the customer has no wallet at all.
    const merchant = await pub.readContract({
      address: addresses.integrator as Address,
      abi: INTEGRATOR_ABI,
      functionName: "orderToMerchant",
      args: [BigInt(body.orderId!)],
    });
    expect((merchant as string).toLowerCase()).toBe(addresses.merchant.toLowerCase());
  });

  it("consumes a single-use link, so a forwarded URL is dead", async () => {
    const linkId = await createLink({ id: "e2e-single", amount: USDC(2), singleUse: true });

    const first = await handlePay(payRequest(), env, linkId);
    expect(first.status).toBe(200);

    // Someone else opens the same URL.
    const second = await handlePay(payRequest(), env, linkId);
    const body = (await second.json()) as { error: string };
    expect(second.status).toBe(409);
    expect(body.error).toMatch(/already been paid/i);
  });

  it("keeps a reusable link payable, and each payment is its own order", async () => {
    const linkId = await createLink({ id: "e2e-reuse", amount: USDC(1), singleUse: false });

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await handlePay(payRequest(), env, linkId);
      expect(res.status).toBe(200);
      ids.push(((await res.json()) as { orderId: string }).orderId);
    }
    expect(new Set(ids).size).toBe(3);
  });

  it("refuses a revoked link the moment it is revoked — no cache to go stale", async () => {
    const linkId = await createLink({ id: "e2e-revoke", amount: USDC(1) });

    expect((await handlePay(payRequest(), env, linkId)).status).toBe(200);

    const hash = await merchantWallet.writeContract({
      address: addresses.integrator as Address,
      abi: [
        {
          type: "function",
          name: "revokeLink",
          stateMutability: "nonpayable",
          inputs: [{ name: "linkId", type: "bytes32" }],
          outputs: [],
        },
      ] as const,
      functionName: "revokeLink",
      args: [linkId],
      account: merchantWallet.account!,
      chain,
    });
    await pub.waitForTransactionReceipt({ hash });

    const res = await handlePay(payRequest(), env, linkId);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/cancelled/i);
  });

  it("refuses an expired link", async () => {
    const now = BigInt((await pub.getBlock()).timestamp);
    const linkId = await createLink({
      id: "e2e-expiry",
      amount: USDC(1),
      expiresAt: now + 60n,
    });

    expect((await handlePay(payRequest(), env, linkId)).status).toBe(200);

    await increaseTime(addresses.rpcUrl, 120);
    const res = await handlePay(payRequest(), env, linkId);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/expired/i);
  });

  it("tells the customer plainly when the merchant has hit their daily limit", async function () {
    // This really happened while building this suite: the merchant exhausted
    // their 25/day quota and every further payment failed. The customer is
    // alone with the screen, so the message has to say what is wrong.
    const admin = createWalletClient({
      account: privateKeyToAccount(
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
      ),
      chain,
      transport: http(addresses.rpcUrl),
    });
    const setLimit = async (n: bigint) => {
      const h = await admin.writeContract({
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
        args: [n],
        account: admin.account!,
        chain,
      });
      await pub.waitForTransactionReceipt({ hash: h });
    };

    const linkId = await createLink({ id: "e2e-daily", amount: USDC(1) });
    await setLimit(1n); // already used far more than 1 today
    try {
      const res = await handlePay(payRequest(), env, linkId);
      const { error } = (await res.json()) as { error: string };
      expect(res.status).toBe(409);
      expect(error).toMatch(/today's payment limit/i);
      expect(error).not.toMatch(/0x|revert/i);
    } finally {
      await setLimit(5000n);
    }
  });

  it("returns a message a person can act on, never a raw revert", async () => {
    const linkId = keccak256(toHex("never-created"));
    const res = await handlePay(payRequest(), env, linkId);
    const { error } = (await res.json()) as { error: string };

    expect(res.status).toBe(404);
    expect(error).toMatch(/not found/i);
    expect(error).not.toMatch(/0x|revert|execution/i);
  });
});

describe("E2E · the request body cannot move money", () => {
  it("ignores a tampered amount on a fixed-price link", async () => {
    const linkId = await createLink({ id: "e2e-tamper", amount: USDC(5), singleUse: true });

    // The customer's browser claims quantity 1 (= 1 USDC) for a 5 USDC link.
    // The Worker derives quantity from the link itself, so the order is 5 USDC.
    const res = await handlePay(payRequest({ quantity: 1 }), env, linkId);
    expect(res.status).toBe(200);

    const { orderId } = (await res.json()) as { orderId: string };
    const logs = await pub.getLogs({
      address: addresses.integrator as Address,
      event: INTEGRATOR_ABI.find(
        (e) => e.type === "event" && e.name === "LinkOrderPlaced"
      ) as never,
      fromBlock: 0n,
    });
    const mine = logs.find(
      (l) => (l as unknown as { args: { orderId: bigint } }).args.orderId === BigInt(orderId)
    ) as unknown as { args: { amount: bigint } };

    expect(mine.args.amount, "amount comes from the CHAIN, not the body").toBe(USDC(5));
  });

  it("rejects an absurd quantity on a variable link before spending gas", async () => {
    const linkId = await createLink({ id: "e2e-absurd", amount: 0n });

    // 1e30 passes Number.isInteger — the guard must be isSafeInteger.
    const res = await handlePay(payRequest({ quantity: 1e30 }), env, linkId);
    expect(res.status).toBe(400);
  });

  it("rejects a quantity above the merchant's per-tx cap", async () => {
    const linkId = await createLink({ id: "e2e-cap", amount: 0n });
    // Default INR cap is 50 USDC; ask for 500.
    const res = await handlePay(payRequest({ quantity: 500 }), env, linkId);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/above the limit/i);
  });

  it("requires a relay pubkey — the LP has nothing to encrypt to without it", async () => {
    const linkId = await createLink({ id: "e2e-nokey", amount: USDC(1) });
    const req = new Request("https://worker/api/pay/x", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" },
      body: JSON.stringify({ circleId: 1 }),
    });
    expect((await handlePay(req, env, linkId)).status).toBe(400);
  });

  it("rejects a malformed link id without touching the chain", async () => {
    expect((await handlePay(payRequest(), env, "not-a-link")).status).toBe(400);
  });
});

describe("E2E · concurrency", () => {
  it("two customers paying DIFFERENT links at once both succeed — the nonce bug", async () => {
    // This is the failure the global nonce sequencer exists to prevent: two
    // payments on different links read the same pending nonce, and one
    // transaction is silently dropped with no error anywhere.
    // Created sequentially — the MERCHANT's own wallet has no nonce sequencer,
    // and racing it here would test viem rather than the Worker. What must be
    // concurrent is the two PAYMENTS below, which is where the relayer's
    // single nonce sequence is actually contended.
    const a = await createLink({ id: "e2e-conc-a", amount: USDC(1) });
    const b = await createLink({ id: "e2e-conc-b", amount: USDC(1) });

    const [ra, rb] = await Promise.all([
      handlePay(payRequest(), env, a),
      handlePay(payRequest(), env, b),
    ]);

    const [ba, bb] = (await Promise.all([ra.json(), rb.json()])) as {
      orderId?: string;
      error?: string;
    }[];

    expect(ra.status, `A failed: ${ba.error}`).toBe(200);
    expect(rb.status, `B failed: ${bb.error}`).toBe(200);
    expect(ba.orderId).not.toBe(bb.orderId);

    // Both transactions really landed — neither was dropped.
    for (const id of [ba.orderId!, bb.orderId!]) {
      const m = await pub.readContract({
        address: addresses.integrator as Address,
        abi: INTEGRATOR_ABI,
        functionName: "orderToMerchant",
        args: [BigInt(id)],
      });
      expect(m).not.toBe("0x0000000000000000000000000000000000000000");
    }
  });

  it("a double-tap on ONE link places at most one order", async () => {
    const linkId = await createLink({ id: "e2e-doubletap", amount: USDC(1), singleUse: true });

    const [r1, r2] = await Promise.all([
      handlePay(payRequest(), env, linkId),
      handlePay(payRequest(), env, linkId),
    ]);

    const ok = [r1, r2].filter((r) => r.status === 200);
    expect(ok.length, "exactly one tap may win").toBe(1);
  });
});

describe("E2E · relay-tx forwarding", () => {
  let seq = 0;
  async function placeOrder(): Promise<string> {
    const linkId = await createLink({ id: `e2e-relay-${seq++}`, amount: USDC(1) });
    const res = await handlePay(payRequest(), env, linkId);
    const body = (await res.json()) as { orderId?: string; error?: string };
    expect(res.status, `pay failed: ${body.error}`).toBe(200);
    return body.orderId!;
  }

  let relaySeq = 0;
  function relayReq(to: string, data: string): Request {
    return new Request("https://worker/api/relay-tx", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": `198.51.100.${(relaySeq++ % 200) + 1}`,
      },
      body: JSON.stringify({ to, data }),
    });
  }

  const cancelData = (orderId: bigint) =>
    encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "cancelOrder",
          stateMutability: "nonpayable",
          inputs: [{ type: "uint256" }],
          outputs: [],
        },
      ] as const,
      functionName: "cancelOrder",
      args: [orderId],
    });

  it("refuses any target that is not the Diamond", async () => {
    const orderId = await placeOrder();
    // Pointed at our own integrator — the one thing this must never reach.
    const res = await handleRelayTx(
      relayReq(addresses.integrator, cancelData(BigInt(orderId))),
      env
    );
    expect(res.status).toBe(403);
  });

  it("refuses a selector that is not on the allowlist", async () => {
    const withdraw = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "withdrawUSDC",
          stateMutability: "nonpayable",
          inputs: [{ type: "uint256" }],
          outputs: [],
        },
      ] as const,
      functionName: "withdrawUSDC",
      args: [1n],
    });
    const res = await handleRelayTx(relayReq(addresses.diamond, withdraw), env);
    expect(res.status).toBe(403);
  });

  it("refuses an order this contract never placed", async () => {
    const res = await handleRelayTx(relayReq(addresses.diamond, cancelData(999_999n)), env);
    expect(res.status).toBe(403);
  });

  it("refuses calldata with a trailing argument smuggled on", async () => {
    const orderId = await placeOrder();
    const padded = (cancelData(BigInt(orderId)) + "0".repeat(64)) as Hex;
    const res = await handleRelayTx(relayReq(addresses.diamond, padded), env);
    expect(res.status).toBe(403);
  });
});

describe("E2E · the relayer's boundary is structural", () => {
  it("is not a registered merchant, so no funds-moving function is reachable", async () => {
    const registered = await pub.readContract({
      address: addresses.integrator as Address,
      abi: [
        {
          type: "function",
          name: "registered",
          stateMutability: "view",
          inputs: [{ type: "address" }],
          outputs: [{ type: "bool" }],
        },
      ] as const,
      functionName: "registered",
      args: [addresses.relayer as Address],
    });
    expect(registered).toBe(false);
  });

  it("never holds USDC through a real payment", async () => {
    const linkId = await createLink({ id: "e2e-custody", amount: USDC(2) });
    await handlePay(payRequest(), env, linkId);

    const bal = await pub.readContract({
      address: addresses.usdc as Address,
      abi: [
        {
          type: "function",
          name: "balanceOf",
          stateMutability: "view",
          inputs: [{ type: "address" }],
          outputs: [{ type: "uint256" }],
        },
      ] as const,
      functionName: "balanceOf",
      args: [addresses.relayer as Address],
    });
    expect(bal).toBe(0n);
  });

  it("reads link state straight from chain, matching the contract's own view", async () => {
    const linkId = await createLink({ id: "e2e-readthrough", amount: USDC(4), singleUse: true });

    const link = await readLink(pub as never, env, linkId);
    expect(link).not.toBeNull();
    expect(link!.owner.toLowerCase()).toBe(addresses.merchant.toLowerCase());
    expect(link!.amount).toBe(USDC(4));
    expect(linkBlockedReason(link!, Math.floor(Date.now() / 1000))).toBeNull();

    const onChain = await pub.readContract({
      address: addresses.integrator as Address,
      abi: INTEGRATOR_ABI,
      functionName: "isLinkActive",
      args: [linkId],
    });
    expect(onChain).toBe(true);
  });
});

describe("E2E · gas accounting", () => {
  it("charges the daily budget for a real payment", async () => {
    const key = `gas:day:${Math.floor(Date.now() / 86_400_000)}`;
    const before = BigInt((await env.KV.get(key)) ?? "0");

    const linkId = await createLink({ id: "e2e-gas", amount: USDC(1) });
    const res = await handlePay(payRequest(), env, linkId);
    expect(res.status).toBe(200);

    const after = BigInt((await env.KV.get(key)) ?? "0");
    expect(after).toBeGreaterThan(before);
    // A single payment must not be wildly off the measured ~348k average.
    expect(after - before).toBeLessThan(600_000n);
  });
});

describe("E2E · settlement parity", () => {
  it("a link sale lands in the merchant's balance under the normal lock", async () => {
    const linkId = await createLink({ id: "e2e-settle", amount: USDC(3), singleUse: true });
    const res = await handlePay(payRequest(), env, linkId);
    const payload = (await res.json()) as { orderId?: string; error?: string };
    expect(res.status, `pay failed: ${payload.error}`).toBe(200);
    const orderId = payload.orderId!;

    const balBefore = (await pub.readContract({
      address: addresses.integrator as Address,
      abi: [
        {
          type: "function",
          name: "getMerchantBalance",
          stateMutability: "view",
          inputs: [{ type: "address" }],
          outputs: [
            { type: "uint256" },
            { type: "uint256" },
            { type: "uint256" },
            { type: "bool" },
          ],
        },
      ] as const,
      functionName: "getMerchantBalance",
      args: [addresses.merchant as Address],
    })) as readonly [bigint, bigint, bigint, boolean];

    // The LP completes the fiat leg.
    const deployer = createWalletClient({
      account: privateKeyToAccount(
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
      ),
      chain,
      transport: http(addresses.rpcUrl),
    });
    const hash = await deployer.writeContract({
      address: addresses.diamond as Address,
      abi: [
        {
          type: "function",
          name: "simulateOrderComplete",
          stateMutability: "nonpayable",
          inputs: [{ type: "uint256" }],
          outputs: [],
        },
      ] as const,
      functionName: "simulateOrderComplete",
      args: [BigInt(orderId)],
      account: deployer.account!,
      chain,
    });
    await pub.waitForTransactionReceipt({ hash });

    const balAfter = (await pub.readContract({
      address: addresses.integrator as Address,
      abi: [
        {
          type: "function",
          name: "getMerchantBalance",
          stateMutability: "view",
          inputs: [{ type: "address" }],
          outputs: [
            { type: "uint256" },
            { type: "uint256" },
            { type: "uint256" },
            { type: "bool" },
          ],
        },
      ] as const,
      functionName: "getMerchantBalance",
      args: [addresses.merchant as Address],
    })) as readonly [bigint, bigint, bigint, boolean];

    // Pending rises by exactly the sale amount — locked, not yet withdrawable.
    expect(balAfter[0] - balBefore[0]).toBe(USDC(3));
    expect(balAfter[2] - balBefore[2]).toBe(USDC(3));

    // After the lock period it becomes available on the ordinary schedule.
    await increaseTime(addresses.rpcUrl, addresses.settlementPeriod + 10);
    await mineBlocks(addresses.rpcUrl, 1);

    const unlocked = (await pub.readContract({
      address: addresses.integrator as Address,
      abi: [
        {
          type: "function",
          name: "getMerchantBalance",
          stateMutability: "view",
          inputs: [{ type: "address" }],
          outputs: [
            { type: "uint256" },
            { type: "uint256" },
            { type: "uint256" },
            { type: "bool" },
          ],
        },
      ] as const,
      functionName: "getMerchantBalance",
      args: [addresses.merchant as Address],
    })) as readonly [bigint, bigint, bigint, boolean];

    expect(unlocked[1]).toBeGreaterThanOrEqual(USDC(3));
  });
});
