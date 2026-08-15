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
import type { Env } from "../src/config";

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
  handler: (state: Map<string, unknown>, path: string, ctx: Ctx) => Promise<unknown>,
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
        fetch: async (input: string) => {
          const path = new URL(input).pathname;
          const prev = queues.get(name) ?? Promise.resolve();
          const next = prev
            .catch(() => undefined)
            .then(() => handler(states.get(name)!, path, ctx));
          queues.set(name, next);
          const body = await next;
          return new Response(JSON.stringify(body), {
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

export function makeTestEnv(a: Addresses): Env {
  const relayer = privateKeyToAccount(a.relayerKey as `0x${string}`).address;
  const ctx: Ctx = { rpcUrl: a.rpcUrl, chainId: a.chainId, relayer };

  return {
    RELAYER_PRIVATE_KEY: a.relayerKey,
    WEBHOOK_SIGNING_KEY: "test-signing-key",
    RPC_URL: a.rpcUrl,
    CHAIN_ID: String(a.chainId),
    INTEGRATOR_ADDRESS: a.integrator,
    DIAMOND_ADDRESS: a.diamond,
    CLIENT_ADDRESS: a.client,
    ALLOWED_ORIGINS: "",
    KV: memoryKV(),
    LINK_LOCK: memoryDO((s, p) => lockHandler(s, p), ctx),
    NONCE: memoryDO(nonceHandler, ctx),
  };
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
