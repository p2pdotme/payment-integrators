import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { requireFixture } from "./fixture";
import { webcrypto } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  toHex,
  encodeFunctionData,
  parseUnits,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { localBundler } from "./localBundler";
import { createLinkWallet, linkWalletAddress, linkSigner, keyTtlFor } from "../src/linkWallet";
import { placeOrder, markPaid, cancelOrder } from "../src/linkOps";
import { predictAccount } from "../src/aa";
import { handleSponsorCheck } from "../src/sponsor";
import { scanAndQueue, deliverQueued } from "../src/webhooks";
import { ENTRYPOINT_ABI, LINK_ROUTER_ABI, INTEGRATOR_ABI, type Env } from "../src/config";

/**
 * The relayer-free payment path, end to end, through the WORKER's real code.
 *
 * WHAT MAKES THIS DIFFERENT FROM test/LinkRouter*.ts
 * The contract suites prove the Router's rules and prove that a sponsored
 * operation works. What they do not touch is the part the worker actually owns
 * now: packing a user operation the way the EntryPoint hashes it, folding
 * factory and paymaster fields into `initCode` and `paymasterAndData`, deciding
 * whether an account needs deploying, and reading the outcome back. Every one
 * of those is silent when wrong.
 *
 * So nothing in `src/` is stubbed here. `linkOps` → `aa` → JSON-RPC runs
 * exactly as it will in production; only `BUNDLER_URL` and `PAYMASTER_URL`
 * point at a local stand-in instead of a hosted one. If the packing is wrong,
 * these tests fail the same way production would.
 *
 * Requires `npx hardhat node` and `scripts/e2e-setup.js`.
 */

if (!(globalThis as any).crypto) (globalThis as any).crypto = webcrypto;

// The URL object is passed straight to existsSync/readFileSync, which both
// accept one. Converting to a string with `.pathname` and stripping the
// leading slash is a Windows drive-letter fix that BREAKS POSIX: it leaves
// "/D:/..." absolute but turns "/home/..." into a relative path resolved
// against cwd. The result was always false on Linux, so these suites ran on
// a developer machine and silently skipped in CI.
const ADDR_FILE = new URL("./e2e-addresses.json", import.meta.url);
const have = requireFixture(ADDR_FILE, "e2e-router");
const d = describe.skipIf(!have);

let A: any;
if (have) A = JSON.parse(readFileSync(ADDR_FILE, "utf8"));

const USDC = (n: number) => parseUnits(n.toString(), 6);
// Product 1 is priced at one 6-decimal unit by e2e-setup, so a quantity of 1
// totals exactly this. A fixed-amount link must match EXACTLY or consume()
// reverts LinkAmountMismatch.
const UNIT_PRICE = USDC(1);
const INR = toHex("INR", { size: 32 }) as Hex;
const PK = "04" + "ab".repeat(64);
const CONFIG = "0x636667" as Hex; // "cfg"

