import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("ExampleIntegrator — RP TX Limit + Daily Count + Quantity", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let user2: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let integrator: any;
  let erc721Client: any;

  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
  const BASE_TX_LIMIT = USDC(50);
  const DAILY_COUNT_LIMIT = 10;
  const UNIT_PRICE = USDC(10);
  const PRODUCT_ID = 1;
  const INR = ethers.encodeBytes32String("INR");
  const BRL = ethers.encodeBytes32String("BRL");

  beforeEach(async function () {
    [owner, user, user2] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUsdc = await MockUSDC.deploy();

    const MockDiamond = await ethers.getContractFactory("MockDiamond");
    mockDiamond = await MockDiamond.deploy(await mockUsdc.getAddress());

    const Integrator = await ethers.getContractFactory("ExampleIntegrator");
    integrator = await Integrator.deploy(
      await mockDiamond.getAddress(),
      await mockUsdc.getAddress(),
      BASE_TX_LIMIT,
      DAILY_COUNT_LIMIT
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
    await integrator.registerClient(await erc721Client.getAddress());
    await erc721Client.setProductPrice(PRODUCT_ID, UNIT_PRICE);
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(10000));
  });

  describe("Quantity-based purchases", function () {
    it("quantity = 1 mints 1 NFT", async function () {
      await integrator
        .connect(user)
        .userPlaceOrder(await erc721Client.getAddress(), PRODUCT_ID, 1, INR, 1, "", 0, 0);
      await mockDiamond.simulateOrderComplete(1);
      expect(await erc721Client.balanceOf(user.address)).to.equal(1);
    });

    it("quantity = 3 mints 3 NFTs in one order", async function () {
      await integrator
        .connect(user)
        .userPlaceOrder(await erc721Client.getAddress(), PRODUCT_ID, 3, INR, 1, "", 0, 0);
      await mockDiamond.simulateOrderComplete(1);
      expect(await erc721Client.balanceOf(user.address)).to.equal(3);
      // All 3 tokens should be owned by user
      expect(await erc721Client.ownerOf(1)).to.equal(user.address);
      expect(await erc721Client.ownerOf(2)).to.equal(user.address);
      expect(await erc721Client.ownerOf(3)).to.equal(user.address);
    });

    it("total price = unitPrice × quantity", async function () {
      // 5 units × 10 USDC = 50 USDC
      await integrator
        .connect(user)
        .userPlaceOrder(await erc721Client.getAddress(), PRODUCT_ID, 5, INR, 1, "", 0, 0);
      const session = await integrator.sessions(1);
      expect(session.usdcAmount).to.equal(USDC(50));
      expect(session.quantity).to.equal(5);
    });

    it("reverts on quantity = 0", async function () {
      await expect(
        integrator
          .connect(user)
          .userPlaceOrder(await erc721Client.getAddress(), PRODUCT_ID, 0, INR, 1, "", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "InvalidQuantity");
    });

    it("quantity × unitPrice must be within per-tx limit", async function () {
      // 0 RP → baseTxLimit = 50 USDC. 6 units × 10 USDC = 60 USDC → exceeds
      await expect(
        integrator
          .connect(user)
          .userPlaceOrder(await erc721Client.getAddress(), PRODUCT_ID, 6, INR, 1, "", 0, 0)
      ).to.be.reverted;
    });
  });

  describe("Per-TX Limit (0 RP)", function () {
    it("uses baseTxLimit for 0 RP", async function () {
      expect(await integrator.getUserTxLimit(user.address, INR)).to.equal(BASE_TX_LIMIT);
    });
  });

  describe("Per-TX Limit (RP-based)", function () {
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
    it("tracks count correctly with quantity > 1", async function () {
      // Each order counts as 1 tx regardless of quantity
      await integrator
        .connect(user)
        .userPlaceOrder(await erc721Client.getAddress(), PRODUCT_ID, 3, INR, 1, "", 0, 0);
      await integrator
        .connect(user)
        .userPlaceOrder(await erc721Client.getAddress(), PRODUCT_ID, 2, INR, 1, "", 0, 0);
      expect(await integrator.getTodayCount(user.address)).to.equal(2);
    });

    it("enforces daily count limit", async function () {
      for (let i = 0; i < DAILY_COUNT_LIMIT; i++) {
        await integrator
          .connect(user)
          .userPlaceOrder(await erc721Client.getAddress(), PRODUCT_ID, 1, INR, 1, "", 0, 0);
      }
      await expect(
        integrator
          .connect(user)
          .userPlaceOrder(await erc721Client.getAddress(), PRODUCT_ID, 1, INR, 1, "", 0, 0)
      ).to.be.reverted;
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

  describe("Client Registration", function () {
    it("rejects unregistered client", async function () {
      await expect(
        integrator.connect(user).userPlaceOrder(ethers.ZeroAddress, 1, 1, INR, 1, "", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "ClientNotRegistered");
    });
    it("rejects non-existent product", async function () {
      await expect(
        integrator
          .connect(user)
          .userPlaceOrder(await erc721Client.getAddress(), 999, 1, INR, 1, "", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "ProductNotFound");
    });
  });

  describe("ERC721 Client quantity", function () {
    it("rejects mint from non-integrator", async function () {
      await expect(
        erc721Client.connect(user).onCheckoutPayment(user.address, UNIT_PRICE, PRODUCT_ID, 1)
      ).to.be.revertedWithCustomError(erc721Client, "OnlyIntegrator");
    });
  });

  describe("Full Flow with Quantity", function () {
    it("completes checkout: place(qty=3) → complete → 3 NFTs", async function () {
      await integrator
        .connect(user)
        .userPlaceOrder(await erc721Client.getAddress(), PRODUCT_ID, 3, INR, 1, "", 0, 0);
      await mockDiamond.simulateOrderComplete(1);

      expect(await erc721Client.balanceOf(user.address)).to.equal(3);
      const session = await integrator.sessions(1);
      expect(session.fulfilled).to.equal(true);
      expect(session.quantity).to.equal(3);
    });
  });

  describe("Branch coverage — constructor + admin reverts + lifecycle gates", function () {
    describe("constructor", function () {
      it("reverts InvalidAddress when diamond is zero", async function () {
        const Integrator = await ethers.getContractFactory("ExampleIntegrator");
        await expect(
          Integrator.deploy(ethers.ZeroAddress, await mockUsdc.getAddress(), BASE_TX_LIMIT, 10)
        ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      });

      it("reverts InvalidAddress when usdc is zero", async function () {
        const Integrator = await ethers.getContractFactory("ExampleIntegrator");
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
      it("registerClient non-owner reverts", async function () {
        await expect(
          integrator.connect(user).registerClient(user.address)
        ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
      });
      it("removeClient non-owner reverts", async function () {
        await expect(
          integrator.connect(user).removeClient(user.address)
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

    describe("registerClient", function () {
      it("reverts InvalidAddress on zero address", async function () {
        await expect(integrator.registerClient(ethers.ZeroAddress)).to.be.revertedWithCustomError(
          integrator,
          "InvalidAddress"
        );
      });
    });

    describe("removeClient", function () {
      it("emits ClientRemoved and de-registers", async function () {
        const clientAddr = await erc721Client.getAddress();
        await expect(integrator.removeClient(clientAddr))
          .to.emit(integrator, "ClientRemoved")
          .withArgs(clientAddr);
        // subsequent order placement against the de-registered client reverts
        await expect(
          integrator.connect(user).userPlaceOrder(clientAddr, PRODUCT_ID, 1, INR, 1, "", 0, 0)
        ).to.be.revertedWithCustomError(integrator, "ClientNotRegistered");
      });
    });

    describe("getRemainingDailyCount", function () {
      it("returns 0 once count reaches the daily limit", async function () {
        for (let i = 0; i < DAILY_COUNT_LIMIT; i++) {
          await integrator
            .connect(user)
            .userPlaceOrder(await erc721Client.getAddress(), PRODUCT_ID, 1, INR, 1, "", 0, 0);
        }
        expect(await integrator.getRemainingDailyCount(user.address)).to.equal(0);
      });
    });

    describe("onOrderComplete gates", function () {
      it("reverts OnlyDiamond when caller isn't the Diamond", async function () {
        await integrator
          .connect(user)
          .userPlaceOrder(await erc721Client.getAddress(), PRODUCT_ID, 1, INR, 1, "", 0, 0);
        await expect(
          integrator.connect(user).onOrderComplete(1, user.address, UNIT_PRICE, user.address)
        ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
      });

      it("reverts OrderAlreadyFulfilled on second completion", async function () {
        await integrator
          .connect(user)
          .userPlaceOrder(await erc721Client.getAddress(), PRODUCT_ID, 1, INR, 1, "", 0, 0);
        await mockDiamond.simulateOrderComplete(1);
        await expect(mockDiamond.simulateOrderComplete(1)).to.be.reverted;
      });
    });

    describe("onOrderCancel gates", function () {
      it("reverts OnlyDiamond when caller isn't the Diamond", async function () {
        await integrator
          .connect(user)
          .userPlaceOrder(await erc721Client.getAddress(), PRODUCT_ID, 1, INR, 1, "", 0, 0);
        await expect(integrator.connect(user).onOrderCancel(1)).to.be.revertedWithCustomError(
          integrator,
          "OnlyDiamond"
        );
      });

      it("reverts OrderAlreadyFulfilled when cancelling after completion", async function () {
        await integrator
          .connect(user)
          .userPlaceOrder(await erc721Client.getAddress(), PRODUCT_ID, 1, INR, 1, "", 0, 0);
        await mockDiamond.simulateOrderComplete(1);
        await expect(mockDiamond.simulateOrderCancelled(1)).to.be.reverted;
      });

      it("reverts OrderAlreadyCancelled when cancelling twice", async function () {
        await integrator
          .connect(user)
          .userPlaceOrder(await erc721Client.getAddress(), PRODUCT_ID, 1, INR, 1, "", 0, 0);
        await mockDiamond.simulateOrderCancelled(1);
        await expect(mockDiamond.simulateOrderCancelled(1)).to.be.reverted;
      });
    });
  });
});
