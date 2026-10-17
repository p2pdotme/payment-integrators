import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const USDC = (n: number | string) => ethers.parseUnits(n.toString(), 6);
const ANY = ethers.ZeroHash;
const BUY = ethers.encodeBytes32String("BUY");
const SELL = ethers.encodeBytes32String("SELL");
const INR = ethers.encodeBytes32String("INR");
const BRL = ethers.encodeBytes32String("BRL");

// Diamond order statuses
const PLACED = 0;
const COMPLETED = 3;
const CANCELLED = 4;

enum Status {
  INACTIVE,
  ACTIVE,
  PAUSED,
  ENDED,
}

describe("CashbackRegistry", function () {
  let deployer: SignerWithAddress;
  let funder: SignerWithAddress;
  let watcher: SignerWithAddress;
  let user: SignerWithAddress;
  let other: SignerWithAddress;
  let stranger: SignerWithAddress;

  let token: any;
  let orders: any;
  let registry: any;

  // A stand-in integrator address. The registry only ever uses it as a
  // lookup key — it is never called — so a plain address is sufficient.
  let integrator: string;

  beforeEach(async function () {
    [deployer, funder, watcher, user, other, stranger] = await ethers.getSigners();
    integrator = ethers.Wallet.createRandom().address;

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    token = await MockUSDC.deploy();

    const MockOrderSource = await ethers.getContractFactory("MockOrderSource");
    orders = await MockOrderSource.deploy();

    const Registry = await ethers.getContractFactory("CashbackRegistry");
    registry = await Registry.deploy(await orders.getAddress());

    await registry.setAccruer(watcher.address, true);
    // One setup call per integrator: assign its cashback owner. After this
    // `funder` is fully self-service for this integrator.
    await registry.setIntegratorOwner(integrator, funder.address);

    // Fund the wallet and approve the registry — the operator's one-time setup.
    await token.mint(funder.address, USDC(1_000_000));
    await token.connect(funder).approve(await registry.getAddress(), ethers.MaxUint256);
  });

  // Helper: create + activate a campaign in one step.
  async function makeCampaign(opts: {
    orderType?: string;
    currency?: string;
    bps?: number;
    flat?: bigint;
    integratorAddr?: string;
    activate?: boolean;
    as?: any;
  }) {
    const tx = await registry
      .connect(opts.as ?? funder)
      .createCampaign(
        opts.integratorAddr ?? integrator,
        opts.orderType ?? BUY,
        opts.currency ?? INR,
        await token.getAddress(),
        opts.bps ?? 0,
        opts.flat ?? 0n,
        (opts.as ?? funder).address,
        {
          maxRewardPerOrder: 0,
          dailyBudget: 0,
          totalBudget: 0,
          dailyPerUser: 0,
          startTime: 0,
          endTime: 0,
        }
      );
    const receipt = await tx.wait();
    const ev = receipt.logs
      .map((l: any) => {
        try {
          return registry.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e: any) => e && e.name === "CampaignCreated");
    const id = ev.args.campaignId;
    if (opts.activate !== false) await registry.connect(opts.as ?? funder).activate(id);
    return id;
  }

  // Helper: record a COMPLETED order on the mock Diamond.
  async function completedOrder(orderId: number, who: string, amount: bigint, intg?: string) {
    // Orders are now bound to the integrator that placed them (audit F1),
    // and carry a placement time (F7).
    await orders.setOrderFull(orderId, who, amount, COMPLETED, 0, intg ?? integrator, 0);
  }

  // ─── Creating campaigns ────────────────────────────────────────────

  describe("createCampaign", function () {
    it("rejects an unclaimed integrator", async function () {
      const unclaimed = ethers.Wallet.createRandom().address;
      await expect(
        registry
          .connect(funder)
          .createCampaign(unclaimed, BUY, INR, await token.getAddress(), 100, 0, funder.address, {
            maxRewardPerOrder: 0,
            dailyBudget: 0,
            totalBudget: 0,
            dailyPerUser: 0,
            startTime: 0,
            endTime: 0,
          })
      ).to.be.revertedWithCustomError(registry, "IntegratorUnclaimed");
    });

    it("rejects a zero reward token or funding wallet", async function () {
      await expect(
        registry
          .connect(funder)
          .createCampaign(integrator, BUY, INR, ethers.ZeroAddress, 100, 0, funder.address, {
            maxRewardPerOrder: 0,
            dailyBudget: 0,
            totalBudget: 0,
            dailyPerUser: 0,
            startTime: 0,
            endTime: 0,
          })
      ).to.be.revertedWithCustomError(registry, "InvalidAddress");

      await expect(
        registry
          .connect(funder)
          .createCampaign(
            integrator,
            BUY,
            INR,
            await token.getAddress(),
            100,
            0,
            ethers.ZeroAddress,
            {
              maxRewardPerOrder: 0,
              dailyBudget: 0,
              totalBudget: 0,
              dailyPerUser: 0,
              startTime: 0,
              endTime: 0,
            }
          )
      ).to.be.revertedWithCustomError(registry, "InvalidAddress");
    });

    it("rejects both bps and flatAmount set", async function () {
      await expect(
        registry
          .connect(funder)
          .createCampaign(
            integrator,
            BUY,
            INR,
            await token.getAddress(),
            100,
            USDC(1),
            funder.address,
            {
              maxRewardPerOrder: 0,
              dailyBudget: 0,
              totalBudget: 0,
              dailyPerUser: 0,
              startTime: 0,
              endTime: 0,
            }
          )
      ).to.be.revertedWithCustomError(registry, "InvalidRate");
    });

    it("rejects neither bps nor flatAmount set", async function () {
      await expect(
        registry
          .connect(funder)
          .createCampaign(integrator, BUY, INR, await token.getAddress(), 0, 0, funder.address, {
            maxRewardPerOrder: 0,
            dailyBudget: 0,
            totalBudget: 0,
            dailyPerUser: 0,
            startTime: 0,
            endTime: 0,
          })
      ).to.be.revertedWithCustomError(registry, "InvalidRate");
    });

    it("rejects a rate above MAX_BPS", async function () {
      const max = await registry.MAX_BPS();
      await expect(
        registry
          .connect(funder)
          .createCampaign(
            integrator,
            BUY,
            INR,
            await token.getAddress(),
            max + 1n,
            0,
            funder.address,
            {
              maxRewardPerOrder: 0,
              dailyBudget: 0,
              totalBudget: 0,
              dailyPerUser: 0,
              startTime: 0,
              endTime: 0,
            }
          )
      ).to.be.revertedWithCustomError(registry, "InvalidRate");
    });

    it("starts INACTIVE and does not pay until activated", async function () {
      const id = await makeCampaign({ bps: 100, activate: false });
      expect((await registry.getCampaign(id)).status).to.equal(Status.INACTIVE);

      await completedOrder(1, user.address, USDC(100));
      await registry.connect(watcher).pay(1, integrator, user.address, USDC(100));

      expect(await token.balanceOf(user.address)).to.equal(0);
      expect(await registry.orderPaid(1)).to.equal(false);
    });

    it("only the integrator owner may create campaigns", async function () {
      await expect(
        registry
          .connect(stranger)
          .createCampaign(
            integrator,
            BUY,
            INR,
            await token.getAddress(),
            100,
            0,
            stranger.address,
            {
              maxRewardPerOrder: 0,
              dailyBudget: 0,
              totalBudget: 0,
              dailyPerUser: 0,
              startTime: 0,
              endTime: 0,
            }
          )
      ).to.be.revertedWithCustomError(registry, "OnlyIntegratorOwner");
    });
  });

  // ─── Lifecycle ─────────────────────────────────────────────────────

  describe("lifecycle", function () {
    it("walks INACTIVE → ACTIVE → PAUSED → ACTIVE → ENDED", async function () {
      const id = await makeCampaign({ bps: 100, activate: false });

      await registry.connect(funder).activate(id);
      expect((await registry.getCampaign(id)).status).to.equal(Status.ACTIVE);

      await registry.connect(funder).pause(id);
      expect((await registry.getCampaign(id)).status).to.equal(Status.PAUSED);

      await registry.connect(funder).activate(id);
      expect((await registry.getCampaign(id)).status).to.equal(Status.ACTIVE);

      await registry.connect(funder).end(id);
      expect((await registry.getCampaign(id)).status).to.equal(Status.ENDED);
    });

    it("ENDED is terminal — cannot be reactivated", async function () {
      const id = await makeCampaign({ bps: 100 });
      await registry.connect(funder).end(id);
      await expect(registry.connect(funder).activate(id)).to.be.revertedWithCustomError(
        registry,
        "CampaignEnded"
      );
    });

    it("rejects a second ACTIVE campaign on the same lookup key", async function () {
      await makeCampaign({ bps: 100 });
      const second = await makeCampaign({ bps: 200, activate: false });
      await expect(registry.connect(funder).activate(second)).to.be.revertedWithCustomError(
        registry,
        "CampaignSlotTaken"
      );
    });

    it("frees the lookup slot on pause, so a replacement can take it", async function () {
      const first = await makeCampaign({ bps: 100 });
      await registry.connect(funder).pause(first);

      const second = await makeCampaign({ bps: 200, activate: false });
      await expect(registry.connect(funder).activate(second)).to.not.be.reverted;
    });

    it("a paused campaign stops paying", async function () {
      const id = await makeCampaign({ bps: 100 });
      await registry.connect(funder).pause(id);

      await completedOrder(1, user.address, USDC(100));
      await registry.connect(watcher).pay(1, integrator, user.address, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(0);
    });

    it("setRate retunes a running campaign", async function () {
      const id = await makeCampaign({ bps: 100 });

      await completedOrder(1, user.address, USDC(100));
      await registry.connect(watcher).pay(1, integrator, user.address, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(USDC(1)); // 1%

      await registry.connect(funder).setRate(id, 200, 0); // bump to 2%

      await completedOrder(2, user.address, USDC(100));
      await registry.connect(watcher).pay(2, integrator, user.address, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(USDC(3)); // 1 + 2
    });

    it("setRate rejects a rate above the ceiling", async function () {
      const id = await makeCampaign({ bps: 100 });
      const max = await registry.MAX_BPS();
      await expect(registry.connect(funder).setRate(id, max + 1n, 0)).to.be.revertedWithCustomError(
        registry,
        "InvalidRate"
      );
    });

    it("only the integrator owner may pause", async function () {
      const id = await makeCampaign({ bps: 100 });
      await expect(registry.connect(stranger).pause(id)).to.be.revertedWithCustomError(
        registry,
        "OnlyIntegratorOwner"
      );
    });

    it("unknown campaign reverts", async function () {
      await expect(
        registry.connect(funder).activate(ethers.ZeroHash)
      ).to.be.revertedWithCustomError(registry, "UnknownCampaign");
    });
  });

  // ─── Resolution ────────────────────────────────────────────────────

  describe("campaign resolution", function () {
    it("exact match wins over the ANY fallbacks", async function () {
      await makeCampaign({ orderType: BUY, currency: ANY, bps: 100 }); // 1% any currency
      await makeCampaign({ orderType: BUY, currency: INR, bps: 500 }); // 5% INR

      await completedOrder(1, user.address, USDC(100));
      await registry.connect(watcher).pay(1, integrator, user.address, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(USDC(5)); // exact INR row
    });

    it("falls back to (orderType, ANY) for an unlisted currency", async function () {
      await makeCampaign({ orderType: BUY, currency: ANY, bps: 100 });

      await completedOrder(1, user.address, USDC(100));
      await registry.connect(watcher).pay(1, integrator, user.address, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(USDC(1));
    });

    it("falls back to the integrator-wide default", async function () {
      await makeCampaign({ orderType: ANY, currency: ANY, bps: 100 });

      await completedOrder(1, user.address, USDC(100));
      await registry.connect(watcher).pay(1, integrator, user.address, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(USDC(1));
    });

    it("an unknown integrator pays nothing and does not revert", async function () {
      await makeCampaign({ bps: 100 });
      const strangerIntegrator = ethers.Wallet.createRandom().address;

      await completedOrder(1, user.address, USDC(100));
      await expect(registry.connect(watcher).pay(1, strangerIntegrator, user.address, USDC(100))).to
        .not.be.reverted;
      expect(await token.balanceOf(user.address)).to.equal(0);
    });
  });

  // ─── Reward maths ──────────────────────────────────────────────────

  describe("reward calculation", function () {
    it("pays a percentage of the order", async function () {
      await makeCampaign({ bps: 100 }); // 1%
      await completedOrder(1, user.address, USDC(100));
      await registry.connect(watcher).pay(1, integrator, user.address, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(USDC(1));
    });

    it("pays a flat amount regardless of order size", async function () {
      await makeCampaign({ flat: USDC(5) });

      await completedOrder(1, user.address, USDC(100));
      await registry.connect(watcher).pay(1, integrator, user.address, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(USDC(5));

      await completedOrder(2, other.address, USDC(10_000));
      await registry.connect(watcher).pay(2, integrator, other.address, USDC(10_000));
      expect(await token.balanceOf(other.address)).to.equal(USDC(5));
    });

    it("rounds down (never overpays)", async function () {
      await makeCampaign({ bps: 250 }); // 2.5%
      // 1 micro-USDC * 250 / 10000 = 0.025 → floors to 0 → nothing paid
      await completedOrder(1, user.address, 1n);
      await registry.connect(watcher).pay(1, integrator, user.address, 1n);
      expect(await token.balanceOf(user.address)).to.equal(0);
      expect(await registry.orderPaid(1)).to.equal(false);
    });

    it("quote() previews without paying", async function () {
      await makeCampaign({ bps: 100 });
      const [, reward] = await registry.quote(integrator, BUY, INR, USDC(100));
      expect(reward).to.equal(USDC(1));
      expect(await token.balanceOf(user.address)).to.equal(0);
    });
  });

  // ─── Guards / trust boundary ───────────────────────────────────────

  describe("guards", function () {
    beforeEach(async function () {
      await makeCampaign({ bps: 100 });
    });

    it("pays each order only once", async function () {
      await completedOrder(1, user.address, USDC(100));
      await registry.connect(watcher).pay(1, integrator, user.address, USDC(100));
      await registry.connect(watcher).pay(1, integrator, user.address, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(USDC(1));
    });

    it("pays nothing for an order that is not COMPLETED", async function () {
      await orders.setOrderFull(1, user.address, USDC(100), PLACED, 0, integrator, 0);
      await registry.connect(watcher).pay(1, integrator, user.address, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(0);

      await orders.setOrderFull(2, user.address, USDC(100), CANCELLED, 0, integrator, 0);
      await registry.connect(watcher).pay(2, integrator, user.address, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(0);
    });

    it("pays nothing for an order that does not exist", async function () {
      await registry.connect(watcher).pay(99, integrator, user.address, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(0);
    });

    it("rejects a mismatched user — a lying watcher cannot redirect funds", async function () {
      await completedOrder(1, user.address, USDC(100));
      // Watcher claims the reward belongs to `other`.
      await registry.connect(watcher).pay(1, integrator, other.address, USDC(100));
      expect(await token.balanceOf(other.address)).to.equal(0);
      expect(await token.balanceOf(user.address)).to.equal(0);
    });

    it("rejects a mismatched amount — a lying watcher cannot inflate rewards", async function () {
      await completedOrder(1, user.address, USDC(100));
      // Watcher claims the order was for 1,000,000 rather than 100.
      await registry.connect(watcher).pay(1, integrator, user.address, USDC(1_000_000));
      expect(await token.balanceOf(user.address)).to.equal(0);
    });

    it("fails closed when the Diamond is unreachable", async function () {
      await completedOrder(1, user.address, USDC(100));
      await orders.setReverting(true);
      await expect(registry.connect(watcher).pay(1, integrator, user.address, USDC(100))).to.not.be
        .reverted;
      expect(await token.balanceOf(user.address)).to.equal(0);
    });

    it("rejects a caller that is not an allowlisted watcher", async function () {
      await completedOrder(1, user.address, USDC(100));
      await expect(
        registry.connect(stranger).pay(1, integrator, user.address, USDC(100))
      ).to.be.revertedWithCustomError(registry, "OnlyAccruer");
    });

    it("a revoked watcher can no longer report", async function () {
      await registry.setAccruer(watcher.address, false);
      await completedOrder(1, user.address, USDC(100));
      await expect(
        registry.connect(watcher).pay(1, integrator, user.address, USDC(100))
      ).to.be.revertedWithCustomError(registry, "OnlyAccruer");
    });
  });

  // ─── Payment failure handling ──────────────────────────────────────

  describe("payment failures", function () {
    it("rolls back and emits PayFailed when the funding wallet is empty", async function () {
      await makeCampaign({ bps: 100 });

      // Drain the funding wallet.
      const bal = await token.balanceOf(funder.address);
      await token.connect(funder).transfer(stranger.address, bal);

      await completedOrder(1, user.address, USDC(100));
      await expect(registry.connect(watcher).pay(1, integrator, user.address, USDC(100))).to.emit(
        registry,
        "PayFailed"
      );

      // Crucially: the order stays unpaid, so it can be retried.
      expect(await registry.orderPaid(1)).to.equal(false);
      expect(await token.balanceOf(user.address)).to.equal(0);
    });

    it("succeeds on retry after the wallet is topped up", async function () {
      await makeCampaign({ bps: 100 });

      const bal = await token.balanceOf(funder.address);
      await token.connect(funder).transfer(stranger.address, bal);

      await completedOrder(1, user.address, USDC(100));
      await registry.connect(watcher).pay(1, integrator, user.address, USDC(100));
      expect(await registry.orderPaid(1)).to.equal(false);

      // Top up, retry.
      await token.mint(funder.address, USDC(100));
      await expect(registry.connect(watcher).pay(1, integrator, user.address, USDC(100))).to.emit(
        registry,
        "Paid"
      );
      expect(await token.balanceOf(user.address)).to.equal(USDC(1));
    });

    it("revoking the approval halts payouts (the kill switch)", async function () {
      await makeCampaign({ bps: 100 });
      await token.connect(funder).approve(await registry.getAddress(), 0);

      await completedOrder(1, user.address, USDC(100));
      await expect(registry.connect(watcher).pay(1, integrator, user.address, USDC(100))).to.emit(
        registry,
        "PayFailed"
      );
      expect(await token.balanceOf(user.address)).to.equal(0);
    });

    it("handles a token whose transferFrom reverts", async function () {
      const Bad = await ethers.getContractFactory("MockBadToken");
      const bad = await Bad.deploy(0); // REVERT mode

      const tx = await registry
        .connect(funder)
        .createCampaign(integrator, BUY, INR, await bad.getAddress(), 100, 0, funder.address, {
          maxRewardPerOrder: 0,
          dailyBudget: 0,
          totalBudget: 0,
          dailyPerUser: 0,
          startTime: 0,
          endTime: 0,
        });
      const receipt = await tx.wait();
      const id = receipt.logs
        .map((l: any) => {
          try {
            return registry.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e: any) => e && e.name === "CampaignCreated").args.campaignId;
      await registry.connect(funder).activate(id);

      await completedOrder(1, user.address, USDC(100));
      await expect(registry.connect(watcher).pay(1, integrator, user.address, USDC(100))).to.emit(
        registry,
        "PayFailed"
      );
      expect(await registry.orderPaid(1)).to.equal(false);
    });

    it("handles a token whose transferFrom returns false without reverting", async function () {
      const Bad = await ethers.getContractFactory("MockBadToken");
      const bad = await Bad.deploy(1); // RETURN_FALSE mode

      const tx = await registry
        .connect(funder)
        .createCampaign(integrator, BUY, INR, await bad.getAddress(), 100, 0, funder.address, {
          maxRewardPerOrder: 0,
          dailyBudget: 0,
          totalBudget: 0,
          dailyPerUser: 0,
          startTime: 0,
          endTime: 0,
        });
      const receipt = await tx.wait();
      const id = receipt.logs
        .map((l: any) => {
          try {
            return registry.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e: any) => e && e.name === "CampaignCreated").args.campaignId;
      await registry.connect(funder).activate(id);

      await completedOrder(1, user.address, USDC(100));
      await expect(registry.connect(watcher).pay(1, integrator, user.address, USDC(100))).to.emit(
        registry,
        "PayFailed"
      );
      // The order must NOT be marked paid when no tokens actually moved.
      expect(await registry.orderPaid(1)).to.equal(false);
    });
  });

  // ─── Batch ─────────────────────────────────────────────────────────

  describe("payBatch", function () {
    it("pays every qualifying row", async function () {
      await makeCampaign({ bps: 100 });

      await completedOrder(1, user.address, USDC(100));
      await completedOrder(2, other.address, USDC(200));

      await registry.connect(watcher).payBatch([
        {
          orderId: 1,
          integrator,
          user: user.address,
          orderType: BUY,
          currency: INR,
          orderAmount: USDC(100),
        },
        {
          orderId: 2,
          integrator,
          user: other.address,
          orderType: BUY,
          currency: INR,
          orderAmount: USDC(200),
        },
      ]);

      expect(await token.balanceOf(user.address)).to.equal(USDC(1));
      expect(await token.balanceOf(other.address)).to.equal(USDC(2));
    });

    it("one bad row does not stop the rest of the batch", async function () {
      await makeCampaign({ bps: 100 });

      await completedOrder(1, user.address, USDC(100));
      // order 2 is never recorded on the Diamond → unverifiable
      await completedOrder(3, other.address, USDC(300));

      await registry.connect(watcher).payBatch([
        {
          orderId: 1,
          integrator,
          user: user.address,
          orderType: BUY,
          currency: INR,
          orderAmount: USDC(100),
        },
        {
          orderId: 2,
          integrator,
          user: other.address,
          orderType: BUY,
          currency: INR,
          orderAmount: USDC(999),
        },
        {
          orderId: 3,
          integrator,
          user: other.address,
          orderType: BUY,
          currency: INR,
          orderAmount: USDC(300),
        },
      ]);

      expect(await token.balanceOf(user.address)).to.equal(USDC(1));
      expect(await token.balanceOf(other.address)).to.equal(USDC(3));
      expect(await registry.orderPaid(2)).to.equal(false);
    });

    it("rejects a non-watcher caller", async function () {
      await expect(registry.connect(stranger).payBatch([])).to.be.revertedWithCustomError(
        registry,
        "OnlyAccruer"
      );
    });
  });

  // ─── Admin surface ─────────────────────────────────────────────────

  // ─── Remaining state-machine edges ─────────────────────────────────

  describe("status edges", function () {
    it("activate on an already-ACTIVE campaign reverts", async function () {
      const id = await makeCampaign({ bps: 100 });
      await expect(registry.connect(funder).activate(id)).to.be.revertedWithCustomError(
        registry,
        "InvalidStatus"
      );
    });

    it("pause on a non-ACTIVE campaign reverts", async function () {
      const id = await makeCampaign({ bps: 100, activate: false });
      await expect(registry.connect(funder).pause(id)).to.be.revertedWithCustomError(
        registry,
        "InvalidStatus"
      );
    });

    it("end on an already-ENDED campaign reverts", async function () {
      const id = await makeCampaign({ bps: 100 });
      await registry.connect(funder).end(id);
      await expect(registry.connect(funder).end(id)).to.be.revertedWithCustomError(
        registry,
        "InvalidStatus"
      );
    });

    it("ends an INACTIVE campaign that never ran", async function () {
      const id = await makeCampaign({ bps: 100, activate: false });
      await expect(registry.connect(funder).end(id)).to.not.be.reverted;
      expect((await registry.getCampaign(id)).status).to.equal(Status.ENDED);
    });

    it("setRate on an ENDED campaign reverts", async function () {
      const id = await makeCampaign({ bps: 100 });
      await registry.connect(funder).end(id);
      await expect(registry.connect(funder).setRate(id, 200, 0)).to.be.revertedWithCustomError(
        registry,
        "CampaignEnded"
      );
    });

    it("switches a campaign from percentage to flat", async function () {
      const id = await makeCampaign({ bps: 100 });
      await registry.connect(funder).setRate(id, 0, USDC(7));

      await completedOrder(1, user.address, USDC(100));
      await registry.connect(watcher).pay(1, integrator, user.address, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(USDC(7));
    });

    it("quote() returns zero reward for a paused campaign", async function () {
      const id = await makeCampaign({ bps: 100 });
      await registry.connect(funder).pause(id);
      const [, reward] = await registry.quote(integrator, BUY, INR, USDC(100));
      expect(reward).to.equal(0);
    });

    it("quote() returns nothing for an integrator with no campaign", async function () {
      const [id, reward] = await registry.quote(
        ethers.Wallet.createRandom().address,
        BUY,
        INR,
        USDC(100)
      );
      expect(id).to.equal(ethers.ZeroHash);
      expect(reward).to.equal(0);
    });

    it("pays nothing when the reported integrator is the zero address", async function () {
      await makeCampaign({ bps: 100 });
      await completedOrder(1, user.address, USDC(100));
      await registry.connect(watcher).pay(1, ethers.ZeroAddress, user.address, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(0);
    });
  });

  // ─── Worked example: merchant terminal (payqr) ─────────────────────

  describe("integration: merchant terminal shape", function () {
    it("pays the merchant on a completed BUY, integrator untouched", async function () {
      // payqr's merchant terminal: the SHOP places the order (its wallet is
      // `order.user`), the customer pays fiat off-chain. Cashback therefore
      // pays the shop — there is no customer address on-chain.
      const merchant = other;
      await makeCampaign({ orderType: BUY, currency: INR, bps: 100 });

      await completedOrder(77, merchant.address, USDC(1000));
      await expect(registry.connect(watcher).pay(77, integrator, merchant.address, USDC(1000)))
        .to.emit(registry, "Paid")
        .withArgs(
          await registry.activeFor(await registry.lookupKey(integrator, BUY, INR)),
          77,
          merchant.address,
          await token.getAddress(),
          USDC(10)
        );

      expect(await token.balanceOf(merchant.address)).to.equal(USDC(10)); // 1% of 1000
    });

    it("a second currency row runs alongside at a different rate", async function () {
      await makeCampaign({ orderType: BUY, currency: INR, bps: 100 }); // 1%
      await makeCampaign({ orderType: BUY, currency: BRL, bps: 300 }); // 3%

      await completedOrder(1, user.address, USDC(100));
      await registry.connect(watcher).pay(1, integrator, user.address, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(USDC(1));

      await orders.setOrderWithCurrency(
        2,
        other.address,
        USDC(100),
        COMPLETED,
        0,
        BRL,
        integrator,
        0
      );
      await registry.connect(watcher).pay(2, integrator, other.address, USDC(100));
      expect(await token.balanceOf(other.address)).to.equal(USDC(3));
    });
  });

  // ─── Multi-tenant: per-integrator ownership ────────────────────────

  describe("integrator ownership", function () {
    it("a registry admin assigns the owner, who is then self-service", async function () {
      const newIntegrator = ethers.Wallet.createRandom().address;
      await registry.setIntegratorOwner(newIntegrator, other.address);
      expect(await registry.integratorOwner(newIntegrator)).to.equal(other.address);

      await token.mint(other.address, USDC(1000));
      await token.connect(other).approve(await registry.getAddress(), ethers.MaxUint256);

      const id = await makeCampaign({ integratorAddr: newIntegrator, bps: 100, as: other });
      expect((await registry.getCampaign(id)).status).to.equal(Status.ACTIVE);
    });

    it("only a registry admin may assign an owner", async function () {
      await expect(
        registry.connect(stranger).setIntegratorOwner(integrator, stranger.address)
      ).to.be.revertedWithCustomError(registry, "OnlyAdmin");
    });

    it("one owner runs campaigns across many integrators", async function () {
      const b = ethers.Wallet.createRandom().address;
      const c = ethers.Wallet.createRandom().address;
      await registry.setIntegratorOwner(b, funder.address);
      await registry.setIntegratorOwner(c, funder.address);

      await makeCampaign({ bps: 100 });
      await makeCampaign({ integratorAddr: b, bps: 200 });
      await makeCampaign({ integratorAddr: c, bps: 300 });

      expect((await registry.campaignsOfOwner(funder.address)).length).to.equal(3);
      expect((await registry.integratorsOfOwner(funder.address)).length).to.equal(3);
    });

    it("transferring an integrator retires the previous owner campaigns", async function () {
      const id = await makeCampaign({ bps: 100 });

      await registry.setIntegratorOwner(integrator, other.address);

      // The old owner loses control...
      await expect(registry.connect(funder).pause(id)).to.be.revertedWithCustomError(
        registry,
        "OnlyIntegratorOwner"
      );
      // ...and the new owner does NOT inherit it, because it is still funded
      // by the previous owner wallet. Inheriting it would let the incoming
      // owner retune the rate and drain a wallet they never controlled.
      await expect(registry.connect(other).pause(id)).to.be.revertedWithCustomError(
        registry,
        "CampaignRetired"
      );

      // The new owner creates their own, funded by their own wallet.
      await token.mint(other.address, USDC(1000));
      await token.connect(other).approve(await registry.getAddress(), ethers.MaxUint256);
      const fresh = await makeCampaign({ bps: 100, as: other });
      expect((await registry.getCampaign(fresh)).status).to.equal(Status.ACTIVE);
    });
  });

  // ─── Multi-tenant: fund isolation ──────────────────────────────────

  describe("fund isolation", function () {
    it("each campaign spends only its own funding wallet", async function () {
      // Two owners, two integrators, two independent wallets.
      const integratorB = ethers.Wallet.createRandom().address;
      await registry.setIntegratorOwner(integratorB, other.address);
      await token.mint(other.address, USDC(500));
      await token.connect(other).approve(await registry.getAddress(), ethers.MaxUint256);

      await makeCampaign({ bps: 100 }); // funder pays
      await makeCampaign({ integratorAddr: integratorB, bps: 100, as: other }); // other pays

      const funderBefore = await token.balanceOf(funder.address);
      const otherBefore = await token.balanceOf(other.address);

      // An order on integrator B must debit `other`, never `funder`.
      await completedOrder(1, user.address, USDC(100), integratorB);
      await registry.connect(watcher).pay(1, integratorB, user.address, USDC(100));

      expect(await token.balanceOf(funder.address)).to.equal(funderBefore);
      expect(await token.balanceOf(other.address)).to.equal(otherBefore - USDC(1));
      expect(await token.balanceOf(user.address)).to.equal(USDC(1));
    });

    it("one owner's empty wallet does not affect another's campaign", async function () {
      const integratorB = ethers.Wallet.createRandom().address;
      await registry.setIntegratorOwner(integratorB, other.address);
      // `other` funds nothing and approves nothing.

      await makeCampaign({ bps: 100 });
      await makeCampaign({ integratorAddr: integratorB, bps: 100, as: other });

      await completedOrder(1, user.address, USDC(100), integratorB);
      await registry.connect(watcher).pay(1, integratorB, user.address, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(0); // theirs fails

      await completedOrder(2, user.address, USDC(100));
      await registry.connect(watcher).pay(2, integrator, user.address, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(USDC(1)); // ours still pays
    });

    it("cannot point a campaign at a wallet you do not control", async function () {
      // `stranger` owns an integrator but tries to fund from `funder`'s wallet.
      const integratorB = ethers.Wallet.createRandom().address;
      await registry.setIntegratorOwner(integratorB, stranger.address);

      await expect(
        registry
          .connect(stranger)
          .createCampaign(integratorB, BUY, INR, await token.getAddress(), 100, 0, funder.address, {
            maxRewardPerOrder: 0,
            dailyBudget: 0,
            totalBudget: 0,
            dailyPerUser: 0,
            startTime: 0,
            endTime: 0,
          })
      ).to.be.revertedWithCustomError(registry, "FundingWalletNotAuthorized");
    });

    it("a stray token allowance is NOT proof of control", async function () {
      const treasury = other;
      await token.mint(treasury.address, USDC(1000));
      // A token allowance to the owner proves nothing about who may attach
      // this wallet — it is granted for unrelated reasons all the time, and
      // the payout actually pulls as the registry, not as the owner.
      await token.connect(treasury).approve(funder.address, USDC(1));
      await token.connect(treasury).approve(await registry.getAddress(), ethers.MaxUint256);

      await expect(
        registry
          .connect(funder)
          .createCampaign(
            integrator,
            BUY,
            INR,
            await token.getAddress(),
            100,
            0,
            treasury.address,
            {
              maxRewardPerOrder: 0,
              dailyBudget: 0,
              totalBudget: 0,
              dailyPerUser: 0,
              startTime: 0,
              endTime: 0,
            }
          )
      ).to.be.revertedWithCustomError(registry, "FundingWalletNotAuthorized");
    });

    it("a wallet that explicitly authorised you may be used as the funding source", async function () {
      const treasury = other;
      await token.mint(treasury.address, USDC(1000));
      await token.connect(treasury).approve(await registry.getAddress(), ethers.MaxUint256);
      // Only the wallet itself can grant this.
      await registry
        .connect(treasury)
        .authorizeCampaignFunder(funder.address, await token.getAddress(), true);

      await expect(
        registry
          .connect(funder)
          .createCampaign(
            integrator,
            BUY,
            INR,
            await token.getAddress(),
            100,
            0,
            treasury.address,
            {
              maxRewardPerOrder: 0,
              dailyBudget: 0,
              totalBudget: 0,
              dailyPerUser: 0,
              startTime: 0,
              endTime: 0,
            }
          )
      ).to.not.be.reverted;
    });

    it("repoints a campaign's funding wallet", async function () {
      const id = await makeCampaign({ bps: 100 });

      await token.mint(other.address, USDC(1000));
      await token.connect(other).approve(await registry.getAddress(), ethers.MaxUint256);
      await registry
        .connect(other)
        .authorizeCampaignFunder(funder.address, await token.getAddress(), true);
      await registry.connect(funder).setCampaignFundingWallet(id, other.address);

      const otherBefore = await token.balanceOf(other.address);
      await completedOrder(1, user.address, USDC(100));
      await registry.connect(watcher).pay(1, integrator, user.address, USDC(100));

      expect(await token.balanceOf(other.address)).to.equal(otherBefore - USDC(1));
    });
  });

  // ─── Emergency stop ────────────────────────────────────────────────

  describe("emergencyStop", function () {
    it("a registry admin can pause an abusive campaign", async function () {
      const id = await makeCampaign({ bps: 100 });
      await registry.emergencyStop(id, false);
      expect((await registry.getCampaign(id)).status).to.equal(Status.PAUSED);

      await completedOrder(1, user.address, USDC(100));
      await registry.connect(watcher).pay(1, integrator, user.address, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(0);
    });

    it("a registry admin can end a campaign permanently", async function () {
      const id = await makeCampaign({ bps: 100 });
      await registry.emergencyStop(id, true);
      expect((await registry.getCampaign(id)).status).to.equal(Status.ENDED);
    });

    it("the owner can resume after an admin pause", async function () {
      const id = await makeCampaign({ bps: 100 });
      await registry.emergencyStop(id, false);
      await expect(registry.connect(funder).activate(id)).to.not.be.reverted;
    });

    it("an admin CANNOT change a rate — stopping is not spending", async function () {
      const id = await makeCampaign({ bps: 100 });
      // `deployer` is a registry admin but not the integrator owner.
      await expect(registry.connect(deployer).setRate(id, 500, 0)).to.be.revertedWithCustomError(
        registry,
        "OnlyIntegratorOwner"
      );
    });

    it("a non-admin cannot emergency-stop", async function () {
      const id = await makeCampaign({ bps: 100 });
      await expect(
        registry.connect(stranger).emergencyStop(id, false)
      ).to.be.revertedWithCustomError(registry, "OnlyAdmin");
    });
  });

  // ─── Dashboard surface ─────────────────────────────────────────────

  describe("dashboard views", function () {
    it("tracks totals per campaign", async function () {
      const id = await makeCampaign({ bps: 100 });

      await completedOrder(1, user.address, USDC(100));
      await registry.connect(watcher).pay(1, integrator, user.address, USDC(100));
      await completedOrder(2, other.address, USDC(300));
      await registry.connect(watcher).pay(2, integrator, other.address, USDC(300));

      const s = await registry.stats(id);
      expect(s.totalPaid).to.equal(USDC(4)); // 1 + 3
      expect(s.orderCount).to.equal(2);
    });

    it("campaignView reports spendable headroom", async function () {
      const id = await makeCampaign({ bps: 100 });
      const [, , spendable] = await registry.campaignView(id);
      // Allowance is max, so headroom is the wallet balance.
      expect(spendable).to.equal(await token.balanceOf(funder.address));
    });

    it("spendable drops to zero when the approval is revoked", async function () {
      const id = await makeCampaign({ bps: 100 });
      await token.connect(funder).approve(await registry.getAddress(), 0);
      const [, , spendable] = await registry.campaignView(id);
      expect(spendable).to.equal(0);
    });

    it("paginates the global campaign list", async function () {
      await makeCampaign({ bps: 100 });
      await makeCampaign({ currency: BRL, bps: 200 });
      await makeCampaign({ currency: ANY, bps: 300 });

      expect(await registry.campaignCount()).to.equal(3);
      expect((await registry.campaignsPaged(0, 2)).length).to.equal(2);
      expect((await registry.campaignsPaged(2, 10)).length).to.equal(1);
      expect((await registry.campaignsPaged(99, 10)).length).to.equal(0);
    });

    it("lists campaigns per integrator", async function () {
      await makeCampaign({ bps: 100 });
      await makeCampaign({ currency: BRL, bps: 200 });
      expect((await registry.campaignsOfIntegrator(integrator)).length).to.equal(2);
    });
  });
});

// ─── Audit regressions ───────────────────────────────────────────────
// Each of these encodes a bug found in the multi-tenant audit. They are the
// reason the fixes exist; they must never go green by accident.

describe("CashbackRegistry — audit regressions", function () {
  let admin: SignerWithAddress;
  let alice: SignerWithAddress; // outgoing integrator owner
  let bob: SignerWithAddress; // incoming integrator owner
  let carol: SignerWithAddress; // uninvolved third party
  let watcher2: SignerWithAddress;
  let user2: SignerWithAddress;

  let token2: any;
  let orders2: any;
  let reg: any;
  let intg: string;

  const U6 = (n: number) => ethers.parseUnits(n.toString(), 6);

  function idOf(rc: any) {
    return rc.logs
      .map((l: any) => {
        try {
          return reg.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e: any) => e && e.name === "CampaignCreated").args.campaignId;
  }

  async function newCampaign(
    as: SignerWithAddress,
    funder: string,
    bps: number,
    flat: bigint = 0n,
    orderType: string = BUY,
    currency: string = INR
  ) {
    const tx = await reg
      .connect(as)
      .createCampaign(intg, orderType, currency, await token2.getAddress(), bps, flat, funder, {
        maxRewardPerOrder: 0,
        dailyBudget: 0,
        totalBudget: 0,
        dailyPerUser: 0,
        startTime: 0,
        endTime: 0,
      });
    return idOf(await tx.wait());
  }

  beforeEach(async function () {
    [admin, alice, bob, carol, watcher2, user2] = await ethers.getSigners();
    intg = ethers.Wallet.createRandom().address;

    token2 = await (await ethers.getContractFactory("MockUSDC")).deploy();
    orders2 = await (await ethers.getContractFactory("MockOrderSource")).deploy();
    reg = await (
      await ethers.getContractFactory("CashbackRegistry")
    ).deploy(await orders2.getAddress());

    await reg.setAccruer(watcher2.address, true);
    await reg.setIntegratorOwner(intg, alice.address);

    await token2.mint(alice.address, U6(1_000_000));
    await token2.connect(alice).approve(await reg.getAddress(), ethers.MaxUint256);
  });

  // CRITICAL 1 — a handover must not hand over the previous owner's money.
  it("a new integrator owner cannot drain the previous owner wallet", async function () {
    const id = await newCampaign(alice, alice.address, 100);
    await reg.connect(alice).activate(id);

    await reg.setIntegratorOwner(intg, bob.address);

    await expect(
      reg.connect(bob).setRate(id, 0, ethers.parseUnits("500000", 6))
    ).to.be.revertedWithCustomError(reg, "CampaignRetired");

    const before = await token2.balanceOf(alice.address);
    await orders2.setOrderFull(1, user2.address, U6(100), 3, 0, intg, 0);
    await reg.connect(watcher2).pay(1, intg, user2.address, U6(100));

    expect(await token2.balanceOf(user2.address)).to.equal(0);
    expect(await token2.balanceOf(alice.address)).to.equal(before);
  });

  // CRITICAL 1b — the flat path was the unbounded one.
  it("rejects a flat reward above the ceiling", async function () {
    // AUDIT M2: the ceiling is now decimals-aware, so read it per token.
    const max = await reg.maxFlatAmountFor(await token2.getAddress());
    await expect(newCampaign(alice, alice.address, 0, max + 1n)).to.be.revertedWithCustomError(
      reg,
      "InvalidRate"
    );

    const id = await newCampaign(alice, alice.address, 100);
    await expect(reg.connect(alice).setRate(id, 0, max + 1n)).to.be.revertedWithCustomError(
      reg,
      "InvalidRate"
    );
  });

  // HIGH 2 — a stray ERC-20 allowance is not proof of control.
  it("cannot attach another party wallet via a stray token allowance", async function () {
    await token2.mint(carol.address, U6(1000));
    await token2.connect(carol).approve(alice.address, 1n);
    await token2.connect(carol).approve(await reg.getAddress(), ethers.MaxUint256);

    await expect(newCampaign(alice, carol.address, 100)).to.be.revertedWithCustomError(
      reg,
      "FundingWalletNotAuthorized"
    );
  });

  it("an authorised wallet may fund, and revoking stops payouts live", async function () {
    await token2.mint(carol.address, U6(1000));
    await token2.connect(carol).approve(await reg.getAddress(), ethers.MaxUint256);
    await reg
      .connect(carol)
      .authorizeCampaignFunder(alice.address, await token2.getAddress(), true);

    const id = await newCampaign(alice, carol.address, 100);
    await reg.connect(alice).activate(id);

    await orders2.setOrderFull(1, user2.address, U6(100), 3, 0, intg, 0);
    await reg.connect(watcher2).pay(1, intg, user2.address, U6(100));
    expect(await token2.balanceOf(user2.address)).to.equal(U6(1));

    await reg
      .connect(carol)
      .authorizeCampaignFunder(alice.address, await token2.getAddress(), false);

    await orders2.setOrderFull(2, user2.address, U6(100), 3, 0, intg, 0);
    await reg.connect(watcher2).pay(2, intg, user2.address, U6(100));
    expect(await token2.balanceOf(user2.address)).to.equal(U6(1)); // unchanged
  });

  // HIGH 3 — a retired narrow campaign must not shadow a healthy broad one.
  it("resolution falls through a retired campaign to a healthy broader one", async function () {
    const narrow = await newCampaign(alice, alice.address, 500);
    await reg.connect(alice).activate(narrow);

    const wide = await newCampaign(alice, alice.address, 100, 0n, ANY, ANY);
    await reg.connect(alice).activate(wide);

    await orders2.setOrderFull(1, user2.address, U6(100), 3, 0, intg, 0);
    await reg.connect(watcher2).pay(1, intg, user2.address, U6(100));
    expect(await token2.balanceOf(user2.address)).to.equal(U6(5)); // narrow wins

    await reg.connect(admin).emergencyStop(narrow, true);

    await orders2.setOrderFull(2, user2.address, U6(100), 3, 0, intg, 0);
    await reg.connect(watcher2).pay(2, intg, user2.address, U6(100));
    expect(await token2.balanceOf(user2.address)).to.equal(U6(6)); // fell through: 5 + 1
  });

  // MEDIUM 4 — enumeration must not accumulate duplicates.
  it("does not duplicate integrators when ownership moves back and forth", async function () {
    await reg.setIntegratorOwner(intg, bob.address);
    await reg.setIntegratorOwner(intg, alice.address);
    await reg.setIntegratorOwner(intg, bob.address);

    const bobs = await reg.integratorsOfOwner(bob.address);
    const unique = new Set(bobs.map((a: string) => a.toLowerCase()));
    expect(unique.size).to.equal(bobs.length);
  });

  // Admins are bounded: they may stop, never spend.
  it("an admin cannot create a campaign or change a rate", async function () {
    const id = await newCampaign(alice, alice.address, 100);
    await reg.connect(alice).activate(id);

    await expect(newCampaign(admin, admin.address, 100)).to.be.revertedWithCustomError(
      reg,
      "OnlyIntegratorOwner"
    );
    await expect(reg.connect(admin).setRate(id, 500, 0)).to.be.revertedWithCustomError(
      reg,
      "OnlyIntegratorOwner"
    );

    await expect(reg.connect(admin).emergencyStop(id, false)).to.not.be.reverted;
  });
});

// ─── PR #62 review findings (Aash) ───────────────────────────────────
// One regression per finding, encoding the reviewer's proof-of-concepts —
// so a regression reintroduces a named, reproduced exploit rather than an
// abstract coverage gap.

describe("CashbackRegistry — PR #62 review regressions", function () {
  let admin: SignerWithAddress;
  let alice: SignerWithAddress; // owns integrator A
  let bob: SignerWithAddress; // owns integrator B
  let carol: SignerWithAddress; // uninvolved treasury
  let keeper: SignerWithAddress; // the accruer / watcher key
  let buyer: SignerWithAddress;

  let usdc: any;
  let orders: any;
  let reg: any;
  let intgA: string;
  let intgB: string;

  const U6 = (n: number | string) => ethers.parseUnits(n.toString(), 6);
  const NB = {
    maxRewardPerOrder: 0,
    dailyBudget: 0,
    totalBudget: 0,
    dailyPerUser: 0,
    startTime: 0,
    endTime: 0,
  };

  function idOf(rc: any) {
    return rc.logs
      .map((l: any) => {
        try {
          return reg.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e: any) => e && e.name === "CampaignCreated").args.campaignId;
  }

  async function campaign(
    as: SignerWithAddress,
    intg: string,
    opts: {
      token?: any;
      bps?: number;
      flat?: bigint;
      currency?: string;
      orderType?: string;
      funder?: string;
      budget?: any;
      activate?: boolean;
    } = {}
  ) {
    const tok = opts.token ?? usdc;
    const tx = await reg
      .connect(as)
      .createCampaign(
        intg,
        opts.orderType ?? BUY,
        opts.currency ?? INR,
        await tok.getAddress(),
        opts.bps ?? 0,
        opts.flat ?? 0n,
        opts.funder ?? as.address,
        opts.budget ?? NB
      );
    const id = idOf(await tx.wait());
    if (opts.activate !== false) await reg.connect(as).activate(id);
    return id;
  }

  beforeEach(async function () {
    [admin, alice, bob, carol, keeper, buyer] = await ethers.getSigners();
    intgA = ethers.Wallet.createRandom().address;
    intgB = ethers.Wallet.createRandom().address;

    usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    orders = await (await ethers.getContractFactory("MockOrderSource")).deploy();
    reg = await (
      await ethers.getContractFactory("CashbackRegistry")
    ).deploy(await orders.getAddress());

    await reg.setAccruer(keeper.address, true);
    await reg.setIntegratorOwner(intgA, alice.address);
    await reg.setIntegratorOwner(intgB, bob.address);

    for (const who of [alice, bob, carol]) {
      await usdc.mint(who.address, U6(1_000_000));
      await usdc.connect(who).approve(await reg.getAddress(), ethers.MaxUint256);
    }
  });

  // F1 (HIGH) — the accruer key must not choose WHICH tenant pays.
  it("F1: an order can only bill the integrator that actually placed it", async function () {
    await campaign(alice, intgA, { bps: 100 }); // Alice: 1%
    await campaign(bob, intgB, { bps: 500 }); // Bob: 5%

    // A real order placed through Alice's integrator.
    await orders.setOrderFull(1, buyer.address, U6(1000), COMPLETED, 0, intgA, 0);

    const bobBefore = await usdc.balanceOf(bob.address);

    // The keeper reports it against BOB's richer campaign.
    await reg.connect(keeper).pay(1, intgB, buyer.address, U6(1000));

    expect(await usdc.balanceOf(bob.address)).to.equal(bobBefore);
    expect(await usdc.balanceOf(buyer.address)).to.equal(0);
    expect(await reg.orderPaid(1)).to.equal(false);
  });

  it("F1: an organic order with no integrator pays nothing", async function () {
    await campaign(alice, intgA, { bps: 100 });
    await orders.setOrderFull(2, buyer.address, U6(1000), COMPLETED, 0, ethers.ZeroAddress, 0);

    await reg.connect(keeper).pay(2, intgA, buyer.address, U6(1000));
    expect(await usdc.balanceOf(buyer.address)).to.equal(0);
  });

  // F3 (MEDIUM-HIGH) — the keeper must not choose WHICH campaign pays.
  it("F3: order type and currency come from the record, not the report", async function () {
    await campaign(alice, intgA, { bps: 100, currency: INR }); // 1% INR
    await campaign(alice, intgA, { bps: 500, currency: ANY }); // 5% anything else

    await orders.setOrderWithCurrency(1, buyer.address, U6(1000), COMPLETED, 0, INR, intgA, 0);

    // The INR row must win: the currency is read from the record.
    await reg.connect(keeper).pay(1, intgA, buyer.address, U6(1000));
    expect(await usdc.balanceOf(buyer.address)).to.equal(U6(10)); // 1%, not 5%
  });

  // F4 (MEDIUM) — funding authorisation is scoped to a token.
  it("F4: authorising a spender for one token does not authorise another", async function () {
    const points = await (await ethers.getContractFactory("MockUSDC")).deploy();
    await points.mint(carol.address, U6(1000));
    await points.connect(carol).approve(await reg.getAddress(), ethers.MaxUint256);

    // Carol sponsors Alice for the POINTS token only.
    await reg
      .connect(carol)
      .authorizeCampaignFunder(alice.address, await points.getAddress(), true);

    // Succeeds: Carol explicitly authorised Alice for THIS token.
    const sponsored = await campaign(alice, intgA, {
      token: points,
      bps: 100,
      funder: carol.address,
    });
    expect((await reg.getCampaign(sponsored)).fundingWallet).to.equal(carol.address);

    await expect(
      reg
        .connect(alice)
        .createCampaign(intgA, BUY, BRL, await usdc.getAddress(), 100, 0, carol.address, NB)
    ).to.be.revertedWithCustomError(reg, "FundingWalletNotAuthorized");
  });

  // F5 (MEDIUM) — one hostile reward token must not starve the batch.
  it("F5: a gas-bomb reward token cannot take down the whole batch", async function () {
    const bomb = await (await ethers.getContractFactory("MockGasBomb")).deploy();
    await bomb.mint(bob.address, U6(1_000_000));
    await bomb.connect(bob).approve(await reg.getAddress(), ethers.MaxUint256);

    await campaign(alice, intgA, { bps: 100 }); // honest
    await campaign(bob, intgB, { token: bomb, bps: 100 }); // hostile

    const reports: any[] = [
      { orderId: 1, integrator: intgB, user: buyer.address, orderAmount: U6(100) },
    ];
    await orders.setOrderFull(1, buyer.address, U6(100), COMPLETED, 0, intgB, 0);
    for (let i = 2; i <= 10; i++) {
      await orders.setOrderFull(i, buyer.address, U6(100), COMPLETED, 0, intgA, 0);
      reports.push({ orderId: i, integrator: intgA, user: buyer.address, orderAmount: U6(100) });
    }

    await reg.connect(keeper).payBatch(reports);
    expect(await usdc.balanceOf(buyer.address)).to.equal(U6(9)); // 9 honest rows paid
  });

  // F6 (MEDIUM) — budgets are enforced on-chain, not by allowance discipline.
  it("F6/M2: MAX_BPS is programme-shaped and the flat ceiling binds a 6dp token", async function () {
    expect(await reg.MAX_BPS()).to.equal(500); // 5%, not 20%
    await expect(campaign(alice, intgA, { bps: 501 })).to.be.revertedWithCustomError(
      reg,
      "InvalidRate"
    );

    // AUDIT M2. The old fixed 1e21 cap was 10^15 USDC for a 6dp token — no
    // bound at all. The ceiling is now MAX_FLAT_TOKENS whole tokens whatever
    // the decimals, so for 6dp USDC it is a real 1,000 USDC per order.
    const maxFlat = await reg.maxFlatAmountFor(await usdc.getAddress());
    expect(maxFlat).to.equal(U6(1000));
    await expect(campaign(alice, intgA, { flat: maxFlat + 1n })).to.be.revertedWithCustomError(
      reg,
      "InvalidRate"
    );
    // And the value that the old ceiling waved through is now rejected.
    await expect(campaign(alice, intgA, { flat: 10n ** 21n })).to.be.revertedWithCustomError(
      reg,
      "InvalidRate"
    );
  });

  it("F6: per-order, per-day and lifetime budgets all clamp", async function () {
    const id = await campaign(alice, intgA, {
      bps: 500,
      budget: { ...NB, maxRewardPerOrder: U6(2), dailyBudget: U6(3), totalBudget: U6(3) },
    });

    // 5% of 1000 = 50, clamped to maxRewardPerOrder = 2.
    await orders.setOrderFull(1, buyer.address, U6(1000), COMPLETED, 0, intgA, 0);
    await reg.connect(keeper).pay(1, intgA, buyer.address, U6(1000));
    expect(await usdc.balanceOf(buyer.address)).to.equal(U6(2));

    // Only 1 left in the daily / total budget.
    await orders.setOrderFull(2, buyer.address, U6(1000), COMPLETED, 0, intgA, 0);
    await reg.connect(keeper).pay(2, intgA, buyer.address, U6(1000));
    expect(await usdc.balanceOf(buyer.address)).to.equal(U6(3));

    // Exhausted.
    await orders.setOrderFull(3, buyer.address, U6(1000), COMPLETED, 0, intgA, 0);
    await reg.connect(keeper).pay(3, intgA, buyer.address, U6(1000));
    expect(await usdc.balanceOf(buyer.address)).to.equal(U6(3));
    expect((await reg.stats(id)).totalPaid).to.equal(U6(3));
  });

  it("F6: a per-user daily cap bounds one address farming", async function () {
    await campaign(alice, intgA, { bps: 500, budget: { ...NB, dailyPerUser: U6(1) } });

    await orders.setOrderFull(1, buyer.address, U6(1000), COMPLETED, 0, intgA, 0);
    await reg.connect(keeper).pay(1, intgA, buyer.address, U6(1000));
    await orders.setOrderFull(2, buyer.address, U6(1000), COMPLETED, 0, intgA, 0);
    await reg.connect(keeper).pay(2, intgA, buyer.address, U6(1000));

    expect(await usdc.balanceOf(buyer.address)).to.equal(U6(1)); // capped
  });

  // F7 (MEDIUM) — campaigns are not retroactive.
  it("F7: a campaign cannot pay orders placed before it started", async function () {
    const past = (await ethers.provider.getBlock("latest"))!.timestamp - 30 * 24 * 3600;
    await orders.setOrderFull(1, buyer.address, U6(1000), COMPLETED, 0, intgA, past);

    await campaign(alice, intgA, { bps: 500 });

    await reg.connect(keeper).pay(1, intgA, buyer.address, U6(1000));
    expect(await usdc.balanceOf(buyer.address)).to.equal(0);
  });

  it("F7: an order placed after endTime is not eligible", async function () {
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await campaign(alice, intgA, {
      bps: 500,
      // A real window. AUDIT N4: `endTime: now + 1` used to be accepted, but
      // the stored start is floored at the creation block — so that was a
      // zero-length window, a campaign that could never pay any order. The
      // point of this test is an order placed AFTER a live window, so give it
      // a window to be after.
      budget: { ...NB, startTime: now - 100, endTime: now + 1000 },
    });

    await orders.setOrderFull(1, buyer.address, U6(1000), COMPLETED, 0, intgA, now + 5000);
    await reg.connect(keeper).pay(1, intgA, buyer.address, U6(1000));
    expect(await usdc.balanceOf(buyer.address)).to.equal(0);
  });

  // F8 (MEDIUM) — SELL rewards land on a proxy, so block them for now.
  it("F8: SELL and PAY campaigns are rejected at creation", async function () {
    await expect(
      campaign(alice, intgA, { bps: 100, orderType: SELL })
    ).to.be.revertedWithCustomError(reg, "UnsupportedOrderType");

    const PAY = ethers.encodeBytes32String("PAY");
    await expect(
      campaign(alice, intgA, { bps: 100, orderType: PAY })
    ).to.be.revertedWithCustomError(reg, "UnsupportedOrderType");
  });

  // F9 (LOW) — reward scaling across token decimals.
  it("F9: an 18-decimal reward token pays a sensible amount", async function () {
    const t18 = await (await ethers.getContractFactory("MockToken18")).deploy();
    await t18.mint(alice.address, ethers.parseUnits("1000000", 18));
    await t18.connect(alice).approve(await reg.getAddress(), ethers.MaxUint256);

    await campaign(alice, intgA, { token: t18, bps: 100 }); // 1%

    await orders.setOrderFull(1, buyer.address, U6(1000), COMPLETED, 0, intgA, 0);
    await reg.connect(keeper).pay(1, intgA, buyer.address, U6(1000));

    // 1% of a $1,000 order = 10 tokens, at 18 decimals.
    expect(await t18.balanceOf(buyer.address)).to.equal(ethers.parseUnits("10", 18));
  });

  // F10 (LOW) — a retired campaign must be closeable.
  it("F10: the recorded owner can end a retired campaign", async function () {
    const id = await campaign(alice, intgA, { bps: 100 });

    await reg.setIntegratorOwner(intgA, bob.address); // handover retires it

    await expect(reg.connect(bob).pause(id)).to.be.revertedWithCustomError(reg, "CampaignRetired");
    // The recorded owner can close it, so they know to revoke their approval.
    await expect(reg.connect(alice).end(id)).to.not.be.reverted;
    expect((await reg.getCampaign(id)).status).to.equal(Status.ENDED);
  });

  // F11 (LOW) — admin surface sharp edges.
  it("F11: the last admin cannot remove themselves", async function () {
    await expect(reg.setAdmin(admin.address, false)).to.be.revertedWithCustomError(
      reg,
      "LastAdmin"
    );

    await reg.setAdmin(alice.address, true);
    await expect(reg.setAdmin(admin.address, false)).to.not.be.reverted;
  });

  it("F11: an integrator can be un-assigned, retiring its campaigns", async function () {
    await campaign(alice, intgA, { bps: 100 });
    await reg.unassignIntegrator(intgA);

    expect(await reg.integratorOwner(intgA)).to.equal(ethers.ZeroAddress);

    await orders.setOrderFull(1, buyer.address, U6(1000), COMPLETED, 0, intgA, 0);
    await reg.connect(keeper).pay(1, intgA, buyer.address, U6(1000));
    expect(await usdc.balanceOf(buyer.address)).to.equal(0);

    await expect(campaign(alice, intgA, { bps: 100 })).to.be.revertedWithCustomError(
      reg,
      "IntegratorUnclaimed"
    );
  });
});

// ─── Coverage: budget retuning, decimals, order-type labels ──────────

describe("CashbackRegistry — budgets, decimals, labels", function () {
  let admin: SignerWithAddress;
  let alice: SignerWithAddress;
  let keeper: SignerWithAddress;
  let buyer: SignerWithAddress;

  let usdc: any;
  let orders: any;
  let reg: any;
  let intg: string;

  const U6 = (n: number | string) => ethers.parseUnits(n.toString(), 6);
  const NB = {
    maxRewardPerOrder: 0,
    dailyBudget: 0,
    totalBudget: 0,
    dailyPerUser: 0,
    startTime: 0,
    endTime: 0,
  };

  async function campaign(opts: any = {}) {
    const tok = opts.token ?? usdc;
    const tx = await reg
      .connect(alice)
      .createCampaign(
        intg,
        opts.orderType ?? BUY,
        opts.currency ?? INR,
        await tok.getAddress(),
        opts.bps ?? 100,
        opts.flat ?? 0n,
        alice.address,
        opts.budget ?? NB
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
    if (opts.activate !== false) await reg.connect(alice).activate(id);
    return id;
  }

  beforeEach(async function () {
    [admin, alice, keeper, buyer] = await ethers.getSigners();
    intg = ethers.Wallet.createRandom().address;

    usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    orders = await (await ethers.getContractFactory("MockOrderSource")).deploy();
    reg = await (
      await ethers.getContractFactory("CashbackRegistry")
    ).deploy(await orders.getAddress());

    await reg.setAccruer(keeper.address, true);
    await reg.setIntegratorOwner(intg, alice.address);
    await usdc.mint(alice.address, U6(1_000_000));
    await usdc.connect(alice).approve(await reg.getAddress(), ethers.MaxUint256);
  });

  it("setBudget retunes the dials mid-flight", async function () {
    const id = await campaign({ bps: 500 });

    await expect(reg.connect(alice).setBudget(id, { ...NB, maxRewardPerOrder: U6(1) })).to.emit(
      reg,
      "CampaignBudgetChanged"
    );

    await orders.setOrderFull(1, buyer.address, U6(1000), COMPLETED, 0, intg, 0);
    await reg.connect(keeper).pay(1, intg, buyer.address, U6(1000));
    expect(await usdc.balanceOf(buyer.address)).to.equal(U6(1)); // clamped by the new cap
  });

  it("setBudget refuses to move the start backwards", async function () {
    const id = await campaign({ bps: 100 });
    const c = await reg.getCampaign(id);

    // Moving the start earlier would let the campaign swallow history it was
    // never eligible for — the F7 hole by another route.
    await expect(
      reg.connect(alice).setBudget(id, { ...NB, startTime: Number(c.startTime) - 1 })
    ).to.be.revertedWithCustomError(reg, "InvalidWindow");
  });

  it("setBudget rejects an end before the start, and an ended campaign", async function () {
    const id = await campaign({ bps: 100 });
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;

    await expect(
      reg.connect(alice).setBudget(id, { ...NB, startTime: now, endTime: now - 1 })
    ).to.be.revertedWithCustomError(reg, "InvalidWindow");

    await reg.connect(alice).end(id);
    await expect(reg.connect(alice).setBudget(id, NB)).to.be.revertedWithCustomError(
      reg,
      "CampaignEnded"
    );
  });

  it("createCampaign rejects an end before the start", async function () {
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await expect(
      campaign({ budget: { ...NB, startTime: now, endTime: now - 1 } })
    ).to.be.revertedWithCustomError(reg, "InvalidWindow");
  });

  it("a sub-6-decimal reward token scales down correctly", async function () {
    const t2 = await (await ethers.getContractFactory("MockToken2")).deploy();
    await t2.mint(alice.address, ethers.parseUnits("1000000", 2));
    await t2.connect(alice).approve(await reg.getAddress(), ethers.MaxUint256);

    await campaign({ token: t2, bps: 100 }); // 1%

    await orders.setOrderFull(1, buyer.address, U6(1000), COMPLETED, 0, intg, 0);
    await reg.connect(keeper).pay(1, intg, buyer.address, U6(1000));

    // 1% of $1,000 = 10 tokens, at 2 decimals.
    expect(await t2.balanceOf(buyer.address)).to.equal(ethers.parseUnits("10", 2));
  });

  it("a token with no decimals() is treated as 6dp", async function () {
    const nodec = await (await ethers.getContractFactory("MockNoDecimals")).deploy();
    await nodec.mint(alice.address, U6(1000));
    await nodec.connect(alice).approve(await reg.getAddress(), ethers.MaxUint256);

    await campaign({ token: nodec, bps: 100 });

    await orders.setOrderFull(1, buyer.address, U6(1000), COMPLETED, 0, intg, 0);
    await reg.connect(keeper).pay(1, intg, buyer.address, U6(1000));
    expect(await nodec.balanceOf(buyer.address)).to.equal(U6(10));
  });

  it("a PAY order resolves only against a wildcard row", async function () {
    // orderType 2 = PAY on the record. A BUY-keyed campaign must not match.
    await campaign({ bps: 500, orderType: BUY, currency: INR });
    await orders.setOrderFull(1, buyer.address, U6(1000), COMPLETED, 2, intg, 0);

    await reg.connect(keeper).pay(1, intg, buyer.address, U6(1000));
    expect(await usdc.balanceOf(buyer.address)).to.equal(0);
  });

  it("an unrecognised order type maps to the ANY wildcard, never to BUY", async function () {
    await campaign({ bps: 500, orderType: BUY, currency: INR });
    // orderType 7 is not a Diamond enum value.
    await orders.setOrderFull(1, buyer.address, U6(1000), COMPLETED, 7, intg, 0);

    await reg.connect(keeper).pay(1, intg, buyer.address, U6(1000));
    expect(await usdc.balanceOf(buyer.address)).to.equal(0);
  });

  it("an order with no placement time is rejected", async function () {
    await campaign({ bps: 100 });
    // A record that decodes but carries no placedTimestamp cannot be checked
    // against the campaign window, so it must fail closed.
    await orders.setOrderWithCurrency(1, buyer.address, U6(1000), COMPLETED, 0, INR, intg, 1);
    await reg.connect(keeper).setAccruer;

    const c = await reg.getCampaign(await reg.activeFor(await reg.lookupKey(intg, BUY, INR)));
    expect(c.startTime).to.be.greaterThan(1);

    await reg.connect(keeper).pay(1, intg, buyer.address, U6(1000));
    expect(await usdc.balanceOf(buyer.address)).to.equal(0);
  });

  it("campaignView reports spendable capacity", async function () {
    const id = await campaign({ bps: 100 });
    const [, , spendable] = await reg.campaignView(id);
    expect(spendable).to.be.greaterThan(0);

    // Revoking the approval drops spendable to zero — the health signal a
    // dashboard needs, since the campaign still reads ACTIVE.
    await usdc.connect(alice).approve(await reg.getAddress(), 0);
    const [, , after] = await reg.campaignView(id);
    expect(after).to.equal(0);
  });

  it("campaignsPaged pages and clamps", async function () {
    await campaign({ bps: 100, currency: INR });
    await campaign({ bps: 100, currency: BRL, activate: false });

    expect(await reg.campaignCount()).to.equal(2);
    expect((await reg.campaignsPaged(0, 1)).length).to.equal(1);
    expect((await reg.campaignsPaged(1, 50)).length).to.equal(1); // clamped
    expect((await reg.campaignsPaged(99, 10)).length).to.equal(0); // past the end
  });
});

// ─── Re-audit regressions ────────────────────────────────────────────
// Bugs introduced BY the PR #62 fixes, found in a second adversarial pass.
// The critical one fired in normal operation with no attacker involved.

describe("CashbackRegistry — re-audit regressions", function () {
  let admin: SignerWithAddress;
  let alice: SignerWithAddress;
  let keeper: SignerWithAddress;
  let buyer: SignerWithAddress;

  let orders: any;
  let reg: any;
  let intg: string;

  const U6 = (n: number | string) => ethers.parseUnits(n.toString(), 6);
  const NB = {
    maxRewardPerOrder: 0,
    dailyBudget: 0,
    totalBudget: 0,
    dailyPerUser: 0,
    startTime: 0,
    endTime: 0,
  };

  async function campaign(token: any, opts: any = {}) {
    const tx = await reg
      .connect(alice)
      .createCampaign(
        intg,
        opts.orderType ?? BUY,
        opts.currency ?? INR,
        await token.getAddress(),
        opts.bps ?? 100,
        opts.flat ?? 0n,
        alice.address,
        opts.budget ?? NB
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
    if (opts.activate !== false) await reg.connect(alice).activate(id);
    return id;
  }

  beforeEach(async function () {
    [admin, alice, keeper, buyer] = await ethers.getSigners();
    intg = ethers.Wallet.createRandom().address;

    orders = await (await ethers.getContractFactory("MockOrderSource")).deploy();
    reg = await (
      await ethers.getContractFactory("CashbackRegistry")
    ).deploy(await orders.getAddress());

    await reg.setAccruer(keeper.address, true);
    await reg.setIntegratorOwner(intg, alice.address);
  });

  // CRITICAL — a USDT-style token moved the funds but read as a failure, so
  // orderPaid was rolled back and the budget counters never incremented.
  // A retrying watcher then drained the wallet one transfer at a time.
  it("a no-return (USDT-style) token pays exactly once and is accounted for", async function () {
    const usdt = await (await ethers.getContractFactory("MockNoReturnToken")).deploy();
    await usdt.mint(alice.address, U6(1_000_000));
    await usdt.connect(alice).approve(await reg.getAddress(), ethers.MaxUint256);

    const id = await campaign(usdt, { bps: 100, budget: { ...NB, totalBudget: U6(5) } });
    await orders.setOrderFull(1, buyer.address, U6(1000), COMPLETED, 0, intg, 0);

    const funderStart = await usdt.balanceOf(alice.address);

    // The watcher retries an order it believes unpaid. Ten attempts.
    for (let i = 0; i < 10; i++) {
      await reg.connect(keeper).pay(1, intg, buyer.address, U6(1000));
    }

    // 1% of 1000 = 10, clamped by the 5-token lifetime budget. Paid ONCE,
    // not once per retry — that is the whole point of the regression.
    expect(await usdt.balanceOf(buyer.address)).to.equal(U6(5));
    expect(funderStart - (await usdt.balanceOf(alice.address))).to.equal(U6(5));

    // And every guard held.
    expect(await reg.orderPaid(1)).to.equal(true);
    expect((await reg.stats(id)).totalPaid).to.equal(U6(5));
    expect((await reg.stats(id)).orderCount).to.equal(1);
  });

  it("a token that returns false still fails and stays retryable", async function () {
    const bad = await (await ethers.getContractFactory("MockBadToken")).deploy(1); // RETURN_FALSE
    await bad.mint(alice.address, U6(1000));
    await bad.connect(alice).approve(await reg.getAddress(), ethers.MaxUint256);

    await campaign(bad, { bps: 100 });
    await orders.setOrderFull(1, buyer.address, U6(1000), COMPLETED, 0, intg, 0);

    await expect(reg.connect(keeper).pay(1, intg, buyer.address, U6(1000))).to.emit(
      reg,
      "PayFailed"
    );
    expect(await reg.orderPaid(1)).to.equal(false);
  });

  // HIGH — startTime was only DEFAULTED to now, not floored, so passing a
  // past value harvested the integrator's whole order history.
  it("startTime is floored at creation time, not merely defaulted", async function () {
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    await usdc.mint(alice.address, U6(1_000_000));
    await usdc.connect(alice).approve(await reg.getAddress(), ethers.MaxUint256);

    // An order placed long before any campaign exists.
    const past = (await ethers.provider.getBlock("latest"))!.timestamp - 90 * 24 * 3600;
    await orders.setOrderFull(1, buyer.address, U6(1000), COMPLETED, 0, intg, past);

    // Owner tries to backdate the campaign to sweep history.
    const id = await campaign(usdc, { bps: 500, budget: { ...NB, startTime: 1 } });

    const c = await reg.getCampaign(id);
    expect(c.startTime).to.be.greaterThan(past); // floored to ~now

    await reg.connect(keeper).pay(1, intg, buyer.address, U6(1000));
    expect(await usdc.balanceOf(buyer.address)).to.equal(0);
  });

  // MEDIUM — setBudget validated endTime against the calldata start, so the
  // "leave unchanged" sentinel (0) let an endTime slip below the real start
  // and silently brick a live campaign.
  it("setBudget validates endTime against the effective start", async function () {
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    await usdc.mint(alice.address, U6(1000));
    await usdc.connect(alice).approve(await reg.getAddress(), ethers.MaxUint256);

    const id = await campaign(usdc, { bps: 100 });

    // startTime 0 means "leave it"; endTime 1 is far below the real start.
    await expect(
      reg.connect(alice).setBudget(id, { ...NB, startTime: 0, endTime: 1 })
    ).to.be.revertedWithCustomError(reg, "InvalidWindow");

    // The campaign is still payable.
    await orders.setOrderFull(1, buyer.address, U6(1000), COMPLETED, 0, intg, 0);
    await reg.connect(keeper).pay(1, intg, buyer.address, U6(1000));
    expect(await usdc.balanceOf(buyer.address)).to.equal(U6(10));
  });

  // MEDIUM — quote() advertised rewards that pay() would not pay.
  it("quote agrees with pay once the budget is exhausted", async function () {
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    await usdc.mint(alice.address, U6(1_000_000));
    await usdc.connect(alice).approve(await reg.getAddress(), ethers.MaxUint256);

    await campaign(usdc, { bps: 500, budget: { ...NB, totalBudget: U6(10) } });

    await orders.setOrderFull(1, buyer.address, U6(200), COMPLETED, 0, intg, 0);
    await reg.connect(keeper).pay(1, intg, buyer.address, U6(200)); // spends the lot

    const [, quoted] = await reg.quote(intg, BUY, INR, U6(200));
    expect(quoted).to.equal(0); // no longer advertises a reward it cannot pay
  });

  it("quote reports zero once the funder revokes authorisation", async function () {
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const [, , , , carol] = await ethers.getSigners();
    await usdc.mint(carol.address, U6(1000));
    await usdc.connect(carol).approve(await reg.getAddress(), ethers.MaxUint256);
    await reg.connect(carol).authorizeCampaignFunder(alice.address, await usdc.getAddress(), true);

    const tx = await reg
      .connect(alice)
      .createCampaign(intg, BUY, INR, await usdc.getAddress(), 100, 0, carol.address, NB);
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
    await reg.connect(alice).activate(id);

    const [, before] = await reg.quote(intg, BUY, INR, U6(1000));
    expect(before).to.equal(U6(10));

    await reg.connect(carol).authorizeCampaignFunder(alice.address, await usdc.getAddress(), false);

    const [, after] = await reg.quote(intg, BUY, INR, U6(1000));
    expect(after).to.equal(0);
  });

  it("quote reports zero when the funding wallet cannot pay", async function () {
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    await usdc.mint(alice.address, U6(1000));
    await usdc.connect(alice).approve(await reg.getAddress(), ethers.MaxUint256);

    await campaign(usdc, { bps: 100 });

    await usdc.connect(alice).approve(await reg.getAddress(), 0); // revoke
    const [, quoted] = await reg.quote(intg, BUY, INR, U6(1000));
    expect(quoted).to.equal(0);
  });

  it("quoteForUser accounts for the per-user daily allowance", async function () {
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    await usdc.mint(alice.address, U6(1_000_000));
    await usdc.connect(alice).approve(await reg.getAddress(), ethers.MaxUint256);

    await campaign(usdc, { bps: 500, budget: { ...NB, dailyPerUser: U6(1) } });

    await orders.setOrderFull(1, buyer.address, U6(1000), COMPLETED, 0, intg, 0);
    await reg.connect(keeper).pay(1, intg, buyer.address, U6(1000));

    const [, forUser] = await reg.quoteForUser(intg, buyer.address, BUY, INR, U6(1000));
    expect(forUser).to.equal(0); // this user is capped out for today

    // A different user still has their full allowance.
    const [, forOther] = await reg.quoteForUser(intg, admin.address, BUY, INR, U6(1000));
    expect(forOther).to.equal(U6(1));
  });
});

// ─── Third-pass audit regressions ────────────────────────────────────
// Two blind spots the third audit found: a token that reports success but
// delivers nothing, and one that delivers less than requested.

describe("CashbackRegistry — third-pass regressions", function () {
  let alice: SignerWithAddress;
  let keeper: SignerWithAddress;
  let buyer: SignerWithAddress;

  let orders: any;
  let reg: any;
  let intg: string;

  const U6 = (n: number | string) => ethers.parseUnits(n.toString(), 6);
  const NB = {
    maxRewardPerOrder: 0,
    dailyBudget: 0,
    totalBudget: 0,
    dailyPerUser: 0,
    startTime: 0,
    endTime: 0,
  };

  async function campaign(token: any, opts: any = {}) {
    const tx = await reg
      .connect(alice)
      .createCampaign(
        intg,
        BUY,
        INR,
        await token.getAddress(),
        opts.bps ?? 100,
        0n,
        alice.address,
        opts.budget ?? NB
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
    await reg.connect(alice).activate(id);
    return id;
  }

  beforeEach(async function () {
    [, alice, keeper, buyer] = await ethers.getSigners();
    intg = ethers.Wallet.createRandom().address;

    orders = await (await ethers.getContractFactory("MockOrderSource")).deploy();
    reg = await (
      await ethers.getContractFactory("CashbackRegistry")
    ).deploy(await orders.getAddress());

    await reg.setAccruer(keeper.address, true);
    await reg.setIntegratorOwner(intg, alice.address);
  });

  // A campaign must not be creatable against a codeless address: a
  // low-level call there succeeds with empty returndata, which the
  // SafeERC20 rule reads as a successful transfer.
  it("rejects a reward token with no code", async function () {
    const eoa = ethers.Wallet.createRandom().address;
    await expect(
      reg.connect(alice).createCampaign(intg, BUY, INR, eoa, 100, 0n, alice.address, NB)
    ).to.be.revertedWithCustomError(reg, "InvalidAddress");
  });

  // A token that reports success but delivers nothing must not burn the
  // order's one payout slot — otherwise no later honest campaign could
  // ever pay that order.
  it("a no-op token does not mark the order paid or inflate totals", async function () {
    const noop = await (await ethers.getContractFactory("MockNoOpToken")).deploy();
    await noop.mint(alice.address, U6(1000));
    await noop.connect(alice).approve(await reg.getAddress(), ethers.MaxUint256);

    const id = await campaign(noop, { bps: 100 });
    await orders.setOrderFull(1, buyer.address, U6(1000), COMPLETED, 0, intg, 0);

    await expect(reg.connect(keeper).pay(1, intg, buyer.address, U6(1000))).to.emit(
      reg,
      "PayFailed"
    );

    expect(await reg.orderPaid(1)).to.equal(false); // slot NOT burned
    expect((await reg.stats(id)).totalPaid).to.equal(0);
    expect((await reg.stats(id)).orderCount).to.equal(0);
  });

  // Budgets must track tokens DELIVERED, not requested — otherwise a
  // fee-on-transfer token exhausts a campaign at twice the real spend.
  it("a fee-on-transfer token accounts the delivered amount", async function () {
    const fee = await (await ethers.getContractFactory("MockFeeToken")).deploy(5000); // 50%
    await fee.mint(alice.address, U6(1_000_000));
    await fee.connect(alice).approve(await reg.getAddress(), ethers.MaxUint256);

    const id = await campaign(fee, { bps: 100 });
    await orders.setOrderFull(1, buyer.address, U6(1000), COMPLETED, 0, intg, 0);
    await reg.connect(keeper).pay(1, intg, buyer.address, U6(1000));

    // 1% of 1000 = 10 requested; 50% fee means 5 delivered.
    expect(await fee.balanceOf(buyer.address)).to.equal(U6(5));
    // The counters must record 5, not 10.
    expect((await reg.stats(id)).totalPaid).to.equal(U6(5));
  });

  it("a fee-on-transfer token does not exhaust the budget early", async function () {
    const fee = await (await ethers.getContractFactory("MockFeeToken")).deploy(5000);
    await fee.mint(alice.address, U6(1_000_000));
    await fee.connect(alice).approve(await reg.getAddress(), ethers.MaxUint256);

    // Budget of 10, 1% of 1000 = 10 requested per order, 50% fee.
    //   order 1: requests 10, delivers 5, budget credited 5  (5 left)
    //   order 2: clamped to the remaining 5, delivers 2.5, credited 2.5
    // Total delivered 7.5. Crediting the REQUESTED amount would have
    // recorded 10 on order 1 and stopped everything after one order.
    await campaign(fee, { bps: 100, budget: { ...NB, totalBudget: U6(10) } });

    for (const i of [1, 2]) {
      await orders.setOrderFull(i, buyer.address, U6(1000), COMPLETED, 0, intg, 0);
      await reg.connect(keeper).pay(i, intg, buyer.address, U6(1000));
    }

    // Both orders paid — the budget was not exhausted by the first alone.
    expect(await fee.balanceOf(buyer.address)).to.equal(U6("7.5"));
  });
});

// ─── Fourth-pass audit regressions ───────────────────────────────────
// Both of these live in the three lines the third pass added: the
// delivered-amount measurement reopened the gas hole F5 had closed, and
// made an unusual token a permanently-failing row.

describe("CashbackRegistry — fourth-pass regressions", function () {
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let keeper: SignerWithAddress;
  let buyer: SignerWithAddress;

  let usdc: any;
  let orders: any;
  let reg: any;
  let intgA: string;
  let intgB: string;

  const U6 = (n: number | string) => ethers.parseUnits(n.toString(), 6);
  const NB = {
    maxRewardPerOrder: 0,
    dailyBudget: 0,
    totalBudget: 0,
    dailyPerUser: 0,
    startTime: 0,
    endTime: 0,
  };

  async function campaign(as: SignerWithAddress, intg: string, token: any, bps = 100) {
    const tx = await reg
      .connect(as)
      .createCampaign(intg, BUY, INR, await token.getAddress(), bps, 0n, as.address, NB);
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
    await reg.connect(as).activate(id);
    return id;
  }

  beforeEach(async function () {
    [, alice, bob, keeper, buyer] = await ethers.getSigners();
    intgA = ethers.Wallet.createRandom().address;
    intgB = ethers.Wallet.createRandom().address;

    usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    orders = await (await ethers.getContractFactory("MockOrderSource")).deploy();
    reg = await (
      await ethers.getContractFactory("CashbackRegistry")
    ).deploy(await orders.getAddress());

    await reg.setAccruer(keeper.address, true);
    await reg.setIntegratorOwner(intgA, alice.address);
    await reg.setIntegratorOwner(intgB, bob.address);

    await usdc.mint(alice.address, U6(1_000_000));
    await usdc.connect(alice).approve(await reg.getAddress(), ethers.MaxUint256);
  });

  // CRITICAL — the delivered-amount measurement must not hand a hostile
  // token 63/64 of the batch's gas via an uncapped balanceOf.
  it("a balanceOf gas bomb cannot starve the rest of the batch", async function () {
    const bomb = await (await ethers.getContractFactory("MockBalanceBomb")).deploy();
    await bomb.mint(bob.address, U6(1_000_000));
    await bomb.connect(bob).approve(await reg.getAddress(), ethers.MaxUint256);

    await campaign(alice, intgA, usdc, 100); // honest
    await campaign(bob, intgB, bomb, 100); // hostile balanceOf

    const reports: any[] = [
      { orderId: 1, integrator: intgB, user: buyer.address, orderAmount: U6(100) },
    ];
    await orders.setOrderFull(1, buyer.address, U6(100), COMPLETED, 0, intgB, 0);
    for (let i = 2; i <= 10; i++) {
      await orders.setOrderFull(i, buyer.address, U6(100), COMPLETED, 0, intgA, 0);
      reports.push({ orderId: i, integrator: intgA, user: buyer.address, orderAmount: U6(100) });
    }

    await reg.connect(keeper).payBatch(reports);

    // All nine honest rows must still be paid.
    expect(await usdc.balanceOf(buyer.address)).to.equal(U6(9));
  });

  // HIGH — a token that shrinks the recipient must fail gracefully, not
  // panic on a checked subtraction and poison the row forever.
  it("a token that lowers the recipient balance fails gracefully", async function () {
    const shrink = await (await ethers.getContractFactory("MockShrinkingToken")).deploy();
    await shrink.mint(alice.address, U6(1_000_000));
    await shrink.mint(buyer.address, U6(100)); // so it has something to halve
    await shrink.connect(alice).approve(await reg.getAddress(), ethers.MaxUint256);

    const id = await campaign(alice, intgA, shrink, 100);
    await orders.setOrderFull(1, buyer.address, U6(1000), COMPLETED, 0, intgA, 0);

    // A DIRECT pay() call must not revert — it degrades to PayFailed.
    await expect(reg.connect(keeper).pay(1, intgA, buyer.address, U6(1000))).to.emit(
      reg,
      "PayFailed"
    );

    expect(await reg.orderPaid(1)).to.equal(false); // retryable, not poisoned
    expect((await reg.stats(id)).totalPaid).to.equal(0);
  });

  it("a shrinking token in a batch does not stop the honest rows", async function () {
    const shrink = await (await ethers.getContractFactory("MockShrinkingToken")).deploy();
    await shrink.mint(bob.address, U6(1_000_000));
    await shrink.mint(buyer.address, U6(100));
    await shrink.connect(bob).approve(await reg.getAddress(), ethers.MaxUint256);

    await campaign(alice, intgA, usdc, 100);
    await campaign(bob, intgB, shrink, 100);

    await orders.setOrderFull(1, buyer.address, U6(100), COMPLETED, 0, intgB, 0);
    await orders.setOrderFull(2, buyer.address, U6(100), COMPLETED, 0, intgA, 0);

    await reg.connect(keeper).payBatch([
      { orderId: 1, integrator: intgB, user: buyer.address, orderAmount: U6(100) },
      { orderId: 2, integrator: intgA, user: buyer.address, orderAmount: U6(100) },
    ]);

    expect(await usdc.balanceOf(buyer.address)).to.equal(U6(1)); // honest row paid
  });
});

// ─── Second-pass audit regressions (N1–N9, M1–M4) ────────────────────
// Self-contained fixture: these must not depend on the helpers above, so a
// change to another block's setup cannot quietly weaken them.

describe("CashbackRegistry — second-pass audit regressions", function () {
  const U6 = (n: number | string) => ethers.parseUnits(n.toString(), 6);
  const ANY_ = ethers.ZeroHash;
  const BUY_ = ethers.encodeBytes32String("BUY");
  const INR_ = ethers.encodeBytes32String("INR");
  const DONE = 3;
  const NOBUDGET = {
    maxRewardPerOrder: 0n,
    dailyBudget: 0n,
    totalBudget: 0n,
    dailyPerUser: 0n,
    startTime: 0n,
    endTime: 0n,
  };

  let owner: any, keeper: any, user: any, other: any;
  let token: any, orders: any, reg: any, integ: string;

  const now = async () => (await ethers.provider.getBlock("latest"))!.timestamp;

  function idFrom(rc: any) {
    return rc.logs
      .map((l: any) => {
        try {
          return reg.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e: any) => e && e.name === "CampaignCreated").args.campaignId;
  }

  async function mk(opts: any = {}) {
    const tx = await reg
      .connect(opts.as ?? owner)
      .createCampaign(
        integ,
        opts.orderType ?? BUY_,
        opts.currency ?? INR_,
        opts.token ?? (await token.getAddress()),
        opts.bps ?? 100,
        opts.flat ?? 0n,
        opts.funder ?? owner.address,
        { ...NOBUDGET, ...(opts.budget ?? {}) }
      );
    const id = idFrom(await tx.wait());
    if (opts.activate !== false) await reg.connect(opts.as ?? owner).activate(id);
    return id;
  }

  beforeEach(async function () {
    [, keeper, owner, user, other] = await ethers.getSigners();
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

  // ── N3: an out-of-window campaign must not hold the resolution slot ──

  it("N3: a future-dated campaign no longer shadows the live wildcard beneath it", async function () {
    await mk({ orderType: ANY_, currency: ANY_, bps: 100 }); // integrator-wide, live
    const t = await now();
    await mk({ bps: 300, budget: { startTime: BigInt(t + 7 * 24 * 3600) } }); // starts next week

    await orders.setOrderFull(1, user.address, U6(1000), DONE, 0, integ, t);
    await reg.connect(keeper).pay(1, integ, user.address, U6(1000));

    // Falls through to the wildcard instead of resolving to a campaign that
    // cannot pay this order. Previously: nothing was paid at all.
    expect(await token.balanceOf(user.address)).to.equal(U6(10));
  });

  it("N3: an expired campaign no longer shadows the live wildcard beneath it", async function () {
    await mk({ orderType: ANY_, currency: ANY_, bps: 100 });
    const t = await now();
    await mk({ bps: 300, budget: { endTime: BigInt(t + 100) } });

    await ethers.provider.send("evm_increaseTime", [500]);
    await ethers.provider.send("evm_mine", []);
    const later = await now();

    await orders.setOrderFull(2, user.address, U6(1000), DONE, 0, integ, later);
    await reg.connect(keeper).pay(2, integ, user.address, U6(1000));
    expect(await token.balanceOf(user.address)).to.equal(U6(10));
  });

  it("N3: resolution is judged at the ORDER's time, so a late report still pays", async function () {
    // Regression guard on the N3 fix. Resolving against `block.timestamp`
    // would have broken every order reported after its campaign's window
    // closed — and the watcher holds orders for up to a 14-day dispute TTL.
    await mk({ orderType: ANY_, currency: ANY_, bps: 100 });
    const promo = await mk({ bps: 300, budget: { endTime: BigInt((await now()) + 100) } });
    // Read the clock AFTER activation: the campaign's start is floored at its
    // own creation block, so an order stamped earlier is legitimately outside
    // its window and would (correctly) fall through to the wildcard.
    const t = await now();

    await orders.setOrderFull(3, user.address, U6(1000), DONE, 0, integ, t); // placed in window

    await ethers.provider.send("evm_increaseTime", [5000]); // reported long after
    await ethers.provider.send("evm_mine", []);

    await expect(reg.connect(keeper).pay(3, integ, user.address, U6(1000)))
      .to.emit(reg, "Paid")
      .withArgs(promo, 3, user.address, await token.getAddress(), U6(30));
    expect(await token.balanceOf(user.address)).to.equal(U6(30)); // 3%, not the 1% wildcard
  });

  // ── N4: the window is validated against the FLOORED start ──

  it("N4: createCampaign rejects an endTime below the floored start", async function () {
    await expect(
      mk({ budget: { startTime: 0n, endTime: 1000n }, activate: false })
    ).to.be.revertedWithCustomError(reg, "InvalidWindow");
  });

  it("N4: a legitimately scheduled future window is still accepted", async function () {
    const t = await now();
    const id = await mk({
      budget: { startTime: BigInt(t + 3600), endTime: BigInt(t + 7200) },
      activate: false,
    });
    const c = await reg.getCampaign(id);
    expect(c.startTime).to.be.lessThan(c.endTime);
  });

  // ── N5: quote() models the window ──

  it("N5: quote does not advertise a campaign that has not started", async function () {
    const t = await now();
    await mk({ bps: 300, budget: { startTime: BigInt(t + 7 * 24 * 3600) } });

    const [, quoted] = await reg.quote(integ, BUY_, INR_, U6(1000));
    expect(quoted).to.equal(0); // was U6(30) while pay() paid 0

    await orders.setOrderFull(4, user.address, U6(1000), DONE, 0, integ, t);
    await reg.connect(keeper).pay(4, integ, user.address, U6(1000));
    expect(await token.balanceOf(user.address)).to.equal(0);
  });

  it("N5: quote falls through to the campaign that would actually pay", async function () {
    await mk({ orderType: ANY_, currency: ANY_, bps: 100 });
    const t = await now();
    await mk({ bps: 300, budget: { startTime: BigInt(t + 7 * 24 * 3600) } });

    const [, quoted] = await reg.quote(integ, BUY_, INR_, U6(1000));
    expect(quoted).to.equal(U6(10)); // the wildcard's 1%, which is what pay() pays
  });

  it("N5/N6: quote reports 0 rather than a partial amount the funder cannot cover", async function () {
    await token.connect(owner).approve(await reg.getAddress(), U6(1)); // only 1 available
    await mk({ bps: 100 });
    const [, quoted] = await reg.quote(integ, BUY_, INR_, U6(1000)); // wants U6(10)
    expect(quoted).to.equal(0); // pay() would fail on the shortfall, not pay 1
  });

  // ── N6: budget boundaries defer instead of paying dust ──

  it("N6: an order that does not fit today's budget is deferred, not paid dust", async function () {
    await mk({ bps: 100, budget: { dailyBudget: U6(10) + 1n } });
    const t = await now();

    await orders.setOrderFull(5, other.address, U6(1000), DONE, 0, integ, t);
    await reg.connect(keeper).pay(5, integ, other.address, U6(1000)); // consumes U6(10)

    await orders.setOrderFull(6, user.address, U6(1000), DONE, 0, integ, t);
    await expect(reg.connect(keeper).pay(6, integ, user.address, U6(1000)))
      .to.emit(reg, "PayDeclined")
      .withArgs(6, 10); // BUDGET_EXHAUSTED — retryable

    expect(await token.balanceOf(user.address)).to.equal(0); // not one micro-unit
    expect(await reg.orderPaid(6)).to.equal(false); // slot NOT burned
  });

  it("N6: the deferred order pays in full once the daily budget resets", async function () {
    await mk({ bps: 100, budget: { dailyBudget: U6(10) + 1n } });
    const t = await now();

    await orders.setOrderFull(7, other.address, U6(1000), DONE, 0, integ, t);
    await reg.connect(keeper).pay(7, integ, other.address, U6(1000));
    await orders.setOrderFull(8, user.address, U6(1000), DONE, 0, integ, t);
    await reg.connect(keeper).pay(8, integ, user.address, U6(1000)); // deferred

    await ethers.provider.send("evm_increaseTime", [2 * 24 * 3600]);
    await ethers.provider.send("evm_mine", []);

    await reg.connect(keeper).pay(8, integ, user.address, U6(1000));
    expect(await token.balanceOf(user.address)).to.equal(U6(10)); // in full, a day later
  });

  it("N6: a reward larger than the whole cap is still paid best-effort, not deadlocked", async function () {
    // The case that makes a flat all-or-nothing rule wrong: deferring could
    // never help here, so withholding would be silent non-payment forever.
    await mk({ bps: 100, budget: { dailyPerUser: U6(1) } }); // cap below one reward
    const t = await now();

    await orders.setOrderFull(9, user.address, U6(1000), DONE, 0, integ, t);
    await reg.connect(keeper).pay(9, integ, user.address, U6(1000));
    expect(await token.balanceOf(user.address)).to.equal(U6(1)); // clamped, not 0
  });

  // ── F8: the wildcard hole ──

  it("F8: a wildcard campaign does not pay a SELL order", async function () {
    await mk({ orderType: ANY_, currency: ANY_, bps: 100 });
    const proxy = ethers.Wallet.createRandom().address;
    const t = await now();

    await orders.setOrderFull(10, proxy, U6(1000), DONE, 1, integ, t); // 1 = SELL
    await expect(reg.connect(keeper).pay(10, integ, proxy, U6(1000)))
      .to.emit(reg, "PayDeclined")
      .withArgs(10, 3); // ORDER_TYPE — terminal
    expect(await token.balanceOf(proxy)).to.equal(0);
  });

  // ── M1: setBudget cannot silently un-bound a campaign ──

  it("M1: setBudget refuses to clear an endTime that is already set", async function () {
    const t = await now();
    const id = await mk({ bps: 100, budget: { endTime: BigInt(t + 10000) } });

    await expect(
      reg.connect(owner).setBudget(id, { ...NOBUDGET, endTime: 0n })
    ).to.be.revertedWithCustomError(reg, "InvalidWindow");

    const c = await reg.getCampaign(id);
    expect(c.endTime).to.equal(BigInt(t + 10000)); // still bounded
  });

  it("M1: the budget event carries every resulting value", async function () {
    const t = await now();
    const id = await mk({ bps: 100, budget: { endTime: BigInt(t + 10000) } });
    const c = await reg.getCampaign(id);

    await expect(
      reg
        .connect(owner)
        .setBudget(id, { ...NOBUDGET, dailyBudget: U6(50), endTime: BigInt(t + 10000) })
    )
      .to.emit(reg, "CampaignBudgetChanged")
      .withArgs(id, 0, U6(50), 0, 0, c.startTime, BigInt(t + 10000));
  });

  // ── M2: the flat ceiling means the same thing at every precision ──

  it("M2: the flat ceiling is 1,000 whole tokens at 6dp and at 18dp", async function () {
    const t18 = await (await ethers.getContractFactory("MockToken18")).deploy();
    expect(await reg.maxFlatAmountFor(await token.getAddress())).to.equal(U6(1000));
    expect(await reg.maxFlatAmountFor(await t18.getAddress())).to.equal(
      ethers.parseUnits("1000", 18)
    );
  });

  it("M2: a flat reward the old fixed ceiling allowed is now rejected on a 6dp token", async function () {
    await expect(
      mk({ bps: 0, flat: 10n ** 21n, activate: false }) // the old MAX_FLAT_AMOUNT
    ).to.be.revertedWithCustomError(reg, "InvalidRate");
  });

  it("M2: setRate is bounded by the same ceiling", async function () {
    const id = await mk({ bps: 100 });
    await expect(reg.connect(owner).setRate(id, 0, U6(1000) + 1n)).to.be.revertedWithCustomError(
      reg,
      "InvalidRate"
    );
    await reg.connect(owner).setRate(id, 0, U6(1000)); // at the ceiling: fine
  });

  // ── N1: declines are legible, and typed terminal vs retryable ──

  it("N1: an order with no campaign is declined terminally", async function () {
    const t = await now();
    await orders.setOrderFull(11, user.address, U6(1000), DONE, 0, integ, t);
    await expect(reg.connect(keeper).pay(11, integ, user.address, U6(1000)))
      .to.emit(reg, "PayDeclined")
      .withArgs(11, 4); // NO_CAMPAIGN
  });

  it("N1: a paused campaign leaves the order unpaid and retryable", async function () {
    const id = await mk({ bps: 100 });
    const t = await now();
    await reg.connect(owner).pause(id);

    await orders.setOrderFull(12, user.address, U6(1000), DONE, 0, integ, t);
    // Must NOT read as NO_CAMPAIGN (terminal) — a paused campaign resumes,
    // and retiring the order here is exactly the N1 failure one level down.
    await expect(reg.connect(keeper).pay(12, integ, user.address, U6(1000)))
      .to.emit(reg, "PayDeclined")
      .withArgs(12, 5); // CAMPAIGN_INACTIVE — retryable
    expect(await reg.orderPaid(12)).to.equal(false);

    // Resuming pays the same order — the property the watcher's retry needs.
    await reg.connect(owner).activate(id);
    await reg.connect(keeper).pay(12, integ, user.address, U6(1000));
    expect(await token.balanceOf(user.address)).to.equal(U6(10));
  });

  it("N1: a revoked funder declines retryably and the order stays payable", async function () {
    const treasury = other;
    await token.mint(treasury.address, U6(100000));
    await token.connect(treasury).approve(await reg.getAddress(), ethers.MaxUint256);
    await reg
      .connect(treasury)
      .authorizeCampaignFunder(owner.address, await token.getAddress(), true);

    await mk({ bps: 100, funder: treasury.address });
    const t = await now();

    await reg
      .connect(treasury)
      .authorizeCampaignFunder(owner.address, await token.getAddress(), false);

    await orders.setOrderFull(13, user.address, U6(1000), DONE, 0, integ, t);
    await expect(reg.connect(keeper).pay(13, integ, user.address, U6(1000)))
      .to.emit(reg, "PayDeclined")
      .withArgs(13, 8); // FUNDER_UNAUTHORIZED — retryable
    expect(await reg.orderPaid(13)).to.equal(false);

    await reg
      .connect(treasury)
      .authorizeCampaignFunder(owner.address, await token.getAddress(), true);
    await reg.connect(keeper).pay(13, integ, user.address, U6(1000));
    expect(await token.balanceOf(user.address)).to.equal(U6(10));
  });

  it("N1: a second payment attempt on a paid order is declined as ALREADY_PAID", async function () {
    await mk({ bps: 100 });
    const t = await now();
    await orders.setOrderFull(14, user.address, U6(1000), DONE, 0, integ, t);
    await reg.connect(keeper).pay(14, integ, user.address, U6(1000));

    await expect(reg.connect(keeper).pay(14, integ, user.address, U6(1000)))
      .to.emit(reg, "PayDeclined")
      .withArgs(14, 1);
    expect(await token.balanceOf(user.address)).to.equal(U6(10)); // paid exactly once
  });

  // ── M3: the view path is gas-capped too ──

  it("M3: a hostile reward token cannot brick quote or campaignView", async function () {
    const bomb = await (await ethers.getContractFactory("MockBalanceBomb")).deploy();
    await bomb.mint(owner.address, U6(1000000));
    await bomb.connect(owner).approve(await reg.getAddress(), ethers.MaxUint256);

    const id = await mk({ token: await bomb.getAddress(), bps: 100 });

    // Both must return rather than revert; an unreadable balance reads as 0.
    const [, quoted] = await reg.quote(integ, BUY_, INR_, U6(1000));
    expect(quoted).to.equal(0);
    const view = await reg.campaignView(id);
    expect(view.spendable).to.equal(0);
  });
});
