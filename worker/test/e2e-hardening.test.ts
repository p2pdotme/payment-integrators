import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { requireFixture } from "./fixture";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  hashMessage,
  keccak256,
  encodeAbiParameters,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { handlePay } from "../src/pay";
import { handleRelayTx } from "../src/relayTx";
import { handleRegisterWebhook, registrationMessage } from "../src/webhooks";
import { reserveGas } from "../src/limits";
import { MAX_FALSE_CLAIMS } from "../src/claims";
import { INTEGRATOR_ABI, DEFAULT_LIMITS } from "../src/config";

/**
 * The merchant-side surface. The Worker never calls these — it is not a
 * merchant — so they are absent from src/config.ts by design. This suite drives
 * both sides of the flow, so it needs them.
 */
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
  {
    type: "function",
    name: "userPlaceOrder",
    stateMutability: "nonpayable",
    inputs: [
      { name: "client", type: "address" },
      { name: "productId", type: "uint256" },
      { name: "quantity", type: "uint256" },
      { name: "currency", type: "bytes32" },
      { name: "circleId", type: "uint256" },
      { name: "pubKey", type: "string" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "proxyAddress",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "getMerchantBalance",
    stateMutability: "view",
    inputs: [{ name: "merchant", type: "address" }],
    outputs: [
      { name: "pending", type: "uint256" },
      { name: "available", type: "uint256" },
      { name: "totalDeposited", type: "uint256" },
      { name: "isFrozen", type: "bool" },
    ],
  },
] as const;
import {
  makeTestEnv,
  type Addresses,
  useLocalBundler,
  registerLinkAgent,
  CUSTOMER_PUBKEY,
  signRelayAction,
} from "./harness";

/**
 * Adversarial end-to-end.
 *
 * `e2e.test.ts` proves the walletless path works. This file tries to break the
 * things that were BROKEN — every finding from the review gets an attacker, not
 * a happy path. Two rules kept throughout:
 *
 *   1. Drive the real handlers, not the contract directly. A fix that only
 *      holds when you call the contract yourself is not a fix — B1 was exactly
 *      that shape: the contract was fine, the service could not reach it.
 *   2. Assert against CHAIN state, not the handler's own response. A handler
 *      that returns 200 while the order stalls at PLACED is the original bug.
 */

// The URL object goes straight to existsSync/readFileSync, both of which
// accept one. The previous drive-letter fix only mattered because the path
// was being stringified at all.
const ADDRESSES_PATH = new URL("./e2e-addresses.json", import.meta.url);
export const HAS_E2E_FIXTURE = requireFixture(ADDRESSES_PATH, "e2e-hardening");

const addresses: Addresses = HAS_E2E_FIXTURE
  ? JSON.parse(readFileSync(ADDRESSES_PATH, "utf8"))
  : ({
      rpcUrl: "http://127.0.0.1:8545",
      chainId: 1337,
      integrator: "0x0000000000000000000000000000000000000001",
      diamond: "0x0000000000000000000000000000000000000002",
      client: "0x0000000000000000000000000000000000000003",
      usdc: "0x0000000000000000000000000000000000000004",
      merchant: "0x0000000000000000000000000000000000000005",
      relayer: "0x0000000000000000000000000000000000000006",
      relayerKey: `0x${"11".repeat(32)}`,
      settlementPeriod: 600,
    } as Addresses);

const chain = defineChain({
  id: addresses.chainId,
  name: "e2e",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [addresses.rpcUrl] } },
});

const pub = createPublicClient({ chain, transport: http(addresses.rpcUrl) });
const env = makeTestEnv(addresses);

// Hardhat's deterministic accounts. #1 is the merchant in e2e-setup.js.
const MERCHANT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
/** Stands in for the LP that settles the order. Never the relayer. */
const LP_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const OUTSIDER_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";

const merchantAccount = privateKeyToAccount(MERCHANT_KEY as Hex);
const outsiderAccount = privateKeyToAccount(OUTSIDER_KEY as Hex);
const merchantWallet = createWalletClient({
  account: merchantAccount,
  chain,
  transport: http(addresses.rpcUrl),
});

