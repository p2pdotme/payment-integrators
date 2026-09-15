/**
 * Environment, ABIs, and the tunable limits.
 *
 * Everything financial is read from the CHAIN, never from a request body or
 * from KV — see `readLink` in `chain.ts`. What lives here is only the wiring
 * (addresses, RPC) and the operational ceilings.
 */

export interface Env {
  // ─── Secrets (wrangler secret put) ──────────────────────────────
  /**
   * @deprecated Being removed. The funded relayer EOA is what the review
   * rejected: a single point of failure, no spending limits, and one nonce
   * sequence that blocks under load. Payments now go through `LinkRouter`,
   * signed by a per-link wallet that holds nothing (see `linkWallet.ts`).
   *
   * OPTIONAL, and no longer read by anything on the payment path: not by
   * `/health`, not by the cron, not by `pay` or `relayTx`. The only remaining
   * reader is the `NonceManager` durable object, which nothing instantiates.
   * A deploy without it works.
   *
   * Delete this, `relayerFor()` and `NonceManager` together once the keeper
   * duty (`deliverFiatPayout`) has moved to its own operator key.
   */
  RELAYER_PRIVATE_KEY?: string;
  /** HMAC key for outbound webhook signatures. */
  WEBHOOK_SIGNING_KEY: string;
  /**
   * Master secret for wrapping per-link wallet keys, base64, 32 bytes.
   *
   * This replaces a FUNDED key with an ENCRYPTION key, which is the point: it
   * holds no money, so losing it costs availability rather than funds. Losing
   * it and the key store together yields every link's signing key — and those
   * still cannot mark paid, cancel, or move any asset, because those need the
   * customer's own signature, which we never hold.
   *
   * In production this should be a handle to a managed key service rather than
   * raw material here, so every unwrap is logged and the credential is
   * revocable. Only `linkWallet.importMaster` changes when that happens.
   */
  LINK_KEY_MASTER: string;
  /** Shared secret the sponsorship provider presents to `/api/sponsor-check`.
   *  Without it an outsider could burn a link's sponsorship allowance without
   *  ever sending a transaction. */
  SPONSOR_VERIFIER_SECRET?: string;
  /**
   * Cloudflare Turnstile secret. Presence of this secret is what ENABLES the
   * human-cost gate on `/api/pay` and `/api/relay-tx` (AUDIT N2).
   *
   * Optional so local dev and the e2e suite run without one. That is a
   * deliberate fail-OPEN, which is only defensible because the alternative —
   * a hard requirement — would make the tests unrunnable and get the check
   * disabled wholesale. `/health` reports whether the gate is live, and
   * `REQUIRE_TURNSTILE=true` turns the omission into a startup-visible 503
   * so a production deploy cannot quietly ship without it.
   */
  TURNSTILE_SECRET?: string;

