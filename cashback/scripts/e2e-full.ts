/**
 * FULL end-to-end: the real watcher PROCESS against a real chain.
 *
 * WHY THIS EXISTS
 * `test/cashback-e2e.test.ts` drives the watcher's decision functions with real
 * receipts, which is what caught N1. But it stops at the RPC boundary, and I
 * said so in the file: `queryFilter`, the block cursor, `tx.wait`, and the
 * state file were all still unexercised. Those are not incidental — the cursor
 * IS the F2 fix, and the state file is the only thing that makes a restart
 * safe. A suite that never runs them is asserting that the half of the system
 * which decides whether an order is ever SEEN works, rather than showing it.
 *
 * So this spawns `services/watcher/watcher.ts` as a child process, exactly as
 * an operator would, and talks to it only through the chain and its own state
 * file. Nothing is stubbed: real discovery, real polling, real batching, real
 * receipts, real persistence.
 *
 *   npx hardhat run scripts/e2e-full.ts --network localhost
 *
 * Needs a node: `npx hardhat node` in another terminal.
 *
 * WHAT IT PROVES, in order:
 *   1. an order the watcher never saw placed is not paid (discovery works)
 *   2. placement + completion -> discovered, reported, paid, retired
 *   3. an order that completes LATER is still paid (the F2 pending set)
 *   4. a budget-throttled order is HELD, not dropped, and pays the next day
 *      (N1 + N6, through the real loop rather than a parsed receipt)
 *   5. the state file survives a restart and nothing is double-paid
 */

import { spawn, type ChildProcess } from "child_process";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";

const U6 = (n: number) => ethers.parseUnits(n.toString(), 6);
const ANY = ethers.ZeroHash;
const BUY = ethers.encodeBytes32String("BUY");
const INR = ethers.encodeBytes32String("INR");
const COMPLETED = 3;

const STATE_FILE = path.join(__dirname, ".e2e-watcher-state.json");
const RPC = "http://127.0.0.1:8545";

/** Hardhat account #1 — the watcher signs with this. */
const WATCHER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until `fn` is true or the budget runs out. Returns whether it became true. */
async function until(fn: () => Promise<boolean>, ms = 45_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(500);
  }
  return false;
}

/** Every line the watcher has printed, so the e2e can assert on its behaviour. */
const watcherLog: string[] = [];
const batchCount = () => watcherLog.filter((l) => l.includes("batch of")).length;

