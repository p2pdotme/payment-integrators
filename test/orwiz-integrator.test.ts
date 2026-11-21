import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("OrwizIntegrator", function () {
  let owner: SignerWithAddress;
  let treasury: SignerWithAddress;
  let newTreasury: SignerWithAddress;
  let user: SignerWithAddress;
  let user2: SignerWithAddress;
  let attacker: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let integrator: any;

  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
  const INITIAL_MAX_TX_LIMIT = USDC(50);
  const INITIAL_DAILY_LIMIT = 5;
  const PLUS_PRICE = USDC(20);
  const MAX_PRICE = USDC(45);
  const VES = ethers.encodeBytes32String("VES");

  const makeIntent = (label: string) => ethers.keccak256(ethers.toUtf8Bytes(label));

  beforeEach(async function () {
    [owner, treasury, newTreasury, user, user2, attacker] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUsdc = await MockUSDC.deploy();

    const MockDiamond = await ethers.getContractFactory("MockDiamond");
    mockDiamond = await MockDiamond.deploy(await mockUsdc.getAddress());

    const OrwizIntegrator = await ethers.getContractFactory("OrwizIntegrator");
    integrator = await OrwizIntegrator.deploy(
      await mockDiamond.getAddress(),
      await mockUsdc.getAddress(),
      treasury.address,
      INITIAL_MAX_TX_LIMIT,
      INITIAL_DAILY_LIMIT
    );

    await mockDiamond.registerIntegrator(
      await integrator.getAddress(),
      await integrator.proxyImpl()
    );
    await mockDiamond.setUsdcThroughIntegrator(true);
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(10000));
  });

  describe("Deployment & Constructor", function () {
    it("sets immutables and initial config", async function () {
      expect(await integrator.diamond()).to.equal(await mockDiamond.getAddress());
      expect(await integrator.usdc()).to.equal(await mockUsdc.getAddress());
      expect(await integrator.treasury()).to.equal(treasury.address);
      expect(await integrator.owner()).to.equal(owner.address);
      expect(await integrator.maxTxLimit()).to.equal(INITIAL_MAX_TX_LIMIT);
      expect(await integrator.dailyTxCountLimit()).to.equal(INITIAL_DAILY_LIMIT);
      expect(await integrator.proxyImpl()).to.not.equal(ethers.ZeroAddress);
    });

    it("reverts on zero addresses or invalid limits", async function () {
      const OrwizIntegrator = await ethers.getContractFactory("OrwizIntegrator");

      await expect(
        OrwizIntegrator.deploy(
          ethers.ZeroAddress,
          await mockUsdc.getAddress(),
          treasury.address,
          INITIAL_MAX_TX_LIMIT,
          INITIAL_DAILY_LIMIT
        )
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");

      await expect(
        OrwizIntegrator.deploy(
          await mockDiamond.getAddress(),
          ethers.ZeroAddress,
          treasury.address,
          INITIAL_MAX_TX_LIMIT,
          INITIAL_DAILY_LIMIT
        )
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");

      await expect(
        OrwizIntegrator.deploy(
          await mockDiamond.getAddress(),
          await mockUsdc.getAddress(),
          ethers.ZeroAddress,
          INITIAL_MAX_TX_LIMIT,
          INITIAL_DAILY_LIMIT
        )
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");

      await expect(
        OrwizIntegrator.deploy(
          await mockDiamond.getAddress(),
          await mockUsdc.getAddress(),
          treasury.address,
          0,
          INITIAL_DAILY_LIMIT
        )
      ).to.be.revertedWithCustomError(integrator, "InvalidLimit");

      await expect(
        OrwizIntegrator.deploy(
          await mockDiamond.getAddress(),
          await mockUsdc.getAddress(),
          treasury.address,
          USDC(501),
          INITIAL_DAILY_LIMIT
        )
      ).to.be.revertedWithCustomError(integrator, "LimitExceedsCeiling");

      await expect(
        OrwizIntegrator.deploy(
          await mockDiamond.getAddress(),
          await mockUsdc.getAddress(),
          treasury.address,
          INITIAL_MAX_TX_LIMIT,
          21
        )
      ).to.be.revertedWithCustomError(integrator, "LimitExceedsCeiling");
    });
  });

  describe("Happy Path & Settlement to Treasury", function () {
    it("creates order, settles 100% USDC to treasury, leaves 0 trapped, and emits SubscriptionSettled", async function () {
      const intentHash = makeIntent("sub-plus-user1-001");
      const predictedProxy = await integrator.proxyAddress(user.address);

      await expect(
        integrator.connect(user).createSubscriptionOrder(intentHash, PLUS_PRICE, VES, 1, "pk", 0, 0)
      )
        .to.emit(integrator, "UserProxyDeployed")
        .withArgs(user.address, predictedProxy)
        .and.to.emit(integrator, "SubscriptionOrderCreated")
        .withArgs(intentHash, 1, user.address, PLUS_PRICE, VES);

      expect(await integrator.orderToIntent(1)).to.equal(intentHash);
      expect(await integrator.intentToOrder(intentHash)).to.equal(1);

      const treasuryBefore = await mockUsdc.balanceOf(treasury.address);

      await expect(mockDiamond.simulateOrderComplete(1))
        .to.emit(integrator, "SubscriptionSettled")
        .withArgs(intentHash, 1, user.address, PLUS_PRICE, treasury.address);

      const treasuryAfter = await mockUsdc.balanceOf(treasury.address);
      expect(treasuryAfter - treasuryBefore).to.equal(PLUS_PRICE);
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(0);
      expect(await mockUsdc.balanceOf(predictedProxy)).to.equal(0);
      expect(await integrator.settledIntents(intentHash)).to.equal(true);

      const order = await integrator.orders(1);
      expect(order.settled).to.equal(true);
      expect(order.cancelled).to.equal(false);
      expect(order.payer).to.equal(user.address);
      expect(order.usdcAmount).to.equal(PLUS_PRICE);
    });

    it("supports Plan Max ($45 USDC) within default $50 limit", async function () {
      const intentHash = makeIntent("sub-max-user1-001");
      await integrator
        .connect(user)
        .createSubscriptionOrder(intentHash, MAX_PRICE, VES, 1, "pk", 0, 0);

      await expect(mockDiamond.simulateOrderComplete(1))
        .to.emit(integrator, "SubscriptionSettled")
        .withArgs(intentHash, 1, user.address, MAX_PRICE, treasury.address);

      expect(await mockUsdc.balanceOf(treasury.address)).to.equal(MAX_PRICE);
    });
  });

  describe("IntentHash Deduplication & Validation", function () {
    it("reverts when intentHash is zero or usdcAmount is zero", async function () {
      await expect(
        integrator
          .connect(user)
          .createSubscriptionOrder(ethers.ZeroHash, PLUS_PRICE, VES, 1, "pk", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "InvalidIntentHash");

      await expect(
        integrator
          .connect(user)
          .createSubscriptionOrder(makeIntent("zero-amount"), 0, VES, 1, "pk", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "InvalidAmount");
    });

    it("rejects duplicate intentHash while order is active", async function () {
      const intentHash = makeIntent("sub-dup-active");
      await integrator
        .connect(user)
        .createSubscriptionOrder(intentHash, PLUS_PRICE, VES, 1, "pk", 0, 0);

      await expect(
        integrator.connect(user).createSubscriptionOrder(intentHash, PLUS_PRICE, VES, 1, "pk", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "IntentAlreadyActive");

      await expect(
        integrator
          .connect(user2)
          .createSubscriptionOrder(intentHash, PLUS_PRICE, VES, 1, "pk", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "IntentAlreadyActive");
    });

    it("rejects duplicate intentHash after order is settled", async function () {
      const intentHash = makeIntent("sub-dup-settled");
      await integrator
        .connect(user)
        .createSubscriptionOrder(intentHash, PLUS_PRICE, VES, 1, "pk", 0, 0);
      await mockDiamond.simulateOrderComplete(1);

      await expect(
        integrator.connect(user).createSubscriptionOrder(intentHash, PLUS_PRICE, VES, 1, "pk", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "IntentAlreadySettled");
    });
  });

  describe("Cancellation & Retry", function () {
    it("releases daily count, unlocks intentHash, emits SubscriptionOrderCancelled, and allows retry", async function () {
      const intentHash = makeIntent("sub-cancel-retry");

      await integrator
        .connect(user)
        .createSubscriptionOrder(intentHash, PLUS_PRICE, VES, 1, "pk", 0, 0);
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(
        INITIAL_DAILY_LIMIT - 1
      );

      await expect(mockDiamond.simulateOrderCancelled(1))
        .to.emit(integrator, "SubscriptionOrderCancelled")
        .withArgs(intentHash, 1);

      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(INITIAL_DAILY_LIMIT);
      expect(await integrator.intentToOrder(intentHash)).to.equal(0);
      expect((await integrator.orders(1)).cancelled).to.equal(true);

      // Retry with the exact same intentHash
      await expect(
        integrator.connect(user).createSubscriptionOrder(intentHash, PLUS_PRICE, VES, 1, "pk", 0, 0)
      )
        .to.emit(integrator, "SubscriptionOrderCreated")
        .withArgs(intentHash, 2, user.address, PLUS_PRICE, VES);

      expect(await integrator.intentToOrder(intentHash)).to.equal(2);

      await expect(mockDiamond.simulateOrderComplete(2))
        .to.emit(integrator, "SubscriptionSettled")
        .withArgs(intentHash, 2, user.address, PLUS_PRICE, treasury.address);
    });

    it("tolerates repeat onOrderCancel and unknown orderId without reverting", async function () {
      const intentHash = makeIntent("sub-repeat-cancel");
      await integrator
        .connect(user)
        .createSubscriptionOrder(intentHash, PLUS_PRICE, VES, 1, "pk", 0, 0);

      const diamondAddress = await mockDiamond.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [diamondAddress]);
      await ethers.provider.send("hardhat_setBalance", [diamondAddress, "0x1000000000000000000"]);
      const diamondSigner = await ethers.getSigner(diamondAddress);

      await integrator.connect(diamondSigner).onOrderCancel(1);
      // Repeat call must not revert
      await expect(integrator.connect(diamondSigner).onOrderCancel(1)).to.not.be.reverted;
      // Unknown orderId must not revert
      await expect(integrator.connect(diamondSigner).onOrderCancel(999)).to.not.be.reverted;

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [diamondAddress]);
    });
  });

  describe("Treasury Rotation", function () {
    it("allows owner to rotate treasury and routes subsequent settlements there", async function () {
      await expect(integrator.connect(owner).setTreasury(newTreasury.address))
        .to.emit(integrator, "TreasuryUpdated")
        .withArgs(treasury.address, newTreasury.address);

      expect(await integrator.treasury()).to.equal(newTreasury.address);

      const intentHash = makeIntent("sub-rotated-treasury");
      await integrator
        .connect(user)
        .createSubscriptionOrder(intentHash, PLUS_PRICE, VES, 1, "pk", 0, 0);

      await expect(mockDiamond.simulateOrderComplete(1))
        .to.emit(integrator, "SubscriptionSettled")
        .withArgs(intentHash, 1, user.address, PLUS_PRICE, newTreasury.address);

      expect(await mockUsdc.balanceOf(newTreasury.address)).to.equal(PLUS_PRICE);
      expect(await mockUsdc.balanceOf(treasury.address)).to.equal(0);
    });

    it("reverts setTreasury with zero address or non-owner", async function () {
      await expect(
        integrator.connect(owner).setTreasury(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");

      await expect(
        integrator.connect(attacker).setTreasury(attacker.address)
      ).to.be.revertedWithCustomError(integrator, "OwnableUnauthorizedAccount");
    });
  });

  describe("Access Control", function () {
    it("blocks non-Diamond callers on validateOrder, onOrderComplete, and onOrderCancel", async function () {
      await expect(
        integrator.connect(attacker).validateOrder(user.address, PLUS_PRICE, VES)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");

      await expect(
        integrator
          .connect(attacker)
          .onOrderComplete(1, user.address, PLUS_PRICE, await integrator.getAddress())
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");

      await expect(integrator.connect(attacker).onOrderCancel(1)).to.be.revertedWithCustomError(
        integrator,
        "OnlyDiamond"
      );
    });

    it("blocks non-owner on limit setters and disables renounceOwnership", async function () {
      await expect(
        integrator.connect(attacker).setMaxTxLimit(USDC(100))
      ).to.be.revertedWithCustomError(integrator, "OwnableUnauthorizedAccount");

      await expect(
        integrator.connect(attacker).setDailyTxCountLimit(10)
      ).to.be.revertedWithCustomError(integrator, "OwnableUnauthorizedAccount");

      await expect(integrator.connect(owner).renounceOwnership()).to.be.revertedWithCustomError(
        integrator,
        "RenounceDisabled"
      );
    });
  });

  describe("Per-TX & Daily Limits", function () {
    it("enforces maxTxLimit and allows owner updates within ceiling", async function () {
      await expect(
        integrator
          .connect(user)
          .createSubscriptionOrder(makeIntent("over-50"), USDC(51), VES, 1, "pk", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "TxLimitExceeded");

      await expect(integrator.connect(owner).setMaxTxLimit(USDC(100)))
        .to.emit(integrator, "MaxTxLimitUpdated")
        .withArgs(USDC(100));

      await expect(
        integrator
          .connect(user)
          .createSubscriptionOrder(makeIntent("now-ok"), USDC(60), VES, 1, "pk", 0, 0)
      ).to.not.be.reverted;

      await expect(
        integrator.connect(owner).setMaxTxLimit(USDC(501))
      ).to.be.revertedWithCustomError(integrator, "LimitExceedsCeiling");

      await expect(integrator.connect(owner).setMaxTxLimit(0)).to.be.revertedWithCustomError(
        integrator,
        "InvalidLimit"
      );
    });

    it("enforces dailyTxCountLimit and resets on the next UTC day", async function () {
      for (let i = 0; i < INITIAL_DAILY_LIMIT; i++) {
        await integrator
          .connect(user)
          .createSubscriptionOrder(makeIntent(`daily-${i}`), PLUS_PRICE, VES, 1, "pk", 0, 0);
      }
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(0);

      await expect(
        integrator
          .connect(user)
          .createSubscriptionOrder(makeIntent("daily-overflow"), PLUS_PRICE, VES, 1, "pk", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "DailyLimitExceeded");

      // Advance 1 day
      await time.increase(24 * 60 * 60);
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(INITIAL_DAILY_LIMIT);

      await expect(
        integrator
          .connect(user)
          .createSubscriptionOrder(makeIntent("next-day"), PLUS_PRICE, VES, 1, "pk", 0, 0)
      ).to.not.be.reverted;
    });
  });
});
