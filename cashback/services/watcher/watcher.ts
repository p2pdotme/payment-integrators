/**
 * Cashback watcher.
 *
 * Tails the Diamond's `B2BOrderPlaced` event — emitted by the protocol's B2B
 * gateway on EVERY order for EVERY integrator — and reports COMPLETED orders
 * to the CashbackRegistry, which verifies and pays them.
 *
 * This is why no integrator contract is ever modified: the protocol already
 * publishes (integrator, user, amount) centrally, so a new integrator is
 * covered the day it is whitelisted with no cashback code inside it.
 *
 * WHY THERE IS A PENDING SET (audit F2). `B2BOrderPlaced` fires at
 * PLACEMENT; completion happens fiat-time later. Measured on Base mainnet,
 * orders complete at a median of ~122 s, with a long tail — and a dispute
 * settlement can complete one days later. An earlier version of this loop
 * checked each order once, ~60 s after placement, then advanced the cursor
 * past it forever: 0 of 13 completed orders in a real sample would have been
 * caught. The programme would have run, emitted no errors, and paid nothing.
 *
 * So the cursor now tracks DISCOVERY only. Every order found is added to a
 * pending set and re-checked on each poll until the registry SETTLES it —
 * pays it, or declines it for a reason that can never change — or it ages
 * out past the dispute window.
 *
 * Two corollaries the first version of this loop got wrong, both of which
 * turned a deferral into a silent non-payment (AUDIT N1, N2):
 *
 *   · A batch landing on chain does not mean its rows were paid. `payBatch`
 *     isolates each row and the registry leaves declined ones retryable, so
 *     rows are retired individually from the receipt, never wholesale.
 *   · CANCELLED is not terminal for a BUY. A dispute settled in the user's
 *     favour completes the order days later — the very case this TTL exists
 *     for — so cancelled orders are held, just polled slowly.
 *
 * The watcher is NOT a trusted component. The registry independently
 * re-reads every order from the Diamond, confirms the integrator binding,
 * and pays the address of record — so a compromised watcher cannot invent
 * orders, inflate amounts, or redirect funds. Its only real power is
 * omission, and anyone can run a second watcher to backfill.
 *
 * Run:
 *   RPC_URL=… REGISTRY_ADDRESS=0x… DIAMOND_ADDRESS=0x… \
 *   WATCHER_PRIVATE_KEY=0x… npx ts-node services/watcher/watcher.ts
 */

import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";

// ─── Config ─────────────────────────────────────────────────────────

const RPC_URL = process.env.RPC_URL || "https://sepolia.base.org";
const REGISTRY_ADDRESS = process.env.REGISTRY_ADDRESS || "";
const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "";
const WATCHER_PRIVATE_KEY = process.env.WATCHER_PRIVATE_KEY || "";

/** Blocks to stay behind the head when DISCOVERING orders, so a reorg
 *  cannot un-do a payout we based on a since-orphaned log. */
const CONFIRMATIONS = Number(process.env.CONFIRMATIONS || 30);
/** Confirmations to wait on our own payment tx before retiring the orders
 *  it paid. Lower than CONFIRMATIONS because a re-send is cheap and the
 *  on-chain `orderPaid` marker prevents double payment either way. */
const PAYMENT_CONFIRMATIONS = Number(process.env.PAYMENT_CONFIRMATIONS || 3);
/** Orders per payBatch transaction. */
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 50);

/**
 * Explicit gas budget for a `payBatch`, in place of `eth_estimateGas`.
 * AUDIT M5 — see the call site for why the estimator cannot be used here.
 *
 * Measured against the worst case (every row's reward token burns its full
 * `TOKEN_CALL_GAS`): 187k used per row, ~240k of limit needed per row. Honest
 * rows use ~67k. 250k/row therefore covers the hostile case with headroom,
 * and at the default BATCH_SIZE of 50 asks for 12.8M — comfortably inside a
 * Base block, and only ever charged for what is actually used.
 */
const GAS_PER_ROW = Number(process.env.GAS_PER_ROW || 250_000);
const GAS_OVERHEAD = Number(process.env.GAS_OVERHEAD || 300_000);
/** Max blocks per getLogs call (RPC providers cap this). */
const BLOCK_SPAN = Number(process.env.BLOCK_SPAN || 2000);
const POLL_MS = Number(process.env.POLL_MS || 5000);
/** First block to scan on a cold start (the registry's deploy block). */
const START_BLOCK = Number(process.env.START_BLOCK || 0);

