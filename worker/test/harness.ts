/**
 * In-memory stand-ins for the Cloudflare bindings, so the real handlers can run
 * under vitest against a real chain.
 *
 * The Durable Objects here run the SAME logic as `src/durable.ts` — including
 * the single-threaded serialization that makes the nonce sequencer work — so
 * the concurrency tests exercise the real behaviour, not a mock of it.
 */

import { createPublicClient, http, defineChain, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEFAULT_LIMITS, type Env } from "../src/config";
import { ENTRYPOINT_ABI, LINK_ROUTER_ABI } from "../src/config";
import { createLinkWallet } from "../src/linkWallet";
import { predictAccount } from "../src/aa";
import { localBundler } from "./localBundler";

export interface Addresses {
  rpcUrl: string;
  chainId: number;
  integrator: string;
  diamond: string;
  client: string;
  usdc: string;
  merchant: string;
  relayer: string;
  relayerKey: string;
  settlementPeriod: number;
  // ─── The relayer-free path ───
  router: string;
  entryPoint: string;
  accountFactory: string;
  /** Accounts that also implement ERC-1271, as hosted accounts do. */
  account1271Factory: string;
  paymaster: string;
  sponsorKey: string;
  bundlerKey: string;
}

function memoryKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    list: async (opts?: { prefix?: string; limit?: number }) => {
      const prefix = opts?.prefix ?? "";
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .slice(0, opts?.limit ?? 1000)
        .map((name) => ({ name }));
      return { keys, list_complete: true, cacheStatus: null } as never;
    },
  } as unknown as KVNamespace;
}

/**
 * A Durable Object namespace where each named instance runs its handler under a
 * per-instance promise chain — the same one-request-at-a-time guarantee the
 * real platform provides, which is exactly what the nonce logic depends on.
 */
