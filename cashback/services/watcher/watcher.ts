/**
 * Cashback watcher.
 *
 * Tails the Diamond's `B2BOrderPlaced` event — emitted by the protocol's B2B
 * gateway on EVERY order for EVERY integrator — and reports completed orders
 * to the CashbackRegistry, which pays the reward.
 *
 * This is why no integrator contract is ever modified: the protocol already
 * publishes (integrator, user, amount) centrally, so a new integrator is
 * covered the day it is whitelisted with no cashback code inside it.
 *
 * The watcher is NOT a trusted component. The registry independently re-reads
 * every order from the Diamond and pays the address of record, so a
 * compromised watcher cannot invent orders, inflate amounts, or redirect
 * funds. Its only real power is omission — delaying reports — and anyone can
 * run a second watcher to backfill.
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

const CURSOR_FILE = process.env.CURSOR_FILE || path.join(__dirname, ".cursor.json");

/** Diamond order status — only COMPLETED orders earn cashback. */
const COMPLETED = 3;

// ─── ABIs (minimal) ─────────────────────────────────────────────────

const DIAMOND_ABI = [
  "event B2BOrderPlaced(uint256 indexed orderId, address indexed integrator, address indexed user, uint256 amount)",
  "function getOrdersById(uint256 orderId) view returns (tuple(uint256 amount, uint256 fiatAmount, uint256 placedTimestamp, uint256 completedTimestamp, uint256 userCompletedTimestamp, address acceptedMerchant, address user, address recipientAddr, string pubkey, string encUpi, bool userCompleted, uint8 status, uint8 orderType, tuple(uint8 raisedBy, uint8 status, uint256 redactTransId, uint256 accountNumber) disputeInfo, uint256 id, string userPubKey, string encMerchantUpi, uint256 acceptedAccountNo, uint256[] assignedAccountNos, bytes32 currency, uint256 preferredPaymentChannelConfigId, uint256 circleId))",
];

const REGISTRY_ABI = [
  "function payBatch((uint256 orderId, address integrator, address user, bytes32 orderType, bytes32 currency, uint256 orderAmount)[] reports)",
  "function orderPaid(uint256 orderId) view returns (bool)",
];

const ORDER_TYPE_LABELS = ["BUY", "SELL", "PAY"] as const;

// ─── Cursor persistence ─────────────────────────────────────────────
// Crash-safety comes from two places: this cursor (cheap resume point) and
// the registry's on-chain `orderPaid` marker (the authoritative guard). Even
// a corrupted or reset cursor cannot cause a double payout.

function readCursor(fallback: number): number {
  try {
    const raw = JSON.parse(fs.readFileSync(CURSOR_FILE, "utf8"));
    return typeof raw.lastProcessedBlock === "number" ? raw.lastProcessedBlock : fallback;
  } catch {
    return fallback;
  }
}

function writeCursor(block: number): void {
  fs.writeFileSync(CURSOR_FILE, JSON.stringify({ lastProcessedBlock: block }, null, 2));
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
  console.log(`            · ${CONFIRMATIONS} confirmations, batches of ${BATCH_SIZE}`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const head = await provider.getBlockNumber();
      const safeHead = head - CONFIRMATIONS;
      const from = readCursor(START_BLOCK || head) + 1;

      if (safeHead < from) {
        await sleep(POLL_MS);
        continue;
      }

      // Cap the span so a long backfill is chunked rather than rejected.
      const to = Math.min(safeHead, from + BLOCK_SPAN - 1);

      const logs = await diamond.queryFilter(diamond.filters.B2BOrderPlaced(), from, to);

      const reports: {
        orderId: bigint;
        integrator: string;
        user: string;
        orderType: string;
        currency: string;
        orderAmount: bigint;
      }[] = [];

      for (const log of logs) {
        const { orderId, integrator, user, amount } = (log as ethers.EventLog).args;

        // The event fires at placement; cashback is only for orders that
        // actually settled. Read the current state before reporting.
        let order;
        try {
          order = await diamond.getOrdersById(orderId);
        } catch {
          continue; // unreadable — leave it for a later pass
        }
        if (Number(order.status) !== COMPLETED) continue;

        // Cheap dedupe. The registry enforces this authoritatively anyway;
        // skipping here just avoids wasting calldata on already-paid orders.
        if (await registry.orderPaid(orderId)) continue;

        reports.push({
          orderId,
          integrator,
          user,
          orderType: ethers.encodeBytes32String(
            ORDER_TYPE_LABELS[Number(order.orderType)] ?? "BUY"
          ),
          currency: order.currency,
          orderAmount: amount,
        });
      }

      for (let i = 0; i < reports.length; i += BATCH_SIZE) {
        const chunk = reports.slice(i, i + BATCH_SIZE);
        const tx = await registry.payBatch(chunk);
        const receipt = await tx.wait();
        console.log(`paid batch of ${chunk.length}  · block ${receipt?.blockNumber} · ${tx.hash}`);
      }

      writeCursor(to);
      if (reports.length > 0) {
        console.log(`blocks ${from}–${to}: reported ${reports.length}`);
      }
    } catch (err) {
      // Never exit on a transient RPC failure — back off and retry. Missed
      // blocks are picked up on the next pass because the cursor only
      // advances after a successful sweep.
      console.error("loop error:", (err as Error).message);
      await sleep(POLL_MS * 2);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
