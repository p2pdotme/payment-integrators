import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * PlasmaPayCheckoutIntegrator: a fiat -> Base USDC onramp gated on a single
 * liveness tier and settling DIRECTLY into the buyer's own wallet
 * ($20 per tx, 5 orders/day).
 *
 * The attestor key is a plain hardhat signer; the integrator only checks
 * `ecrecover(...) == attestor`, so a locally-signed EIP-712 struct is
 * indistinguishable from one the real simple-kyc service signs.
 */
describe("PlasmaPayCheckoutIntegrator", function () {
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

  // Launch policy. Each is also an immutable MAX_* ceiling in the contract.
  const TIER_CAP = USDC(20);
  const DAILY_COUNT = 5;

  function nullifierFor(label: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(label));
  }

  async function futureExpiry(secondsAhead = 3600): Promise<bigint> {
    const block = await ethers.provider.getBlock("latest");
    return BigInt(block!.timestamp) + BigInt(secondsAhead);
  }

  /**
   * Sign a liveness attestation exactly as the simple-kyc liveness verifier
   * does: the `LivenessVerifier` domain, bound to a specific verifyingContract.
   */
  async function signAttestation(
    signer: SignerWithAddress,
    wallet: string,
    nullifier: string,
    limit: bigint,
    expiry: bigint,
    verifyingContract: string = integratorAddr
  ): Promise<string> {
    const domain = { name: "LivenessVerifier", version: "1", chainId, verifyingContract };
    const types = {
      LivenessAttestation: [
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
    const nullifier = nullifierFor(label ?? `liveness:${who.address}`);
    const expiry = await futureExpiry();
    const sig = await signAttestation(attestor, who.address, nullifier, limit, expiry);
    return integrator.connect(who).submitLivenessAttestation(nullifier, limit, expiry, sig);
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
    tierCap = TIER_CAP,
    dailyCount: number = DAILY_COUNT,
    attestorAddr: string = attestor.address
  ) {
    return (await ethers.getContractFactory("PlasmaPayCheckoutIntegrator")).deploy(
      diamondAddr,
      usdcAddr,
      owner.address,
      attestorAddr,
      tierCap,
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
      await verify(user, TIER_CAP);

      const proxy = await integrator.proxyAddress(user.address);
      const before = await mockUsdc.balanceOf(user.address);

      await buyAndComplete(user, USDC(15));

      expect(await mockUsdc.balanceOf(user.address)).to.equal(before + USDC(15));
      // The two addresses that must never hold a buyer's proceeds.
      expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(0);
      expect(await mockUsdc.balanceOf(proxy)).to.equal(0);
    });

    it("pins recipientAddr to the buyer on the Diamond order", async function () {
      await verify(user, TIER_CAP);
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).buyUsdc(USDC(20), INR, 1, "pubkey", 0, 0);

      const order = await mockDiamond.orders(orderId);
      expect(order.recipientAddr).to.equal(user.address);
      expect(order.user).to.equal(user.address);
    });

    it("marks the session settled on completion", async function () {
      await verify(user, TIER_CAP);
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

  // ─── Liveness gate ──────────────────────────────────────────────────

  describe("liveness gate", function () {
    it("blocks a wallet with no attestation", async function () {
      expect(await integrator.effectiveLimit(user.address)).to.equal(0);
      await expect(
        integrator.connect(user).buyUsdc(USDC(5), INR, 1, "pubkey", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "NotVerified");
    });

    it("grants the attested limit and marks the wallet verified", async function () {
      await expect(verify(user, USDC(15)))
        .to.emit(integrator, "LivenessVerified")
        .withArgs(user.address, nullifierFor(`liveness:${user.address}`), USDC(15), USDC(15));

      expect(await integrator.verified(user.address)).to.equal(true);
      expect(await integrator.grantedLimit(user.address)).to.equal(USDC(15));
      expect(await integrator.effectiveLimit(user.address)).to.equal(USDC(15));
    });

    it("rejects a signature from the wrong signer", async function () {
      const nullifier = nullifierFor("wrong-signer");
      const expiry = await futureExpiry();
      const sig = await signAttestation(stranger, user.address, nullifier, TIER_CAP, expiry);
      await expect(
        integrator.connect(user).submitLivenessAttestation(nullifier, TIER_CAP, expiry, sig)
      ).to.be.revertedWithCustomError(integrator, "InvalidSignature");
    });

    it("rejects an expired attestation", async function () {
      const nullifier = nullifierFor("expired");
      const block = await ethers.provider.getBlock("latest");
      const expiry = BigInt(block!.timestamp);
      const sig = await signAttestation(attestor, user.address, nullifier, TIER_CAP, expiry);
      await expect(
        integrator.connect(user).submitLivenessAttestation(nullifier, TIER_CAP, expiry, sig)
      ).to.be.revertedWithCustomError(integrator, "AttestationExpired");
    });

    it("rejects a replayed nullifier (Sybil gate)", async function () {
      await verify(user, TIER_CAP, "shared-human");
      // Same human, different wallet — the nullifier is already spent.
      const nullifier = nullifierFor("shared-human");
      const expiry = await futureExpiry();
      const sig = await signAttestation(attestor, user2.address, nullifier, TIER_CAP, expiry);
      await expect(
        integrator.connect(user2).submitLivenessAttestation(nullifier, TIER_CAP, expiry, sig)
      ).to.be.revertedWithCustomError(integrator, "NullifierAlreadySpent");
    });

    it("rejects an attestation issued for a different wallet", async function () {
      const nullifier = nullifierFor("bound-to-user");
      const expiry = await futureExpiry();
      // Signed for `user`, submitted by `user2`.
      const sig = await signAttestation(attestor, user.address, nullifier, TIER_CAP, expiry);
      await expect(
        integrator.connect(user2).submitLivenessAttestation(nullifier, TIER_CAP, expiry, sig)
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
        TIER_CAP,
        expiry,
        await other.getAddress()
      );
      await expect(
        integrator.connect(user).submitLivenessAttestation(nullifier, TIER_CAP, expiry, sig)
      ).to.be.revertedWithCustomError(integrator, "InvalidSignature");
    });

    it("rejects the malleated (high-s) twin of a valid signature", async function () {
      const nullifier = nullifierFor("malleable");
      const expiry = await futureExpiry();
      const sig = await signAttestation(attestor, user.address, nullifier, TIER_CAP, expiry);

      const { r, s, v } = ethers.Signature.from(sig);
      const N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
      const flipped = ethers.concat([
        r,
        ethers.zeroPadValue(ethers.toBeHex(N - BigInt(s)), 32),
        ethers.toBeHex(v === 27 ? 28 : 27, 1),
      ]);
      await expect(
        integrator.connect(user).submitLivenessAttestation(nullifier, TIER_CAP, expiry, flipped)
      ).to.be.revertedWithCustomError(integrator, "InvalidSignature");
    });

    it("rejects a signature of the wrong length", async function () {
      const nullifier = nullifierFor("short-sig");
      const expiry = await futureExpiry();
      await expect(
        integrator.connect(user).submitLivenessAttestation(nullifier, TIER_CAP, expiry, "0xdead")
      ).to.be.revertedWithCustomError(integrator, "InvalidSignature");
    });

    it("reverts when no attestor is configured", async function () {
      const bare = await deployIntegrator(TIER_CAP, DAILY_COUNT, ethers.ZeroAddress);
      const nullifier = nullifierFor("no-attestor");
      const expiry = await futureExpiry();
      const sig = await signAttestation(attestor, user.address, nullifier, TIER_CAP, expiry);
      await expect(
        bare.connect(user).submitLivenessAttestation(nullifier, TIER_CAP, expiry, sig)
      ).to.be.revertedWithCustomError(bare, "AttestorNotSet");
    });

    it("is monotonic — a lower later attestation cannot downgrade the grant", async function () {
      await verify(user, USDC(18), "first");
      await verify(user, USDC(4), "second");
      expect(await integrator.grantedLimit(user.address)).to.equal(USDC(18));
    });
  });

  // ─── Per-tx cap ─────────────────────────────────────────────────────

  describe("per-tx cap", function () {
    it("clamps an over-generous attestation to the on-chain ceiling", async function () {
      // A compromised attestor key signs $10,000 — the ceiling is what binds.
      await verify(user, USDC(10_000));
      expect(await integrator.grantedLimit(user.address)).to.equal(USDC(10_000));
      expect(await integrator.effectiveLimit(user.address)).to.equal(TIER_CAP);

      await expect(
        integrator.connect(user).buyUsdc(USDC(21), INR, 1, "pubkey", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "VerificationLimitExceeded");
      await expect(integrator.connect(user).buyUsdc(USDC(20), INR, 1, "pubkey", 0, 0)).to.not.be
        .reverted;
    });

    it("uses the attested limit when it is below the ceiling", async function () {
      await verify(user, USDC(5));
      expect(await integrator.effectiveLimit(user.address)).to.equal(USDC(5));
      await expect(
        integrator.connect(user).buyUsdc(USDC(6), INR, 1, "pubkey", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "VerificationLimitExceeded");
    });

    it("rejects a zero amount", async function () {
      await verify(user, TIER_CAP);
      await expect(
        integrator.connect(user).buyUsdc(0, INR, 1, "pubkey", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "InvalidAmount");
    });

    it("exposes the widget-compatibility limit view", async function () {
      expect(await integrator.userTxLimit()).to.equal(TIER_CAP);
      await integrator.connect(owner).setLivenessTierCap(USDC(5));
      expect(await integrator.userTxLimit()).to.equal(USDC(5));
    });
  });

  // ─── Immutable ceilings ─────────────────────────────────────────────

  describe("immutable policy ceilings", function () {
    it("exposes the ceilings as constants", async function () {
      expect(await integrator.MAX_LIVENESS_TIER_CAP()).to.equal(USDC(20));
      expect(await integrator.MAX_DAILY_TX_COUNT_LIMIT()).to.equal(5);
    });

    it("refuses to deploy above the tier ceiling", async function () {
      await expect(deployIntegrator(USDC(21))).to.be.revertedWithCustomError(
        integrator,
        "CapExceedsCeiling"
      );
    });

    it("refuses to deploy above the daily-count ceiling, or at zero", async function () {
      await expect(deployIntegrator(TIER_CAP, 6)).to.be.revertedWithCustomError(
        integrator,
        "CapExceedsCeiling"
      );
      await expect(deployIntegrator(TIER_CAP, 0)).to.be.revertedWithCustomError(
        integrator,
        "InvalidLimit"
      );
    });

    it("lets the owner tighten the tier cap but never raise it past $20", async function () {
      await expect(integrator.connect(owner).setLivenessTierCap(USDC(5)))
        .to.emit(integrator, "LivenessTierCapUpdated")
        .withArgs(USDC(5));
      expect(await integrator.livenessTierCap()).to.equal(USDC(5));

      await expect(
        integrator.connect(owner).setLivenessTierCap(USDC(21))
      ).to.be.revertedWithCustomError(integrator, "CapExceedsCeiling");

      // Back up to the ceiling is legal — the ceiling is the bound, not the
      // current value.
      await integrator.connect(owner).setLivenessTierCap(USDC(20));
      expect(await integrator.livenessTierCap()).to.equal(USDC(20));
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

    it("halts new orders when the cap is set to 0, without un-verifying anyone", async function () {
      await verify(user, TIER_CAP);
      await integrator.connect(owner).setLivenessTierCap(0);

      expect(await integrator.effectiveLimit(user.address)).to.equal(0);
      await expect(
        integrator.connect(user).buyUsdc(USDC(1), INR, 1, "pubkey", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "NotVerified");

      // The attestation itself is untouched — restoring the cap restores access.
      expect(await integrator.verified(user.address)).to.equal(true);
      await integrator.connect(owner).setLivenessTierCap(TIER_CAP);
      expect(await integrator.effectiveLimit(user.address)).to.equal(TIER_CAP);
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
      await verify(user, TIER_CAP);
      // Even from the Diamond, and even for a fully verified wallet: without a
      // pending placement there is nothing to approve.
      const asDiamond = await impersonateDiamond();
      expect(
        await integrator.connect(asDiamond).validateOrder.staticCall(user.address, USDC(1), INR)
      ).to.equal(false);
    });

    it("flags a completion routed away from the buyer", async function () {
      await verify(user, TIER_CAP);
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
        .withArgs(orderId, user.address, user.address, USDC(10), integratorAddr);

      // …and the session is NOT marked settled on a mismatch.
      expect((await integrator.getSession(orderId)).settled).to.equal(false);
    });

    it("flags a completion with the wrong amount", async function () {
      await verify(user, TIER_CAP);
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).buyUsdc(USDC(10), INR, 1, "pubkey", 0, 0);

      await expect(
        mockDiamond.adminCallOnOrderComplete(
          integratorAddr,
          orderId,
          user.address,
          USDC(19),
          user.address
        )
      ).to.emit(integrator, "SettlementRoutingAnomaly");
    });

    it("ignores an unknown or already-settled order without reverting", async function () {
      await verify(user, TIER_CAP);
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
      await verify(user, TIER_CAP);
      const orderId = await buyAndComplete(user, USDC(10));
      // MockDiamond guards double-terminal transitions; call the hook directly.
      const asDiamond = await impersonateDiamond();
      await integrator.connect(asDiamond).onOrderCancel(orderId);

      const session = await integrator.getSession(orderId);
      expect(session.settled).to.equal(true);
      expect(session.cancelled).to.equal(false);
    });

    it("cannot settle an already-cancelled order", async function () {
      await verify(user, TIER_CAP);
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).buyUsdc(USDC(10), INR, 1, "pubkey", 0, 0);
      await mockDiamond.simulateOrderCancelled(orderId);

      await mockDiamond.adminCallOnOrderComplete(
        integratorAddr,
        orderId,
        user.address,
        USDC(10),
        user.address
      );
      const session = await integrator.getSession(orderId);
      expect(session.cancelled).to.equal(true);
      expect(session.settled).to.equal(false);
    });
  });

  // ─── Administration ─────────────────────────────────────────────────

  describe("administration", function () {
    it("restricts every setter to the owner", async function () {
      await expect(
        integrator.connect(stranger).setAttestor(stranger.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
      await expect(
        integrator.connect(stranger).setLivenessTierCap(1)
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
      await expect(integrator.connect(stranger).unpause()).to.be.revertedWithCustomError(
        integrator,
        "OnlyOwner"
      );
      await expect(
        integrator.connect(stranger).sweepUsdc(stranger.address, 1)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });

    it("pauses and resumes the onramp", async function () {
      await verify(user, TIER_CAP);
      await expect(integrator.connect(owner).pause())
        .to.emit(integrator, "Paused")
        .withArgs(owner.address);
      await expect(
        integrator.connect(user).buyUsdc(USDC(1), INR, 1, "pubkey", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "ContractPaused");

      await expect(integrator.connect(owner).unpause())
        .to.emit(integrator, "Unpaused")
        .withArgs(owner.address);
      await expect(integrator.connect(user).buyUsdc(USDC(1), INR, 1, "pubkey", 0, 0)).to.not.be
        .reverted;
    });

    it("refuses to validate while paused", async function () {
      await verify(user, TIER_CAP);
      await integrator.connect(owner).pause();
      const asDiamond = await impersonateDiamond();
      expect(
        await integrator.connect(asDiamond).validateOrder.staticCall(user.address, USDC(1), INR)
      ).to.equal(false);
    });

    it("blocks a wallet", async function () {
      await verify(user, TIER_CAP);
      await expect(integrator.connect(owner).setBlocked(user.address, true))
        .to.emit(integrator, "UserBlocked")
        .withArgs(user.address, true);

      expect(await integrator.effectiveLimit(user.address)).to.equal(0);
      await expect(
        integrator.connect(user).buyUsdc(USDC(1), INR, 1, "pubkey", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "UserIsBlocked");

      await integrator.connect(owner).setBlocked(user.address, false);
      expect(await integrator.effectiveLimit(user.address)).to.equal(TIER_CAP);
    });

    it("rotates the attestor without touching existing grants", async function () {
      await verify(user, USDC(18));
      await expect(integrator.connect(owner).setAttestor(stranger.address))
        .to.emit(integrator, "AttestorUpdated")
        .withArgs(stranger.address);
      expect(await integrator.attestor()).to.equal(stranger.address);
      expect(await integrator.grantedLimit(user.address)).to.equal(USDC(18));

      // The old key no longer verifies anyone.
      const nullifier = nullifierFor("after-rotation");
      const expiry = await futureExpiry();
      const sig = await signAttestation(attestor, user2.address, nullifier, USDC(10), expiry);
      await expect(
        integrator.connect(user2).submitLivenessAttestation(nullifier, USDC(10), expiry, sig)
      ).to.be.revertedWithCustomError(integrator, "InvalidSignature");
    });

    it("sweeps stray USDC — the contract holds none in normal operation", async function () {
      await verify(user, TIER_CAP);
      await buyAndComplete(user, USDC(20));
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
      expect(await integrator.livenessTierCap()).to.equal(TIER_CAP);
      expect(await integrator.dailyTxCountLimit()).to.equal(DAILY_COUNT);
      expect(await integrator.paused()).to.equal(false);
    });

    it("rejects zero addresses for the core wiring", async function () {
      const F = await ethers.getContractFactory("PlasmaPayCheckoutIntegrator");
      await expect(
        F.deploy(
          ethers.ZeroAddress,
          usdcAddr,
          owner.address,
          attestor.address,
          TIER_CAP,
          DAILY_COUNT
        )
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      await expect(
        F.deploy(
          diamondAddr,
          ethers.ZeroAddress,
          owner.address,
          attestor.address,
          TIER_CAP,
          DAILY_COUNT
        )
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      await expect(
        F.deploy(diamondAddr, usdcAddr, ethers.ZeroAddress, attestor.address, TIER_CAP, DAILY_COUNT)
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

      await verify(user, TIER_CAP);
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
        name: "LivenessVerifier",
        version: "1",
        chainId,
        verifyingContract: integratorAddr,
      });
      expect(await integrator.domainSeparator()).to.equal(expected);
    });
  });
});
