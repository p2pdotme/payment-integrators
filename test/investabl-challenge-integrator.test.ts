import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("InvestablChallengeCheckoutIntegrator — goods model, ≤50 cap, no KYC", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let user2: SignerWithAddress;
  let treasury: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let integrator: any;

  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
  const PER_TX_CAP = USDC(50);
  const DAILY_COUNT_LIMIT = 10;
  const BUYIN = USDC(15); // the $15 challenge buy-in
  const INR = ethers.encodeBytes32String("INR");
  const SESSION_REF = ethers.encodeBytes32String("sess-1");
  const CIRCLE_ID = 1;

  // buyChallenge(amount, currency, circleId, pubKey, prefPCC, fiatAmountLimit, sessionRef)
  const buy = (signer: SignerWithAddress, amount = BUYIN, ref = SESSION_REF) =>
    integrator.connect(signer).buyChallenge(amount, INR, CIRCLE_ID, "", 0, 0, ref);

  beforeEach(async function () {
    [owner, user, user2, treasury] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUsdc = await MockUSDC.deploy();

    const MockDiamond = await ethers.getContractFactory("MockDiamond");
    mockDiamond = await MockDiamond.deploy(await mockUsdc.getAddress());

    const Integrator = await ethers.getContractFactory("InvestablChallengeCheckoutIntegrator");
    integrator = await Integrator.deploy(
      await mockDiamond.getAddress(),
      await mockUsdc.getAddress(),
      PER_TX_CAP,
      DAILY_COUNT_LIMIT
    );

    await mockDiamond.registerIntegrator(
      await integrator.getAddress(),
      await integrator.proxyImpl()
    );
    // Fund the Diamond so it can deliver USDC to the integrator on completion.
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(100000));
  });

  describe("Happy path", function () {
    it("places an order, stores the session, emits ChallengeOrderCreated", async function () {
      await expect(buy(user))
        .to.emit(integrator, "ChallengeOrderCreated")
        .withArgs(1, user.address, BUYIN, INR, SESSION_REF);

      const s = await integrator.sessions(1);
      expect(s.user).to.equal(user.address);
      expect(s.amount).to.equal(BUYIN);
      expect(s.sessionRef).to.equal(SESSION_REF);
      expect(s.fulfilled).to.equal(false);
      expect(await integrator.getTodayCount(user.address)).to.equal(1);
    });

    it("on completion: USDC lands on the integrator, session fulfilled, ChallengePurchased emitted", async function () {
      await buy(user);
      await expect(mockDiamond.simulateOrderComplete(1))
        .to.emit(integrator, "ChallengePurchased")
        .withArgs(1, user.address, BUYIN, SESSION_REF);

      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(BUYIN);
      const s = await integrator.sessions(1);
      expect(s.fulfilled).to.equal(true);
    });

    it("owner sweeps accrued USDC to treasury", async function () {
      await buy(user);
      await mockDiamond.simulateOrderComplete(1);
      await integrator.setTreasury(treasury.address);

      await expect(integrator.sweepUsdc(BUYIN))
        .to.emit(integrator, "UsdcSwept")
        .withArgs(treasury.address, BUYIN);
      expect(await mockUsdc.balanceOf(treasury.address)).to.equal(BUYIN);
    });
  });

  describe("Per-tx cap (no KYC, absolute cap)", function () {
    it("allows amount == cap", async function () {
      await expect(buy(user, PER_TX_CAP)).to.emit(integrator, "ChallengeOrderCreated");
    });

    it("reverts AmountExceedsCap above the cap", async function () {
      await expect(buy(user, PER_TX_CAP + 1n)).to.be.revertedWithCustomError(
        integrator,
        "AmountExceedsCap"
      );
    });

    it("reverts InvalidAmount on zero amount", async function () {
      await expect(buy(user, 0n)).to.be.revertedWithCustomError(integrator, "InvalidAmount");
    });
  });

  describe("Daily count limit", function () {
    it("enforces the daily order count", async function () {
      for (let i = 0; i < DAILY_COUNT_LIMIT; i++) {
        await buy(user, BUYIN, ethers.encodeBytes32String("sess-" + i));
      }
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(0);
      await expect(buy(user)).to.be.revertedWithCustomError(integrator, "DailyCountExceeded");
    });

    it("onOrderCancel releases a daily-count slot + emits ChallengeOrderCancelled", async function () {
      await buy(user);
      expect(await integrator.getTodayCount(user.address)).to.equal(1);
      await expect(mockDiamond.simulateOrderCancelled(1))
        .to.emit(integrator, "ChallengeOrderCancelled")
        .withArgs(1, user.address);
      expect(await integrator.getTodayCount(user.address)).to.equal(0);
      const s = await integrator.sessions(1);
      expect(s.cancelled).to.equal(true);
    });
  });

  describe("validateOrder (onlyDiamond, authoritative)", function () {
    let asDiamond: any;
    beforeEach(async function () {
      const addr = await mockDiamond.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [addr]);
      await ethers.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
      asDiamond = await ethers.getSigner(addr);
    });

    it("returns true within cap and count", async function () {
      expect(
        await integrator.connect(asDiamond).validateOrder.staticCall(user.address, BUYIN, INR)
      ).to.equal(true);
    });
    it("returns false above cap", async function () {
      expect(
        await integrator
          .connect(asDiamond)
          .validateOrder.staticCall(user.address, PER_TX_CAP + 1n, INR)
      ).to.equal(false);
    });
    it("returns false on zero amount", async function () {
      expect(
        await integrator.connect(asDiamond).validateOrder.staticCall(user.address, 0, INR)
      ).to.equal(false);
    });
    it("returns false once daily count is exhausted", async function () {
      for (let i = 0; i < DAILY_COUNT_LIMIT; i++) {
        await integrator.connect(asDiamond).validateOrder(user.address, BUYIN, INR);
      }
      expect(
        await integrator.connect(asDiamond).validateOrder.staticCall(user.address, BUYIN, INR)
      ).to.equal(false);
    });
    it("reverts OnlyDiamond for a non-diamond caller", async function () {
      await expect(
        integrator.connect(user).validateOrder(user.address, BUYIN, INR)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
    });
  });

  describe("Callback access control + replay", function () {
    it("onOrderComplete reverts OnlyDiamond for non-diamond", async function () {
      await buy(user);
      await expect(
        integrator.connect(user).onOrderComplete(1, user.address, BUYIN, user.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
    });
    it("onOrderCancel reverts OnlyDiamond for non-diamond", async function () {
      await buy(user);
      await expect(integrator.connect(user).onOrderCancel(1)).to.be.revertedWithCustomError(
        integrator,
        "OnlyDiamond"
      );
    });
    it("second completion reverts (OrderAlreadyFulfilled, caught by gateway)", async function () {
      await buy(user);
      await mockDiamond.simulateOrderComplete(1);
      await expect(mockDiamond.simulateOrderComplete(1)).to.be.reverted;
    });
    it("cancel after completion reverts", async function () {
      await buy(user);
      await mockDiamond.simulateOrderComplete(1);
      await expect(mockDiamond.simulateOrderCancelled(1)).to.be.reverted;
    });
    it("double cancel reverts", async function () {
      await buy(user);
      await mockDiamond.simulateOrderCancelled(1);
      await expect(mockDiamond.simulateOrderCancelled(1)).to.be.reverted;
    });
    it("completion of an unknown order is a no-op (no revert)", async function () {
      const addr = await mockDiamond.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [addr]);
      await ethers.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
      const asDiamond = await ethers.getSigner(addr);
      await expect(
        integrator.connect(asDiamond).onOrderComplete(999, user.address, BUYIN, user.address)
      ).to.not.be.reverted;
      await expect(integrator.connect(asDiamond).onOrderCancel(999)).to.not.be.reverted;
    });
  });

  describe("Admin", function () {
    it("setPerTxUsdcCap updates + emits", async function () {
      await expect(integrator.setPerTxUsdcCap(USDC(40)))
        .to.emit(integrator, "PerTxUsdcCapUpdated")
        .withArgs(USDC(40));
      expect(await integrator.perTxUsdcCap()).to.equal(USDC(40));
    });
    it("setDailyTxCountLimit updates + emits", async function () {
      await expect(integrator.setDailyTxCountLimit(5))
        .to.emit(integrator, "DailyTxCountLimitUpdated")
        .withArgs(5);
    });
    it("setTreasury updates + emits", async function () {
      await expect(integrator.setTreasury(treasury.address))
        .to.emit(integrator, "TreasuryUpdated")
        .withArgs(treasury.address);
    });
    it("setPerTxUsdcCap(0) reverts InvalidAmount", async function () {
      await expect(integrator.setPerTxUsdcCap(0)).to.be.revertedWithCustomError(
        integrator,
        "InvalidAmount"
      );
    });
    it("setDailyTxCountLimit(0) reverts InvalidAmount", async function () {
      await expect(integrator.setDailyTxCountLimit(0)).to.be.revertedWithCustomError(
        integrator,
        "InvalidAmount"
      );
    });
    it("setTreasury(0) reverts InvalidAddress", async function () {
      await expect(integrator.setTreasury(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        integrator,
        "InvalidAddress"
      );
    });
    it("sweepUsdc(0) reverts InvalidAmount", async function () {
      await expect(integrator.sweepUsdc(0)).to.be.revertedWithCustomError(
        integrator,
        "InvalidAmount"
      );
    });
    it("rejects non-owner on every setter", async function () {
      await expect(integrator.connect(user).setPerTxUsdcCap(USDC(1))).to.be.revertedWithCustomError(
        integrator,
        "OnlyOwner"
      );
      await expect(integrator.connect(user).setDailyTxCountLimit(1)).to.be.revertedWithCustomError(
        integrator,
        "OnlyOwner"
      );
      await expect(
        integrator.connect(user).setTreasury(user.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
      await expect(integrator.connect(user).sweepUsdc(1)).to.be.revertedWithCustomError(
        integrator,
        "OnlyOwner"
      );
    });
  });

  describe("Constructor validation", function () {
    let Integrator: any;
    beforeEach(async function () {
      Integrator = await ethers.getContractFactory("InvestablChallengeCheckoutIntegrator");
    });
    it("reverts InvalidAddress when diamond is zero", async function () {
      await expect(
        Integrator.deploy(ethers.ZeroAddress, await mockUsdc.getAddress(), PER_TX_CAP, 10)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    });
    it("reverts InvalidAddress when usdc is zero", async function () {
      await expect(
        Integrator.deploy(await mockDiamond.getAddress(), ethers.ZeroAddress, PER_TX_CAP, 10)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    });
    it("reverts InvalidAmount when cap is zero", async function () {
      await expect(
        Integrator.deploy(await mockDiamond.getAddress(), await mockUsdc.getAddress(), 0, 10)
      ).to.be.revertedWithCustomError(integrator, "InvalidAmount");
    });
    it("reverts InvalidAmount when daily limit is zero", async function () {
      await expect(
        Integrator.deploy(
          await mockDiamond.getAddress(),
          await mockUsdc.getAddress(),
          PER_TX_CAP,
          0
        )
      ).to.be.revertedWithCustomError(integrator, "InvalidAmount");
    });
    it("defaults treasury to owner", async function () {
      expect(await integrator.treasury()).to.equal(owner.address);
    });
  });
});
