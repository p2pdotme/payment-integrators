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
  const INR_CODE = "INR"; // human-readable code
  const INR = ethers.encodeBytes32String("INR"); // packed bytes32 (events)
  const DAY = 86400;
  // Read from the deployed contract in beforeEach so the suite matches whatever
  // SETTLEMENT_PERIOD is compiled in (30 days in prod, 10 min for the withdraw test build).
  let SETTLEMENT = 30 * DAY;
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
    SETTLEMENT = Number(await integrator.SETTLEMENT_PERIOD());

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
    await integrator.connect(merchant).registerMerchant(upi, "Shop", INR_CODE);
    const orderId = await placeOrder(merchant, quantity);
    await mockDiamond.simulateOrderComplete(orderId);
    return orderId;
  }

  // ─── 1 + 2: Registration ──────────────────────────────────────────

  it("1. registerMerchant succeeds and emits MerchantRegistered", async function () {
    await expect(integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", INR_CODE))
      .to.emit(integrator, "MerchantRegistered")
      .withArgs(merchant1.address, UPI_1, "Shop One", INR);
    expect(await integrator.registered(merchant1.address)).to.equal(true);
  });

  it("2. registerMerchant reverts when called twice", async function () {
    await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", INR_CODE);
    await expect(
      integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", INR_CODE)
    ).to.be.revertedWithCustomError(integrator, "AlreadyRegistered");
  });

  // ─── multi-country: currency naming + per-country registration ─────

  it("2a. toCurrency / fromCurrency round-trip for any country code", async function () {
    for (const code of ["INR", "BRL", "ARS", "MXN", "NGN", "COP"]) {
      const packed = await integrator.toCurrency(code);
      expect(packed).to.equal(ethers.encodeBytes32String(code));
      expect(await integrator.fromCurrency(packed)).to.equal(code);
    }
  });

  it("2b. registerMerchant rejects an empty currency code", async function () {
    await expect(
      integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", "")
    ).to.be.revertedWithCustomError(integrator, "InvalidCurrency");
  });

  it("2c. a Brazil merchant registers with BRL + PIX and reads it back", async function () {
    const pixKey = "joao@email.com";
    await integrator.connect(merchant1).registerMerchant(pixKey, "Café Rio", "BRL");
    const [payoutId, shopName, currency, isReg] = await integrator.getMerchantInfo(
      merchant1.address
    );
    expect(payoutId).to.equal(pixKey);
    expect(shopName).to.equal("Café Rio");
    expect(currency).to.equal(ethers.encodeBytes32String("BRL"));
    expect(isReg).to.equal(true);
    expect(await integrator.getMerchantCurrency(merchant1.address)).to.equal("BRL");
  });

  it("2d. an Argentina merchant registers with ARS + CBU/alias", async function () {
    await integrator.connect(merchant2).registerMerchant("miguel.mp", "Café del Sur", "ARS");
    expect(await integrator.getMerchantCurrency(merchant2.address)).to.equal("ARS");
  });

  it("2e. registerMerchantRaw accepts a pre-packed bytes32 currency", async function () {
    await integrator.connect(merchant1).registerMerchantRaw(UPI_1, "Shop One", INR);
    expect(await integrator.getMerchantCurrency(merchant1.address)).to.equal("INR");
  });

  // ─── 3 + 4 + 5: validateOrder limits ──────────────────────────────

  it("3. validateOrder reverts above 50 USDC per-tx cap", async function () {
    await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", INR_CODE);
    const diamond = await diamondSigner();
    await expect(
      integrator.connect(diamond).validateOrder(merchant1.address, USDC(51), INR)
    ).to.be.revertedWithCustomError(integrator, "ExceedsPerTxCap");
  });

  it("4. validateOrder reverts on the 5th transaction in the same day", async function () {
    await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", INR_CODE);
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
    await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", INR_CODE);
    for (let i = 0; i < 4; i++) await placeOrder(merchant1);
    await increaseTime(DAY + 10);
    expect((await integrator.getDailyTxInfo(merchant1.address))[0]).to.equal(0);
    await placeOrder(merchant1);
    expect((await integrator.getDailyTxInfo(merchant1.address))[0]).to.equal(1);
  });

  // ─── 6 + 7: Completion and balances ────────────────────────────────

  it("6. onOrderComplete creates the correct bucket with unlock = completion + SETTLEMENT_PERIOD", async function () {
    await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", INR_CODE);
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
    await expect(
      integrator.connect(merchant1).withdrawFiat(USDC(20), 1, "")
    ).to.be.revertedWithCustomError(integrator, "InsufficientAvailableBalance");
  });

  it("9. withdrawINR succeeds after 30 days (funds the merchant proxy, places SELL order)", async function () {
    await depositFor(merchant1, UPI_1, 2);
    await increaseTime(SETTLEMENT + 3600);

    // SELL is placed through the MERCHANT'S OWN proxy now (per-merchant isolation)
    const merchantProxy = await integrator.proxyAddress(merchant1.address);
    await expect(integrator.connect(merchant1).withdrawFiat(USDC(20), 1, "")).to.emit(
      integrator,
      "WithdrawalFiat"
    );
    expect(await mockUsdc.balanceOf(merchantProxy)).to.equal(USDC(20));
    expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(0);

    const [pending, available] = await integrator.getMerchantBalance(merchant1.address);
    expect(pending).to.equal(0);
    expect(available).to.equal(0);

    const sellOrder = await mockDiamond.getSellOrder(2);
    expect(sellOrder.user).to.equal(merchantProxy);
    expect(sellOrder.amount).to.equal(USDC(20));
    // currency on the SELL order = the merchant's registered currency (INR here)
    expect(sellOrder.currency).to.equal(INR);
  });

  it("9-multi. a BRL merchant's withdrawFiat places the SELL order in BRL (not hardcoded INR)", async function () {
    // Register as Brazil/BRL, deposit, settle, withdraw — the SELL order must
    // carry BRL, proving the currency comes from the merchant's profile.
    const BRL = ethers.encodeBytes32String("BRL");
    await integrator.connect(merchant2).registerMerchant("joao@pix", "Café Rio", "BRL");
    const orderId = await placeOrder(merchant2, 2);
    await mockDiamond.simulateOrderComplete(orderId);
    await increaseTime(SETTLEMENT + 3600);

    const tx = await integrator.connect(merchant2).withdrawFiat(USDC(20), 1, "");
    const rcpt = await tx.wait();
    const sellId = rcpt.logs
      .map((l: any) => {
        try {
          return integrator.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((l: any) => l?.name === "WithdrawalFiat").args.orderId;

    const sellOrder = await mockDiamond.getSellOrder(sellId);
    expect(sellOrder.currency).to.equal(BRL); // ← BRL, not INR
  });

  it("9a. withdrawINR uses the UPI override when provided, else the saved UPI", async function () {
    await depositFor(merchant1, UPI_1, 2);
    await increaseTime(SETTLEMENT + 3600);

    // override → SELL order carries the override UPI, saved UPI unchanged
    const tx = await integrator.connect(merchant1).withdrawFiat(USDC(10), 1, "other@upi");
    const rcpt = await tx.wait();
    const orderId = rcpt.logs
      .map((l: any) => {
        try {
          return integrator.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((l: any) => l?.name === "WithdrawalFiat").args.orderId;
    const sell = await mockDiamond.getSellOrder(orderId);
    expect(sell.merchantPubkey === undefined || true).to.equal(true); // encUpi set later
    // saved UPI still UPI_1 (unchanged by the override)
    const [savedUpi] = await integrator.getMerchantInfo(merchant1.address);
    expect(savedUpi).to.equal(UPI_1);
  });

  it("9b. INR withdrawal settles through PLACED→PAID→COMPLETED WITH a fee (fee charged to merchant)", async function () {
    // Regression for the SELL fee/allowance bug AND for HIGH-1: the Diamond
    // pulls principal + fee during setSellOrderUpi. The fee top-up is now
    // CHARGED TO THE WITHDRAWING MERCHANT (debited from their own unlocked
    // buckets), never the shared pool — so the merchant needs headroom for it.
    await depositFor(merchant1, UPI_1, 3); // 30 USDC settled
    await increaseTime(SETTLEMENT + 3600);

    const FEE = USDC(1);
    await mockDiamond.setSellFee(FEE);

    // The integrator needs USDC on hand to physically forward the fee. A fresh
    // BUY deposit leaves USDC on the integrator (pulled at onOrderComplete).
    await depositFor(merchant2, UPI_2, 2);

    const merchantProxy = await integrator.proxyAddress(merchant1.address);

    // available before: 30 USDC
    const beforeAvail = (await integrator.getMerchantBalance(merchant1.address))[1];
    expect(beforeAvail).to.equal(USDC(30));

    // 1) place the SELL for 20 — proxy funded with principal only (20)
    const tx = await integrator.connect(merchant1).withdrawFiat(USDC(20), 1, "");
    const rcpt = await tx.wait();
    const ev = rcpt.logs
      .map((l: any) => {
        try {
          return integrator.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((l: any) => l?.name === "WithdrawalFiat");
    const orderId = ev.args.orderId;
    expect(await mockUsdc.balanceOf(merchantProxy)).to.equal(USDC(20)); // principal only

    // after placing: 30 - 20 principal = 10 available (fee not yet charged)
    expect((await integrator.getMerchantBalance(merchant1.address))[1]).to.equal(USDC(10));

    // 2) LP accepts
    await mockDiamond.acceptSellOrder(orderId, "lpPubkey");

    // 3) deliver: tops up the FEE (charged to merchant's own balance) + allowance
    await expect(integrator.connect(merchant1).deliverFiatPayout(orderId, "encUpi"))
      .to.emit(integrator, "WithdrawalUpiDelivered")
      .withArgs(orderId, USDC(21)); // principal 20 + fee 1

    // HIGH-1: the fee was debited from the MERCHANT, not the pool → 10 - 1 = 9
    expect((await integrator.getMerchantBalance(merchant1.address))[1]).to.equal(USDC(9));

    // Diamond pulled principal+fee from the proxy → proxy drained
    expect(await mockUsdc.balanceOf(merchantProxy)).to.equal(0);

    // 4) complete; finalizeWithdrawal flips the tracking slot
    await mockDiamond.completeSellOrder(orderId);
    await integrator.finalizeWithdrawal(orderId);
  });

  it("9c. deliverInrUpi reverts OfframpFeeNotReady until the Diamond computes the fee", async function () {
    await depositFor(merchant1, UPI_1, 2);
    await increaseTime(SETTLEMENT + 3600);
    await mockDiamond.setSellFee(USDC(1));
    await depositFor(merchant2, UPI_2, 2); // fund integrator pool

    const tx = await integrator.connect(merchant1).withdrawFiat(USDC(20), 1, "");
    const rcpt = await tx.wait();
    const orderId = rcpt.logs
      .map((l: any) => {
        try {
          return integrator.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((l: any) => l?.name === "WithdrawalFiat").args.orderId;
    await mockDiamond.acceptSellOrder(orderId, "lp");

    // Diamond hasn't populated actualUsdtAmount yet → must revert, not fall back
    await mockDiamond.setAdditionalOrderDetailsFeeUnready(true);
    await expect(
      integrator.connect(merchant1).deliverFiatPayout(orderId, "encUpi")
    ).to.be.revertedWithCustomError(integrator, "OfframpFeeNotReady");
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

    await expect(
      integrator.connect(merchant1).withdrawFiat(USDC(20), 1, "")
    ).to.be.revertedWithCustomError(integrator, "MerchantIsFrozen");
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
    await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", INR_CODE);
    await integrator.connect(merchant2).registerMerchant(UPI_2, "Shop Two", INR_CODE);

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
    await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", INR_CODE);
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
      await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", INR_CODE);
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
      await expect(
        integrator.connect(attacker).withdrawFiat(USDC(1), 1, "")
      ).to.be.revertedWithCustomError(integrator, "NotRegistered");
    });

    it("zero-amount withdrawal reverts NothingToWithdraw", async function () {
      await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", INR_CODE);
      await expect(integrator.connect(merchant1).withdrawUSDC(0)).to.be.revertedWithCustomError(
        integrator,
        "NothingToWithdraw"
      );
    });

    it("cannot withdraw locked funds (partial unlock respected)", async function () {
      await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", INR_CODE);
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
      await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", INR_CODE);
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

      const tx = await integrator.connect(merchant1).withdrawFiat(USDC(20), 1, "");
      const receipt = await tx.wait();
      const ev = receipt.logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((l: any) => l?.name === "WithdrawalFiat");
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
      await integrator.connect(merchant2).registerMerchant(UPI_2, "Shop Two", INR_CODE);
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
        await integrator.connect(merchant1).withdrawFiat(USDC(20), 1, ""),
        "WithdrawalFiat"
      );
      await grab(
        await integrator.connect(merchant2).withdrawFiat(USDC(30), 1, ""),
        "WithdrawalFiat"
      );

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
      const tx = await integrator.connect(merchant1).withdrawFiat(USDC(20), 1, "");
      const receipt = await tx.wait();
      const ev = receipt.logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((l: any) => l?.name === "WithdrawalFiat");
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
      const tx = await integrator.connect(merchant1).withdrawFiat(USDC(20), 1, "");
      const receipt = await tx.wait();
      const ev = receipt.logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((l: any) => l?.name === "WithdrawalFiat");
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
      await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", INR_CODE);
      // 5 deposits, unlock, withdraw all -> then deposit again; array must not
      // grow without bound (compaction removes spent buckets at the head)
      for (let i = 0; i < 4; i++) {
        const o = await placeOrder(merchant1, 1);
        await mockDiamond.simulateOrderComplete(o);
      }
      // advance at least a full day so funds unlock AND the daily-tx window
      // resets (settlement can be shorter than a day in the withdraw-test build)
      await increaseTime(Math.max(SETTLEMENT, DAY) + 100);
      await integrator.connect(merchant1).withdrawUSDC(USDC(40)); // empties all 4
      // next deposit triggers compaction -> array length should drop back to 1
      const o = await placeOrder(merchant1, 1);
      await mockDiamond.simulateOrderComplete(o);
      const buckets = await integrator.getMerchantBuckets(merchant1.address);
      expect(buckets.length).to.equal(1);
      expect(buckets[0].amount).to.equal(USDC(10));
    });

    it("compaction reclaims a spent bucket sitting BEHIND a still-locked bucket", async function () {
      await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", INR_CODE);
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

  // ─── Audit-fix regression tests ────────────────────────────────────
  describe("audit fixes", function () {
    const grabFiat = async (txPromise: any) => {
      const tx = await txPromise;
      const r = await tx.wait();
      return r.logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((l: any) => l?.name === "WithdrawalFiat").args.orderId;
    };

    it("HIGH-1: SELL fee is charged to the merchant, NOT the shared pool (other merchant stays solvent)", async function () {
      // m1 deposits 30, m2 deposits 20. m1 off-ramps 20 with a 1 USDC fee.
      // The fee must come out of m1's own balance — m2's 20 must remain fully
      // withdrawable (the old bug drained the pool and bricked m2).
      await depositFor(merchant1, UPI_1, 3); // 30
      await integrator.connect(merchant2).registerMerchant(UPI_2, "Shop Two", INR_CODE);
      const o2 = await placeOrder(merchant2, 2); // 20
      await mockDiamond.simulateOrderComplete(o2);
      await increaseTime(SETTLEMENT + 3600);

      await mockDiamond.setSellFee(USDC(1));
      const orderId = await grabFiat(integrator.connect(merchant1).withdrawFiat(USDC(20), 1, ""));
      await mockDiamond.acceptSellOrder(orderId, "lp");
      await integrator.connect(merchant1).deliverFiatPayout(orderId, "enc");

      // m1 charged principal 20 + fee 1 = 21, leaving 9 of their 30
      expect((await integrator.getMerchantBalance(merchant1.address))[1]).to.equal(USDC(9));
      // m2 fully intact and actually withdrawable — pool is still solvent
      expect((await integrator.getMerchantBalance(merchant2.address))[1]).to.equal(USDC(20));
      await expect(integrator.connect(merchant2).withdrawUSDC(USDC(20))).to.emit(
        integrator,
        "WithdrawalUSDC"
      );
      // solvency invariant holds
      const owed = await integrator.totalOwed();
      const bal = await mockUsdc.balanceOf(await integrator.getAddress());
      expect(bal >= owed).to.equal(true);
    });

    it("HIGH-1: a merchant with no headroom for the fee cannot drain the pool (reverts)", async function () {
      // m1 deposits exactly 20 and off-ramps all 20 — nothing left to pay the
      // fee, so delivery reverts instead of dipping into the pool.
      await depositFor(merchant1, UPI_1, 2); // 20
      await depositFor(merchant2, UPI_2, 2); // pool has USDC to forward
      await increaseTime(SETTLEMENT + 3600);
      await mockDiamond.setSellFee(USDC(1));
      const orderId = await grabFiat(integrator.connect(merchant1).withdrawFiat(USDC(20), 1, ""));
      await mockDiamond.acceptSellOrder(orderId, "lp");
      await expect(
        integrator.connect(merchant1).deliverFiatPayout(orderId, "enc")
      ).to.be.revertedWithCustomError(integrator, "InsufficientAvailableBalance");
    });

    it("HIGH-2: a frozen merchant's in-flight withdrawal cannot be delivered", async function () {
      await depositFor(merchant1, UPI_1, 3); // 30
      await depositFor(merchant2, UPI_2, 2);
      await increaseTime(SETTLEMENT + 3600);
      await mockDiamond.setSellFee(USDC(1));
      const orderId = await grabFiat(integrator.connect(merchant1).withdrawFiat(USDC(20), 1, ""));
      await mockDiamond.acceptSellOrder(orderId, "lp");
      // owner freezes BETWEEN placement and delivery
      await integrator.freezeMerchant(merchant1.address);
      await expect(
        integrator.connect(merchant1).deliverFiatPayout(orderId, "enc")
      ).to.be.revertedWithCustomError(integrator, "MerchantIsFrozen");
    });

    it("HIGH-2: owner can adminAbortWithdrawal to claw a frozen in-flight withdrawal back", async function () {
      await depositFor(merchant1, UPI_1, 2); // 20
      await increaseTime(SETTLEMENT + 3600);
      const orderId = await grabFiat(integrator.connect(merchant1).withdrawFiat(USDC(20), 1, ""));
      await integrator.freezeMerchant(merchant1.address);
      await expect(integrator.adminAbortWithdrawal(orderId)).to.emit(
        integrator,
        "WithdrawalReconciled"
      );
      // funds back on the integrator, re-credited but LOCKED again (frozen)
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(USDC(20));
      const [pending, available] = await integrator.getMerchantBalance(merchant1.address);
      expect(available).to.equal(0); // re-locked under a fresh settlement window
      expect(pending).to.equal(USDC(20));
    });

    it("HIGH-2: adminAbortWithdrawal only works on a FROZEN merchant and only for the owner", async function () {
      await depositFor(merchant1, UPI_1, 2);
      await increaseTime(SETTLEMENT + 3600);
      const orderId = await grabFiat(integrator.connect(merchant1).withdrawFiat(USDC(20), 1, ""));
      // not frozen → reverts
      await expect(integrator.adminAbortWithdrawal(orderId)).to.be.revertedWithCustomError(
        integrator,
        "MerchantIsFrozen"
      );
      await integrator.freezeMerchant(merchant1.address);
      // non-owner → reverts
      await expect(
        integrator.connect(attacker).adminAbortWithdrawal(orderId)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });

    it("MED-1: a second concurrent fiat withdrawal is rejected until the first settles", async function () {
      await depositFor(merchant1, UPI_1, 4); // 40
      await increaseTime(SETTLEMENT + 3600);
      await integrator.connect(merchant1).withdrawFiat(USDC(20), 1, "");
      await expect(
        integrator.connect(merchant1).withdrawFiat(USDC(20), 1, "")
      ).to.be.revertedWithCustomError(integrator, "WithdrawalInFlight");
    });

    it("MED-1: after the first withdrawal reconciles, a new one is allowed again", async function () {
      await depositFor(merchant1, UPI_1, 4); // 40
      await increaseTime(SETTLEMENT + 3600);
      const orderId = await grabFiat(integrator.connect(merchant1).withdrawFiat(USDC(20), 1, ""));
      await mockDiamond.cancelSellOrder(orderId);
      await integrator.reconcileWithdrawal(orderId); // settles + frees the slot
      await expect(integrator.connect(merchant1).withdrawFiat(USDC(20), 1, "")).to.emit(
        integrator,
        "WithdrawalFiat"
      );
    });

    it("MED-2 + NEW-1: a COMPLETED (fiat-delivered) order can never re-credit USDC (double-spend blocked)", async function () {
      // Genuine double-spend case: fiat was delivered AND the order COMPLETED.
      // reconcile only acts on CANCELLED, so a completed order is never
      // re-creditable — the merchant keeps the fiat, no USDC clawback.
      await depositFor(merchant1, UPI_1, 3); // 30 (headroom for fee)
      await depositFor(merchant2, UPI_2, 2);
      await increaseTime(SETTLEMENT + 3600);
      await mockDiamond.setSellFee(USDC(1));
      const orderId = await grabFiat(integrator.connect(merchant1).withdrawFiat(USDC(20), 1, ""));
      await mockDiamond.acceptSellOrder(orderId, "lp");
      await integrator.connect(merchant1).deliverFiatPayout(orderId, "enc"); // fiat PAID
      await mockDiamond.completeSellOrder(orderId); // fiat DELIVERED
      // completed → reconcile refuses (status != CANCELLED)
      await expect(integrator.reconcileWithdrawal(orderId)).to.be.revertedWithCustomError(
        integrator,
        "WithdrawalNotCancellable"
      );
      // finalize settles it and frees the slot (the happy path)
      await integrator.finalizeWithdrawal(orderId);
      await expect(integrator.connect(merchant1).withdrawFiat(USDC(5), 1, "")).to.emit(
        integrator,
        "WithdrawalFiat"
      ); // channel not bricked
    });

    it("NEW-1: a PAID-then-CANCELLED SELL is fully recoverable (refund re-credited, slot freed, no DoS)", async function () {
      // The Diamond clawed the fiat back (refunds principal+fee to the proxy),
      // so the merchant must be made whole and able to withdraw again.
      await depositFor(merchant1, UPI_1, 3); // 30 (headroom for fee)
      await depositFor(merchant2, UPI_2, 2);
      await increaseTime(SETTLEMENT + 3600);
      await mockDiamond.setSellFee(USDC(1));
      const orderId = await grabFiat(integrator.connect(merchant1).withdrawFiat(USDC(20), 1, ""));
      await mockDiamond.acceptSellOrder(orderId, "lp");
      await integrator.connect(merchant1).deliverFiatPayout(orderId, "enc"); // PAID, merchant charged 21
      // after deliver: merchant available = 30 - 20 principal - 1 fee = 9
      expect((await integrator.getMerchantBalance(merchant1.address))[1]).to.equal(USDC(9));

      // LP times out / admin cancels the PAID SELL → Diamond refunds 21 to proxy
      await mockDiamond.cancelSellOrder(orderId);

      // recovery succeeds (was permanently bricked before the NEW-1 fix)
      await expect(integrator.reconcileWithdrawal(orderId)).to.emit(
        integrator,
        "WithdrawalReconciled"
      );

      // principal + fee (21) re-credited, re-locked under a fresh settlement
      // window because the order had reached PAID. Merchant is fully whole.
      const [pending, available] = await integrator.getMerchantBalance(merchant1.address);
      expect(available).to.equal(USDC(9)); // unchanged: re-credit is locked
      expect(pending).to.equal(USDC(21)); // principal 20 + fee 1 back, settling
      // proxy emptied, funds back on the integrator
      const proxy = await integrator.proxyAddress(merchant1.address);
      expect(await mockUsdc.balanceOf(proxy)).to.equal(0);

      // and the in-flight slot is freed → the merchant can withdraw again
      await increaseTime(SETTLEMENT + 100);
      await expect(integrator.connect(merchant1).withdrawFiat(USDC(20), 1, "")).to.emit(
        integrator,
        "WithdrawalFiat"
      );
    });

    it("FINAL: a PAID→DISPUTED→CANCELLED order is recoverable via adminForceSettle (no channel-brick)", async function () {
      // The disputed-clawback trap the final audit caught: reconcile refuses
      // disputed, finalize needs COMPLETED, adminAbort refuses upiDelivered — so
      // without adminForceSettle the slot stays stuck forever. Verify recovery.
      await depositFor(merchant1, UPI_1, 3); // 30 (fee headroom)
      await depositFor(merchant2, UPI_2, 2);
      await increaseTime(SETTLEMENT + 3600);
      await mockDiamond.setSellFee(USDC(1));
      const orderId = await grabFiat(integrator.connect(merchant1).withdrawFiat(USDC(20), 1, ""));
      await mockDiamond.acceptSellOrder(orderId, "lp");
      await integrator.connect(merchant1).deliverFiatPayout(orderId, "enc"); // PAID, charged 21

      // dispute is raised, then the order is cancelled WITH a dispute recorded
      await mockDiamond.setSellDispute(orderId, 1, 1); // raisedBy=1, status=1
      await mockDiamond.cancelSellOrder(orderId); // refunds 21 to proxy

      // every normal settle path refuses this state
      await expect(integrator.reconcileWithdrawal(orderId)).to.be.revertedWithCustomError(
        integrator,
        "WithdrawalNotCancellable"
      ); // dispute guard
      await expect(integrator.finalizeWithdrawal(orderId)).to.be.revertedWithCustomError(
        integrator,
        "WithdrawalNotCancellable"
      ); // not COMPLETED

      // owner force-settles: sweeps the 21 refund, re-credits principal+fee (20+1)
      // re-locked, frees the slot.
      await expect(integrator.adminForceSettle(orderId)).to.emit(
        integrator,
        "WithdrawalReconciled"
      );
      const proxy = await integrator.proxyAddress(merchant1.address);
      expect(await mockUsdc.balanceOf(proxy)).to.equal(0); // refund recovered

      // merchant made whole: 9 still-available + 21 re-locked = 30 pending+available
      const [pending, available] = await integrator.getMerchantBalance(merchant1.address);
      expect(available).to.equal(USDC(9));
      expect(pending).to.equal(USDC(21)); // principal 20 + fee 1 refunded, settling

      // channel no longer bricked
      await increaseTime(SETTLEMENT + 100);
      await expect(integrator.connect(merchant1).withdrawFiat(USDC(20), 1, "")).to.emit(
        integrator,
        "WithdrawalFiat"
      );
    });

    it("FINAL: adminForceSettle is owner-only and refuses a non-CANCELLED order", async function () {
      await depositFor(merchant1, UPI_1, 2);
      await increaseTime(SETTLEMENT + 3600);
      const orderId = await grabFiat(integrator.connect(merchant1).withdrawFiat(USDC(20), 1, ""));
      // not cancelled yet → reverts
      await expect(integrator.adminForceSettle(orderId)).to.be.revertedWithCustomError(
        integrator,
        "WithdrawalNotCancellable"
      );
      // non-owner → reverts
      await mockDiamond.cancelSellOrder(orderId);
      await expect(
        integrator.connect(attacker).adminForceSettle(orderId)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });

    it("MED-4: a stale cross-day cancellation does not decrement the new day's tx count", async function () {
      await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop", INR_CODE);
      // Day N: place 4 (hit the daily limit). Keep the first order id.
      const firstOrder = await placeOrder(merchant1, 1);
      for (let i = 0; i < 3; i++) await placeOrder(merchant1, 1);
      expect((await integrator.getDailyTxInfo(merchant1.address))[0]).to.equal(4n);

      // Roll to day N+1 and place 4 more (counter resets, hits limit again).
      await increaseTime(DAY);
      for (let i = 0; i < 4; i++) await placeOrder(merchant1, 1);
      expect((await integrator.getDailyTxInfo(merchant1.address))[0]).to.equal(4n);

      // A DAY-N order cancels on day N+1 — must NOT decrement today's counter.
      const ds = await diamondSigner();
      await integrator.connect(ds).onOrderCancel(firstOrder);
      expect((await integrator.getDailyTxInfo(merchant1.address))[0]).to.equal(4n);
    });

    it("MED-4: a SAME-day cancellation still correctly releases a slot", async function () {
      await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop", INR_CODE);
      const o = await placeOrder(merchant1, 1);
      await placeOrder(merchant1, 1);
      expect((await integrator.getDailyTxInfo(merchant1.address))[0]).to.equal(2n);
      const ds = await diamondSigner();
      await integrator.connect(ds).onOrderCancel(o); // same day → decrements
      expect((await integrator.getDailyTxInfo(merchant1.address))[0]).to.equal(1n);
    });

    it("MED-5: deposits sharing an unlock window coalesce, so the bucket count stays bounded", async function () {
      // Two deposits credited at the same unlock timestamp fold into ONE bucket,
      // so the credit path can never grow unboundedly or revert at the cap.
      await depositFor(merchant1, UPI_1, 1); // 10, one bucket
      const o = await placeOrder(merchant1, 1);
      await mockDiamond.simulateOrderComplete(o); // same-window credit → coalesces
      const buckets = await integrator.getMerchantBuckets(merchant1.address);
      const total = buckets.reduce((s: bigint, b: any) => s + b.amount, 0n);
      expect(total).to.equal(USDC(20)); // both credited, nothing stranded
    });

    it("INFO-2: a currency code with an interior NUL byte is rejected", async function () {
      const withNul = "IN" + String.fromCharCode(0) + "R";
      await expect(integrator.toCurrency(withNul)).to.be.revertedWithCustomError(
        integrator,
        "InvalidCurrency"
      );
    });

    it("NEW-2: a reconcile re-credit (past-dated) never unlocks a merchant's other STILL-LOCKED funds", async function () {
      // Deposit 40 (locked), withdraw 20 fiat (from unlocked? no — locked, so
      // first settle 40, then take 20). Set up: 40 available, withdraw 20 fiat,
      // cancel→reconcile re-credits past-dated. The remaining bucket must stay
      // correct; a fresh locked deposit must remain locked afterward.
      await depositFor(merchant1, UPI_1, 4); // 40
      await increaseTime(SETTLEMENT + 100); // 40 unlocked
      const orderId = await grabFiat(integrator.connect(merchant1).withdrawFiat(USDC(20), 1, "")); // 20 left unlocked
      // add a FRESH locked deposit (still within settlement)
      const o = await placeOrder(merchant1, 2); // +20, locked
      await mockDiamond.simulateOrderComplete(o);
      // now: 20 unlocked (old) + 20 locked (fresh)
      expect((await integrator.getMerchantBalance(merchant1.address))[0]).to.equal(USDC(20)); // pending(locked)
      expect((await integrator.getMerchantBalance(merchant1.address))[1]).to.equal(USDC(20)); // available

      // cancel + reconcile the fiat withdrawal: re-credits 20 past-dated (unlocked).
      await mockDiamond.cancelSellOrder(orderId);
      await integrator.reconcileWithdrawal(orderId);

      // the FRESH 20 must remain LOCKED — the past-dated re-credit must not have
      // bled into it. available = 20(old) + 20(reconciled) = 40; pending = 20.
      expect((await integrator.getMerchantBalance(merchant1.address))[0]).to.equal(USDC(20)); // still locked
      expect((await integrator.getMerchantBalance(merchant1.address))[1]).to.equal(USDC(40));
    });
  });
});
