import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

// MockDiamond SellStatus / Diamond OrderStatus codes.
const STATUS = { PLACED: 0, ACCEPTED: 1, PAID: 2, COMPLETED: 3, CANCELLED: 4 };

/**
 * ZeroXRampDirectSettlementIntegrator (V2 candidate) — full lifecycle suite.
 *
 * Covers the CONTRIBUTING-required categories (happy paths, onOrderComplete
 * accounting, onOrderCancel reversal, per-tx/daily limits, access control,
 * completion-callback replay/reentrancy) plus the two V2 differentiators:
 *
 *  1. Fail-closed native limit enforcement — _protocolTxLimit reads
 *     IP2PUserLimits(diamond).userTxLimit(user, currency) and reverts
 *     P2PLimitsUnavailable if the facet call fails; _prepareValidation
 *     reverts P2PAccountLimitExceeded when the direction-specific limit is
 *     zero or below the requested amount. App limits can only RESTRICT the
 *     protocol limit, never widen it.
 *
 *  2. Callback binding — a PendingValidation ties account + amount +
 *     currency + direction (isSell) to the in-flight placement; validateOrder
 *     resolves proxies back to users via proxyToUser, consumes the pending
 *     entry exactly once, and rejects any mismatched tuple. A diamond that
 *     skips validation trips ValidationNotConsumed.
 *
 * Binding/misbehaving-diamond tests run against MockValidationDiamond (a
 * lean probe diamond with per-dimension overrides); everything else runs
 * against the shared MockDiamond.
 */
