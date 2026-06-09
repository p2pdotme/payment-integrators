import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * PikerOnrampIntegrator — on-ramp (BUY: fiat→USDC) lifecycle, limits, access
 * control. The integrator places a BUY via the user's proxy with
 * recipientAddr = user, so the Diamond delivers USDC straight to the buyer's
 * wallet; the integrator custodies no USDC.
 */
describe("PikerOnrampIntegrator", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let other: SignerWithAddress;

  let usdc: any;
  let diamond: any;
  let integrator: any;

  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
  const BASE_TX_LIMIT = USDC(2000);
  const DAILY_COUNT_LIMIT = 10n;
  const INR = ethers.encodeBytes32String("INR");
  const AMOUNT = USDC(100);
  const CIRCLE_ID = 1n;
  const PUBKEY = "user-relay-pubkey";

  beforeEach(async function () {
    [owner, user, other] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();

    const MockDiamond = await ethers.getContractFactory("MockDiamond");
    diamond = await MockDiamond.deploy(await usdc.getAddress());

    const Integrator = await ethers.getContractFactory("PikerOnrampIntegrator");
    integrator = await Integrator.deploy(
      await diamond.getAddress(),
      await usdc.getAddress(),
      BASE_TX_LIMIT,
      DAILY_COUNT_LIMIT
    );

    await diamond.registerIntegrator(await integrator.getAddress(), await integrator.proxyImpl());
  });

  async function initiate(amount = AMOUNT) {
    const tx = await integrator
      .connect(user)
      .userInitiateOnramp(amount, INR, 0, CIRCLE_ID, 0, PUBKEY);
    await tx.wait();
    return 1n; // first order in a fresh mock
  }

  describe("userInitiateOnramp", function () {
    it("places a BUY via the per-user proxy with recipientAddr = user; pulls no USDC", async function () {
      const balBefore = await usdc.balanceOf(user.address);
      const orderId = await initiate();

      // A BUY pulls nothing at placement (buyer pays fiat off-chain).
      expect(await usdc.balanceOf(user.address)).to.equal(balBefore);
      expect(await usdc.balanceOf(await integrator.getAddress())).to.equal(0);

      const proxy = await integrator.proxyAddress(user.address);
      expect((await ethers.provider.getCode(proxy)).length).to.be.greaterThan(2);

      const rec = await integrator.getOnramp(orderId);
      expect(rec.user).to.equal(user.address);
      expect(rec.fulfilled).to.equal(false);
      expect(rec.cancelled).to.equal(false);
      expect(rec.initialized).to.equal(true);

      // Diamond recorded order.user + recipientAddr = the buyer's EOA.
      const order = await diamond.orders(orderId);
      expect(order.user).to.equal(user.address);
      expect(order.recipientAddr).to.equal(user.address);
      expect(order.amount).to.equal(AMOUNT);
    });

    it("emits OnrampInitiated", async function () {
      await expect(
        integrator.connect(user).userInitiateOnramp(AMOUNT, INR, 0, CIRCLE_ID, 0, PUBKEY)
      )
        .to.emit(integrator, "OnrampInitiated")
        .withArgs(1n, user.address, AMOUNT);
    });

    it("reverts on zero amount", async function () {
      await expect(
        integrator.connect(user).userInitiateOnramp(0, INR, 0, CIRCLE_ID, 0, PUBKEY)
      ).to.be.revertedWithCustomError(integrator, "InvalidAmount");
    });
  });

  describe("completion", function () {
    it("delivers USDC to the buyer's wallet on completion + marks fulfilled", async function () {
      const orderId = await initiate();
      // Merchant USDC escrowed by the Diamond; on completion it routes to recipient.
      await usdc.mint(await diamond.getAddress(), AMOUNT);

      const balBefore = await usdc.balanceOf(user.address);
      await expect(diamond.simulateOrderComplete(orderId))
        .to.emit(integrator, "OnrampFulfilled")
        .withArgs(orderId, user.address, AMOUNT);

      expect(await usdc.balanceOf(user.address)).to.equal(balBefore + AMOUNT);
      expect((await integrator.getOnramp(orderId)).fulfilled).to.equal(true);
    });
  });

  describe("cancellation", function () {
    it("releases the daily-count slot when an onramp is cancelled", async function () {
      await integrator.setDailyTxCountLimit(1);
      const orderId = await initiate();
      expect(await integrator.getTodayCount(user.address)).to.equal(1);

      await expect(diamond.simulateOrderCancelled(orderId))
        .to.emit(integrator, "OnrampCancelled")
        .withArgs(orderId, user.address);

      expect(await integrator.getTodayCount(user.address)).to.equal(0);
      await expect(initiate()).to.not.be.reverted; // slot freed
    });
  });

  describe("limits", function () {
    it("enforces the per-tx limit", async function () {
      await expect(
        integrator
          .connect(user)
          .userInitiateOnramp(BASE_TX_LIMIT + 1n, INR, 0, CIRCLE_ID, 0, PUBKEY)
      ).to.be.revertedWithCustomError(integrator, "TxLimitExceeded");
    });

    it("enforces the daily count", async function () {
      await integrator.setDailyTxCountLimit(1);
      await initiate();
      await expect(
        integrator.connect(user).userInitiateOnramp(AMOUNT, INR, 0, CIRCLE_ID, 0, PUBKEY)
      ).to.be.revertedWithCustomError(integrator, "DailyCountExceeded");
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(0);
    });

    it("treats a zero limit as unlimited", async function () {
      await integrator.setBaseTxLimit(0);
      await integrator.setDailyTxCountLimit(0);
      await expect(
        integrator.connect(user).userInitiateOnramp(USDC(1_000_000), INR, 0, CIRCLE_ID, 0, PUBKEY)
      ).to.not.be.reverted;
    });
  });

  describe("access control", function () {
    it("validateOrder / onOrderComplete / onOrderCancel are Diamond-only", async function () {
      await expect(
        integrator.connect(user).validateOrder(user.address, AMOUNT, INR)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
      await expect(
        integrator.connect(user).onOrderComplete(1, user.address, AMOUNT, user.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
      await expect(integrator.connect(user).onOrderCancel(1)).to.be.revertedWithCustomError(
        integrator,
        "OnlyDiamond"
      );
    });

    it("limit setters are owner-only", async function () {
      await expect(integrator.connect(user).setBaseTxLimit(USDC(1))).to.be.revertedWithCustomError(
        integrator,
        "OnlyOwner"
      );
      await expect(integrator.connect(user).setDailyTxCountLimit(1)).to.be.revertedWithCustomError(
        integrator,
        "OnlyOwner"
      );
      await integrator.connect(owner).setBaseTxLimit(USDC(500));
      expect(await integrator.baseTxLimit()).to.equal(USDC(500));
    });
  });

  describe("guards", function () {
    it("onOrderComplete reverts on an unknown order", async function () {
      await expect(
        diamond.adminCallOnOrderComplete(
          await integrator.getAddress(),
          999,
          user.address,
          AMOUNT,
          user.address
        )
      ).to.be.revertedWithCustomError(integrator, "UnknownOrder");
    });
  });
});
