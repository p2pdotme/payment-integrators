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
        (opts.as ?? funder).address
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
  async function completedOrder(orderId: number, who: string, amount: bigint) {
    await orders.setOrder(orderId, who, amount, COMPLETED);
  }

  // ─── Creating campaigns ────────────────────────────────────────────

  describe("createCampaign", function () {
    it("rejects an unclaimed integrator", async function () {
      const unclaimed = ethers.Wallet.createRandom().address;
      await expect(
        registry
          .connect(funder)
          .createCampaign(unclaimed, BUY, INR, await token.getAddress(), 100, 0, funder.address)
      ).to.be.revertedWithCustomError(registry, "IntegratorUnclaimed");
    });

    it("rejects a zero reward token or funding wallet", async function () {
      await expect(
        registry
          .connect(funder)
          .createCampaign(integrator, BUY, INR, ethers.ZeroAddress, 100, 0, funder.address)
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
            ethers.ZeroAddress
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
            funder.address
          )
      ).to.be.revertedWithCustomError(registry, "InvalidRate");
    });

    it("rejects neither bps nor flatAmount set", async function () {
      await expect(
        registry
          .connect(funder)
          .createCampaign(integrator, BUY, INR, await token.getAddress(), 0, 0, funder.address)
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
            funder.address
          )
      ).to.be.revertedWithCustomError(registry, "InvalidRate");
    });

    it("starts INACTIVE and does not pay until activated", async function () {
      const id = await makeCampaign({ bps: 100, activate: false });
      expect((await registry.getCampaign(id)).status).to.equal(Status.INACTIVE);

      await completedOrder(1, user.address, USDC(100));
      await registry.connect(watcher).pay(1, integrator, user.address, BUY, INR, USDC(100));

      expect(await token.balanceOf(user.address)).to.equal(0);
      expect(await registry.orderPaid(1)).to.equal(false);
    });

    it("only the integrator owner may create campaigns", async function () {
      await expect(
        registry
          .connect(stranger)
          .createCampaign(integrator, BUY, INR, await token.getAddress(), 100, 0, stranger.address)
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
      await registry.connect(watcher).pay(1, integrator, user.address, BUY, INR, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(0);
    });

    it("setRate retunes a running campaign", async function () {
      const id = await makeCampaign({ bps: 100 });

      await completedOrder(1, user.address, USDC(100));
      await registry.connect(watcher).pay(1, integrator, user.address, BUY, INR, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(USDC(1)); // 1%

      await registry.connect(funder).setRate(id, 200, 0); // bump to 2%

      await completedOrder(2, user.address, USDC(100));
      await registry.connect(watcher).pay(2, integrator, user.address, BUY, INR, USDC(100));
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
      await registry.connect(watcher).pay(1, integrator, user.address, BUY, INR, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(USDC(5)); // exact INR row
    });

    it("falls back to (orderType, ANY) for an unlisted currency", async function () {
      await makeCampaign({ orderType: BUY, currency: ANY, bps: 100 });

      await completedOrder(1, user.address, USDC(100));
      await registry.connect(watcher).pay(1, integrator, user.address, BUY, BRL, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(USDC(1));
    });

    it("falls back to the integrator-wide default", async function () {
      await makeCampaign({ orderType: ANY, currency: ANY, bps: 100 });

      await completedOrder(1, user.address, USDC(100));
      await registry.connect(watcher).pay(1, integrator, user.address, SELL, BRL, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(USDC(1));
    });

    it("an unknown integrator pays nothing and does not revert", async function () {
      await makeCampaign({ bps: 100 });
      const strangerIntegrator = ethers.Wallet.createRandom().address;

      await completedOrder(1, user.address, USDC(100));
      await expect(
        registry.connect(watcher).pay(1, strangerIntegrator, user.address, BUY, INR, USDC(100))
      ).to.not.be.reverted;
      expect(await token.balanceOf(user.address)).to.equal(0);
    });
  });

  // ─── Reward maths ──────────────────────────────────────────────────

  describe("reward calculation", function () {
    it("pays a percentage of the order", async function () {
      await makeCampaign({ bps: 100 }); // 1%
      await completedOrder(1, user.address, USDC(100));
      await registry.connect(watcher).pay(1, integrator, user.address, BUY, INR, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(USDC(1));
    });

    it("pays a flat amount regardless of order size", async function () {
      await makeCampaign({ flat: USDC(5) });

      await completedOrder(1, user.address, USDC(100));
      await registry.connect(watcher).pay(1, integrator, user.address, BUY, INR, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(USDC(5));

      await completedOrder(2, other.address, USDC(10_000));
      await registry.connect(watcher).pay(2, integrator, other.address, BUY, INR, USDC(10_000));
      expect(await token.balanceOf(other.address)).to.equal(USDC(5));
    });

    it("rounds down (never overpays)", async function () {
      await makeCampaign({ bps: 250 }); // 2.5%
      // 1 micro-USDC * 250 / 10000 = 0.025 → floors to 0 → nothing paid
      await completedOrder(1, user.address, 1n);
      await registry.connect(watcher).pay(1, integrator, user.address, BUY, INR, 1n);
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
      await registry.connect(watcher).pay(1, integrator, user.address, BUY, INR, USDC(100));
      await registry.connect(watcher).pay(1, integrator, user.address, BUY, INR, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(USDC(1));
    });

    it("pays nothing for an order that is not COMPLETED", async function () {
      await orders.setOrder(1, user.address, USDC(100), PLACED);
      await registry.connect(watcher).pay(1, integrator, user.address, BUY, INR, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(0);

      await orders.setOrder(2, user.address, USDC(100), CANCELLED);
      await registry.connect(watcher).pay(2, integrator, user.address, BUY, INR, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(0);
    });

    it("pays nothing for an order that does not exist", async function () {
      await registry.connect(watcher).pay(99, integrator, user.address, BUY, INR, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(0);
    });

    it("rejects a mismatched user — a lying watcher cannot redirect funds", async function () {
      await completedOrder(1, user.address, USDC(100));
      // Watcher claims the reward belongs to `other`.
      await registry.connect(watcher).pay(1, integrator, other.address, BUY, INR, USDC(100));
      expect(await token.balanceOf(other.address)).to.equal(0);
      expect(await token.balanceOf(user.address)).to.equal(0);
    });

    it("rejects a mismatched amount — a lying watcher cannot inflate rewards", async function () {
      await completedOrder(1, user.address, USDC(100));
      // Watcher claims the order was for 1,000,000 rather than 100.
      await registry.connect(watcher).pay(1, integrator, user.address, BUY, INR, USDC(1_000_000));
      expect(await token.balanceOf(user.address)).to.equal(0);
    });

    it("fails closed when the Diamond is unreachable", async function () {
      await completedOrder(1, user.address, USDC(100));
      await orders.setReverting(true);
      await expect(registry.connect(watcher).pay(1, integrator, user.address, BUY, INR, USDC(100)))
        .to.not.be.reverted;
      expect(await token.balanceOf(user.address)).to.equal(0);
    });

    it("rejects a caller that is not an allowlisted watcher", async function () {
      await completedOrder(1, user.address, USDC(100));
      await expect(
        registry.connect(stranger).pay(1, integrator, user.address, BUY, INR, USDC(100))
      ).to.be.revertedWithCustomError(registry, "OnlyAccruer");
    });

    it("a revoked watcher can no longer report", async function () {
      await registry.setAccruer(watcher.address, false);
      await completedOrder(1, user.address, USDC(100));
      await expect(
        registry.connect(watcher).pay(1, integrator, user.address, BUY, INR, USDC(100))
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
      await expect(
        registry.connect(watcher).pay(1, integrator, user.address, BUY, INR, USDC(100))
      ).to.emit(registry, "PayFailed");

      // Crucially: the order stays unpaid, so it can be retried.
      expect(await registry.orderPaid(1)).to.equal(false);
      expect(await token.balanceOf(user.address)).to.equal(0);
    });

    it("succeeds on retry after the wallet is topped up", async function () {
      await makeCampaign({ bps: 100 });

      const bal = await token.balanceOf(funder.address);
      await token.connect(funder).transfer(stranger.address, bal);

      await completedOrder(1, user.address, USDC(100));
      await registry.connect(watcher).pay(1, integrator, user.address, BUY, INR, USDC(100));
      expect(await registry.orderPaid(1)).to.equal(false);

      // Top up, retry.
      await token.mint(funder.address, USDC(100));
      await expect(
        registry.connect(watcher).pay(1, integrator, user.address, BUY, INR, USDC(100))
      ).to.emit(registry, "Paid");
      expect(await token.balanceOf(user.address)).to.equal(USDC(1));
    });

    it("revoking the approval halts payouts (the kill switch)", async function () {
      await makeCampaign({ bps: 100 });
      await token.connect(funder).approve(await registry.getAddress(), 0);

      await completedOrder(1, user.address, USDC(100));
      await expect(
        registry.connect(watcher).pay(1, integrator, user.address, BUY, INR, USDC(100))
      ).to.emit(registry, "PayFailed");
      expect(await token.balanceOf(user.address)).to.equal(0);
    });

    it("handles a token whose transferFrom reverts", async function () {
      const Bad = await ethers.getContractFactory("MockBadToken");
      const bad = await Bad.deploy(0); // REVERT mode

      const tx = await registry
        .connect(funder)
        .createCampaign(integrator, BUY, INR, await bad.getAddress(), 100, 0, funder.address);
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
      await expect(
        registry.connect(watcher).pay(1, integrator, user.address, BUY, INR, USDC(100))
      ).to.emit(registry, "PayFailed");
      expect(await registry.orderPaid(1)).to.equal(false);
    });

    it("handles a token whose transferFrom returns false without reverting", async function () {
      const Bad = await ethers.getContractFactory("MockBadToken");
      const bad = await Bad.deploy(1); // RETURN_FALSE mode

      const tx = await registry
        .connect(funder)
        .createCampaign(integrator, BUY, INR, await bad.getAddress(), 100, 0, funder.address);
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
      await expect(
        registry.connect(watcher).pay(1, integrator, user.address, BUY, INR, USDC(100))
      ).to.emit(registry, "PayFailed");
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
      await registry.connect(watcher).pay(1, integrator, user.address, BUY, INR, USDC(100));
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
      await registry.connect(watcher).pay(1, ethers.ZeroAddress, user.address, BUY, INR, USDC(100));
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
      await expect(
        registry.connect(watcher).pay(77, integrator, merchant.address, BUY, INR, USDC(1000))
      )
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
      await registry.connect(watcher).pay(1, integrator, user.address, BUY, INR, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(USDC(1));

      await completedOrder(2, other.address, USDC(100));
      await registry.connect(watcher).pay(2, integrator, other.address, BUY, BRL, USDC(100));
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
      await completedOrder(1, user.address, USDC(100));
      await registry.connect(watcher).pay(1, integratorB, user.address, BUY, INR, USDC(100));

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

      await completedOrder(1, user.address, USDC(100));
      await registry.connect(watcher).pay(1, integratorB, user.address, BUY, INR, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(0); // theirs fails

      await completedOrder(2, user.address, USDC(100));
      await registry.connect(watcher).pay(2, integrator, user.address, BUY, INR, USDC(100));
      expect(await token.balanceOf(user.address)).to.equal(USDC(1)); // ours still pays
    });

    it("cannot point a campaign at a wallet you do not control", async function () {
      // `stranger` owns an integrator but tries to fund from `funder`'s wallet.
      const integratorB = ethers.Wallet.createRandom().address;
      await registry.setIntegratorOwner(integratorB, stranger.address);

      await expect(
        registry
          .connect(stranger)
          .createCampaign(integratorB, BUY, INR, await token.getAddress(), 100, 0, funder.address)
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
          .createCampaign(integrator, BUY, INR, await token.getAddress(), 100, 0, treasury.address)
      ).to.be.revertedWithCustomError(registry, "FundingWalletNotAuthorized");
    });

    it("a wallet that explicitly authorised you may be used as the funding source", async function () {
      const treasury = other;
      await token.mint(treasury.address, USDC(1000));
      await token.connect(treasury).approve(await registry.getAddress(), ethers.MaxUint256);
      // Only the wallet itself can grant this.
      await registry.connect(treasury).authorizeCampaignFunder(funder.address, true);

      await expect(
        registry
          .connect(funder)
          .createCampaign(integrator, BUY, INR, await token.getAddress(), 100, 0, treasury.address)
      ).to.not.be.reverted;
    });

    it("repoints a campaign's funding wallet", async function () {
      const id = await makeCampaign({ bps: 100 });

      await token.mint(other.address, USDC(1000));
      await token.connect(other).approve(await registry.getAddress(), ethers.MaxUint256);
      await registry.connect(other).authorizeCampaignFunder(funder.address, true);
      await registry.connect(funder).setCampaignFundingWallet(id, other.address);

      const otherBefore = await token.balanceOf(other.address);
      await completedOrder(1, user.address, USDC(100));
      await registry.connect(watcher).pay(1, integrator, user.address, BUY, INR, USDC(100));

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
      await registry.connect(watcher).pay(1, integrator, user.address, BUY, INR, USDC(100));
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
      await expect(registry.connect(deployer).setRate(id, 2000, 0)).to.be.revertedWithCustomError(
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
      await registry.connect(watcher).pay(1, integrator, user.address, BUY, INR, USDC(100));
      await completedOrder(2, other.address, USDC(300));
      await registry.connect(watcher).pay(2, integrator, other.address, BUY, INR, USDC(300));

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
      .createCampaign(intg, orderType, currency, await token2.getAddress(), bps, flat, funder);
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
    await orders2.setOrder(1, user2.address, U6(100), 3);
    await reg.connect(watcher2).pay(1, intg, user2.address, BUY, INR, U6(100));

    expect(await token2.balanceOf(user2.address)).to.equal(0);
    expect(await token2.balanceOf(alice.address)).to.equal(before);
  });

  // CRITICAL 1b — the flat path was the unbounded one.
  it("rejects a flat reward above the ceiling", async function () {
    const max = await reg.MAX_FLAT_AMOUNT();
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
    await reg.connect(carol).authorizeCampaignFunder(alice.address, true);

    const id = await newCampaign(alice, carol.address, 100);
    await reg.connect(alice).activate(id);

    await orders2.setOrder(1, user2.address, U6(100), 3);
    await reg.connect(watcher2).pay(1, intg, user2.address, BUY, INR, U6(100));
    expect(await token2.balanceOf(user2.address)).to.equal(U6(1));

    await reg.connect(carol).authorizeCampaignFunder(alice.address, false);

    await orders2.setOrder(2, user2.address, U6(100), 3);
    await reg.connect(watcher2).pay(2, intg, user2.address, BUY, INR, U6(100));
    expect(await token2.balanceOf(user2.address)).to.equal(U6(1)); // unchanged
  });

  // HIGH 3 — a retired narrow campaign must not shadow a healthy broad one.
  it("resolution falls through a retired campaign to a healthy broader one", async function () {
    const narrow = await newCampaign(alice, alice.address, 500);
    await reg.connect(alice).activate(narrow);

    const wide = await newCampaign(alice, alice.address, 100, 0n, ANY, ANY);
    await reg.connect(alice).activate(wide);

    await orders2.setOrder(1, user2.address, U6(100), 3);
    await reg.connect(watcher2).pay(1, intg, user2.address, BUY, INR, U6(100));
    expect(await token2.balanceOf(user2.address)).to.equal(U6(5)); // narrow wins

    await reg.connect(admin).emergencyStop(narrow, true);

    await orders2.setOrder(2, user2.address, U6(100), 3);
    await reg.connect(watcher2).pay(2, intg, user2.address, BUY, INR, U6(100));
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
    await expect(reg.connect(admin).setRate(id, 2000, 0)).to.be.revertedWithCustomError(
      reg,
      "OnlyIntegratorOwner"
    );

    await expect(reg.connect(admin).emergencyStop(id, false)).to.not.be.reverted;
  });
});