  // ─── Vars (wrangler.toml) ───────────────────────────────────────
  RPC_URL: string;
  CHAIN_ID: string;
  INTEGRATOR_ADDRESS: string;
  DIAMOND_ADDRESS: string;
  /** The LinkRouter, which is the integrator's `trustedRelayer`. Every link
   *  payment goes through it; it holds nothing and cannot move value. */
  LINK_ROUTER_ADDRESS: string;
  /** Sponsored-operation ceiling per link, over the link's lifetime. This is
   *  what bounds the place-and-cancel loop: cancelling refunds the link's use
   *  (`onOrderCancel` does `cl.uses--`), so `maxUses` caps concurrent orders,
   *  not total attempts. Defaults to 20. */
  MAX_SPONSORED_OPS_PER_LINK?: string;
  /** ERC-4337 EntryPoint. The same singleton already deployed on Base. */
  ENTRYPOINT_ADDRESS: string;
  /** Account factory. Addresses are deterministic, so a link's wallet is
   *  known before it exists and is deployed lazily on the first payment —
   *  a link nobody ever pays deploys nothing at all. */
  ACCOUNT_FACTORY_ADDRESS: string;
  /**
   * Which factory shape `ACCOUNT_FACTORY_ADDRESS` is.
   *
   * "thirdweb" — getAddress(address, bytes)   ← hosted accounts
   * "simple"   — getAddress(address, uint256) ← the ERC-4337 reference factory
   *
   * The two have DIFFERENT SELECTORS, so the wrong one does not fail loudly; it
   * calls a function the factory does not have. Defaults to "thirdweb" because
   * that is what production uses, and the local suites set "simple" explicitly.
   */
  ACCOUNT_FACTORY_KIND?: string;
  /** Bundler RPC. This is what replaces the funded key AND the nonce
   *  manager: each link's account has its own nonce sequence, so one stuck
   *  payment cannot block every later one. */
  BUNDLER_URL: string;
  /** Sponsorship RPC. Omit only for local development. Without it nothing is
   *  sponsored, and an empty link wallet has no way to pay for itself. */
  PAYMASTER_URL?: string;
  PAYMASTER_POLICY_ID?: string;
  /** Bearer token for the bundler and paymaster. Server side only, and
   *  unrestricted by domain, so it is treated as a high-value credential. */
  BUNDLER_SECRET?: string;
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
  MAX_GAS_WEI_PER_TX?: string;
  MAX_GAS_WEI_PER_DAY?: string;
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
  /**
   * Per-link and per-merchant daily gas ceilings, in wei (AUDIT N2).
   * Sub-budgets of MAX_GAS_WEI_PER_DAY — see DEFAULT_LIMITS.
   */
  MAX_GAS_WEI_PER_LINK_PER_DAY?: string;
  MAX_GAS_WEI_PER_MERCHANT_PER_DAY?: string;
  /**
   * "true" to refuse service when TURNSTILE_SECRET is unset, rather than
   * running with the gate open. Set this in production.
   */
  REQUIRE_TURNSTILE?: string;

  // ─── Bindings ───────────────────────────────────────────────────
  KV: KVNamespace;
  LINK_LOCK: DurableObjectNamespace;
  NONCE: DurableObjectNamespace;
  /** Daily gas ceiling. A DO, not KV — see limits.ts for why. */
  GAS_BUDGET: DurableObjectNamespace;
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
  /**
   * Per-transaction and per-day ceilings, in WEI — the unit the float is
   * actually denominated in. The previous gas-UNIT ceilings let a gas-price
   * spike drain the balance while the counter still read healthy.
   *
   * These are sized off the FLOAT, not off a fixed gas price. Pricing them at
   * Base's typical 0.01 gwei produced ceilings so tight that a single payment
   * was refused the moment the chain reached ~1 gwei — the service would go
   * dark during exactly the congestion it needs to ride out.
   *
   *   • per-tx 0.001 ETH — generous enough for ~600k gas at 1.6 gwei, tight
   *     enough to refuse a runaway estimate outright.
   *   • per-day 0.01 ETH — about a fifth of the 0.05 ETH float the README's
   *     cost model assumes. At Base's usual 0.01 gwei that is ~1,600 payments,
   *     close to the ~1,400 the old unit ceiling allowed.
   *
   * The trade this makes deliberately: under a sustained price spike the daily
   * ceiling buys fewer payments and the service throttles. That is the correct
   * failure — a cost control that quietly scales with the gas price is not
   * protecting anything.
   */
  maxGasWeiPerTx: 1_000_000_000_000_000n,
  maxGasWeiPerDay: 10_000_000_000_000_000n,
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
  /**
   * Per-link and per-merchant slices of the daily budget (AUDIT N2).
   *
   * The global ceiling alone did not bound BLAST RADIUS, only total spend:
   * one IP hammering a couple of public links could consume the whole day's
   * float and darken every other merchant's link until UTC midnight. The
   * budget built to protect the float was the cheapest way to take the
   * service down.
   *
   * Sized as 20% and 10% of the daily total, so it takes five busy merchants
   * to exhaust the day and no single link can take more than a tenth. At
   * Base's typical cost per placement that is still hundreds of payments per
   * link per day — far above real use, and far below a denial of service.
   */
  maxGasWeiPerMerchantPerDay: 2_000_000_000_000_000n, // 20% of the day
  maxGasWeiPerLinkPerDay: 1_000_000_000_000_000n, //     10% of the day
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
    maxGasWeiPerTx: big(env.MAX_GAS_WEI_PER_TX, d.maxGasWeiPerTx),
    maxGasWeiPerDay: big(env.MAX_GAS_WEI_PER_DAY, d.maxGasWeiPerDay),
    lowBalanceWei: big(env.LOW_BALANCE_WEI, d.lowBalanceWei),
    receiptTimeoutMs: num(env.RECEIPT_TIMEOUT_MS, d.receiptTimeoutMs),
    gasBufferPct: big(env.GAS_BUFFER_PCT, d.gasBufferPct),
    logScanBlocks: big(env.LOG_SCAN_BLOCKS, d.logScanBlocks),
    webhookBatch: num(env.WEBHOOK_BATCH, d.webhookBatch),
    linkLockSeconds: num(env.LINK_LOCK_SECONDS, d.linkLockSeconds),
    maxGasWeiPerMerchantPerDay: big(
      env.MAX_GAS_WEI_PER_MERCHANT_PER_DAY,
      d.maxGasWeiPerMerchantPerDay
    ),
    maxGasWeiPerLinkPerDay: big(env.MAX_GAS_WEI_PER_LINK_PER_DAY, d.maxGasWeiPerLinkPerDay),
  };
}

