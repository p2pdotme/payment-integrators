import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("MerchantTerminalIntegrator — registration, limits, settlement, withdrawals, security", function () {
  let owner: SignerWithAddress;
  let merchant1: SignerWithAddress;
  let merchant2: SignerWithAddress;
  let attacker: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let integrator: any;
  let erc721Client: any;

  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
  const UNIT_PRICE = USDC(10);
  const PRODUCT_ID = 1;
  const INR = ethers.encodeBytes32String("INR");
  const DAY = 86400;
  const SETTLEMENT = 30 * DAY;
  const UPI_1 = "shop1@upi";
  const UPI_2 = "shop2@upi";

  beforeEach(async function () {
    [owner, merchant1, merchant2, attacker] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUsdc = await MockUSDC.deploy();

    const MockDiamond = await ethers.getContractFactory("MockDiamond");
    mockDiamond = await MockDiamond.deploy(await mockUsdc.getAddress());

    const Integrator = await ethers.getContractFactory("MerchantTerminalIntegrator");
    integrator = await Integrator.deploy(
      await mockDiamond.getAddress(),
      await mockUsdc.getAddress()
    );

    const Client = await ethers.getContractFactory("SimpleERC721Client");
    erc721Client = await Client.deploy(
      await integrator.getAddress(),
      await mockUsdc.getAddress(),
      "Digital Item",
      "ITEM"
    );

    await mockDiamond.registerIntegrator(
      await integrator.getAddress(),
      await integrator.proxyImpl()
    );
    await erc721Client.setProductPrice(PRODUCT_ID, UNIT_PRICE);
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(100000));
  });

  // ─── Helpers ──────────────────────────────────────────────────────

  async function diamondSigner(): Promise<SignerWithAddress> {
    const diamondAddr = await mockDiamond.getAddress();
    await ethers.provider.send("hardhat_impersonateAccount", [diamondAddr]);
    await ethers.provider.send("hardhat_setBalance", [diamondAddr, "0x1000000000000000000"]);
    return ethers.getSigner(diamondAddr);
  }

  async function placeOrder(merchant: SignerWithAddress, quantity = 1): Promise<bigint> {
    const tx = await integrator
      .connect(merchant)
      .userPlaceOrder(await erc721Client.getAddress(), PRODUCT_ID, quantity, INR, 1, "");
    await tx.wait();
    const events = await integrator.queryFilter(integrator.filters.OrderPlaced());
    return events[events.length - 1].args.orderId;
  }

  async function increaseTime(seconds: number) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  async function depositFor(
    merchant: SignerWithAddress,
    upi: string,
    quantity = 2
  ): Promise<bigint> {
    await integrator.connect(merchant).registerMerchant(upi);
    const orderId = await placeOrder(merchant, quantity);
    await mockDiamond.simulateOrderComplete(orderId);
    return orderId;
  }

  // ─── 1 + 2: Registration ──────────────────────────────────────────

  it("1. registerMerchant succeeds and emits MerchantRegistered", async function () {
    await expect(integrator.connect(merchant1).registerMerchant(UPI_1))
      .to.emit(integrator, "MerchantRegistered")
      .withArgs(merchant1.address, UPI_1);
    expect(await integrator.registered(merchant1.address)).to.equal(true);
  });

  it("2. registerMerchant reverts when called twice", async function () {
    await integrator.connect(merchant1).registerMerchant(UPI_1);
    await expect(
      integrator.connect(merchant1).registerMerchant(UPI_1)
    ).to.be.revertedWithCustomError(integrator, "AlreadyRegistered");
  });

  // ─── 3 + 4 + 5: validateOrder limits ──────────────────────────────

  it("3. validateOrder reverts above 50 USDC per-tx cap", async function () {
    await integrator.connect(merchant1).registerMerchant(UPI_1);
    const diamond = await diamondSigner();
    await expect(
      integrator.connect(diamond).validateOrder(merchant1.address, USDC(51), INR)
    ).to.be.revertedWithCustomError(integrator, "ExceedsPerTxCap");
  });

  it("4. validateOrder reverts on the 5th transaction in the same day", async function () {
    await integrator.connect(merchant1).registerMerchant(UPI_1);
    for (let i = 0; i < 4; i++) await placeOrder(merchant1);
    expect((await integrator.getDailyTxInfo(merchant1.address))[0]).to.equal(4);

    const diamond = await diamondSigner();
    await expect(
      integrator.connect(diamond).validateOrder(merchant1.address, UNIT_PRICE, INR)
    ).to.be.revertedWithCustomError(integrator, "DailyLimitReached");

    await expect(
      integrator
        .connect(merchant1)
        .userPlaceOrder(await erc721Client.getAddress(), PRODUCT_ID, 1, INR, 1, "")
    ).to.be.reverted;
  });

  it("5. daily count resets after one day", async function () {
    await integrator.connect(merchant1).registerMerchant(UPI_1);
    for (let i = 0; i < 4; i++) await placeOrder(merchant1);
    await increaseTime(DAY + 10);
    expect((await integrator.getDailyTxInfo(merchant1.address))[0]).to.equal(0);
    await placeOrder(merchant1);
    expect((await integrator.getDailyTxInfo(merchant1.address))[0]).to.equal(1);
  });

  // ─── 6 + 7: Completion and balances ────────────────────────────────

  it("6. onOrderComplete creates the correct bucket with unlock = completion + 30 days", async function () {
    await integrator.connect(merchant1).registerMerchant(UPI_1);
    const orderId = await placeOrder(merchant1, 2);
    const tx = await mockDiamond.simulateOrderComplete(orderId);
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt.blockNumber);
    const expectedUnlock = BigInt(block!.timestamp) + BigInt(SETTLEMENT);

    await expect(tx)
      .to.emit(integrator, "OrderCompleted")
      .withArgs(orderId, merchant1.address, USDC(20), expectedUnlock);

    const buckets = await integrator.getMerchantBuckets(merchant1.address);
    expect(buckets.length).to.equal(1);
    expect(buckets[0].amount).to.equal(USDC(20));
    expect(buckets[0].unlockTimestamp).to.equal(expectedUnlock);
    expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(USDC(20));
    expect(await mockUsdc.balanceOf(await integrator.proxyAddress(merchant1.address))).to.equal(0);
  });

  it("7. getMerchantBalance is correct after a deposit", async function () {
    await depositFor(merchant1, UPI_1, 2);
    const [pending, available, totalDeposited, isFrozen] = await integrator.getMerchantBalance(
      merchant1.address
    );
    expect(pending).to.equal(USDC(20));
    expect(available).to.equal(0);
    expect(totalDeposited).to.equal(USDC(20));
    expect(isFrozen).to.equal(false);
  });

  // ─── 8–11: Withdrawal gating ───────────────────────────────────────

  it("8. withdrawINR reverts before the 30-day settlement", async function () {
    await depositFor(merchant1, UPI_1, 2);
    await expect(integrator.connect(merchant1).withdrawINR(USDC(20))).to.be.revertedWithCustomError(
      integrator,
      "InsufficientAvailableBalance"
    );
  });

  it("9. withdrawINR succeeds after 30 days (funds the merchant proxy, places SELL order)", async function () {
    await depositFor(merchant1, UPI_1, 2);
    await increaseTime(SETTLEMENT + 3600);

    // SELL is placed through the MERCHANT'S OWN proxy now (per-merchant isolation)
    const merchantProxy = await integrator.proxyAddress(merchant1.address);
    await expect(integrator.connect(merchant1).withdrawINR(USDC(20))).to.emit(
      integrator,
      "WithdrawalINR"
    );
    expect(await mockUsdc.balanceOf(merchantProxy)).to.equal(USDC(20));
    expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(0);

    const [pending, available] = await integrator.getMerchantBalance(merchant1.address);
    expect(pending).to.equal(0);
    expect(available).to.equal(0);

    const sellOrder = await mockDiamond.getSellOrder(2);
    expect(sellOrder.user).to.equal(merchantProxy);
    expect(sellOrder.amount).to.equal(USDC(20));
  });

  it("10. withdrawUSDC reverts before the 30-day settlement", async function () {
    await depositFor(merchant1, UPI_1, 2);
    await expect(
      integrator.connect(merchant1).withdrawUSDC(USDC(20))
    ).to.be.revertedWithCustomError(integrator, "InsufficientAvailableBalance");
  });

  it("11. withdrawUSDC succeeds after 30 days (USDC to the merchant wallet)", async function () {
    await depositFor(merchant1, UPI_1, 2);
    await increaseTime(SETTLEMENT + 3600);

    const before = await mockUsdc.balanceOf(merchant1.address);
    await expect(integrator.connect(merchant1).withdrawUSDC(USDC(20)))
      .to.emit(integrator, "WithdrawalUSDC")
      .withArgs(merchant1.address, USDC(20));
    const after = await mockUsdc.balanceOf(merchant1.address);

    expect(after - before).to.equal(USDC(20));
    expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(0);
    const [pending, available] = await integrator.getMerchantBalance(merchant1.address);
    expect(pending).to.equal(0);
    expect(available).to.equal(0);
  });

  // ─── 12: Freeze ────────────────────────────────────────────────────

  it("12. a frozen merchant cannot withdraw even after 30 days", async function () {
    await depositFor(merchant1, UPI_1, 2);
    await increaseTime(SETTLEMENT + 3600);

    await expect(integrator.freezeMerchant(merchant1.address))
      .to.emit(integrator, "MerchantFrozen")
      .withArgs(merchant1.address);

    await expect(integrator.connect(merchant1).withdrawINR(USDC(20))).to.be.revertedWithCustomError(
      integrator,
      "MerchantIsFrozen"
    );
    await expect(
      integrator.connect(merchant1).withdrawUSDC(USDC(20))
    ).to.be.revertedWithCustomError(integrator, "MerchantIsFrozen");

    await expect(integrator.unfreezeMerchant(merchant1.address))
      .to.emit(integrator, "MerchantUnfrozen")
      .withArgs(merchant1.address);
    await integrator.connect(merchant1).withdrawUSDC(USDC(20));
  });

  // ─── 13: Isolation ─────────────────────────────────────────────────

  it("13. two merchants' balances never cross-contaminate", async function () {
    await integrator.connect(merchant1).registerMerchant(UPI_1);
    await integrator.connect(merchant2).registerMerchant(UPI_2);

    const order1 = await placeOrder(merchant1, 2);
    const order2 = await placeOrder(merchant2, 3);
    await mockDiamond.simulateOrderComplete(order1);
    await mockDiamond.simulateOrderComplete(order2);

    expect((await integrator.getMerchantBalance(merchant1.address))[0]).to.equal(USDC(20));
    expect((await integrator.getMerchantBalance(merchant2.address))[0]).to.equal(USDC(30));

    await increaseTime(SETTLEMENT + 3600);
    await integrator.connect(merchant2).withdrawUSDC(USDC(30));

    expect((await integrator.getMerchantBalance(merchant1.address))[1]).to.equal(USDC(20));
    expect((await integrator.getMerchantBalance(merchant2.address))[1]).to.equal(0);
    expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(USDC(20));
    await integrator.connect(merchant1).withdrawUSDC(USDC(20));
    await expect(integrator.connect(merchant1).withdrawUSDC(USDC(1))).to.be.revertedWithCustomError(
      integrator,
      "InsufficientAvailableBalance"
    );
  });

  // ─── 14: Cancellation ──────────────────────────────────────────────

  it("14. onOrderCancel decrements the daily tx count (and never double-decrements)", async function () {
    await integrator.connect(merchant1).registerMerchant(UPI_1);
    const order1 = await placeOrder(merchant1);
    await placeOrder(merchant1);
    expect((await integrator.getDailyTxInfo(merchant1.address))[0]).to.equal(2);

    await expect(mockDiamond.simulateOrderCancelled(order1))
      .to.emit(integrator, "OrderCancelled")
      .withArgs(order1, merchant1.address);
    expect((await integrator.getDailyTxInfo(merchant1.address))[0]).to.equal(1);

    const diamond = await diamondSigner();
    await integrator.connect(diamond).onOrderCancel(order1);
    expect((await integrator.getDailyTxInfo(merchant1.address))[0]).to.equal(1);
    await integrator.connect(diamond).onOrderCancel(999);
  });

  // ─── SECURITY / HARDENING TESTS ─────────────────────────────────────

  describe("access control", function () {
    it("validateOrder rejects non-Diamond callers", async function () {
      await integrator.connect(merchant1).registerMerchant(UPI_1);
      await expect(
        integrator.connect(attacker).validateOrder(merchant1.address, UNIT_PRICE, INR)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
    });

    it("onOrderComplete rejects non-Diamond callers", async function () {
      await expect(
        integrator
          .connect(attacker)
          .onOrderComplete(1, merchant1.address, USDC(10), merchant1.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
    });

    it("onOrderCancel rejects non-Diamond callers", async function () {
      await expect(integrator.connect(attacker).onOrderCancel(1)).to.be.revertedWithCustomError(
        integrator,
        "OnlyDiamond"
      );
    });

    it("freeze/unfreeze reject non-owner callers", async function () {
      await expect(
        integrator.connect(attacker).freezeMerchant(merchant1.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
      await expect(
        integrator.connect(attacker).unfreezeMerchant(merchant1.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });

    it("constructor rejects zero addresses", async function () {
      const Integrator = await ethers.getContractFactory("MerchantTerminalIntegrator");
      await expect(
        Integrator.deploy(ethers.ZeroAddress, await mockUsdc.getAddress())
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      await expect(
        Integrator.deploy(await mockDiamond.getAddress(), ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    });
  });

  describe("withdrawal guards", function () {
    it("unregistered merchant cannot withdraw", async function () {
      await expect(
        integrator.connect(attacker).withdrawUSDC(USDC(1))
      ).to.be.revertedWithCustomError(integrator, "NotRegistered");
      await expect(integrator.connect(attacker).withdrawINR(USDC(1))).to.be.revertedWithCustomError(
        integrator,
        "NotRegistered"
      );
    });

    it("zero-amount withdrawal reverts NothingToWithdraw", async function () {
      await integrator.connect(merchant1).registerMerchant(UPI_1);
      await expect(integrator.connect(merchant1).withdrawUSDC(0)).to.be.revertedWithCustomError(
        integrator,
        "NothingToWithdraw"
      );
    });

    it("cannot withdraw locked funds (partial unlock respected)", async function () {
      await integrator.connect(merchant1).registerMerchant(UPI_1);
      // deposit 1 (will unlock), then deposit 2 (still locked)
      let o = await placeOrder(merchant1, 2);
      await mockDiamond.simulateOrderComplete(o);
      await increaseTime(SETTLEMENT + 100);
      o = await placeOrder(merchant1, 1);
      await mockDiamond.simulateOrderComplete(o);

      // 20 unlocked, 10 locked -> withdrawing 25 must fail, 20 ok
      await expect(
        integrator.connect(merchant1).withdrawUSDC(USDC(25))
      ).to.be.revertedWithCustomError(integrator, "InsufficientAvailableBalance");
      await integrator.connect(merchant1).withdrawUSDC(USDC(20));
      const [pending, available] = await integrator.getMerchantBalance(merchant1.address);
      expect(pending).to.equal(USDC(10));
      expect(available).to.equal(0);
    });

    it("oldest-first deduction across multiple unlocked buckets", async function () {
      await integrator.connect(merchant1).registerMerchant(UPI_1);
      for (let i = 0; i < 3; i++) {
        const o = await placeOrder(merchant1, 1); // 10 each
        await mockDiamond.simulateOrderComplete(o);
      }
      await increaseTime(SETTLEMENT + 100);
      // 30 unlocked across 3 buckets; withdraw 15 -> first bucket gone, second half
      await integrator.connect(merchant1).withdrawUSDC(USDC(15));
      const [, available] = await integrator.getMerchantBalance(merchant1.address);
      expect(available).to.equal(USDC(15));
      const buckets = await integrator.getMerchantBuckets(merchant1.address);
      // first bucket fully spent (0 or compacted away), remainder = 15
      const liveTotal = buckets.reduce((s: bigint, b: any) => s + b.amount, 0n);
      expect(liveTotal).to.equal(USDC(15));
    });
  });

  describe("INR withdrawal reconciliation (cancelled SELL order recovery)", function () {
    it("reconcileWithdrawal recovers funds when the SELL order is cancelled", async function () {
      await depositFor(merchant1, UPI_1, 2); // 20 USDC
      await increaseTime(SETTLEMENT + 3600);

      const tx = await integrator.connect(merchant1).withdrawINR(USDC(20));
      const receipt = await tx.wait();
      const ev = receipt.logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((l: any) => l?.name === "WithdrawalINR");
      const orderId = ev.args.orderId;

      // merchant balance is zero, funds parked on the MERCHANT'S OWN proxy
      expect((await integrator.getMerchantBalance(merchant1.address))[1]).to.equal(0);
      const merchantProxy = await integrator.proxyAddress(merchant1.address);
      expect(await mockUsdc.balanceOf(merchantProxy)).to.equal(USDC(20));

      // Diamond cancels the sell order (PLACED -> CANCELLED). Our integrator
      // funded the merchant proxy at placement, so the USDC sits there and
      // reconcileWithdrawal sweeps it back.
      await mockDiamond.cancelSellOrder(orderId);
      expect((await mockDiamond.getOrdersById(orderId)).status).to.equal(4); // CANCELLED

      // reconcile: sweeps proxy USDC back, re-credits merchant
      await expect(integrator.reconcileWithdrawal(orderId))
        .to.emit(integrator, "WithdrawalReconciled")
        .withArgs(merchant1.address, orderId, USDC(20));

      const [, available] = await integrator.getMerchantBalance(merchant1.address);
      expect(available).to.equal(USDC(20)); // fully recovered, immediately unlocked
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(USDC(20));
    });

    it("two in-flight INR withdrawals are physically isolated on per-merchant proxies (no cross-steal)", async function () {
      // m1 and m2 each withdraw INR; each funds their OWN proxy. Cancelling
      // m1's order recovers only m1's funds; m2's are on a different proxy and
      // cannot be touched — isolation is now structural, not amount-capped.
      await depositFor(merchant1, UPI_1, 2); // m1: 20
      await integrator.connect(merchant2).registerMerchant(UPI_2);
      const o2 = await placeOrder(merchant2, 3); // m2: 30
      await mockDiamond.simulateOrderComplete(o2);
      await increaseTime(SETTLEMENT + 3600);

      const grab = async (tx: any, name: string) => {
        const r = await tx.wait();
        return r.logs
          .map((l: any) => {
            try {
              return integrator.interface.parseLog(l);
            } catch {
              return null;
            }
          })
          .find((l: any) => l?.name === name).args.orderId;
      };
      const id1 = await grab(
        await integrator.connect(merchant1).withdrawINR(USDC(20)),
        "WithdrawalINR"
      );
      await grab(await integrator.connect(merchant2).withdrawINR(USDC(30)), "WithdrawalINR");

      const proxy1 = await integrator.proxyAddress(merchant1.address);
      const proxy2 = await integrator.proxyAddress(merchant2.address);
      // funds are on SEPARATE proxies — never commingled
      expect(await mockUsdc.balanceOf(proxy1)).to.equal(USDC(20));
      expect(await mockUsdc.balanceOf(proxy2)).to.equal(USDC(30));

      // cancel + reconcile only m1's
      await mockDiamond.cancelSellOrder(id1);
      await expect(integrator.reconcileWithdrawal(id1))
        .to.emit(integrator, "WithdrawalReconciled")
        .withArgs(merchant1.address, id1, USDC(20));

      // m1 got exactly 20 back from m1's proxy; m2's proxy is completely untouched
      expect((await integrator.getMerchantBalance(merchant1.address))[1]).to.equal(USDC(20));
      expect((await integrator.getMerchantBalance(merchant2.address))[1]).to.equal(0);
      expect(await mockUsdc.balanceOf(proxy1)).to.equal(0); // swept back
      expect(await mockUsdc.balanceOf(proxy2)).to.equal(USDC(30)); // m2's untouched
    });

    it("reconcileWithdrawal reverts for a non-cancelled order", async function () {
      await depositFor(merchant1, UPI_1, 2);
      await increaseTime(SETTLEMENT + 3600);
      const tx = await integrator.connect(merchant1).withdrawINR(USDC(20));
      const receipt = await tx.wait();
      const ev = receipt.logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((l: any) => l?.name === "WithdrawalINR");
      await expect(integrator.reconcileWithdrawal(ev.args.orderId)).to.be.revertedWithCustomError(
        integrator,
        "WithdrawalNotCancellable"
      );
    });

    it("reconcileWithdrawal reverts for unknown orderId", async function () {
      await expect(integrator.reconcileWithdrawal(424242)).to.be.revertedWithCustomError(
        integrator,
        "UnknownWithdrawal"
      );
    });

    it("reconcileWithdrawal cannot be replayed", async function () {
      await depositFor(merchant1, UPI_1, 2);
      await increaseTime(SETTLEMENT + 3600);
      const tx = await integrator.connect(merchant1).withdrawINR(USDC(20));
      const receipt = await tx.wait();
      const ev = receipt.logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((l: any) => l?.name === "WithdrawalINR");
      const orderId = ev.args.orderId;
      await mockDiamond.cancelSellOrder(orderId);
      await integrator.reconcileWithdrawal(orderId);
      await expect(integrator.reconcileWithdrawal(orderId)).to.be.revertedWithCustomError(
        integrator,
        "WithdrawalAlreadySettled"
      );
    });
  });

  describe("bucket bound (no unbounded-array DoS)", function () {
    it("spent buckets are compacted so the array stays bounded", async function () {
      await integrator.connect(merchant1).registerMerchant(UPI_1);
      // 5 deposits, unlock, withdraw all -> then deposit again; array must not
      // grow without bound (compaction removes spent buckets at the head)
      for (let i = 0; i < 4; i++) {
        const o = await placeOrder(merchant1, 1);
        await mockDiamond.simulateOrderComplete(o);
      }
      await increaseTime(SETTLEMENT + 100);
      await integrator.connect(merchant1).withdrawUSDC(USDC(40)); // empties all 4
      // next deposit triggers compaction -> array length should drop back to 1
      const o = await placeOrder(merchant1, 1);
      await mockDiamond.simulateOrderComplete(o);
      const buckets = await integrator.getMerchantBuckets(merchant1.address);
      expect(buckets.length).to.equal(1);
      expect(buckets[0].amount).to.equal(USDC(10));
    });

    it("compaction reclaims a spent bucket sitting BEHIND a still-locked bucket", async function () {
      await integrator.connect(merchant1).registerMerchant(UPI_1);
      // bucket A (will unlock), then bucket B (stays locked, sits in front of A
      // chronologically? no — A is older). Build: old unlocked A + newer locked B,
      // spend A fully, then deposit C. Interior zero (A) must be reclaimed even
      // though it is followed by locked B.
      let o = await placeOrder(merchant1, 1); // A = 10
      await mockDiamond.simulateOrderComplete(o);
      await increaseTime(SETTLEMENT + 100); // A now unlocked
      o = await placeOrder(merchant1, 2); // B = 20, locked (fresh 30-day)
      await mockDiamond.simulateOrderComplete(o);

      // spend A fully (10 unlocked available) -> A becomes a zero bucket at index 0,
      // B (locked) at index 1
      await integrator.connect(merchant1).withdrawUSDC(USDC(10));

      // deposit C -> _creditBucket compacts; A's zero must be removed
      o = await placeOrder(merchant1, 1); // C = 10
      await mockDiamond.simulateOrderComplete(o);

      const buckets = await integrator.getMerchantBuckets(merchant1.address);
      // should be exactly [B=20 locked, C=10 locked] — A reclaimed, no zeros
      expect(buckets.length).to.equal(2);
      for (const b of buckets) expect(b.amount).to.not.equal(0n);
      const total = buckets.reduce((s: bigint, b: any) => s + b.amount, 0n);
      expect(total).to.equal(USDC(30));
    });
  });

  describe("reentrancy", function () {
    it("withdrawUSDC has a nonReentrant guard (storage flag resets)", async function () {
      // two sequential withdrawals in separate txs both succeed (guard resets)
      await depositFor(merchant1, UPI_1, 4); // 40
      await increaseTime(SETTLEMENT + 100);
      await integrator.connect(merchant1).withdrawUSDC(USDC(20));
      await integrator.connect(merchant1).withdrawUSDC(USDC(20));
      expect((await integrator.getMerchantBalance(merchant1.address))[1]).to.equal(0);
    });
  });
});
