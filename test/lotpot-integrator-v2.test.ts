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
});
