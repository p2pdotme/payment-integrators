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
 * pending set and re-checked on each poll until it completes (paid), is
 * cancelled, or ages out past the dispute window.
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

/** Blocks to stay behind the head, so a reorg cannot un-do a payout. */
const CONFIRMATIONS = Number(process.env.CONFIRMATIONS || 30);
/** Orders per payBatch transaction. */
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 50);
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
];

// ─── State ──────────────────────────────────────────────────────────
//
// Crash-safety has two layers: this file (a cheap resume point) and the
// registry's on-chain `orderPaid` marker (the authoritative guard). Even a
// lost or corrupted state file cannot cause a double payout — at worst the
// watcher re-reports orders the registry then no-ops.

type Pending = {
  integrator: string;
  user: string;
  amount: string; // bigint as decimal string
  firstSeen: number; // ms epoch, for the TTL
};

type State = {
  lastProcessedBlock: number;
  pending: Record<string, Pending>; // orderId -> details
};

function readState(fallbackBlock: number): State {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return {
      lastProcessedBlock:
        typeof raw.lastProcessedBlock === "number" ? raw.lastProcessedBlock : fallbackBlock,
      pending: raw.pending && typeof raw.pending === "object" ? raw.pending : {},
    };
  } catch {
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

      // Re-check OLDEST-FIRST, not in key order.
      //
      // RE-AUDIT (high). This used to be `Object.keys(pending).slice(0, N)`.
      // JavaScript enumerates integer-like keys in ascending NUMERIC order,
      // not insertion order — so once the pending set exceeded N, the same
      // N lowest orderIds were re-checked every poll forever and newer
      // orders were never examined until they aged out. That is F2's
      // failure mode returning by a different route: cashback silently
      // unpaid, dashboards healthy. Sorting by `firstSeen` makes progress
      // monotonic regardless of set size.
      const keys = Object.keys(state.pending)
        .sort((a, b) => state.pending[a].firstSeen - state.pending[b].firstSeen)
        .slice(0, RECHECK_PER_POLL);
      const ready: { orderId: bigint; integrator: string; user: string; orderAmount: bigint }[] =
        [];

      for (const key of keys) {
        const p = state.pending[key];

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
          // Terminal and unrewardable. Drop it.
          delete state.pending[key];
          continue;
        }
        if (status !== COMPLETED) {
          continue; // still in flight — this is the case F2 used to drop
        }

        // Completed. Skip if the registry already has it (crash-safe).
        if (await registry.orderPaid(key)) {
          delete state.pending[key];
          continue;
        }

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
          const tx = await registry.payBatch(chunk);
          const receipt = await tx.wait();
          console.log(`paid batch of ${chunk.length} · block ${receipt?.blockNumber} · ${tx.hash}`);
          // Only retire them once the batch actually landed.
          for (const r of chunk) delete state.pending[r.orderId.toString()];
        } catch (err) {
          // A failed batch must not stall the cursor — the orders stay
          // pending and are retried next poll. Logged loudly because a
          // persistent failure here is the difference between "paying" and
          // "silently not paying".
          console.error(`batch of ${chunk.length} failed:`, (err as Error).message);
        }
      }

      writeState(state);

      if (safeHead < state.lastProcessedBlock + 1 && ready.length === 0) {
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