/**
 * How long a placed order stays in the pending set before being given up on.
 * Must comfortably exceed the protocol's dispute window — a dispute
 * settlement can move an order to COMPLETED days after placement. Default 14
 * days; cheap to hold, expensive to under-set (a dropped order is cashback
 * silently never paid).
 */
const PENDING_TTL_MS = Number(process.env.PENDING_TTL_MS || 14 * 24 * 60 * 60 * 1000);

/** Cap on how many pending orders are re-checked per poll, so a large
 *  backlog degrades gracefully instead of timing out the RPC. */
const RECHECK_PER_POLL = Number(process.env.RECHECK_PER_POLL || 400);

/**
 * How often a CANCELLED order is re-checked. AUDIT N2: cancellation is not
 * terminal for a BUY — a dispute resolved in the user's favour completes the
 * order days later, which is exactly what `PENDING_TTL_MS` exists for, so
 * dropping cancelled orders on sight argued against the TTL's own rationale.
 *
 * Kept, but checked rarely: the tail is thin (a small minority of orders
 * cancel, and only a fraction of those carry a dispute at all), so paying
 * full rotation cost for them would crowd out live orders for no benefit.
 * Every 6 hours over a 14-day TTL is ~56 checks per cancelled order.
 */
const CANCELLED_RECHECK_MS = Number(process.env.CANCELLED_RECHECK_MS || 6 * 60 * 60 * 1000);

/**
 * How long to wait before RE-REPORTING an order the registry declined to
 * settle (AUDIT M6).
 *
 * Every reason a row is held is one that resolves on a human timescale: a
 * daily budget rolls over at UTC midnight, a funding wallet gets topped up, a
 * paused campaign is resumed, an approval is re-granted. Retrying every poll
 * buys nothing and costs a transaction each time. Five minutes is far below
 * the shortest of those and far above the poll interval.
 */
const RETRY_BACKOFF_MS = Number(process.env.RETRY_BACKOFF_MS || 5 * 60 * 1000);

const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, ".watcher-state.json");

/** Diamond order statuses. */
const COMPLETED = 3;
const CANCELLED = 4;

// ─── ABIs (minimal) ─────────────────────────────────────────────────

const DIAMOND_ABI = [
  "event B2BOrderPlaced(uint256 indexed orderId, address indexed integrator, address indexed user, uint256 amount)",
  "function getOrdersById(uint256 orderId) view returns (tuple(uint256 amount, uint256 fiatAmount, uint256 placedTimestamp, uint256 completedTimestamp, uint256 userCompletedTimestamp, address acceptedMerchant, address user, address recipientAddr, string pubkey, string encUpi, bool userCompleted, uint8 status, uint8 orderType, tuple(uint8 raisedBy, uint8 status, uint256 redactTransId, uint256 accountNumber) disputeInfo, uint256 id, string userPubKey, string encMerchantUpi, uint256 acceptedAccountNo, uint256[] assignedAccountNos, bytes32 currency, uint256 preferredPaymentChannelConfigId, uint256 circleId))",
];

const REGISTRY_ABI = [
  "function payBatch((uint256 orderId, address integrator, address user, uint256 orderAmount)[] reports)",
  "function orderPaid(uint256 orderId) view returns (bool)",
  // AUDIT N1. Needed to read per-row outcomes back out of the batch receipt.
  // `payBatch` isolates every row and returns nothing, so without these the
  // caller cannot tell which rows actually paid.
  "event Paid(bytes32 indexed campaignId, uint256 indexed orderId, address indexed user, address rewardToken, uint256 amount)",
  "event PayDeclined(uint256 indexed orderId, uint8 reason)",
];

/**
 * Decline reasons the registry will never change its mind about, so the order
 * can be retired. Everything else — a paused campaign, a revoked funder, an
 * exhausted daily budget — is temporary and MUST stay pending.
 *
 * AUDIT N1. Retiring a deferred order is indistinguishable, from the user's
 * side, from never having earned it: the discovery cursor is long past, so
 * nothing re-reports it and there is no error to look at.
 *
 *   1 ALREADY_PAID · 2 UNVERIFIED · 3 ORDER_TYPE · 4 NO_CAMPAIGN
 *   6 CAMPAIGN_RETIRED · 7 OUT_OF_WINDOW · 9 ZERO_REWARD
 */
export const TERMINAL_DECLINES = new Set([1, 2, 3, 4, 6, 7, 9]);