describe("ZeroXRampDirectSettlementIntegrator (V2)", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let user2: SignerWithAddress;
  let recipient: SignerWithAddress;
  let stranger: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let integrator: any;
  let integratorAddr: string;
  /** Factory handle used only for its interface: reverts that surface through
   *  UserProxy.execute are asserted as the specific CallFailed custom error. */
  let userProxyFactory: any;

  const USDC = (n: number | string) => ethers.parseUnits(n.toString(), 6);
  const BRL = ethers.encodeBytes32String("BRL");
  const USD = ethers.encodeBytes32String("USD");

  const PER_TX_LIMIT = USDC(600);
  const DAILY_COUNT_LIMIT = 2;
  const DAILY_VOLUME_LIMIT = USDC(1_000);
  const PROTOCOL_BUY_LIMIT = USDC(5_000);
  const PROTOCOL_SELL_LIMIT = USDC(4_000);

  const DAY = 86_400;

  async function latestTimestamp(): Promise<bigint> {
    const block = await ethers.provider.getBlock("latest");
    return BigInt(block!.timestamp);
  }

  async function currentDay(): Promise<bigint> {
    return (await latestTimestamp()) / BigInt(DAY);
  }

  /** Pin the next block to mid-day so a suite of same-"day" placements can
   *  never straddle a UTC day boundary between two consecutive blocks. */
  async function pinToMidday() {
    const now = await latestTimestamp();
    const midday = (now / BigInt(DAY) + 1n) * BigInt(DAY) + BigInt(DAY / 2);
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(midday)]);
    await ethers.provider.send("evm_mine", []);
  }

  beforeEach(async function () {
    [owner, user, user2, recipient, stranger] = await ethers.getSigners();

    userProxyFactory = await ethers.getContractFactory("UserProxy");

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
    // Fund the Diamond so BUY completion can route USDC to the recipient.
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(1_000_000));
    await mockUsdc.mint(user.address, USDC(10_000));
    await mockUsdc.mint(user2.address, USDC(10_000));

    // Grant native protocol limits (fail-closed: the default is 0/0, which
    // blocks everything — see the "protocol limit enforcement" section).
    await mockDiamond.setUserTxLimit(user.address, BRL, PROTOCOL_BUY_LIMIT, PROTOCOL_SELL_LIMIT);
    await mockDiamond.setUserTxLimit(user2.address, BRL, PROTOCOL_BUY_LIMIT, PROTOCOL_SELL_LIMIT);
  });

  async function placeCheckout(amount = USDC(100), who: SignerWithAddress = user) {
    const orderId = await mockDiamond.nextOrderId();
    const intentHash = ethers.keccak256(ethers.toUtf8Bytes(`intent:${orderId}`));
    await integrator
      .connect(who)
      .userBuyAsset(recipient.address, intentHash, amount, BRL, 1, "relay-pubkey", 0, 0);
    return { orderId, intentHash, amount };
  }

  async function placeCashout(amount = USDC(100), who: SignerWithAddress = user) {
    await mockUsdc.connect(who).approve(integratorAddr, amount);
    const orderId = await mockDiamond.nextOrderId();
    await integrator.connect(who).userStartOfframp(amount, BRL, 0, 1, 0, "user-pubkey");
    return { orderId, amount, proxy: await integrator.proxyAddress(who.address) };
  }

  // ─── constructor & views ──────────────────────────────────────────

  describe("constructor & views", function () {
    it("rejects zero diamond / usdc / owner addresses", async function () {
      const Integrator = await ethers.getContractFactory("ZeroXRampDirectSettlementIntegrator");
      const diamond = await mockDiamond.getAddress();
      const usdc = await mockUsdc.getAddress();
      await expect(
        Integrator.deploy(ethers.ZeroAddress, usdc, owner.address, 1n, 1n, 1n)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      await expect(
        Integrator.deploy(diamond, ethers.ZeroAddress, owner.address, 1n, 1n, 1n)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      await expect(
        Integrator.deploy(diamond, usdc, ethers.ZeroAddress, 1n, 1n, 1n)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    });

    it("stores constructor config and exposes the app per-tx limit via userTxLimit()", async function () {
      expect(await integrator.diamond()).to.equal(await mockDiamond.getAddress());
      expect(await integrator.usdc()).to.equal(await mockUsdc.getAddress());
      expect(await integrator.owner()).to.equal(owner.address);
      expect(await integrator.perTxUsdcLimit()).to.equal(PER_TX_LIMIT);
      expect(await integrator.dailyTxCountLimit()).to.equal(DAILY_COUNT_LIMIT);
      expect(await integrator.dailyUsdcVolumeLimit()).to.equal(DAILY_VOLUME_LIMIT);
      expect(await integrator.userTxLimit()).to.equal(PER_TX_LIMIT);
    });

    it("effectiveUserTxLimit is min(app, protocol) per direction and never widens", async function () {
      // App (600) below protocol (5000 buy / 4000 sell) → app wins.
      expect(await integrator.effectiveUserTxLimit(user.address, BRL, false)).to.equal(
        PER_TX_LIMIT
      );
      expect(await integrator.effectiveUserTxLimit(user.address, BRL, true)).to.equal(PER_TX_LIMIT);

      // App limit disabled (0) → the protocol limit rules, per direction.
      await integrator.connect(owner).setLimits(0, DAILY_COUNT_LIMIT, DAILY_VOLUME_LIMIT);
      expect(await integrator.effectiveUserTxLimit(user.address, BRL, false)).to.equal(
        PROTOCOL_BUY_LIMIT
      );
      expect(await integrator.effectiveUserTxLimit(user.address, BRL, true)).to.equal(
        PROTOCOL_SELL_LIMIT
      );

      // Protocol below app → protocol wins (the app can never widen it).
      await integrator
        .connect(owner)
        .setLimits(PER_TX_LIMIT, DAILY_COUNT_LIMIT, DAILY_VOLUME_LIMIT);
      await mockDiamond.setUserTxLimit(user.address, BRL, USDC(50), USDC(40));
      expect(await integrator.effectiveUserTxLimit(user.address, BRL, false)).to.equal(USDC(50));
      expect(await integrator.effectiveUserTxLimit(user.address, BRL, true)).to.equal(USDC(40));
    });

    it("effectiveUserTxLimit fails closed when the limits facet is unavailable", async function () {
      await mockDiamond.setUserTxLimitReverts(true);
      await expect(
        integrator.effectiveUserTxLimit(user.address, BRL, false)
      ).to.be.revertedWithCustomError(integrator, "P2PLimitsUnavailable");
    });

    it("proxyAddress is deterministic and availableOfframp mirrors the proxy USDC balance", async function () {
      const predicted = await integrator.proxyAddress(user.address);
      expect(await integrator.proxyAddress(user.address)).to.equal(predicted);
      expect(await integrator.availableOfframp(user.address)).to.equal(0n);

      await mockUsdc.mint(predicted, USDC(7));
      expect(await integrator.availableOfframp(user.address)).to.equal(USDC(7));
    });
  });

  // ─── BUY happy path (checkout) ────────────────────────────────────

  describe("BUY happy path (checkout)", function () {
    it("deploys the user proxy deterministically on first placement only", async function () {
      const predicted = await integrator.proxyAddress(user.address);
      expect(await ethers.provider.getCode(predicted)).to.equal("0x");

      await expect(
        integrator
          .connect(user)
          .userBuyAsset(recipient.address, ethers.ZeroHash, USDC(100), BRL, 1, "pk", 0, 0)
      )
        .to.emit(integrator, "UserProxyDeployed")
        .withArgs(user.address, predicted);

      expect(await ethers.provider.getCode(predicted)).to.not.equal("0x");
      expect(await integrator.proxyToUser(predicted)).to.equal(user.address);

      // Second placement re-uses the proxy silently.
      await expect(
        integrator
          .connect(user)
          .userBuyAsset(recipient.address, ethers.ZeroHash, USDC(100), BRL, 1, "pk", 0, 0)
      ).to.not.emit(integrator, "UserProxyDeployed");
    });

    it("places a B2B BUY order on the Diamond with full session bookkeeping", async function () {
      const orderId = await mockDiamond.nextOrderId();
      const intentHash = ethers.keccak256(ethers.toUtf8Bytes("intent:1"));
      const amount = USDC(150);

      await expect(
        integrator
          .connect(user)
          .userBuyAsset(recipient.address, intentHash, amount, BRL, 1, "relay-pubkey", 0, 0)
      )
        .to.emit(integrator, "ZeroXRampCheckoutOrderCreated")
        .withArgs(orderId, user.address, recipient.address, intentHash, amount, BRL);

      const order = await mockDiamond.orders(orderId);
      expect(order.integrator).to.equal(integratorAddr);
      expect(order.user).to.equal(user.address);
      expect(order.amount).to.equal(amount);
      expect(order.currency).to.equal(BRL);
      expect(order.recipientAddr).to.equal(recipient.address);

      const session = await integrator.sessions(orderId);
      expect(session.user).to.equal(user.address);
      expect(session.recipientAddr).to.equal(recipient.address);
      expect(session.intentHash).to.equal(intentHash);
      expect(session.amount).to.equal(amount);
      expect(session.kind).to.equal(1n); // SessionKind.Checkout
      expect(session.placementDay).to.equal(await currentDay());
      expect(session.fulfilled).to.equal(false);
      expect(session.cancelled).to.equal(false);
    });

    it("settles USDC directly to the deposit recipient on completion", async function () {
      const { orderId, amount } = await placeCheckout(USDC(150));

      await expect(mockDiamond.simulateOrderComplete(orderId))
        .to.emit(integrator, "ZeroXRampOrderCompleted")
        .withArgs(orderId, user.address);

      // usdcThroughIntegrator = false: USDC goes straight to the deposit
      // address; neither the proxy nor the integrator ever hold it.
      expect(await mockUsdc.balanceOf(recipient.address)).to.equal(amount);
      expect(await mockUsdc.balanceOf(await integrator.proxyAddress(user.address))).to.equal(0n);
      expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(0n);
      expect((await integrator.sessions(orderId)).fulfilled).to.equal(true);
    });

    it("records daily count + volume at placement and keeps them on completion", async function () {
      const { orderId, amount } = await placeCheckout(USDC(150));
      const day = await currentDay();

      expect(await integrator.userDailyCount(user.address, day)).to.equal(1n);
      expect(await integrator.userDailyVolume(user.address, day)).to.equal(amount);

      // Completion consumes the slot for good — only cancellation releases it.
      await mockDiamond.simulateOrderComplete(orderId);
      expect(await integrator.userDailyCount(user.address, day)).to.equal(1n);
      expect(await integrator.userDailyVolume(user.address, day)).to.equal(amount);
    });

    it("rejects a zero recipient and a zero amount", async function () {
      await expect(
        integrator
          .connect(user)
          .userBuyAsset(ethers.ZeroAddress, ethers.ZeroHash, USDC(1), BRL, 1, "pk", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      await expect(
        integrator
          .connect(user)
          .userBuyAsset(recipient.address, ethers.ZeroHash, 0, BRL, 1, "pk", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "InvalidAmount");
    });
  });

  // ─── SELL happy path (cashout) ────────────────────────────────────

  describe("SELL happy path (cashout)", function () {
    it("pulls USDC into the user proxy and places the SELL order", async function () {
      const amount = USDC(200);
      const proxy = await integrator.proxyAddress(user.address);
      const balanceBefore = await mockUsdc.balanceOf(user.address);

      await mockUsdc.connect(user).approve(integratorAddr, amount);
      const orderId = await mockDiamond.nextOrderId();
      await expect(integrator.connect(user).userStartOfframp(amount, BRL, 0, 1, 0, "user-pubkey"))
        .to.emit(integrator, "ZeroXRampCashoutStarted")
        .withArgs(orderId, user.address, proxy, amount, BRL);

      expect(await mockUsdc.balanceOf(user.address)).to.equal(balanceBefore - amount);
      expect(await mockUsdc.balanceOf(proxy)).to.equal(amount);
      expect(await integrator.activeCashout(user.address)).to.equal(true);

      const sellOrder = await mockDiamond.getSellOrder(orderId);
      expect(sellOrder.user).to.equal(proxy); // proxy is order.user on the Diamond
      expect(sellOrder.amount).to.equal(amount);
      expect(sellOrder.currency).to.equal(BRL);
      expect(sellOrder.status).to.equal(STATUS.PLACED);

      const session = await integrator.sessions(orderId);
      expect(session.user).to.equal(user.address);
      expect(session.recipientAddr).to.equal(proxy);
      expect(session.kind).to.equal(2n); // SessionKind.Cashout
    });

    it("rejects a zero amount and a second cashout while one is active", async function () {
      await expect(
        integrator.connect(user).userStartOfframp(0, BRL, 0, 1, 0, "pk")
      ).to.be.revertedWithCustomError(integrator, "InvalidAmount");

      await placeCashout(USDC(100));
      await mockUsdc.connect(user).approve(integratorAddr, USDC(100));
      await expect(
        integrator.connect(user).userStartOfframp(USDC(100), BRL, 0, 1, 0, "pk")
      ).to.be.revertedWithCustomError(integrator, "CashoutAlreadyActive");
    });

    it("delivers the encrypted Pix key with no fee shortfall (proxy fully funded)", async function () {
      const { orderId, amount, proxy } = await placeCashout(USDC(100));
      await mockDiamond.acceptSellOrder(orderId, "merchant-pubkey");

      await expect(integrator.connect(user).deliverOfframpUpi(orderId, "encrypted-pix"))
        .to.emit(integrator, "ZeroXRampCashoutPaymentDelivered")
        .withArgs(orderId, user.address, amount);

      // Diamond pulled the full principal from the proxy.
      expect(await mockUsdc.balanceOf(proxy)).to.equal(0n);
      const sellOrder = await mockDiamond.getSellOrder(orderId);
      expect(sellOrder.status).to.equal(STATUS.PAID);
      expect(sellOrder.encUpi).to.equal("encrypted-pix");
      expect((await integrator.sessions(orderId)).paymentDelivered).to.equal(true);
    });

    it("tops up the proxy from the user when the final fee exceeds the parked principal", async function () {
      const fee = USDC(5);
      const { orderId, amount, proxy } = await placeCashout(USDC(100));
      await mockDiamond.acceptSellOrder(orderId, "merchant-pubkey");
      await mockDiamond.setSellFee(fee);

      // actualUsdtAmount = principal + fee; the shortfall is pulled from the
      // user, so they must approve it.
      await mockUsdc.connect(user).approve(integratorAddr, fee);
      const userBefore = await mockUsdc.balanceOf(user.address);

      await expect(integrator.connect(user).deliverOfframpUpi(orderId, "encrypted-pix"))
        .to.emit(integrator, "ZeroXRampCashoutPaymentDelivered")
        .withArgs(orderId, user.address, amount + fee);

      expect(userBefore - (await mockUsdc.balanceOf(user.address))).to.equal(fee);
      expect(await mockUsdc.balanceOf(proxy)).to.equal(0n);
      expect((await mockDiamond.getSellOrder(orderId)).status).to.equal(STATUS.PAID);
    });

    it("falls back to the recorded principal when fee details are not ready", async function () {
      const { orderId, amount } = await placeCashout(USDC(100));
      await mockDiamond.acceptSellOrder(orderId, "merchant-pubkey");
      await mockDiamond.setAdditionalOrderDetailsFeeUnready(true);

      // actualUsdtAmount == 0 → integrator uses session.amount.
      await expect(integrator.connect(user).deliverOfframpUpi(orderId, "encrypted-pix"))
        .to.emit(integrator, "ZeroXRampCashoutPaymentDelivered")
        .withArgs(orderId, user.address, amount);
    });

    it("completes the cashout end-to-end via setSellOrderUpi + syncOfframp", async function () {
      const { orderId, proxy } = await placeCashout(USDC(100));
      await mockDiamond.acceptSellOrder(orderId, "merchant-pubkey");
      await integrator.connect(user).deliverOfframpUpi(orderId, "encrypted-pix");
      await mockDiamond.completeSellOrder(orderId);

      // syncOfframp is permissionless by design (keeper-style reconcile).
      await expect(integrator.connect(stranger).syncOfframp(orderId, STATUS.COMPLETED))
        .to.emit(integrator, "ZeroXRampOrderCompleted")
        .withArgs(orderId, user.address);

      expect(await integrator.activeCashout(user.address)).to.equal(false);
      expect((await integrator.sessions(orderId)).fulfilled).to.equal(true);
      expect(await mockUsdc.balanceOf(proxy)).to.equal(0n);
    });
  });

  // ─── deliverOfframpUpi guards ─────────────────────────────────────

  describe("deliverOfframpUpi guards", function () {
    it("rejects delivery from anyone except the cashout owner", async function () {
      const { orderId } = await placeCashout();
      await mockDiamond.acceptSellOrder(orderId, "mp");
      await expect(
        integrator.connect(stranger).deliverOfframpUpi(orderId, "x")
      ).to.be.revertedWithCustomError(integrator, "NotOrderUser");
    });

    it("rejects repeated delivery for the same cashout", async function () {
      const { orderId } = await placeCashout();
      await mockDiamond.acceptSellOrder(orderId, "mp");
      await integrator.connect(user).deliverOfframpUpi(orderId, "encrypted-pix");
      await expect(
        integrator.connect(user).deliverOfframpUpi(orderId, "again")
      ).to.be.revertedWithCustomError(integrator, "PaymentAlreadyDelivered");
    });

    it("rejects unknown order ids and BUY order ids", async function () {
      await expect(
        integrator.connect(user).deliverOfframpUpi(999, "x")
      ).to.be.revertedWithCustomError(integrator, "UnknownOrder");

      const { orderId } = await placeCheckout();
      await expect(
        integrator.connect(user).deliverOfframpUpi(orderId, "x")
      ).to.be.revertedWithCustomError(integrator, "UnknownOrder");
    });

    it("rejects delivery after the session was cancelled or fulfilled by the Diamond", async function () {
      const cancelled = await placeCashout(USDC(50));
      await mockDiamond.adminCallOnOrderCancel(integratorAddr, cancelled.orderId);
      await expect(
        integrator.connect(user).deliverOfframpUpi(cancelled.orderId, "x")
      ).to.be.revertedWithCustomError(integrator, "OrderAlreadyCancelled");

      const fulfilled = await placeCashout(USDC(50));
      await mockDiamond.adminCallOnOrderComplete(
        integratorAddr,
        fulfilled.orderId,
        user.address,
        fulfilled.amount,
        fulfilled.proxy
      );
      await expect(
        integrator.connect(user).deliverOfframpUpi(fulfilled.orderId, "x")
      ).to.be.revertedWithCustomError(integrator, "OrderAlreadyFulfilled");
    });

    it("reverts (wrapped by the proxy) when the merchant has not accepted yet", async function () {
      const { orderId } = await placeCashout();
      // Diamond's setSellOrderUpi requires ACCEPTED; the revert surfaces
      // through UserProxy.execute as CallFailed.
      await expect(
        integrator.connect(user).deliverOfframpUpi(orderId, "x")
      ).to.be.revertedWithCustomError(userProxyFactory, "CallFailed");
    });
  });

  // ─── syncOfframp reconciliation ───────────────────────────────────

  describe("syncOfframp reconciliation", function () {
    it("returns proxy USDC to the user when the cashout is cancelled before payment", async function () {
      const startingBalance = await mockUsdc.balanceOf(user.address);
      const { orderId, amount, proxy } = await placeCashout(USDC(120));
      expect(await mockUsdc.balanceOf(user.address)).to.equal(startingBalance - amount);

      await mockDiamond.cancelSellOrder(orderId);
      await expect(integrator.connect(stranger).syncOfframp(orderId, STATUS.CANCELLED))
        .to.emit(integrator, "ZeroXRampOrderCancelled")
        .withArgs(orderId, user.address);

      expect(await mockUsdc.balanceOf(proxy)).to.equal(0n);
      expect(await mockUsdc.balanceOf(user.address)).to.equal(startingBalance);
      expect(await integrator.activeCashout(user.address)).to.equal(false);
      expect((await integrator.sessions(orderId)).cancelled).to.equal(true);
    });

    it("releases the daily count + volume slot on a cancelled cashout", async function () {
      const { orderId, amount } = await placeCashout(USDC(120));
      const day = await currentDay();
      expect(await integrator.userDailyCount(user.address, day)).to.equal(1n);
      expect(await integrator.userDailyVolume(user.address, day)).to.equal(amount);

      await mockDiamond.cancelSellOrder(orderId);
      await integrator.syncOfframp(orderId, STATUS.CANCELLED);

      expect(await integrator.userDailyCount(user.address, day)).to.equal(0n);
      expect(await integrator.userDailyVolume(user.address, day)).to.equal(0n);
    });

    it("accepts currentStatus=0 as an 'unknown to caller' wildcard", async function () {
      const { orderId } = await placeCashout();
      await mockDiamond.cancelSellOrder(orderId);
      await expect(integrator.syncOfframp(orderId, 0))
        .to.emit(integrator, "ZeroXRampOrderCancelled")
        .withArgs(orderId, user.address);
    });

    it("reverts OrderNotTerminal while the Diamond order is still live", async function () {
      const { orderId } = await placeCashout();
      await expect(integrator.syncOfframp(orderId, 0)).to.be.revertedWithCustomError(
        integrator,
        "OrderNotTerminal"
      );
    });

    it("reverts OrderNotTerminal when the caller's status disagrees with the Diamond", async function () {
      const { orderId } = await placeCashout();
      await mockDiamond.acceptSellOrder(orderId, "mp");
      await integrator.connect(user).deliverOfframpUpi(orderId, "pix");
      await mockDiamond.completeSellOrder(orderId);
      await expect(integrator.syncOfframp(orderId, STATUS.CANCELLED)).to.be.revertedWithCustomError(
        integrator,
        "OrderNotTerminal"
      );
    });

    it("rejects unknown order ids and BUY order ids", async function () {
      await expect(integrator.syncOfframp(999, 0)).to.be.revertedWithCustomError(
        integrator,
        "UnknownOrder"
      );
      const { orderId } = await placeCheckout();
      await expect(integrator.syncOfframp(orderId, 0)).to.be.revertedWithCustomError(
        integrator,
        "UnknownOrder"
      );
    });

    it("is idempotent after the Diamond callback already finalised the session", async function () {
      const { orderId } = await placeCashout();
      await mockDiamond.adminCallOnOrderCancel(integratorAddr, orderId);

      // Early-return branch: no event, no revert, lock stays cleared.
      const tx = await integrator.syncOfframp(orderId, 0);
      const receipt = await tx.wait();
      expect(receipt.logs.length).to.equal(0);
      expect(await integrator.activeCashout(user.address)).to.equal(false);
    });
  });

  // ─── onOrderComplete / onOrderCancel accounting ───────────────────

  describe("onOrderComplete / onOrderCancel accounting", function () {
    it("onOrderCancel reverses a BUY: session cancelled + daily slot released", async function () {
      const { orderId, amount } = await placeCheckout(USDC(150));
      const day = await currentDay();

      await expect(mockDiamond.simulateOrderCancelled(orderId))
        .to.emit(integrator, "ZeroXRampOrderCancelled")
        .withArgs(orderId, user.address);

      const session = await integrator.sessions(orderId);
      expect(session.cancelled).to.equal(true);
      expect(session.fulfilled).to.equal(false);
      expect(await integrator.userDailyCount(user.address, day)).to.equal(0n);
      expect(await integrator.userDailyVolume(user.address, day)).to.equal(0n);
      // BUY never parks USDC on the proxy, so there is nothing to sweep.
      expect(await mockUsdc.balanceOf(await integrator.proxyAddress(user.address))).to.equal(0n);
      expect(amount).to.equal(USDC(150));
    });

    it("a cancelled BUY frees the daily-count slot for a replacement order", async function () {
      const first = await placeCheckout(USDC(100));
      await placeCheckout(USDC(100));
      await expect(placeCheckout(USDC(100))).to.be.revertedWithCustomError(
        integrator,
        "DailyTxCountExceeded"
      );

      await mockDiamond.simulateOrderCancelled(first.orderId);
      await expect(
        integrator
          .connect(user)
          .userBuyAsset(recipient.address, ethers.ZeroHash, USDC(100), BRL, 1, "pk", 0, 0)
      ).to.not.be.reverted;
    });

    it("onOrderCancel reverses a cashout: lock cleared + principal swept back to the user", async function () {
      const startingBalance = await mockUsdc.balanceOf(user.address);
      const { orderId, proxy } = await placeCashout(USDC(120));
      const day = await currentDay();

      await expect(mockDiamond.adminCallOnOrderCancel(integratorAddr, orderId))
        .to.emit(integrator, "ZeroXRampOrderCancelled")
        .withArgs(orderId, user.address);

      expect(await mockUsdc.balanceOf(proxy)).to.equal(0n);
      expect(await mockUsdc.balanceOf(user.address)).to.equal(startingBalance);
      expect(await integrator.activeCashout(user.address)).to.equal(false);
      expect(await integrator.userDailyCount(user.address, day)).to.equal(0n);
    });

    it("onOrderComplete on a cashout clears the lock and sweeps residual proxy USDC", async function () {
      const { orderId, amount, proxy } = await placeCashout(USDC(100));
      // Simulate dust left behind on the proxy (e.g. a fee rebate).
      await mockUsdc.mint(proxy, USDC(3));
      const userBefore = await mockUsdc.balanceOf(user.address);

      await expect(
        mockDiamond.adminCallOnOrderComplete(integratorAddr, orderId, user.address, amount, proxy)
      )
        .to.emit(integrator, "ZeroXRampOrderCompleted")
        .withArgs(orderId, user.address);

      // Principal (never pulled by the Diamond here) + dust both return.
      expect((await mockUsdc.balanceOf(user.address)) - userBefore).to.equal(amount + USDC(3));
      expect(await mockUsdc.balanceOf(proxy)).to.equal(0n);
      expect(await integrator.activeCashout(user.address)).to.equal(false);
    });

    it("cancelling a session after the placement day releases the placement-day slot", async function () {
      const { orderId } = await placeCheckout(USDC(100));
      const placementDay = await currentDay();

      await ethers.provider.send("evm_increaseTime", [DAY]);
      await ethers.provider.send("evm_mine", []);

      await mockDiamond.simulateOrderCancelled(orderId);
      // Released against the day the slot was consumed, not "today".
      expect(await integrator.userDailyCount(user.address, placementDay)).to.equal(0n);
      expect(await integrator.userDailyVolume(user.address, placementDay)).to.equal(0n);
    });

    it("tolerates unknown order ids without reverting (best-effort gateway contract)", async function () {
      await expect(
        mockDiamond.adminCallOnOrderComplete(integratorAddr, 999, user.address, 1n, user.address)
      ).to.not.emit(integrator, "ZeroXRampOrderCompleted");
      await expect(mockDiamond.adminCallOnOrderCancel(integratorAddr, 999)).to.not.emit(
        integrator,
        "ZeroXRampOrderCancelled"
      );
    });

    it("onOrderCancel after completion is a no-op (terminal state wins)", async function () {
      const { orderId } = await placeCheckout(USDC(100));
      const day = await currentDay();
      await mockDiamond.simulateOrderComplete(orderId);

      await expect(mockDiamond.adminCallOnOrderCancel(integratorAddr, orderId)).to.not.emit(
        integrator,
        "ZeroXRampOrderCancelled"
      );
      const session = await integrator.sessions(orderId);
      expect(session.fulfilled).to.equal(true);
      expect(session.cancelled).to.equal(false);
      // Slot NOT released — the completed order legitimately consumed it.
      expect(await integrator.userDailyCount(user.address, day)).to.equal(1n);
    });
  });

  // ─── app limits (per-tx, daily count, daily volume) ───────────────

  describe("app limits", function () {
    beforeEach(async function () {
      await pinToMidday();
    });

    it("rejects a BUY and a SELL above the app per-tx limit", async function () {
      await expect(
        integrator
          .connect(user)
          .userBuyAsset(recipient.address, ethers.ZeroHash, PER_TX_LIMIT + 1n, BRL, 1, "pk", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "PerTxLimitExceeded");

      await mockUsdc.connect(user).approve(integratorAddr, PER_TX_LIMIT + 1n);
      await expect(
        integrator.connect(user).userStartOfframp(PER_TX_LIMIT + 1n, BRL, 0, 1, 0, "pk")
      ).to.be.revertedWithCustomError(integrator, "PerTxLimitExceeded");
    });

    it("BUYs and SELLs share the same daily count budget", async function () {
      await placeCheckout(USDC(100));
      await placeCashout(USDC(100)); // count = 2 = DAILY_COUNT_LIMIT
      await expect(placeCheckout(USDC(100))).to.be.revertedWithCustomError(
        integrator,
        "DailyTxCountExceeded"
      );
    });

    it("rejects a placement that would exceed the daily volume cap", async function () {
      await placeCheckout(USDC(600));
      await expect(placeCheckout(USDC(500))).to.be.revertedWithCustomError(
        integrator,
        "DailyVolumeExceeded"
      );
      // A smaller top-up that fits still passes.
      await expect(placeCheckout(USDC(400))).to.not.be.reverted;
    });

    it("daily budgets reset on day rollover", async function () {
      await placeCheckout(USDC(100));
      await placeCheckout(USDC(100));
      await expect(placeCheckout(USDC(100))).to.be.revertedWithCustomError(
        integrator,
        "DailyTxCountExceeded"
      );

      await ethers.provider.send("evm_increaseTime", [DAY]);
      await ethers.provider.send("evm_mine", []);

      await expect(placeCheckout(USDC(100))).to.not.be.reverted;
    });

    it("zeroed app limits disable app checks but the protocol limit still binds", async function () {
      await integrator.connect(owner).setLimits(0, 0, 0);

      // Amount above every previous app cap but within the protocol limit.
      await expect(placeCheckout(USDC(2_000))).to.not.be.reverted;

      // Protocol buy limit (5000) still binds even with app limits off.
      await expect(placeCheckout(PROTOCOL_BUY_LIMIT + 1n))
        .to.be.revertedWithCustomError(integrator, "P2PAccountLimitExceeded")
        .withArgs(PROTOCOL_BUY_LIMIT + 1n, PROTOCOL_BUY_LIMIT);
    });

    it("cancel with disabled counters is a no-op release (no underflow)", async function () {
      await integrator.connect(owner).setLimits(0, 0, 0);
      const { orderId } = await placeCheckout(USDC(100));
      const day = await currentDay();
      // Counters were never incremented (validateOrder skips disabled budgets).
      expect(await integrator.userDailyCount(user.address, day)).to.equal(0n);

      await expect(mockDiamond.simulateOrderCancelled(orderId)).to.not.be.reverted;
      expect(await integrator.userDailyCount(user.address, day)).to.equal(0n);
      expect(await integrator.userDailyVolume(user.address, day)).to.equal(0n);
    });
  });

  // ─── V2: fail-closed protocol limit enforcement ───────────────────

  describe("V2 protocol limit enforcement (fail-closed)", function () {
    it("BUY reverts P2PAccountLimitExceeded when the protocol grants no buy limit", async function () {
      await mockDiamond.setUserTxLimit(user.address, BRL, 0, PROTOCOL_SELL_LIMIT);
      await expect(
        integrator
          .connect(user)
          .userBuyAsset(recipient.address, ethers.ZeroHash, USDC(10), BRL, 1, "pk", 0, 0)
      )
        .to.be.revertedWithCustomError(integrator, "P2PAccountLimitExceeded")
        .withArgs(USDC(10), 0);
    });

    it("BUY reverts when the amount exceeds the protocol buy limit (boundary exact)", async function () {
      await mockDiamond.setUserTxLimit(user.address, BRL, USDC(100), PROTOCOL_SELL_LIMIT);

      await expect(
        integrator
          .connect(user)
          .userBuyAsset(recipient.address, ethers.ZeroHash, USDC(100) + 1n, BRL, 1, "pk", 0, 0)
      )
        .to.be.revertedWithCustomError(integrator, "P2PAccountLimitExceeded")
        .withArgs(USDC(100) + 1n, USDC(100));

      // Exactly at the limit is allowed.
      await expect(
        integrator
          .connect(user)
          .userBuyAsset(recipient.address, ethers.ZeroHash, USDC(100), BRL, 1, "pk", 0, 0)
      ).to.not.be.reverted;
    });

    it("SELL reverts when the protocol sell limit is zero or below the amount", async function () {
      await mockUsdc.connect(user).approve(integratorAddr, USDC(500));

      await mockDiamond.setUserTxLimit(user.address, BRL, PROTOCOL_BUY_LIMIT, 0);
      await expect(integrator.connect(user).userStartOfframp(USDC(10), BRL, 0, 1, 0, "pk"))
        .to.be.revertedWithCustomError(integrator, "P2PAccountLimitExceeded")
        .withArgs(USDC(10), 0);

      await mockDiamond.setUserTxLimit(user.address, BRL, PROTOCOL_BUY_LIMIT, USDC(50));
      await expect(integrator.connect(user).userStartOfframp(USDC(51), BRL, 0, 1, 0, "pk"))
        .to.be.revertedWithCustomError(integrator, "P2PAccountLimitExceeded")
        .withArgs(USDC(51), USDC(50));
    });

    it("limits are direction-specific: a tight sell limit never blocks buys (and vice versa)", async function () {
      await mockDiamond.setUserTxLimit(user.address, BRL, USDC(500), USDC(10));

      // BUY of 100 uses the buy limit (500) — fine.
      await expect(
        integrator
          .connect(user)
          .userBuyAsset(recipient.address, ethers.ZeroHash, USDC(100), BRL, 1, "pk", 0, 0)
      ).to.not.be.reverted;

      // SELL of 100 uses the sell limit (10) — blocked.
      await mockUsdc.connect(user).approve(integratorAddr, USDC(100));
      await expect(
        integrator.connect(user).userStartOfframp(USDC(100), BRL, 0, 1, 0, "pk")
      ).to.be.revertedWithCustomError(integrator, "P2PAccountLimitExceeded");
    });

    it("limits are per-currency: a BRL grant does not authorise USD", async function () {
      // No USD grant was ever set → limit 0 → fail closed.
      await expect(
        integrator
          .connect(user)
          .userBuyAsset(recipient.address, ethers.ZeroHash, USDC(10), USD, 1, "pk", 0, 0)
      )
        .to.be.revertedWithCustomError(integrator, "P2PAccountLimitExceeded")
        .withArgs(USDC(10), 0);
    });

    it("reverts P2PLimitsUnavailable when the limits facet call fails (BUY + SELL)", async function () {
      await mockDiamond.setUserTxLimitReverts(true);

      await expect(
        integrator
          .connect(user)
          .userBuyAsset(recipient.address, ethers.ZeroHash, USDC(10), BRL, 1, "pk", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "P2PLimitsUnavailable");

      await mockUsdc.connect(user).approve(integratorAddr, USDC(10));
      await expect(
        integrator.connect(user).userStartOfframp(USDC(10), BRL, 0, 1, 0, "pk")
      ).to.be.revertedWithCustomError(integrator, "P2PLimitsUnavailable");
    });

    it("app limits only restrict the protocol limit — they can never widen it", async function () {
      // Protocol allows 100; the app per-tx limit (600) is wider but must
      // not unlock anything above the protocol grant.
      await mockDiamond.setUserTxLimit(user.address, BRL, USDC(100), USDC(100));
      await expect(
        integrator
          .connect(user)
          .userBuyAsset(recipient.address, ethers.ZeroHash, USDC(200), BRL, 1, "pk", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "P2PAccountLimitExceeded");

      // Even with app limits fully disabled, the protocol grant still rules.
      await integrator.connect(owner).setLimits(0, 0, 0);
      await expect(
        integrator
          .connect(user)
          .userBuyAsset(recipient.address, ethers.ZeroHash, USDC(200), BRL, 1, "pk", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "P2PAccountLimitExceeded");
    });
  });

  // ─── V2: validateOrder callback binding (probe diamond) ───────────

  describe("V2 validateOrder binding (probe diamond)", function () {
    let valDiamond: any;
    let integ2: any;
    let integ2Addr: string;

    beforeEach(async function () {
      const ValDiamond = await ethers.getContractFactory("MockValidationDiamond");
      valDiamond = await ValDiamond.deploy();

      const Integrator = await ethers.getContractFactory("ZeroXRampDirectSettlementIntegrator");
      integ2 = await Integrator.deploy(
        await valDiamond.getAddress(),
        await mockUsdc.getAddress(),
        owner.address,
        PER_TX_LIMIT,
        DAILY_COUNT_LIMIT,
        DAILY_VOLUME_LIMIT
      );
      integ2Addr = await integ2.getAddress();

      await valDiamond.setUserTxLimit(user.address, BRL, PROTOCOL_BUY_LIMIT, PROTOCOL_SELL_LIMIT);
    });

    function buyVia(amount = USDC(100)) {
      return integ2
        .connect(user)
        .userBuyAsset(recipient.address, ethers.ZeroHash, amount, BRL, 1, "pk", 0, 0);
    }

    async function sellVia(amount = USDC(100)) {
      await mockUsdc.connect(user).approve(integ2Addr, amount);
      return integ2.connect(user).userStartOfframp(amount, BRL, 0, 1, 0, "pk");
    }

    it("control: a diamond validating the exact prepared tuple is accepted (BUY + SELL)", async function () {
      await expect(buyVia()).to.emit(integ2, "ZeroXRampCheckoutOrderCreated");
      await expect(sellVia()).to.emit(integ2, "ZeroXRampCashoutStarted");
    });

    it("rejects validation with the wrong amount", async function () {
      await valDiamond.setValidateOverrides(
        false,
        false,
        ethers.ZeroAddress,
        USDC(99),
        ethers.ZeroHash
      );
      // validateOrder returns false → the diamond refuses the placement →
      // surfaces through UserProxy.execute as a wrapped CallFailed.
      await expect(buyVia(USDC(100))).to.be.revertedWithCustomError(userProxyFactory, "CallFailed");
    });

    it("rejects validation with the wrong currency", async function () {
      await valDiamond.setValidateOverrides(false, false, ethers.ZeroAddress, 0, USD);
      await expect(buyVia()).to.be.revertedWithCustomError(userProxyFactory, "CallFailed");
    });

    it("rejects validation bound to the wrong account", async function () {
      await valDiamond.setValidateOverrides(false, false, user2.address, 0, ethers.ZeroHash);
      await expect(buyVia()).to.be.revertedWithCustomError(userProxyFactory, "CallFailed");
    });

    it("rejects a direction flip: BUY prepared but SELL-shaped validation (proxy account)", async function () {
      // Passing the user's proxy makes validateOrder resolve isSell=true,
      // which must not match a pending BUY preparation.
      const proxy = await integ2.proxyAddress(user.address);
      await valDiamond.setValidateOverrides(false, false, proxy, 0, ethers.ZeroHash);
      await expect(buyVia()).to.be.revertedWithCustomError(userProxyFactory, "CallFailed");
    });

    it("rejects a direction flip: SELL prepared but BUY-shaped validation (EOA account)", async function () {
      // A SELL must be validated via the mapped proxy; the raw EOA resolves
      // isSell=false and must not match the pending SELL preparation.
      await valDiamond.setValidateOverrides(false, false, user.address, 0, ethers.ZeroHash);
      await expect(sellVia()).to.be.revertedWithCustomError(userProxyFactory, "CallFailed");
    });

    it("rejects a SELL validated through an unmapped proxy address", async function () {
      // user2's proxy address was never deployed/mapped by integ2, so
      // proxyToUser resolves to zero and no pending entry can match.
      const unmapped = await integ2.proxyAddress(user2.address);
      await valDiamond.setValidateOverrides(false, false, unmapped, 0, ethers.ZeroHash);
      await expect(sellVia()).to.be.revertedWithCustomError(userProxyFactory, "CallFailed");
    });

    it("returns false with no prepared PendingValidation, a zero account, or a zero amount", async function () {
      expect(
        await valDiamond.probeValidate.staticCall(integ2Addr, user.address, USDC(100), BRL)
      ).to.equal(false);
      expect(
        await valDiamond.probeValidate.staticCall(integ2Addr, ethers.ZeroAddress, USDC(100), BRL)
      ).to.equal(false);
      expect(await valDiamond.probeValidate.staticCall(integ2Addr, user.address, 0, BRL)).to.equal(
        false
      );
    });

    it("a preparation is single-use: the second consume in the same placement fails", async function () {
      await valDiamond.setValidateOverrides(false, true, ethers.ZeroAddress, 0, ethers.ZeroHash);
      await expect(buyVia()).to.be.revertedWithCustomError(userProxyFactory, "CallFailed");
    });

    it("a consumed preparation cannot be replayed after the placement", async function () {
      await buyVia(USDC(100));
      expect(
        await valDiamond.probeValidate.staticCall(integ2Addr, user.address, USDC(100), BRL)
      ).to.equal(false);
    });

    it("fails closed when the diamond skips validateOrder entirely", async function () {
      await valDiamond.setValidateOverrides(true, false, ethers.ZeroAddress, 0, ethers.ZeroHash);
      await expect(buyVia()).to.be.revertedWithCustomError(integ2, "ValidationNotConsumed");
      await expect(sellVia()).to.be.revertedWithCustomError(integ2, "ValidationNotConsumed");
    });

    it("refuses to stack a second preparation while one is in flight (PendingValidationExists)", async function () {
      const Reentrant = await ethers.getContractFactory("ReentrantRampUser");
      const reentrant = await Reentrant.deploy();
      const reentrantAddr = await reentrant.getAddress();

      await valDiamond.setUserTxLimit(reentrantAddr, BRL, PROTOCOL_BUY_LIMIT, 0);
      await valDiamond.setReentrancyProbes(reentrantAddr, false);

      // The outer BUY succeeds; the nested attempt is captured by the caller.
      await reentrant.buy(integ2Addr, recipient.address, USDC(100), BRL);
      expect(await reentrant.reentered()).to.equal(true);
      expect(await reentrant.capturedReentryRevert()).to.equal(
        ethers.id("PendingValidationExists()").slice(0, 10)
      );
    });

    it("the proxy's reentrancy guard holds during the 0xramp placement path", async function () {
      await valDiamond.setReentrancyProbes(ethers.ZeroAddress, true);
      await buyVia();
      // The diamond's nested UserProxy.execute attempt hit the transient
      // guard before any authorization logic ran.
      expect(await valDiamond.capturedProxyRevert()).to.equal(
        ethers.id("Reentrancy()").slice(0, 10)
      );
    });
  });

  // ─── replay & reentrancy of completion callbacks ──────────────────

  describe("completion callback replay & reentrancy", function () {
    it("replaying onOrderComplete across transactions duplicates nothing", async function () {
      const { orderId, amount } = await placeCheckout(USDC(100));
      await mockDiamond.simulateOrderComplete(orderId);
      const recipientAfterFirst = await mockUsdc.balanceOf(recipient.address);

      await expect(
        mockDiamond.adminCallOnOrderComplete(
          integratorAddr,
          orderId,
          user.address,
          amount,
          recipient.address
        )
      ).to.not.emit(integrator, "ZeroXRampOrderCompleted");

      expect(await mockUsdc.balanceOf(recipient.address)).to.equal(recipientAfterFirst);
      expect((await integrator.sessions(orderId)).fulfilled).to.equal(true);
    });

    it("replaying onOrderCancel across transactions releases the daily slot only once", async function () {
      const a = await placeCheckout(USDC(100));
      await placeCheckout(USDC(100));
      const day = await currentDay();
      expect(await integrator.userDailyCount(user.address, day)).to.equal(2n);

      await mockDiamond.simulateOrderCancelled(a.orderId);
      expect(await integrator.userDailyCount(user.address, day)).to.equal(1n);

      await expect(mockDiamond.adminCallOnOrderCancel(integratorAddr, a.orderId)).to.not.emit(
        integrator,
        "ZeroXRampOrderCancelled"
      );
      expect(await integrator.userDailyCount(user.address, day)).to.equal(1n);
      expect(await integrator.userDailyVolume(user.address, day)).to.equal(USDC(100));
    });

    it("a same-transaction double onOrderComplete sweeps the cashout exactly once", async function () {
      // Probe diamond so the double-call happens inside ONE transaction —
      // the tightest replay/reentrancy window for the completion callback.
      const ValDiamond = await ethers.getContractFactory("MockValidationDiamond");
      const valDiamond = await ValDiamond.deploy();
      const Integrator = await ethers.getContractFactory("ZeroXRampDirectSettlementIntegrator");
      const integ2 = await Integrator.deploy(
        await valDiamond.getAddress(),
        await mockUsdc.getAddress(),
        owner.address,
        PER_TX_LIMIT,
        DAILY_COUNT_LIMIT,
        DAILY_VOLUME_LIMIT
      );
      const integ2Addr = await integ2.getAddress();
      await valDiamond.setUserTxLimit(user.address, BRL, PROTOCOL_BUY_LIMIT, PROTOCOL_SELL_LIMIT);

      const amount = USDC(100);
      await mockUsdc.connect(user).approve(integ2Addr, amount);
      const orderId = await valDiamond.nextOrderId();
      await integ2.connect(user).userStartOfframp(amount, BRL, 0, 1, 0, "pk");
      const proxy = await integ2.proxyAddress(user.address);
      expect(await mockUsdc.balanceOf(proxy)).to.equal(amount);
      const userBefore = await mockUsdc.balanceOf(user.address);

      const tx = await valDiamond.callOnOrderCompleteTwice(
        integ2Addr,
        orderId,
        user.address,
        amount,
        proxy
      );
      const receipt = await tx.wait();
      const completedEvents = receipt.logs
        .filter((l: any) => l.address === integ2Addr)
        .map((l: any) => integ2.interface.parseLog(l))
        .filter((e: any) => e?.name === "ZeroXRampOrderCompleted");
      expect(completedEvents.length).to.equal(1);

      // Swept once: exactly the parked principal came back, no double credit.
      expect((await mockUsdc.balanceOf(user.address)) - userBefore).to.equal(amount);
      expect(await mockUsdc.balanceOf(proxy)).to.equal(0n);
      expect(await integ2.activeCashout(user.address)).to.equal(false);
    });
  });

  // ─── access control ───────────────────────────────────────────────

  describe("access control", function () {
    it("setLimits is owner-gated and emits on success", async function () {
      await expect(
        integrator.connect(stranger).setLimits(USDC(50), 1, USDC(100))
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");

      await expect(integrator.connect(owner).setLimits(USDC(50), 1, USDC(100)))
        .to.emit(integrator, "LimitsUpdated")
        .withArgs(USDC(50), 1, USDC(100));

      expect(await integrator.perTxUsdcLimit()).to.equal(USDC(50));
      expect(await integrator.dailyTxCountLimit()).to.equal(1n);
      expect(await integrator.dailyUsdcVolumeLimit()).to.equal(USDC(100));
    });

    it("validateOrder / onOrderComplete / onOrderCancel reject any non-Diamond caller", async function () {
      await expect(
        integrator.connect(stranger).validateOrder(user.address, USDC(10), BRL)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
      await expect(
        integrator.connect(stranger).onOrderComplete(1, user.address, USDC(10), user.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
      await expect(integrator.connect(stranger).onOrderCancel(1)).to.be.revertedWithCustomError(
        integrator,
        "OnlyDiamond"
      );

      // Even the owner is not the Diamond — strict privilege separation.
      await expect(
        integrator.connect(owner).validateOrder(user.address, USDC(10), BRL)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
      await expect(integrator.connect(owner).onOrderCancel(1)).to.be.revertedWithCustomError(
        integrator,
        "OnlyDiamond"
      );
    });
  });

  // ─── documented current-behavior quirks ───────────────────────────

  describe("documented current-behavior quirks", function () {
    it("KNOWN ISSUE: deliverOfframpUpi trusts setSellOrderUpi's success and marks paymentDelivered even when the Diamond auto-cancelled", async function () {
      // The live Diamond's setSellOrderUpi wraps its USDC pull in try/catch
      // and, on failure, auto-cancels the order and RETURNS SUCCESS (repo
      // audit #3). Peer integrators re-read the order status afterwards
      // (audit #2); this V2 candidate does not, so it records
      // paymentDelivered=true and emits ZeroXRampCashoutPaymentDelivered for
      // an order that is actually CANCELLED. Funds are not lost — the
      // principal stays on the proxy and syncOfframp recovers it — but the
      // event/flag are false signals. Test documents CURRENT behavior.
      const startingBalance = await mockUsdc.balanceOf(user.address);
      const { orderId, amount, proxy } = await placeCashout(USDC(100));
      await mockDiamond.acceptSellOrder(orderId, "mp");
      await mockDiamond.setForceSellUpiAutoCancel(true);

      await expect(integrator.connect(user).deliverOfframpUpi(orderId, "pix"))
        .to.emit(integrator, "ZeroXRampCashoutPaymentDelivered")
        .withArgs(orderId, user.address, amount);

      // Diamond side: CANCELLED; integrator side: paymentDelivered=true.
      expect((await mockDiamond.getSellOrder(orderId)).status).to.equal(STATUS.CANCELLED);
      expect((await integrator.sessions(orderId)).paymentDelivered).to.equal(true);

      // Recovery path still works: syncOfframp returns the principal.
      await integrator.syncOfframp(orderId, STATUS.CANCELLED);
      expect(await mockUsdc.balanceOf(proxy)).to.equal(0n);
      expect(await mockUsdc.balanceOf(user.address)).to.equal(startingBalance);
    });

    it("KNOWN ISSUE: syncOfframp on an already-final session clears the cashout lock of an unrelated in-flight cashout", async function () {
      // syncOfframp's early-return branch sets activeCashout[user] = false
      // unconditionally. Because syncOfframp is permissionless, anyone can
      // replay it on an old finalized order to unlock a user's CURRENT
      // cashout single-flight lock, breaking the CashoutAlreadyActive
      // invariant. Test documents CURRENT behavior.
      // Widen the daily count budget so only the cashout lock is in play.
      await integrator.connect(owner).setLimits(PER_TX_LIMIT, 10, DAILY_VOLUME_LIMIT);
      const a = await placeCashout(USDC(50));
      await mockDiamond.acceptSellOrder(a.orderId, "mp");
      await integrator.connect(user).deliverOfframpUpi(a.orderId, "pix");
      await mockDiamond.completeSellOrder(a.orderId);
      await integrator.syncOfframp(a.orderId, STATUS.COMPLETED); // A finalized

      await placeCashout(USDC(50)); // cashout B in flight
      expect(await integrator.activeCashout(user.address)).to.equal(true);

      // Replaying the finalized A clears B's lock...
      await integrator.connect(stranger).syncOfframp(a.orderId, 0);
      expect(await integrator.activeCashout(user.address)).to.equal(false);

      // ...so a THIRD concurrent cashout sails past CashoutAlreadyActive.
      await mockUsdc.connect(user).approve(integratorAddr, USDC(50));
      await expect(integrator.connect(user).userStartOfframp(USDC(50), BRL, 0, 1, 0, "pk")).to.not
        .be.reverted;
    });
  });
});
