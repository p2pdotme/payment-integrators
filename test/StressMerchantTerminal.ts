import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Randomised stress test: hundreds of mixed operations across several
 * merchants and several days, with the money invariants checked after EVERY
 * step.
 *
 * Operations: POS sales, link orders (fixed + variable, capped + unlimited),
 * LP accept + mark-paid, completions, Diamond cancels, USDC withdrawals, fiat
 * withdrawals through deliver / complete / cancel / reconcile / finalize,
 * freezes, a no-op Diamond, and clock jumps from minutes to days. Each op is
 * allowed to revert (a random walk hits limits, locks and freezes constantly);
 * what must never happen is an invariant breaking.
 *
 * Invariants:
 *   1. SOLVENCY      usdc.balanceOf(integrator) >= totalOwed
 *   2. BOOKKEEPING   sum of every merchant's buckets == totalOwed
 *   3. CONSERVATION  USDC across diamond + integrator + proxies + merchant
 *                    wallets == what was minted (nothing created or lost)
 *   4. LINK LIMITS   a capped link's `uses` never exceeds `maxUses`
 *   5. DAILY LIMIT   POS placements alone never push a day past the limit
 *
 * Deterministic: a fixed seed per run, so a failure replays exactly.
 */

const SECTOR = ethers.encodeBytes32String("Retail");

async function deployLibs(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of ["PaymentLinksLib", "MerchantRegistryLib", "SettlementLib"]) {
    const c = await (await ethers.getContractFactory(name)).deploy();
    await c.waitForDeployment();
    out[name] = await c.getAddress();
  }
  return out;
}