// ─── State ──────────────────────────────────────────────────────────
//
// Crash-safety has two layers: this file (a cheap resume point) and the
// registry's on-chain `orderPaid` marker (the authoritative guard). Even a
// lost or corrupted state file cannot cause a double payout — at worst the
// watcher re-reports orders the registry then no-ops.

export type Pending = {
  integrator: string;
  user: string;
  amount: string; // bigint as decimal string
  firstSeen: number; // ms epoch, for the TTL
  lastChecked?: number; // ms epoch, drives the round-robin rotation
  // ms epoch the order was first seen CANCELLED, or undefined. AUDIT N2:
  // cancellation is not terminal for a BUY — a dispute settled in the user's
  // favour runs the normal completion path and the order reaches COMPLETED
  // later — so a cancelled order is kept and re-checked slowly rather than
  // dropped. Cleared if it ever leaves CANCELLED.
  cancelledAt?: number;
  /**
   * ms epoch before which this order should not be REPORTED again.
   *
   * AUDIT M6. Set when a batch comes back without settling the row. Without
   * it, a deferred order is re-reported on every poll for as long as it is
   * deferred — up to the full 14-day TTL — which is a transaction every few
   * seconds for an order the registry has already said it will not pay yet.
   * The backoff is what makes "hold it and try again" cheap enough to be the
   * right default.
   */
  retryAfter?: number;
};

type State = {
  lastProcessedBlock: number;
  pending: Record<string, Pending>; // orderId -> details
};

/** Thrown when the state file exists but cannot be parsed. */
class CorruptStateError extends Error {}

/** Keeps only entries that are actually usable; logs whatever is dropped. */
function sanitizePending(raw: unknown): Record<string, Pending> {
  const out: Record<string, Pending> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const p = value as Partial<Pending>;
    const usable =
      p &&
      typeof p.integrator === "string" &&
      typeof p.user === "string" &&
      typeof p.amount === "string" &&
      /^\d+$/.test(p.amount) &&
      typeof p.firstSeen === "number" &&
      Number.isFinite(p.firstSeen) &&
      /^\d+$/.test(key);

    if (usable) {
      out[key] = {
        integrator: p.integrator as string,
        user: p.user as string,
        amount: p.amount as string,
        firstSeen: p.firstSeen as number,
        lastChecked: typeof p.lastChecked === "number" ? p.lastChecked : 0,
        cancelledAt: typeof p.cancelledAt === "number" ? p.cancelledAt : undefined,
        retryAfter: typeof p.retryAfter === "number" ? p.retryAfter : undefined,
      };
    } else {
      console.error(`state: dropping unusable pending entry ${key}`);
    }
  }
  return out;
}

function readState(fallbackBlock: number): State {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return {
      lastProcessedBlock:
        typeof raw.lastProcessedBlock === "number" ? raw.lastProcessedBlock : fallbackBlock,
      // FOURTH-PASS AUDIT (low). `typeof x === "object"` also accepts an
      // array, and says nothing about the entries. A hand-edited or
      // partially-corrupted-but-parseable file could hold an entry whose
      // `amount` is not numeric; it would throw inside the loop every poll
      // forever, never being removed. Validate the shape on load and drop
      // what cannot be used, loudly.
      pending: sanitizePending(raw.pending),
    };
  } catch (err) {
    // THIRD-PASS AUDIT (medium). A file that EXISTS but does not parse must
    // not silently fall back to the head — that is the same silent-skip the
    // cold-start guard was added to prevent, reached by the exact scenario
    // its own comment names ("missing or corrupt").
    if (fs.existsSync(STATE_FILE)) {
      throw new CorruptStateError(
        `State file ${STATE_FILE} exists but could not be parsed: ${(err as Error).message}. ` +
          `Refusing to resume from the chain head, which would silently skip every order ` +
          `placed while the watcher was down. Restore it from backup, or delete it and set ` +
          `START_BLOCK explicitly.`
      );
    }
    return { lastProcessedBlock: fallbackBlock, pending: {} };
  }
}

