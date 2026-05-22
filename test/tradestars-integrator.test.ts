import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("TradeStarsCheckoutIntegrator", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let user2: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let integrator: any;

  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
  const BASE_TX_LIMIT = USDC(50);
  const DAILY_COUNT_LIMIT = 10;
  const INR = ethers.encodeBytes32String("INR");
  const BRL = ethers.encodeBytes32String("BRL");

  // Sample Solana pubkey (32 bytes)
  const SOLANA_RECIPIENT = "0x" + "11".repeat(32);
  const SOLANA_RECIPIENT_2 = "0x" + "22".repeat(32);

  beforeEach(async function () {
    [owner, user, user2] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUsdc = await MockUSDC.deploy();

    const MockDiamond = await ethers.getContractFactory("MockDiamond");
    mockDiamond = await MockDiamond.deploy(await mockUsdc.getAddress());

    const Integrator = await ethers.getContractFactory("TradeStarsCheckoutIntegrator");
    integrator = await Integrator.deploy(
      await mockDiamond.getAddress(),
      await mockUsdc.getAddress(),
      BASE_TX_LIMIT,
      DAILY_COUNT_LIMIT
    );

    await mockDiamond.registerIntegrator(
      await integrator.getAddress(),
      await integrator.proxyImpl()
    );
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(10000));
  });

  describe("Order Placement", function () {
    it("places order with Solana recipient", async function () {
      await integrator.connect(user).userPlaceOrder(SOLANA_RECIPIENT, USDC(10), INR, 1, "", 0, 0);

      const session = await integrator.sessions(1);
      expect(session.user).to.equal(user.address);
      expect(session.solanaRecipient).to.equal(SOLANA_RECIPIENT);
      expect(session.usdcAmount).to.equal(USDC(10));
      expect(session.fulfilled).to.equal(false);
    });

    it("emits CheckoutOrderCreated with all three indexed fields", async function () {
      await expect(
        integrator.connect(user).userPlaceOrder(SOLANA_RECIPIENT, USDC(10), INR, 1, "", 0, 0)
      )
        .to.emit(integrator, "CheckoutOrderCreated")
        .withArgs(1, user.address, SOLANA_RECIPIENT, USDC(10));
    });

    it("reverts on zero Solana recipient", async function () {
      await expect(
        integrator.connect(user).userPlaceOrder(ethers.ZeroHash, USDC(10), INR, 1, "", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "InvalidSolanaRecipient");
    });

    it("reverts on zero amount", async function () {
      await expect(
        integrator.connect(user).userPlaceOrder(SOLANA_RECIPIENT, 0, INR, 1, "", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "InvalidAmount");
    });

    it("rejects amount above per-tx limit", async function () {
      // 0 RP → baseTxLimit = 50 USDC. 51 USDC exceeds.
      await expect(
        integrator.connect(user).userPlaceOrder(SOLANA_RECIPIENT, USDC(51), INR, 1, "", 0, 0)
      ).to.be.reverted;
    });
  });

  describe("Order Completion", function () {
    it("marks fulfilled and emits CheckoutFulfilled with Solana pubkey", async function () {
      await integrator.connect(user).userPlaceOrder(SOLANA_RECIPIENT, USDC(10), INR, 1, "", 0, 0);

      await expect(mockDiamond.simulateOrderComplete(1))
        .to.emit(integrator, "CheckoutFulfilled")
        .withArgs(1, SOLANA_RECIPIENT, USDC(10));

      const session = await integrator.sessions(1);
      expect(session.fulfilled).to.equal(true);
    });

    it("USDC accumulates in integrator (escrow not wired)", async function () {
      await integrator.connect(user).userPlaceOrder(SOLANA_RECIPIENT, USDC(10), INR, 1, "", 0, 0);
      await mockDiamond.simulateOrderComplete(1);

      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(USDC(10));
    });

    it("reverts on double fulfillment", async function () {
      await integrator.connect(user).userPlaceOrder(SOLANA_RECIPIENT, USDC(10), INR, 1, "", 0, 0);
      await mockDiamond.simulateOrderComplete(1);

      await expect(mockDiamond.simulateOrderComplete(1)).to.be.reverted;
    });

    it("rejects onOrderComplete from non-Diamond", async function () {
      await expect(
        integrator.connect(user).onOrderComplete(1, user.address, USDC(10), ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
    });
  });

  describe("Per-TX Limit", function () {
    it("uses baseTxLimit for 0 RP", async function () {
      expect(await integrator.getUserTxLimit(user.address, INR)).to.equal(BASE_TX_LIMIT);
    });

    it("RP > 0 → RP × rate", async function () {
      await integrator.setUserRP(user.address, 20);
      await integrator.setRpToUsdc(INR, USDC(1));
      expect(await integrator.getUserTxLimit(user.address, INR)).to.equal(USDC(20));
    });

    it("different rates per currency", async function () {
      await integrator.setUserRP(user.address, 10);
      await integrator.setRpToUsdc(INR, USDC(1));
      await integrator.setRpToUsdc(BRL, USDC(2));
      expect(await integrator.getUserTxLimit(user.address, INR)).to.equal(USDC(10));
      expect(await integrator.getUserTxLimit(user.address, BRL)).to.equal(USDC(20));
    });

    it("caps at maxTxLimit", async function () {
      await integrator.setUserRP(user.address, 1000);
      await integrator.setRpToUsdc(INR, USDC(1));
      await integrator.setMaxTxLimit(INR, USDC(100));
      expect(await integrator.getUserTxLimit(user.address, INR)).to.equal(USDC(100));
    });
  });

  describe("Daily TX Count Limit", function () {
    it("tracks count per order", async function () {
      await integrator.connect(user).userPlaceOrder(SOLANA_RECIPIENT, USDC(10), INR, 1, "", 0, 0);
      await integrator.connect(user).userPlaceOrder(SOLANA_RECIPIENT, USDC(10), INR, 1, "", 0, 0);
      expect(await integrator.getTodayCount(user.address)).to.equal(2);
    });

    it("enforces daily count limit", async function () {
      for (let i = 0; i < DAILY_COUNT_LIMIT; i++) {
        await integrator.connect(user).userPlaceOrder(SOLANA_RECIPIENT, USDC(10), INR, 1, "", 0, 0);
      }
      await expect(
        integrator.connect(user).userPlaceOrder(SOLANA_RECIPIENT, USDC(10), INR, 1, "", 0, 0)
      ).to.be.reverted;
    });

    it("tracks per-user independently", async function () {
      for (let i = 0; i < DAILY_COUNT_LIMIT; i++) {
        await integrator.connect(user).userPlaceOrder(SOLANA_RECIPIENT, USDC(10), INR, 1, "", 0, 0);
      }
      // user2 should still be able to place orders
      await integrator
        .connect(user2)
        .userPlaceOrder(SOLANA_RECIPIENT_2, USDC(10), INR, 1, "", 0, 0);
      expect(await integrator.getTodayCount(user2.address)).to.equal(1);
    });
  });

  describe("Admin Functions", function () {
    it("setBaseTxLimit", async function () {
      await expect(integrator.setBaseTxLimit(USDC(100)))
        .to.emit(integrator, "BaseTxLimitUpdated")
        .withArgs(USDC(100));
    });
    it("setDailyTxCountLimit", async function () {
      await expect(integrator.setDailyTxCountLimit(20))
        .to.emit(integrator, "DailyTxCountLimitUpdated")
        .withArgs(20);
    });
    it("setRpToUsdc", async function () {
      await expect(integrator.setRpToUsdc(INR, USDC(2)))
        .to.emit(integrator, "RpRateUpdated")
        .withArgs(INR, USDC(2));
    });
    it("setMaxTxLimit", async function () {
      await expect(integrator.setMaxTxLimit(INR, USDC(500)))
        .to.emit(integrator, "MaxTxLimitUpdated")
        .withArgs(INR, USDC(500));
    });
    it("setUserRP", async function () {
      await expect(integrator.setUserRP(user.address, 100))
        .to.emit(integrator, "UserRPUpdated")
        .withArgs(user.address, 100);
    });
    it("batchSetUserRP", async function () {
      await integrator.batchSetUserRP([user.address, user2.address], [50, 75]);
      expect(await integrator.userRP(user.address)).to.equal(50);
      expect(await integrator.userRP(user2.address)).to.equal(75);
    });
    it("rejects non-owner", async function () {
      await expect(
        integrator.connect(user).setBaseTxLimit(USDC(100))
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });
  });

  describe("Full Flow", function () {
    it("place → complete → CheckoutFulfilled fires with Solana pubkey + amount", async function () {
      const tx = await integrator
        .connect(user)
        .userPlaceOrder(SOLANA_RECIPIENT, USDC(25), INR, 1, "", 0, 0);
      await tx.wait();

      await expect(mockDiamond.simulateOrderComplete(1))
        .to.emit(integrator, "CheckoutFulfilled")
        .withArgs(1, SOLANA_RECIPIENT, USDC(25));

      const session = await integrator.sessions(1);
      expect(session.fulfilled).to.equal(true);
      expect(session.solanaRecipient).to.equal(SOLANA_RECIPIENT);
    });
  });

  describe("Branch coverage — constructor + admin reverts + lifecycle gates", function () {
    describe("constructor", function () {
      it("reverts InvalidAddress when diamond is zero", async function () {
        const Integrator = await ethers.getContractFactory("TradeStarsCheckoutIntegrator");
        await expect(
          Integrator.deploy(ethers.ZeroAddress, await mockUsdc.getAddress(), BASE_TX_LIMIT, 10)
        ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      });
      it("reverts InvalidAddress when usdc is zero", async function () {
        const Integrator = await ethers.getContractFactory("TradeStarsCheckoutIntegrator");
        await expect(
          Integrator.deploy(await mockDiamond.getAddress(), ethers.ZeroAddress, BASE_TX_LIMIT, 10)
        ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      });
    });

    describe("admin onlyOwner reverts", function () {
      it("setDailyTxCountLimit non-owner reverts", async function () {
        await expect(
          integrator.connect(user).setDailyTxCountLimit(99)
        ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
      });
      it("setRpToUsdc non-owner reverts", async function () {
        await expect(
          integrator.connect(user).setRpToUsdc(INR, USDC(1))
        ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
      });
      it("setMaxTxLimit non-owner reverts", async function () {
        await expect(
          integrator.connect(user).setMaxTxLimit(INR, USDC(1))
        ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
      });
      it("setUserRP non-owner reverts", async function () {
        await expect(
          integrator.connect(user).setUserRP(user.address, 1)
        ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
      });
      it("batchSetUserRP non-owner reverts", async function () {
        await expect(
          integrator.connect(user).batchSetUserRP([user.address], [1])
        ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
      });
    });

    describe("batchSetUserRP", function () {
      it("reverts ArrayLengthMismatch on uneven inputs", async function () {
        await expect(
          integrator.batchSetUserRP([user.address, user2.address], [1])
        ).to.be.revertedWithCustomError(integrator, "ArrayLengthMismatch");
      });
    });

    describe("onOrderCancel gates", function () {
      it("reverts OnlyDiamond when caller isn't the Diamond", async function () {
        await integrator.connect(user).userPlaceOrder(SOLANA_RECIPIENT, USDC(10), INR, 1, "", 0, 0);
        await expect(integrator.connect(user).onOrderCancel(1)).to.be.revertedWithCustomError(
          integrator,
          "OnlyDiamond"
        );
      });
      it("reverts OrderAlreadyFulfilled when cancelling after completion", async function () {
        await integrator.connect(user).userPlaceOrder(SOLANA_RECIPIENT, USDC(10), INR, 1, "", 0, 0);
        await mockDiamond.simulateOrderComplete(1);
        await expect(mockDiamond.simulateOrderCancelled(1)).to.be.reverted;
      });
      it("reverts OrderAlreadyCancelled when cancelling twice", async function () {
        await integrator.connect(user).userPlaceOrder(SOLANA_RECIPIENT, USDC(10), INR, 1, "", 0, 0);
        await mockDiamond.simulateOrderCancelled(1);
        await expect(mockDiamond.simulateOrderCancelled(1)).to.be.reverted;
      });
      it("emits OrderCancelled with orderId and user (audit fix S2)", async function () {
        await integrator.connect(user).userPlaceOrder(SOLANA_RECIPIENT, USDC(10), INR, 1, "", 0, 0);
        await expect(mockDiamond.simulateOrderCancelled(1))
          .to.emit(integrator, "OrderCancelled")
          .withArgs(1, user.address);
      });
    });

    describe("onOrderComplete defense-in-depth (audit fixes B3 + S1)", function () {
      // Drive onOrderComplete directly via the MockDiamond test helper so
      // we can supply arbitrary args — the BUY callback is `onlyDiamond`
      // and these adversarial inputs aren't reachable through the normal
      // gateway flow.

      it("reverts UnknownOrder when Diamond delivers a completion for a never-placed order", async function () {
        // No session exists for orderId=999 → integrator must refuse to
        // operate on a zero-init session.
        await expect(
          mockDiamond.adminCallOnOrderComplete(
            await integrator.getAddress(),
            999,
            user.address,
            USDC(10),
            user.address
          )
        ).to.be.revertedWithCustomError(integrator, "UnknownOrder");
      });

      it("reverts OrderAlreadyCancelled when Diamond completes an already-cancelled order", async function () {
        // Race the impossible: gateway invariants prevent this in practice,
        // but the guard makes a future Diamond bug loud rather than silent.
        await integrator.connect(user).userPlaceOrder(SOLANA_RECIPIENT, USDC(10), INR, 1, "", 0, 0);
        await mockDiamond.simulateOrderCancelled(1);
        await expect(
          mockDiamond.adminCallOnOrderComplete(
            await integrator.getAddress(),
            1,
            user.address,
            USDC(10),
            user.address
          )
        ).to.be.revertedWithCustomError(integrator, "OrderAlreadyCancelled");
      });

      it("reverts AmountMismatch when Diamond passes an amount != session.usdcAmount", async function () {
        // Diamond's gateway sends the same amount it placed with, so this
        // is only reachable via a Diamond bug — the guard mirrors LotPot
        // and pins the invariant.
        await integrator.connect(user).userPlaceOrder(SOLANA_RECIPIENT, USDC(10), INR, 1, "", 0, 0);
        await expect(
          mockDiamond.adminCallOnOrderComplete(
            await integrator.getAddress(),
            1,
            user.address,
            USDC(999),
            user.address
          )
        ).to.be.revertedWithCustomError(integrator, "AmountMismatch");
      });

      it("happy path still works with the new guards in place", async function () {
        await integrator.connect(user).userPlaceOrder(SOLANA_RECIPIENT, USDC(10), INR, 1, "", 0, 0);
        await mockDiamond.simulateOrderComplete(1);
        const session = await integrator.sessions(1);
        expect(session.fulfilled).to.equal(true);
      });
    });
  });
});
