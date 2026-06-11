import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const STATUS = { PLACED: 0, ACCEPTED: 1, PAID: 2, COMPLETED: 3, CANCELLED: 4 };

/**
 * Guard / branch coverage for MarketplaceCheckoutIntegrator: admin access
 * control, constructor + recipe validation, BUY limit enforcement,
 * cancel-hook bookkeeping, and every offramp guard (pool, caps, auth,
 * reconcile/retry preconditions).
 */
describe("MarketplaceCheckoutIntegrator — guards & limits", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let user2: SignerWithAddress;
  let stranger: SignerWithAddress;
  let relayer: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let integrator: any;
  let marketplace: any;

  const USDC = (n: number | string) => ethers.parseUnits(n.toString(), 6);
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

    await mockUsdc.mint(await integrator.getAddress(), USDC(1000));
  });

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

  // ─── constructor ────────────────────────────────────────────────────

  it("constructor rejects a zero diamond / zero usdc", async function () {
    const Integrator = await ethers.getContractFactory("MarketplaceCheckoutIntegrator");
    await expect(
      Integrator.deploy(ethers.ZeroAddress, await mockUsdc.getAddress(), 1n, 1n)
    ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    await expect(
      Integrator.deploy(await mockDiamond.getAddress(), ethers.ZeroAddress, 1n, 1n)
    ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
  });

  // ─── admin access control ───────────────────────────────────────────

  it("every admin setter is owner-gated", async function () {
    const s = integrator.connect(stranger);
    const mk = await marketplace.getAddress();
    await expect(s.setBaseTxLimit(1n)).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    await expect(s.setDailyTxCountLimit(1n)).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    await expect(s.setRpToUsdc(INR, 1n)).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    await expect(s.setMaxTxLimit(INR, 1n)).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    await expect(s.setUserRP(user.address, 1n)).to.be.revertedWithCustomError(
      integrator,
      "OnlyOwner"
    );
    await expect(s.batchSetUserRP([user.address], [1n])).to.be.revertedWithCustomError(
      integrator,
      "OnlyOwner"
    );
    await expect(
      s.setRecipe(mk, 1, 1n, "0x12345678", "0x", true, [])
    ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    await expect(s.removeRecipe(mk, 1)).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    await expect(s.setOfframpEnabled(false)).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    await expect(s.setOfframpRelayer(stranger.address)).to.be.revertedWithCustomError(
      integrator,
      "OnlyOwner"
    );
    await expect(s.setMaxUsdcPerOfframp(1n)).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    await expect(s.setUserSellVolumeLimit(1n)).to.be.revertedWithCustomError(
      integrator,
      "OnlyOwner"
    );
    await expect(s.withdrawUsdc(stranger.address, 1n)).to.be.revertedWithCustomError(
      integrator,
      "OnlyOwner"
    );
    await expect(s.retryOfframp(1n, INR, 0n, 1n, 0n, "pk")).to.be.revertedWithCustomError(
      integrator,
      "OnlyOwner"
    );
  });

  it("admin setters update state + emit", async function () {
    await expect(integrator.setBaseTxLimit(USDC(33)))
      .to.emit(integrator, "BaseTxLimitUpdated")
      .withArgs(USDC(33));
    expect(await integrator.baseTxLimit()).to.equal(USDC(33));
    await expect(integrator.setDailyTxCountLimit(7n))
      .to.emit(integrator, "DailyTxCountLimitUpdated")
      .withArgs(7n);
    await expect(integrator.setRpToUsdc(INR, USDC(2)))
      .to.emit(integrator, "RpRateUpdated")
      .withArgs(INR, USDC(2));
    await expect(integrator.setMaxTxLimit(INR, USDC(40)))
      .to.emit(integrator, "MaxTxLimitUpdated")
      .withArgs(INR, USDC(40));
    await expect(integrator.setUserRP(user.address, 5n))
      .to.emit(integrator, "UserRPUpdated")
      .withArgs(user.address, 5n);
    await integrator.batchSetUserRP([user.address, stranger.address], [3n, 4n]);
    expect(await integrator.userRP(stranger.address)).to.equal(4n);
  });

  it("batchSetUserRP rejects a length mismatch", async function () {
    await expect(integrator.batchSetUserRP([user.address], [1n, 2n])).to.be.revertedWithCustomError(
      integrator,
      "ArrayLengthMismatch"
    );
  });

  it("setRecipe validates client (zero / EOA) and unit price", async function () {
    await expect(
      integrator.setRecipe(ethers.ZeroAddress, 1, 1n, "0x12345678", "0x", true, [])
    ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    // EOA has no code → also InvalidAddress.
    await expect(
      integrator.setRecipe(stranger.address, 1, 1n, "0x12345678", "0x", true, [])
    ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    await expect(
      integrator.setRecipe(await marketplace.getAddress(), 1, 0n, "0x12345678", "0x", true, [])
    ).to.be.revertedWithCustomError(integrator, "InvalidUnitPrice");
  });

  it("withdrawUsdc rejects a zero recipient and moves funds to a real one", async function () {
    await expect(integrator.withdrawUsdc(ethers.ZeroAddress, 1n)).to.be.revertedWithCustomError(
      integrator,
      "InvalidAddress"
    );
    const before = await mockUsdc.balanceOf(owner.address);
    await expect(integrator.withdrawUsdc(owner.address, USDC(5)))
      .to.emit(integrator, "OfframpUsdcWithdrawn")
      .withArgs(owner.address, USDC(5));
    expect((await mockUsdc.balanceOf(owner.address)) - before).to.equal(USDC(5));
  });

  // ─── Diamond-only callbacks ─────────────────────────────────────────

  it("validateOrder / onOrderComplete / onOrderCancel reject a non-Diamond caller", async function () {
    await expect(
      integrator.connect(stranger).validateOrder(user.address, 1n, INR)
    ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
    await expect(
      integrator.connect(stranger).onOrderComplete(1n, user.address, 1n, user.address)
    ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
    await expect(integrator.connect(stranger).onOrderCancel(1n)).to.be.revertedWithCustomError(
      integrator,
      "OnlyDiamond"
    );
  });

  // ─── BUY limits via validateOrder ───────────────────────────────────

  it("rejects a buy above the per-tx limit and beyond the daily count", async function () {
    // 11 × 10 = 110 USDC > baseTxLimit (100) → validateOrder false → placement reverts.
    await expect(
      integrator
        .connect(user)
        .userPlaceOrder(await marketplace.getAddress(), PRODUCT_ID, 11, INR, 1, "", 0, 0)
    ).to.be.reverted;

    await integrator.setDailyTxCountLimit(1);
    await integrator
      .connect(user)
      .userPlaceOrder(await marketplace.getAddress(), PRODUCT_ID, 1, INR, 1, "", 0, 0);
    await expect(
      integrator
        .connect(user)
        .userPlaceOrder(await marketplace.getAddress(), PRODUCT_ID, 1, INR, 1, "", 0, 0)
    ).to.be.reverted;
  });

  it("getUserTxLimit covers rp=0 / default rate / explicit rate / cap; daily views", async function () {
    expect(await integrator.getUserTxLimit(stranger.address, INR)).to.equal(BASE_TX_LIMIT);
    await integrator.setUserRP(user.address, 5n);
    const XXX = ethers.encodeBytes32String("XXX");
    expect(await integrator.getUserTxLimit(user.address, XXX)).to.equal(USDC(5)); // rate default 1e6
    await integrator.setRpToUsdc(INR, USDC(2));
    expect(await integrator.getUserTxLimit(user.address, INR)).to.equal(USDC(10)); // rp*rate
    await integrator.setMaxTxLimit(INR, USDC(8));
    expect(await integrator.getUserTxLimit(user.address, INR)).to.equal(USDC(8)); // capped

    expect(await integrator.getRemainingDailyCount(user.address)).to.equal(DAILY_COUNT_LIMIT);
    await integrator.setDailyTxCountLimit(0);
    expect(await integrator.getRemainingDailyCount(user.address)).to.equal(0n); // count >= limit
    expect(await integrator.getTodayCount(user.address)).to.equal(0n);
  });

  // ─── onOrderComplete / onOrderCancel branches ───────────────────────

  it("onOrderComplete rejects a replay; appendQuantity=false recipes fulfill too", async function () {
    await integrator
      .connect(user)
      .userPlaceOrder(await marketplace.getAddress(), PRODUCT_ID, 1, INR, 1, "", 0, 0);
    await mockDiamond.simulateOrderComplete(1n);
    // Replay the callback directly (the mock's own simulate guards replays
    // before reaching the integrator).
    await expect(
      mockDiamond.adminCallOnOrderComplete(
        await integrator.getAddress(),
        1n,
        user.address,
        UNIT_PRICE,
        user.address
      )
    ).to.be.revertedWithCustomError(integrator, "OrderAlreadyFulfilled");

    // Recipe with appendQuantity=false: prefixArgs already carry (productId, qty).
    const PRODUCT2 = 2;
    await marketplace.setProductPrice(PRODUCT2, UNIT_PRICE);
    const fullArgs = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint256"],
      [PRODUCT2, 1]
    );
    await integrator.setRecipe(
      await marketplace.getAddress(),
      PRODUCT2,
      UNIT_PRICE,
      buySelector,
      fullArgs,
      false,
      [await marketplace.getAddress()]
    );
    await integrator
      .connect(user2)
      .userPlaceOrder(await marketplace.getAddress(), PRODUCT2, 1, INR, 1, "", 0, 0);
    await mockDiamond.simulateOrderComplete(2n);
    // Minted under the user2 proxy.
    const proxy2 = await integrator.proxyAddress(user2.address);
    expect(await marketplace.balanceOf(proxy2)).to.equal(1n);
  });

  it("onOrderCancel releases the daily-count slot reserved at placement", async function () {
    await integrator
      .connect(user)
      .userPlaceOrder(await marketplace.getAddress(), PRODUCT_ID, 1, INR, 1, "", 0, 0);
    expect(await integrator.getTodayCount(user.address)).to.equal(1n);
    await mockDiamond.simulateOrderCancelled(1n);
    expect(await integrator.getTodayCount(user.address)).to.equal(0n); // slot released
  });

  // ─── offramp guards ─────────────────────────────────────────────────

  it("userInitiateSellBack guards: disabled / not owner of token / no recipe / over cap / pool empty / user cap", async function () {
    await buyOne(user);

    await integrator.setOfframpEnabled(false);
    await expect(placeSellBack(user)).to.be.revertedWithCustomError(integrator, "OfframpDisabled");
    await integrator.setOfframpEnabled(true);

    await expect(placeSellBack(stranger)).to.be.revertedWithCustomError(
      integrator,
      "TokenNotOwnedByCaller"
    );

    await integrator.removeRecipe(await marketplace.getAddress(), PRODUCT_ID);
    await expect(placeSellBack(user)).to.be.revertedWithCustomError(
      integrator,
      "TokenNotMintedHere"
    );
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

    await integrator.setMaxUsdcPerOfframp(USDC(5)); // < 10 unit price
    await expect(placeSellBack(user)).to.be.revertedWithCustomError(
      integrator,
      "OfframpAmountTooLarge"
    );
    await integrator.setMaxUsdcPerOfframp(USDC(50));

    const pool = await mockUsdc.balanceOf(await integrator.getAddress());
    await integrator.withdrawUsdc(owner.address, pool);
    await expect(placeSellBack(user)).to.be.revertedWithCustomError(
      integrator,
      "OfframpInsufficientPool"
    );
    await mockUsdc.mint(await integrator.getAddress(), USDC(1000));

    await integrator.setUserSellVolumeLimit(USDC(5)); // < 10 unit price
    await expect(placeSellBack(user)).to.be.revertedWithCustomError(
      integrator,
      "OfframpUserCapExceeded"
    );
  });

  it("deliverOfframpUpi guards: unknown order / unauthorized / fee-unready fallback / pool drained", async function () {
    await expect(
      integrator.connect(user).deliverOfframpUpi(999n, "x")
    ).to.be.revertedWithCustomError(integrator, "OfframpRecordNotFound");

    await buyOne(user);
    const sellOrderId = await placeSellBack(user);
    await mockDiamond.acceptSellOrder(sellOrderId, "mp");

    await expect(
      integrator.connect(stranger).deliverOfframpUpi(sellOrderId, "x")
    ).to.be.revertedWithCustomError(integrator, "OfframpNotAuthorized");

    // actualUsdtAmount unavailable (0) → falls back to the recorded principal.
    await mockDiamond.setAdditionalOrderDetailsFeeUnready(true);
    const pool = await mockUsdc.balanceOf(await integrator.getAddress());
    await integrator.withdrawUsdc(owner.address, pool); // drain → insufficient
    await expect(
      integrator.connect(user).deliverOfframpUpi(sellOrderId, "x")
    ).to.be.revertedWithCustomError(integrator, "OfframpInsufficientPool");

    await mockUsdc.mint(await integrator.getAddress(), UNIT_PRICE);
    await integrator.connect(user).deliverOfframpUpi(sellOrderId, "encUpi");
    expect((await mockDiamond.getSellOrder(sellOrderId)).status).to.equal(STATUS.PAID);
  });

  it("reconcile guards: unknown / double-reconcile; PLACED-cancel reconciles with an empty proxy", async function () {
    await expect(integrator.reconcile(999n, STATUS.COMPLETED)).to.be.revertedWithCustomError(
      integrator,
      "OfframpRecordNotFound"
    );

    await buyOne(user);
    const sellOrderId = await placeSellBack(user);

    // Cancel while PLACED — no USDC ever reached the system proxy, so the
    // CANCELLED reconcile takes the bal == 0 path and just restores volume.
    await mockDiamond.cancelSellOrder(sellOrderId);
    await integrator.reconcile(sellOrderId, STATUS.CANCELLED);
    expect(await integrator.userSellVolume(user.address)).to.equal(0n);

    await expect(integrator.reconcile(sellOrderId, STATUS.CANCELLED)).to.be.revertedWithCustomError(
      integrator,
      "OfframpAlreadyReconciled"
    );
  });

  it("retryOfframp guards: unknown / not-cancelled / pool empty / user cap; then succeeds", async function () {
    await expect(
      integrator.retryOfframp(999n, INR, 0n, 1n, 0n, "pk")
    ).to.be.revertedWithCustomError(integrator, "OfframpRecordNotFound");

    await buyOne(user);
    const sellOrderId = await placeSellBack(user);

    // Not yet reconciled-to-CANCELLED → OfframpNotCancelled.
    await expect(
      integrator.retryOfframp(sellOrderId, INR, 0n, 1n, 0n, "pk")
    ).to.be.revertedWithCustomError(integrator, "OfframpNotCancelled");

    await mockDiamond.cancelSellOrder(sellOrderId);
    await integrator.reconcile(sellOrderId, STATUS.CANCELLED);

    const pool = await mockUsdc.balanceOf(await integrator.getAddress());
    await integrator.withdrawUsdc(owner.address, pool);
    await expect(
      integrator.retryOfframp(sellOrderId, INR, 0n, 1n, 0n, "pk")
    ).to.be.revertedWithCustomError(integrator, "OfframpInsufficientPool");
    await mockUsdc.mint(await integrator.getAddress(), USDC(1000));

    await integrator.setUserSellVolumeLimit(USDC(5)); // < 10
    await expect(
      integrator.retryOfframp(sellOrderId, INR, 0n, 1n, 0n, "pk")
    ).to.be.revertedWithCustomError(integrator, "OfframpUserCapExceeded");
    await integrator.setUserSellVolumeLimit(USDC(100));

    const tx = await integrator.retryOfframp(sellOrderId, INR, 0n, 1n, 0n, "pk");
    const rcpt = await tx.wait();
    const ev = rcpt.logs.find((l: any) => l.fragment?.name === "OfframpInitiated");
    expect(ev).to.not.equal(undefined);
    expect(await integrator.userSellVolume(user.address)).to.equal(UNIT_PRICE);
  });
});