const USDC = (n: number) => BigInt(n) * 1_000_000n;
const INR = ("0x" + Buffer.from("INR").toString("hex").padEnd(64, "0")) as Hex;
// A REAL keypair. The same key the LP encrypts payment details to is now the
// key that must sign "I have paid", so a placeholder pubkey could not sign and
// would test a path no real customer takes.
const PK = CUSTOMER_PUBKEY;

const PAID_SELECTOR = "0x1e31508e";
const CANCEL_SELECTOR = "0x514fcac7";

let salt = 0;
/** Unique per run: the node keeps state between runs, and link ids are permanent. */
const RUN = Date.now().toString(36);

/** Creates a link with the merchant's own signer, exactly as the app does. */
async function createLink(opts: { amount: bigint; maxUses?: number }): Promise<Hex> {
  const s = keccak256(toBytes(`harden-${RUN}-${salt++}`));
  const linkId = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [addresses.merchant as Address, s]
    )
  );
  const hash = await merchantWallet.writeContract({
    address: addresses.integrator as Address,
    abi: MERCHANT_ABI,
    functionName: "createLink",
    args: [linkId, opts.amount, INR, 0n, opts.maxUses ?? 0, "0x"],
  });
  await pub.waitForTransactionReceipt({ hash });

  // The link's own account, bound to it on the Router. In production the
  // merchant app batches this into the operation that creates the link; a link
  // without it looks correctly created and can never be paid.
  await registerLinkAgent(env, linkId, merchantWallet, addresses.router);

  return linkId;
}

const payRequest = (ip = "198.51.100.1", body: Record<string, unknown> = {}) =>
  new Request("https://worker/api/pay/x", {
    method: "POST",
    headers: { "CF-Connecting-IP": ip, "Content-Type": "application/json" },
    body: JSON.stringify({ pubKey: PK, ...body }),
  });

/**
 * Builds a relay request, signing as the customer when one is implied.
 *
 * A claim token means "this is the browser that placed the order" — the
 * legitimate customer — so the request also carries that customer's signature,
 * because a real one would. Requests WITHOUT a claim token are the ones probing
 * other gates (wrong target, smuggled argument, someone else's order), and they
 * deliberately stay unsigned so those gates are what gets tested.
 *
 * Async because signing is: the link is read from the chain so the signature is
 * bound to the same order the request names.
 */
const relayRequest = async (
  data: string,
  ip = "198.51.100.1",
  to = addresses.diamond,
  claimToken?: string | null,
  signature?: string
): Promise<Request> => {
  let sig = signature;
  // Only well-formed calldata (selector + one uint256) can be signed for. The
  // malformed and smuggled payloads some tests send must reach the endpoint's
  // own guards, not fail here.
  if (!sig && claimToken && data.length === 2 + 8 + 64) {
    const orderId = BigInt("0x" + data.slice(10));
    const linkId = (await pub.readContract({
      address: addresses.integrator as Address,
      abi: INTEGRATOR_ABI,
      functionName: "orderToLink",
      args: [orderId],
    })) as Hex;
    const action = data.slice(0, 10).toLowerCase() === PAID_SELECTOR ? "MarkPaid" : "Cancel";
    sig = await signRelayAction(addresses, action, linkId, orderId);
  }
  return new Request("https://worker/api/relay-tx", {
    method: "POST",
    headers: {
      "CF-Connecting-IP": ip,
      "Content-Type": "application/json",
      ...(claimToken ? { "X-Payment-Claim": claimToken } : {}),
    },
    body: JSON.stringify({ to, data, ...(sig ? { signature: sig } : {}) }),
  });
};

const orderCall = (selector: string, orderId: bigint) =>
  selector + orderId.toString(16).padStart(64, "0");

const readOrder = (orderId: bigint) =>
  pub.readContract({
    address: addresses.diamond as Address,
    abi: [
      {
        type: "function",
        name: "orders",
        stateMutability: "view",
        inputs: [{ type: "uint256" }],
        outputs: [
          { name: "integrator", type: "address" },
          { name: "user", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "currency", type: "bytes32" },
          { name: "recipientAddr", type: "address" },
          { name: "completed", type: "bool" },
          { name: "cancelled", type: "bool" },
          { name: "paid", type: "bool" },
        ],
      },
    ] as const,
    functionName: "orders",
    args: [orderId],
  });

