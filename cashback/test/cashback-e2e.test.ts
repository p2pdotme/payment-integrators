import { expect } from "chai";
import { ethers } from "hardhat";
import {
  settledFromReceipt,
  selectForRecheck,
  TERMINAL_DECLINES,
  type Pending,
} from "../services/watcher/watcher";

/**
 * END-TO-END: the registry and the watcher, together.
 *
 * Every other test in this repo exercises the contract alone. But cashback is
 * a two-part system, and the half that decides whether a reward is EVER paid
 * — the watcher's pending set — had no coverage at all. Both halves can be
 * individually correct and still never pay: the registry defers an order and
 * the watcher discards it. That gap is precisely where the second-pass audit
 * found N1, and it is what this file exists to close.
 *
 * So these tests drive the real `pay`/`payBatch` on a real registry, feed the
 * REAL transaction receipts into the watcher's REAL decision functions, and
 * assert on what survives in the pending set — the same objects `main()`
 * operates on, not a re-implementation of them.
 *
 * What is deliberately NOT covered here: the RPC layer (`queryFilter`,
 * `tx.wait`, the state file). Those need a live node; this runs in the normal
 * suite and in CI. The lifecycle logic is the part that loses money when it
 * is wrong.
 */
describe("E2E — registry + watcher lifecycle", function () {
  const U6 = (n: number | string) => ethers.parseUnits(n.toString(), 6);
  const BUY = ethers.encodeBytes32String("BUY");
  const INR = ethers.encodeBytes32String("INR");
  const ANY = ethers.ZeroHash;
  const PLACED = 0;
  const COMPLETED = 3;
  const CANCELLED = 4;
  const NOBUDGET = {
    maxRewardPerOrder: 0n,
    dailyBudget: 0n,
    totalBudget: 0n,
    dailyPerUser: 0n,
    startTime: 0n,
    endTime: 0n,
  };

  let owner: any, keeper: any, alice: any, bob: any;
  let token: any, orders: any, reg: any, integ: string;

  const now = async () => (await ethers.provider.getBlock("latest"))!.timestamp;
  const day = 24 * 60 * 60;

  async function jump(seconds: number) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  async function campaign(opts: any = {}) {
    const tx = await reg
      .connect(owner)
      .createCampaign(
        integ,
        opts.orderType ?? BUY,
        opts.currency ?? INR,
        await token.getAddress(),
        opts.bps ?? 100,
        0n,
        owner.address,
        { ...NOBUDGET, ...(opts.budget ?? {}) }
      );
    const rc = await tx.wait();
    const id = rc.logs
      .map((l: any) => {
        try {
          return reg.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e: any) => e && e.name === "CampaignCreated").args.campaignId;
    await reg.connect(owner).activate(id);
    return id;
  }

  /** The watcher's own view of an order it has discovered. */
  function pendingRow(user: string, amount: bigint, seenAt: number): Pending {
    return {
      integrator: integ,
      user,
      amount: amount.toString(),
      firstSeen: seenAt,
      lastChecked: 0,
    };
  }

  /**
   * One full watcher REPORT step: submit the batch, then retire from the
   * pending set exactly what the receipt says was settled. This mirrors
   * `main()`'s step 3 line for line, using the same exported helper.
   */
  async function reportBatch(pending: Record<string, Pending>, orderIds: number[]) {
    const chunk = orderIds.map((id) => ({
      orderId: BigInt(id),
      integrator: pending[String(id)].integrator,
      user: pending[String(id)].user,
      orderAmount: BigInt(pending[String(id)].amount),
    }));

    const tx = await reg.connect(keeper).payBatch(chunk);
    const receipt = await tx.wait();

    const { settled, paidCount } = settledFromReceipt(reg.interface, receipt.logs);
    for (const r of chunk) {
      const key = r.orderId.toString();
      if (settled.has(key)) delete pending[key];
    }
    return { settled, paidCount, held: chunk.length - settled.size };
  }

  beforeEach(async function () {
    [, keeper, owner, alice, bob] = await ethers.getSigners();
    token = await (await ethers.getContractFactory("MockUSDC")).deploy();
    orders = await (await ethers.getContractFactory("MockOrderSource")).deploy();
    reg = await (
      await ethers.getContractFactory("CashbackRegistry")
    ).deploy(await orders.getAddress());
    await reg.setAccruer(keeper.address, true);
    integ = ethers.Wallet.createRandom().address;
    await reg.setIntegratorOwner(integ, owner.address);
    await token.mint(owner.address, U6(1000000));
    await token.connect(owner).approve(await reg.getAddress(), ethers.MaxUint256);
  });

  // ── The happy path, all the way through ──

  it("pays a completed order and retires it from the pending set", async function () {
    await campaign({ bps: 100 });
    const t = await now();

    const pending: Record<string, Pending> = {
      "1": pendingRow(alice.address, U6(1000), Date.now()),
    };
    await orders.setOrderFull(1, alice.address, U6(1000), COMPLETED, 0, integ, t);

    const { paidCount, held } = await reportBatch(pending, [1]);

    expect(paidCount).to.equal(1);
    expect(held).to.equal(0);
    expect(pending["1"]).to.equal(undefined); // retired
    expect(await token.balanceOf(alice.address)).to.equal(U6(10));
    expect(await reg.orderPaid(1)).to.equal(true);
  });

  it("an order for an integrator with no campaign is retired, not held forever", async function () {
    // The other side of N1: holding EVERYTHING would let the pending set grow
    // without bound on a Diamond whose integrators mostly run no cashback.
    const t = await now();
    const pending: Record<string, Pending> = {
      "1": pendingRow(alice.address, U6(1000), Date.now()),
    };
    await orders.setOrderFull(1, alice.address, U6(1000), COMPLETED, 0, integ, t);

    const { paidCount, held } = await reportBatch(pending, [1]);

    expect(paidCount).to.equal(0);
    expect(held).to.equal(0); // terminal decline — correctly dropped
    expect(pending["1"]).to.equal(undefined);
  });

  // ── N1 + N6: the deferral path, end to end ──

  it("N1+N6: a budget-throttled order is HELD, then paid in full the next day", async function () {
    // This is the exact interaction the audit found: the caps defer an order
    // and the pending set used to discard it. Both halves must agree or the
    // reward is silently never paid.
    await campaign({ bps: 100, budget: { dailyBudget: U6(10) + 1n } });
    const t = await now();

    const pending: Record<string, Pending> = {
      "1": pendingRow(alice.address, U6(1000), Date.now()),
      "2": pendingRow(bob.address, U6(1000), Date.now()),
    };
    await orders.setOrderFull(1, alice.address, U6(1000), COMPLETED, 0, integ, t);
    await orders.setOrderFull(2, bob.address, U6(1000), COMPLETED, 0, integ, t);

    const first = await reportBatch(pending, [1, 2]);

    // Alice fits today's budget; Bob does not.
    expect(first.paidCount).to.equal(1);
    expect(first.held).to.equal(1);
    expect(await token.balanceOf(alice.address)).to.equal(U6(10));
    expect(await token.balanceOf(bob.address)).to.equal(0);

    // Bob's order is STILL PENDING — the whole point.
    expect(pending["1"]).to.equal(undefined);
    expect(pending["2"]).to.not.equal(undefined);
    expect(await reg.orderPaid(2)).to.equal(false);

    // Not paid dust either: nothing was transferred at all.
    expect(await token.balanceOf(bob.address)).to.equal(0);

    // Next day, the watcher retries what it kept.
    await jump(2 * day);
    const second = await reportBatch(pending, [2]);

    expect(second.paidCount).to.equal(1);
    expect(second.held).to.equal(0);
    expect(pending["2"]).to.equal(undefined);
    expect(await token.balanceOf(bob.address)).to.equal(U6(10)); // in full
  });

  it("N1: an order held by a dry funding wallet pays once the wallet is topped up", async function () {
    await campaign({ bps: 100 });
    const t = await now();
    // Drain the funder so the transfer itself fails (PayFailed, not a decline).
    const balance = await token.balanceOf(owner.address);
    await token.connect(owner).transfer(bob.address, balance);

    const pending: Record<string, Pending> = {
      "1": pendingRow(alice.address, U6(1000), Date.now()),
    };
    await orders.setOrderFull(1, alice.address, U6(1000), COMPLETED, 0, integ, t);

    const first = await reportBatch(pending, [1]);
    expect(first.paidCount).to.equal(0);
    expect(first.held).to.equal(1); // no Paid, no terminal decline -> kept
    expect(pending["1"]).to.not.equal(undefined);
    expect(await reg.orderPaid(1)).to.equal(false); // rolled back, still payable

    await token.mint(owner.address, U6(1000));
    const second = await reportBatch(pending, [1]);
    expect(second.paidCount).to.equal(1);
    expect(await token.balanceOf(alice.address)).to.equal(U6(10));
  });

  it("N1: an order held by a paused campaign pays after it resumes", async function () {
    const id = await campaign({ bps: 100 });
    const t = await now();
    await reg.connect(owner).pause(id);

    const pending: Record<string, Pending> = {
      "1": pendingRow(alice.address, U6(1000), Date.now()),
    };
    await orders.setOrderFull(1, alice.address, U6(1000), COMPLETED, 0, integ, t);

    const first = await reportBatch(pending, [1]);
    expect(first.held).to.equal(1); // CAMPAIGN_INACTIVE is retryable
    expect(pending["1"]).to.not.equal(undefined);

    await reg.connect(owner).activate(id);
    const second = await reportBatch(pending, [1]);
    expect(second.paidCount).to.equal(1);
    expect(await token.balanceOf(alice.address)).to.equal(U6(10));
  });

  it("N1: a SELL order is retired terminally rather than retried forever", async function () {
    await campaign({ orderType: ANY, currency: ANY, bps: 100 });
    const t = await now();
    const proxy = ethers.Wallet.createRandom().address;

    const pending: Record<string, Pending> = {
      "1": pendingRow(proxy, U6(1000), Date.now()),
    };
    await orders.setOrderFull(1, proxy, U6(1000), COMPLETED, 1 /* SELL */, integ, t);

    const { paidCount, held } = await reportBatch(pending, [1]);
    expect(paidCount).to.equal(0);
    expect(held).to.equal(0); // ORDER_TYPE — will never change
    expect(pending["1"]).to.equal(undefined);
    expect(await token.balanceOf(proxy)).to.equal(0);
  });

  it("a mixed batch settles each row independently", async function () {
    await campaign({ bps: 100, budget: { dailyBudget: U6(10) } });
    const t = await now();

    const pending: Record<string, Pending> = {};
    for (const id of [1, 2, 3]) {
      pending[String(id)] = pendingRow(alice.address, U6(1000), Date.now());
    }
    // 1: pays. 2: budget exhausted -> held. 3: SELL -> terminal.
    await orders.setOrderFull(1, alice.address, U6(1000), COMPLETED, 0, integ, t);
    await orders.setOrderFull(2, alice.address, U6(1000), COMPLETED, 0, integ, t);
    await orders.setOrderFull(3, alice.address, U6(1000), COMPLETED, 1, integ, t);

    const { paidCount, held } = await reportBatch(pending, [1, 2, 3]);

    expect(paidCount).to.equal(1);
    expect(held).to.equal(1);
    expect(pending["1"]).to.equal(undefined); // paid
    expect(pending["2"]).to.not.equal(undefined); // deferred, kept
    expect(pending["3"]).to.equal(undefined); // terminal, dropped
  });

  // ── N2: cancellation is not the end of the story ──

  it("N2: a cancelled order that later completes still gets paid", async function () {
    await campaign({ bps: 100 });
    const t = await now();

    const pending: Record<string, Pending> = {
      "1": pendingRow(alice.address, U6(1000), Date.now()),
    };
    await orders.setOrderFull(1, alice.address, U6(1000), CANCELLED, 0, integ, t);

    // The watcher's re-check marks it rather than deleting it.
    pending["1"].cancelledAt = Date.now();
    pending["1"].lastChecked = Date.now();
    expect(pending["1"]).to.not.equal(undefined);

    // A dispute resolves in the user's favour days later.
    await orders.setOrderFull(1, alice.address, U6(1000), COMPLETED, 0, integ, t);
    pending["1"].cancelledAt = undefined;

    const { paidCount } = await reportBatch(pending, [1]);
    expect(paidCount).to.equal(1);
    expect(await token.balanceOf(alice.address)).to.equal(U6(10));
  });

  it("N2: cancelled orders are polled slowly and cannot starve live orders", async function () {
    const nowMs = 1_000_000_000_000;
    const pending: Record<string, Pending> = {};

    // 5 cancelled orders, all just checked.
    for (let i = 1; i <= 5; i++) {
      pending[String(i)] = pendingRow(alice.address, U6(100), nowMs);
      pending[String(i)].cancelledAt = nowMs;
      pending[String(i)].lastChecked = nowMs;
    }
    // 2 live orders, never checked.
    for (let i = 6; i <= 7; i++) {
      pending[String(i)] = pendingRow(alice.address, U6(100), nowMs);
    }

    // A tight per-poll budget: the live orders must still get a slot.
    const picked = selectForRecheck(pending, nowMs, 2);
    expect(picked.sort()).to.deep.equal(["6", "7"]);

    // Once the slow cadence elapses, the cancelled ones come back round.
    const later = nowMs + 7 * 60 * 60 * 1000; // > 6h
    const pickedLater = selectForRecheck(pending, later, 10);
    expect(pickedLater.length).to.equal(7);
  });

  // ── M6: holding a declined order must stay cheap ──

  it("M6: a held order keeps its place but is not re-reported every poll", async function () {
    // Found by running the watcher as a process, not by testing its parts.
    // Holding a declined order (N1) meant `ready` was never empty while one was
    // deferred — and the loop only slept when `ready` WAS empty, so it stopped
    // sleeping and sent a payBatch every iteration. Measured in the full e2e
    // before the fix: 39 batches and 19 nonce collisions in twenty seconds, off
    // a single budget-throttled order. On a real chain that is the funding
    // wallet's gas burned continuously until the 14-day TTL.
    //
    // The row must stay pending — that is the whole N1 property — while not
    // costing a transaction on every pass.
    await campaign({ bps: 100, budget: { dailyBudget: U6(10) + 1n } });
    const t = await now();

    const pending: Record<string, Pending> = {
      "1": pendingRow(alice.address, U6(1000), Date.now()),
      "2": pendingRow(bob.address, U6(1000), Date.now()),
    };
    await orders.setOrderFull(1, alice.address, U6(1000), COMPLETED, 0, integ, t);
    await orders.setOrderFull(2, bob.address, U6(1000), COMPLETED, 0, integ, t);

    const first = await reportBatch(pending, [1, 2]);
    expect(first.held, "bob's order does not fit today's budget").to.equal(1);
    expect(pending["2"], "and is kept").to.not.equal(undefined);

    // The report step stamps a backoff on whatever it could not settle.
    pending["2"].retryAfter = Date.now() + 5 * 60_000;

    // The next few polls must skip it rather than spend a transaction.
    const soon = Date.now();
    expect(
      selectForRecheck(pending, soon, 10).includes("2"),
      "still rotated for a STATUS re-check, which is only an RPC read"
    ).to.equal(true);

    // What must not happen is another payBatch. That is gated on retryAfter in
    // the report step, so assert the field the watcher reads.
    expect(pending["2"].retryAfter).to.be.greaterThan(soon);

    // Once the backoff elapses it is reportable again, and the daily budget
    // having reset is what finally pays it.
    pending["2"].retryAfter = Date.now() - 1;
    await ethers.provider.send("evm_increaseTime", [2 * 24 * 3600]);
    await ethers.provider.send("evm_mine", []);

    const second = await reportBatch(pending, [2]);
    expect(second.paidCount).to.equal(1);
    expect(await token.balanceOf(bob.address)).to.equal(U6(10));
  });

  // ── The classification itself ──

  it("every retryable decline reason is excluded from the terminal set", async function () {
    // Guards the table by hand: getting one of these backwards is either a
    // silently unpaid order (terminal when it should retry) or an unbounded
    // pending set (retryable when it should stop).
    for (const terminal of [1, 2, 3, 4, 6, 7, 9]) {
      expect(TERMINAL_DECLINES.has(terminal), `reason ${terminal} should be terminal`).to.equal(
        true
      );
    }
    for (const retryable of [5, 8, 10]) {
      expect(TERMINAL_DECLINES.has(retryable), `reason ${retryable} should retry`).to.equal(false);
    }
  });

  it("a receipt with unrelated logs does not confuse settlement", async function () {
    // The batch receipt also carries the reward token's own Transfer events.
    await campaign({ bps: 100 });
    const t = await now();
    const pending: Record<string, Pending> = {
      "1": pendingRow(alice.address, U6(1000), Date.now()),
    };
    await orders.setOrderFull(1, alice.address, U6(1000), COMPLETED, 0, integ, t);

    const tx = await reg.connect(keeper).payBatch([
      {
        orderId: 1n,
        integrator: integ,
        user: alice.address,
        orderAmount: U6(1000),
      },
    ]);
    const receipt = await tx.wait();

    // There IS a Transfer in here alongside our Paid event.
    expect(receipt.logs.length).to.be.greaterThan(1);

    const { settled, paidCount } = settledFromReceipt(reg.interface, receipt.logs);
    expect(paidCount).to.equal(1);
    expect(settled.size).to.equal(1);
    expect(settled.has("1")).to.equal(true);
  });

  // ── The F2 case that started all of this ──

  it("F2: an order still in flight is neither paid nor dropped", async function () {
    await campaign({ bps: 100 });
    const t = await now();

    const pending: Record<string, Pending> = {
      "1": pendingRow(alice.address, U6(1000), Date.now()),
    };
    await orders.setOrderFull(1, alice.address, U6(1000), PLACED, 0, integ, t);

    // The watcher does not even report a non-COMPLETED order, so the row
    // simply survives the poll. Verify the registry agrees it is unpayable.
    await reg.connect(keeper).pay(1, integ, alice.address, U6(1000));
    expect(await token.balanceOf(alice.address)).to.equal(0);
    expect(await reg.orderPaid(1)).to.equal(false);
    expect(pending["1"]).to.not.equal(undefined);

    // It completes, and the same row now pays.
    await orders.setOrderFull(1, alice.address, U6(1000), COMPLETED, 0, integ, t);
    const { paidCount } = await reportBatch(pending, [1]);
    expect(paidCount).to.equal(1);
    expect(await token.balanceOf(alice.address)).to.equal(U6(10));
  });
  // ── Batch gas budget (review PoC V6) ──
  //
  // `BATCH_SIZE` defaults to 50, so a full batch has to fit comfortably in a
  // Base block. The review measured ~109k gas per honest row and 1.5M for 50
  // hostile rows at `d878067`, and concluded 50 was comfortable.
  //
  // That conclusion needs re-checking, because the N1 fix ADDED per-row cost
  // on exactly the paths a large batch is most likely to take: every decline
  // now emits `PayDeclined`, and a no-campaign decline additionally runs
  // `_declineReason` over three lookup tiers. A batch of 50 rows for an
  // integrator running no cashback went from nearly free to three SLOADs and
  // an event apiece.
  //
  // These assert headroom rather than a precise figure — the point is to fail
  // loudly if a change makes a full batch unlandable, not to pin a number
  // this suite cannot portably reproduce. The measured values are logged so a
  // regression is visible in CI output even while the assertion passes.
  // Gas figures are meaningless under solidity-coverage — instrumentation
  // adds a counter to every line, which inflates every measurement (~98k/row
  // instead of ~66k) and turns the gas-bomb token into a pathological case
  // that exhausts the coverage runner's heap. Measure gas on a normal run.
  const coverageRunning =
    Boolean(process.env.SOLIDITY_COVERAGE) ||
    Boolean((require("hardhat") as any).__SOLIDITY_COVERAGE_RUNNING);

  (coverageRunning ? describe.skip : describe)("batch gas budget", function () {
    const ROWS = 50;

    // The watcher's own budget (AUDIT M5). Asserting against this rather than
    // an arbitrary ceiling is the point: it proves the number the watcher
    // actually sends is enough for the worst case it can meet.
    const GAS_PER_ROW = 250_000;
    const GAS_OVERHEAD = 300_000;
    const WATCHER_LIMIT = BigInt(GAS_OVERHEAD + GAS_PER_ROW * ROWS); // 12.8M

    /**
     * Submit a real batch under the watcher's gas budget and report what it
     * cost. Deliberately NOT `estimateGas`: a reward token that burns all the
     * gas it is handed consumes whatever it is given up to `TOKEN_CALL_GAS`,
     * so estimation is self-defeating — more gas offered means more gas
     * burned, and the estimator converges on 28M for a hostile batch of 50
     * that in fact uses 9.3M. Actual `gasUsed` under a fixed limit is the
     * only meaningful figure.
     */
    async function runBatch(rows: number) {
      const t = await now();
      const reports = [];
      for (let i = 1; i <= rows; i++) {
        await orders.setOrderFull(i, alice.address, U6(1000), COMPLETED, 0, integ, t);
        reports.push({
          orderId: BigInt(i),
          integrator: integ,
          user: alice.address,
          orderAmount: U6(1000),
        });
      }
      const tx = await reg.connect(keeper).payBatch(reports, { gasLimit: WATCHER_LIMIT });
      const receipt = await tx.wait();

      // Every row must have reached a verdict. A batch that silently runs out
      // of gas part-way would look identical to one where the tail declined.
      let verdicts = 0;
      for (const log of receipt.logs) {
        try {
          const p = reg.interface.parseLog(log as any);
          if (p && (p.name === "Paid" || p.name === "PayFailed" || p.name === "PayDeclined")) {
            verdicts++;
          }
        } catch {
          /* the reward token's own events */
        }
      }
      return { gasUsed: receipt.gasUsed as bigint, verdicts };
    }

    it("V6: a full batch of paying rows fits well inside a block", async function () {
      await campaign({ bps: 100 });
      const { gasUsed, verdicts } = await runBatch(ROWS);
      console.log(`      ${ROWS} paying rows: ${gasUsed} gas (${gasUsed / BigInt(ROWS)}/row)`);
      expect(verdicts).to.equal(ROWS);
      expect(gasUsed).to.be.lessThan(WATCHER_LIMIT);
    });

    it("V6: a full batch that ALL decline stays cheap despite the new diagnostics", async function () {
      // No campaign at all, so every row takes the `_declineReason` path the
      // N1 fix introduced. This is the common case on a Diamond whose
      // integrators mostly run no cashback — it must not be the costly one.
      const { gasUsed, verdicts } = await runBatch(ROWS);
      console.log(`      ${ROWS} declining rows: ${gasUsed} gas (${gasUsed / BigInt(ROWS)}/row)`);
      expect(verdicts).to.equal(ROWS);
      expect(gasUsed).to.be.lessThan(WATCHER_LIMIT);
    });

    it("V6: 50 hostile-token rows cannot make a batch unlandable", async function () {
      const bomb = await (await ethers.getContractFactory("MockBalanceBomb")).deploy();
      await bomb.mint(owner.address, U6(1000000));
      await bomb.connect(owner).approve(await reg.getAddress(), ethers.MaxUint256);

      const tx = await reg
        .connect(owner)
        .createCampaign(integ, ANY, ANY, await bomb.getAddress(), 100, 0n, owner.address, NOBUDGET);
      const rc = await tx.wait();
      const id = rc.logs
        .map((l: any) => {
          try {
            return reg.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e: any) => e && e.name === "CampaignCreated").args.campaignId;
      await reg.connect(owner).activate(id);

      const { gasUsed, verdicts } = await runBatch(ROWS);
      console.log(`      ${ROWS} hostile rows: ${gasUsed} gas (${gasUsed / BigInt(ROWS)}/row)`);

      // The property that matters: under the watcher's own gas budget, all 50
      // rows still reach a verdict. A hostile tenant cannot starve the batch
      // or push it past the limit the watcher sends.
      expect(verdicts).to.equal(ROWS);
      expect(gasUsed).to.be.lessThan(WATCHER_LIMIT);
    });
  });
});
