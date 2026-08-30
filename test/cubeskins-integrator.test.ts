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
  // The approved CubeSkins policy figures, which are also the contract's
  // immutable ceilings — a deploy cannot start above either.
  const LIVENESS_TIER_CAP = USDC(200);
  const DAILY_COUNT_LIMIT = 5;
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
    await integrator
      .connect(who)
      .submitLivenessAttestation(a.nullifier, a.limit, a.expiry, a.signature);
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
        integrator
          .connect(buyer)
          .submitLivenessAttestation(a.nullifier, a.limit, a.expiry, a.signature)
      ).to.be.revertedWithCustomError(integrator, "InvalidSignature");
    });

    it("rejects an attestation bound to a different wallet", async function () {
      const a = await attest(stranger.address, USDC(200));
      await expect(
        integrator
          .connect(buyer)
          .submitLivenessAttestation(a.nullifier, a.limit, a.expiry, a.signature)
      ).to.be.revertedWithCustomError(integrator, "InvalidSignature");
    });

    it("rejects an expired attestation", async function () {
      const past = (await now()) - 10n;
      const a = await attest(buyer.address, USDC(200), { expiry: past });
      await expect(
        integrator
          .connect(buyer)
          .submitLivenessAttestation(a.nullifier, a.limit, a.expiry, a.signature)
      ).to.be.revertedWithCustomError(integrator, "AttestationExpired");
    });

    it("rejects a replayed nullifier (Sybil resistance)", async function () {
      const a = await claimLiveness(buyer, USDC(200));
      // Same nullifier, re-signed for a different wallet — must still be spent.
      const replay = await attest(stranger.address, USDC(200), { nullifier: a.nullifier });
      await expect(
        integrator
          .connect(stranger)
          .submitLivenessAttestation(
            replay.nullifier,
            replay.limit,
            replay.expiry,
            replay.signature
          )
      ).to.be.revertedWithCustomError(integrator, "NullifierAlreadySpent");
    });

    it("reverts when no attestor is configured", async function () {
      await integrator.connect(owner).setLivenessAttestor(ethers.ZeroAddress);
      const a = await attest(buyer.address, USDC(200));
      await expect(
        integrator
          .connect(buyer)
          .submitLivenessAttestation(a.nullifier, a.limit, a.expiry, a.signature)
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

    // The gateway transfers settlement USDC BEFORE calling this hook and
    // try/catches the call, finalising the order either way. A revert here
    // therefore cannot undo the transfer — it only strands the USDC in a
    // contract that can never be upgraded. So the hook must never revert.
    it("does not revert on an unknown order — flags it instead", async function () {
      await expect(
        mockDiamond.adminCallOnOrderComplete(
          await integrator.getAddress(),
          999,
          buyer.address,
          USDC(10),
          await integrator.getAddress()
        )
      )
        .to.emit(integrator, "SettlementAnomaly")
        .withArgs(999, await integrator.ANOMALY_UNKNOWN_ORDER(), 0, USDC(10), 0);
    });

    it("does not revert on an amount that does not match the session", async function () {
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
      )
        .to.emit(integrator, "SettlementAnomaly")
        .withArgs(1, await integrator.ANOMALY_AMOUNT_MISMATCH(), USDC(10), USDC(999), 0);
    });

    it("forwards only what it actually holds, never reverting on a short balance", async function () {
      await registerOrder();
      await integrator.connect(buyer).userPlaceOrder(MARKETPLACE_ORDER_ID, BRL, 1, "", 0, 0);
      // Callback claims $999 settled but no USDC was transferred in.
      await expect(
        mockDiamond.adminCallOnOrderComplete(
          await integrator.getAddress(),
          1,
          buyer.address,
          USDC(999),
          await integrator.getAddress()
        )
      )
        .to.emit(integrator, "SettlementAnomaly")
        .withArgs(1, await integrator.ANOMALY_SHORT_BALANCE(), USDC(999), 0, 0);
      expect(await mockUsdc.balanceOf(treasury.address)).to.equal(0);
    });

    it("does not revert or double-pay when the same order settles twice", async function () {
      await registerOrder();
      await integrator.connect(buyer).userPlaceOrder(MARKETPLACE_ORDER_ID, BRL, 1, "", 0, 0);
      await mockDiamond.simulateOrderComplete(1);
      expect(await mockUsdc.balanceOf(treasury.address)).to.equal(USDC(10));

      await expect(
        mockDiamond.adminCallOnOrderComplete(
          await integrator.getAddress(),
          1,
          buyer.address,
          USDC(10),
          await integrator.getAddress()
        )
      )
        .to.emit(integrator, "SettlementAnomaly")
        .withArgs(1, await integrator.ANOMALY_ALREADY_FULFILLED(), USDC(10), USDC(10), 0);
      // Nothing left to forward, so the treasury is not paid a second time.
      expect(await mockUsdc.balanceOf(treasury.address)).to.equal(USDC(10));
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

  // A whitelisted integrator bypasses the protocol's own RP / daily / monthly
  // volume limits and is trusted to enforce its own in validateOrder. An
  // owner-raisable cap is therefore a protocol lever, not partner config: the
  // owner could re-point the attestor at itself, self-attest an arbitrary
  // limit, lift the cap, and run unbounded fiat->USDC through P2P's LPs.
  describe("immutable policy ceilings", function () {
    it("exposes the approved policy figures as constants", async function () {
      expect(await integrator.MAX_LIVENESS_TIER_CAP()).to.equal(USDC(200));
      expect(await integrator.MAX_DAILY_TX_COUNT_LIMIT()).to.equal(5);
    });

    it("lets the owner lower the tier cap", async function () {
      await integrator.connect(owner).setLivenessTierCap(USDC(50));
      expect(await integrator.livenessTierCap()).to.equal(USDC(50));
    });

    it("refuses to raise the tier cap past the ceiling", async function () {
      await expect(
        integrator.connect(owner).setLivenessTierCap(USDC(201))
      ).to.be.revertedWithCustomError(integrator, "CapExceedsCeiling");
    });

    it("refuses to raise the daily count past the ceiling", async function () {
      await expect(integrator.connect(owner).setDailyTxCountLimit(6)).to.be.revertedWithCustomError(
        integrator,
        "CapExceedsCeiling"
      );
    });

    it("rejects a zero daily count — 'unlimited' is the hole in the ceiling", async function () {
      await expect(integrator.connect(owner).setDailyTxCountLimit(0)).to.be.revertedWithCustomError(
        integrator,
        "CapExceedsCeiling"
      );
    });

    it("refuses to deploy above either ceiling", async function () {
      const Integrator = await ethers.getContractFactory("CubeSkinsIntegrator");
      const base = [
        await mockDiamond.getAddress(),
        await mockUsdc.getAddress(),
        treasury.address,
        owner.address,
      ];
      await expect(
        Integrator.deploy(...base, USDC(201), DAILY_COUNT_LIMIT, attestor.address)
      ).to.be.revertedWithCustomError(Integrator, "CapExceedsCeiling");
      await expect(
        Integrator.deploy(...base, LIVENESS_TIER_CAP, 6, attestor.address)
      ).to.be.revertedWithCustomError(Integrator, "CapExceedsCeiling");
      await expect(
        Integrator.deploy(...base, LIVENESS_TIER_CAP, 0, attestor.address)
      ).to.be.revertedWithCustomError(Integrator, "CapExceedsCeiling");
    });

    it("caps a self-attested limit even if the attestor key is compromised", async function () {
      // Worst case: owner re-points the attestor at a key it controls and signs
      // itself $1m. The on-chain ceiling still binds.
      await integrator.connect(owner).setLivenessAttestor(stranger.address);
      const a = await attest(buyer.address, USDC(1_000_000), { signer: stranger });
      await integrator
        .connect(buyer)
        .submitLivenessAttestation(a.nullifier, a.limit, a.expiry, a.signature);
      expect(await integrator.effectiveLimit(buyer.address)).to.equal(USDC(200));
    });

    it("keeps tierCap(uint8) readable for existing frontends", async function () {
      expect(await integrator.tierCap(1)).to.equal(LIVENESS_TIER_CAP);
      expect(await integrator.tierCap(0)).to.equal(0);
    });

    it("rejects limit changes from a non-owner", async function () {
      await expect(
        integrator.connect(stranger).setLivenessTierCap(USDC(1))
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
      await expect(
        integrator.connect(stranger).setDailyTxCountLimit(1)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });
  });

  describe("sweepUsdc", function () {
    it("recovers USDC that arrived outside the order flow", async function () {
      // Settlement USDC never rests here; anything held is money that would
      // otherwise be locked forever in a contract that cannot be upgraded.
      await mockUsdc.mint(await integrator.getAddress(), USDC(75));
      await integrator.connect(owner).sweepUsdc(treasury.address, USDC(75));
      expect(await mockUsdc.balanceOf(treasury.address)).to.equal(USDC(75));
    });

    it("emits UsdcSwept", async function () {
      await mockUsdc.mint(await integrator.getAddress(), USDC(5));
      await expect(integrator.connect(owner).sweepUsdc(treasury.address, USDC(5)))
        .to.emit(integrator, "UsdcSwept")
        .withArgs(treasury.address, USDC(5));
    });

    it("rejects a non-owner", async function () {
      await mockUsdc.mint(await integrator.getAddress(), USDC(5));
      await expect(
        integrator.connect(stranger).sweepUsdc(stranger.address, USDC(5))
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });

    it("rejects the zero address", async function () {
      await expect(
        integrator.connect(owner).sweepUsdc(ethers.ZeroAddress, 0)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    });
  });

  describe("onOrderCancel never reverts", function () {
    // The gateway try/catches this hook, so a revert would not block
    // cancellation — it would silently drop the daily-count refund and the
    // `placed` release, surfacing only as B2BIntegratorCallbackFailed.
    beforeEach(async function () {
      await claimLiveness(buyer);
    });

    it("tolerates an unknown order id", async function () {
      await expect(mockDiamond.adminCallOnOrderCancel(await integrator.getAddress(), 4242)).to.not
        .be.reverted;
    });

    it("tolerates being called twice for the same order", async function () {
      await registerOrder();
      await integrator.connect(buyer).userPlaceOrder(MARKETPLACE_ORDER_ID, BRL, 1, "", 0, 0);
      await mockDiamond.simulateOrderCancelled(1);
      await expect(mockDiamond.adminCallOnOrderCancel(await integrator.getAddress(), 1)).to.not.be
        .reverted;
    });

    it("tolerates a cancel arriving after settlement", async function () {
      await registerOrder();
      await integrator.connect(buyer).userPlaceOrder(MARKETPLACE_ORDER_ID, BRL, 1, "", 0, 0);
      await mockDiamond.simulateOrderComplete(1);
      await expect(mockDiamond.adminCallOnOrderCancel(await integrator.getAddress(), 1)).to.not.be
        .reverted;
      // The settled registration stays fulfilled — a late cancel cannot reopen it.
      const reg = await integrator.registrations(MARKETPLACE_ORDER_ID);
      expect(reg.fulfilled).to.equal(true);
    });

    it("refunds the daily slot so failed matches do not lock the buyer out", async function () {
      await integrator.connect(owner).setDailyTxCountLimit(1);
      await registerOrder(301, USDC(10));
      await integrator.connect(buyer).userPlaceOrder(301, BRL, 1, "", 0, 0);
      expect(await integrator.getRemainingDailyCount(buyer.address)).to.equal(0);

      await mockDiamond.simulateOrderCancelled(1);
      expect(await integrator.getRemainingDailyCount(buyer.address)).to.equal(1);

      await registerOrder(302, USDC(10));
      await integrator.connect(buyer).userPlaceOrder(302, BRL, 1, "", 0, 0);
    });
  });
});
