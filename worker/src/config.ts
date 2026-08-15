/**
 * Environment, ABIs, and the tunable limits.
 *
 * Everything financial is read from the CHAIN, never from a request body or
 * from KV — see `readLink` in `chain.ts`. What lives here is only the wiring
 * (addresses, RPC) and the operational ceilings.
 */

export interface Env {
  // ─── Secrets (wrangler secret put) ──────────────────────────────
  /** The relayer EOA's key. Its ONLY on-chain power is relayerPlaceOrder. */
  RELAYER_PRIVATE_KEY: string;
  /** HMAC key for outbound webhook signatures. */
  WEBHOOK_SIGNING_KEY: string;

  // ─── Vars (wrangler.toml) ───────────────────────────────────────
  RPC_URL: string;
  CHAIN_ID: string;
  INTEGRATOR_ADDRESS: string;
  DIAMOND_ADDRESS: string;
  /** The checkout client the widget prices against. Pinned, not caller-supplied. */
  CLIENT_ADDRESS: string;
  /** The productId the client prices a single unit at. Defaults to 1. */
  PRODUCT_ID?: string;
  /** Optional: comma-separated origins allowed to call the pay endpoint. */
  ALLOWED_ORIGINS?: string;

  // ─── Operational limits (all optional; see DEFAULT_LIMITS) ──────
  //
  // These are the knobs an operator reaches for at 3am — a spam wave, a gas
  // spike, an RPC that went slow. Baking them into the bundle would mean a
  // redeploy to turn one down, so every one can be overridden by a var while
  // still having a sane default that needs no configuration at all.
  RATE_IP_PER_MINUTE?: string;
  RATE_LINK_PER_HOUR?: string;
  MAX_GAS_PER_TX?: string;
  MAX_GAS_PER_DAY?: string;
  LOW_BALANCE_WEI?: string;
  RECEIPT_TIMEOUT_MS?: string;
  /** Head-room multiplier on the gas estimate, as a percentage. 120 = +20%. */
  GAS_BUFFER_PCT?: string;
  /** Blocks scanned per scheduled run when looking for completions. */
  LOG_SCAN_BLOCKS?: string;
  /** Webhook deliveries attempted per scheduled run. */
  WEBHOOK_BATCH?: string;
  /** Seconds a single-use link is held while a payment is in flight. */
  LINK_LOCK_SECONDS?: string;

  // ─── Bindings ───────────────────────────────────────────────────
  KV: KVNamespace;
  LINK_LOCK: DurableObjectNamespace;
  NONCE: DurableObjectNamespace;
}

/**
 * Operational ceilings. These bound COST and BLAST RADIUS, not correctness —
 * correctness is enforced on-chain. A breach here means we stop early and
 * cheaply rather than discovering the problem from a drained gas balance.
 *
 * Every value is overridable per environment (see `Env` above). The defaults
 * below are what ships if nothing is set, and are sized from the contract's
 * own measured gas report rather than guessed.
 */
export const DEFAULT_LIMITS = {
  /** Per-IP pay attempts. */
  ipPerMinute: 10,
  /** Per-link pay attempts — a public link is a public endpoint. */
  linkPerHour: 20,
  /**
   * Hard gas ceiling for one relayerPlaceOrder. Measured avg is ~348k and max
   * ~398k; anything materially above that is an anomaly, not a busy block.
   */
  maxGasPerTx: 600_000n,
  /** Total gas across all payments in a UTC day. ~1,400 payments at 600k. */
  maxGasPerDay: 840_000_000n,
  /** Warn while there is still time to act, not once the float is gone. */
  lowBalanceWei: 15_000_000_000_000_000n, // 0.015 ETH
  /** How long to wait for a receipt before telling the customer to retry. */
  receiptTimeoutMs: 45_000,
  /** Head-room over the gas estimate, as a percentage of it. */
  gasBufferPct: 120n,
  /** Blocks per scheduled log scan — small enough to finish inside the tick. */
  logScanBlocks: 800n,
  /** Webhook deliveries per scheduled run. */
  webhookBatch: 50,
  /** How long one link is held while a payment is in flight. */
  linkLockSeconds: 60,
} as const;

/**
 * The resolved shape. `DEFAULT_LIMITS` is `as const`, so its members are
 * literal types — widened here to plain number/bigint, since the whole point
 * is that an operator can set something else.
 */
export type Limits = {
  [K in keyof typeof DEFAULT_LIMITS]: (typeof DEFAULT_LIMITS)[K] extends bigint ? bigint : number;
};

/** Parses a positive number from a var, falling back on anything unusable. */
function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Same, for the bigint-valued knobs (gas and wei). */
function big(raw: string | undefined, fallback: bigint): bigint {
  if (raw === undefined) return fallback;
  try {
    const n = BigInt(raw);
    return n > 0n ? n : fallback;
  } catch {
    return fallback; // a typo must not disable a ceiling
  }
}

