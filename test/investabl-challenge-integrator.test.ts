import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("InvestablChallengeCheckoutIntegrator — goods model, liveness-gated $20 cap", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let user2: SignerWithAddress;
  let treasury: SignerWithAddress;
  let attestor: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let integrator: any;

  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
  const LIVENESS_CAP = USDC(20); // == MAX_LIVENESS_TIER_CAP (the immutable ceiling)
  const DAILY_COUNT_LIMIT = 5; // == MAX_DAILY_TX_COUNT_LIMIT (the immutable ceiling)
  const BUYIN = USDC(15); // the $15 challenge buy-in
  const INR = ethers.encodeBytes32String("INR");
  const SESSION_REF = ethers.encodeBytes32String("sess-1");
  const CIRCLE_ID = 1;

  // buyChallenge(amount, currency, circleId, pubKey, prefPCC, fiatAmountLimit, sessionRef)
  const buy = (signer: SignerWithAddress, amount = BUYIN, ref = SESSION_REF) =>
    integrator.connect(signer).buyChallenge(amount, INR, CIRCLE_ID, "", 0, 0, ref);

  /**
   * Current EVM block timestamp. Other suites time-travel the chain, so
   * wall-clock can sit behind block.timestamp when the full suite runs.
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
    const signature = await signer.signTypedData(domain, types, { wallet, nullifier, limit, expiry });
    return { nullifier, limit, expiry, signature };
  }

  /** Claims the liveness tier for `who`. */
  async function claimLiveness(who: SignerWithAddress, limit = LIVENESS_CAP) {
    const a = await attest(who.address, limit);
    await integrator
      .connect(who)
      .submitLivenessAttestation(a.nullifier, a.limit, a.expiry, a.signature);
    return a;
  }

  beforeEach(async function () {
    [owner, user, user2, treasury, attestor] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUsdc = await MockUSDC.deploy();

    const MockDiamond = await ethers.getContractFactory("MockDiamond");
    mockDiamond = await MockDiamond.deploy(await mockUsdc.getAddress());

    const Integrator = await ethers.getContractFactory("InvestablChallengeCheckoutIntegrator");
    integrator = await Integrator.deploy(
      await mockDiamond.getAddress(),
      await mockUsdc.getAddress(),
      LIVENESS_CAP,
      DAILY_COUNT_LIMIT,
      attestor.address
    );

    await mockDiamond.registerIntegrator(
      await integrator.getAddress(),
      await integrator.proxyImpl()
    );
    // Fund the Diamond so it can deliver USDC to the integrator on completion.
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(100000));

    // Every buyer must clear liveness first — the contract fails closed.
    await claimLiveness(user);
    await claimLiveness(user2);
  });

  describe("Happy path", function () {
    it("places an order, stores the session, emits ChallengeOrderCreated", async function () {
      await expect(buy(user))
        .to.emit(integrator, "ChallengeOrderCreated")
        .withArgs(1, user.address, BUYIN, INR, SESSION_REF);

      const s = await integrator.sessions(1);
      expect(s.user).to.equal(user.address);
      expect(s.amount).to.equal(BUYIN);
      expect(s.sessionRef).to.equal(SESSION_REF);
      expect(s.fulfilled).to.equal(false);
      expect(await integrator.getTodayCount(user.address)).to.equal(1);
    });

    it("on completion: USDC lands on the integrator, session fulfilled, ChallengePurchased emitted", async function () {
      await buy(user);
      await expect(mockDiamond.simulateOrderComplete(1))
        .to.emit(integrator, "ChallengePurchased")
        .withArgs(1, user.address, BUYIN, SESSION_REF);

      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(BUYIN);
      const s = await integrator.sessions(1);
      expect(s.fulfilled).to.equal(true);
    });

    it("owner sweeps accrued USDC to treasury", async function () {
      await buy(user);
      await mockDiamond.simulateOrderComplete(1);
      await integrator.setTreasury(treasury.address);

      await expect(integrator.sweepUsdc(BUYIN))
        .to.emit(integrator, "UsdcSwept")
        .withArgs(treasury.address, BUYIN);
      expect(await mockUsdc.balanceOf(treasury.address)).to.equal(BUYIN);
    });
  });

  describe("Liveness gate", function () {
    it("a wallet with no attestation cannot buy at all", async function () {
      // `user3` never claimed — effective limit is 0, so even $1 is refused.
      const [, , , , , user3] = await ethers.getSigners();
      expect(await integrator.effectiveLimit(user3.address)).to.equal(0);
      await expect(buy(user3, USDC(1))).to.be.revertedWithCustomError(
        integrator,
        "AmountExceedsCap"
      );
    });

    it("grants the attested limit and sets the tier", async function () {
      expect(await integrator.userTier(user.address)).to.equal(1);
      expect(await integrator.effectiveLimit(user.address)).to.equal(LIVENESS_CAP);
    });

    it("clamps an over-attested limit to the on-chain tier cap", async function () {
      const [, , , , , user3] = await ethers.getSigners();
      await claimLiveness(user3, USDC(10000));
      expect(await integrator.effectiveLimit(user3.address)).to.equal(LIVENESS_CAP);
    });

    it("rejects a signature from the wrong signer", async function () {
      const [, , , , , user3] = await ethers.getSigners();
      const a = await attest(user3.address, LIVENESS_CAP, { signer: user2 });
      await expect(
        integrator
          .connect(user3)
          .submitLivenessAttestation(a.nullifier, a.limit, a.expiry, a.signature)
      ).to.be.revertedWithCustomError(integrator, "InvalidSignature");
    });

    it("rejects an attestation bound to a different wallet", async function () {
      const [, , , , , user3] = await ethers.getSigners();
      const a = await attest(user2.address, LIVENESS_CAP, {
        nullifier: ethers.keccak256(ethers.toUtf8Bytes("other")),
      });
      await expect(
        integrator
          .connect(user3)
          .submitLivenessAttestation(a.nullifier, a.limit, a.expiry, a.signature)
      ).to.be.revertedWithCustomError(integrator, "InvalidSignature");
    });

    it("rejects an expired attestation", async function () {
      const [, , , , , user3] = await ethers.getSigners();
      const a = await attest(user3.address, LIVENESS_CAP, { expiry: (await now()) - 10n });
      await expect(
        integrator
          .connect(user3)
          .submitLivenessAttestation(a.nullifier, a.limit, a.expiry, a.signature)
      ).to.be.revertedWithCustomError(integrator, "AttestationExpired");
    });

    it("rejects a replayed nullifier (Sybil resistance)", async function () {
      const [, , , , , user3] = await ethers.getSigners();
      const spent = ethers.keccak256(ethers.toUtf8Bytes(`null:${user.address}`));
      const a = await attest(user3.address, LIVENESS_CAP, { nullifier: spent });
      await expect(
        integrator
          .connect(user3)
          .submitLivenessAttestation(a.nullifier, a.limit, a.expiry, a.signature)
      ).to.be.revertedWithCustomError(integrator, "NullifierAlreadySpent");
    });

    it("reverts AttestorNotSet when no attestor is configured", async function () {
      const [, , , , , user3] = await ethers.getSigners();
      const a = await attest(user3.address, LIVENESS_CAP);
      await integrator.setLivenessAttestor(ethers.ZeroAddress);
      await expect(
        integrator
          .connect(user3)
          .submitLivenessAttestation(a.nullifier, a.limit, a.expiry, a.signature)
      ).to.be.revertedWithCustomError(integrator, "AttestorNotSet");
    });

    it("validateOrder refuses an unattested user even at $1", async function () {
      const [, , , , , user3] = await ethers.getSigners();
      const addr = await mockDiamond.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [addr]);
      await ethers.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
      const asDiamond = await ethers.getSigner(addr);
      expect(
        await integrator.connect(asDiamond).validateOrder.staticCall(user3.address, USDC(1), INR)
      ).to.equal(false);
    });
  });

  describe("Per-tx cap (liveness tier)", function () {
    it("allows amount == cap", async function () {
      await expect(buy(user, LIVENESS_CAP)).to.emit(integrator, "ChallengeOrderCreated");
    });

    it("reverts AmountExceedsCap above the cap", async function () {
      await expect(buy(user, LIVENESS_CAP + 1n)).to.be.revertedWithCustomError(
        integrator,
        "AmountExceedsCap"
      );
    });

    it("reverts InvalidAmount on zero amount", async function () {
      await expect(buy(user, 0n)).to.be.revertedWithCustomError(integrator, "InvalidAmount");
    });
  });

  describe("Daily count limit", function () {
    it("enforces the daily order count", async function () {
      for (let i = 0; i < DAILY_COUNT_LIMIT; i++) {
        await buy(user, BUYIN, ethers.encodeBytes32String("sess-" + i));
      }
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(0);
      await expect(buy(user)).to.be.revertedWithCustomError(integrator, "DailyCountExceeded");
    });

    it("onOrderCancel releases a daily-count slot + emits ChallengeOrderCancelled", async function () {
      await buy(user);
      expect(await integrator.getTodayCount(user.address)).to.equal(1);
      await expect(mockDiamond.simulateOrderCancelled(1))
        .to.emit(integrator, "ChallengeOrderCancelled")
        .withArgs(1, user.address);
      expect(await integrator.getTodayCount(user.address)).to.equal(0);
      const s = await integrator.sessions(1);
      expect(s.cancelled).to.equal(true);
    });
  });

  describe("validateOrder (onlyDiamond, authoritative)", function () {
    let asDiamond: any;
    beforeEach(async function () {
      const addr = await mockDiamond.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [addr]);
      await ethers.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
      asDiamond = await ethers.getSigner(addr);
    });

    it("returns true within cap and count", async function () {
      expect(
        await integrator.connect(asDiamond).validateOrder.staticCall(user.address, BUYIN, INR)
      ).to.equal(true);
    });
    it("returns false above cap", async function () {
      expect(
        await integrator
          .connect(asDiamond)
          .validateOrder.staticCall(user.address, LIVENESS_CAP + 1n, INR)
      ).to.equal(false);
    });
    it("returns false on zero amount", async function () {
      expect(
        await integrator.connect(asDiamond).validateOrder.staticCall(user.address, 0, INR)
      ).to.equal(false);
    });
    it("returns false once daily count is exhausted", async function () {
      for (let i = 0; i < DAILY_COUNT_LIMIT; i++) {
        await integrator.connect(asDiamond).validateOrder(user.address, BUYIN, INR);
      }
      expect(
        await integrator.connect(asDiamond).validateOrder.staticCall(user.address, BUYIN, INR)
      ).to.equal(false);
    });
    it("reverts OnlyDiamond for a non-diamond caller", async function () {
      await expect(
        integrator.connect(user).validateOrder(user.address, BUYIN, INR)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
    });
  });

  describe("Callback access control + replay", function () {
    it("onOrderComplete reverts OnlyDiamond for non-diamond", async function () {
      await buy(user);
      await expect(
        integrator.connect(user).onOrderComplete(1, user.address, BUYIN, user.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
    });
    it("onOrderCancel reverts OnlyDiamond for non-diamond", async function () {
      await buy(user);
      await expect(integrator.connect(user).onOrderCancel(1)).to.be.revertedWithCustomError(
        integrator,
        "OnlyDiamond"
      );
    });
    it("second completion reverts (OrderAlreadyFulfilled, caught by gateway)", async function () {
      await buy(user);
      await mockDiamond.simulateOrderComplete(1);
      await expect(mockDiamond.simulateOrderComplete(1)).to.be.reverted;
    });
    it("cancel after completion reverts", async function () {
      await buy(user);
      await mockDiamond.simulateOrderComplete(1);
      await expect(mockDiamond.simulateOrderCancelled(1)).to.be.reverted;
    });
    it("double cancel reverts", async function () {
      await buy(user);
      await mockDiamond.simulateOrderCancelled(1);
      await expect(mockDiamond.simulateOrderCancelled(1)).to.be.reverted;
    });
    it("completion of an unknown order is a no-op (no revert)", async function () {
      const addr = await mockDiamond.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [addr]);
      await ethers.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
      const asDiamond = await ethers.getSigner(addr);
      await expect(
        integrator.connect(asDiamond).onOrderComplete(999, user.address, BUYIN, user.address)
      ).to.not.be.reverted;
      await expect(integrator.connect(asDiamond).onOrderCancel(999)).to.not.be.reverted;
    });
    it("onOrderComplete reverts AmountMismatch when the delivered amount != the order", async function () {
      await buy(user); // orderId 1, session.amount = BUYIN
      const addr = await mockDiamond.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [addr]);
      await ethers.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
      const asDiamond = await ethers.getSigner(addr);
      await expect(
        integrator.connect(asDiamond).onOrderComplete(1, user.address, BUYIN + 1n, user.address)
      ).to.be.revertedWithCustomError(integrator, "AmountMismatch");
      // the matching amount still finalizes + emits (the reverted call left it unfulfilled)
      await expect(
        integrator.connect(asDiamond).onOrderComplete(1, user.address, BUYIN, user.address)
      )
        .to.emit(integrator, "ChallengePurchased")
        .withArgs(1, user.address, BUYIN, SESSION_REF);
    });
  });

  describe("Admin", function () {
    it("setTierCap lowers the cap (within ceiling) + emits", async function () {
      await expect(integrator.setTierCap(USDC(15)))
        .to.emit(integrator, "TierCapUpdated")
        .withArgs(USDC(15));
      expect(await integrator.livenessTierCap()).to.equal(USDC(15));
    });
    it("setTierCap reverts CapExceedsCeiling above the $20 ceiling", async function () {
      await expect(integrator.setTierCap(USDC(20) + 1n)).to.be.revertedWithCustomError(
        integrator,
        "CapExceedsCeiling"
      );
    });
    it("setTierCap(0) reverts InvalidAmount", async function () {
      await expect(integrator.setTierCap(0)).to.be.revertedWithCustomError(
        integrator,
        "InvalidAmount"
      );
    });
    it("setLivenessAttestor updates + emits", async function () {
      await expect(integrator.setLivenessAttestor(user.address))
        .to.emit(integrator, "LivenessAttestorUpdated")
        .withArgs(user.address);
      expect(await integrator.livenessAttestor()).to.equal(user.address);
    });
    it("setDailyTxCountLimit lowers the count (within ceiling) + emits", async function () {
      await expect(integrator.setDailyTxCountLimit(3))
        .to.emit(integrator, "DailyTxCountLimitUpdated")
        .withArgs(3);
      expect(await integrator.dailyTxCountLimit()).to.equal(3);
    });
    it("setDailyTxCountLimit reverts CapExceedsCeiling above the 5/day ceiling", async function () {
      await expect(integrator.setDailyTxCountLimit(6)).to.be.revertedWithCustomError(
        integrator,
        "CapExceedsCeiling"
      );
    });
    it("setTreasury updates + emits", async function () {
      await expect(integrator.setTreasury(treasury.address))
        .to.emit(integrator, "TreasuryUpdated")
        .withArgs(treasury.address);
    });
    it("setDailyTxCountLimit(0) reverts InvalidAmount", async function () {
      await expect(integrator.setDailyTxCountLimit(0)).to.be.revertedWithCustomError(
        integrator,
        "InvalidAmount"
      );
    });
    it("setTreasury(0) reverts InvalidAddress", async function () {
      await expect(integrator.setTreasury(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        integrator,
        "InvalidAddress"
      );
    });
    it("sweepUsdc(0) reverts InvalidAmount", async function () {
      await expect(integrator.sweepUsdc(0)).to.be.revertedWithCustomError(
        integrator,
        "InvalidAmount"
      );
    });
    it("exposes the immutable policy ceilings", async function () {
      expect(await integrator.MAX_LIVENESS_TIER_CAP()).to.equal(USDC(20));
      expect(await integrator.MAX_DAILY_TX_COUNT_LIMIT()).to.equal(5);
    });
    it("rejects non-owner on every setter", async function () {
      await expect(integrator.connect(user).setTierCap(USDC(1))).to.be.revertedWithCustomError(
        integrator,
        "OnlyOwner"
      );
      await expect(
        integrator.connect(user).setLivenessAttestor(user.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
      await expect(integrator.connect(user).setDailyTxCountLimit(1)).to.be.revertedWithCustomError(
        integrator,
        "OnlyOwner"
      );
      await expect(
        integrator.connect(user).setTreasury(user.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
      await expect(integrator.connect(user).sweepUsdc(1)).to.be.revertedWithCustomError(
        integrator,
        "OnlyOwner"
      );
    });
  });

  describe("Constructor validation", function () {
    let Integrator: any;
    beforeEach(async function () {
      Integrator = await ethers.getContractFactory("InvestablChallengeCheckoutIntegrator");
    });
    it("reverts InvalidAddress when diamond is zero", async function () {
      await expect(
        Integrator.deploy(ethers.ZeroAddress, await mockUsdc.getAddress(), LIVENESS_CAP, DAILY_COUNT_LIMIT, attestor.address)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    });
    it("reverts InvalidAddress when usdc is zero", async function () {
      await expect(
        Integrator.deploy(await mockDiamond.getAddress(), ethers.ZeroAddress, LIVENESS_CAP, DAILY_COUNT_LIMIT, attestor.address)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    });
    it("reverts InvalidAmount when cap is zero", async function () {
      await expect(
        Integrator.deploy(await mockDiamond.getAddress(), await mockUsdc.getAddress(), 0, DAILY_COUNT_LIMIT, attestor.address)
      ).to.be.revertedWithCustomError(integrator, "InvalidAmount");
    });
    it("reverts InvalidAmount when daily limit is zero", async function () {
      await expect(
        Integrator.deploy(
          await mockDiamond.getAddress(),
          await mockUsdc.getAddress(),
          LIVENESS_CAP,
          0,
          attestor.address
        )
      ).to.be.revertedWithCustomError(integrator, "InvalidAmount");
    });
    it("reverts CapExceedsCeiling when the tier cap is above the $20 ceiling", async function () {
      await expect(
        Integrator.deploy(
          await mockDiamond.getAddress(),
          await mockUsdc.getAddress(),
          USDC(20) + 1n,
          DAILY_COUNT_LIMIT,
          attestor.address
        )
      ).to.be.revertedWithCustomError(integrator, "CapExceedsCeiling");
    });
    it("reverts CapExceedsCeiling when the daily count is above the 5/day ceiling", async function () {
      await expect(
        Integrator.deploy(
          await mockDiamond.getAddress(),
          await mockUsdc.getAddress(),
          LIVENESS_CAP,
          6,
          attestor.address
        )
      ).to.be.revertedWithCustomError(integrator, "CapExceedsCeiling");
    });
    it("defaults treasury to owner", async function () {
      expect(await integrator.treasury()).to.equal(owner.address);
    });
  });
});
