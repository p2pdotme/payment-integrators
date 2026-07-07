import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("ZeroXRampDirectSettlementIntegrator", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let recipient: SignerWithAddress;
  let stranger: SignerWithAddress;
  let mockUsdc: any;
  let mockDiamond: any;
  let integrator: any;
  let integratorAddr: string;

  const USDC = (n: number | string) => ethers.parseUnits(n.toString(), 6);
  const BRL = ethers.encodeBytes32String("BRL");
  const PER_TX_LIMIT = USDC(600);
  const DAILY_COUNT_LIMIT = 2;
  const DAILY_VOLUME_LIMIT = USDC(1_000);

  beforeEach(async function () {
    [owner, user, recipient, stranger] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUsdc = await MockUSDC.deploy();

    const MockDiamond = await ethers.getContractFactory("MockDiamond");
    mockDiamond = await MockDiamond.deploy(await mockUsdc.getAddress());

    const Integrator = await ethers.getContractFactory("ZeroXRampDirectSettlementIntegrator");
    integrator = await Integrator.deploy(
      await mockDiamond.getAddress(),
      await mockUsdc.getAddress(),
      owner.address,
      PER_TX_LIMIT,
      DAILY_COUNT_LIMIT,
      DAILY_VOLUME_LIMIT
    );
    integratorAddr = await integrator.getAddress();

    await mockDiamond.registerIntegrator(integratorAddr, await integrator.proxyImpl());
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(1_000_000));
    await mockUsdc.mint(user.address, USDC(10_000));
  });

  async function placeCheckout(amount = USDC(100)) {
    const orderId = await mockDiamond.nextOrderId();
    const intentHash = ethers.keccak256(ethers.toUtf8Bytes(`intent:${orderId}`));

    await expect(
      integrator
        .connect(user)
        .userBuyAsset(recipient.address, intentHash, amount, BRL, 1, "relay-pubkey", 0, 0)
    )
      .to.emit(integrator, "ZeroXRampCheckoutOrderCreated")
      .withArgs(orderId, user.address, recipient.address, intentHash, amount, BRL);

    return { orderId, intentHash, amount };
  }

  async function placeCashout(amount = USDC(100)) {
    await mockUsdc.connect(user).approve(integratorAddr, amount);
    const orderId = await mockDiamond.nextOrderId();

    await expect(integrator.connect(user).userStartOfframp(amount, BRL, 0, 1, 0, "user-pubkey"))
      .to.emit(integrator, "ZeroXRampCashoutStarted")
      .withArgs(orderId, user.address, await integrator.proxyAddress(user.address), amount, BRL);

    return { orderId, amount, proxy: await integrator.proxyAddress(user.address) };
  }

  it("places a checkout order and settles USDC directly to the NEAR deposit recipient", async function () {
    const { orderId, intentHash, amount } = await placeCheckout();

    const session = await integrator.sessions(orderId);
    expect(session.user).to.equal(user.address);
    expect(session.recipientAddr).to.equal(recipient.address);
    expect(session.intentHash).to.equal(intentHash);
    expect(session.amount).to.equal(amount);

    await expect(mockDiamond.simulateOrderComplete(orderId))
      .to.emit(integrator, "ZeroXRampOrderCompleted")
      .withArgs(orderId, user.address);

    expect(await mockUsdc.balanceOf(recipient.address)).to.equal(amount);
    expect(await mockUsdc.balanceOf(await integrator.proxyAddress(user.address))).to.equal(0n);
  });

  it("blocks checkout above the configured per-transaction limit", async function () {
    await expect(
      integrator
        .connect(user)
        .userBuyAsset(recipient.address, ethers.ZeroHash, PER_TX_LIMIT + 1n, BRL, 1, "", 0, 0)
    ).to.be.revertedWithCustomError(integrator, "PerTxLimitExceeded");
  });

  it("uses the configured owner address for admin limit updates", async function () {
    await expect(
      integrator.connect(stranger).setLimits(USDC(50), 1, USDC(100))
    ).to.be.revertedWithCustomError(integrator, "OnlyOwner");

    await expect(integrator.connect(owner).setLimits(USDC(50), 1, USDC(100)))
      .to.emit(integrator, "LimitsUpdated")
      .withArgs(USDC(50), 1, USDC(100));

    expect(await integrator.perTxUsdcLimit()).to.equal(USDC(50));
    expect(await integrator.dailyTxCountLimit()).to.equal(1);
    expect(await integrator.dailyUsdcVolumeLimit()).to.equal(USDC(100));
  });

  it("releases a daily slot when a checkout order is cancelled", async function () {
    const first = await placeCheckout(USDC(100));
    const second = await placeCheckout(USDC(100));

    await expect(
      integrator
        .connect(user)
        .userBuyAsset(recipient.address, ethers.ZeroHash, USDC(100), BRL, 1, "", 0, 0)
    ).to.be.revertedWithCustomError(integrator, "DailyTxCountExceeded");

    await mockDiamond.simulateOrderCancelled(first.orderId);

    const replacement = await placeCheckout(USDC(100));
    expect(replacement.orderId).to.equal(second.orderId + 1n);
  });

  it("places a cashout order, delivers encrypted Pix details, and reconciles completion", async function () {
    const { orderId, amount, proxy } = await placeCashout();

    expect(await mockUsdc.balanceOf(proxy)).to.equal(amount);
    expect(await integrator.activeCashout(user.address)).to.equal(true);

    const sellOrder = await mockDiamond.getSellOrder(orderId);
    expect(sellOrder.user).to.equal(proxy);
    expect(sellOrder.amount).to.equal(amount);

    await mockDiamond.acceptSellOrder(orderId, "merchant-pubkey");
    await expect(integrator.connect(user).deliverOfframpUpi(orderId, "encrypted-pix"))
      .to.emit(integrator, "ZeroXRampCashoutPaymentDelivered")
      .withArgs(orderId, user.address, amount);

    expect(await mockUsdc.balanceOf(proxy)).to.equal(0n);
    expect((await mockDiamond.getSellOrder(orderId)).status).to.equal(2);

    await mockDiamond.completeSellOrder(orderId);
    await expect(integrator.connect(stranger).syncOfframp(orderId, 3))
      .to.emit(integrator, "ZeroXRampOrderCompleted")
      .withArgs(orderId, user.address);
    expect(await integrator.activeCashout(user.address)).to.equal(false);
  });

  it("returns proxy USDC to the user when a cashout is cancelled before payment", async function () {
    const startingBalance = await mockUsdc.balanceOf(user.address);
    const { orderId, amount, proxy } = await placeCashout();
    expect(await mockUsdc.balanceOf(user.address)).to.equal(startingBalance - amount);

    await mockDiamond.cancelSellOrder(orderId);
    await expect(integrator.connect(stranger).syncOfframp(orderId, 4))
      .to.emit(integrator, "ZeroXRampOrderCancelled")
      .withArgs(orderId, user.address);

    expect(await mockUsdc.balanceOf(proxy)).to.equal(0n);
    expect(await mockUsdc.balanceOf(user.address)).to.equal(startingBalance);
    expect(await integrator.activeCashout(user.address)).to.equal(false);
  });

  it("rejects encrypted Pix delivery from anyone except the cashout owner", async function () {
    const { orderId } = await placeCashout();
    await mockDiamond.acceptSellOrder(orderId, "merchant-pubkey");

    await expect(
      integrator.connect(stranger).deliverOfframpUpi(orderId, "encrypted-pix")
    ).to.be.revertedWithCustomError(integrator, "NotOrderUser");
  });

  it("rejects repeated encrypted Pix delivery for the same cashout", async function () {
    const { orderId } = await placeCashout();
    await mockDiamond.acceptSellOrder(orderId, "merchant-pubkey");

    await integrator.connect(user).deliverOfframpUpi(orderId, "encrypted-pix");

    await expect(
      integrator.connect(user).deliverOfframpUpi(orderId, "encrypted-pix-again")
    ).to.be.revertedWithCustomError(integrator, "PaymentAlreadyDelivered");
  });
});