/**
 * Resolves the live limits for this environment.
 *
 * A malformed value falls back to the default rather than throwing or
 * disabling the ceiling — a fat-fingered var should never be the reason a
 * spend cap stops applying.
 */
export function limitsFor(env: Env): Limits {
  const d = DEFAULT_LIMITS;
  return {
    ipPerMinute: num(env.RATE_IP_PER_MINUTE, d.ipPerMinute),
    linkPerHour: num(env.RATE_LINK_PER_HOUR, d.linkPerHour),
    maxGasPerTx: big(env.MAX_GAS_PER_TX, d.maxGasPerTx),
    maxGasPerDay: big(env.MAX_GAS_PER_DAY, d.maxGasPerDay),
    lowBalanceWei: big(env.LOW_BALANCE_WEI, d.lowBalanceWei),
    receiptTimeoutMs: num(env.RECEIPT_TIMEOUT_MS, d.receiptTimeoutMs),
    gasBufferPct: big(env.GAS_BUFFER_PCT, d.gasBufferPct),
    logScanBlocks: big(env.LOG_SCAN_BLOCKS, d.logScanBlocks),
    webhookBatch: num(env.WEBHOOK_BATCH, d.webhookBatch),
    linkLockSeconds: num(env.LINK_LOCK_SECONDS, d.linkLockSeconds),
  };
}

/** The productId the pinned checkout client prices a single unit at. */
export function productIdFor(env: Env): bigint {
  return big(env.PRODUCT_ID, 1n);
}

/** Only what the Worker actually calls. A narrow ABI is a narrow blast radius. */
export const INTEGRATOR_ABI = [
  {
    type: "function",
    name: "getLink",
    stateMutability: "view",
    inputs: [{ name: "linkId", type: "bytes32" }],
    outputs: [
      { name: "owner", type: "address" },
      { name: "amount", type: "uint96" },
      { name: "currency", type: "bytes32" },
      { name: "expiresAt", type: "uint64" },
      { name: "singleUse", type: "bool" },
      { name: "status", type: "uint8" },
      { name: "uses", type: "uint32" },
    ],
  },
  {
    type: "function",
    name: "isLinkActive",
    stateMutability: "view",
    inputs: [{ name: "linkId", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "relayerPlaceOrder",
    stateMutability: "nonpayable",
    inputs: [
      { name: "linkId", type: "bytes32" },
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
    name: "orderToMerchant",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "perTxCap",
    stateMutability: "view",
    inputs: [{ name: "currency", type: "bytes32" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "event",
    name: "LinkOrderPlaced",
    inputs: [
      { name: "linkId", type: "bytes32", indexed: true },
      { name: "orderId", type: "uint256", indexed: true },
      { name: "merchant", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "OrderCompleted",
    inputs: [
      { name: "orderId", type: "uint256", indexed: true },
      { name: "merchant", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "unlockAt", type: "uint256", indexed: false },
    ],
  },
] as const;

/**
 * The widget's own signer calls.
 *
 * `<Checkout>` does not route everything through the `placeOrder` callback: for
 * some in-flow actions it calls `signer.sendTransaction` DIRECTLY. A walletless
 * customer has no signer, so the pay page forwards those here — and only those.
 *
 * Verified against the shipped @p2pdotme/widgets 1.7.1 bundle, which makes
 * exactly three such calls:
 *   • cancelOrder(uint256)   → diamondAddress      ✅ forwarded
 *   • paidBuyOrder(uint256)  → diamondAddress      ✅ forwarded
 *   • submitLivenessAttestation(...) → integrator  ❌ NOT forwarded
 *
 * The third only fires when the host passes a `liveness` config prop. The pay
 * page does not pass one, so it is unreachable in this flow — and it must stay
 * off the allowlist regardless, because it targets our own integrator.
 */
export const RELAY_SELECTORS: Record<string, string> = {
  "0x514fcac7": "cancelOrder(uint256)",
  "0x1e31508e": "paidBuyOrder(uint256)",
};

/**
 * Never forwardable, listed so the intent is explicit rather than implied by
 * absence. `submitLivenessAttestation` targets our own integrator; the other
 * two are the shapes an attacker would most want to smuggle through a relay.
 */
export const FORBIDDEN_SELECTORS: Record<string, string> = {
  "0x2bd54ab8": "submitLivenessAttestation(bytes32,uint256,uint256,bytes)",
  "0xf010221f": "relayerPlaceOrder(...)",
  "0xdb81f99b": "withdrawUSDC(uint256)",
};

export const ORDER_ID_ABI = [
  {
    type: "function",
    name: "cancelOrder",
    stateMutability: "nonpayable",
    inputs: [{ name: "orderId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "paidBuyOrder",
    stateMutability: "nonpayable",
    inputs: [{ name: "orderId", type: "uint256" }],
    outputs: [],
  },
] as const;