/**
 * Merchant-side calls.
 *
 * Deliberately NOT added to the worker's INTEGRATOR_ABI: the worker never
 * creates a link and never reads a merchant's balance. Keeping them out is
 * what makes the worker's ABI a statement of its reach rather than a
 * convenience bag.
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

d("payment links without a relayer wallet — worker, end to end", () => {
  let chain: any;
  let pub: any;
  let merchantWallet: any;
  let env: Env;
  let store: Map<string, string>;
  let bundler: ReturnType<typeof localBundler>;
  let customer: ReturnType<typeof privateKeyToAccount>;
  let LINK: Hex;

  const linkIdFor = (salt: string) => keccak256(toBytes(`${A.merchant}:${salt}`)) as Hex;

  function fakeEnv(): Env {
    store = new Map<string, string>();
    return {
      CHAIN_ID: String(A.chainId),
      // Deliveries are HMAC-signed, and `sign` throws without a key — which the
      // per-delivery catch would turn into a failed attempt rather than a
      // configuration error.
      WEBHOOK_SIGNING_KEY: "test-webhook-signing-key",
      RPC_URL: A.rpcUrl,
      INTEGRATOR_ADDRESS: A.integrator,
      DIAMOND_ADDRESS: A.diamond,
      CLIENT_ADDRESS: A.client,
      LINK_ROUTER_ADDRESS: A.router,
      ENTRYPOINT_ADDRESS: A.entryPoint,
      ACCOUNT_FACTORY_ADDRESS: A.accountFactory,
      // The local fixture is the reference factory (uint256 salt), not
      // thirdweb's (bytes). Different selectors, so this must be explicit.
      ACCOUNT_FACTORY_KIND: "simple",
      // Same worker code; only these two differ from production.
      BUNDLER_URL: "http://local-bundler/rpc",
      PAYMASTER_URL: "http://local-bundler/rpc",
      LINK_KEY_MASTER: Buffer.from(new Uint8Array(32).fill(5)).toString("base64"),
      MAX_SPONSORED_OPS_PER_LINK: "20",
      // The verifier fails CLOSED without this — see sponsor.ts.
      SPONSOR_VERIFIER_SECRET: "test-sponsor-secret",
      KV: {
        get: async (k: string) => store.get(k) ?? null,
        put: async (k: string, v: string) => void store.set(k, v),
        delete: async (k: string) => void store.delete(k),
        // A real listing: `deliverQueued` walks `hook:q:` keys, so a stub
        // returning nothing means nothing is ever delivered — the queue fills
        // and the test sees silence rather than a failure.
        list: async ({ prefix = "", limit = 1000 }: any = {}) => ({
          keys: [...store.keys()]
            .filter((k) => k.startsWith(prefix))
            .slice(0, limit)
            .map((name) => ({ name })),
          list_complete: true,
        }),
      } as unknown as KVNamespace,
    } as unknown as Env;
  }

  beforeAll(async () => {
    chain = defineChain({
      id: A.chainId,
      name: "local",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [A.rpcUrl] } },
    });
    pub = createPublicClient({ chain, transport: http(A.rpcUrl) });
    merchantWallet = createWalletClient({
      // Hardhat account #1 — the registered merchant.
      account: privateKeyToAccount(
        "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
      ),
      chain,
      transport: http(A.rpcUrl),
    });
    customer = privateKeyToAccount(
      "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"
    );
  });

  beforeEach(async () => {
    env = fakeEnv();
    bundler = localBundler({
      rpcUrl: A.rpcUrl,
      chainId: A.chainId,
      entryPoint: A.entryPoint,
      paymaster: A.paymaster,
      sponsorKey: A.sponsorKey,
      bundlerKey: A.bundlerKey,
      entryPointAbi: [
        ...ENTRYPOINT_ABI,
        {
          type: "function",
          name: "handleOps",
          stateMutability: "nonpayable",
          inputs: [
            {
              name: "ops",
              type: "tuple[]",
              components: [
                { name: "sender", type: "address" },
                { name: "nonce", type: "uint256" },
                { name: "initCode", type: "bytes" },
                { name: "callData", type: "bytes" },
                { name: "accountGasLimits", type: "bytes32" },
                { name: "preVerificationGas", type: "uint256" },
                { name: "gasFees", type: "bytes32" },
                { name: "paymasterAndData", type: "bytes" },
                { name: "signature", type: "bytes" },
              ],
            },
            { name: "beneficiary", type: "address" },
          ],
          outputs: [],
        },
      ],
    });
    (globalThis as any).fetch = ((url: any, init: any) =>
      String(url).includes("local-bundler")
        ? bundler(String(url), init)
        : (fetchOriginal as any)(url, init)) as typeof fetch;

    LINK = linkIdFor("e2e-" + Date.now() + "-" + Math.random());
  });

  const fetchOriginal = globalThis.fetch;

  /** Creates a link on-chain and its wallet, exactly as the merchant app will:
   *  one key, its account address predicted, then registered on the Router. */
  async function setupLink(maxUses = 3, expiresAt = 0n) {
    await merchantWallet.writeContract({
      address: A.integrator as Address,
      abi: MERCHANT_ABI,
      functionName: "createLink",
      args: [LINK, UNIT_PRICE, INR, expiresAt, maxUses, CONFIG],
    });

    const account = await createLinkWallet(env, LINK, keyTtlFor(expiresAt), (owner) =>
      predictAccount(env, owner)
    );

    await merchantWallet.writeContract({
      address: A.router as Address,
      abi: LINK_ROUTER_ABI,
      functionName: "registerAgent",
      args: [LINK, account],
    });
    return account as Address;
  }

  const place = (customerAddr: Address = customer.address) =>
    placeOrder(env, LINK, {
      client: A.client as Address,
      productId: 1n,
      quantity: 1n,
      currency: INR,
      circleId: 0n,
      pubKey: PK,
      customer: customerAddr,
    });

  async function lastOrderId(): Promise<bigint> {
    const logs = await pub.getContractEvents({
      address: A.router as Address,
      abi: LINK_ROUTER_ABI,
      eventName: "OrderPlaced",
      fromBlock: 0n,
    });
    return (logs[logs.length - 1] as any).args.orderId as bigint;
  }

  const signAction = (action: "MarkPaid" | "Cancel", orderId: bigint, who = customer) =>
    who.signTypedData({
      domain: {
        name: "P2P LinkRouter",
        version: "1",
        chainId: A.chainId,
        verifyingContract: A.router as Address,
      },
      types: {
        [action]: [
          { name: "linkId", type: "bytes32" },
          { name: "orderId", type: "uint256" },
        ],
      },
      primaryType: action,
      message: { linkId: LINK, orderId },
    });

  // ─── The path ─────────────────────────────────────────────────────

  it("places an order with no funded key anywhere in the worker", async () => {
    const account = await setupLink();

    // The account does not exist yet — the address was only computed.
    expect(await pub.getCode({ address: account })).toBeUndefined();
    expect(await pub.getBalance({ address: account })).toBe(0n);

    const r = await place();
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);

    // Deployed lazily by the very operation that used it.
    expect(await pub.getCode({ address: account })).not.toBeUndefined();
    // The claim the design rests on, asserted through the real worker path.
    expect(await pub.getBalance({ address: account })).toBe(0n);
  });

  it("marks paid with the customer's signature, and the merchant is credited", async () => {
    await setupLink();
    await place();
    const orderId = await lastOrderId();

    // An LP takes the order; nothing can reach PAID before that.
    const lp = createWalletClient({
      account: privateKeyToAccount(
        "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"
      ),
      chain,
      transport: http(A.rpcUrl),
    });
    await pub.waitForTransactionReceipt({
      hash: await lp.writeContract({
        address: A.diamond as Address,
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
      }),
    });

    const before = (await pub.readContract({
      address: A.integrator as Address,
      abi: MERCHANT_ABI,
      functionName: "getMerchantBalance",
      args: [A.merchant as Address],
    })) as any[];

    const r = await markPaid(env, LINK, orderId, (await signAction("MarkPaid", orderId)) as Hex);
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);

    await pub.waitForTransactionReceipt({
      hash: await lp.writeContract({
        address: A.diamond as Address,
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
        args: [orderId],
        // An EXPLICIT limit, because estimation cannot be trusted here: MockDiamond
        // CATCHES a failing onOrderComplete, so `eth_estimateGas` binary-searches
        // to the smallest gas that makes the TRANSACTION succeed — which is the
        // amount where the callback is skipped. The order then reads as completed
        // while the USDC sits stranded on the proxy and the merchant is never
        // credited. Estimating gas for any call whose inner failure is swallowed
        // has this hazard.
        gas: 3_000_000n,
      }),
    });

    const after = (await pub.readContract({
      address: A.integrator as Address,
      abi: MERCHANT_ABI,
      functionName: "getMerchantBalance",
      args: [A.merchant as Address],
    })) as any[];
    expect(after[2] - before[2]).toBe(UNIT_PRICE);
  });

  it("cancels with the customer's signature, giving the link's use back", async () => {
    await setupLink();
    await place();
    const orderId = await lastOrderId();

    const usesBefore = (await pub.readContract({
      address: A.integrator as Address,
      abi: INTEGRATOR_ABI,
      functionName: "getLink",
      args: [LINK],
    })) as any[];

    const r = await cancelOrder(env, LINK, orderId, (await signAction("Cancel", orderId)) as Hex);
    expect(r.ok).toBe(true);

    const usesAfter = (await pub.readContract({
      address: A.integrator as Address,
      abi: INTEGRATOR_ABI,
      functionName: "getLink",
      args: [LINK],
    })) as any[];
    expect(usesAfter[6]).toBe(usesBefore[6] - 1);
  });

  it("runs a second payment on the same link without redeploying the account", async () => {
    const account = await setupLink(3);
    await place();
    const code = await pub.getCode({ address: account });

    // The second operation must NOT carry the factory call again — doing so
    // fails as "sender already constructed", which points nowhere near the
    // cause. `deployArgs` decides this from on-chain code, not from a flag we
    // could forget to clear.
    const r = await place();
    expect(r.ok).toBe(true);
    expect(await pub.getCode({ address: account })).toBe(code);
  });

  // ─── Failures the worker must report honestly ─────────────────────

  it("reports a REFUSED operation as failure, not as a completed payment", async () => {
    await setupLink();
    await place();
    const orderId = await lastOrderId();

    // A signature from the wrong key. The Router rejects it — but handleOps
    // still succeeds, so the only thing that says so is UserOperationEvent.
    // Treating the bundler hash as confirmation here would tell a customer
    // their payment went through.
    const wrong = privateKeyToAccount(
      "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"
    );
    const r = await markPaid(
      env,
      LINK,
      orderId,
      (await signAction("MarkPaid", orderId, wrong)) as Hex
    );

    expect(r.ok).toBe(false);
    expect(r.userOpHash).toBeDefined(); // it WAS submitted and mined
    expect(r.error).toBeTruthy();
  });

  it("reports a sponsorship refusal plainly, without retrying into the ground", async () => {
    await setupLink();
    (bundler as any).refuseNext = true;

    const r = await place();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("limit");
    // Nothing was submitted, so the link's use was never consumed.
    const link = (await pub.readContract({
      address: A.integrator as Address,
      abi: INTEGRATOR_ABI,
      functionName: "getLink",
      args: [LINK],
    })) as any[];
    expect(link[6]).toBe(0);
  });

  it("refuses to drive a link whose key has been destroyed", async () => {
    await setupLink();
    store.delete(`linkkey:${LINK.toLowerCase()}`);

    const r = await place();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no longer active");
  });

  // ─── Compromise, through the real worker ──────────────────────────

  it("a compromised worker can place but cannot settle", async () => {
    await setupLink();
    await place();
    const orderId = await lastOrderId();

    // The attacker has everything this worker holds — every link key and the
    // master secret. What they do not have is the customer's browser key.
    const attacker = privateKeyToAccount(
      "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"
    );
    const paid = await markPaid(
      env,
      LINK,
      orderId,
      (await signAction("MarkPaid", orderId, attacker)) as Hex
    );
    const cancelled = await cancelOrder(
      env,
      LINK,
      orderId,
      (await signAction("Cancel", orderId, attacker)) as Hex
    );

    expect(paid.ok).toBe(false);
    expect(cancelled.ok).toBe(false);
  });

  it("a link's account is the wrong address for any other link", async () => {
    await setupLink();
    const victim = LINK;

    // A second link with its own account.
    const other = linkIdFor("other-" + Date.now());
    await merchantWallet.writeContract({
      address: A.integrator as Address,
      abi: MERCHANT_ABI,
      functionName: "createLink",
      args: [other, UNIT_PRICE, INR, 0n, 1, CONFIG],
    });
    const otherAccount = await createLinkWallet(env, other, 3600, (o) => predictAccount(env, o));
    await merchantWallet.writeContract({
      address: A.router as Address,
      abi: LINK_ROUTER_ABI,
      functionName: "registerAgent",
      args: [other, otherAccount],
    });

    // Drive the OTHER link using the victim link's key by pointing the stored
    // record at it — the shape a leaked key takes.
    store.set(`linkkey:${other.toLowerCase()}`, store.get(`linkkey:${victim.toLowerCase()}`)!);
    // The record is wrapped under the victim's link id, so it will not even
    // decrypt for the other link. Scope holds at two independent layers.
    const r = await placeOrder(env, other, {
      client: A.client as Address,
      productId: 1n,
      quantity: 1n,
      currency: INR,
      circleId: 0n,
      pubKey: PK,
      customer: customer.address,
    });
    expect(r.ok).toBe(false);
  });

  // ─── The sponsorship verifier, on real call data ──────────────────

  it("the verifier attributes a real operation to its link and meters it", async () => {
    await setupLink();

    // Exactly the call data the worker sends — decoded by the verifier the way
    // the sponsorship provider will hand it over.
    const signer = await linkSigner(env, LINK);
    const account = await linkWalletAddress(env, LINK);
    expect(signer).not.toBeNull();
    expect(account).not.toBeNull();

    const res = await handleSponsorCheck(
      new Request("https://w/api/sponsor-check", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // The verifier fails closed without this.
          "X-Sponsor-Secret": "test-sponsor-secret",
        },
        body: JSON.stringify({
          chainId: A.chainId,
          userOp: {
            sender: account,
            // A Router call — linkId first, which is what makes one decode
            // enough to attribute any operation.
            callData: encodeRouterPlace(LINK),
          },
        }),
      }),
      env
    );
    const decision = (await res.json()) as { isAllowed: boolean };
    expect(decision.isAllowed).toBe(true);
  });

  // ─── Webhooks, from real chain logs ───────────────────────────────

  describe("the merchant's callback", () => {
    /**
     * Custom business logic — activation, notifications, a token transfer —
     * hangs off these. So which event fires, and when, is the whole contract.
     *
     * The important distinction is `placed` versus `completed`. Placed means a
     * customer started paying; completed means the LP confirmed real fiat and
     * USDC actually settled. Acting on the first is how a merchant ships goods
     * for a payment that never arrives, so they are deliberately separate
     * events rather than one with a status field.
     *
     * Everything below is driven from REAL logs the chain emitted during a real
     * payment — nothing is synthesised.
     */
    const received: Array<{ event: string; body: any; sig: string | null }> = [];

    /** Captures deliveries without a server, leaving the chain reads real. */
    function captureDeliveries() {
      const original = globalThis.fetch;
      (globalThis as any).fetch = async (url: any, init: any) => {
        const u = String(url);
        if (u.startsWith("https://merchant.test/")) {
          received.push({
            event: init?.headers?.["X-PayQR-Event"] ?? null,
            body: JSON.parse(String(init?.body ?? "{}")),
            sig: init?.headers?.["X-PayQR-Signature"] ?? null,
          });
          return new Response("ok", { status: 200 });
        }
        return (original as any)(url, init);
      };
      return () => void ((globalThis as any).fetch = original);
    }

    async function drain() {
      // Loop on the CURSOR, not on how many were queued. scanAndQueue returns
      // the number queued, so a window containing no matching logs returns 0
      // while blocks still remain — stopping there leaves the events that
      // matter unscanned.
      for (let i = 0; i < 30; i++) {
        await scanAndQueue(env);
        await deliverQueued(env);
        const cursor = BigInt((await env.KV.get("hook:cursor")) ?? "0");
        if (cursor >= (await pub.getBlockNumber())) break;
      }
      // One more pass: the last scan may have queued something it had no turn
      // to deliver.
      await deliverQueued(env);
    }

    it("fires placed, then completed — and they are different events", async () => {
      received.length = 0;
      const restore = captureDeliveries();
      try {
        await setupLink(3);
        // A merchant-level callback, so one registration covers every link.
        await env.KV.put(
          `hook:merchant:${String(A.merchant).toLowerCase()}`,
          "https://merchant.test/hook"
        );
        // Start the cursor here so the scan does not replay the whole chain.
        await env.KV.put("hook:cursor", String(await pub.getBlockNumber()));

        await place();
        const orderId = await lastOrderId();
        await drain();

        const placed = received.find((r) => r.body.event === "payment.placed");
        expect(placed, "no payment.placed delivered").toBeTruthy();
        expect(placed!.body.orderId).toBe(orderId.toString());
        expect(placed!.body.linkId.toLowerCase()).toBe(LINK.toLowerCase());
        // Signed, so the merchant can tell it came from us.
        expect(placed!.sig).toMatch(/^sha256=[0-9a-f]{64}$/);
        // The header a merchant filters on matches the body they verify.
        expect(placed!.event).toBe("payment.placed");

        // No money has moved yet, and nothing says it has.
        expect(received.some((r) => r.body.event === "payment.completed")).toBe(false);

        // Now settle it for real.
        const lp = createWalletClient({
          account: privateKeyToAccount(
            "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"
          ),
          chain,
          transport: http(A.rpcUrl),
        });
        await pub.waitForTransactionReceipt({
          hash: await lp.writeContract({
            address: A.diamond as Address,
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
          }),
        });
        await markPaid(env, LINK, orderId, (await signAction("MarkPaid", orderId)) as Hex);
        await pub.waitForTransactionReceipt({
          hash: await lp.writeContract({
            address: A.diamond as Address,
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
            args: [orderId],
            gas: 3_000_000n,
          }),
        });

        await drain();

        const done = received.find((r) => r.body.event === "payment.completed");
        expect(done, "no payment.completed delivered").toBeTruthy();
        expect(done!.body.orderId).toBe(orderId.toString());
        // Only this one carries the settled amount, because only this one means
        // money moved.
        expect(done!.body.amount).toBeTruthy();
      } finally {
        restore();
      }
    }, 300_000);

    it("fires cancelled, so a builder can release what they held", async () => {
      received.length = 0;
      const restore = captureDeliveries();
      try {
        await setupLink(3);
        await env.KV.put(
          `hook:merchant:${String(A.merchant).toLowerCase()}`,
          "https://merchant.test/hook"
        );
        await env.KV.put("hook:cursor", String(await pub.getBlockNumber()));

        await place();
        const orderId = await lastOrderId();
        await cancelOrder(env, LINK, orderId, (await signAction("Cancel", orderId)) as Hex);
        await drain();

        expect(received.some((r) => r.body.event === "payment.cancelled")).toBe(true);
      } finally {
        restore();
      }
    }, 300_000);

    it("delivers nothing when no callback is registered", async () => {
      received.length = 0;
      const restore = captureDeliveries();
      try {
        await setupLink(1);
        await env.KV.delete(`hook:merchant:${String(A.merchant).toLowerCase()}`);
        await env.KV.put("hook:cursor", String(await pub.getBlockNumber()));

        await place();
        await drain();
        expect(received).toHaveLength(0);
      } finally {
        restore();
      }
    }, 300_000);
  });
});

/** The Router `place` call data, for the verifier test. */
function encodeRouterPlace(linkId: Hex): Hex {
  return encodeFunctionData({
    abi: LINK_ROUTER_ABI,
    functionName: "place",
    args: [
      linkId,
      "0x1111111111111111111111111111111111111111",
      1n,
      1n,
      INR,
      0n,
      PK,
      "0x2222222222222222222222222222222222222222",
    ],
  }) as Hex;
}
