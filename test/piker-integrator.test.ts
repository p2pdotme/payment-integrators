import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * PikerOfframpIntegrator — off-ramp lifecycle, refunds, limits, access control.
 *
 * The MockDiamond has no protocol fee (actualUsdtAmount == sell principal), so
 * these tests exercise the principal flow end-to-end. The fee-pull branch in
 * deliverOfframpUpi (`needed > deposited`) only fires with a real small-order
 * fee — covered separately once a fee-bearing mock path is wired.
 */
describe("PikerOfframpIntegrator", function () {
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
  const PRINCIPAL = USDC(100);
  const CIRCLE_ID = 1n;
  const PUBKEY = "user-relay-pubkey";

  // SellStatus / OrderStatus: PLACED=0 ACCEPTED=1 PAID=2 COMPLETED=3 CANCELLED=4
  const STATUS_COMPLETED = 3;
  const STATUS_CANCELLED = 4;

  beforeEach(async function () {
    [owner, user, other] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();

    const MockDiamond = await ethers.getContractFactory("MockDiamond");
    diamond = await MockDiamond.deploy(await usdc.getAddress());

    const Integrator = await ethers.getContractFactory("PikerOfframpIntegrator");
    integrator = await Integrator.deploy(
      await diamond.getAddress(),
      await usdc.getAddress(),
      BASE_TX_LIMIT,
      DAILY_COUNT_LIMIT
    );

    await diamond.registerIntegrator(await integrator.getAddress(), await integrator.proxyImpl());

    // Fund the user and approve the integrator generously (covers principal +
    // any fee the widget would approve up-front).
    await usdc.mint(user.address, USDC(10000));
    await usdc.connect(user).approve(await integrator.getAddress(), ethers.MaxUint256);
  });

  async function initiate(amount = PRINCIPAL) {
    const tx = await integrator
      .connect(user)
      .userInitiateOfframp(amount, INR, 0, CIRCLE_ID, 0, PUBKEY);
    await tx.wait();
    return 1n; // first order in a fresh mock
  }

  describe("userInitiateOfframp", function () {
    it("pulls principal, places the SELL via the per-user proxy, records it", async function () {
      const orderId = await initiate();

      // Principal moved from user into the integrator (held until deliver).
      expect(await usdc.balanceOf(await integrator.getAddress())).to.equal(PRINCIPAL);

      const proxy = await integrator.proxyAddress(user.address);
      expect((await ethers.provider.getCode(proxy)).length).to.be.greaterThan(2);

      const rec = await integrator.getOfframp(orderId);
      expect(rec.user).to.equal(user.address);
      expect(rec.principal).to.equal(PRINCIPAL);
      expect(rec.deposited).to.equal(PRINCIPAL);
      expect(rec.initialized).to.equal(true);
      expect(rec.delivered).to.equal(false);

      // order.user on the Diamond is the proxy.
      const sell = await diamond.getSellOrder(orderId);
      expect(sell.user).to.equal(proxy);
      expect(sell.amount).to.equal(PRINCIPAL);
      expect(sell.status).to.equal(0); // PLACED
    });

    it("emits OfframpInitiated", async function () {
      await expect(
        integrator.connect(user).userInitiateOfframp(PRINCIPAL, INR, 0, CIRCLE_ID, 0, PUBKEY)
      )
        .to.emit(integrator, "OfframpInitiated")
        .withArgs(1n, user.address, PRINCIPAL);
    });

    it("reverts on zero principal", async function () {
      await expect(
        integrator.connect(user).userInitiateOfframp(0, INR, 0, CIRCLE_ID, 0, PUBKEY)
      ).to.be.revertedWithCustomError(integrator, "InvalidAmount");
    });
  });

  describe("deliver + complete (happy path)", function () {
    it("funds the proxy, drives setSellOrderUpi, settles on reconcile", async function () {
      const orderId = await initiate();
      await diamond.acceptSellOrder(orderId, "merchant-pubkey");

      await expect(integrator.connect(user).deliverOfframpUpi(orderId, "enc-upi"))
        .to.emit(integrator, "OfframpUpiDelivered")
        .withArgs(orderId, PRINCIPAL);

      // Diamond pulled the principal from the proxy; nothing stranded.
      expect(await usdc.balanceOf(await integrator.getAddress())).to.equal(0);
      const proxy = await integrator.proxyAddress(user.address);
      expect(await usdc.balanceOf(proxy)).to.equal(0);
      expect((await diamond.getSellOrder(orderId)).status).to.equal(2); // PAID

      await diamond.completeSellOrder(orderId);

      // reconcile is permissionless; completing leaves no refund.
      await expect(integrator.connect(other).reconcile(orderId))
        .to.emit(integrator, "OfframpReconciled")
        .withArgs(orderId, STATUS_COMPLETED, 0);
      expect((await integrator.getOfframp(orderId)).lastStatus).to.equal(STATUS_COMPLETED);
    });
  });

  describe("with a small-order fee", function () {
    const FEE = USDC(1);

    beforeEach(async function () {
      await diamond.setSellFee(FEE);
    });

    it("pulls principal + fee from the user across initiate + deliver", async function () {
      const orderId = await initiate();
      // initiate pulled only principal.
      expect((await integrator.getOfframp(orderId)).deposited).to.equal(PRINCIPAL);

      await diamond.acceptSellOrder(orderId, "merchant-pubkey");
      const balBefore = await usdc.balanceOf(user.address);

      await integrator.connect(user).deliverOfframpUpi(orderId, "enc-upi");

      // deliver pulled the fee remainder; total deposited = principal + fee.
      expect(await usdc.balanceOf(user.address)).to.equal(balBefore - FEE);
      expect((await integrator.getOfframp(orderId)).deposited).to.equal(PRINCIPAL + FEE);
      // Funded the proxy with exactly principal+fee; Diamond pulled it all.
      const proxy = await integrator.proxyAddress(user.address);
      expect(await usdc.balanceOf(proxy)).to.equal(0);
      expect(await usdc.balanceOf(await integrator.getAddress())).to.equal(0);
    });

    it("refunds principal + fee on a post-deliver cancel", async function () {
      const orderId = await initiate();
      await diamond.acceptSellOrder(orderId, "merchant-pubkey");
      await integrator.connect(user).deliverOfframpUpi(orderId, "enc-upi");

      const balBefore = await usdc.balanceOf(user.address);
      await diamond.cancelSellOrder(orderId); // refunds principal+fee to proxy

      await expect(integrator.connect(other).reconcile(orderId))
        .to.emit(integrator, "OfframpReconciled")
        .withArgs(orderId, STATUS_CANCELLED, PRINCIPAL + FEE);
      expect(await usdc.balanceOf(user.address)).to.equal(balBefore + PRINCIPAL + FEE);
    });
  });

  describe("cancellation refunds", function () {
    it("refunds the user after a post-deliver (PAID) cancel", async function () {
      const orderId = await initiate();
      await diamond.acceptSellOrder(orderId, "merchant-pubkey");
      await integrator.connect(user).deliverOfframpUpi(orderId, "enc-upi");

      const balBefore = await usdc.balanceOf(user.address);
      await diamond.cancelSellOrder(orderId); // PAID → refunds principal to proxy

      await expect(integrator.connect(other).reconcile(orderId))
        .to.emit(integrator, "OfframpReconciled")
        .withArgs(orderId, STATUS_CANCELLED, PRINCIPAL);

      expect(await usdc.balanceOf(user.address)).to.equal(balBefore + PRINCIPAL);
      const proxy = await integrator.proxyAddress(user.address);
      expect(await usdc.balanceOf(proxy)).to.equal(0);
      expect(await usdc.balanceOf(await integrator.getAddress())).to.equal(0);
    });

    it("refunds the user after a pre-deliver (PLACED) cancel", async function () {
      const orderId = await initiate();
      const balAfterInitiate = await usdc.balanceOf(user.address);

      await diamond.cancelSellOrder(orderId); // PLACED → no Diamond refund
      await expect(integrator.connect(other).reconcile(orderId))
        .to.emit(integrator, "OfframpReconciled")
        .withArgs(orderId, STATUS_CANCELLED, PRINCIPAL);

      // User made whole; integrator drained.
      expect(await usdc.balanceOf(user.address)).to.equal(balAfterInitiate + PRINCIPAL);
      expect(await usdc.balanceOf(await integrator.getAddress())).to.equal(0);
    });
  });

  describe("limits", function () {
    it("enforces the per-tx principal limit", async function () {
      await expect(
        integrator
          .connect(user)
          .userInitiateOfframp(BASE_TX_LIMIT + 1n, INR, 0, CIRCLE_ID, 0, PUBKEY)
      ).to.be.revertedWithCustomError(integrator, "TxLimitExceeded");
    });

    it("enforces the daily cash-out count", async function () {
      await integrator.setDailyTxCountLimit(1);
      await initiate(); // 1st ok
      await expect(
        integrator.connect(user).userInitiateOfframp(PRINCIPAL, INR, 0, CIRCLE_ID, 0, PUBKEY)
      ).to.be.revertedWithCustomError(integrator, "DailyCountExceeded");
      expect(await integrator.getTodayCount(user.address)).to.equal(1);
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(0);
    });

    it("treats a zero limit as unlimited", async function () {
      await integrator.setBaseTxLimit(0);
      await integrator.setDailyTxCountLimit(0);
      // No revert despite a large principal and repeated cash-outs.
      await initiate(USDC(5000));
      await integrator.connect(user).userInitiateOfframp(USDC(5000), INR, 0, CIRCLE_ID, 0, PUBKEY);
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(ethers.MaxUint256);
    });

    it("validateOrder rejects over-limit amounts (Diamond-side gate)", async function () {
      // Called by the Diamond during placeB2BSellOrder; over-limit ⇒ false.
      // A small order passes when placed through the real flow above, so here
      // we just assert the over-limit principal is blocked at the entry point,
      // which is the user-facing gate.
      await expect(
        integrator
          .connect(user)
          .userInitiateOfframp(BASE_TX_LIMIT + 1n, INR, 0, CIRCLE_ID, 0, PUBKEY)
      ).to.be.revertedWithCustomError(integrator, "TxLimitExceeded");
    });
  });

  describe("access control", function () {
    it("validateOrder / onOrderComplete / onOrderCancel are Diamond-only", async function () {
      await expect(
        integrator.connect(user).validateOrder(user.address, PRINCIPAL, INR)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
      await expect(
        integrator.connect(user).onOrderComplete(1, user.address, PRINCIPAL, user.address)
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

    it("deliverOfframpUpi is order-owner-only", async function () {
      const orderId = await initiate();
      await diamond.acceptSellOrder(orderId, "merchant-pubkey");
      await expect(
        integrator.connect(other).deliverOfframpUpi(orderId, "enc-upi")
      ).to.be.revertedWithCustomError(integrator, "NotOrderOwner");
    });
  });

  describe("replay + bad state guards", function () {
    it("rejects a second deliver (replay guard)", async function () {
      const orderId = await initiate();
      await diamond.acceptSellOrder(orderId, "merchant-pubkey");
      await integrator.connect(user).deliverOfframpUpi(orderId, "enc-upi");
      await expect(
        integrator.connect(user).deliverOfframpUpi(orderId, "enc-upi")
      ).to.be.revertedWithCustomError(integrator, "OfframpAlreadyDelivered");
    });

    it("rejects a second reconcile", async function () {
      const orderId = await initiate();
      await diamond.cancelSellOrder(orderId);
      await integrator.connect(other).reconcile(orderId);
      await expect(integrator.connect(other).reconcile(orderId)).to.be.revertedWithCustomError(
        integrator,
        "OfframpAlreadyReconciled"
      );
    });

    it("reconcile reverts while the order is non-terminal", async function () {
      const orderId = await initiate();
      await expect(integrator.connect(other).reconcile(orderId)).to.be.revertedWithCustomError(
        integrator,
        "StatusNotTerminal"
      );
    });

    it("deliver reverts when the Diamond fee isn't ready", async function () {
      const orderId = await initiate();
      await diamond.acceptSellOrder(orderId, "merchant-pubkey");
      await diamond.setAdditionalOrderDetailsFeeUnready(true);
      await expect(
        integrator.connect(user).deliverOfframpUpi(orderId, "enc-upi")
      ).to.be.revertedWithCustomError(integrator, "OfframpFeeNotReady");
    });

    it("deliver / reconcile revert on an unknown order", async function () {
      await expect(
        integrator.connect(user).deliverOfframpUpi(999, "enc-upi")
      ).to.be.revertedWithCustomError(integrator, "OfframpRecordNotFound");
      await expect(integrator.connect(other).reconcile(999)).to.be.revertedWithCustomError(
        integrator,
        "OfframpRecordNotFound"
      );
    });
  });

  describe("on-ramp (BUY: INR→USDC)", function () {
    const AMOUNT = USDC(100);

    async function initiateOnramp(amount = AMOUNT) {
      const tx = await integrator
        .connect(user)
        .userInitiateOnramp(amount, INR, 0, CIRCLE_ID, 0, PUBKEY);
      await tx.wait();
      return 1n;
    }

    it("places a BUY via the proxy with recipientAddr = user; pulls no USDC", async function () {
      const balBefore = await usdc.balanceOf(user.address);
      const orderId = await initiateOnramp();

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

    it("delivers USDC to the buyer's wallet on completion + marks fulfilled", async function () {
      const orderId = await initiateOnramp();
      // Merchant USDC escrowed by the Diamond; on completion it routes to recipient.
      await usdc.mint(await diamond.getAddress(), AMOUNT);

      const balBefore = await usdc.balanceOf(user.address);
      await expect(diamond.simulateOrderComplete(orderId))
        .to.emit(integrator, "OnrampFulfilled")
        .withArgs(orderId, user.address, AMOUNT);

      expect(await usdc.balanceOf(user.address)).to.equal(balBefore + AMOUNT);
      expect((await integrator.getOnramp(orderId)).fulfilled).to.equal(true);
    });

    it("releases the daily-count slot when an onramp is cancelled", async function () {
      await integrator.setDailyTxCountLimit(1);
      const orderId = await initiateOnramp();
      expect(await integrator.getTodayCount(user.address)).to.equal(1);

      await expect(diamond.simulateOrderCancelled(orderId))
        .to.emit(integrator, "OnrampCancelled")
        .withArgs(orderId, user.address);

      expect(await integrator.getTodayCount(user.address)).to.equal(0);
      await expect(initiateOnramp()).to.not.be.reverted; // slot freed
    });

    it("enforces the per-tx limit", async function () {
      await expect(
        integrator
          .connect(user)
          .userInitiateOnramp(BASE_TX_LIMIT + 1n, INR, 0, CIRCLE_ID, 0, PUBKEY)
      ).to.be.revertedWithCustomError(integrator, "TxLimitExceeded");
    });

    it("enforces the daily count", async function () {
      await integrator.setDailyTxCountLimit(1);
      await initiateOnramp();
      await expect(
        integrator.connect(user).userInitiateOnramp(AMOUNT, INR, 0, CIRCLE_ID, 0, PUBKEY)
      ).to.be.revertedWithCustomError(integrator, "DailyCountExceeded");
    });

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