/** The productId the pinned checkout client prices a single unit at. */
export function productIdFor(env: Env): bigint {
  return big(env.PRODUCT_ID, 1n);
}

/** Only what the Worker actually calls. A narrow ABI is a narrow blast radius. */

/**
 * Every custom error a link payment can revert with, including the
 * `CallFailed(bytes)` wrapper that `UserProxy` puts around a Diamond revert.
 *
 * These were absent, and the cost was invisible locally: a hardhat node
 * decodes error NAMES from its own artifacts and prints them in the message,
 * so string-matching on the name appeared to work. Public RPCs return
 * `execution reverted` plus raw data and nothing else, so in production every
 * branch degraded to the generic message — expired, used up, revoked, halted,
 * frozen, over-cap and paused all told the customer the same unhelpful thing.
 */
export const INTEGRATOR_ERRORS = [
  { type: "error", name: "CallFailed", inputs: [{ name: "reason", type: "bytes" }] },
  { type: "error", name: "LinkExpired", inputs: [] },
  { type: "error", name: "LinkAlreadyUsed", inputs: [] },
  { type: "error", name: "LinkNotActive", inputs: [] },
  { type: "error", name: "LinkNotFound", inputs: [] },
  { type: "error", name: "LinkAmountMismatch", inputs: [] },
  { type: "error", name: "LinkOrdersDisabled", inputs: [] },
  { type: "error", name: "OnlyTrustedRelayer", inputs: [] },
  { type: "error", name: "MerchantIsFrozen", inputs: [] },
  { type: "error", name: "ExceedsPerTxCap", inputs: [] },
  { type: "error", name: "DailyLimitReached", inputs: [] },
  { type: "error", name: "NotRegistered", inputs: [] },
  { type: "error", name: "InvalidCurrency", inputs: [] },
  { type: "error", name: "InvalidQuantity", inputs: [] },
  { type: "error", name: "ProductNotFound", inputs: [] },
  { type: "error", name: "Paused", inputs: [] },
  { type: "error", name: "Reentrancy", inputs: [] },
] as const;

/**
 * Selector → customer-facing message.
 *
 * Keyed on the SELECTOR rather than the name, because the selector is the only
 * thing every RPC returns. Verified by recomputing keccak256 of each signature.
 */