/** mulberry32 — tiny deterministic PRNG. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("Stress — merchant terminal invariants under random load", function () {
  this.timeout(600_000);

  const USDC = (n: number | string) => ethers.parseUnits(n.toString(), 6);
  const INR = ethers.encodeBytes32String("INR");
  const PK = "04" + "ab".repeat(64);
  const MINT = USDC(1_000_000);

  for (const seed of [1, 7, 2026]) {
    it(`holds every invariant for 400 random steps (seed ${seed})`, async function () {
      const rnd = prng(seed);
      const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
      const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

      const signers = await ethers.getSigners();
      const [owner] = signers;
      const merchants: SignerWithAddress[] = signers.slice(1, 4);
      const relayer = signers[4];

      const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
      const diamond = await (
        await ethers.getContractFactory("MockDiamond")
      ).deploy(await usdc.getAddress());
      const integrator: any = await (
        await ethers.getContractFactory("MerchantTerminalIntegrator", {
          libraries: await deployLibs(),
        })
      ).deploy(await diamond.getAddress(), await usdc.getAddress(), []);
      const client = await (
        await ethers.getContractFactory("SimpleERC721Client")
      ).deploy(await integrator.getAddress(), await usdc.getAddress(), "Item", "ITEM");
      await diamond.registerIntegrator(await integrator.getAddress(), await integrator.proxyImpl());
      await client.setProductPrice(1, USDC(1));
      await usdc.mint(await diamond.getAddress(), MINT);
      await diamond.setSellFee(USDC("0.1"));
      await integrator.setTrustedRelayer(relayer.address);
      await integrator.setDailyLimit(8); // small, so the limit is hit often

      type Link = { id: string; owner: SignerWithAddress; amount: bigint; maxUses: number };
      const links: Link[] = [];
      for (const [i, m] of merchants.entries()) {
        await integrator
          .connect(m)
          .registerMerchant(ethers.id(`upi${i}`), `Shop ${i}`, "INR", SECTOR);
        const variable = ethers.id(`var-${i}`);
        const capped = ethers.id(`cap-${i}`);
        await integrator.connect(m).createLink(variable, 0, INR, 0, 0, "0x");
        await integrator.connect(m).createLink(capped, USDC(2), INR, 0, 3, "0x");
        links.push({ id: variable, owner: m, amount: 0n, maxUses: 0 });
        links.push({ id: capped, owner: m, amount: USDC(2), maxUses: 3 });
      }

      type Buy = { id: bigint; link?: Link; accepted: boolean; paid: boolean };
      type Sell = {
        id: bigint;
        merchant: SignerWithAddress;
        stage: "placed" | "accepted" | "paid" | "done";
      };
      let buys: Buy[] = [];
      const sells: Sell[] = [];
      const counts: Record<string, number> = {};
      const ok = (name: string) => (counts[name] = (counts[name] ?? 0) + 1);
      const tryOp = async (name: string, f: () => Promise<any>) => {
        try {
          await f();
          ok(name);
          return true;
        } catch {
          ok(name + ":reverted");
          return false;
        }
      };

      const orderIdFrom = async (tx: any, event: string) => {
        const rc = await (await tx).wait();
        for (const l of rc.logs) {
          try {
            const p = integrator.interface.parseLog(l);
            if (p?.name === event) return p.args.orderId ?? p.args[1] ?? p.args[0];
          } catch {}
        }
        throw new Error("no " + event);
      };

      const posToday: Record<string, { day: number; n: number }> = {};

      async function checkInvariants(step: number, op: string) {
        const ia = await integrator.getAddress();
        const owed: bigint = await integrator.totalOwed();
        const held: bigint = await usdc.balanceOf(ia);
        expect(held >= owed, `step ${step} (${op}): SOLVENCY held ${held} < owed ${owed}`).to.equal(
          true
        );

        let sum = 0n;
        let wallets = 0n;
        let proxies = 0n;
        for (const m of merchants) {
          const [pending, available] = await integrator.getMerchantBalance(m.address);
          sum += pending + available;
          wallets += await usdc.balanceOf(m.address);
          proxies += await usdc.balanceOf(await integrator.proxyAddress(m.address));
        }
        expect(
          sum,
          `step ${step} (${op}): BOOKKEEPING buckets ${sum} != totalOwed ${owed}`
        ).to.equal(owed);

        const total = (await usdc.balanceOf(await diamond.getAddress())) + held + wallets + proxies;
        expect(total, `step ${step} (${op}): CONSERVATION`).to.equal(MINT);

        for (const l of links.filter((x) => x.maxUses > 0)) {
          const uses = Number((await integrator.getLink(l.id))[6]);
          expect(
            uses <= l.maxUses,
            `step ${step} (${op}): link uses ${uses} > ${l.maxUses}`
          ).to.equal(true);
        }
      }

      const ops: [number, string, () => Promise<void>][] = [
        [
          14,
          "pos",
          async () => {
            const m = pick(merchants);
            const day = Math.floor((await time.latest()) / 86400);
            const placed = await tryOp("pos", async () => {
              const id = await orderIdFrom(
                integrator.connect(m).userPlaceOrder(client.target, 1, int(1, 8), INR, 0, PK),
                "OrderPlaced"
              );
              buys.push({ id, accepted: false, paid: false });
            });
            if (placed) {
              const t = posToday[m.address];
              posToday[m.address] = t && t.day === day ? { day, n: t.n + 1 } : { day, n: 1 };
              expect(posToday[m.address].n <= 8, "DAILY LIMIT exceeded by POS alone").to.equal(
                true
              );
            }
          },
        ],
        [
          16,
          "link",
          async () => {
            const l = pick(links);
            const qty = l.amount === 0n ? int(1, 60) : 2; // variable links sometimes exceed the cap
            await tryOp("link", async () => {
              const id = await orderIdFrom(
                integrator
                  .connect(relayer)
                  .relayerPlaceOrder(l.id, client.target, 1, qty, INR, 0, PK),
                "LinkOrderPlaced"
              );
              buys.push({ id, link: l, accepted: false, paid: false });
            });
          },
        ],
        [
          10,
          "accept",
          async () => {
            const b = pick(buys.filter((x) => !x.accepted));
            if (!b) return;
            await tryOp("accept", () => diamond.simulateOrderAccepted(b.id));
            b.accepted = true;
          },
        ],
        [
          10,
          "markPaid",
          async () => {
            const b = pick(buys.filter((x) => x.link && x.accepted && !x.paid));
            if (!b) return;
            if (
              await tryOp("markPaid", () =>
                integrator.connect(relayer).relayerMarkPaid(b.link!.id, b.id)
              )
            )
              b.paid = true;
          },
        ],
        [
          14,
          "complete",
          async () => {
            const b = pick(buys);
            if (!b) return;
            await tryOp("complete", () => diamond.simulateOrderComplete(b.id));
            buys = buys.filter((x) => x !== b);
          },
        ],
        [
          8,
          "cancel",
          async () => {
            const b = pick(buys);
            if (!b) return;
            await tryOp("cancel", () => diamond.simulateOrderCancelled(b.id));
            buys = buys.filter((x) => x !== b);
          },
        ],
        [
          6,
          "relayerCancel",
          async () => {
            const b = pick(buys.filter((x) => x.link && !x.paid));
            if (!b) return;
            if (
              await tryOp("relayerCancel", () =>
                integrator.connect(relayer).relayerCancelOrder(b.link!.id, b.id)
              )
            )
              buys = buys.filter((x) => x !== b);
          },
        ],
        [
          8,
          "withdrawUSDC",
          async () => {
            const m = pick(merchants);
            const [, available] = await integrator.getMerchantBalance(m.address);
            if (available === 0n) return;
            const amt = rnd() < 0.3 ? available : (available * BigInt(int(1, 99))) / 100n + 1n;
            await tryOp("withdrawUSDC", () => integrator.connect(m).withdrawUSDC(amt));
          },
        ],
        [
          7,
          "withdrawFiat",
          async () => {
            const m = pick(merchants);
            const [, available] = await integrator.getMerchantBalance(m.address);
            if (available < USDC(1)) return;
            const amt = (available * BigInt(int(10, 80))) / 100n;
            await tryOp("withdrawFiat", async () => {
              const id = await orderIdFrom(
                integrator.connect(m).withdrawFiat(amt, 1, PK, ""),
                "WithdrawalFiat"
              );
              sells.push({ id, merchant: m, stage: "placed" });
            });
          },
        ],
        [
          8,
          "sellProgress",
          async () => {
            const s = pick(sells.filter((x) => x.stage !== "done"));
            if (!s) return;
            const r = rnd();
            if (s.stage === "placed") {
              if (r < 0.8) {
                await tryOp("sellAccept", () => diamond.acceptSellOrder(s.id, "lp"));
                s.stage = "accepted";
              } else if (await tryOp("sellCancelEarly", () => diamond.cancelSellOrder(s.id))) {
                await tryOp("reconcile", () => integrator.reconcileWithdrawal(s.id));
                s.stage = "done";
              }
            } else if (s.stage === "accepted") {
              const noop = r < 0.15; // the Diamond moves nothing (M-2 path)
              if (noop) await diamond.setForceSellUpiNoOp(true);
              if (
                await tryOp(noop ? "deliverNoop" : "deliver", () =>
                  integrator.connect(s.merchant).deliverFiatPayout(s.id, "enc")
                )
              ) {
                const st = Number((await diamond.getSellOrder(s.id)).status);
                s.stage = st === 2 ? "paid" : st === 4 ? "done" : s.stage; // SellStatus: 2 PAID, 4 CANCELLED
              }
              if (noop) await diamond.setForceSellUpiNoOp(false);
            } else if (s.stage === "paid") {
              if (r < 0.7) {
                await tryOp("sellComplete", () => diamond.completeSellOrder(s.id));
                await tryOp("finalize", () => integrator.finalizeWithdrawal(s.id));
              } else {
                await tryOp("sellClawback", () => diamond.cancelSellOrder(s.id));
                await tryOp("reconcile", () => integrator.reconcileWithdrawal(s.id));
              }
              s.stage = "done";
            }
          },
        ],
        [
          3,
          "freeze",
          async () => {
            const m = pick(merchants);
            const [, , , frozen] = await integrator.getMerchantBalance(m.address);
            await tryOp(frozen ? "unfreeze" : "freeze", () =>
              frozen ? integrator.unfreezeMerchant(m.address) : integrator.freezeMerchant(m.address)
            );
          },
        ],
        [
          8,
          "time",
          async () => {
            const r = rnd();
            await time.increase(
              r < 0.5 ? int(30, 900) : r < 0.85 ? int(3600, 6 * 3600) : int(86400, 3 * 86400)
            );
            ok("time");
          },
        ],
      ];
      const totalWeight = ops.reduce((s, o) => s + o[0], 0);

      for (let step = 0; step < 400; step++) {
        let r = rnd() * totalWeight;
        const op = ops.find((o) => (r -= o[0]) < 0)!;
        await op[2]();
        await checkInvariants(step, op[1]);
      }

      // Wind-down: finish every open fiat withdrawal, unfreeze everyone, let
      // every lock expire, drain every merchant — the books must reach zero.
      for (const s of sells.filter((x) => x.stage !== "done")) {
        if (s.stage === "placed" || s.stage === "accepted") await diamond.cancelSellOrder(s.id);
        else {
          await diamond.completeSellOrder(s.id);
          await integrator.finalizeWithdrawal(s.id);
          continue;
        }
        await integrator.reconcileWithdrawal(s.id);
      }
      for (const b of buys)
        await tryOp("windDownCancel", () => diamond.simulateOrderCancelled(b.id));
      for (const m of merchants) await integrator.unfreezeMerchant(m.address);
      await time.increase(40 * 86400);
      for (const m of merchants) {
        const [pending, available] = await integrator.getMerchantBalance(m.address);
        expect(pending).to.equal(0n);
        if (available > 0n) await integrator.connect(m).withdrawUSDC(available);
      }
      expect(await integrator.totalOwed()).to.equal(0n);
      await checkInvariants(-1, "wind-down");

      // Every operation must actually have been exercised, not just attempted.
      for (const k of [
        "pos",
        "link",
        "markPaid",
        "complete",
        "withdrawUSDC",
        "withdrawFiat",
        "deliver",
      ]) {
        expect(counts[k] ?? 0, `op ${k} never succeeded (seed ${seed})`).to.be.greaterThan(0);
      }
      // eslint-disable-next-line no-console
      console.log(`      seed ${seed}:`, JSON.stringify(counts));
    });
  }
});
