import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("CubeSkinsIntegrator", function () {
  let owner: SignerWithAddress;
  let treasury: SignerWithAddress;
  let buyer: SignerWithAddress;
  let stranger: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let integrator: any;

  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
  const BASE_TX_LIMIT = USDC(50);
  const DAILY_COUNT_LIMIT = 10;
  const MARKETPLACE_ORDER_ID = 42;
  const BRL = ethers.encodeBytes32String("BRL");

  async function registerOrder(orderId = MARKETPLACE_ORDER_ID, amount = USDC(10), who = buyer) {
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
    await integrator.connect(owner).registerOrder(orderId, who.address, amount, expiresAt);
  }

  beforeEach(async function () {
    [owner, treasury, buyer, stranger] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUsdc = await MockUSDC.deploy();

    const MockDiamond = await ethers.getContractFactory("MockDiamond");
    mockDiamond = await MockDiamond.deploy(await mockUsdc.getAddress());

    const Integrator = await ethers.getContractFactory("CubeSkinsIntegrator");
    integrator = await Integrator.deploy(
      await mockDiamond.getAddress(),
      await mockUsdc.getAddress(),
      treasury.address,
      BASE_TX_LIMIT,
      DAILY_COUNT_LIMIT
    );

    await mockDiamond.registerIntegrator(
      await integrator.getAddress(),
      await integrator.proxyImpl()
    );
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(10000));
  });

  describe("registerOrder + userPlaceOrder", function () {
    it("places order with registered price and buyer", async function () {
      await registerOrder();
      await integrator.connect(buyer).userPlaceOrder(MARKETPLACE_ORDER_ID, BRL, 1, "", 0, 0);

      const session = await integrator.sessions(1);
      expect(session.marketplaceOrderId).to.equal(MARKETPLACE_ORDER_ID);
      expect(session.usdcAmount).to.equal(USDC(10));
    });

    it("reverts when buyer wallet does not match registration", async function () {
      await registerOrder(MARKETPLACE_ORDER_ID, USDC(10), buyer);
      await expect(
        integrator.connect(stranger).userPlaceOrder(MARKETPLACE_ORDER_ID, BRL, 1, "", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "BuyerMismatch");
    });

    it("reverts when order is not registered", async function () {
      await expect(
        integrator.connect(buyer).userPlaceOrder(999, BRL, 1, "", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "OrderNotRegistered");
    });

    it("reverts when stranger tries to register an order", async function () {
      const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      await expect(
        integrator
          .connect(stranger)
          .registerOrder(MARKETPLACE_ORDER_ID, buyer.address, USDC(10), expiresAt)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });
  });

  describe("onOrderComplete", function () {
    it("sends USDC to treasury and marks registration fulfilled", async function () {
      await registerOrder();
      await integrator.connect(buyer).userPlaceOrder(MARKETPLACE_ORDER_ID, BRL, 1, "", 0, 0);

      await mockDiamond.simulateOrderComplete(1);

      expect(await mockUsdc.balanceOf(treasury.address)).to.equal(USDC(10));
      const reg = await integrator.registrations(MARKETPLACE_ORDER_ID);
      expect(reg.fulfilled).to.equal(true);
    });

    it("reverts when called by non-diamond", async function () {
      await expect(
        integrator.connect(stranger).onOrderComplete(1, buyer.address, USDC(10), owner.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
    });
  });

  describe("onOrderCancel", function () {
    it("releases daily count and allows re-placement", async function () {
      await registerOrder();
      await integrator.connect(buyer).userPlaceOrder(MARKETPLACE_ORDER_ID, BRL, 1, "", 0, 0);
      await mockDiamond.simulateOrderCancelled(1);

      const reg = await integrator.registrations(MARKETPLACE_ORDER_ID);
      expect(reg.placed).to.equal(false);

      await integrator.connect(buyer).userPlaceOrder(MARKETPLACE_ORDER_ID, BRL, 1, "", 0, 0);
      const session = await integrator.sessions(2);
      expect(session.marketplaceOrderId).to.equal(MARKETPLACE_ORDER_ID);
    });
  });

  describe("validateOrder limits", function () {
    it("blocks amounts above base tx limit", async function () {
      const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      await integrator
        .connect(owner)
        .registerOrder(MARKETPLACE_ORDER_ID, buyer.address, USDC(60), expiresAt);

      await expect(integrator.connect(buyer).userPlaceOrder(MARKETPLACE_ORDER_ID, BRL, 1, "", 0, 0))
        .to.be.reverted;
    });
  });
});