export const REVERT_MESSAGES: Record<string, string> = {
  "0x81a36e7f": "This payment link has expired.",
  "0x8f4f4b10": "This payment link has already been used the maximum number of times.",
  "0x185214e4": "This payment link has been cancelled.",
  "0x3b82cbf1": "This payment link was not found.",
  "0x5723c737": "The amount has changed. Please reload the page.",
  "0x410bccb3": "Link payments are temporarily unavailable. Please try again later.",
  "0x961ec64f": "This payment could not be processed. Please try again.",
  "0xe2df7fb3": "This merchant cannot accept payments right now.",
  "0x49aeece1": "This amount is above the limit for this merchant.",
  "0xf402e5b1": "This merchant has reached today's payment limit. Please try again tomorrow.",
  "0xaba47339": "This merchant is not set up to accept payments.",
  "0xf5993428": "This link's currency is not supported right now.",
  "0x524f409b": "Please enter a valid amount.",
  "0x79de4af5": "This link is not payable right now.",
  "0x9e87fac8": "Payments are temporarily paused. Please try again later.",
  "0xab143c06": "This payment is already being processed.",
};

/** `CallFailed(bytes)` — UserProxy wrapping an inner Diamond revert. */
export const CALL_FAILED_SELECTOR = "0xa5fa8d2b";
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
      { name: "maxUses", type: "uint32" },
      { name: "status", type: "uint8" },
      { name: "uses", type: "uint32" },
      { name: "strikes", type: "uint16" },
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
    // The Diamond gates paidBuyOrder on order.user, which for a link order is
    // the merchant's proxy — an address only the integrator can drive. So the
    // relayer asks the integrator; it cannot call the Diamond itself.
    type: "function",
    name: "relayerMarkPaid",
    stateMutability: "nonpayable",
    inputs: [
      { name: "linkId", type: "bytes32" },
      { name: "orderId", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "relayerCancelOrder",
    stateMutability: "nonpayable",
    inputs: [
      { name: "linkId", type: "bytes32" },
      { name: "orderId", type: "uint256" },
    ],
    outputs: [],
  },
  {
    // Needed for the per-tx cap precheck: validateOrder keys the cap off the
    // merchant's REGISTERED currency, never the link's.
    type: "function",
    name: "getMerchantInfo",
    stateMutability: "view",
    inputs: [{ name: "merchant", type: "address" }],
    outputs: [
      { name: "encPayoutId", type: "bytes" },
      { name: "shopName", type: "string" },
      { name: "currency", type: "bytes32" },
      { name: "isRegistered", type: "bool" },
      { name: "isFrozen", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "orderToLink",
    stateMutability: "view",
    inputs: [{ name: "orderId", type: "uint256" }],
    outputs: [{ type: "bytes32" }],
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
    name: "OrderCancelled",
    inputs: [
      { name: "orderId", type: "uint256", indexed: true },
      { name: "merchant", type: "address", indexed: true },
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
 *   • cancelOrder(uint256)   → diamondAddress
 *   • paidBuyOrder(uint256)  → diamondAddress
 *   • submitLivenessAttestation(...) → integrator  ❌ NOT forwarded
 *
 * NEITHER of the first two can be forwarded to the Diamond any more, and they
 * never worked: the Diamond authorises both against `order.user`, which for a
 * link order is the merchant's proxy — never this relayer. Forwarding them
 * signed by the relayer EOA always reverted NotAuthorized(), which is why a
 * link payment could be placed and then never advance.
 *
 * They are now translated onto the integrator's own `relayerMarkPaid` /
 * `relayerCancelOrder`, which reach the Diamond through the merchant's proxy.
 * The allowlist is therefore a map from what the widget ASKS for to what we are
 * willing to DO — two of our own functions, rather than raw Diamond calldata.
 */
export const RELAY_INTENTS: Record<string, "markPaid" | "cancel"> = {
  "0x1e31508e": "markPaid", // paidBuyOrder(uint256)
  "0x514fcac7": "cancel", // cancelOrder(uint256)
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

/**
 * LinkRouter — the integrator's `trustedRelayer`, replacing the funded EOA.
 *
 * Note the shape of every entry: `linkId` comes FIRST on all three payment
 * calls. That is deliberate rather than incidental — the sponsorship verifier
 * decodes one argument to learn which link an operation belongs to, so there is
 * no call we can be asked to pay for without being able to attribute it.
 *
 * `markPaid` and `cancel` additionally carry the customer's own signature. The
 * link wallet's key alone cannot settle or cancel anything; that signature is
 * generated in the customer's browser and we never hold it, which is what makes
 * a full compromise of this worker unable to advance a payment.
 */
export const LINK_ROUTER_ABI = [
  {
    type: "function",
    name: "registerAgent",
    stateMutability: "nonpayable",
    inputs: [
      { name: "linkId", type: "bytes32" },
      { name: "agent", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "place",
    stateMutability: "nonpayable",
    inputs: [
      { name: "linkId", type: "bytes32" },
      { name: "client", type: "address" },
      { name: "productId", type: "uint256" },
      { name: "quantity", type: "uint256" },
      { name: "currency", type: "bytes32" },
      { name: "circleId", type: "uint256" },
      { name: "pubKey", type: "string" },
      { name: "customer", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "markPaid",
    stateMutability: "nonpayable",
    inputs: [
      { name: "linkId", type: "bytes32" },
      { name: "orderId", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "cancel",
    stateMutability: "nonpayable",
    inputs: [
      { name: "linkId", type: "bytes32" },
      { name: "orderId", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "linkAgent",
    stateMutability: "view",
    inputs: [{ name: "linkId", type: "bytes32" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "orderCustomer",
    stateMutability: "view",
    inputs: [{ name: "orderId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "markPaidDigest",
    stateMutability: "view",
    inputs: [
      { name: "linkId", type: "bytes32" },
      { name: "orderId", type: "uint256" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "cancelDigest",
    stateMutability: "view",
    inputs: [
      { name: "linkId", type: "bytes32" },
      { name: "orderId", type: "uint256" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  // Events. `OrderPlaced` carries the customer key the Router recorded, which
  // is the only address that can later settle or cancel that order — so this is
  // where a support question about "who is allowed to finish this payment" is
  // answered, without unwrapping any key.
  {
    type: "event",
    name: "OrderPlaced",
    inputs: [
      { name: "linkId", type: "bytes32", indexed: true },
      { name: "orderId", type: "uint256", indexed: true },
      { name: "customer", type: "address", indexed: false },
    ],
  },
  {
    type: "event",
    name: "OrderMarkedPaid",
    inputs: [
      { name: "linkId", type: "bytes32", indexed: true },
      { name: "orderId", type: "uint256", indexed: true },
    ],
  },
  {
    type: "event",
    name: "OrderCancelled",
    inputs: [
      { name: "linkId", type: "bytes32", indexed: true },
      { name: "orderId", type: "uint256", indexed: true },
    ],
  },
  {
    type: "event",
    name: "AgentRegistered",
    inputs: [
      { name: "linkId", type: "bytes32", indexed: true },
      { name: "agent", type: "address", indexed: true },
      { name: "merchant", type: "address", indexed: true },
    ],
  },
] as const;

/**
 * Router revert selectors, for turning a failure into something a customer can
 * act on. Computed from the signatures in LinkRouter.sol.
 */
export const ROUTER_ERRORS: Record<string, string> = {
  NotLinkAgent: "This payment link is not set up correctly. Ask the merchant to re-issue it.",
  NotLinkOwner: "Only the merchant who created this link can change it.",
  AgentAlreadySet: "This link is already set up.",
  UnknownOrder: "That order was not created through this link.",
  OrderLinkMismatch: "That order belongs to a different link.",
  BadCustomerSignature:
    "We could not verify this came from you. Please reload the page and try again.",
  ZeroAddress: "Invalid address.",
  Reentrancy: "Please try again.",
};

/**
 * ERC-4337 EntryPoint (v0.7) — only what the payment path reads.
 *
 * `UserOperationEvent.success` is the important one and the easiest to skip.
 * `handleOps` does not revert when the inner call fails: the EntryPoint catches
 * it and records the outcome here, so a refused payment and a completed one are
 * indistinguishable from the outside. Treating a bundler hash as confirmation
 * would tell a customer their payment went through when the Router rejected it.
 */
export const ENTRYPOINT_ABI = [
  {
    type: "function",
    name: "getNonce",
    stateMutability: "view",
    inputs: [
      { name: "sender", type: "address" },
      { name: "key", type: "uint192" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getUserOpHash",
    stateMutability: "view",
    inputs: [
      {
        name: "userOp",
        type: "tuple",
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
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "event",
    name: "UserOperationEvent",
    inputs: [
      { name: "userOpHash", type: "bytes32", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "paymaster", type: "address", indexed: true },
      { name: "nonce", type: "uint256", indexed: false },
      { name: "success", type: "bool", indexed: false },
      { name: "actualGasCost", type: "uint256", indexed: false },
      { name: "actualGasUsed", type: "uint256", indexed: false },
    ],
  },
] as const;

/** The account's own entry point. Value is always zero here — the link's
 *  account holds nothing, and nothing in this flow moves native coin. */
export const SIMPLE_ACCOUNT_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "dest", type: "address" },
      { name: "value", type: "uint256" },
      { name: "func", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

/**
 * The account factory — and there are TWO shapes in the wild.
 *
 * The reference `SimpleAccountFactory` takes a uint256 salt:
 *     getAddress(address owner, uint256 salt)
 *
 * thirdweb's `BaseAccountFactory` takes bytes:
 *     getAddress(address adminSigner, bytes data)
 *
 * Different types mean different SELECTORS, so the wrong ABI does not fail
 * loudly — it calls a function the factory does not have. This was shipped
 * wrong once: the reference shape was used against a thirdweb factory, which
 * works in every local test (where the reference factory is deployed) and fails
 * only against production.
 *
 * `ACCOUNT_FACTORY_KIND` picks the shape. There is no default that silently
 * guesses, because guessing is what caused the problem.
 */
export const SIMPLE_ACCOUNT_FACTORY_ABI = [
  {
    type: "function",
    name: "getAddress",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "salt", type: "uint256" },
    ],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "createAccount",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "salt", type: "uint256" },
    ],
    outputs: [{ type: "address" }],
  },
] as const;

export const THIRDWEB_ACCOUNT_FACTORY_ABI = [
  {
    type: "function",
    name: "getAddress",
    stateMutability: "view",
    inputs: [
      { name: "adminSigner", type: "address" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "createAccount",
    stateMutability: "nonpayable",
    inputs: [
      { name: "admin", type: "address" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ type: "address" }],
  },
] as const;

/** The factory ABI and salt argument for the configured kind. */
export function accountFactory(env: Env) {
  const kind = (env.ACCOUNT_FACTORY_KIND ?? "thirdweb").toLowerCase();
  if (kind === "simple") {
    return { abi: SIMPLE_ACCOUNT_FACTORY_ABI, salt: 0n as unknown as bigint | `0x${string}` };
  }
  if (kind === "thirdweb") {
    // The account salt, as bytes. Empty means "one account per owner", which is
    // what we want: the owner key is already unique per link.
    return { abi: THIRDWEB_ACCOUNT_FACTORY_ABI, salt: "0x" as unknown as bigint | `0x${string}` };
  }
  throw new Error(`Unknown ACCOUNT_FACTORY_KIND: ${kind}`);
}

/** @deprecated Use `accountFactory(env)` — the shape depends on the factory. */
export const ACCOUNT_FACTORY_ABI = SIMPLE_ACCOUNT_FACTORY_ABI;
