import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const STATUS = { PLACED: 0, ACCEPTED: 1, PAID: 2, COMPLETED: 3, CANCELLED: 4 };

describe("MarketplaceCheckoutIntegrator — Offramp (sell-back)", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let user2: SignerWithAddress;
  let stranger: SignerWithAddress;
  let relayer: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let integrator: any;
  let marketplace: any;

  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
  const BASE_TX_LIMIT = USDC(100);
  const DAILY_COUNT_LIMIT = 20;
  const UNIT_PRICE = USDC(10);
  const PRODUCT_ID = 1;
  const INR = ethers.encodeBytes32String("INR");

  const buySelector = ethers.id("buy(uint256,uint256)").slice(0, 10);

  beforeEach(async function () {
    [owner, user, user2, stranger, relayer] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUsdc = await MockUSDC.deploy();

    const MockDiamond = await ethers.getContractFactory("MockDiamond");
    mockDiamond = await MockDiamond.deploy(await mockUsdc.getAddress());

    const Integrator = await ethers.getContractFactory("MarketplaceCheckoutIntegrator");
    integrator = await Integrator.deploy(
      await mockDiamond.getAddress(),
      await mockUsdc.getAddress(),
      BASE_TX_LIMIT,
      DAILY_COUNT_LIMIT
    );

    const Marketplace = await ethers.getContractFactory("SimpleNFTMarketplace");
    marketplace = await Marketplace.deploy(await mockUsdc.getAddress(), "Demo", "DMO");

    await mockDiamond.registerIntegrator(
      await integrator.getAddress(),
      await integrator.proxyImpl()
    );
    await marketplace.setProductPrice(PRODUCT_ID, UNIT_PRICE);
    await marketplace.setOfframpIntegrator(await integrator.getAddress());
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(10000));

    const prefixArgs = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [PRODUCT_ID]);
    await integrator.setRecipe(
      await marketplace.getAddress(),
      PRODUCT_ID,
      UNIT_PRICE,
      buySelector,
      prefixArgs,
      true,
      [await marketplace.getAddress()]
    );

    await integrator.setOfframpEnabled(true);
    await integrator.setOfframpRelayer(relayer.address);
    await integrator.setMaxUsdcPerOfframp(USDC(50));
    await integrator.setUserSellVolumeLimit(USDC(100));

    // Fund the integrator pool. In real deployment this is a treasury top-up.
    await mockUsdc.mint(await integrator.getAddress(), USDC(1000));
  });

  // Place a buy and sweep tokenId=1 from the proxy to the buyer's EOA.
  async function buyOne(
    buyer: SignerWithAddress,
    orderIdAtMockDiamond: bigint = 1n,
    tokenId: bigint = 1n
  ) {
    await integrator
      .connect(buyer)
      .userPlaceOrder(await marketplace.getAddress(), PRODUCT_ID, 1, INR, 1, "", 0, 0);
    await mockDiamond.simulateOrderComplete(orderIdAtMockDiamond);
    const proxyAddr = await integrator.proxyAddress(buyer.address);
    const proxy = await ethers.getContractAt("UserProxy", proxyAddr);
    await proxy.connect(buyer).sweepERC721(await marketplace.getAddress(), tokenId);
    expect(await marketplace.ownerOf(tokenId)).to.equal(buyer.address);
  }

  async function placeSellBack(seller: SignerWithAddress, tokenId: bigint = 1n) {
    const tx = await integrator
      .connect(seller)
      .userInitiateSellBack(
        await marketplace.getAddress(),
        tokenId,
        INR,
        USDC(800),
        1,
        0,
        "userPubKey"
      );
    const rcpt = await tx.wait();
    const ev = rcpt.logs.find((l: any) => l.fragment?.name === "OfframpInitiated");
    return ev.args.orderId as bigint;
  }

  describe("Happy path", function () {
    it("buy → sellBack → accept → deliverUpi → complete; integrator funds, NFT burned", async function () {
      await buyOne(user);

      const integratorBefore = await mockUsdc.balanceOf(await integrator.getAddress());
      const diamondBefore = await mockUsdc.balanceOf(await mockDiamond.getAddress());

      const sellOrderId = await placeSellBack(user);

      // NFT burned
      await expect(marketplace.ownerOf(1n)).to.be.reverted;
      // Volume tracked
      expect(await integrator.userSellVolume(user.address)).to.equal(UNIT_PRICE);
      // Order on Diamond, status = PLACED, order.user = system proxy
      const so = await mockDiamond.getSellOrder(sellOrderId);
      expect(so.user).to.equal(await integrator.systemProxy());
      expect(so.amount).to.equal(UNIT_PRICE);
      expect(so.status).to.equal(STATUS.PLACED);

      await mockDiamond.acceptSellOrder(sellOrderId, "merchantPubKey");
      await integrator.connect(user).deliverOfframpUpi(sellOrderId, "encUpiPayload");

      const so2 = await mockDiamond.getSellOrder(sellOrderId);
      expect(so2.status).to.equal(STATUS.PAID);
      expect(so2.encUpi).to.equal("encUpiPayload");

      const integratorAfter = await mockUsdc.balanceOf(await integrator.getAddress());
      const diamondAfter = await mockUsdc.balanceOf(await mockDiamond.getAddress());
      // Integrator transferred USDC to the system proxy, which then forwarded
      // it to the Diamond. Net integrator delta is -UNIT_PRICE; Diamond +UNIT_PRICE.
      expect(integratorBefore - integratorAfter).to.equal(UNIT_PRICE);
      expect(diamondAfter - diamondBefore).to.equal(UNIT_PRICE);

      await mockDiamond.completeSellOrder(sellOrderId);
      await integrator.connect(stranger).reconcile(sellOrderId, STATUS.COMPLETED);
      const r = await integrator.offramps(sellOrderId);
      expect(r.lastStatus).to.equal(STATUS.COMPLETED);
    });

    it("relayer can deliver UPI on the user's behalf", async function () {
      await buyOne(user);
      const sellOrderId = await placeSellBack(user);
      await mockDiamond.acceptSellOrder(sellOrderId, "mp");
      await integrator.connect(relayer).deliverOfframpUpi(sellOrderId, "encUpi");
      const so = await mockDiamond.getSellOrder(sellOrderId);
      expect(so.status).to.equal(STATUS.PAID);
    });

    it("honors the original price when the marketplace price has changed since the buy", async function () {
      await buyOne(user); // bought at 10 USDC
      // Bump the marketplace price after the buy
      await marketplace.setProductPrice(PRODUCT_ID, USDC(25));
      const sellOrderId = await placeSellBack(user);
      const so = await mockDiamond.getSellOrder(sellOrderId);
      expect(so.amount).to.equal(UNIT_PRICE); // original 10, not 25
    });
  });

  describe("Cancellation refund", function () {
    it("cancel-while-PAID refunds USDC to the system proxy; reconcile sweeps it back to the integrator and decrements user volume", async function () {
      await buyOne(user);
      const sellOrderId = await placeSellBack(user);
      await mockDiamond.acceptSellOrder(sellOrderId, "mp");
      await integrator.connect(user).deliverOfframpUpi(sellOrderId, "encUpi");

      const sysProxy = await integrator.systemProxy();
      const integratorMid = await mockUsdc.balanceOf(await integrator.getAddress());
      await mockDiamond.cancelSellOrder(sellOrderId);

      // Refund landed on the proxy, not the integrator yet.
      expect(await mockUsdc.balanceOf(sysProxy)).to.equal(UNIT_PRICE);
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(integratorMid);

      const volBefore = await integrator.userSellVolume(user.address);
      await integrator.connect(stranger).reconcile(sellOrderId, STATUS.CANCELLED);
      const volAfter = await integrator.userSellVolume(user.address);
      expect(volBefore - volAfter).to.equal(UNIT_PRICE);

      // After reconcile, the integrator pool got the refund back.
      expect(await mockUsdc.balanceOf(sysProxy)).to.equal(0);
      const integratorAfterReconcile = await mockUsdc.balanceOf(await integrator.getAddress());
      expect(integratorAfterReconcile - integratorMid).to.equal(UNIT_PRICE);
    });

    it("retryOfframp places a fresh sell order using the same user/amount", async function () {
      await buyOne(user);
      const sellOrderId = await placeSellBack(user);
      await mockDiamond.cancelSellOrder(sellOrderId);
      await integrator.connect(stranger).reconcile(sellOrderId, STATUS.CANCELLED);

      const tx = await integrator.retryOfframp(sellOrderId, INR, USDC(800), 1, 0, "");
      const newId = (await tx.wait()).logs.find((l: any) => l.fragment?.name === "OfframpRetried")
        .args.newOrderId;

      const newRec = await integrator.offramps(newId);
      expect(newRec.user).to.equal(user.address);
      expect(newRec.usdcAmount).to.equal(UNIT_PRICE);
      expect(await integrator.orderInitiator(newId)).to.equal(user.address);
    });

    it("retryOfframp rejects non-cancelled orders", async function () {
      await buyOne(user);
      const sellOrderId = await placeSellBack(user);
      // lastStatus still 0 (PLACED) — never reconciled to CANCELLED.
      await expect(
        integrator.retryOfframp(sellOrderId, INR, USDC(800), 1, 0, "")
      ).to.be.revertedWithCustomError(integrator, "OfframpNotCancelled");
    });
  });

  describe("Caps and access control", function () {
    it("offrampDisabled blocks userInitiateSellBack", async function () {
      await buyOne(user);
      await integrator.setOfframpEnabled(false);
      await expect(placeSellBack(user)).to.be.revertedWithCustomError(
        integrator,
        "OfframpDisabled"
      );
    });

    it("rejects sell-back from non-owner of the token", async function () {
      await buyOne(user);
      await expect(
        integrator
          .connect(user2)
          .userInitiateSellBack(await marketplace.getAddress(), 1n, INR, USDC(800), 1, 0, "")
      ).to.be.revertedWithCustomError(integrator, "TokenNotOwnedByCaller");
    });

    it("max-per-offramp blocks orders above cap", async function () {
      await integrator.setMaxUsdcPerOfframp(USDC(5));
      await buyOne(user);
      await expect(placeSellBack(user)).to.be.revertedWithCustomError(
        integrator,
        "OfframpAmountTooLarge"
      );
    });

    it("user volume cap rejects orders that would push past the limit", async function () {
      await integrator.setUserSellVolumeLimit(USDC(15));
      await integrator
        .connect(user)
        .userPlaceOrder(await marketplace.getAddress(), PRODUCT_ID, 2, INR, 1, "", 0, 0);
      await mockDiamond.simulateOrderComplete(1n);
      const proxyAddr = await integrator.proxyAddress(user.address);
      const proxy = await ethers.getContractAt("UserProxy", proxyAddr);
      await proxy.connect(user).sweepERC721(await marketplace.getAddress(), 1n);
      await proxy.connect(user).sweepERC721(await marketplace.getAddress(), 2n);

      await placeSellBack(user, 1n);
      await expect(placeSellBack(user, 2n)).to.be.revertedWithCustomError(
        integrator,
        "OfframpUserCapExceeded"
      );
    });

    it("insufficient pool reverts cleanly", async function () {
      await buyOne(user);
      const bal = await mockUsdc.balanceOf(await integrator.getAddress());
      await integrator.withdrawUsdc(stranger.address, bal);
      await expect(placeSellBack(user)).to.be.revertedWithCustomError(
        integrator,
        "OfframpInsufficientPool"
      );
    });

    it("deliverOfframpUpi rejects unauthorized callers", async function () {
      await buyOne(user);
      const sellOrderId = await placeSellBack(user);
      await mockDiamond.acceptSellOrder(sellOrderId, "mp");
      await expect(
        integrator.connect(stranger).deliverOfframpUpi(sellOrderId, "encUpi")
      ).to.be.revertedWithCustomError(integrator, "OfframpNotAuthorized");
    });

    it("only owner can flip offramp toggles", async function () {
      await expect(
        integrator.connect(stranger).setOfframpEnabled(false)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
      await expect(
        integrator.connect(stranger).setOfframpRelayer(stranger.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
      await expect(
        integrator.connect(stranger).setMaxUsdcPerOfframp(0)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
      await expect(
        integrator.connect(stranger).setUserSellVolumeLimit(0)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
      await expect(
        integrator.connect(stranger).withdrawUsdc(stranger.address, 0)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });
  });

  describe("Marketplace authorization", function () {
    it("sellBackEntry rejects callers other than the registered offramp integrator", async function () {
      await buyOne(user);
      await expect(
        marketplace.connect(stranger).sellBackEntry(1n, user.address)
      ).to.be.revertedWithCustomError(marketplace, "OnlyOfframpIntegrator");
    });

    it("sellBackEntry rejects when from-arg doesn't own the token", async function () {
      await buyOne(user);
      // Re-point the marketplace at `stranger` so we can call sellBackEntry directly with a bad `from`.
      await marketplace.setOfframpIntegrator(stranger.address);
      await expect(
        marketplace.connect(stranger).sellBackEntry(1n, user2.address)
      ).to.be.revertedWithCustomError(marketplace, "NotTokenOwner");
    });
  });
});
