import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const STATUS = { PLACED: 0, ACCEPTED: 1, PAID: 2, COMPLETED: 3, CANCELLED: 4 };

describe("TradeStarsCheckoutIntegratorV2 — user-driven offramp", function () {
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

  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
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

    // Seed the vault with 100 USDC of principal.
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

  async function startOfframp(allocationId: bigint, amount: bigint) {
    const tx = await integrator
      .connect(user)
      .userStartOfframp(allocationId, INR, USDC(0), 1n, 0n, "userRelayPubKey");
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

      const proxy = await integrator.proxyAddress(user.address);
      expect(await usdc.balanceOf(proxy)).to.equal(USDC(20));
      expect(await vault.offrampWithdrawn()).to.equal(offrampBefore + USDC(20));
      expect(await integrator.availableOfframp(user.address)).to.equal(USDC(20));
      expect(await integrator.burnToAllocation(BURN("ab"))).to.equal(allocationId);

      const a = await integrator.getAllocation(allocationId);
      expect(a.user).to.equal(user.address);
      expect(a.amount).to.equal(USDC(20));
      expect(a.settled).to.equal(false);

      const pending = await integrator.pendingAllocations(user.address);
      expect(pending.length).to.equal(1);
      expect(pending[0]).to.equal(allocationId);
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

  describe("userStartOfframp (user places the SELL)", function () {
    it("places a SELL whose order.user is the user's OWN proxy (history attribution)", async function () {
      const allocationId = await allocate(USDC(20));
      const orderId = await startOfframp(allocationId, USDC(20));

      const proxy = await integrator.proxyAddress(user.address);
      const so = await mockDiamond.getSellOrder(orderId);
      expect(so.user).to.equal(proxy); // <- keyed on the user's proxy, not a system proxy
      expect(so.amount).to.equal(USDC(20));
      expect(so.status).to.equal(STATUS.PLACED);
      expect(await integrator.orderToAllocation(orderId)).to.equal(allocationId);
    });

    it("bypasses BUY limits for the offramp SELL (validateOrder bypass)", async function () {
      // baseTxLimit = 50 USDC; an allocation of 70 would FAIL the buy limit
      // if validateOrder didn't bypass for our own placement.
      const allocationId = await allocate(USDC(70), "11");
      const proxy = await integrator.proxyAddress(user.address);
      const orderId = await startOfframp(allocationId, USDC(70));
      const so = await mockDiamond.getSellOrder(orderId);
      expect(so.amount).to.equal(USDC(70));
      // No daily-count slot consumed for the proxy (offramp bypass path).
      expect(await integrator.getTodayCount(proxy)).to.equal(0);
    });

    it("only the allocation owner can start it", async function () {
      const allocationId = await allocate(USDC(20));
      await expect(
        integrator.connect(stranger).userStartOfframp(allocationId, INR, 0n, 1n, 0n, "pk")
      ).to.be.revertedWithCustomError(integrator, "OnlyAllocationOwner");
    });

    it("rejects an unknown allocation", async function () {
      await expect(
        integrator.connect(user).userStartOfframp(999n, INR, 0n, 1n, 0n, "pk")
      ).to.be.revertedWithCustomError(integrator, "OfframpRecordNotFound");
    });

    it("rejects re-placing while an order is still in flight", async function () {
      const allocationId = await allocate(USDC(20));
      await startOfframp(allocationId, USDC(20));
      await expect(
        integrator.connect(user).userStartOfframp(allocationId, INR, 0n, 1n, 0n, "pk")
      ).to.be.revertedWithCustomError(integrator, "OfframpInFlight");
    });
  });

  // ─── full happy path ──────────────────────────────────────────────────

  describe("userDeliverOfframpUpi → COMPLETED", function () {
    it("delivers UPI (Diamond pulls from the proxy) then settles on complete", async function () {
      const allocationId = await allocate(USDC(20));
      const orderId = await startOfframp(allocationId, USDC(20));
      const proxy = await integrator.proxyAddress(user.address);

      await mockDiamond.acceptSellOrder(orderId, "merchantPubKey");
      await integrator.connect(user).userDeliverOfframpUpi(orderId, "encUpiCiphertext");

      // Diamond pulled the 20 USDC from the user's proxy.
      expect(await usdc.balanceOf(proxy)).to.equal(0n);
      expect((await mockDiamond.getSellOrder(orderId)).status).to.equal(STATUS.PAID);

      await mockDiamond.completeSellOrder(orderId);
      await integrator.syncOfframp(orderId);
      const a = await integrator.getAllocation(allocationId);
      expect(a.lastStatus).to.equal(STATUS.COMPLETED);
      expect(a.settled).to.equal(true);
      expect(await integrator.availableOfframp(user.address)).to.equal(0n);
    });

    it("reverts OfframpFeeNotReady when actualUsdtAmount is 0", async function () {
      const allocationId = await allocate(USDC(20));
      const orderId = await startOfframp(allocationId, USDC(20));
      await mockDiamond.acceptSellOrder(orderId, "mp");
      await mockDiamond.setAdditionalOrderDetailsFeeUnready(true);
      await expect(
        integrator.connect(user).userDeliverOfframpUpi(orderId, "x")
      ).to.be.revertedWithCustomError(integrator, "OfframpFeeNotReady");
    });

    it("only the allocation owner can deliver", async function () {
      const allocationId = await allocate(USDC(20));
      const orderId = await startOfframp(allocationId, USDC(20));
      await mockDiamond.acceptSellOrder(orderId, "mp");
      await expect(
        integrator.connect(stranger).userDeliverOfframpUpi(orderId, "x")
      ).to.be.revertedWithCustomError(integrator, "OnlyAllocationOwner");
    });
  });

  // ─── cancel → retry from the proxy balance ────────────────────────────

  describe("cancel → user retries from the proxy balance", function () {
    it("a cancelled order leaves USDC in the proxy; user re-places and completes", async function () {
      const allocationId = await allocate(USDC(20));
      const orderId = await startOfframp(allocationId, USDC(20));
      const proxy = await integrator.proxyAddress(user.address);

      await mockDiamond.acceptSellOrder(orderId, "mp");
      await integrator.connect(user).userDeliverOfframpUpi(orderId, "enc");
      expect(await usdc.balanceOf(proxy)).to.equal(0n);

      // Diamond cancels while PAID → refunds to order.user = the proxy.
      await mockDiamond.cancelSellOrder(orderId);
      await integrator.syncOfframp(orderId);
      const a1 = await integrator.getAllocation(allocationId);
      expect(a1.lastStatus).to.equal(STATUS.CANCELLED);
      expect(a1.settled).to.equal(false); // NOT settled — retryable
      expect(await usdc.balanceOf(proxy)).to.equal(USDC(20)); // refunded to proxy

      // User retries: re-place a fresh SELL from the same proxy balance.
      const orderId2 = await startOfframp(allocationId, USDC(20));
      expect(orderId2).to.not.equal(orderId);
      await mockDiamond.acceptSellOrder(orderId2, "mp2");
      await integrator.connect(user).userDeliverOfframpUpi(orderId2, "enc2");
      await mockDiamond.completeSellOrder(orderId2);
      await integrator.syncOfframp(orderId2);
      expect((await integrator.getAllocation(allocationId)).settled).to.equal(true);
    });

    it("syncOfframp reverts on a non-terminal order", async function () {
      const allocationId = await allocate(USDC(20));
      const orderId = await startOfframp(allocationId, USDC(20));
      await expect(integrator.syncOfframp(orderId)).to.be.revertedWithCustomError(
        integrator,
        "StatusNotTerminal"
      );
    });
  });

  // ─── reclaim abandoned ────────────────────────────────────────────────

  describe("reclaimAbandonedOfframp (owner break-glass)", function () {
    it("returns the proxy's USDC to the vault after the timeout", async function () {
      const allocationId = await allocate(USDC(20));
      const proxy = await integrator.proxyAddress(user.address);
      const offrampAfterAlloc = await vault.offrampWithdrawn();

      await expect(
        integrator.connect(owner).reclaimAbandonedOfframp(allocationId)
      ).to.be.revertedWithCustomError(integrator, "NotYetAbandoned");

      await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);

      await integrator.connect(owner).reclaimAbandonedOfframp(allocationId);
      expect(await usdc.balanceOf(proxy)).to.equal(0n);
      expect(await vault.offrampWithdrawn()).to.equal(offrampAfterAlloc - USDC(20));
      expect((await integrator.getAllocation(allocationId)).settled).to.equal(true);
      expect(await integrator.availableOfframp(user.address)).to.equal(0n);
    });

    it("only the owner can reclaim", async function () {
      const allocationId = await allocate(USDC(20));
      await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      await expect(
        integrator.connect(stranger).reclaimAbandonedOfframp(allocationId)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });

    it("refuses to reclaim while an order is in flight", async function () {
      const allocationId = await allocate(USDC(20));
      await startOfframp(allocationId, USDC(20)); // PLACED, not cancelled
      await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      await expect(
        integrator.connect(owner).reclaimAbandonedOfframp(allocationId)
      ).to.be.revertedWithCustomError(integrator, "OfframpInFlight");
    });
  });
});
