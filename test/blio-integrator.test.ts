import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("BlioCheckoutIntegrator", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let user2: SignerWithAddress;
  let treasury: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let integrator: any;

  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
  const BASE_TX_LIMIT = USDC(50);
  const DAILY_COUNT_LIMIT = 10;
  const PRODUCT_ID = 1;
  const PRODUCT_PRICE = USDC(10);
  const INR = ethers.encodeBytes32String("INR");
  const BRL = ethers.encodeBytes32String("BRL");

  beforeEach(async function () {
    [owner, user, user2, treasury] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUsdc = await MockUSDC.deploy();

    const MockDiamond = await ethers.getContractFactory("MockDiamond");
    mockDiamond = await MockDiamond.deploy(await mockUsdc.getAddress());

    const Integrator = await ethers.getContractFactory("BlioCheckoutIntegrator");
    integrator = await Integrator.deploy(
      await mockDiamond.getAddress(),
      await mockUsdc.getAddress(),
      treasury.address,
      owner.address,
      BASE_TX_LIMIT,
      DAILY_COUNT_LIMIT
    );

    await mockDiamond.registerIntegrator(
      await integrator.getAddress(),
      await integrator.proxyImpl()
    );
    await integrator.setProductPrice(PRODUCT_ID, PRODUCT_PRICE);
    await integrator.setProductActive(PRODUCT_ID, true);
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(10000));
  });

  const place = (signer = user, quantity = 1, currency = INR) =>
    integrator.connect(signer).userPlaceOrder(PRODUCT_ID, quantity, currency, 1, "", 0, 0);

  describe("Happy path", function () {
    it("settles USDC to the treasury and emits BlioOrderCompleted", async function () {
      const before = await mockUsdc.balanceOf(treasury.address);
      await place(user, 2);
      const session = await integrator.getSession(1);
      expect(session.user).to.equal(user.address);
      expect(session.usdcAmount).to.equal(USDC(20));
      expect(session.quantity).to.equal(2);

      await expect(mockDiamond.simulateOrderComplete(1))
        .to.emit(integrator, "BlioOrderCompleted")
        .withArgs(1, user.address, PRODUCT_ID, 2, USDC(20));

      expect(await mockUsdc.balanceOf(treasury.address)).to.equal(before + USDC(20));
      expect((await integrator.getSession(1)).fulfilled).to.equal(true);
    });

    it("emits BlioOrderCreated on placement", async function () {
      await expect(place(user, 3))
        .to.emit(integrator, "BlioOrderCreated")
        .withArgs(1, user.address, PRODUCT_ID, 3, USDC(30));
    });

    it("never holds order USDC on the integrator", async function () {
      await place(user, 1);
      await mockDiamond.simulateOrderComplete(1);
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(0);
    });
  });

  describe("Products", function () {
    it("reverts ProductNotFound when price is unset", async function () {
      await expect(place(user, 1)).to.not.be.reverted; // id 1 exists
      await expect(
        integrator.connect(user).userPlaceOrder(999, 1, INR, 1, "", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "ProductNotFound");
    });

    it("reverts ProductInactive when the product is retired", async function () {
      await integrator.setProductActive(PRODUCT_ID, false);
      await expect(place(user, 1)).to.be.revertedWithCustomError(integrator, "ProductInactive");
    });

    it("reverts InvalidQuantity on zero quantity", async function () {
      await expect(place(user, 0)).to.be.revertedWithCustomError(integrator, "InvalidQuantity");
    });
  });

  describe("Limits", function () {
    it("reverts AmountExceedsLimit above the per-tx cap", async function () {
      // 6 × 10 = 60 USDC > 50 USDC base limit
      await expect(place(user, 6)).to.be.revertedWithCustomError(integrator, "AmountExceedsLimit");
    });

    it("applies a per-currency cap", async function () {
      await integrator.setMaxTxLimit(BRL, USDC(20));
      expect(await integrator.userTxLimitFor(user.address, BRL)).to.equal(USDC(20));
      await expect(place(user, 3, BRL)).to.be.revertedWithCustomError(
        integrator,
        "AmountExceedsLimit"
      );
    });

    it("enforces the daily count limit", async function () {
      for (let i = 0; i < DAILY_COUNT_LIMIT; i++) {
        await place(user, 1);
      }
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(0);
      await expect(place(user, 1)).to.be.revertedWithCustomError(integrator, "DailyCountExceeded");
    });

    it("pauses placements", async function () {
      await integrator.pause();
      await expect(place(user, 1)).to.be.revertedWithCustomError(integrator, "ContractPaused");
      await integrator.unpause();
      await expect(place(user, 1)).to.not.be.reverted;
    });
  });

  describe("Cancellation", function () {
    it("releases the daily-count slot on cancel", async function () {
      await place(user, 1);
      expect(await integrator.getTodayCount(user.address)).to.equal(1);
      await mockDiamond.simulateOrderCancelled(1);
      expect(await integrator.getTodayCount(user.address)).to.equal(0);
      expect((await integrator.getSession(1)).cancelled).to.equal(true);
    });

    it("ignores cancel after completion", async function () {
      await place(user, 1);
      await mockDiamond.simulateOrderComplete(1);
      // second completion reverts at the Diamond (already completed)
      await expect(mockDiamond.simulateOrderComplete(1)).to.be.reverted;
    });
  });

  describe("Access control", function () {
    it("onOrderComplete is onlyDiamond", async function () {
      await place(user, 1);
      await expect(
        integrator.connect(user).onOrderComplete(1, user.address, PRODUCT_PRICE, treasury.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
    });

    it("onOrderCancel is onlyDiamond", async function () {
      await place(user, 1);
      await expect(integrator.connect(user).onOrderCancel(1)).to.be.revertedWithCustomError(
        integrator,
        "OnlyDiamond"
      );
    });

    it("admin functions are onlyOwner", async function () {
      await expect(
        integrator.connect(user).setProductPrice(2, USDC(1))
      ).to.be.revertedWithCustomError(integrator, "OwnableUnauthorizedAccount");
      await expect(integrator.connect(user).pause()).to.be.revertedWithCustomError(
        integrator,
        "OwnableUnauthorizedAccount"
      );
      await expect(
        integrator.connect(user).sweepUsdc(user.address, 1)
      ).to.be.revertedWithCustomError(integrator, "OwnableUnauthorizedAccount");
    });

    it("renounceOwnership is disabled", async function () {
      await expect(integrator.renounceOwnership()).to.be.revertedWithCustomError(
        integrator,
        "RenounceDisabled"
      );
    });

    it("constructor rejects zero addresses", async function () {
      const I = await ethers.getContractFactory("BlioCheckoutIntegrator");
      const d = await mockDiamond.getAddress();
      const u = await mockUsdc.getAddress();
      await expect(
        I.deploy(ethers.ZeroAddress, u, treasury.address, owner.address, BASE_TX_LIMIT, 10)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      await expect(
        I.deploy(d, ethers.ZeroAddress, treasury.address, owner.address, BASE_TX_LIMIT, 10)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      await expect(
        I.deploy(d, u, ethers.ZeroAddress, owner.address, BASE_TX_LIMIT, 10)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      await expect(
        I.deploy(d, u, treasury.address, ethers.ZeroAddress, BASE_TX_LIMIT, 10)
      ).to.be.revertedWithCustomError(integrator, "OwnableInvalidOwner");
    });
  });

  describe("Mis-registration defence", function () {
    it("flags SettlementRoutingAnomaly when USDC is routed to the integrator", async function () {
      await mockDiamond.setUsdcThroughIntegrator(true);
      await place(user, 1);

      await expect(mockDiamond.simulateOrderComplete(1)).to.emit(
        integrator,
        "SettlementRoutingAnomaly"
      );
      // Not marked fulfilled: the settlement did not reach the treasury.
      expect((await integrator.getSession(1)).fulfilled).to.equal(false);
    });
  });

  describe("Recovery", function () {
    it("owner can sweep stray USDC", async function () {
      await mockUsdc.mint(await integrator.getAddress(), USDC(5));
      await expect(integrator.sweepUsdc(owner.address, USDC(5)))
        .to.emit(integrator, "UsdcSwept")
        .withArgs(owner.address, USDC(5));
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(0);
    });
  });
});
