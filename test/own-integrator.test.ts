import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const REGION = { INDIA: 0, ABROAD: 1 };

/**
 * OwnCheckoutIntegrator: a fiat -> Base USDC onramp for Own Finance, gated on a
 * single passport+liveness tier and settling DIRECTLY into the buyer's own
 * wallet ($100 per tx on INR, $200 elsewhere, 5 orders/day).
 *
 * The attestor key is a plain hardhat signer; the integrator only checks
 * `ecrecover(...) == attestor`, so a locally-signed EIP-712 struct is
 * indistinguishable from one the real simple-kyc service signs.
 */
describe("OwnCheckoutIntegrator", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let user2: SignerWithAddress;
  let stranger: SignerWithAddress;
  let attestor: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let integrator: any;
  let integratorAddr: string;
  let diamondAddr: string;
  let usdcAddr: string;
  let chainId: bigint;

  const USDC = (n: number | string) => ethers.parseUnits(n.toString(), 6);
  const INR = ethers.encodeBytes32String("INR");
  // Any non-INR currency resolves to the Abroad column.
  const USD = ethers.encodeBytes32String("USD");

  // Launch policy. Each is also an immutable MAX_* ceiling in the contract.
  const CAP_INDIA = USDC(100);
  const CAP_ABROAD = USDC(200);
  const DAILY_COUNT = 5;

  function nullifierFor(label: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(label));
  }

  async function futureExpiry(secondsAhead = 3600): Promise<bigint> {
    const block = await ethers.provider.getBlock("latest");
    return BigInt(block!.timestamp) + BigInt(secondsAhead);
  }

  /**
   * Sign a passport+liveness attestation exactly as the simple-kyc service
   * does: the `KycVerifier` domain, bound to a specific verifyingContract.
   */
  async function signAttestation(
    signer: SignerWithAddress,
    wallet: string,
    nullifier: string,
    limit: bigint,
    expiry: bigint,
    verifyingContract: string = integratorAddr
  ): Promise<string> {
    const domain = { name: "KycVerifier", version: "1", chainId, verifyingContract };
    const types = {
      KycAttestation: [
        { name: "wallet", type: "address" },
        { name: "nullifier", type: "bytes32" },
        { name: "limit", type: "uint256" },
        { name: "expiry", type: "uint256" },
      ],
    };
    return signer.signTypedData(domain, types, { wallet, nullifier, limit, expiry });
  }

  /** Verify `who` at `limit`, from the real attestor, and submit it. */
  async function verify(who: SignerWithAddress, limit: bigint, label?: string) {
    const nullifier = nullifierFor(label ?? `kyc:${who.address}`);
    const expiry = await futureExpiry();
    const sig = await signAttestation(attestor, who.address, nullifier, limit, expiry);
    return integrator.connect(who).submitPassportAttestation(nullifier, limit, expiry, sig);
  }

  /**
   * A signer that IS the Diamond, for calling the protocol hooks directly.
   * MockDiamond has no `receive()`, so fund it with setBalance rather than a
   * transfer.
   */
  async function impersonateDiamond(): Promise<SignerWithAddress> {
    await ethers.provider.send("hardhat_setBalance", [
      diamondAddr,
      "0x" + ethers.parseEther("10").toString(16),
    ]);
    return ethers.getImpersonatedSigner(diamondAddr);
  }

  /** Place an onramp buy and drive it to completion on the mock Diamond. */
  async function buyAndComplete(who: SignerWithAddress, amount: bigint, currency = INR) {
    const orderId = await mockDiamond.nextOrderId();
    await integrator.connect(who).buyUsdc(amount, currency, 1, "pubkey", 0, 0);
    await mockDiamond.simulateOrderComplete(orderId);
    return orderId;
  }

  async function deployIntegrator(
    capIndia = CAP_INDIA,
    capAbroad = CAP_ABROAD,
    dailyCount: number = DAILY_COUNT,
    attestorAddr: string = attestor.address
  ) {
    return (await ethers.getContractFactory("OwnCheckoutIntegrator")).deploy(
      diamondAddr,
      usdcAddr,
      owner.address,
      attestorAddr,
      capIndia,
      capAbroad,
      dailyCount
    );
  }

  beforeEach(async function () {
    [owner, user, user2, stranger, attestor] = await ethers.getSigners();
    chainId = (await ethers.provider.getNetwork()).chainId;

    mockUsdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    usdcAddr = await mockUsdc.getAddress();

    mockDiamond = await (await ethers.getContractFactory("MockDiamond")).deploy(usdcAddr);
    diamondAddr = await mockDiamond.getAddress();

    integrator = await deployIntegrator();
    integratorAddr = await integrator.getAddress();

    await mockDiamond.registerIntegrator(integratorAddr, await integrator.proxyImpl());
    // The Diamond needs USDC on hand to settle completed buys.
    await mockUsdc.mint(diamondAddr, USDC(1_000_000));
  });

  // ─── The core invariant ─────────────────────────────────────────────

  describe("direct settlement into the buyer's wallet", function () {
    it("delivers the USDC to the buyer, never to the integrator or its proxy", async function () {
      await verify(user, CAP_INDIA);

      const proxy = await integrator.proxyAddress(user.address);
      const before = await mockUsdc.balanceOf(user.address);

      await buyAndComplete(user, USDC(75));

      expect(await mockUsdc.balanceOf(user.address)).to.equal(before + USDC(75));
      // The two addresses that must never hold a buyer's proceeds.
      expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(0);
      expect(await mockUsdc.balanceOf(proxy)).to.equal(0);
    });

    it("pins recipientAddr to the buyer on the Diamond order", async function () {
      await verify(user, CAP_INDIA);
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).buyUsdc(USDC(20), INR, 1, "pubkey", 0, 0);

      const order = await mockDiamond.orders(orderId);
      expect(order.recipientAddr).to.equal(user.address);
      expect(order.user).to.equal(user.address);
    });

    it("marks the session settled on completion", async function () {
      await verify(user, CAP_INDIA);
      const orderId = await buyAndComplete(user, USDC(10));

      const session = await integrator.getSession(orderId);
      expect(session.user).to.equal(user.address);
      expect(session.settled).to.equal(true);
      expect(session.cancelled).to.equal(false);
      expect(session.amount).to.equal(USDC(10));
    });

    it("offers no way to buy for a different address", async function () {
      // buyUsdc takes no recipient parameter at all — the ABI is the guarantee.
      const fragment = integrator.interface.getFunction("buyUsdc");
      expect(fragment!.inputs.map((i: any) => i.name)).to.deep.equal([
        "amount",
        "currency",
        "circleId",
        "pubKey",
        "preferredPaymentChannelConfigId",
        "fiatAmountLimit",
      ]);
    });
  });

  // ─── Passport + liveness gate ───────────────────────────────────────

  describe("passport + liveness gate", function () {
    it("blocks a wallet with no attestation", async function () {
      expect(await integrator.effectiveLimit(user.address, INR)).to.equal(0);
      await expect(
        integrator.connect(user).buyUsdc(USDC(5), INR, 1, "pubkey", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "NotVerified");
    });

    it("grants the attested limit and marks the wallet verified", async function () {
      await expect(verify(user, USDC(60)))
        .to.emit(integrator, "PassportVerified")
        .withArgs(user.address, nullifierFor(`kyc:${user.address}`), USDC(60), USDC(60));

      expect(await integrator.verified(user.address)).to.equal(true);
      expect(await integrator.grantedLimit(user.address)).to.equal(USDC(60));
      expect(await integrator.effectiveLimit(user.address, INR)).to.equal(USDC(60));
    });

    it("rejects a signature from the wrong signer", async function () {
      const nullifier = nullifierFor("wrong-signer");
      const expiry = await futureExpiry();
      const sig = await signAttestation(stranger, user.address, nullifier, CAP_INDIA, expiry);
      await expect(
        integrator.connect(user).submitPassportAttestation(nullifier, CAP_INDIA, expiry, sig)
      ).to.be.revertedWithCustomError(integrator, "InvalidSignature");
    });

    it("rejects an expired attestation", async function () {
      const nullifier = nullifierFor("expired");
      const block = await ethers.provider.getBlock("latest");
      const expiry = BigInt(block!.timestamp);
      const sig = await signAttestation(attestor, user.address, nullifier, CAP_INDIA, expiry);
      await expect(
        integrator.connect(user).submitPassportAttestation(nullifier, CAP_INDIA, expiry, sig)
      ).to.be.revertedWithCustomError(integrator, "AttestationExpired");
    });

    it("rejects a replayed nullifier (Sybil gate)", async function () {
      await verify(user, CAP_INDIA, "shared-human");
      // Same human, different wallet — the nullifier is already spent.
      const nullifier = nullifierFor("shared-human");
      const expiry = await futureExpiry();
      const sig = await signAttestation(attestor, user2.address, nullifier, CAP_INDIA, expiry);
      await expect(
        integrator.connect(user2).submitPassportAttestation(nullifier, CAP_INDIA, expiry, sig)
      ).to.be.revertedWithCustomError(integrator, "NullifierAlreadySpent");
    });

    it("rejects an attestation issued for a different wallet", async function () {
      const nullifier = nullifierFor("bound-to-user");
      const expiry = await futureExpiry();
      // Signed for `user`, submitted by `user2`.
      const sig = await signAttestation(attestor, user.address, nullifier, CAP_INDIA, expiry);
      await expect(
        integrator.connect(user2).submitPassportAttestation(nullifier, CAP_INDIA, expiry, sig)
      ).to.be.revertedWithCustomError(integrator, "InvalidSignature");
    });

    it("rejects an attestation minted for a different integrator", async function () {
      const other = await deployIntegrator();
      const nullifier = nullifierFor("cross-contract");
      const expiry = await futureExpiry();
      // Correct service, correct wallet — but bound to another verifyingContract.
      const sig = await signAttestation(
        attestor,
        user.address,
        nullifier,
        CAP_INDIA,
        expiry,
        await other.getAddress()
      );
      await expect(
        integrator.connect(user).submitPassportAttestation(nullifier, CAP_INDIA, expiry, sig)
      ).to.be.revertedWithCustomError(integrator, "InvalidSignature");
    });

    it("rejects the malleated (high-s) twin of a valid signature", async function () {
      const nullifier = nullifierFor("malleable");
      const expiry = await futureExpiry();
      const sig = await signAttestation(attestor, user.address, nullifier, CAP_INDIA, expiry);

      const { r, s, v } = ethers.Signature.from(sig);
      const N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
      const flipped = ethers.concat([
        r,
        ethers.zeroPadValue(ethers.toBeHex(N - BigInt(s)), 32),
        ethers.toBeHex(v === 27 ? 28 : 27, 1),
      ]);
      await expect(
        integrator.connect(user).submitPassportAttestation(nullifier, CAP_INDIA, expiry, flipped)
      ).to.be.revertedWithCustomError(integrator, "InvalidSignature");
    });

    it("reverts when no attestor is configured", async function () {
      const bare = await deployIntegrator(CAP_INDIA, CAP_ABROAD, DAILY_COUNT, ethers.ZeroAddress);
      const nullifier = nullifierFor("no-attestor");
      const expiry = await futureExpiry();
      const sig = await signAttestation(attestor, user.address, nullifier, CAP_INDIA, expiry);
      await expect(
        bare.connect(user).submitPassportAttestation(nullifier, CAP_INDIA, expiry, sig)
      ).to.be.revertedWithCustomError(bare, "AttestorNotSet");
    });

    it("is monotonic — a lower later attestation cannot downgrade the grant", async function () {
      await verify(user, USDC(90), "first");
      await verify(user, USDC(10), "second");
      expect(await integrator.grantedLimit(user.address)).to.equal(USDC(90));
    });
  });

  // ─── Region tiers ───────────────────────────────────────────────────

  describe("region tiers", function () {
    it("caps INR at $100 and other currencies at $200", async function () {
      // Attested far above policy — the region ceiling is what binds.
      await verify(user, USDC(10_000));
      expect(await integrator.effectiveLimit(user.address, INR)).to.equal(USDC(100));
      expect(await integrator.effectiveLimit(user.address, USD)).to.equal(USDC(200));

      const [india, abroad] = await integrator.effectiveLimits(user.address);
      expect(india).to.equal(USDC(100));
      expect(abroad).to.equal(USDC(200));
    });

    it("uses the attested limit when it is below the region ceiling", async function () {
      await verify(user, USDC(40));
      expect(await integrator.effectiveLimit(user.address, INR)).to.equal(USDC(40));
      expect(await integrator.effectiveLimit(user.address, USD)).to.equal(USDC(40));
    });

    it("routes every non-INR currency to the Abroad column", async function () {
      expect(await integrator.regionFor(INR)).to.equal(REGION.INDIA);
      expect(await integrator.regionFor(USD)).to.equal(REGION.ABROAD);
      expect(await integrator.regionFor(ethers.encodeBytes32String("BRL"))).to.equal(REGION.ABROAD);
      expect(await integrator.regionFor(ethers.ZeroHash)).to.equal(REGION.ABROAD);
    });

    it("allows $200 abroad but only $100 on the same INR wallet", async function () {
      await verify(user, USDC(10_000));
      await expect(
        integrator.connect(user).buyUsdc(USDC(150), INR, 1, "pubkey", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "VerificationLimitExceeded");
      // Same wallet, foreign currency — allowed.
      await expect(integrator.connect(user).buyUsdc(USDC(150), USD, 1, "pubkey", 0, 0)).to.not.be
        .reverted;
    });

    it("rejects an amount above the region cap", async function () {
      await verify(user, USDC(10_000));
      await expect(
        integrator.connect(user).buyUsdc(USDC(201), USD, 1, "pubkey", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "VerificationLimitExceeded");
    });

    it("rejects a zero amount", async function () {
      await verify(user, CAP_INDIA);
      await expect(
        integrator.connect(user).buyUsdc(0, INR, 1, "pubkey", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "InvalidAmount");
    });
  });

  // ─── Immutable ceilings ─────────────────────────────────────────────

  describe("immutable policy ceilings", function () {
    it("exposes the ceilings as constants", async function () {
      expect(await integrator.MAX_REGION_CAP_INDIA()).to.equal(USDC(100));
      expect(await integrator.MAX_REGION_CAP_ABROAD()).to.equal(USDC(200));
      expect(await integrator.MAX_DAILY_TX_COUNT_LIMIT()).to.equal(5);
      expect(await integrator.maxRegionCap(REGION.INDIA)).to.equal(USDC(100));
      expect(await integrator.maxRegionCap(REGION.ABROAD)).to.equal(USDC(200));
    });

    it("refuses to deploy above a region ceiling", async function () {
      await expect(deployIntegrator(USDC(101), CAP_ABROAD)).to.be.revertedWithCustomError(
        integrator,
        "CapExceedsCeiling"
      );
      await expect(deployIntegrator(CAP_INDIA, USDC(201))).to.be.revertedWithCustomError(
        integrator,
        "CapExceedsCeiling"
      );
    });

    it("refuses to deploy above the daily-count ceiling, or at zero", async function () {
      await expect(deployIntegrator(CAP_INDIA, CAP_ABROAD, 6)).to.be.revertedWithCustomError(
        integrator,
        "CapExceedsCeiling"
      );
      await expect(deployIntegrator(CAP_INDIA, CAP_ABROAD, 0)).to.be.revertedWithCustomError(
        integrator,
        "InvalidLimit"
      );
    });

    it("lets the owner tighten a region cap but never raise it", async function () {
      await expect(integrator.connect(owner).setRegionCap(REGION.INDIA, USDC(25)))
        .to.emit(integrator, "RegionCapUpdated")
        .withArgs(REGION.INDIA, USDC(25));
      expect(await integrator.regionCap(REGION.INDIA)).to.equal(USDC(25));

      await expect(
        integrator.connect(owner).setRegionCap(REGION.INDIA, USDC(101))
      ).to.be.revertedWithCustomError(integrator, "CapExceedsCeiling");
      // Not even back up to the ceiling-legal launch value once tightened? It is
      // legal — the ceiling is the bound, not the current value.
      await integrator.connect(owner).setRegionCap(REGION.INDIA, USDC(100));
      expect(await integrator.regionCap(REGION.INDIA)).to.equal(USDC(100));
    });

    it("lets the owner tighten the daily count but never raise it past 5", async function () {
      await integrator.connect(owner).setDailyTxCountLimit(2);
      expect(await integrator.dailyTxCountLimit()).to.equal(2);
      await expect(integrator.connect(owner).setDailyTxCountLimit(6)).to.be.revertedWithCustomError(
        integrator,
        "CapExceedsCeiling"
      );
      await expect(integrator.connect(owner).setDailyTxCountLimit(0)).to.be.revertedWithCustomError(
        integrator,
        "InvalidLimit"
      );
    });

    it("rejects an unknown region", async function () {
      await expect(
        integrator.connect(owner).setRegionCap(2, USDC(1))
      ).to.be.revertedWithCustomError(integrator, "InvalidRegion");
    });

    it("disables a region when its cap is set to 0", async function () {
      await verify(user, CAP_INDIA);
      await integrator.connect(owner).setRegionCap(REGION.INDIA, 0);
      expect(await integrator.effectiveLimit(user.address, INR)).to.equal(0);
      await expect(
        integrator.connect(user).buyUsdc(USDC(1), INR, 1, "pubkey", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "NotVerified");
      // The other region is untouched.
      expect(await integrator.effectiveLimit(user.address, USD)).to.equal(CAP_INDIA);
    });
  });

  // ─── Daily count ────────────────────────────────────────────────────

  describe("daily order count", function () {
    it("allows 5 orders a day and blocks the 6th", async function () {
      await verify(user, USDC(10));
      for (let i = 0; i < DAILY_COUNT; i++) {
        await integrator.connect(user).buyUsdc(USDC(1), INR, 1, "pubkey", 0, 0);
      }
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(0);
      await expect(
        integrator.connect(user).buyUsdc(USDC(1), INR, 1, "pubkey", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "DailyCountLimitExceeded");
    });

    it("counts down as orders are placed", async function () {
      await verify(user, USDC(10));
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(5);
      await integrator.connect(user).buyUsdc(USDC(1), INR, 1, "pubkey", 0, 0);
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(4);
    });

    it("resets the next UTC day", async function () {
      await verify(user, USDC(10));
      for (let i = 0; i < DAILY_COUNT; i++) {
        await integrator.connect(user).buyUsdc(USDC(1), INR, 1, "pubkey", 0, 0);
      }
      await ethers.provider.send("evm_increaseTime", [86_400]);
      await ethers.provider.send("evm_mine", []);
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(5);
      await expect(integrator.connect(user).buyUsdc(USDC(1), INR, 1, "pubkey", 0, 0)).to.not.be
        .reverted;
    });

    it("budgets per wallet, not globally", async function () {
      await verify(user, USDC(10), "a");
      await verify(user2, USDC(10), "b");
      for (let i = 0; i < DAILY_COUNT; i++) {
        await integrator.connect(user).buyUsdc(USDC(1), INR, 1, "pubkey", 0, 0);
      }
      expect(await integrator.getRemainingDailyCount(user2.address)).to.equal(5);
      await expect(integrator.connect(user2).buyUsdc(USDC(1), INR, 1, "pubkey", 0, 0)).to.not.be
        .reverted;
    });

    it("does NOT release the slot on cancellation", async function () {
      // The counter is placements/day: a placement holds merchant capacity
      // whether or not it completes, so cancelling must not refund the slot.
      await verify(user, USDC(10));
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).buyUsdc(USDC(1), INR, 1, "pubkey", 0, 0);
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(4);

      await mockDiamond.simulateOrderCancelled(orderId);
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(4);

      const session = await integrator.getSession(orderId);
      expect(session.cancelled).to.equal(true);
      expect(session.settled).to.equal(false);
    });
  });

  // ─── Protocol callbacks ─────────────────────────────────────────────

  describe("protocol callbacks", function () {
    it("only the Diamond may call the hooks", async function () {
      await expect(
        integrator.connect(stranger).validateOrder(user.address, USDC(1), INR)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
      await expect(
        integrator.connect(stranger).onOrderComplete(1, user.address, USDC(1), user.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
      await expect(integrator.connect(stranger).onOrderCancel(1)).to.be.revertedWithCustomError(
        integrator,
        "OnlyDiamond"
      );
    });

    it("validateOrder refuses a call with no placement in flight", async function () {
      await verify(user, CAP_INDIA);
      // Even from the Diamond, and even for a fully verified wallet: without a
      // pending placement there is nothing to approve.
      const asDiamond = await impersonateDiamond();
      expect(
        await integrator.connect(asDiamond).validateOrder.staticCall(user.address, USDC(1), INR)
      ).to.equal(false);
    });

    it("flags a completion routed away from the buyer", async function () {
      await verify(user, CAP_INDIA);
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).buyUsdc(USDC(10), INR, 1, "pubkey", 0, 0);

      // The shape a mis-registered `usdcThroughIntegrator = true` would produce:
      // settlement routed to the integrator instead of the buyer.
      await expect(
        mockDiamond.adminCallOnOrderComplete(
          integratorAddr,
          orderId,
          user.address,
          USDC(10),
          integratorAddr
        )
      )
        .to.emit(integrator, "SettlementRoutingAnomaly")
        // The 6th field is this contract's USDC balance. Zero here: this entry
        // point only replays the callback and moves no money, which is exactly
        // why it could never have caught a real mis-registration. The test
        // above in "the mis-registration alarm" drives the actual routing.
        .withArgs(orderId, user.address, user.address, USDC(10), integratorAddr, 0);

      // …and the session is NOT marked settled on a mismatch.
      expect((await integrator.getSession(orderId)).settled).to.equal(false);
    });

    it("flags a completion with the wrong amount", async function () {
      await verify(user, CAP_INDIA);
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).buyUsdc(USDC(10), INR, 1, "pubkey", 0, 0);

      await expect(
        mockDiamond.adminCallOnOrderComplete(
          integratorAddr,
          orderId,
          user.address,
          USDC(99),
          user.address
        )
      ).to.emit(integrator, "SettlementRoutingAnomaly");
    });

    it("ignores an unknown or already-settled order without reverting", async function () {
      await verify(user, CAP_INDIA);
      const orderId = await buyAndComplete(user, USDC(10));

      // Unknown order.
      await expect(
        mockDiamond.adminCallOnOrderComplete(
          integratorAddr,
          9_999,
          user.address,
          USDC(1),
          user.address
        )
      ).to.not.be.reverted;
      // Replayed completion.
      await expect(
        mockDiamond.adminCallOnOrderComplete(
          integratorAddr,
          orderId,
          user.address,
          USDC(10),
          user.address
        )
      ).to.not.be.reverted;
      expect((await integrator.getSession(orderId)).settled).to.equal(true);
    });

    it("cannot cancel an already-settled order", async function () {
      await verify(user, CAP_INDIA);
      const orderId = await buyAndComplete(user, USDC(10));
      // MockDiamond guards double-terminal transitions; call the hook directly.
      const asDiamond = await impersonateDiamond();
      await integrator.connect(asDiamond).onOrderCancel(orderId);

      const session = await integrator.getSession(orderId);
      expect(session.settled).to.equal(true);
      expect(session.cancelled).to.equal(false);
    });
  });

  // ─── Administration ─────────────────────────────────────────────────

  describe("administration", function () {
    it("restricts every setter to the owner", async function () {
      await expect(
        integrator.connect(stranger).setAttestor(stranger.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
      await expect(
        integrator.connect(stranger).setRegionCap(REGION.INDIA, 1)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
      await expect(
        integrator.connect(stranger).setDailyTxCountLimit(1)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
      await expect(
        integrator.connect(stranger).setBlocked(user.address, true)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
      await expect(integrator.connect(stranger).pause()).to.be.revertedWithCustomError(
        integrator,
        "OnlyOwner"
      );
      await expect(
        integrator.connect(stranger).sweepUsdc(stranger.address, 1)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });

    it("pauses and resumes the onramp", async function () {
      await verify(user, CAP_INDIA);
      await integrator.connect(owner).pause();
      await expect(
        integrator.connect(user).buyUsdc(USDC(1), INR, 1, "pubkey", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "ContractPaused");

      await integrator.connect(owner).unpause();
      await expect(integrator.connect(user).buyUsdc(USDC(1), INR, 1, "pubkey", 0, 0)).to.not.be
        .reverted;
    });

    it("blocks a wallet in every region", async function () {
      await verify(user, CAP_INDIA);
      await expect(integrator.connect(owner).setBlocked(user.address, true))
        .to.emit(integrator, "UserBlocked")
        .withArgs(user.address, true);

      expect(await integrator.effectiveLimit(user.address, INR)).to.equal(0);
      expect(await integrator.effectiveLimit(user.address, USD)).to.equal(0);
      await expect(
        integrator.connect(user).buyUsdc(USDC(1), INR, 1, "pubkey", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "UserIsBlocked");

      await integrator.connect(owner).setBlocked(user.address, false);
      expect(await integrator.effectiveLimit(user.address, INR)).to.equal(CAP_INDIA);
    });

    it("rotates the attestor without touching existing grants", async function () {
      await verify(user, USDC(80));
      await integrator.connect(owner).setAttestor(stranger.address);
      expect(await integrator.attestor()).to.equal(stranger.address);
      expect(await integrator.grantedLimit(user.address)).to.equal(USDC(80));

      // The old key no longer verifies anyone.
      const nullifier = nullifierFor("after-rotation");
      const expiry = await futureExpiry();
      const sig = await signAttestation(attestor, user2.address, nullifier, USDC(10), expiry);
      await expect(
        integrator.connect(user2).submitPassportAttestation(nullifier, USDC(10), expiry, sig)
      ).to.be.revertedWithCustomError(integrator, "InvalidSignature");
    });

    it("sweeps stray USDC — the contract holds none in normal operation", async function () {
      await verify(user, CAP_INDIA);
      await buyAndComplete(user, USDC(50));
      expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(0);

      // Someone transfers USDC here by mistake.
      await mockUsdc.mint(integratorAddr, USDC(7));
      await expect(integrator.connect(owner).sweepUsdc(owner.address, USDC(7)))
        .to.emit(integrator, "UsdcSwept")
        .withArgs(owner.address, USDC(7));
      expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(0);
    });

    it("rejects a sweep to the zero address", async function () {
      await expect(
        integrator.connect(owner).sweepUsdc(ethers.ZeroAddress, 0)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    });
  });

  // ─── Wiring ─────────────────────────────────────────────────────────

  describe("deployment wiring", function () {
    it("binds the Diamond, USDC, owner and launch limits", async function () {
      expect(await integrator.diamond()).to.equal(diamondAddr);
      expect(await integrator.usdc()).to.equal(usdcAddr);
      expect(await integrator.owner()).to.equal(owner.address);
      expect(await integrator.attestor()).to.equal(attestor.address);
      expect(await integrator.regionCap(REGION.INDIA)).to.equal(CAP_INDIA);
      expect(await integrator.regionCap(REGION.ABROAD)).to.equal(CAP_ABROAD);
      expect(await integrator.dailyTxCountLimit()).to.equal(DAILY_COUNT);
    });

    it("rejects zero addresses for the core wiring", async function () {
      const F = await ethers.getContractFactory("OwnCheckoutIntegrator");
      await expect(
        F.deploy(
          ethers.ZeroAddress,
          usdcAddr,
          owner.address,
          attestor.address,
          CAP_INDIA,
          CAP_ABROAD,
          DAILY_COUNT
        )
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      await expect(
        F.deploy(
          diamondAddr,
          ethers.ZeroAddress,
          owner.address,
          attestor.address,
          CAP_INDIA,
          CAP_ABROAD,
          DAILY_COUNT
        )
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      await expect(
        F.deploy(
          diamondAddr,
          usdcAddr,
          ethers.ZeroAddress,
          attestor.address,
          CAP_INDIA,
          CAP_ABROAD,
          DAILY_COUNT
        )
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    });

    it("deploys its own canonical UserProxy master", async function () {
      const impl = await integrator.proxyImpl();
      expect(impl).to.not.equal(ethers.ZeroAddress);
      expect(await ethers.provider.getCode(impl)).to.not.equal("0x");
    });

    it("derives a deterministic per-user proxy, deployed on first use", async function () {
      const predicted = await integrator.proxyAddress(user.address);
      expect(await ethers.provider.getCode(predicted)).to.equal("0x");

      await verify(user, CAP_INDIA);
      await expect(integrator.connect(user).buyUsdc(USDC(1), INR, 1, "pubkey", 0, 0))
        .to.emit(integrator, "UserProxyDeployed")
        .withArgs(user.address, predicted);
      expect(await ethers.provider.getCode(predicted)).to.not.equal("0x");

      // Reused, not redeployed, on the next order.
      await expect(integrator.connect(user).buyUsdc(USDC(1), INR, 1, "pubkey", 0, 0)).to.not.emit(
        integrator,
        "UserProxyDeployed"
      );
    });

    it("exposes the EIP-712 domain separator it verifies against", async function () {
      const expected = ethers.TypedDataEncoder.hashDomain({
        name: "KycVerifier",
        version: "1",
        chainId,
        verifyingContract: integratorAddr,
      });
      expect(await integrator.domainSeparator()).to.equal(expected);
    });
  });

  /*
   * A Diamond that does not behave.
   *
   * Everything this contract inherits from its siblings was already covered;
   * the guards it invented for itself were not. Each of the four below
   * survived deletion with the whole suite still green, because every negative
   * path in the rest of the file stops at the friendly pre-check in `buyUsdc`
   * and never reaches a live placement. These drive the gateway off the happy
   * path instead.
   */
  describe("defences against a misbehaving Diamond", function () {
    it("refuses to record a placement the gate never saw", async function () {
      // OrderValidationMissing. A Diamond that skips validateOrder has created
      // an order without passing this contract's limits — the placement must
      // unwind, not be recorded.
      await verify(user, CAP_INDIA);
      await mockDiamond.setSkipValidation(true);
      await expect(
        integrator.connect(user).buyUsdc(USDC(10), INR, 1, "pubkey", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "OrderValidationMissing");
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(DAILY_COUNT);
    });

    it("refuses an order id it has already recorded", async function () {
      // OrderIdAlreadyUsed. Reusing an id would silently overwrite a live
      // session and orphan the first order's bookkeeping.
      await verify(user, CAP_INDIA);
      const first = await mockDiamond.nextOrderId();
      await integrator.connect(user).buyUsdc(USDC(10), INR, 1, "pubkey", 0, 0);

      await mockDiamond.setForceOrderId(first);
      await expect(
        integrator.connect(user).buyUsdc(USDC(10), INR, 1, "pubkey", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "OrderIdAlreadyUsed");

      const session = await integrator.getSession(first);
      expect(session.amount).to.equal(USDC(10));
      expect(session.settled).to.equal(false);
    });

    it("refuses a validateOrder that does not match the placement in flight", async function () {
      // The pending-placement tuple binding. validateOrder must approve only
      // the exact (user, amount, currency) buyUsdc is mid-flight on — a
      // tampered amount makes it return false, and the gateway unwinds.
      await verify(user, CAP_INDIA);
      await mockDiamond.setTamperValidationAmount(true);
      // Reverts, but not with the gateway's own string: UserProxy.execute wraps
      // any failed call in CallFailed(bytes), so the reason is opaque at this
      // boundary. What matters is that nothing was recorded.
      await expect(integrator.connect(user).buyUsdc(USDC(10), INR, 1, "pubkey", 0, 0)).to.be
        .reverted;
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(DAILY_COUNT);
      expect((await integrator.getSession(await mockDiamond.nextOrderId())).user).to.equal(
        ethers.ZeroAddress
      );
    });

    it("consumes exactly one daily slot when the gate is called twice", async function () {
      // pending.validated is single-use: a second validateOrder inside one
      // placement must not consume a second slot.
      await verify(user, CAP_INDIA);
      await mockDiamond.setDoubleValidate(true);
      await integrator.connect(user).buyUsdc(USDC(10), INR, 1, "pubkey", 0, 0);
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(DAILY_COUNT - 1);
    });

    it("rejects a validateOrder arriving with no placement in flight", async function () {
      // Standalone predicate, called straight from the Diamond. Without the
      // binding this would be a free daily-slot burn, or worse an approval.
      await verify(user, CAP_INDIA);
      const asDiamond = await impersonateDiamond();
      expect(
        await integrator.connect(asDiamond).validateOrder.staticCall(user.address, USDC(10), INR)
      ).to.equal(false);
    });
  });

  describe("the mis-registration alarm", function () {
    /*
     * The Diamond routes settlement on `usdcThroughIntegrator` but passes
     * `recipientAddr` to onOrderComplete in BOTH branches, so under a
     * mis-registration the callback still names the buyer. An alarm keyed on
     * that argument is silent in exactly the case it exists for; this one
     * reads the contract's own balance instead.
     */
    it("fires when settlement lands here instead of the buyer", async function () {
      await verify(user, CAP_INDIA);
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).buyUsdc(USDC(10), INR, 1, "pubkey", 0, 0);

      await mockDiamond.setUsdcThroughIntegrator(true);
      const before = await mockUsdc.balanceOf(user.address);

      await expect(mockDiamond.simulateOrderComplete(orderId)).to.emit(
        integrator,
        "SettlementRoutingAnomaly"
      );

      // The money is here, the buyer got nothing, and the session is NOT
      // marked settled — an anomaly must never look like a completion.
      expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(USDC(10));
      expect(await mockUsdc.balanceOf(user.address)).to.equal(before);
      expect((await integrator.getSession(orderId)).settled).to.equal(false);
    });

    it("stays quiet on a correctly routed completion", async function () {
      await verify(user, CAP_INDIA);
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).buyUsdc(USDC(10), INR, 1, "pubkey", 0, 0);

      await expect(mockDiamond.simulateOrderComplete(orderId)).to.not.emit(
        integrator,
        "SettlementRoutingAnomaly"
      );
      expect((await integrator.getSession(orderId)).settled).to.equal(true);
      expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(0);
    });

    it("is not trippable by a stranger sending dust", async function () {
      // Comparing against the settled amount rather than zero. A `!= 0` test
      // would let anyone permanently break settlement bookkeeping for the
      // price of one wei, since an anomaly refuses to mark the session
      // settled.
      await verify(user, CAP_INDIA);
      await mockUsdc.mint(stranger.address, USDC(1));
      await mockUsdc.connect(stranger).transfer(integratorAddr, 1n);

      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).buyUsdc(USDC(10), INR, 1, "pubkey", 0, 0);
      await expect(mockDiamond.simulateOrderComplete(orderId)).to.not.emit(
        integrator,
        "SettlementRoutingAnomaly"
      );
      expect((await integrator.getSession(orderId)).settled).to.equal(true);
    });
  });
});
