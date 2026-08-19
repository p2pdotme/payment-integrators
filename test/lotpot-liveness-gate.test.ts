import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * LotPot V2 anti-sybil liveness gate (LivenessGate mixin). The attestor is a
 * plain hardhat signer here; the gate only checks `ecrecover(...) == attestor`,
 * so a locally-signed EIP-712 struct is indistinguishable from one the real
 * simple-kyc liveness service signs. The gate is OFF by default — these tests
 * also lock in that existing behavior is unchanged until the owner enables it.
 */
describe("LotPotCheckoutIntegratorV2 — liveness gate (anti-sybil)", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let user2: SignerWithAddress;
  let stranger: SignerWithAddress;
  let attestor: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let mockMegapot: any;
  let mockBatch: any;
  let mockNft: any;
  let integrator: any;
  let integratorAddr: string;
  let chainId: bigint;

  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
  const TICKET_PRICE = USDC(1);
  const BASE_TX_LIMIT = USDC(50);
  const DAILY_COUNT_LIMIT = 10;
  const BALL_MAX = 30;
  const BONUSBALL_MAX = 15;
  const SOURCE = ethers.encodeBytes32String("lotpot-v2");
  const INR = ethers.encodeBytes32String("INR");
  const LIVENESS_LIMIT = USDC(20); // recorded in the attestation; LotPot ignores it

  const nullifierFor = (label: string) => ethers.keccak256(ethers.toUtf8Bytes(label));
  async function futureExpiry(secondsAhead = 3600): Promise<bigint> {
    const block = await ethers.provider.getBlock("latest");
    return BigInt(block!.timestamp) + BigInt(secondsAhead);
  }
  async function signLiveness(
    signer: SignerWithAddress,
    wallet: string,
    nullifier: string,
    limit: bigint,
    expiry: bigint
  ): Promise<string> {
    return signer.signTypedData(
      { name: "LivenessVerifier", version: "1", chainId, verifyingContract: integratorAddr },
      {
        LivenessAttestation: [
          { name: "wallet", type: "address" },
          { name: "nullifier", type: "bytes32" },
          { name: "limit", type: "uint256" },
          { name: "expiry", type: "uint256" },
        ],
      },
      { wallet, nullifier, limit, expiry }
    );
  }
  /** Verify `who` (gate helper). Defaults the nullifier to a per-wallet value. */
  async function verify(who: SignerWithAddress, nullifierLabel?: string) {
    const nullifier = nullifierFor(nullifierLabel ?? `liveness:${who.address}`);
    const expiry = await futureExpiry();
    const sig = await signLiveness(attestor, who.address, nullifier, LIVENESS_LIMIT, expiry);
    return integrator
      .connect(who)
      .submitLivenessAttestation(nullifier, LIVENESS_LIMIT, expiry, sig);
  }

  beforeEach(async function () {
    [owner, user, user2, stranger, attestor] = await ethers.getSigners();
    chainId = (await ethers.provider.getNetwork()).chainId;

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUsdc = await MockUSDC.deploy();
    const MockDiamond = await ethers.getContractFactory("MockDiamond");
    mockDiamond = await MockDiamond.deploy(await mockUsdc.getAddress());
    const MockJackpotNFT = await ethers.getContractFactory("MockJackpotNFT");
    mockNft = await MockJackpotNFT.deploy();
    const MockMegapot = await ethers.getContractFactory("MockMegapot");
    mockMegapot = await MockMegapot.deploy(
      await mockUsdc.getAddress(),
      await mockNft.getAddress(),
      TICKET_PRICE,
      BALL_MAX,
      BONUSBALL_MAX
    );
    const MockBatch = await ethers.getContractFactory("MockBatchPurchaseFacilitator");
    mockBatch = await MockBatch.deploy(
      await mockUsdc.getAddress(),
      await mockNft.getAddress(),
      TICKET_PRICE,
      BALL_MAX,
      BONUSBALL_MAX,
      11
    );
    const Integrator = await ethers.getContractFactory("LotPotCheckoutIntegratorV2");
    integrator = await Integrator.deploy(
      await mockDiamond.getAddress(),
      await mockUsdc.getAddress(),
      await mockMegapot.getAddress(),
      await mockBatch.getAddress(),
      await mockNft.getAddress(),
      BASE_TX_LIMIT,
      DAILY_COUNT_LIMIT,
      SOURCE
    );
    integratorAddr = await integrator.getAddress();
    await mockDiamond.registerIntegrator(integratorAddr, await integrator.proxyImpl());
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(10000));
    await mockBatch.addAllowed(integratorAddr);
  });

  // ─── Default off = unchanged behavior ───────────────────────────────

  it("defaults to OFF — orders work without any verification", async function () {
    expect(await integrator.livenessRequired()).to.equal(false);
    expect(await integrator.livenessAttestor()).to.equal(ethers.ZeroAddress);
    await expect(integrator.connect(user).userPlaceOrder(2, INR, 1, "", 0, 0, [], [])).to.not.be
      .reverted;
    await expect(mockDiamond.simulateOrderComplete(1)).to.not.be.reverted;
  });

  // ─── Attestation intake ─────────────────────────────────────────────

  describe("submitLivenessAttestation", function () {
    beforeEach(async function () {
      await integrator.setLivenessAttestor(attestor.address);
    });

    it("marks the caller verified and emits LivenessVerified", async function () {
      const nullifier = nullifierFor("ok");
      const expiry = await futureExpiry();
      const sig = await signLiveness(attestor, user.address, nullifier, LIVENESS_LIMIT, expiry);
      await expect(
        integrator.connect(user).submitLivenessAttestation(nullifier, LIVENESS_LIMIT, expiry, sig)
      )
        .to.emit(integrator, "LivenessVerified")
        .withArgs(user.address, nullifier, LIVENESS_LIMIT, expiry);
      expect(await integrator.livenessVerified(user.address)).to.equal(true);
      expect(await integrator.livenessNullifierSpent(nullifier)).to.equal(true);
    });

    it("reverts on a wrong signer", async function () {
      const nullifier = nullifierFor("wrong");
      const expiry = await futureExpiry();
      const sig = await signLiveness(stranger, user.address, nullifier, LIVENESS_LIMIT, expiry);
      await expect(
        integrator.connect(user).submitLivenessAttestation(nullifier, LIVENESS_LIMIT, expiry, sig)
      ).to.be.revertedWithCustomError(integrator, "LivenessInvalidSignature");
    });

    it("reverts on a signature bound to a different wallet", async function () {
      const nullifier = nullifierFor("mismatch");
      const expiry = await futureExpiry();
      const sig = await signLiveness(attestor, user2.address, nullifier, LIVENESS_LIMIT, expiry);
      await expect(
        integrator.connect(user).submitLivenessAttestation(nullifier, LIVENESS_LIMIT, expiry, sig)
      ).to.be.revertedWithCustomError(integrator, "LivenessInvalidSignature");
    });

    it("reverts on an expired attestation", async function () {
      const nullifier = nullifierFor("expired");
      const block = await ethers.provider.getBlock("latest");
      const expiry = BigInt(block!.timestamp) - 1n;
      const sig = await signLiveness(attestor, user.address, nullifier, LIVENESS_LIMIT, expiry);
      await expect(
        integrator.connect(user).submitLivenessAttestation(nullifier, LIVENESS_LIMIT, expiry, sig)
      ).to.be.revertedWithCustomError(integrator, "LivenessAttestationExpired");
    });

    it("rejects a replayed nullifier — one human, one wallet (sybil resistance)", async function () {
      await verify(user, "shared-human");
      // A second wallet presenting the SAME human's nullifier is rejected.
      const nullifier = nullifierFor("shared-human");
      const expiry = await futureExpiry();
      const sig = await signLiveness(attestor, user2.address, nullifier, LIVENESS_LIMIT, expiry);
      await expect(
        integrator.connect(user2).submitLivenessAttestation(nullifier, LIVENESS_LIMIT, expiry, sig)
      ).to.be.revertedWithCustomError(integrator, "LivenessNullifierAlreadySpent");
    });

    it("reverts when the attestor is unset (fresh integrator)", async function () {
      const Integrator = await ethers.getContractFactory("LotPotCheckoutIntegratorV2");
      const bare = await Integrator.deploy(
        await mockDiamond.getAddress(),
        await mockUsdc.getAddress(),
        await mockMegapot.getAddress(),
        await mockBatch.getAddress(),
        await mockNft.getAddress(),
        BASE_TX_LIMIT,
        DAILY_COUNT_LIMIT,
        SOURCE
      );
      await expect(
        bare
          .connect(user)
          .submitLivenessAttestation(nullifierFor("x"), LIVENESS_LIMIT, await futureExpiry(), "0x")
      ).to.be.revertedWithCustomError(bare, "LivenessAttestorNotSet");
    });
  });

  // ─── The gate ───────────────────────────────────────────────────────

  describe("verify-everyone mode (livenessRequiredForAll = true)", function () {
    beforeEach(async function () {
      await integrator.setLivenessAttestor(attestor.address);
      await integrator.setLivenessRequired(true);
      await integrator.setLivenessRequiredForAll(true);
    });

    async function diamondSigner() {
      await ethers.provider.send("hardhat_impersonateAccount", [await mockDiamond.getAddress()]);
      await ethers.provider.send("hardhat_setBalance", [
        await mockDiamond.getAddress(),
        "0xde0b6b3a7640000",
      ]);
      return ethers.getSigner(await mockDiamond.getAddress());
    }

    it("blocks an unverified user at userPlaceOrder (clear revert)", async function () {
      await expect(
        integrator.connect(user).userPlaceOrder(1, INR, 1, "", 0, 0, [], [])
      ).to.be.revertedWithCustomError(integrator, "NotLivenessVerified");
      await expect(
        integrator
          .connect(user)
          .userPlaceOrderWithPicks(
            [{ normals: [1, 2, 3, 4, 5], bonusball: 1 }],
            INR,
            1,
            "",
            0,
            0,
            [],
            []
          )
      ).to.be.revertedWithCustomError(integrator, "NotLivenessVerified");
    });

    it("blocks an unverified user authoritatively at validateOrder", async function () {
      const d = await diamondSigner();
      expect(
        await integrator.connect(d).validateOrder.staticCall(user.address, USDC(1), INR)
      ).to.equal(false);
    });

    it("lets a verified user place + complete, and validateOrder returns true", async function () {
      await verify(user);
      const d = await diamondSigner();
      expect(
        await integrator.connect(d).validateOrder.staticCall(user.address, USDC(1), INR)
      ).to.equal(true);
      await expect(integrator.connect(user).userPlaceOrder(2, INR, 1, "", 0, 0, [], [])).to.not.be
        .reverted;
      await expect(mockDiamond.simulateOrderComplete(1)).to.not.be.reverted;
    });

    it("can be turned off again, restoring open access", async function () {
      await integrator.setLivenessRequired(false);
      await expect(integrator.connect(user).userPlaceOrder(1, INR, 1, "", 0, 0, [], [])).to.not.be
        .reverted;
    });
  });

  // ─── Suspect-only mode (default when armed) — the fraud-engine flow ──

  describe("suspect-only mode (armed, livenessRequiredForAll = false)", function () {
    beforeEach(async function () {
      await integrator.setLivenessAttestor(attestor.address);
      await integrator.setLivenessRequired(true);
      // livenessRequiredForAll stays false → only flagged users must verify.
    });

    async function diamondSigner() {
      await ethers.provider.send("hardhat_impersonateAccount", [await mockDiamond.getAddress()]);
      await ethers.provider.send("hardhat_setBalance", [
        await mockDiamond.getAddress(),
        "0xde0b6b3a7640000",
      ]);
      return ethers.getSigner(await mockDiamond.getAddress());
    }

    it("does NOT prompt an unflagged user — orders work without verification", async function () {
      const d = await diamondSigner();
      expect(
        await integrator.connect(d).validateOrder.staticCall(user.address, USDC(1), INR)
      ).to.equal(true);
      await expect(integrator.connect(user).userPlaceOrder(1, INR, 1, "", 0, 0, [], [])).to.not.be
        .reverted;
    });

    it("blocks a flagged (suspect) user until they verify — userPlaceOrder + validateOrder", async function () {
      await expect(integrator.setLivenessSuspect(user.address, true))
        .to.emit(integrator, "LivenessSuspectUpdated")
        .withArgs(user.address, true);
      await expect(
        integrator.connect(user).userPlaceOrder(1, INR, 1, "", 0, 0, [], [])
      ).to.be.revertedWithCustomError(integrator, "NotLivenessVerified");
      const d = await diamondSigner();
      expect(
        await integrator.connect(d).validateOrder.staticCall(user.address, USDC(1), INR)
      ).to.equal(false);
    });

    it("clears a flagged user once they pass liveness", async function () {
      await integrator.setLivenessSuspect(user.address, true);
      await verify(user);
      const d = await diamondSigner();
      expect(
        await integrator.connect(d).validateOrder.staticCall(user.address, USDC(1), INR)
      ).to.equal(true);
      await expect(integrator.connect(user).userPlaceOrder(2, INR, 1, "", 0, 0, [], [])).to.not.be
        .reverted;
    });

    it("un-flagging a suspect restores open access without verification", async function () {
      await integrator.setLivenessSuspect(user.address, true);
      await integrator.setLivenessSuspect(user.address, false);
      await expect(integrator.connect(user).userPlaceOrder(1, INR, 1, "", 0, 0, [], [])).to.not.be
        .reverted;
    });

    it("batch-flags many fresh sybil wallets in one tx", async function () {
      await integrator.setLivenessSuspectBatch([user.address, user2.address], true);
      expect(await integrator.livenessSuspect(user.address)).to.equal(true);
      expect(await integrator.livenessSuspect(user2.address)).to.equal(true);
      await expect(
        integrator.connect(user2).userPlaceOrder(1, INR, 1, "", 0, 0, [], [])
      ).to.be.revertedWithCustomError(integrator, "NotLivenessVerified");
    });

    it("a flagged sybil that verifies still can't spin a second wallet (nullifier spent)", async function () {
      // Operator flags two fresh wallets of the same human.
      await integrator.setLivenessSuspectBatch([user.address, user2.address], true);
      await verify(user, "one-human"); // wallet #1 clears
      // Wallet #2 presenting the SAME human's nullifier is rejected …
      const expiry = await futureExpiry();
      const sig = await signLiveness(
        attestor,
        user2.address,
        nullifierFor("one-human"),
        LIVENESS_LIMIT,
        expiry
      );
      await expect(
        integrator
          .connect(user2)
          .submitLivenessAttestation(nullifierFor("one-human"), LIVENESS_LIMIT, expiry, sig)
      ).to.be.revertedWithCustomError(integrator, "LivenessNullifierAlreadySpent");
      // … so wallet #2 stays blocked.
      await expect(
        integrator.connect(user2).userPlaceOrder(1, INR, 1, "", 0, 0, [], [])
      ).to.be.revertedWithCustomError(integrator, "NotLivenessVerified");
    });
  });

  // ─── Access control ─────────────────────────────────────────────────

  it("only the owner can configure the gate", async function () {
    await expect(
      integrator.connect(stranger).setLivenessAttestor(stranger.address)
    ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    await expect(
      integrator.connect(stranger).setLivenessRequired(true)
    ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    await expect(
      integrator.connect(stranger).setLivenessRequiredForAll(true)
    ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    await expect(
      integrator.connect(stranger).setLivenessSuspect(user.address, true)
    ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    await expect(
      integrator.connect(stranger).setLivenessSuspectBatch([user.address], true)
    ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
  });
});