const readLink = (linkId: Hex) =>
  pub.readContract({
    address: addresses.integrator as Address,
    abi: INTEGRATOR_ABI,
    functionName: "getLink",
    args: [linkId],
  }) as Promise<readonly [Address, bigint, Hex, bigint, number, number, number, number]>;

/** Pay a link through the real handler and return its on-chain order id. */
/**
 * An LP takes the order.
 *
 * Required before PAID on the real Diamond — there is nobody the fiat could
 * have been sent to until an LP has accepted. The mock enforces this now, so
 * the tests have to walk the same path a real payment does.
 */
async function acceptOrder(orderId: bigint) {
  const lp = createWalletClient({
    account: privateKeyToAccount(LP_KEY),
    chain,
    transport: http(addresses.rpcUrl),
  });
  const hash = await lp.writeContract({
    address: addresses.diamond as Address,
    abi: [
      {
        type: "function",
        name: "simulateOrderAccepted",
        stateMutability: "nonpayable",
        inputs: [{ type: "uint256" }],
        outputs: [],
      },
    ] as const,
    functionName: "simulateOrderAccepted",
    args: [orderId],
  });
  await pub.waitForTransactionReceipt({ hash });
}

async function pay(linkId: Hex, ip = "198.51.100.1", body: Record<string, unknown> = {}) {
  const res = await handlePay(payRequest(ip, body), env, linkId);
  const payload = (await res.json()) as { orderId?: string; claimToken?: string; error?: string };
  return {
    status: res.status,
    payload,
    orderId: payload.orderId ? BigInt(payload.orderId) : null,
    claim: payload.claimToken ?? null,
  };
}

let bundlerHandle: ReturnType<typeof useLocalBundler>;
afterAll(() => bundlerHandle?.restore());

