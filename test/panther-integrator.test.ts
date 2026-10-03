import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * PantherBuyUsdcIntegrator: server-driven onramp for a custodial wallet. The
 * operator places / marks paid / cancels on behalf of keyless per-account
 * pseudo users; every order settles straight into Panther's treasury.
 */
describe("PantherBuyUsdcIntegrator", function () {
  let owner: SignerWithAddress;
  let operator: SignerWithAddress;
  let treasury: SignerWithAddress;
  let stranger: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let integrator: any;
  let integratorAddr: string;
  let diamondAddr: string;

  const USDC = (n: number | string) => ethers.parseUnits(n.toString(), 6);
  const COP = ethers.encodeBytes32String("COP");
  const PER_TX = USDC(50);
  const DAILY_COUNT = 10;
  const CUENTA = ethers.keccak256(ethers.toUtf8Bytes("panther:cuenta:1"));
  const CUENTA2 = ethers.keccak256(ethers.toUtf8Bytes("panther:cuenta:2"));

  async function deploy(volumeCap: bigint = 0n) {
    const Integrator = await ethers.getContractFactory("PantherBuyUsdcIntegrator");
    return Integrator.connect(owner).deploy(
      diamondAddr,
      await mockUsdc.getAddress(),
      treasury.address,
      operator.address,
      PER_TX,
      DAILY_COUNT,
      volumeCap
    );
  }

  async function place(cuenta = CUENTA, amount = USDC(10), from = operator): Promise<bigint> {
    const orderId = await mockDiamond.nextOrderId();
    await integrator.connect(from).operatorPlaceOrder(cuenta, amount, COP, 1, "pubkey", 0, 0);
    return orderId;
  }

  async function impersonateDiamond(): Promise<SignerWithAddress> {
    await ethers.provider.send("hardhat_setBalance", [
      diamondAddr,
      "0x" + ethers.parseEther("10").toString(16),
    ]);
    return ethers.getImpersonatedSigner(diamondAddr);
  }

  async function nextDay() {
    await ethers.provider.send("evm_increaseTime", [86_400]);
    await ethers.provider.send("evm_mine", []);
  }

  beforeEach(async function () {
    [owner, operator, treasury, stranger] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUsdc = await MockUSDC.deploy();
    const MockDiamond = await ethers.getContractFactory("MockDiamond");
    mockDiamond = await MockDiamond.deploy(await mockUsdc.getAddress());
    diamondAddr = await mockDiamond.getAddress();

    integrator = await deploy();
    integratorAddr = await integrator.getAddress();

    await mockDiamond.registerIntegrator(integratorAddr, await integrator.proxyImpl());
    await mockUsdc.mint(diamondAddr, USDC(1_000_000));
  });

  // ─── Construction ───────────────────────────────────────────────────

  describe("constructor", function () {
    it("pins immutables and initial limits", async function () {
      expect(await integrator.owner()).to.equal(owner.address);
      expect(await integrator.diamond()).to.equal(diamondAddr);
      expect(await integrator.usdc()).to.equal(await mockUsdc.getAddress());
      expect(await integrator.treasury()).to.equal(treasury.address);
      expect(await integrator.operator()).to.equal(operator.address);
      expect(await integrator.perTxCap()).to.equal(PER_TX);
      expect(await integrator.dailyTxCountLimit()).to.equal(DAILY_COUNT);
      expect(await integrator.dailyVolumeCap()).to.equal(0);
      expect(await integrator.paused()).to.equal(false);
      expect(await ethers.provider.getCode(await integrator.proxyImpl())).to.not.equal("0x");
    });

    it("rejects zero / colliding addresses and out-of-range limits", async function () {
      const F = await ethers.getContractFactory("PantherBuyUsdcIntegrator");
      const usdc = await mockUsdc.getAddress();
      const Z = ethers.ZeroAddress;
      await expect(
        F.deploy(Z, usdc, treasury.address, operator.address, PER_TX, 10, 0)
      ).to.be.revertedWithCustomError(F, "InvalidAddress");
      await expect(
        F.deploy(diamondAddr, Z, treasury.address, operator.address, PER_TX, 10, 0)
      ).to.be.revertedWithCustomError(F, "InvalidAddress");
      await expect(
        F.deploy(diamondAddr, usdc, Z, operator.address, PER_TX, 10, 0)
      ).to.be.revertedWithCustomError(F, "InvalidAddress");
      await expect(
        F.deploy(diamondAddr, usdc, diamondAddr, operator.address, PER_TX, 10, 0)
      ).to.be.revertedWithCustomError(F, "InvalidAddress");
      await expect(
        F.deploy(diamondAddr, usdc, treasury.address, operator.address, 0, 10, 0)
      ).to.be.revertedWithCustomError(F, "InvalidLimit");
      await expect(
        F.deploy(diamondAddr, usdc, treasury.address, operator.address, USDC(501), 10, 0)
      ).to.be.revertedWithCustomError(F, "CapExceedsCeiling");
      await expect(
        F.deploy(diamondAddr, usdc, treasury.address, operator.address, PER_TX, 0, 0)
      ).to.be.revertedWithCustomError(F, "InvalidLimit");
      await expect(
        F.deploy(diamondAddr, usdc, treasury.address, operator.address, PER_TX, 51, 0)
      ).to.be.revertedWithCustomError(F, "CapExceedsCeiling");
      await expect(
        F.deploy(diamondAddr, usdc, treasury.address, operator.address, PER_TX, 10, USDC(5001))
      ).to.be.revertedWithCustomError(F, "CapExceedsCeiling");
    });
  });

  // ─── Identity ───────────────────────────────────────────────────────

  describe("pseudo users and proxies", function () {
    it("derives usuarioDe(cuenta) as specified", async function () {
      const expected = ethers.getAddress(
        "0x" +
          ethers
            .keccak256(ethers.solidityPacked(["string", "bytes32"], ["panther.p2pkit", CUENTA]))
            .slice(-40)
      );
      expect(await integrator.usuarioDe(CUENTA)).to.equal(expected);
      expect(await integrator.usuarioDe(CUENTA2)).to.not.equal(expected);
    });

    it("deploys the canonical UserProxy once per cuenta and maps it back", async function () {
      const user = await integrator.usuarioDe(CUENTA);
      const proxy = await integrator.proxyDe(CUENTA);
      expect(await ethers.provider.getCode(proxy)).to.equal("0x");

      await expect(
        integrator.connect(operator).operatorPlaceOrder(CUENTA, USDC(10), COP, 1, "pk", 0, 0)
      )
        .to.emit(integrator, "UserProxyDeployed")
        .withArgs(CUENTA, user, proxy);

      const p = await ethers.getContractAt("UserProxy", proxy);
      expect(await p.owner()).to.equal(user);
      expect(await p.integrator()).to.equal(integratorAddr);
      expect(await integrator.proxyCuenta(proxy)).to.equal(CUENTA);

      // Second order reuses the proxy (no new deploy event).
      await expect(
        integrator.connect(operator).operatorPlaceOrder(CUENTA, USDC(10), COP, 1, "pk", 0, 0)
      ).to.not.emit(integrator, "UserProxyDeployed");
    });
  });

  // ─── Placement ──────────────────────────────────────────────────────

  describe("operatorPlaceOrder", function () {
    it("places with order.user = proxy and recipientAddr = treasury", async function () {
      const orderId = await mockDiamond.nextOrderId();
      const proxy = await integrator.proxyDe(CUENTA);
      const tx = integrator
        .connect(operator)
        .operatorPlaceOrder(CUENTA, USDC(10), COP, 1, "pubkey", 0, 0);
      await expect(tx)
        .to.emit(integrator, "PantherOrderPlaced")
        .withArgs(orderId, CUENTA, USDC(10), COP);
      await expect(tx)
        .to.emit(integrator, "CheckoutOrderCreated")
        .withArgs(orderId, proxy, CUENTA, 1, USDC(10));

      const order = await mockDiamond.orders(orderId);
      expect(order.integrator).to.equal(integratorAddr);
      expect(order.user).to.equal(proxy);
      expect(order.recipientAddr).to.equal(treasury.address);
      expect(order.amount).to.equal(USDC(10));
      expect(order.currency).to.equal(COP);

      const s = await integrator.getSession(orderId);
      expect(s.cuenta).to.equal(CUENTA);
      expect(s.amount).to.equal(USDC(10));
      expect(s.fulfilled).to.equal(false);
      expect(s.cancelled).to.equal(false);
      expect(s.paid).to.equal(false);
    });

    it("returns the Diamond's order id", async function () {
      const expected = await mockDiamond.nextOrderId();
      const got = await integrator
        .connect(operator)
        .operatorPlaceOrder.staticCall(CUENTA, USDC(10), COP, 1, "pk", 0, 0);
      expect(got).to.equal(expected);
      await place();
      await mockDiamond.setForceOrderId(777);
      const forced = await integrator
        .connect(operator)
        .operatorPlaceOrder.staticCall(CUENTA, USDC(10), COP, 1, "pk", 0, 0);
      expect(forced).to.equal(777);
    });

    it("only the operator can place", async function () {
      for (const who of [owner, stranger, treasury]) {
        await expect(
          integrator.connect(who).operatorPlaceOrder(CUENTA, USDC(10), COP, 1, "pk", 0, 0)
        ).to.be.revertedWithCustomError(integrator, "OnlyOperator");
      }
    });

    it("rejects zero cuenta, zero amount and oversized pubKey", async function () {
      await expect(
        integrator
          .connect(operator)
          .operatorPlaceOrder(ethers.ZeroHash, USDC(10), COP, 1, "pk", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "InvalidCuenta");
      await expect(
        integrator.connect(operator).operatorPlaceOrder(CUENTA, 0, COP, 1, "pk", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "InvalidAmount");
      await expect(
        integrator
          .connect(operator)
          .operatorPlaceOrder(CUENTA, USDC(1), COP, 1, "a".repeat(257), 0, 0)
      ).to.be.revertedWithCustomError(integrator, "FieldTooLong");
      // exactly at the cap is fine
      await integrator
        .connect(operator)
        .operatorPlaceOrder(CUENTA, USDC(1), COP, 1, "a".repeat(256), 0, 0);
    });

    it("enforces the per-tx cap", async function () {
      await place(CUENTA, PER_TX); // at the cap
      await expect(place(CUENTA, PER_TX + 1n)).to.be.revertedWithCustomError(
        integrator,
        "PerTxCapExceeded"
      );
    });

    it("enforces the daily count per cuenta, independently per cuenta", async function () {
      for (let i = 0; i < DAILY_COUNT; i++) await place();
      expect(await integrator.getRemainingDailyCount(CUENTA)).to.equal(0);
      await expect(place()).to.be.revertedWithCustomError(integrator, "DailyCountLimitExceeded");
      await place(CUENTA2); // other account unaffected
      await nextDay();
      expect(await integrator.getRemainingDailyCount(CUENTA)).to.equal(DAILY_COUNT);
      await place();
    });

    it("enforces the optional daily volume cap", async function () {
      integrator = await deploy(USDC(100));
      integratorAddr = await integrator.getAddress();
      await mockDiamond.registerIntegrator(integratorAddr, await integrator.proxyImpl());

      await place(CUENTA, USDC(50));
      await place(CUENTA, USDC(40));
      expect(await integrator.getTodayVolume(CUENTA)).to.equal(USDC(90));
      await expect(place(CUENTA, USDC(11))).to.be.revertedWithCustomError(
        integrator,
        "DailyVolumeExceeded"
      );
      await place(CUENTA, USDC(10)); // exactly reaches the cap
      await place(CUENTA2, USDC(50));
    });

    it("tracks volume even with the cap off, so enabling it mid-day is exact", async function () {
      await place(CUENTA, USDC(50));
      await place(CUENTA, USDC(50));
      await integrator.connect(owner).setDailyVolumeCap(USDC(120));
      await expect(place(CUENTA, USDC(21))).to.be.revertedWithCustomError(
        integrator,
        "DailyVolumeExceeded"
      );
      await place(CUENTA, USDC(20));
    });

    it("is blocked while paused", async function () {
      await integrator.connect(owner).pause();
      await expect(place()).to.be.revertedWithCustomError(integrator, "ContractPaused");
      await integrator.connect(owner).unpause();
      await place();
    });
  });

  // ─── validateOrder (the authoritative gate) ─────────────────────────

  describe("validateOrder", function () {
    it("is onlyDiamond", async function () {
      await expect(
        integrator.connect(stranger).validateOrder(stranger.address, USDC(1), COP)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
    });

    it("rejects with no placement in flight, including for an unknown proxy", async function () {
      await place(); // proxy now exists and is mapped
      const d = await impersonateDiamond();
      const proxy = await integrator.proxyDe(CUENTA);
      expect(await integrator.connect(d).validateOrder.staticCall(proxy, USDC(1), COP)).to.equal(
        false
      );
      expect(
        await integrator.connect(d).validateOrder.staticCall(stranger.address, USDC(1), COP)
      ).to.equal(false);
    });

    it("rejects a tampered amount (placement unwinds, nothing recorded)", async function () {
      await mockDiamond.setTamperValidationAmount(true);
      await expect(place()).to.be.reverted;
      expect(await integrator.getRemainingDailyCount(CUENTA)).to.equal(DAILY_COUNT);
      expect(await integrator.getTodayVolume(CUENTA)).to.equal(0);
    });

    it("unwinds if the Diamond skipped validation", async function () {
      await mockDiamond.setSkipValidation(true);
      await expect(place()).to.be.revertedWithCustomError(integrator, "OrderValidationMissing");
      expect(await integrator.getRemainingDailyCount(CUENTA)).to.equal(DAILY_COUNT);
    });

    it("consumes exactly one slot when called twice in one placement", async function () {
      await mockDiamond.setDoubleValidate(true);
      await place();
      expect(await integrator.getRemainingDailyCount(CUENTA)).to.equal(DAILY_COUNT - 1);
      expect(await integrator.getTodayVolume(CUENTA)).to.equal(USDC(10));
    });

    it("refuses a reused order id", async function () {
      const first = await place();
      await mockDiamond.setForceOrderId(first);
      await expect(place(CUENTA, USDC(20))).to.be.revertedWithCustomError(
        integrator,
        "OrderIdAlreadyUsed"
      );
      expect((await integrator.getSession(first)).amount).to.equal(USDC(10));
    });
  });

  // ─── Mark paid ──────────────────────────────────────────────────────

  describe("operatorMarkPaid", function () {
    it("forwards paidBuyOrder through the proxy (order.user)", async function () {
      const orderId = await place();
      await mockDiamond.simulateOrderAccepted(orderId);
      const proxy = await integrator.proxyDe(CUENTA);
      await expect(integrator.connect(operator).operatorMarkPaid(orderId))
        .to.emit(integrator, "PantherOrderPaid")
        .withArgs(orderId, CUENTA)
        .and.to.emit(mockDiamond, "MockOrderPaid")
        .withArgs(orderId, proxy);
      expect((await mockDiamond.orders(orderId)).paid).to.equal(true);
      expect((await integrator.getSession(orderId)).paid).to.equal(true);
    });

    it("only the operator can mark paid", async function () {
      const orderId = await place();
      await mockDiamond.simulateOrderAccepted(orderId);
      for (const who of [owner, stranger]) {
        await expect(
          integrator.connect(who).operatorMarkPaid(orderId)
        ).to.be.revertedWithCustomError(integrator, "OnlyOperator");
      }
    });

    it("still works while paused (the buyer's fiat already left)", async function () {
      const orderId = await place();
      await mockDiamond.simulateOrderAccepted(orderId);
      await integrator.connect(owner).pause();
      await integrator.connect(operator).operatorMarkPaid(orderId);
      expect((await mockDiamond.orders(orderId)).paid).to.equal(true);
    });

    it("rejects unknown, repeated, and finalized orders", async function () {
      await expect(
        integrator.connect(operator).operatorMarkPaid(999)
      ).to.be.revertedWithCustomError(integrator, "UnknownOrder");

      const orderId = await place();
      await mockDiamond.simulateOrderAccepted(orderId);
      await integrator.connect(operator).operatorMarkPaid(orderId);
      await expect(
        integrator.connect(operator).operatorMarkPaid(orderId)
      ).to.be.revertedWithCustomError(integrator, "AlreadyPaid");

      await mockDiamond.simulateOrderComplete(orderId);
      await expect(
        integrator.connect(operator).operatorMarkPaid(orderId)
      ).to.be.revertedWithCustomError(integrator, "OrderFinalized");
    });

    it("bubbles the Diamond's refusal (not yet accepted)", async function () {
      const orderId = await place();
      await expect(integrator.connect(operator).operatorMarkPaid(orderId)).to.be.reverted;
      expect((await integrator.getSession(orderId)).paid).to.equal(false);
    });
  });

  // ─── Cancel ─────────────────────────────────────────────────────────

  describe("cancellation", function () {
    it("operatorCancelOrder cancels via the proxy and releases the slots", async function () {
      const orderId = await place(CUENTA, USDC(30));
      expect(await integrator.getRemainingDailyCount(CUENTA)).to.equal(DAILY_COUNT - 1);
      const proxy = await integrator.proxyDe(CUENTA);

      const tx = integrator.connect(operator).operatorCancelOrder(orderId);
      await expect(tx).to.emit(mockDiamond, "MockOrderCancelledBy").withArgs(orderId, proxy);
      await expect(tx).to.emit(integrator, "PantherOrderCancelled").withArgs(orderId, CUENTA);
      // The callback re-entered through its own guard and succeeded.
      await expect(tx).to.not.emit(mockDiamond, "MockIntegratorCallbackFailed");

      expect(await integrator.getRemainingDailyCount(CUENTA)).to.equal(DAILY_COUNT);
      expect(await integrator.getTodayVolume(CUENTA)).to.equal(0);
      expect((await integrator.getSession(orderId)).cancelled).to.equal(true);
    });

    it("emits PantherOrderCancelled exactly once", async function () {
      const orderId = await place();
      const rc = await (await integrator.connect(operator).operatorCancelOrder(orderId)).wait();
      const n = rc.logs.filter(
        (l: any) => l.fragment && l.fragment.name === "PantherOrderCancelled"
      ).length;
      expect(n).to.equal(1);
    });

    it("only the operator can cancel; blocked while paused", async function () {
      const orderId = await place();
      for (const who of [owner, stranger]) {
        await expect(
          integrator.connect(who).operatorCancelOrder(orderId)
        ).to.be.revertedWithCustomError(integrator, "OnlyOperator");
      }
      await integrator.connect(owner).pause();
      await expect(
        integrator.connect(operator).operatorCancelOrder(orderId)
      ).to.be.revertedWithCustomError(integrator, "ContractPaused");
    });

    it("rejects cancelling unknown / finalized orders", async function () {
      await expect(
        integrator.connect(operator).operatorCancelOrder(42)
      ).to.be.revertedWithCustomError(integrator, "UnknownOrder");
      const orderId = await place();
      await integrator.connect(operator).operatorCancelOrder(orderId);
      await expect(
        integrator.connect(operator).operatorCancelOrder(orderId)
      ).to.be.revertedWithCustomError(integrator, "OrderFinalized");
    });

    it("Diamond-side cancel (expiry/dispute) releases the slots", async function () {
      const orderId = await place(CUENTA, USDC(25));
      await expect(mockDiamond.simulateOrderCancelled(orderId))
        .to.emit(integrator, "PantherOrderCancelled")
        .withArgs(orderId, CUENTA);
      expect(await integrator.getRemainingDailyCount(CUENTA)).to.equal(DAILY_COUNT);
      expect(await integrator.getTodayVolume(CUENTA)).to.equal(0);
    });

    it("a freed slot can be reused once the limit was hit", async function () {
      const ids: bigint[] = [];
      for (let i = 0; i < DAILY_COUNT; i++) ids.push(await place());
      await expect(place()).to.be.revertedWithCustomError(integrator, "DailyCountLimitExceeded");
      await integrator.connect(operator).operatorCancelOrder(ids[0]);
      await place();
    });

    it("releases the PLACEMENT day's slot, not today's", async function () {
      const orderId = await place();
      await nextDay();
      await place();
      await mockDiamond.simulateOrderCancelled(orderId);
      expect(await integrator.getRemainingDailyCount(CUENTA)).to.equal(DAILY_COUNT - 1);
    });

    it("onOrderCancel is onlyDiamond and tolerates unknown / repeated / completed", async function () {
      await expect(integrator.connect(stranger).onOrderCancel(1)).to.be.revertedWithCustomError(
        integrator,
        "OnlyDiamond"
      );
      const d = await impersonateDiamond();
      await integrator.connect(d).onOrderCancel(12345); // unknown: no-op

      const orderId = await place();
      await integrator.connect(d).onOrderCancel(orderId);
      await expect(integrator.connect(d).onOrderCancel(orderId)).to.not.emit(
        integrator,
        "PantherOrderCancelled"
      );
      expect(await integrator.getRemainingDailyCount(CUENTA)).to.equal(DAILY_COUNT);

      const done = await place();
      await mockDiamond.simulateOrderComplete(done);
      await expect(integrator.connect(d).onOrderCancel(done)).to.not.emit(
        integrator,
        "PantherOrderCancelled"
      );
      expect(await integrator.getRemainingDailyCount(CUENTA)).to.equal(DAILY_COUNT - 1);
    });
  });

  // ─── Completion ─────────────────────────────────────────────────────

  describe("completion", function () {
    it("USDC lands at the treasury and the order is marked fulfilled", async function () {
      const orderId = await place(CUENTA, USDC(42));
      await mockDiamond.simulateOrderAccepted(orderId);
      await integrator.connect(operator).operatorMarkPaid(orderId);

      const before = await mockUsdc.balanceOf(treasury.address);
      await expect(mockDiamond.simulateOrderComplete(orderId))
        .to.emit(integrator, "PantherOrderCompleted")
        .withArgs(orderId, CUENTA, USDC(42));

      expect(await mockUsdc.balanceOf(treasury.address)).to.equal(before + USDC(42));
      expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(0);
      expect(await mockUsdc.balanceOf(await integrator.proxyDe(CUENTA))).to.equal(0);
      expect((await integrator.getSession(orderId)).fulfilled).to.equal(true);
      // Completion does not give the slot back.
      expect(await integrator.getRemainingDailyCount(CUENTA)).to.equal(DAILY_COUNT - 1);
    });

    it("onOrderComplete is onlyDiamond; unknown and repeated calls are no-ops", async function () {
      await expect(
        integrator.connect(stranger).onOrderComplete(1, stranger.address, 1, treasury.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");

      const d = await impersonateDiamond();
      await expect(
        integrator.connect(d).onOrderComplete(999, stranger.address, 1, treasury.address)
      ).to.not.emit(integrator, "PantherOrderCompleted");

      const orderId = await place();
      await mockDiamond.simulateOrderComplete(orderId);
      const proxy = await integrator.proxyDe(CUENTA);
      await expect(
        integrator.connect(d).onOrderComplete(orderId, proxy, USDC(10), treasury.address)
      ).to.not.emit(integrator, "PantherOrderCompleted");
    });

    it("cancel-then-complete (dispute re-open) settles and re-charges today", async function () {
      const orderId = await place(CUENTA, USDC(10));
      await mockDiamond.simulateOrderCancelled(orderId);
      expect(await integrator.getRemainingDailyCount(CUENTA)).to.equal(DAILY_COUNT);

      await expect(mockDiamond.simulateOrderComplete(orderId))
        .to.emit(integrator, "CancelledOrderCompleted")
        .withArgs(orderId, CUENTA)
        .and.to.emit(integrator, "PantherOrderCompleted")
        .withArgs(orderId, CUENTA, USDC(10));
      expect(await integrator.getRemainingDailyCount(CUENTA)).to.equal(DAILY_COUNT - 1);
      expect(await integrator.getTodayVolume(CUENTA)).to.equal(USDC(10));
    });

    it("a callback that does not match the order raises an anomaly, not a credit", async function () {
      const orderId = await place();
      const d = await impersonateDiamond();
      const proxy = await integrator.proxyDe(CUENTA);
      await expect(
        integrator.connect(d).onOrderComplete(orderId, stranger.address, USDC(10), treasury.address)
      )
        .to.emit(integrator, "SettlementRoutingAnomaly")
        .and.to.not.emit(integrator, "PantherOrderCompleted");
      await expect(
        integrator.connect(d).onOrderComplete(orderId, proxy, USDC(10), stranger.address)
      )
        .to.emit(integrator, "SettlementRoutingAnomaly")
        .and.to.not.emit(integrator, "PantherOrderCompleted");
      expect((await integrator.getSession(orderId)).fulfilled).to.equal(false);
    });

    it("mis-registration (usdcThroughIntegrator=true): alarms, settles, flushes to treasury", async function () {
      await mockDiamond.setUsdcThroughIntegrator(true);
      const orderId = await place(CUENTA, USDC(15));
      await expect(mockDiamond.simulateOrderComplete(orderId))
        .to.emit(integrator, "SettlementRoutingAnomaly")
        .and.to.emit(integrator, "PantherOrderCompleted")
        .withArgs(orderId, CUENTA, USDC(15));
      expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(USDC(15));

      const before = await mockUsdc.balanceOf(treasury.address);
      // Permissionless: the destination is immutable.
      await expect(integrator.connect(stranger).flushToTreasury())
        .to.emit(integrator, "FlushedToTreasury")
        .withArgs(USDC(15));
      expect(await mockUsdc.balanceOf(treasury.address)).to.equal(before + USDC(15));
      expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(0);
      // Zero balance: silent no-op.
      await expect(integrator.flushToTreasury()).to.not.emit(integrator, "FlushedToTreasury");
    });

    it("falls back to the balance when the Diamond config is unreadable", async function () {
      await mockDiamond.setConfigReadable(false);
      const ok = await place();
      await expect(mockDiamond.simulateOrderComplete(ok)).to.not.emit(
        integrator,
        "SettlementRoutingAnomaly"
      );

      await mockDiamond.setUsdcThroughIntegrator(true);
      const bad = await place();
      await expect(mockDiamond.simulateOrderComplete(bad)).to.emit(
        integrator,
        "SettlementRoutingAnomaly"
      );
    });
  });

  // ─── Admin ──────────────────────────────────────────────────────────

  describe("owner admin", function () {
    it("setters are owner-only", async function () {
      for (const who of [operator, stranger]) {
        const c = integrator.connect(who);
        await expect(c.setOperator(who.address)).to.be.revertedWithCustomError(
          integrator,
          "OnlyOwner"
        );
        await expect(c.setPerTxCap(USDC(10))).to.be.revertedWithCustomError(
          integrator,
          "OnlyOwner"
        );
        await expect(c.setDailyTxCountLimit(5)).to.be.revertedWithCustomError(
          integrator,
          "OnlyOwner"
        );
        await expect(c.setDailyVolumeCap(USDC(10))).to.be.revertedWithCustomError(
          integrator,
          "OnlyOwner"
        );
        await expect(c.pause()).to.be.revertedWithCustomError(integrator, "OnlyOwner");
        await expect(c.unpause()).to.be.revertedWithCustomError(integrator, "OnlyOwner");
      }
    });

    it("setters respect the immutable MAX_* ceilings", async function () {
      const c = integrator.connect(owner);
      await expect(c.setPerTxCap(USDC(500)))
        .to.emit(integrator, "PerTxCapUpdated")
        .withArgs(USDC(500));
      await expect(c.setPerTxCap(USDC(500) + 1n)).to.be.revertedWithCustomError(
        integrator,
        "CapExceedsCeiling"
      );
      await expect(c.setPerTxCap(0)).to.be.revertedWithCustomError(integrator, "InvalidLimit");

      await expect(c.setDailyTxCountLimit(50))
        .to.emit(integrator, "DailyTxCountLimitUpdated")
        .withArgs(50);
      await expect(c.setDailyTxCountLimit(51)).to.be.revertedWithCustomError(
        integrator,
        "CapExceedsCeiling"
      );
      await expect(c.setDailyTxCountLimit(0)).to.be.revertedWithCustomError(
        integrator,
        "InvalidLimit"
      );

      await expect(c.setDailyVolumeCap(USDC(5000)))
        .to.emit(integrator, "DailyVolumeCapUpdated")
        .withArgs(USDC(5000));
      await expect(c.setDailyVolumeCap(USDC(5000) + 1n)).to.be.revertedWithCustomError(
        integrator,
        "CapExceedsCeiling"
      );
      await c.setDailyVolumeCap(0); // off
    });

    it("lowering the per-tx cap applies to the next order", async function () {
      await integrator.connect(owner).setPerTxCap(USDC(5));
      await expect(place(CUENTA, USDC(6))).to.be.revertedWithCustomError(
        integrator,
        "PerTxCapExceeded"
      );
      await place(CUENTA, USDC(5));
    });

    it("rotating the operator revokes the old key; zero disables the flow", async function () {
      await expect(integrator.connect(owner).setOperator(stranger.address))
        .to.emit(integrator, "OperatorUpdated")
        .withArgs(stranger.address);
      await expect(place()).to.be.revertedWithCustomError(integrator, "OnlyOperator");
      await place(CUENTA, USDC(10), stranger);

      await integrator.connect(owner).setOperator(ethers.ZeroAddress);
      await expect(place(CUENTA, USDC(10), stranger)).to.be.revertedWithCustomError(
        integrator,
        "OnlyOperator"
      );
    });

    it("pause / unpause emit once and are idempotent", async function () {
      await expect(integrator.connect(owner).pause()).to.emit(integrator, "Paused");
      await expect(integrator.connect(owner).pause()).to.not.emit(integrator, "Paused");
      await expect(integrator.connect(owner).unpause()).to.emit(integrator, "Unpaused");
      await expect(integrator.connect(owner).unpause()).to.not.emit(integrator, "Unpaused");
    });

    it("validateOrder refuses while paused even mid-placement (defence in depth)", async function () {
      await integrator.connect(owner).pause();
      const d = await impersonateDiamond();
      expect(
        await integrator
          .connect(d)
          .validateOrder.staticCall(await integrator.proxyDe(CUENTA), USDC(1), COP)
      ).to.equal(false);
    });
  });
});
