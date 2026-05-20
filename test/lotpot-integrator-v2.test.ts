import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("LotPotCheckoutIntegratorV2", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let stranger: SignerWithAddress;
  let integratorV2: any;
  let proxyImpl: any;
  let mockUsdc: any;
  let mockMegapot: any;
  let mockBatchFacilitator: any;
  let mockNft: any;
  let mockDiamond: any;

  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
  const TICKET_PRICE = USDC(1);
  const BASE_TX_LIMIT = USDC(50);
  const DAILY_COUNT_LIMIT = 10n;
  const SOURCE = ethers.encodeBytes32String("lotpot");
  const BALL_MAX = 30;
  const BONUSBALL_MAX = 15;

  beforeEach(async function () {
    [owner, user, stranger] = await ethers.getSigners();

    proxyImpl = await ethers.deployContract("UserProxyV2");
    mockUsdc = await ethers.deployContract("MockUSDC");
    mockNft = await ethers.deployContract("MockJackpotNFT");
    mockMegapot = await ethers.deployContract("MockMegapot", [
      await mockUsdc.getAddress(),
      await mockNft.getAddress(),
      TICKET_PRICE,
      BALL_MAX,
      BONUSBALL_MAX,
    ]);
    mockBatchFacilitator = await ethers.deployContract("MockBatchPurchaseFacilitator", [
      await mockUsdc.getAddress(),
      await mockNft.getAddress(),
      TICKET_PRICE,
      BALL_MAX,
      BONUSBALL_MAX,
      11,
    ]);
    mockDiamond = await ethers.deployContract("MockDiamond", [await mockUsdc.getAddress()]);

    integratorV2 = await ethers.deployContract("LotPotCheckoutIntegratorV2", [
      await mockDiamond.getAddress(),
      await mockUsdc.getAddress(),
      owner.address,
      await proxyImpl.getAddress(),
      await mockMegapot.getAddress(),
      await mockBatchFacilitator.getAddress(),
      await mockNft.getAddress(),
      BASE_TX_LIMIT,
      DAILY_COUNT_LIMIT,
      SOURCE,
    ]);

    await mockDiamond.registerIntegrator(
      await integratorV2.getAddress(),
      await proxyImpl.getAddress()
    );
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(10000));
    await mockBatchFacilitator.addAllowed(await integratorV2.getAddress());
  });

  it("starts with deprecated = false", async function () {
    expect(await integratorV2.deprecated()).to.equal(false);
  });

  it("deprecate() flips the flag and emits event (owner only)", async function () {
    await expect(integratorV2.connect(owner).deprecate()).to.emit(integratorV2, "Deprecated");
    expect(await integratorV2.deprecated()).to.equal(true);
  });

  it("deprecate() reverts when called by non-owner", async function () {
    await expect(integratorV2.connect(stranger).deprecate()).to.be.reverted;
  });

  it("adminEnsureProxy deploys + initializes a user's proxy (owner only)", async function () {
    const predicted = await integratorV2.proxyAddress(user.address);
    expect(await ethers.provider.getCode(predicted)).to.equal("0x");

    await integratorV2.connect(owner).adminEnsureProxy(user.address);

    expect(await ethers.provider.getCode(predicted)).to.not.equal("0x");
    const proxyContract = await ethers.getContractAt("UserProxyV2", predicted);
    expect(await proxyContract.lastActivityTimestamp()).to.be.greaterThan(0);
  });

  it("adminEnsureProxy is idempotent (no-op if proxy already deployed)", async function () {
    await integratorV2.connect(owner).adminEnsureProxy(user.address);
    // Second call must not revert.
    await integratorV2.connect(owner).adminEnsureProxy(user.address);
  });

  it("adminEnsureProxy reverts when called by non-owner", async function () {
    await expect(integratorV2.connect(stranger).adminEnsureProxy(user.address)).to.be.reverted;
  });

  it("_ensureProxy initializes the V2 proxy clock on first order placement", async function () {
    const predicted = await integratorV2.proxyAddress(user.address);
    expect(await ethers.provider.getCode(predicted)).to.equal("0x");

    // Limits are already set via constructor; confirm setters still work post-deploy.
    await integratorV2.connect(owner).setBaseTxLimit(USDC(50));
    await integratorV2.connect(owner).setDailyTxCountLimit(10);

    const INR = ethers.encodeBytes32String("INR");
    await integratorV2.connect(user).userPlaceOrder(1, INR, 1, "", 0, 0, [], []);

    expect(await ethers.provider.getCode(predicted)).to.not.equal("0x");
    const proxyContract = await ethers.getContractAt("UserProxyV2", predicted);
    expect(await proxyContract.lastActivityTimestamp()).to.be.greaterThan(0);
  });

  describe("LotPotCheckoutIntegratorV2 — cashback consumption", function () {
    const INR = ethers.encodeBytes32String("INR");

    it("auto-nets cashback USDC sitting at the proxy on the next ticket order", async function () {
      // 1. Simulate Diamond cashback: mint 2 USDC directly to the user's
      //    not-yet-deployed proxy address (the CREATE2 address is
      //    deterministic regardless of whether the contract is live).
      const proxyAddr = await integratorV2.proxyAddress(user.address);
      const cashback = ethers.parseUnits("2", 6);
      await mockUsdc.mint(proxyAddr, cashback);
      expect(await mockUsdc.balanceOf(proxyAddr)).to.equal(cashback);

      // 2. MockMegapot was constructed with TICKET_PRICE = USDC(1);
      //    no override needed for a 5-ticket order (5 × 1 = 5 USDC total).

      // 3. User places a 5-ticket order. _route sees credit = 2 USDC < 5 USDC
      //    total, so it places a Diamond order for the delta (3 USDC).
      //    _ensureProxy deploys + initializes the proxy as a side-effect.
      const placeTx = await integratorV2.connect(user).userPlaceOrder(5, INR, 1, "", 0, 0, [], []);

      // The first Diamond order gets id = 1 (MockDiamond starts at nextOrderId = 1).
      const orderId = 1n;

      // 4a. LotPotOrderCreated should have been emitted at placement for the delta.
      await expect(placeTx)
        .to.emit(integratorV2, "LotPotOrderCreated")
        .withArgs(orderId, user.address, 5, true, USDC(5));

      // 4b. Simulate Diamond completing the order (transfers delta USDC to proxy,
      //     then calls onOrderComplete). The fulfillment path detects that the
      //     proxy now holds the full 5 USDC (3 delta + 2 credit) and, after
      //     calling Megapot, emits LotPotCreditRedeemed for the 2 USDC netted.
      const completeTx = await mockDiamond.simulateOrderComplete(orderId);

      await expect(completeTx)
        .to.emit(integratorV2, "LotPotCreditRedeemed")
        .withArgs(user.address, orderId, 5, cashback); // creditUsed = 2 USDC

      // 4c. Fulfillment emitted (tickets were minted successfully).
      await expect(completeTx)
        .to.emit(integratorV2, "LotPotFulfilled")
        .withArgs(orderId, user.address, proxyAddr, 5);

      // 4d. Proxy was deployed and initialized — sweep clock is anchored.
      const proxyContract = await ethers.getContractAt("UserProxyV2", proxyAddr);
      expect(await proxyContract.lastActivityTimestamp()).to.be.greaterThan(0);

      // 4e. All 5 tickets landed on the user EOA; proxy and integrator hold none.
      expect(await mockNft.balanceOf(user.address)).to.equal(5);
      expect(await mockUsdc.balanceOf(proxyAddr)).to.equal(0);
    });

    it("proxy gets initialized on first user-driven order placement", async function () {
      const proxyAddr = await integratorV2.proxyAddress(user.address);
      // Proxy does not yet exist on-chain.
      expect(await ethers.provider.getCode(proxyAddr)).to.equal("0x");

      // Place the user's first order. _ensureProxy is invoked inside _route,
      // deploying the clone and calling initialize() to anchor the activity clock.
      await integratorV2.connect(user).userPlaceOrder(1, INR, 1, "", 0, 0, [], []);

      // Proxy is now live.
      expect(await ethers.provider.getCode(proxyAddr)).to.not.equal("0x");

      // initialize() was called: lastActivityTimestamp was written.
      const proxyContract = await ethers.getContractAt("UserProxyV2", proxyAddr);
      expect(await proxyContract.lastActivityTimestamp()).to.be.greaterThan(0);
    });
  });
});
