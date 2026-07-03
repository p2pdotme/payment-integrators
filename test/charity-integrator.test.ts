import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * CharityCheckoutIntegrator: a donation onramp. Users pay local fiat and the
 * purchased USDC is delivered DIRECTLY to a single charity wallet
 * (recipientAddr = charityWallet, usdcThroughIntegrator = false). No limits,
 * no KYC — the user never receives USDC, so there is no fiat->USDC->user path
 * to gate.
 *
 * MockDiamond mirrors B2BGatewayFacet: placeB2BOrder is proxy-only + CREATE2
 * resolved, and simulateOrderComplete transfers USDC to recipientAddr then
 * calls onOrderComplete under try/catch.
 */
describe("CharityCheckoutIntegrator", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let user2: SignerWithAddress;
  let stranger: SignerWithAddress;
  let charity: SignerWithAddress;
  let charity2: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let integrator: any;
  let integratorAddr: string;

  const USDC = (n: number | string) => ethers.parseUnits(n.toString(), 6);
  const BRL = ethers.encodeBytes32String("BRL");

  // donate(amount, currency, circleId, pubKey, preferredPaymentChannelConfigId, fiatAmountLimit)
  const donate = (who: SignerWithAddress, amount: bigint) =>
    integrator.connect(who).donate(amount, BRL, 1, "", 0, 0);

  // Advance the EVM clock past the next UTC day boundary so the per-wallet
  // daily order counter (keyed on block.timestamp / 1 days) resets.
  async function advanceOneDay() {
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);
  }

  beforeEach(async function () {
    [owner, user, user2, stranger, charity, charity2] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUsdc = await MockUSDC.deploy();

    const MockDiamond = await ethers.getContractFactory("MockDiamond");
    mockDiamond = await MockDiamond.deploy(await mockUsdc.getAddress());

    const Integrator = await ethers.getContractFactory("CharityCheckoutIntegrator");
    integrator = await Integrator.deploy(
      await mockDiamond.getAddress(),
      await mockUsdc.getAddress(),
      charity.address
    );
    integratorAddr = await integrator.getAddress();

    // Register the integrator + its pinned proxyImpl on the (mock) Diamond.
    await mockDiamond.registerIntegrator(integratorAddr, await integrator.proxyImpl());

    // Fund the Diamond so it can deliver USDC to the charity on completion.
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(1_000_000));
  });

  describe("construction", function () {
    it("wires diamond, usdc, owner, charityWallet and deploys a proxyImpl", async function () {
      expect(await integrator.diamond()).to.equal(await mockDiamond.getAddress());
      expect(await integrator.usdc()).to.equal(await mockUsdc.getAddress());
      expect(await integrator.owner()).to.equal(owner.address);
      expect(await integrator.charityWallet()).to.equal(charity.address);
      expect(await integrator.proxyImpl()).to.not.equal(ethers.ZeroAddress);
    });

    it("rejects zero addresses in the constructor", async function () {
      const Integrator = await ethers.getContractFactory("CharityCheckoutIntegrator");
      await expect(
        Integrator.deploy(ethers.ZeroAddress, await mockUsdc.getAddress(), charity.address)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      await expect(
        Integrator.deploy(
          await mockDiamond.getAddress(),
          await mockUsdc.getAddress(),
          ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    });
  });

  describe("donate", function () {
    it("places an order with recipientAddr = charityWallet and deploys the user's proxy", async function () {
      const predicted = await integrator.proxyAddress(user.address);
      expect(await ethers.provider.getCode(predicted)).to.equal("0x"); // not deployed yet

      await expect(donate(user, USDC(50)))
        .to.emit(integrator, "DonationCreated")
        .withArgs(1, user.address, USDC(50), BRL, charity.address);

      // proxy now deployed at the predicted address
      expect(await ethers.provider.getCode(predicted)).to.not.equal("0x");

      // the Diamond recorded the order with the charity as recipient
      const order = await mockDiamond.orders(1);
      expect(order.integrator).to.equal(integratorAddr);
      expect(order.user).to.equal(user.address);
      expect(order.amount).to.equal(USDC(50));
      expect(order.recipientAddr).to.equal(charity.address);

      const session = await integrator.getSession(1);
      expect(session.user).to.equal(user.address);
      expect(session.amount).to.equal(USDC(50));
      expect(session.fulfilled).to.equal(false);
    });

    it("reverts on a zero amount", async function () {
      await expect(donate(user, 0n)).to.be.revertedWithCustomError(integrator, "InvalidAmount");
    });

    it("reuses the same proxy across multiple donations (no redeploy)", async function () {
      await donate(user, USDC(10));
      const predicted = await integrator.proxyAddress(user.address);
      const codeAfterFirst = await ethers.provider.getCode(predicted);
      await advanceOneDay(); // second order is on the next day (daily cap = 1)
      await donate(user, USDC(20));
      expect(await ethers.provider.getCode(predicted)).to.equal(codeAfterFirst);
      // two distinct orders recorded
      expect((await mockDiamond.orders(1)).user).to.equal(user.address);
      expect((await mockDiamond.orders(2)).amount).to.equal(USDC(20));
    });

    it("imposes no amount cap — an arbitrarily large donation is accepted", async function () {
      await expect(donate(user, USDC(10_000_000))).to.not.be.reverted;
    });
  });

  describe("completion delivers USDC to the charity", function () {
    it("routes the purchased USDC to charityWallet and updates bookkeeping", async function () {
      await donate(user, USDC(250));

      const before = await mockUsdc.balanceOf(charity.address);
      await expect(mockDiamond.simulateOrderComplete(1))
        .to.emit(integrator, "Donated")
        .withArgs(1, user.address, USDC(250), charity.address);
      const after = await mockUsdc.balanceOf(charity.address);

      expect(after - before).to.equal(USDC(250));
      expect(await integrator.totalDonated()).to.equal(USDC(250));
      expect(await integrator.donatedBy(user.address)).to.equal(USDC(250));

      const session = await integrator.getSession(1);
      expect(session.fulfilled).to.equal(true);
    });

    it("accumulates totalDonated across users and orders", async function () {
      await donate(user, USDC(100));
      await donate(user2, USDC(400));
      await mockDiamond.simulateOrderComplete(1);
      await mockDiamond.simulateOrderComplete(2);

      expect(await integrator.totalDonated()).to.equal(USDC(500));
      expect(await integrator.donatedBy(user.address)).to.equal(USDC(100));
      expect(await integrator.donatedBy(user2.address)).to.equal(USDC(400));
      expect(await mockUsdc.balanceOf(charity.address)).to.equal(USDC(500));
    });

    it("does not double-count if the same order completes twice", async function () {
      await donate(user, USDC(100));
      await mockDiamond.simulateOrderComplete(1);
      // MockDiamond blocks a second completion at the protocol level
      await expect(mockDiamond.simulateOrderComplete(1)).to.be.revertedWith("Already completed");
      expect(await integrator.totalDonated()).to.equal(USDC(100));
    });
  });

  describe("cancellation", function () {
    it("marks the session cancelled without touching donation totals", async function () {
      await donate(user, USDC(75));
      await expect(mockDiamond.simulateOrderCancelled(1)).to.not.be.reverted;

      const session = await integrator.getSession(1);
      expect(session.cancelled).to.equal(true);
      expect(session.fulfilled).to.equal(false);
      expect(await integrator.totalDonated()).to.equal(0);
      expect(await integrator.donatedBy(user.address)).to.equal(0);
    });
  });

  describe("daily order limit (1 per wallet per day)", function () {
    it("exposes the cap and the remaining quota", async function () {
      expect(await integrator.MAX_ORDERS_PER_DAY()).to.equal(1);
      expect(await integrator.getRemainingDailyOrders(user.address)).to.equal(1);
    });

    it("allows exactly one donation per wallet per day", async function () {
      await donate(user, USDC(10));
      // the slot was reserved by validateOrder during placement
      expect(await integrator.getRemainingDailyOrders(user.address)).to.equal(0);
      await expect(donate(user, USDC(10))).to.be.revertedWithCustomError(
        integrator,
        "DailyLimitReached"
      );
    });

    it("caps completed orders too — completing the first still blocks a second", async function () {
      await donate(user, USDC(10));
      await mockDiamond.simulateOrderComplete(1);
      await expect(donate(user, USDC(10))).to.be.revertedWithCustomError(
        integrator,
        "DailyLimitReached"
      );
    });

    it("meters each wallet independently on the same day", async function () {
      await donate(user, USDC(10));
      await expect(donate(user2, USDC(10))).to.not.be.reverted;
      expect(await integrator.getRemainingDailyOrders(user2.address)).to.equal(0);
    });

    it("resets the quota after the UTC day rolls over", async function () {
      await donate(user, USDC(10));
      await expect(donate(user, USDC(10))).to.be.revertedWithCustomError(
        integrator,
        "DailyLimitReached"
      );
      await advanceOneDay();
      expect(await integrator.getRemainingDailyOrders(user.address)).to.equal(1);
      await expect(donate(user, USDC(10))).to.not.be.reverted;
    });

    it("frees the slot when an order is cancelled (retry allowed same day)", async function () {
      await donate(user, USDC(10));
      expect(await integrator.getRemainingDailyOrders(user.address)).to.equal(0);
      await mockDiamond.simulateOrderCancelled(1); // releases the reserved slot
      expect(await integrator.getRemainingDailyOrders(user.address)).to.equal(1);
      // can place a fresh order the same day
      await expect(donate(user, USDC(10))).to.not.be.reverted;
      expect(await integrator.getRemainingDailyOrders(user.address)).to.equal(0);
    });
  });

  describe("setCharityWallet", function () {
    it("lets the owner update the destination and routes new donations there", async function () {
      await expect(integrator.connect(owner).setCharityWallet(charity2.address))
        .to.emit(integrator, "CharityWalletUpdated")
        .withArgs(charity.address, charity2.address);
      expect(await integrator.charityWallet()).to.equal(charity2.address);

      await donate(user, USDC(30));
      await mockDiamond.simulateOrderComplete(1);
      expect(await mockUsdc.balanceOf(charity2.address)).to.equal(USDC(30));
      expect(await mockUsdc.balanceOf(charity.address)).to.equal(0);
    });

    it("only affects orders placed after the change (recipient pinned at placement)", async function () {
      await donate(user, USDC(40)); // order 1 -> charity
      await integrator.connect(owner).setCharityWallet(charity2.address);
      await advanceOneDay(); // same wallet, next day (daily cap = 1)
      await donate(user, USDC(60)); // order 2 -> charity2

      await mockDiamond.simulateOrderComplete(1);
      await mockDiamond.simulateOrderComplete(2);
      expect(await mockUsdc.balanceOf(charity.address)).to.equal(USDC(40));
      expect(await mockUsdc.balanceOf(charity2.address)).to.equal(USDC(60));
    });

    it("rejects a non-owner and a zero address", async function () {
      await expect(
        integrator.connect(stranger).setCharityWallet(charity2.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
      await expect(
        integrator.connect(owner).setCharityWallet(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    });
  });

  describe("callback access control (onlyDiamond)", function () {
    it("rejects direct validateOrder / onOrderComplete / onOrderCancel calls", async function () {
      await expect(
        integrator.connect(stranger).validateOrder(user.address, USDC(10), BRL)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
      await expect(
        integrator.connect(stranger).onOrderComplete(1, user.address, USDC(10), charity.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
      await expect(integrator.connect(stranger).onOrderCancel(1)).to.be.revertedWithCustomError(
        integrator,
        "OnlyDiamond"
      );
    });
  });
});