beforeAll(async () => {
  if (!HAS_E2E_FIXTURE) return;

  // Substitute the bundler and paymaster SERVICES only. Everything in src/
  // runs exactly as it will in production.
  bundlerHandle = useLocalBundler(addresses);

  const admin = createWalletClient({
    account: privateKeyToAccount(
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex
    ),
    chain,
    transport: http(addresses.rpcUrl),
  });

  // Fund the outsider so it can pay gas for its own attempts.
  const funded = await admin.sendTransaction({
    to: outsiderAccount.address,
    value: 10n ** 18n,
  });
  await pub.waitForTransactionReceipt({ hash: funded });

  // The contract caps a merchant at 25 orders per UTC day and link payments
  // count toward it — correct, and proven by its own test. This suite places
  // more than that, and vitest gives no ordering guarantee between files, so
  // raise the ceiling here rather than depending on another file having run.
  const raised = await admin.writeContract({
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
  await pub.waitForTransactionReceipt({ hash: raised });
});

// ─── B1: the whole point ────────────────────────────────────────────

describe.skipIf(!HAS_E2E_FIXTURE)("HARDEN · a link payment actually completes", () => {
  it("drives PLACED -> PAID -> COMPLETED through the real handlers and credits the merchant", async () => {
    const linkId = await createLink({ amount: USDC(1), maxUses: 1 });

    // 1. Walletless customer pays.
    const { status, orderId, payload, claim } = await pay(linkId);
    expect(status, `pay failed: ${payload.error}`).toBe(200);
    expect(orderId).not.toBeNull();

    // order.user must be the merchant's PROXY. If this is the merchant, the
    // next step cannot succeed and the customer's fiat is stranded.
    const placed = await readOrder(orderId!);
    const proxy = (await pub.readContract({
      address: addresses.integrator as Address,
      abi: MERCHANT_ABI,
      functionName: "proxyAddress",
      args: [addresses.merchant as Address],
    })) as Address;
    expect(placed[1].toLowerCase()).toBe(proxy.toLowerCase());
    expect(placed[1].toLowerCase()).not.toBe(addresses.merchant.toLowerCase());
    expect(placed[7]).toBe(false); // not paid yet

    // 2. Customer taps "I have paid" — THE step that was impossible before.
    await acceptOrder(orderId!);
    const relayRes = await handleRelayTx(
      await relayRequest(
        orderCall(PAID_SELECTOR, orderId!),
        "198.51.100.1",
        addresses.diamond,
        claim
      ),
      env
    );
    const relayBody = (await relayRes.json()) as { hash?: string; error?: string };
    expect(relayRes.status, `markPaid failed: ${relayBody.error}`).toBe(200);
    expect(relayBody.hash).toMatch(/^0x[0-9a-f]{64}$/);

    // Chain state, not the handler's word for it.
    expect((await readOrder(orderId!))[7]).toBe(true);

    // 3. The LP settles, and the merchant is credited.
    const before = (await pub.readContract({
      address: addresses.integrator as Address,
      abi: MERCHANT_ABI,
      functionName: "getMerchantBalance",
      args: [addresses.merchant as Address],
    })) as readonly [bigint, bigint, bigint, boolean];

    const relayerWallet = createWalletClient({
      // Deliberately NOT the relayer key: the Worker owns that nonce sequence.
      account: privateKeyToAccount(LP_KEY),
      chain,
      transport: http(addresses.rpcUrl),
    });
    const done = await relayerWallet.writeContract({
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
      args: [orderId!],
      // An EXPLICIT limit, because estimation cannot be trusted for this call.
      // MockDiamond CATCHES a failing onOrderComplete — as the real gateway
      // does — so `eth_estimateGas` binary-searches to the smallest gas that
      // makes the TRANSACTION succeed, which is the amount where the callback
      // is SKIPPED. The order then reads as completed while the USDC sits
      // stranded on the proxy and the merchant is never credited.
      //
      // This surfaced only once the shared node had accumulated enough
      // settlement buckets to make the callback expensive, which is exactly
      // how it would surface in production: fine early, silently wrong later.
      gas: 3_000_000n,
    });
    await pub.waitForTransactionReceipt({ hash: done });

    const after = (await pub.readContract({
      address: addresses.integrator as Address,
      abi: MERCHANT_ABI,
      functionName: "getMerchantBalance",
      args: [addresses.merchant as Address],
    })) as readonly [bigint, bigint, bigint, boolean];

    // totalDeposited grew by exactly the order amount.
    expect(after[2] - before[2]).toBe(USDC(1));
  });

  it("cancels through the proxy and gives the link's use back — the callback must fire", async () => {
    // Regression for the shared reentrancy flag: with one guard, onOrderCancel
    // reverted on a lock its own caller held, the Diamond swallowed it, and the
    // use was silently lost.
    const linkId = await createLink({ amount: USDC(1), maxUses: 1 });
    const { orderId, status, claim } = await pay(linkId);
    expect(status).toBe(200);
    expect((await readLink(linkId))[6]).toBe(1); // uses

    const res = await handleRelayTx(
      await relayRequest(
        orderCall(CANCEL_SELECTOR, orderId!),
        "198.51.100.1",
        addresses.diamond,
        claim
      ),
      env
    );
    const body = (await res.json()) as { error?: string };
    expect(res.status, `cancel failed: ${body.error}`).toBe(200);

    expect((await readOrder(orderId!))[6]).toBe(true); // cancelled
    expect((await readLink(linkId))[6]).toBe(0); // use RETURNED
    // ...so the link is payable again by a real customer.
    expect((await pay(linkId)).status).toBe(200);
  });
});

// ─── B1: the relayer's boundary ─────────────────────────────────────

describe.skipIf(!HAS_E2E_FIXTURE)(
  "HARDEN · the relay endpoint cannot be turned into a weapon",
  () => {
    it("refuses to touch an order that did not come from a link", async () => {
      // A POS order the merchant placed for themselves.
      const hash = await merchantWallet.writeContract({
        address: addresses.integrator as Address,
        abi: MERCHANT_ABI,
        functionName: "userPlaceOrder",
        args: [addresses.client as Address, 1n, 1n, INR, 0n, PK],
      });
      const receipt = await pub.waitForTransactionReceipt({ hash });
      expect(receipt.status).toBe("success");

      const nextId = (await pub.readContract({
        address: addresses.diamond as Address,
        abi: [
          {
            type: "function",
            name: "nextOrderId",
            stateMutability: "view",
            inputs: [],
            outputs: [{ type: "uint256" }],
          },
        ] as const,
        functionName: "nextOrderId",
      })) as bigint;
      const posOrderId = nextId - 1n;

      for (const sel of [PAID_SELECTOR, CANCEL_SELECTOR]) {
        const res = await handleRelayTx(await relayRequest(orderCall(sel, posOrderId)), env);
        expect(res.status).toBe(403);
      }
      // The merchant's own order is untouched.
      expect((await readOrder(posOrderId))[7]).toBe(false);
    });

    it("refuses an order id that does not exist at all", async () => {
      const res = await handleRelayTx(await relayRequest(orderCall(PAID_SELECTOR, 999_999n)), env);
      expect(res.status).toBe(403);
    });

    it("refuses any target that is not the Diamond, including our own integrator", async () => {
      const linkId = await createLink({ amount: USDC(1) });
      const { orderId, claim } = await pay(linkId);

      // A VALID token, so it is the target check that refuses — not the token.
      for (const target of [addresses.integrator, addresses.usdc, addresses.client]) {
        const res = await handleRelayTx(
          await relayRequest(orderCall(PAID_SELECTOR, orderId!), "198.51.100.9", target, claim),
          env
        );
        expect(res.status).toBe(403);
      }
    });

    it("refuses a selector outside the two intents, and calldata with a smuggled argument", async () => {
      const linkId = await createLink({ amount: USDC(1) });
      const { orderId, claim } = await pay(linkId);
      const D = addresses.diamond;

      // A VALID token throughout, so it is the selector and calldata checks that
      // refuse rather than the token gate.
      const foreign = "0x" + "deadbeef" + orderId!.toString(16).padStart(64, "0");
      expect(
        (await handleRelayTx(await relayRequest(foreign, "198.51.100.1", D, claim), env)).status
      ).toBe(403);

      const smuggled = orderCall(PAID_SELECTOR, orderId!) + "11".repeat(32);
      expect(
        (await handleRelayTx(await relayRequest(smuggled, "198.51.100.1", D, claim), env)).status
      ).toBe(403);

      expect((await readOrder(orderId!))[7]).toBe(false);
    });

    it("cannot mark the same order paid twice", async () => {
      const linkId = await createLink({ amount: USDC(1) });
      const { orderId, claim } = await pay(linkId);
      const req = async () =>
        await relayRequest(
          orderCall(PAID_SELECTOR, orderId!),
          "198.51.100.1",
          addresses.diamond,
          claim
        );

      await acceptOrder(orderId!);
      expect((await handleRelayTx(await req(), env)).status).toBe(200);
      const second = await handleRelayTx(await req(), env);
      expect(second.status).toBeGreaterThanOrEqual(400);
    });
  }
);

// ─── H1: webhook registration ───────────────────────────────────────

describe.skipIf(!HAS_E2E_FIXTURE)("HARDEN · webhook registration cannot be hijacked", () => {
  async function register(signer: typeof merchantAccount, over: Record<string, unknown> = {}) {
    const linkId = (over.linkId as Hex) ?? (await createLink({ amount: USDC(1) }));
    const url = (over.url as string) ?? "https://attacker.example/hook";
    const nonce = (over.nonce as string) ?? `n-${RUN}-${salt++}`;
    const message = registrationMessage(
      linkId,
      url,
      nonce,
      (over.chainId as number) ?? addresses.chainId,
      (over.integrator as string) ?? addresses.integrator
    );
    const signature = await signer.signMessage({ message });
    const req = new Request("https://worker/api/links", {
      method: "POST",
      headers: { "CF-Connecting-IP": "198.51.100.5", "Content-Type": "application/json" },
      body: JSON.stringify({ linkId, url, nonce, signature, ...(over.body ?? {}) }),
    });
    return { res: await handleRegisterWebhook(req, env), linkId, url, nonce, signature };
  }

  it("accepts a registration signed by the link's owner", async () => {
    const { res } = await register(merchantAccount);
    expect(res.status).toBe(200);
  });

  it("refuses one signed by anybody else — the old bug, attempted", async () => {
    // The attacker knows the linkId and the owner address; both are public.
    const { res } = await register(outsiderAccount);
    expect(res.status).toBe(403);
  });

  it("refuses a claimed-owner field with no signature at all", async () => {
    const linkId = await createLink({ amount: USDC(1) });
    const req = new Request("https://worker/api/links", {
      method: "POST",
      headers: { "CF-Connecting-IP": "198.51.100.5", "Content-Type": "application/json" },
      body: JSON.stringify({
        linkId,
        url: "https://attacker.example/hook",
        merchant: addresses.merchant, // exactly what used to be trusted
      }),
    });
    const res = await handleRegisterWebhook(req, env);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("refuses a replayed signature", async () => {
    const first = await register(merchantAccount);
    expect(first.res.status).toBe(200);

    const replay = new Request("https://worker/api/links", {
      method: "POST",
      headers: { "CF-Connecting-IP": "198.51.100.5", "Content-Type": "application/json" },
      body: JSON.stringify({
        linkId: first.linkId,
        url: first.url,
        nonce: first.nonce,
        signature: first.signature,
      }),
    });
    expect((await handleRegisterWebhook(replay, env)).status).toBeGreaterThanOrEqual(400);
  });

  it("refuses a signature bound to another chain or another contract", async () => {
    expect((await register(merchantAccount, { chainId: addresses.chainId + 1 })).res.status).toBe(
      403
    );
    expect(
      (await register(merchantAccount, { integrator: outsiderAccount.address })).res.status
    ).toBe(403);
  });

  it("refuses a non-HTTPS callback", async () => {
    const { res } = await register(merchantAccount, { url: "http://attacker.example/hook" });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

// ─── M2: the gas budget ─────────────────────────────────────────────

describe.skipIf(!HAS_E2E_FIXTURE)("HARDEN · the gas budget holds under a burst", () => {
  it("admits at most the ceiling's worth when 50 reservations race", async () => {
    // On the KV read-modify-write this admitted all 50: every request read the
    // same stale zero and wrote 1. A Durable Object is serialized, so the 41st
    // sees the 40 before it.
    const price = 1_000_000_000n;
    const ROOM_FOR = 40n;
    const burstEnv = makeTestEnv(addresses, {
      maxGasWeiPerDay: DEFAULT_LIMITS.maxGasWeiPerDay,
      maxGasWeiPerTx: DEFAULT_LIMITS.maxGasWeiPerTx,
    });
    const each = DEFAULT_LIMITS.maxGasWeiPerDay / ROOM_FOR / price;

    const results = await Promise.all(
      Array.from({ length: 50 }, () => reserveGas(burstEnv, each, price))
    );
    const admitted = results.filter((r) => r === null).length;
    expect(admitted).toBeGreaterThan(0);
    expect(admitted).toBeLessThanOrEqual(Number(ROOM_FOR));
  });

  it("refuses a single transaction whose cost exceeds the per-tx ceiling", async () => {
    const prodEnv = makeTestEnv(addresses, {
      maxGasWeiPerTx: DEFAULT_LIMITS.maxGasWeiPerTx,
      maxGasWeiPerDay: DEFAULT_LIMITS.maxGasWeiPerDay,
    });
    const absurd = DEFAULT_LIMITS.maxGasWeiPerTx + 1n;
    expect(await reserveGas(prodEnv, absurd, 1n)).toMatch(/could not be processed/i);
  });
});

// ─── The request body still cannot move money ───────────────────────

describe.skipIf(!HAS_E2E_FIXTURE)("HARDEN · nothing financial comes from the request", () => {
  it("ignores a tampered amount and a tampered merchant on a fixed link", async () => {
    const linkId = await createLink({ amount: USDC(2), maxUses: 1 });
    const { status, orderId } = await pay(linkId, "198.51.100.2", {
      amount: "1",
      merchant: outsiderAccount.address,
      owner: outsiderAccount.address,
    });
    expect(status).toBe(200);

    // Credited to the LINK's owner, at the LINK's amount.
    const order = await readOrder(orderId!);
    expect(order[2]).toBe(USDC(2));
    const merchant = (await pub.readContract({
      address: addresses.integrator as Address,
      abi: INTEGRATOR_ABI,
      functionName: "orderToMerchant",
      args: [orderId!],
    })) as Address;
    expect(merchant.toLowerCase()).toBe(addresses.merchant.toLowerCase());
  });

  it("refuses a quantity that would exceed the merchant's per-tx cap", async () => {
    const linkId = await createLink({ amount: 0n }); // variable
    const { status } = await pay(linkId, "198.51.100.3", { quantity: 1000 });
    expect(status).toBeGreaterThanOrEqual(400);
  });
});

// ─── maxUses and strikes, end to end ────────────────────────────────

describe.skipIf(!HAS_E2E_FIXTURE)("HARDEN · multi-use links and false claims", () => {
  it("takes exactly three payments on a three-use link and then refuses", async () => {
    const linkId = await createLink({ amount: USDC(1), maxUses: 3 });

    for (let i = 0; i < 3; i++) {
      expect((await pay(linkId, `198.51.100.${20 + i}`)).status).toBe(200);
    }
    const fourth = await pay(linkId, "198.51.100.29");
    expect(fourth.status).toBe(409);
    expect(fourth.payload.error).toMatch(/already been used/i);

    expect(
      await pub.readContract({
        address: addresses.integrator as Address,
        abi: INTEGRATOR_ABI,
        functionName: "isLinkActive",
        args: [linkId],
      })
    ).toBe(false);
  });

  it("leaves a permanent strike when a marked-paid order is cancelled, and none when it completes", async () => {
    const linkId = await createLink({ amount: USDC(1), maxUses: 0 });

    // Honest payment: mark paid, then complete -> strike released.
    const good = await pay(linkId, "198.51.100.40");
    await acceptOrder(good.orderId!);
    await handleRelayTx(
      await relayRequest(
        orderCall(PAID_SELECTOR, good.orderId!),
        "198.51.100.40",
        addresses.diamond,
        good.claim
      ),
      env
    );
    expect((await readLink(linkId))[7]).toBe(1); // provisional

    const relayerWallet = createWalletClient({
      // Deliberately NOT the relayer key: the Worker owns that nonce sequence.
      account: privateKeyToAccount(LP_KEY),
      chain,
      transport: http(addresses.rpcUrl),
    });
    const h = await relayerWallet.writeContract({
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
      args: [good.orderId!],
      // An EXPLICIT limit, because estimation cannot be trusted for this call.
      // MockDiamond CATCHES a failing onOrderComplete — as the real gateway
      // does — so `eth_estimateGas` binary-searches to the smallest gas that
      // makes the TRANSACTION succeed, which is the amount where the callback
      // is SKIPPED. The order then reads as completed while the USDC sits
      // stranded on the proxy and the merchant is never credited.
      //
      // This surfaced only once the shared node had accumulated enough
      // settlement buckets to make the callback expensive, which is exactly
      // how it would surface in production: fine early, silently wrong later.
      gas: 3_000_000n,
    });
    await pub.waitForTransactionReceipt({ hash: h });
    expect((await readLink(linkId))[7]).toBe(0); // cleared

    // Dishonest claim: mark paid, then cancel -> strike stands.
    const bad = await pay(linkId, "198.51.100.41");
    await acceptOrder(bad.orderId!);
    await handleRelayTx(
      await relayRequest(
        orderCall(PAID_SELECTOR, bad.orderId!),
        "198.51.100.41",
        addresses.diamond,
        bad.claim
      ),
      env
    );
    await handleRelayTx(
      await relayRequest(
        orderCall(CANCEL_SELECTOR, bad.orderId!),
        "198.51.100.41",
        addresses.diamond,
        bad.claim
      ),
      env
    );
    expect((await readLink(linkId))[7]).toBe(1);
  });

  it("keeps the link payable no matter how many false claims land on it", async () => {
    // Freezing a link on strikes would let anyone kill a merchant's link.
    const linkId = await createLink({ amount: USDC(1), maxUses: 0 });

    for (let i = 0; i < MAX_FALSE_CLAIMS + 2; i++) {
      const p = await pay(linkId, `198.51.100.${60 + i}`);
      await acceptOrder(p.orderId!);
      await handleRelayTx(
        await relayRequest(
          orderCall(PAID_SELECTOR, p.orderId!),
          `198.51.100.${60 + i}`,
          addresses.diamond,
          p.claim
        ),
        env
      );
      await handleRelayTx(
        await relayRequest(
          orderCall(CANCEL_SELECTOR, p.orderId!),
          `198.51.100.${60 + i}`,
          addresses.diamond,
          p.claim
        ),
        env
      );
    }

    expect((await readLink(linkId))[7]).toBeGreaterThanOrEqual(MAX_FALSE_CLAIMS);
    expect(
      await pub.readContract({
        address: addresses.integrator as Address,
        abi: INTEGRATOR_ABI,
        functionName: "isLinkActive",
        args: [linkId],
      })
    ).toBe(true);
    // And a fresh customer can still pay it.
    expect((await pay(linkId, "198.51.100.99")).status).toBe(200);
  });
});

// ─── N1: only the customer who started an order may advance it ──────

describe.skipIf(!HAS_E2E_FIXTURE)(
  "HARDEN · an order belongs to the customer who started it",
  () => {
    it("refuses a second customer trying to cancel the first's in-flight order", async () => {
      const linkId = await createLink({ amount: USDC(1), maxUses: 0 });

      const victim = await pay(linkId, "198.51.100.70");
      expect(victim.status).toBe(200);
      expect(victim.claim).toMatch(/^[0-9a-f]{64}$/);

      // The attacker knows the orderId — it is indexed in LinkOrderPlaced,
      // sequential on the Diamond, and readable from orderToLink. That used to be
      // everything they needed.
      const res = await handleRelayTx(
        await relayRequest(orderCall(CANCEL_SELECTOR, victim.orderId!), "203.0.113.9"),
        env
      );
      expect(res.status).toBe(403);

      // Untouched on-chain, and the victim can still complete their payment.
      expect((await readOrder(victim.orderId!))[6]).toBe(false);
      await acceptOrder(victim.orderId!);
      const ok = await handleRelayTx(
        await relayRequest(
          orderCall(PAID_SELECTOR, victim.orderId!),
          "198.51.100.70",
          addresses.diamond,
          victim.claim
        ),
        env
      );
      expect(ok.status).toBe(200);
      expect((await readOrder(victim.orderId!))[7]).toBe(true);
    });

    it("refuses a second customer trying to mark the first's order paid", async () => {
      const linkId = await createLink({ amount: USDC(1), maxUses: 0 });
      const victim = await pay(linkId, "198.51.100.71");

      const res = await handleRelayTx(
        await relayRequest(orderCall(PAID_SELECTOR, victim.orderId!), "203.0.113.9"),
        env
      );
      expect(res.status).toBe(403);
      expect((await readOrder(victim.orderId!))[7]).toBe(false);
      // No strike lands on the merchant's link for an attempt that never landed.
      expect((await readLink(linkId))[7]).toBe(0);
    });

    it("refuses one customer's token used on another customer's order", async () => {
      const linkId = await createLink({ amount: USDC(1), maxUses: 0 });
      const a = await pay(linkId, "198.51.100.72");
      const b = await pay(linkId, "198.51.100.73");

      const res = await handleRelayTx(
        await relayRequest(
          orderCall(CANCEL_SELECTOR, b.orderId!),
          "198.51.100.72",
          addresses.diamond,
          a.claim
        ),
        env
      );
      expect(res.status).toBe(403);
      expect((await readOrder(b.orderId!))[6]).toBe(false);
    });

    it("refuses a forged or truncated token", async () => {
      const linkId = await createLink({ amount: USDC(1), maxUses: 0 });
      const { orderId } = await pay(linkId, "198.51.100.74");

      for (const bogus of ["f".repeat(64), "abc", "", "0x" + "a".repeat(64)]) {
        const res = await handleRelayTx(
          await relayRequest(
            orderCall(CANCEL_SELECTOR, orderId!),
            "198.51.100.74",
            addresses.diamond,
            bogus
          ),
          env
        );
        expect(res.status).toBe(403);
      }
      expect((await readOrder(orderId!))[6]).toBe(false);
    });

    it("does not leak the token to anyone who did not place the order", async () => {
      // The token is returned exactly once, in the pay response. Nothing else
      // exposes it — not getLink, not orderToLink, not the events.
      const linkId = await createLink({ amount: USDC(1), maxUses: 0 });
      const { claim, orderId } = await pay(linkId, "198.51.100.75");

      const dump = (v: unknown) =>
        JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

      expect(dump(await readLink(linkId))).not.toContain(claim!.slice(0, 16));
      expect(dump(await readOrder(orderId!))).not.toContain(claim!.slice(0, 16));
    });
  }
);