function memoryDO(
  handler: (
    state: Map<string, unknown>,
    path: string,
    ctx: Ctx,
    body: Record<string, unknown>
  ) => Promise<unknown>,
  ctx: Ctx
): DurableObjectNamespace {
  const states = new Map<string, Map<string, unknown>>();
  const queues = new Map<string, Promise<unknown>>();

  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (id: DurableObjectId) => {
      const name = String(id);
      if (!states.has(name)) states.set(name, new Map());
      return {
        fetch: async (input: string, init?: { body?: string }) => {
          const path = new URL(input).pathname;
          let body: Record<string, unknown> = {};
          if (init?.body) {
            try {
              body = JSON.parse(init.body);
            } catch {
              body = {};
            }
          }
          const prev = queues.get(name) ?? Promise.resolve();
          const next = prev
            .catch(() => undefined)
            .then(() => handler(states.get(name)!, path, ctx, body));
          queues.set(name, next);
          const result = await next;
          return new Response(JSON.stringify(result), {
            headers: { "Content-Type": "application/json" },
          });
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

interface Ctx {
  rpcUrl: string;
  chainId: number;
  relayer: Address;
  /** Wei ceilings, so the stubbed GasBudget enforces the same numbers as prod. */
  maxGasWeiPerTx: bigint;
  maxGasWeiPerDay: bigint;
}

/** Mirrors src/durable.ts NonceManager. */
async function nonceHandler(state: Map<string, unknown>, path: string, ctx: Ctx): Promise<unknown> {
  if (path === "/resync") {
    state.delete("nonce");
    return { ok: true };
  }
  if (path !== "/allocate") return { error: "not found" };

  let next = state.get("nonce") as number | undefined;
  if (next === undefined) {
    const chain = defineChain({
      id: ctx.chainId,
      name: "local",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [ctx.rpcUrl] } },
    });
    const client = createPublicClient({ chain, transport: http(ctx.rpcUrl) });
    next = await client.getTransactionCount({ address: ctx.relayer, blockTag: "pending" });
  }
  state.set("nonce", next + 1);
  return { nonce: next };
}

/** Mirrors src/durable.ts LinkLock. */
/**
 * Mirrors `GasBudget` in src/durable.ts. Serialized per instance by memoryDO,
 * which is the whole point: the ceiling used to be a read-modify-write on KV
 * and was bypassable by concurrency.
 */
async function gasBudgetHandler(
  state: Map<string, unknown>,
  path: string,
  ctx: Ctx,
  body: Record<string, unknown>
): Promise<unknown> {
  const wei = BigInt((body.wei as string) ?? "0");
  const day = (body.day as number) ?? 0;

  const stored = (state.get("budget") as { day: number; spent: string } | undefined) ?? {
    day,
    spent: "0",
  };
  let spent = stored.day === day ? BigInt(stored.spent) : 0n;

  if (path === "/reserve") {
    if (wei > ctx.maxGasWeiPerTx) return { ok: false, reason: "perTx" };
    if (spent + wei > ctx.maxGasWeiPerDay) return { ok: false, reason: "perDay" };
    spent += wei;
    state.set("budget", { day, spent: spent.toString() });
    return { ok: true, spent: spent.toString() };
  }
  if (path === "/release") {
    spent = spent > wei ? spent - wei : 0n;
    state.set("budget", { day, spent: spent.toString() });
    return { ok: true, spent: spent.toString() };
  }
  if (path === "/read") return { spent: spent.toString(), day };
  return { error: "not found" };
}

async function lockHandler(state: Map<string, unknown>, path: string): Promise<unknown> {
  const HOLD_MS = 60_000;
  if (path === "/acquire") {
    const until = (state.get("until") as number | undefined) ?? 0;
    const now = Date.now();
    if (now < until) return { ok: false, retryInMs: until - now };
    state.set("until", now + HOLD_MS);
    return { ok: true };
  }
  if (path === "/release") {
    state.delete("until");
    return { ok: true };
  }
  return { error: "not found" };
}

export interface EnvOverrides {
  maxGasWeiPerTx?: bigint;
  maxGasWeiPerDay?: bigint;
}

export function makeTestEnv(a: Addresses, overrides: EnvOverrides = {}): Env {
  const relayer = privateKeyToAccount(a.relayerKey as `0x${string}`).address;
  const ctx: Ctx = {
    rpcUrl: a.rpcUrl,
    chainId: a.chainId,
    relayer,
    // A local node prices gas far above Base, and this suite makes dozens of
    // real payments. Bound generously by default so the ceiling under test is
    // the contract's, not the operator's daily spend cap. Pass an override to
    // exercise the ceiling itself.
    maxGasWeiPerTx: overrides.maxGasWeiPerTx ?? DEFAULT_LIMITS.maxGasWeiPerTx * 1000n,
    maxGasWeiPerDay: overrides.maxGasWeiPerDay ?? DEFAULT_LIMITS.maxGasWeiPerDay * 1000n,
  };

  return {
    // Kept only for the keeper duty (deliverFiatPayout), which is unrelated to
    // links and predates this feature. Nothing on the payment path uses it any
    // more: the sender is the link's own account, which holds nothing.
    RELAYER_PRIVATE_KEY: a.relayerKey,
    WEBHOOK_SIGNING_KEY: "test-signing-key",
    RPC_URL: a.rpcUrl,
    CHAIN_ID: String(a.chainId),
    INTEGRATOR_ADDRESS: a.integrator,
    DIAMOND_ADDRESS: a.diamond,
    CLIENT_ADDRESS: a.client,
    ALLOWED_ORIGINS: "",

    // ─── The relayer-free path ───
    LINK_ROUTER_ADDRESS: a.router,
    ENTRYPOINT_ADDRESS: a.entryPoint,
    ACCOUNT_FACTORY_ADDRESS: a.accountFactory,
    // The local fixture is the ERC-4337 REFERENCE factory, whose getAddress
    // takes a uint256 salt. Production uses thirdweb's, which takes bytes.
    // Stating it explicitly is the point: the two have different selectors, so
    // a default that guessed would pass here and fail live.
    ACCOUNT_FACTORY_KIND: "simple",
    // Only these two differ from production. Everything in `src/` runs
    // unchanged, so a packing or receipt-reading mistake fails here exactly the
    // way it would fail live.
    BUNDLER_URL: "http://local-bundler/rpc",
    PAYMASTER_URL: "http://local-bundler/rpc",
    LINK_KEY_MASTER: Buffer.from(new Uint8Array(32).fill(11)).toString("base64"),
    MAX_SPONSORED_OPS_PER_LINK: "50",
    // The verifier fails CLOSED without this, which is the point of it — see
    // sponsor.ts. A deploy without it has no per-link ceiling at all.
    SPONSOR_VERIFIER_SECRET: "test-sponsor-secret",

    KV: memoryKV(),
    LINK_LOCK: memoryDO((s, p) => lockHandler(s, p), ctx),
    NONCE: memoryDO(nonceHandler, ctx),
    GAS_BUDGET: memoryDO(gasBudgetHandler, ctx),
  } as unknown as Env;
}

/**
 * Points `fetch` at a local bundler and paymaster for the duration of a suite.
 *
 * The worker talks to them over the same JSON-RPC it uses in production, so
 * this substitutes the SERVICE, never our code. Anything else — the chain RPC
 * included — passes straight through.
 */
export function useLocalBundler(a: Addresses) {
  const original = globalThis.fetch;
  const bundler = localBundler({
    rpcUrl: a.rpcUrl,
    chainId: a.chainId,
    entryPoint: a.entryPoint,
    paymaster: a.paymaster,
    sponsorKey: a.sponsorKey,
    bundlerKey: a.bundlerKey,
    entryPointAbi: ENTRYPOINT_WITH_HANDLE_OPS,
  });
  globalThis.fetch = ((url: any, init: any) =>
    String(url).includes("local-bundler")
      ? bundler(String(url), init)
      : (original as any)(url, init)) as typeof fetch;
  return { bundler, restore: () => void (globalThis.fetch = original) };
}

/** The EntryPoint ABI plus `handleOps`, which only a bundler needs. */
export const ENTRYPOINT_WITH_HANDLE_OPS = [
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
] as const;

/**
 * Creates a link's account and binds it to the link on the Router.
 *
 * This is the merchant app's job in production, batched into the same operation
 * that creates the link. A link without it looks correctly created and can
 * never be paid, so every test that creates a link must do this too.
 */
export async function registerLinkAgent(
  env: Env,
  linkId: string,
  merchantWallet: any,
  routerAddress: string
): Promise<string> {
  const account = await createLinkWallet(env, linkId, 3600, (owner) => predictAccount(env, owner));
  await merchantWallet.writeContract({
    address: routerAddress as `0x${string}`,
    abi: LINK_ROUTER_ABI,
    functionName: "registerAgent",
    args: [linkId as `0x${string}`, account],
  });
  return account;
}

async function rpc(url: string, method: string, params: unknown[]): Promise<void> {
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

export const increaseTime = (url: string, seconds: number) =>
  rpc(url, "evm_increaseTime", [seconds]).then(() => rpc(url, "evm_mine", []));

export const mineBlocks = (url: string, n: number) =>
  Promise.all(Array.from({ length: n }, () => rpc(url, "evm_mine", []))).then(() => undefined);

/**
 * The customer's browser keypair.
 *
 * A REAL key, not a placeholder. The suites used a made-up `04ab…` pubkey,
 * which was fine while the customer's key only received encrypted payment
 * details. It is not fine now: the same key must sign "I have paid", and the
 * Router checks that signature against the address derived from this very
 * pubkey. A fake one cannot sign, and pretending otherwise would test a path
 * no real customer takes.
 */
export const CUSTOMER_KEY =
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" as `0x${string}`;

export const customerAccount = privateKeyToAccount(CUSTOMER_KEY);

/** The uncompressed public key, in the `04…` form the pay endpoint expects. */
export const CUSTOMER_PUBKEY = customerAccount.publicKey.slice(2);

/**
 * The customer signing over one action and one order.
 *
 * EIP-712, with the domain bound to this chain and this Router — so a signature
 * cannot be replayed on another chain or against another deployment, and a
 * cancel authorisation cannot be reused as a payment.
 */
export function signRelayAction(
  a: Addresses,
  action: "MarkPaid" | "Cancel",
  linkId: string,
  orderId: bigint
): Promise<`0x${string}`> {
  return customerAccount.signTypedData({
    domain: {
      name: "P2P LinkRouter",
      version: "1",
      chainId: a.chainId,
      verifyingContract: a.router as `0x${string}`,
    },
    types: {
      [action]: [
        { name: "linkId", type: "bytes32" },
        { name: "orderId", type: "uint256" },
      ],
    },
    primaryType: action,
    message: { linkId: linkId as `0x${string}`, orderId },
  });
}
