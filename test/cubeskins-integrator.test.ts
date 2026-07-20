import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("CubeSkinsIntegrator", function () {
  let owner: SignerWithAddress;
  let treasury: SignerWithAddress;
  let buyer: SignerWithAddress;
  let stranger: SignerWithAddress;
  let attestor: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let integrator: any;

  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
  const LIVENESS_TIER_CAP = USDC(200);
  const DAILY_COUNT_LIMIT = 10;
  const MARKETPLACE_ORDER_ID = 42;
  const BRL = ethers.encodeBytes32String("BRL");

  /**
   * Current EVM block timestamp. Other suites in this repo time-travel the
   * chain, so wall-clock `Date.now()` can sit far behind `block.timestamp`
   * when the full suite runs — always derive deadlines from chain time.
   */
  async function now() {
    return BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  }

  /** Signs a simple-kyc liveness attestation the way the service would. */
  async function attest(
    wallet: string,
    limit: bigint,
    opts: { nullifier?: string; expiry?: bigint; signer?: SignerWithAddress } = {}
  ) {
    const nullifier = opts.nullifier ?? ethers.keccak256(ethers.toUtf8Bytes(`null:${wallet}`));
    const expiry = opts.expiry ?? (await now()) + 3600n;
    const signer = opts.signer ?? attestor;

    const domain = {
      name: "LivenessVerifier",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await integrator.getAddress(),
    };
    const types = {
      LivenessAttestation: [
        { name: "wallet", type: "address" },
        { name: "nullifier", type: "bytes32" },
        { name: "limit", type: "uint256" },
        { name: "expiry", type: "uint256" },
      ],
    };
    const signature = await signer.signTypedData(domain, types, {
      wallet,
      nullifier,
      limit,
      expiry,
    });
    return { nullifier, limit, expiry, signature };
  }

  /** Claims the liveness tier for `who` at `limit`. */
  async function claimLiveness(who: SignerWithAddress, limit = LIVENESS_TIER_CAP) {
    const a = await attest(who.address, limit);
    await integrator.connect(who).submitLivenessAttestation(a.nullifier, a.limit, a.expiry, a.signature);
    return a;
  }

  async function registerOrder(orderId = MARKETPLACE_ORDER_ID, amount = USDC(10), who = buyer) {
    const expiresAt = (await now()) + 3600n;
    await integrator.connect(owner).registerOrder(orderId, who.address, amount, expiresAt);
  }

  beforeEach(async function () {
    [owner, treasury, buyer, stranger, attestor] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUsdc = await MockUSDC.deploy();

    const MockDiamond = await ethers.getContractFactory("MockDiamond");
    mockDiamond = await MockDiamond.deploy(await mockUsdc.getAddress());

    const Integrator = await ethers.getContractFactory("CubeSkinsIntegrator");
    integrator = await Integrator.deploy(
      await mockDiamond.getAddress(),
      await mockUsdc.getAddress(),
      treasury.address,
      owner.address,
      LIVENESS_TIER_CAP,
      DAILY_COUNT_LIMIT,
      attestor.address
    );

    await mockDiamond.registerIntegrator(
      await integrator.getAddress(),
      await integrator.proxyImpl()
    );
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(100000));
  });

  describe("constructor", function () {
    it("sets owner independently of the deployer", async function () {
      const Integrator = await ethers.getContractFactory("CubeSkinsIntegrator");
      const deployed = await Integrator.connect(stranger).deploy(
        await mockDiamond.getAddress(),
        await mockUsdc.getAddress(),
        treasury.address,
        owner.address,
        LIVENESS_TIER_CAP,
        DAILY_COUNT_LIMIT,
        attestor.address
      );
      expect(await deployed.owner()).to.equal(owner.address);
    });

    it("rejects a zero owner", async function () {
      const Integrator = await ethers.getContractFactory("CubeSkinsIntegrator");
      await expect(
        Integrator.deploy(
          await mockDiamond.getAddress(),
          await mockUsdc.getAddress(),
          treasury.address,
          ethers.ZeroAddress,
          LIVENESS_TIER_CAP,
          DAILY_COUNT_LIMIT,
          attestor.address
        )
      ).to.be.revertedWithCustomError(Integrator, "InvalidAddress");
    });
  });

  describe("liveness attestation", function () {
    it("grants the attested limit clamped to the tier cap", async function () {
      await claimLiveness(buyer, USDC(200));
      expect(await integrator.userTier(buyer.address)).to.equal(1);
      expect(await integrator.effectiveLimit(buyer.address)).to.equal(USDC(200));
    });

    it("clamps an over-attested limit to the on-chain tier cap", async function () {
      // A compromised attestor signing $10k must not be able to exceed $200.
      await claimLiveness(buyer, USDC(10000));
      expect(await integrator.effectiveLimit(buyer.address)).to.equal(LIVENESS_TIER_CAP);
    });

    it("rejects a signature from the wrong signer", async function () {
      const a = await attest(buyer.address, USDC(200), { signer: stranger });
      await expect(
        integrator.connect(buyer).submitLivenessAttestation(a.nullifier, a.limit, a.expiry, a.signature)
      ).to.be.revertedWithCustomError(integrator, "InvalidSignature");
    });

    it("rejects an attestation bound to a different wallet", async function () {
      const a = await attest(stranger.address, USDC(200));
      await expect(
        integrator.connect(buyer).submitLivenessAttestation(a.nullifier, a.limit, a.expiry, a.signature)
      ).to.be.revertedWithCustomError(integrator, "InvalidSignature");
    });

    it("rejects an expired attestation", async function () {
      const past = (await now()) - 10n;
      const a = await attest(buyer.address, USDC(200), { expiry: past });
      await expect(
        integrator.connect(buyer).submitLivenessAttestation(a.nullifier, a.limit, a.expiry, a.signature)
      ).to.be.revertedWithCustomError(integrator, "AttestationExpired");
    });

    it("rejects a replayed nullifier (Sybil resistance)", async function () {
      const a = await claimLiveness(buyer, USDC(200));
      // Same nullifier, re-signed for a different wallet — must still be spent.
      const replay = await attest(stranger.address, USDC(200), { nullifier: a.nullifier });
      await expect(
        integrator
          .connect(stranger)
          .submitLivenessAttestation(replay.nullifier, replay.limit, replay.expiry, replay.signature)
      ).to.be.revertedWithCustomError(integrator, "NullifierAlreadySpent");
    });

    it("reverts when no attestor is configured", async function () {
      await integrator.connect(owner).setLivenessAttestor(ethers.ZeroAddress);
      const a = await attest(buyer.address, USDC(200));
      await expect(
        integrator.connect(buyer).submitLivenessAttestation(a.nullifier, a.limit, a.expiry, a.signature)
      ).to.be.revertedWithCustomError(integrator, "AttestorNotSet");
    });
  });

  describe("registerOrder + userPlaceOrder", function () {
    beforeEach(async function () {
      await claimLiveness(buyer);
    });

    it("places order with registered price and buyer", async function () {
      await registerOrder();
      await integrator.connect(buyer).userPlaceOrder(MARKETPLACE_ORDER_ID, BRL, 1, "", 0, 0);

      const session = await integrator.sessions(1);
      expect(session.marketplaceOrderId).to.equal(MARKETPLACE_ORDER_ID);
      expect(session.usdcAmount).to.equal(USDC(10));
    });

    it("reverts when buyer wallet does not match registration", async function () {
      await registerOrder(MARKETPLACE_ORDER_ID, USDC(10), buyer);
      await expect(
        integrator.connect(stranger).userPlaceOrder(MARKETPLACE_ORDER_ID, BRL, 1, "", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "BuyerMismatch");
    });

    it("reverts when order is not registered", async function () {
      await expect(
        integrator.connect(buyer).userPlaceOrder(999, BRL, 1, "", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "OrderNotRegistered");
    });

    it("reverts when stranger tries to register an order", async function () {
      const expiresAt = (await now()) + 3600n;
      await expect(
        integrator
          .connect(stranger)
          .registerOrder(MARKETPLACE_ORDER_ID, buyer.address, USDC(10), expiresAt)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });

    it("rejects a zero amount with InvalidAmount", async function () {
      const expiresAt = (await now()) + 3600n;
      await expect(
        integrator.connect(owner).registerOrder(MARKETPLACE_ORDER_ID, buyer.address, 0, expiresAt)
      ).to.be.revertedWithCustomError(integrator, "InvalidAmount");
    });
  });

  describe("admin cannot strand a live order", function () {
    beforeEach(async function () {
      await claimLiveness(buyer);
      await registerOrder();
      await integrator.connect(buyer).userPlaceOrder(MARKETPLACE_ORDER_ID, BRL, 1, "", 0, 0);
    });

    it("refuses to cancel a registration that has a live session", async function () {
      await expect(
        integrator.connect(owner).cancelRegistration(MARKETPLACE_ORDER_ID)
      ).to.be.revertedWithCustomError(integrator, "OrderAlreadyPlaced");
    });

    it("refuses to re-register an order that has a live session", async function () {
      const expiresAt = (await now()) + 3600n;
      await expect(
        integrator
          .connect(owner)
          .registerOrder(MARKETPLACE_ORDER_ID, buyer.address, USDC(20), expiresAt)
      ).to.be.revertedWithCustomError(integrator, "OrderAlreadyPlaced");
    });

    it("settles even if the registration is cancelled after the order is cancelled and re-placed", async function () {
      // Cancel the live order, which releases `placed`, then let the admin
      // clear the registration. The settled-order path must stay intact.
      await mockDiamond.simulateOrderCancelled(1);
      await integrator.connect(owner).cancelRegistration(MARKETPLACE_ORDER_ID);
      const reg = await integrator.registrations(MARKETPLACE_ORDER_ID);
      expect(reg.buyer).to.equal(ethers.ZeroAddress);
    });

    it("completes settlement without re-reading the registration", async function () {
      await mockDiamond.simulateOrderComplete(1);
      expect(await mockUsdc.balanceOf(treasury.address)).to.equal(USDC(10));
    });
  });

  describe("onOrderComplete", function () {
    beforeEach(async function () {
      await claimLiveness(buyer);
    });

    it("sends USDC to treasury and marks registration fulfilled", async function () {
      await registerOrder();
      await integrator.connect(buyer).userPlaceOrder(MARKETPLACE_ORDER_ID, BRL, 1, "", 0, 0);

      await mockDiamond.simulateOrderComplete(1);

      expect(await mockUsdc.balanceOf(treasury.address)).to.equal(USDC(10));
      const reg = await integrator.registrations(MARKETPLACE_ORDER_ID);
      expect(reg.fulfilled).to.equal(true);
    });

    it("emits CheckoutFulfilled for the indexer", async function () {
      await registerOrder();
      await integrator.connect(buyer).userPlaceOrder(MARKETPLACE_ORDER_ID, BRL, 1, "", 0, 0);

      await expect(mockDiamond.simulateOrderComplete(1))
        .to.emit(integrator, "CheckoutFulfilled")
        .withArgs(1, buyer.address, MARKETPLACE_ORDER_ID, USDC(10));
    });

    it("reverts when called by non-diamond", async function () {
      await expect(
        integrator.connect(stranger).onOrderComplete(1, buyer.address, USDC(10), owner.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
    });

    it("reverts on an unknown order", async function () {
      await expect(
        mockDiamond.adminCallOnOrderComplete(
          await integrator.getAddress(),
          999,
          buyer.address,
          USDC(10),
          await integrator.getAddress()
        )
      ).to.be.revertedWithCustomError(integrator, "UnknownOrder");
    });

    it("reverts on an amount that does not match the session", async function () {
      await registerOrder();
      await integrator.connect(buyer).userPlaceOrder(MARKETPLACE_ORDER_ID, BRL, 1, "", 0, 0);
      await expect(
        mockDiamond.adminCallOnOrderComplete(
          await integrator.getAddress(),
          1,
          buyer.address,
          USDC(999),
          await integrator.getAddress()
        )
      ).to.be.revertedWithCustomError(integrator, "AmountMismatch");
    });
  });

  describe("onOrderCancel", function () {
    beforeEach(async function () {
      await claimLiveness(buyer);
    });

    it("releases daily count and allows re-placement", async function () {
      await registerOrder();
      await integrator.connect(buyer).userPlaceOrder(MARKETPLACE_ORDER_ID, BRL, 1, "", 0, 0);
      await mockDiamond.simulateOrderCancelled(1);

      const reg = await integrator.registrations(MARKETPLACE_ORDER_ID);
      expect(reg.placed).to.equal(false);

      await integrator.connect(buyer).userPlaceOrder(MARKETPLACE_ORDER_ID, BRL, 1, "", 0, 0);
      const session = await integrator.sessions(2);
      expect(session.marketplaceOrderId).to.equal(MARKETPLACE_ORDER_ID);
    });
  });

  describe("validateOrder limits", function () {
    it("blocks a user with no liveness attestation", async function () {
      await registerOrder();
      await expect(integrator.connect(buyer).userPlaceOrder(MARKETPLACE_ORDER_ID, BRL, 1, "", 0, 0))
        .to.be.reverted;
      expect(await integrator.effectiveLimit(buyer.address)).to.equal(0);
    });

    it("allows an order at the liveness cap", async function () {
      await claimLiveness(buyer, USDC(200));
      await registerOrder(MARKETPLACE_ORDER_ID, USDC(200));
      await integrator.connect(buyer).userPlaceOrder(MARKETPLACE_ORDER_ID, BRL, 1, "", 0, 0);
      const session = await integrator.sessions(1);
      expect(session.usdcAmount).to.equal(USDC(200));
    });

    it("blocks amounts above the liveness cap", async function () {
      await claimLiveness(buyer, USDC(200));
      await registerOrder(MARKETPLACE_ORDER_ID, USDC(201));
      await expect(integrator.connect(buyer).userPlaceOrder(MARKETPLACE_ORDER_ID, BRL, 1, "", 0, 0))
        .to.be.reverted;
    });

    it("blocks amounts above a below-cap attested limit", async function () {
      await claimLiveness(buyer, USDC(100));
      await registerOrder(MARKETPLACE_ORDER_ID, USDC(150));
      await expect(integrator.connect(buyer).userPlaceOrder(MARKETPLACE_ORDER_ID, BRL, 1, "", 0, 0))
        .to.be.reverted;
    });

    it("enforces the daily count limit", async function () {
      await claimLiveness(buyer);
      await integrator.connect(owner).setDailyTxCountLimit(2);

      for (let i = 0; i < 2; i++) {
        await registerOrder(100 + i, USDC(10));
        await integrator.connect(buyer).userPlaceOrder(100 + i, BRL, 1, "", 0, 0);
      }
      await registerOrder(200, USDC(10));
      await expect(integrator.connect(buyer).userPlaceOrder(200, BRL, 1, "", 0, 0)).to.be.reverted;
    });
  });
});