function startWatcher(env: Record<string, string>): ChildProcess {
  // Spawn node DIRECTLY, not through `npx` with a shell.
  //
  // The shell form leaks: on Windows `child.kill()` terminates the npx wrapper
  // and leaves the ts-node grandchild running. Every run of this script left a
  // live watcher behind, and they accumulated — several processes sharing one
  // state file and one relayer EOA, writing over each other's pending set and
  // colliding on nonces. That produced a failure that looked exactly like a
  // product bug (orders vanishing from the pending set) and was entirely this
  // harness's fault. Spawning node itself means the pid we hold is the pid we
  // kill.
  const tsNode = path.join(__dirname, "..", "node_modules", "ts-node", "dist", "bin.js");
  const child = spawn(
    process.execPath,
    [tsNode, "--transpile-only", path.join(__dirname, "..", "services", "watcher", "watcher.ts")],
    {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const record = (d: Buffer) =>
    String(d)
      .split("\n")
      .forEach((l) => l && watcherLog.push(l));
  child.stdout?.on("data", (d) => {
    record(d);
    process.stdout.write(`    [watcher] ${d}`);
  });
  child.stderr?.on("data", (d) => {
    record(d);
    process.stderr.write(`    [watcher!] ${d}`);
  });
  return child;
}

async function stop(child: ChildProcess) {
  if (child.killed || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  // Wait for the process to actually go, rather than assuming a fixed delay.
  // A watcher still alive when the next one starts is two writers on one state
  // file, which is not a condition this script should ever create.
  await Promise.race([exited, sleep(5000)]);
  if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  await sleep(300);
}

async function main() {
  const [admin, , owner, alice, bob] = await ethers.getSigners();
  const watcherAddr = new ethers.Wallet(WATCHER_KEY).address;

  console.log("\n=== deploy ===");
  const token = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const orders = await (await ethers.getContractFactory("MockOrderSource")).deploy();
  const registry = await (
    await ethers.getContractFactory("CashbackRegistry")
  ).deploy(await orders.getAddress());
  await registry.waitForDeployment();

  const startBlock = await ethers.provider.getBlockNumber();
  await (await registry.setAccruer(watcherAddr, true)).wait();

  const integ = ethers.Wallet.createRandom().address;
  await (await registry.setIntegratorOwner(integ, owner.address)).wait();
  await (await token.mint(owner.address, U6(1_000_000))).wait();
  await (await token.connect(owner).approve(await registry.getAddress(), ethers.MaxUint256)).wait();

  // Fund the watcher EOA so it can pay for gas.
  await (await admin.sendTransaction({ to: watcherAddr, value: ethers.parseEther("1") })).wait();

  // 1% on everything, with a daily budget that fits exactly two rewards plus a
  // sliver — so the third order in a day is the N6 deferral case.
  const tx = await registry
    .connect(owner)
    .createCampaign(integ, ANY, ANY, await token.getAddress(), 100, 0n, owner.address, {
      maxRewardPerOrder: 0n,
      dailyBudget: U6(20) + 1n,
      totalBudget: 0n,
      dailyPerUser: 0n,
      startTime: 0n,
      endTime: 0n,
    });
  const rc = await tx.wait();
  const campaignId = rc!.logs
    .map((l: any) => {
      try {
        return registry.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e: any) => e && e.name === "CampaignCreated")!.args.campaignId;
  await (await registry.connect(owner).activate(campaignId)).wait();

  console.log(`  registry ${await registry.getAddress()}`);
  console.log(`  watcher  ${watcherAddr}`);

  fs.rmSync(STATE_FILE, { force: true });

  const env = {
    RPC_URL: RPC,
    REGISTRY_ADDRESS: await registry.getAddress(),
    DIAMOND_ADDRESS: await orders.getAddress(),
    WATCHER_PRIVATE_KEY: WATCHER_KEY,
    STATE_FILE,
    START_BLOCK: String(startBlock),
    CONFIRMATIONS: "0", // a local node has no reorgs to wait out
    PAYMENT_CONFIRMATIONS: "1",
    POLL_MS: "700",
    BLOCK_SPAN: "2000",
    // Short enough to keep this run quick; the property under test is that a
    // held order is not re-reported on EVERY poll, not the exact interval.
    RETRY_BACKOFF_MS: "4000",
  };

  // ── 1. discovery: an order placed BEFORE the cursor is not paid ──
  console.log("\n=== 1. an order the watcher never saw placed ===");
  // Written directly, no B2BOrderPlaced event — the watcher has no way to know.
  await (
    await orders.setOrderFull(900, alice.address, U6(1000), COMPLETED, 0, integ, await now())
  ).wait();

  let watcher = startWatcher(env);
  await sleep(4000);
  check(
    "undiscovered order is not paid",
    (await token.balanceOf(alice.address)) === 0n,
    `alice ${ethers.formatUnits(await token.balanceOf(alice.address), 6)}`
  );

  // ── 2. the happy path, through real discovery ──
  console.log("\n=== 2. placed -> completed -> discovered -> paid ===");
  await (await orders.placeB2BOrder(1, alice.address, U6(1000), 0, INR, integ)).wait();
  await (await orders.setStatus(1, COMPLETED)).wait();

  const paid1 = await until(async () => (await token.balanceOf(alice.address)) >= U6(10));
  check(
    "alice paid 1% of 1,000",
    paid1,
    `${ethers.formatUnits(await token.balanceOf(alice.address), 6)} USDC`
  );
  check("registry marked order 1 paid", await registry.orderPaid(1));

  const retired = await until(async () => {
    const s = readState();
    return s !== null && !("1" in s.pending);
  });
  check("order 1 retired from the pending set", retired);

  // ── 3. the F2 case: completion arrives LATER ──
  console.log("\n=== 3. an order that completes long after placement ===");
  await (await orders.placeB2BOrder(2, bob.address, U6(1000), 0, INR, integ)).wait();

  const held = await until(async () => {
    const s = readState();
    return s !== null && "2" in s.pending;
  });
  check("order 2 is held in the pending set while in flight", held);
  check("and is not paid yet", (await token.balanceOf(bob.address)) === 0n);

  await sleep(2500); // several polls with the order still PLACED
  await (await orders.setStatus(2, COMPLETED)).wait();

  const paid2 = await until(async () => (await token.balanceOf(bob.address)) >= U6(10));
  check(
    "order 2 pays once it completes",
    paid2,
    `bob ${ethers.formatUnits(await token.balanceOf(bob.address), 6)} USDC`
  );

  // ── 4. N1 + N6: budget-throttled order is HELD, not dropped ──
  console.log("\n=== 4. a budget-throttled order is held, then paid tomorrow ===");
  // 20.000001 daily budget; 10 + 10 already spent. A third 10 does not fit,
  // and 10 <= dailyBudget, so it must DEFER rather than pay dust.
  await (await orders.placeB2BOrder(3, alice.address, U6(1000), 0, INR, integ)).wait();
  await (await orders.setStatus(3, COMPLETED)).wait();

  const seen3 = await until(async () => {
    const s = readState();
    return s !== null && "3" in s.pending;
  });
  check("order 3 discovered", seen3);

  // AUDIT M6. Count batches across a window of many polls. Before the backoff
  // this spun without sleeping and sent a transaction per iteration; the whole
  // point of holding a declined order is that it stays cheap.
  const batchesBefore = batchCount();
  const pollsInWindow = Math.floor(6000 / 700); // ~8 polls at POLL_MS=700

  // Sample the pending set across the whole window rather than reading it once
  // at the end. `writeState` is write-then-rename, so a single read can land in
  // the rename gap and come back null — that is the reader's problem, not the
  // watcher's, and a one-shot read turns it into a spurious failure.
  let sawHeld = 0;
  let sawMissing = 0;
  for (let i = 0; i < 12; i++) {
    await sleep(500);
    const s = readState();
    if (s === null) continue; // mid-rename; not evidence either way
    if (!("3" in s.pending)) {
      // Only noisy when something is wrong — a vanished row is the thing this
      // check exists to catch, so say what the file actually held.
      console.log(
        `      sample ${i}: block ${s.lastProcessedBlock} pending ${JSON.stringify(Object.keys(s.pending))}`
      );
    }
    if ("3" in s.pending) sawHeld++;
    else sawMissing++;
  }
  const batchesSent = batchCount() - batchesBefore;
  check(
    "a held order does NOT trigger a batch on every poll",
    batchesSent < pollsInWindow,
    `${batchesSent} batches across ~${pollsInWindow} polls`
  );

  check("order 3 NOT paid dust", (await token.balanceOf(alice.address)) === U6(10));
  check("order 3 still unpaid on chain", (await registry.orderPaid(3)) === false);
  check(
    "order 3 STILL in the pending set throughout — the N1 property",
    sawHeld > 0 && sawMissing === 0,
    `held in ${sawHeld} reads, missing in ${sawMissing}`
  );

  // Roll to the next UTC day and let the same held row pay in full.
  await ethers.provider.send("evm_increaseTime", [2 * 24 * 3600]);
  await ethers.provider.send("evm_mine", []);

  const paid3 = await until(async () => (await token.balanceOf(alice.address)) >= U6(20), 30_000);
  check(
    "order 3 pays IN FULL the next day",
    paid3,
    `alice ${ethers.formatUnits(await token.balanceOf(alice.address), 6)} USDC`
  );

  // ── 5. restart safety ──
  console.log("\n=== 5. the state file survives a restart, nothing double-pays ===");
  const balBefore = await token.balanceOf(alice.address);
  await stop(watcher);

  const persisted = readState();
  check("state file exists after shutdown", persisted !== null);
  check(
    "cursor advanced past the deploy block",
    persisted !== null && persisted.lastProcessedBlock > startBlock,
    `block ${persisted?.lastProcessedBlock}`
  );

  watcher = startWatcher(env);
  await sleep(5000);
  check(
    "no double payment after restart",
    (await token.balanceOf(alice.address)) === balBefore,
    `${ethers.formatUnits(balBefore, 6)} USDC unchanged`
  );

  await stop(watcher);

  // A nonce collision means two transactions were in flight from one EOA —
  // the symptom that exposed M6. It should not happen once the loop rests.
  const nonceErrors = watcherLog.filter((l) => l.includes("nonce has already been used")).length;
  check("no nonce collisions across the whole run", nonceErrors === 0, `${nonceErrors} seen`);
  console.log(`  total batches sent: ${batchCount()}`);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  fs.rmSync(STATE_FILE, { force: true });
  if (failures > 0) process.exit(1);
}

function readState(): { lastProcessedBlock: number; pending: Record<string, unknown> } | null {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function now() {
  return (await ethers.provider.getBlock("latest"))!.timestamp;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
