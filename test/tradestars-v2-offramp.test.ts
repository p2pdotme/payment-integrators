import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const STATUS = { PLACED: 0, ACCEPTED: 1, PAID: 2, COMPLETED: 3, CANCELLED: 4 };

describe("TradeStarsCheckoutIntegratorV2 — user-driven offramp (pooled, partial draws)", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let relayer: SignerWithAddress;
  let stranger: SignerWithAddress;

  let usdc: any;
  let aUsdc: any;
  let aave: any;
  let vault: any;
  let mockDiamond: any;
  let integrator: any;

  const USDC = (n: number | string) => ethers.parseUnits(n.toString(), 6);
  const BASE_TX_LIMIT = USDC(50);
  const DAILY_COUNT_LIMIT = 10;
  const INR = ethers.encodeBytes32String("INR");
  const BURN = (b: string) => "0x" + b.repeat(32);
  const PUBKEY = "0x" + "cd".repeat(32);

  beforeEach(async function () {
    [owner, user, relayer, stranger] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();
    aUsdc = await MockUSDC.deploy();

    const MockAavePool = await ethers.getContractFactory("MockAavePool");
    aave = await MockAavePool.deploy();
    await aave.configure(await usdc.getAddress(), await aUsdc.getAddress());

    const Vault = await ethers.getContractFactory("RestrictedYieldVault");
    vault = await Vault.deploy(
      await usdc.getAddress(),
      await aUsdc.getAddress(),
      await aave.getAddress()
    );

    const MockDiamond = await ethers.getContractFactory("MockDiamond");
    mockDiamond = await MockDiamond.deploy(await usdc.getAddress());

    const Integrator = await ethers.getContractFactory("TradeStarsCheckoutIntegratorV2");
    integrator = await Integrator.deploy(
      await mockDiamond.getAddress(),
      await usdc.getAddress(),
      BASE_TX_LIMIT,
      DAILY_COUNT_LIMIT
    );

    await mockDiamond.registerIntegrator(
      await integrator.getAddress(),
      await integrator.proxyImpl()
    );

    await integrator.setYieldVault(await vault.getAddress());
    await vault.setOfframpOperator(await integrator.getAddress());
    await integrator.setOfframpEnabled(true);
    await integrator.setOfframpRelayer(relayer.address);
    await integrator.setMaxUsdcPerOfframp(USDC(1000));

    // Seed the vault with 100 USDC of offramp liquidity.
    await usdc.mint(owner.address, USDC(100));
    await usdc.connect(owner).approve(await vault.getAddress(), USDC(100));
    await vault.connect(owner).deposit(USDC(100));

    // Fund the MockDiamond so it can pay cancel refunds.
    await usdc.mint(await mockDiamond.getAddress(), USDC(1000));
  });

  // ─── helpers ────────────────────────────────────────────────────────

  async function allocate(amount: bigint, burnHex = "ab") {
    const tx = await integrator
      .connect(relayer)
      .allocateOfframp(user.address, amount, BURN(burnHex), PUBKEY);
    const rcpt = await tx.wait();
    const ev = rcpt.logs
      .map((l: any) => {
        try {
          return integrator.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p: any) => p?.name === "OfframpAllocated");
    return ev.args.allocationId as bigint;
  }

  /** Draw `principal` from the user's pooled proxy balance (places a SELL). */
  async function startOfframp(principal: bigint, who: SignerWithAddress = user) {
    const tx = await integrator
      .connect(who)
      .userStartOfframp(principal, INR, USDC(0), 1n, 0n, "userRelayPubKey");
    const rcpt = await tx.wait();
    const ev = rcpt.logs
      .map((l: any) => {
        try {
          return integrator.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p: any) => p?.name === "OfframpOrderPlaced");
    return ev.args.orderId as bigint;
  }

  /** Drive one draw all the way to COMPLETED + sync. */
  async function completeDraw(principal: bigint) {
    const orderId = await startOfframp(principal);
    await mockDiamond.acceptSellOrder(orderId, "mp");
    await integrator.connect(user).userDeliverOfframpUpi(orderId, "enc");
    await mockDiamond.completeSellOrder(orderId);
    await integrator.syncOfframp(orderId);
    return orderId;
  }

  const proxyOf = () => integrator.proxyAddress(user.address);

  // ─── BUY (onramp) parity ──────────────────────────────────────────────

  describe("BUY still works and funds the vault", function () {
    it("completion routes USDC to the vault", async function () {
      await integrator
        .connect(user)
        .userPlaceOrder("0x" + "11".repeat(32), USDC(20), INR, 1, "pk", 0, 0);
      const before = await vault.totalPrincipal();
      await mockDiamond.simulateOrderComplete(1n);
      expect((await vault.totalPrincipal()) - before).to.equal(USDC(20));
    });
  });

  // ─── allocateOfframp ──────────────────────────────────────────────────

  describe("allocateOfframp (relayer-only)", function () {
    it("pulls from the vault and funds the user's OWN proxy", async function () {
      const offrampBefore = await vault.offrampWithdrawn();
      const allocationId = await allocate(USDC(20));

      const proxy = await proxyOf();
      expect(await usdc.balanceOf(proxy)).to.equal(USDC(20));
      expect(await vault.offrampWithdrawn()).to.equal(offrampBefore + USDC(20));
      expect(await integrator.availableOfframp(user.address)).to.equal(USDC(20));
      expect(await integrator.burnToAllocation(BURN("ab"))).to.equal(allocationId);

      const a = await integrator.getAllocation(allocationId);
      expect(a.user).to.equal(user.address);
      expect(a.amount).to.equal(USDC(20));

      const ids = await integrator.getUserAllocations(user.address);
      expect(ids.length).to.equal(1);
      expect(ids[0]).to.equal(allocationId);
    });

    it("pools multiple allocations into one proxy balance", async function () {
      await allocate(USDC(20), "ab");
      await allocate(USDC(30), "cd");
      expect(await integrator.availableOfframp(user.address)).to.equal(USDC(50));
      expect((await integrator.getUserAllocations(user.address)).length).to.equal(2);
    });

    it("dedupes the same burn tx", async function () {
      await allocate(USDC(20), "ab");
      await expect(
        integrator.connect(relayer).allocateOfframp(user.address, USDC(20), BURN("ab"), PUBKEY)
      ).to.be.revertedWithCustomError(integrator, "BurnAlreadyProcessed");
    });

    it("enforces maxUsdcPerOfframp", async function () {
      await integrator.setMaxUsdcPerOfframp(USDC(50));
      await expect(
        integrator.connect(relayer).allocateOfframp(user.address, USDC(51), BURN("11"), PUBKEY)
      ).to.be.revertedWithCustomError(integrator, "OfframpAmountTooLarge");
    });

    it("only the relayer can allocate", async function () {
      await expect(
        integrator.connect(stranger).allocateOfframp(user.address, USDC(20), BURN("11"), PUBKEY)
      ).to.be.revertedWithCustomError(integrator, "OnlyOfframpRelayer");
    });

    it("blocked when offramp disabled", async function () {
      await integrator.setOfframpEnabled(false);
      await expect(
        integrator.connect(relayer).allocateOfframp(user.address, USDC(20), BURN("11"), PUBKEY)
      ).to.be.revertedWithCustomError(integrator, "OfframpDisabled");
    });
  });

  // ─── userStartOfframp ─────────────────────────────────────────────────

  describe("userStartOfframp (user draws a SELL from the pool)", function () {
    it("places a SELL whose order.user is the user's OWN proxy (history attribution)", async function () {
      await allocate(USDC(20));
      const orderId = await startOfframp(USDC(20));

      const proxy = await proxyOf();
      const so = await mockDiamond.getSellOrder(orderId);
      expect(so.user).to.equal(proxy); // keyed on the user's proxy, not a system proxy
      expect(so.amount).to.equal(USDC(20));
      expect(so.status).to.equal(STATUS.PLACED);
      expect(await integrator.orderToUser(orderId)).to.equal(user.address);
      expect(await integrator.userActiveOrder(user.address)).to.equal(orderId);
    });

    it("bypasses BUY limits for the offramp SELL (validateOrder bypass)", async function () {
      // baseTxLimit = 50 USDC; a draw of 70 would FAIL the buy limit if
      // validateOrder didn't bypass for our own placement.
      await allocate(USDC(70), "11");
      const proxy = await proxyOf();
      const orderId = await startOfframp(USDC(70));
      const so = await mockDiamond.getSellOrder(orderId);
      expect(so.amount).to.equal(USDC(70));
      expect(await integrator.getTodayCount(proxy)).to.equal(0);
    });

    it("rejects a zero principal", async function () {
      await allocate(USDC(20));
      await expect(
        integrator.connect(user).userStartOfframp(0n, INR, 0n, 1n, 0n, "pk")
      ).to.be.revertedWithCustomError(integrator, "InvalidAmount");
    });

    it("rejects a draw with no proxy balance (insufficient)", async function () {
      // stranger has never been allocated → empty proxy.
      await expect(
        integrator.connect(stranger).userStartOfframp(USDC(5), INR, 0n, 1n, 0n, "pk")
      ).to.be.revertedWithCustomError(integrator, "OfframpInsufficientBalance");
    });

    it("rejects a draw larger than the pooled balance", async function () {
      await allocate(USDC(20));
      await expect(
        integrator.connect(user).userStartOfframp(USDC(21), INR, 0n, 1n, 0n, "pk")
      ).to.be.revertedWithCustomError(integrator, "OfframpInsufficientBalance");
    });

    it("rejects a second draw while one is still in flight", async function () {
      await allocate(USDC(50));
      await startOfframp(USDC(20));
      await expect(
        integrator.connect(user).userStartOfframp(USDC(20), INR, 0n, 1n, 0n, "pk")
      ).to.be.revertedWithCustomError(integrator, "OfframpInFlight");
    });
  });

  // ─── partial / multi-part cash-outs ───────────────────────────────────

  describe("partial draws (100 cashed out in parts)", function () {
    it("draws 30 + 40 + 30 sequentially, balance ticks down to 0", async function () {
      await allocate(USDC(100));
      const proxy = await proxyOf();

      await completeDraw(USDC(30));
      expect(await usdc.balanceOf(proxy)).to.equal(USDC(70));
      expect(await integrator.availableOfframp(user.address)).to.equal(USDC(70));

      await completeDraw(USDC(40));
      expect(await integrator.availableOfframp(user.address)).to.equal(USDC(30));

      await completeDraw(USDC(30));
      expect(await integrator.availableOfframp(user.address)).to.equal(0n);
    });

    it("a draw only debits the proxy at deliver (PAID), not at placement", async function () {
      await allocate(USDC(100));
      const proxy = await proxyOf();
      const orderId = await startOfframp(USDC(30));
      // Placed but not delivered — proxy still holds the full pool.
      expect(await usdc.balanceOf(proxy)).to.equal(USDC(100));
      await mockDiamond.acceptSellOrder(orderId, "mp");
      await integrator.connect(user).userDeliverOfframpUpi(orderId, "enc");
      expect(await usdc.balanceOf(proxy)).to.equal(USDC(70));
    });
  });

  // ─── fee comes out of the balance (no subsidy) ────────────────────────

  describe("small-order fee is funded from the balance, never subsidised", function () {
    const THRESHOLD = USDC(10);
    const FEE = USDC("0.125");

    beforeEach(async function () {
      await mockDiamond.setSmallOrderConfig(INR, THRESHOLD, FEE);
    });

    it("rejects withdrawing the full balance when a fee applies (needs principal+fee)", async function () {
      await allocate(USDC(10)); // exactly the threshold → fee applies
      // principal 10 + fee 0.125 = 10.125 > 10 available.
      await expect(
        integrator.connect(user).userStartOfframp(USDC(10), INR, 0n, 1n, 0n, "pk")
      ).to.be.revertedWithCustomError(integrator, "OfframpInsufficientBalance");
    });

    it("allows the largest draw that leaves room for the fee", async function () {
      await allocate(USDC(10));
      // 9.875 + 0.125 = 10 exactly.
      const orderId = await startOfframp(USDC("9.875"));
      expect((await mockDiamond.getSellOrder(orderId)).amount).to.equal(USDC("9.875"));
    });

    it("deliver debits principal + fee from the proxy", async function () {
      await allocate(USDC(12));
      const proxy = await proxyOf();
      const orderId = await startOfframp(USDC(5)); // 5 <= 10 → fee 0.125
      await mockDiamond.acceptSellOrder(orderId, "mp");
      await integrator.connect(user).userDeliverOfframpUpi(orderId, "enc");
      // 12 - (5 + 0.125) = 6.875 left.
      expect(await usdc.balanceOf(proxy)).to.equal(USDC("6.875"));
    });

    it("no fee above the threshold", async function () {
      await allocate(USDC(20));
      const proxy = await proxyOf();
      await completeDraw(USDC(15)); // 15 > 10 → fee 0
      expect(await usdc.balanceOf(proxy)).to.equal(USDC(5));
      // The leftover 5 is below threshold → withdrawing it whole needs 5.125.
      await expect(
        integrator.connect(user).userStartOfframp(USDC(5), INR, 0n, 1n, 0n, "pk")
      ).to.be.revertedWithCustomError(integrator, "OfframpInsufficientBalance");
    });
  });

  // ─── full happy path ──────────────────────────────────────────────────

  describe("userDeliverOfframpUpi → COMPLETED", function () {
    it("delivers UPI (Diamond pulls from the proxy) then completes", async function () {
      await allocate(USDC(20));
      const orderId = await startOfframp(USDC(20));
      const proxy = await proxyOf();

      await mockDiamond.acceptSellOrder(orderId, "merchantPubKey");
      await integrator.connect(user).userDeliverOfframpUpi(orderId, "encUpiCiphertext");

      expect(await usdc.balanceOf(proxy)).to.equal(0n);
      expect((await mockDiamond.getSellOrder(orderId)).status).to.equal(STATUS.PAID);

      await mockDiamond.completeSellOrder(orderId);
      await expect(integrator.syncOfframp(orderId))
        .to.emit(integrator, "OfframpSettled")
        .withArgs(orderId, user.address);
      expect(await integrator.userActiveOrder(user.address)).to.equal(0n);
      expect(await integrator.availableOfframp(user.address)).to.equal(0n);
    });

    it("reverts OfframpFeeNotReady when actualUsdtAmount is 0", async function () {
      await allocate(USDC(20));
      const orderId = await startOfframp(USDC(20));
      await mockDiamond.acceptSellOrder(orderId, "mp");
      await mockDiamond.setAdditionalOrderDetailsFeeUnready(true);
      await expect(
        integrator.connect(user).userDeliverOfframpUpi(orderId, "x")
      ).to.be.revertedWithCustomError(integrator, "OfframpFeeNotReady");
    });

    it("only the order owner can deliver", async function () {
      await allocate(USDC(20));
      const orderId = await startOfframp(USDC(20));
      await mockDiamond.acceptSellOrder(orderId, "mp");
      await expect(
        integrator.connect(stranger).userDeliverOfframpUpi(orderId, "x")
      ).to.be.revertedWithCustomError(integrator, "OnlyOrderOwner");
    });
  });

  // ─── cancel → retry from the proxy balance ────────────────────────────

  describe("cancel → user retries from the proxy balance", function () {
    it("a cancelled order leaves USDC in the proxy; user re-draws and completes", async function () {
      await allocate(USDC(20));
      const orderId = await startOfframp(USDC(20));
      const proxy = await proxyOf();

      await mockDiamond.acceptSellOrder(orderId, "mp");
      await integrator.connect(user).userDeliverOfframpUpi(orderId, "enc");
      expect(await usdc.balanceOf(proxy)).to.equal(0n);

      // Diamond cancels while PAID → refunds to order.user = the proxy.
      await mockDiamond.cancelSellOrder(orderId);
      await expect(integrator.syncOfframp(orderId))
        .to.emit(integrator, "OfframpCancelled")
        .withArgs(orderId, user.address);
      expect(await usdc.balanceOf(proxy)).to.equal(USDC(20)); // refunded
      expect(await integrator.userActiveOrder(user.address)).to.equal(0n);

      // User retries: re-draw a fresh SELL from the same proxy balance.
      const orderId2 = await startOfframp(USDC(20));
      expect(orderId2).to.not.equal(orderId);
      await mockDiamond.acceptSellOrder(orderId2, "mp2");
      await integrator.connect(user).userDeliverOfframpUpi(orderId2, "enc2");
      await mockDiamond.completeSellOrder(orderId2);
      await integrator.syncOfframp(orderId2);
      expect(await integrator.availableOfframp(user.address)).to.equal(0n);
    });

    it("allows a new draw after a cancel even without calling syncOfframp", async function () {
      await allocate(USDC(20));
      const orderId = await startOfframp(USDC(20));
      await mockDiamond.cancelSellOrder(orderId); // PLACED → CANCELLED, no refund needed
      // No syncOfframp; userStartOfframp tolerates a terminal prior order.
      const orderId2 = await startOfframp(USDC(20));
      expect(orderId2).to.not.equal(orderId);
    });

    it("syncOfframp reverts on a non-terminal order", async function () {
      await allocate(USDC(20));
      const orderId = await startOfframp(USDC(20));
      await expect(integrator.syncOfframp(orderId)).to.be.revertedWithCustomError(
        integrator,
        "StatusNotTerminal"
      );
    });
  });

  // ─── admin / BUY limits / guards (branch coverage) ────────────────────

  describe("admin, BUY limits, and guards", function () {
    async function placeBuy(amount: bigint, recipHex: string, ig: any = integrator, who = user) {
      const tx = await ig
        .connect(who)
        .userPlaceOrder("0x" + recipHex.repeat(32), amount, INR, 1, "pk", 0, 0);
      const rcpt = await tx.wait();
      const ev = rcpt.logs
        .map((l: any) => {
          try {
            return ig.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p: any) => p?.name === "CheckoutOrderCreated");
      return ev.args.orderId as bigint;
    }

    it("every admin setter is owner-gated", async function () {
      const s = integrator.connect(stranger);
      await expect(s.setBaseTxLimit(1n)).to.be.revertedWithCustomError(integrator, "OnlyOwner");
      await expect(s.setDailyTxCountLimit(1n)).to.be.revertedWithCustomError(
        integrator,
        "OnlyOwner"
      );
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
      await expect(s.setYieldVault(stranger.address)).to.be.revertedWithCustomError(
        integrator,
        "OnlyOwner"
      );
      await expect(s.setOfframpRelayer(stranger.address)).to.be.revertedWithCustomError(
        integrator,
        "OnlyOwner"
      );
      await expect(s.setOfframpEnabled(false)).to.be.revertedWithCustomError(
        integrator,
        "OnlyOwner"
      );
      await expect(s.setMaxUsdcPerOfframp(1n)).to.be.revertedWithCustomError(
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
      await expect(
        integrator.batchSetUserRP([user.address], [1n, 2n])
      ).to.be.revertedWithCustomError(integrator, "ArrayLengthMismatch");
    });

    it("getUserTxLimit covers rp=0 / default rate / explicit rate / cap", async function () {
      expect(await integrator.getUserTxLimit(stranger.address, INR)).to.equal(BASE_TX_LIMIT); // rp == 0
      await integrator.setUserRP(user.address, 5n);
      const NOR = ethers.encodeBytes32String("XXX");
      expect(await integrator.getUserTxLimit(user.address, NOR)).to.equal(USDC(5)); // rate defaults to 1e6
      await integrator.setRpToUsdc(INR, USDC(2));
      expect(await integrator.getUserTxLimit(user.address, INR)).to.equal(USDC(10)); // rp*rate
      await integrator.setMaxTxLimit(INR, USDC(8));
      expect(await integrator.getUserTxLimit(user.address, INR)).to.equal(USDC(8)); // capped
    });

    it("view helpers (remaining/today/session)", async function () {
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(DAILY_COUNT_LIMIT);
      expect(await integrator.getTodayCount(user.address)).to.equal(0n);
      expect((await integrator.getSession(999n)).user).to.equal(ethers.ZeroAddress);
    });

    it("Diamond-only callbacks reject a non-Diamond caller", async function () {
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

    it("userPlaceOrder rejects a zero recipient / zero amount", async function () {
      await expect(
        integrator.connect(user).userPlaceOrder(ethers.ZeroHash, USDC(10), INR, 1, "pk", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "InvalidSolanaRecipient");
      await expect(
        integrator.connect(user).userPlaceOrder("0x" + "11".repeat(32), 0n, INR, 1, "pk", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "InvalidAmount");
    });

    it("validateOrder enforces the per-tx limit and daily count", async function () {
      // amount over baseTxLimit (50) → validateOrder returns false → placement reverts
      await expect(placeBuy(USDC(60), "11")).to.be.reverted;
      // daily count: cap at 1, place one, second fails
      await integrator.setDailyTxCountLimit(1);
      await placeBuy(USDC(10), "22");
      await expect(placeBuy(USDC(10), "33")).to.be.reverted;
    });

    it("onOrderComplete reverts on unknown order + amount mismatch; BUY cancel decrements", async function () {
      const igAddr = await integrator.getAddress();
      const oid = await placeBuy(USDC(10), "44");
      await expect(
        mockDiamond.adminCallOnOrderComplete(igAddr, 99999n, user.address, USDC(10), user.address)
      ).to.be.revertedWithCustomError(integrator, "UnknownOrder");
      await expect(
        mockDiamond.adminCallOnOrderComplete(igAddr, oid, user.address, USDC(11), user.address)
      ).to.be.revertedWithCustomError(integrator, "AmountMismatch");
      await mockDiamond.simulateOrderCancelled(oid); // onOrderCancel decrement path
      expect(await integrator.getTodayCount(user.address)).to.equal(0n);
    });

    it("allocateOfframp guards: InvalidAddress / InvalidAmount / bad burn", async function () {
      await expect(
        integrator.connect(relayer).allocateOfframp(ethers.ZeroAddress, USDC(1), BURN("a1"), PUBKEY)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      await expect(
        integrator.connect(relayer).allocateOfframp(user.address, 0n, BURN("a2"), PUBKEY)
      ).to.be.revertedWithCustomError(integrator, "InvalidAmount");
      await expect(
        integrator.connect(relayer).allocateOfframp(user.address, USDC(1), ethers.ZeroHash, PUBKEY)
      ).to.be.revertedWithCustomError(integrator, "InvalidSolanaRecipient");
    });

    it("userStartOfframp blocked when offramp disabled", async function () {
      await allocate(USDC(20));
      await integrator.setOfframpEnabled(false);
      await expect(
        integrator.connect(user).userStartOfframp(USDC(5), INR, 0n, 1n, 0n, "pk")
      ).to.be.revertedWithCustomError(integrator, "OfframpDisabled");
    });

    it("deliver/sync reject unknown orders", async function () {
      await expect(
        integrator.connect(user).userDeliverOfframpUpi(99999n, "x")
      ).to.be.revertedWithCustomError(integrator, "OfframpRecordNotFound");
      await expect(integrator.syncOfframp(99999n)).to.be.revertedWithCustomError(
        integrator,
        "OfframpRecordNotFound"
      );
    });

    it("_sellFee falls back to the unified getter when the per-type SELL getter reverts", async function () {
      await mockDiamond.setSmallOrderConfig(INR, USDC(10), USDC("0.125"));
      await mockDiamond.setSellFeeGetterReverts(true);
      await allocate(USDC(20));
      const orderId = await startOfframp(USDC(5)); // 5<=10 → fee via fallback; 5.125<=20 places
      expect((await mockDiamond.getSellOrder(orderId)).amount).to.equal(USDC(5));
    });

    it("allocate reverts VaultNotSet, and onOrderComplete skips deposit when no vault is set", async function () {
      const Integrator = await ethers.getContractFactory("TradeStarsCheckoutIntegratorV2");
      const ig2 = await Integrator.deploy(
        await mockDiamond.getAddress(),
        await usdc.getAddress(),
        BASE_TX_LIMIT,
        DAILY_COUNT_LIMIT
      );
      await mockDiamond.registerIntegrator(await ig2.getAddress(), await ig2.proxyImpl());
      await ig2.setOfframpEnabled(true);
      await ig2.setOfframpRelayer(relayer.address);
      await expect(
        ig2.connect(relayer).allocateOfframp(user.address, USDC(5), BURN("b1"), PUBKEY)
      ).to.be.revertedWithCustomError(ig2, "VaultNotSet");
      const oid = await placeBuy(USDC(10), "55", ig2);
      await mockDiamond.adminCallOnOrderComplete(
        await ig2.getAddress(),
        oid,
        user.address,
        USDC(10),
        user.address
      );
      expect((await ig2.getSession(oid)).fulfilled).to.equal(true);
    });

    it("constructor rejects a zero diamond/usdc", async function () {
      const Integrator = await ethers.getContractFactory("TradeStarsCheckoutIntegratorV2");
      await expect(
        Integrator.deploy(
          ethers.ZeroAddress,
          await usdc.getAddress(),
          BASE_TX_LIMIT,
          DAILY_COUNT_LIMIT
        )
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    });
  });
});