function writeState(state: State): void {
  // Write-then-rename so a crash mid-write cannot leave a truncated file.
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Decision logic (exported so it can actually be tested) ─────────
//
// These two functions are where the N1 and N2 fixes live. They used to be
// inline in `main`'s `while (true)` loop, which meant the entire watcher —
// the half of this system that decides whether a reward is ever paid — had
// no test coverage of any kind. Pure in, pure out, no RPC: the e2e suite
// drives them against real receipts from a real registry.

/**
 * Which rows of a `payBatch` did the registry actually SETTLE?
 *
 * AUDIT N1. `payBatch` isolates every row and returns nothing, so a landed
 * transaction says nothing about whether any individual reward was paid. A
 * row is settled if it emitted `Paid`, or was declined for a reason that can
 * never change. Anything else — a spent daily budget, a dry funding wallet, a
 * paused campaign — must stay pending and be retried, or the caps silently
 * become non-payment.
 */
export function settledFromReceipt(
  iface: ethers.Interface,
  logs: readonly { topics: readonly string[]; data: string }[]
): { settled: Set<string>; paidCount: number } {
  const settled = new Set<string>();
  let paidCount = 0;

  for (const log of logs) {
    let parsed: ethers.LogDescription | null = null;
    try {
      parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue; // a reward token's own Transfer, not one of ours
    }
    if (!parsed) continue;

    if (parsed.name === "Paid") {
      settled.add(parsed.args.orderId.toString());
      paidCount++;
    } else if (parsed.name === "PayDeclined") {
      if (TERMINAL_DECLINES.has(Number(parsed.args.reason))) {
        settled.add(parsed.args.orderId.toString());
      }
    }
  }
  return { settled, paidCount };
}

/**
 * Which pending orders should this poll re-check, oldest-unchecked first?
 *
 * AUDIT N2. Cancelled orders are held to the TTL — a dispute settled in the
 * user's favour completes the order days later — but polled on a slow
 * cadence. The filter runs BEFORE the slice on purpose: left in, a large
 * cancelled backlog would consume the per-poll budget and starve live orders
 * of re-checks, which would be a different route to the same silent
 * non-payment.
 */
export function selectForRecheck(
  pending: Record<string, Pending>,
  now: number,
  limit: number = RECHECK_PER_POLL,
  cancelledRecheckMs: number = CANCELLED_RECHECK_MS
): string[] {
  return Object.keys(pending)
    .filter((k) => {
      const p = pending[k];
      if (p.cancelledAt === undefined) return true;
      return now - (p.lastChecked ?? 0) >= cancelledRecheckMs;
    })
    .sort((a, b) => (pending[a].lastChecked ?? 0) - (pending[b].lastChecked ?? 0))
    .slice(0, limit);
}

// ─── Main loop ──────────────────────────────────────────────────────

async function main() {
  if (!REGISTRY_ADDRESS || !DIAMOND_ADDRESS || !WATCHER_PRIVATE_KEY) {
    throw new Error(
      "REGISTRY_ADDRESS, DIAMOND_ADDRESS and WATCHER_PRIVATE_KEY env vars are required"
    );
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(WATCHER_PRIVATE_KEY, provider);

  const diamond = new ethers.Contract(DIAMOND_ADDRESS, DIAMOND_ABI, provider);
  const registry = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, signer);

  console.log(`watcher up  · registry ${REGISTRY_ADDRESS}`);
  console.log(`            · diamond  ${DIAMOND_ADDRESS}`);
  console.log(`            · signer   ${await signer.getAddress()}`);
  console.log(
    `            · ${CONFIRMATIONS} confirmations · batches of ${BATCH_SIZE} · ` +
      `pending TTL ${Math.round(PENDING_TTL_MS / 3_600_000)}h`
  );

  const head0 = await provider.getBlockNumber();

  // RE-AUDIT (high). Falling back to the CURRENT head when the state file is
  // missing or corrupt silently skips every order placed while the watcher
  // was down — the on-chain `orderPaid` marker prevents double payment, but
  // nothing recovers an order we never looked at. Require START_BLOCK so a
  // cold start has an explicit, auditable floor.
  if (!fs.existsSync(STATE_FILE) && !START_BLOCK) {
    throw new Error(
      `No state file at ${STATE_FILE} and START_BLOCK is unset. Set START_BLOCK ` +
        `to the registry's deploy block (or an earlier known-good block) so a ` +
        `cold start cannot silently skip orders placed while the watcher was down.`
    );
  }
  const state = readState(START_BLOCK || head0);
  console.log(
    `            · resuming at block ${state.lastProcessedBlock} ` +
      `with ${Object.keys(state.pending).length} pending`
  );

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const head = await provider.getBlockNumber();
      const safeHead = head - CONFIRMATIONS;

      // ── 1. DISCOVER: add newly placed orders to the pending set ──
      const from = state.lastProcessedBlock + 1;
      if (safeHead >= from) {
        const to = Math.min(safeHead, from + BLOCK_SPAN - 1);
        const logs = await diamond.queryFilter(diamond.filters.B2BOrderPlaced(), from, to);

        for (const log of logs) {
          const { orderId, integrator, user, amount } = (log as ethers.EventLog).args;
          const key = orderId.toString();
          if (!state.pending[key]) {
            state.pending[key] = {
              integrator,
              user,
              amount: amount.toString(),
              firstSeen: Date.now(),
              lastChecked: 0, // never checked — front of the rotation
            };
          }
        }

        if (logs.length > 0) {
          console.log(`blocks ${from}–${to}: discovered ${logs.length}`);
        }
        state.lastProcessedBlock = to;
      }

      // ── 2. RE-CHECK: has anything pending completed since last poll? ──
      const now = Date.now();

      // Re-check on a ROTATING CURSOR, oldest-unchecked first.
      //
      // THIRD-PASS AUDIT (high). Two earlier versions both starved:
      //   1. `Object.keys(pending).slice(0, N)` — JS enumerates integer-like
      //      keys in ascending NUMERIC order, so the N lowest orderIds were
      //      re-checked forever.
      //   2. Sorting by `firstSeen` — no better. That sort is STATIC, and an
      //      order only leaves the set when it completes, cancels, or ages
      //      out. Orders parked in PLACED/ACCEPTED (abandoned orders, which
      //      are routine) sit at the head of the sort permanently. Once more
      //      than N of them accumulate, nothing newer is ever examined until
      //      it ages out at 14 days — unpaid. An attacker could trigger it
      //      deliberately by placing ~N orders and abandoning them, disabling
      //      cashback for every integrator at once.
      //
      // Sorting by `lastChecked` instead makes the head of the list the
      // least-recently-visited entry, so a stuck order is examined once and
      // then moves to the back. Every entry is visited in bounded time
      // regardless of how many are stuck.
      const keys = selectForRecheck(state.pending, now);
      const ready: { orderId: bigint; integrator: string; user: string; orderAmount: bigint }[] =
        [];

      for (const key of keys) {
        const p = state.pending[key];
        // Stamp BEFORE any early `continue`, so an order that stays pending
        // still moves to the back of the rotation rather than being
        // re-examined immediately.
        p.lastChecked = now;

        // Age out anything past the dispute window so the set stays bounded.
        if (now - p.firstSeen > PENDING_TTL_MS) {
          console.log(`order ${key}: aged out of pending set (TTL)`);
          delete state.pending[key];
          continue;
        }

        let order;
        try {
          order = await diamond.getOrdersById(key);
        } catch {
          continue; // transient RPC failure — keep it pending, retry next poll
        }

        const status = Number(order.status);

        if (status === CANCELLED) {
          // AUDIT N2. NOT terminal — a dispute settled in the user's favour
          // runs the normal completion path and this order can still reach
          // COMPLETED before its TTL expires. Mark it so the rotation checks
          // it slowly, and keep it.
          if (p.cancelledAt === undefined) {
            p.cancelledAt = now;
            console.log(
              `order ${key}: cancelled — holding until TTL in case a dispute completes it`
            );
          }
          continue;
        }
        // Left CANCELLED (dispute resolved): back to the normal cadence.
        if (p.cancelledAt !== undefined) {
          console.log(`order ${key}: no longer cancelled — resuming normal re-checks`);
          p.cancelledAt = undefined;
        }
        if (status !== COMPLETED) {
          continue; // still in flight — this is the case F2 used to drop
        }

        // Completed. Skip if the registry already has it (crash-safe).
        if (await registry.orderPaid(key)) {
          delete state.pending[key];
          continue;
        }

        // AUDIT M6. The registry already declined this one for a reason that
        // needs time, not another attempt. Keep it — that is the N1 property —
        // but do not spend a transaction on it every poll.
        if (p.retryAfter !== undefined && now < p.retryAfter) continue;

        ready.push({
          orderId: BigInt(key),
          integrator: p.integrator,
          user: p.user,
          orderAmount: BigInt(p.amount),
        });
      }

      // ── 3. REPORT: the registry verifies and pays ──
      for (let i = 0; i < ready.length; i += BATCH_SIZE) {
        const chunk = ready.slice(i, i + BATCH_SIZE);
        try {
          // AUDIT M5. Set the gas limit EXPLICITLY rather than letting ethers
          // call `eth_estimateGas`.
          //
          // Measured: a batch of 50 rows whose reward token burns all the gas
          // it is handed USES 9.34M gas and needs a ~12M limit to run, but
          // `estimateGas` returns 28M for it. The estimator is not wrong so
          // much as ill-defined here — a gas-burning token consumes whatever
          // it is given up to `TOKEN_CALL_GAS`, so raising the limit raises
          // consumption, and the search converges far above real usage.
          //
          // Left to the estimator, one hostile tenant would push every batch
          // containing their rows over the block gas limit and make it
          // unsendable — griefing every honest row in the batch, which is the
          // hole F5's per-call cap was meant to close. Unused gas is not
          // charged, so over-providing costs nothing but the block-space cap.
          const gasLimit = BigInt(GAS_OVERHEAD + GAS_PER_ROW * chunk.length);
          const tx = await registry.payBatch(chunk, { gasLimit });
          // AUDIT N7. `tx.wait()` waits ONE confirmation. `PAYMENT_CONFIRMATIONS`
          // was declared and documented as the number of confirmations to wait
          // before retiring orders — and never referenced, so the reorg it was
          // introduced to close was still open: a reorg un-mining this tx after
          // the rows were retired left them permanently unpaid, because the
          // discovery cursor had moved past them.
          const receipt = await tx.wait(PAYMENT_CONFIRMATIONS);

          // AUDIT N1. Retire a row only if the registry actually SETTLED it.
          //
          // `payBatch` isolates every row and swallows the outcome, and the
          // registry deliberately leaves declined orders retryable — a failed
          // transfer rolls `orderPaid` back, and a budget-throttled order
          // returns 0 with no state change at all. Deleting the whole chunk on
          // inclusion therefore dropped exactly the orders the contract had
          // gone out of its way to keep payable: an empty funding wallet, a
          // revoked approval, or simply hitting the daily budget meant those
          // rewards were never paid, with nothing logged to look at. The
          // budget caps deferred the order and the pending set discarded it.
          //
          // Settled = paid, or declined for a reason that can never change.
          // Everything else stays pending and is retried on a later poll.
          const { settled, paidCount } = settledFromReceipt(
            registry.interface,
            receipt?.logs ?? []
          );

          for (const r of chunk) {
            const key = r.orderId.toString();
            if (settled.has(key)) {
              delete state.pending[key];
            } else if (state.pending[key]) {
              // Held. Back off before asking again (AUDIT M6).
              state.pending[key].retryAfter = Date.now() + RETRY_BACKOFF_MS;
            }
          }

          const held = chunk.length - settled.size;
          console.log(
            `batch of ${chunk.length} · ${paidCount} paid · ${settled.size - paidCount} closed · ` +
              `${held} held for retry · block ${receipt?.blockNumber} · ${tx.hash}`
          );
          if (held > 0) {
            // Not an error — this is the deferral path working — but it is
            // the number that tells an operator a funding wallet is dry or a
            // budget is spent, so it must never be silent.
            console.warn(`  ${held} order(s) not settled this round; they stay pending`);
          }
        } catch (err) {
          // A failed batch must not stall the cursor — the orders stay
          // pending and are retried next poll. Logged loudly because a
          // persistent failure here is the difference between "paying" and
          // "silently not paying".
          console.error(`batch of ${chunk.length} failed:`, (err as Error).message);
        }
      }

      writeState(state);

      // Sleep unless there is genuine DISCOVERY backlog to catch up on.
      //
      // AUDIT M6 — a regression the N1 fix introduced, found by running the
      // watcher as a process rather than testing its parts. The condition used
      // to be `&& ready.length === 0`, which was correct while a declined
      // order was dropped: `ready` emptied and the loop rested. Now that
      // declined orders are HELD and re-reported, `ready` is never empty while
      // one is deferred, so the loop stopped sleeping entirely — spinning as
      // fast as the RPC allowed and sending a payBatch every pass.
      //
      // Measured in the e2e before the fix: 39 batches and 19 nonce collisions
      // in a twenty-second run, off a single budget-throttled order. On a real
      // chain that is the funding wallet's gas burned continuously until the
      // 14-day TTL expires — the deferral that N1 exists to make safe turned
      // into the most expensive thing the watcher can do.
      if (safeHead < state.lastProcessedBlock + 1) {
        await sleep(POLL_MS);
      }
    } catch (err) {
      // Never exit on a transient RPC failure. The cursor only advances on a
      // successful sweep, so nothing is skipped.
      console.error("loop error:", (err as Error).message);
      await sleep(POLL_MS * 2);
    }
  }
}

// Only run the loop when this file is EXECUTED, not when it is imported.
// Without the guard, importing the module to test its decision logic would
// start a live watcher against whatever RPC the environment happened to name.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
