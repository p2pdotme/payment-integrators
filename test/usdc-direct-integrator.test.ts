import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const TIER = { NONE: 0, LIVENESS: 1, KYC: 2 };

/**
 * UsdcDirectCheckoutIntegrator: an onramp integrator that delivers USDC
 * directly to the user's EOA, gated by simple-kyc EIP-712 attestations.
 *
 * The attestor keys are plain hardhat signers here; the integrator only ever
 * checks `ecrecover(...) == attestor`, so a locally-signed EIP-712 struct is
 * indistinguishable from one the real simple-kyc service signs.
 */
describe("UsdcDirectCheckoutIntegrator", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let user2: SignerWithAddress;
  let stranger: SignerWithAddress;
  let livenessAttestor: SignerWithAddress;
  let kycAttestor: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let integrator: any;
  let integratorAddr: string;
  let chainId: bigint;

  const USDC = (n: number | string) => ethers.parseUnits(n.toString(), 6);
  const INR = ethers.encodeBytes32String("INR");
  const DAILY_COUNT = 10;
  const LIVENESS_LIMIT = USDC(20);
  const KYC_LIMIT = USDC(100);

  function nullifierFor(label: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(label));
  }

  async function futureExpiry(secondsAhead = 3600): Promise<bigint> {
    const block = await ethers.provider.getBlock("latest");
    return BigInt(block!.timestamp) + BigInt(secondsAhead);
  }

  async function signAttestation(
    service: "kyc" | "liveness",
    attestor: SignerWithAddress,
    wallet: string,
    nullifier: string,
    limit: bigint,
    expiry: bigint
  ): Promise<string> {
    const isKyc = service === "kyc";
    const domain = {
      name: isKyc ? "KycVerifier" : "LivenessVerifier",
      version: "1",
      chainId,
      verifyingContract: integratorAddr,
    };
    const types = {
      [isKyc ? "KycAttestation" : "LivenessAttestation"]: [
        { name: "wallet", type: "address" },
        { name: "nullifier", type: "bytes32" },
        { name: "limit", type: "uint256" },
        { name: "expiry", type: "uint256" },
      ],
    };
    const value = { wallet, nullifier, limit, expiry };
    return attestor.signTypedData(domain, types, value);
  }

  /** Verify a tier for `who` with the right service/attestor. */
  async function verify(
    who: SignerWithAddress,
    service: "kyc" | "liveness",
    limit: bigint,
    label?: string
  ) {
    const attestor = service === "kyc" ? kycAttestor : livenessAttestor;
    const nullifier = nullifierFor(label ?? `${service}:${who.address}`);
    const expiry = await futureExpiry();
    const sig = await signAttestation(service, attestor, who.address, nullifier, limit, expiry);
    const fn = service === "kyc" ? "submitKycAttestation" : "submitLivenessAttestation";
    return integrator.connect(who)[fn](nullifier, limit, expiry, sig);
  }

  /** Place a USDC-direct buy and drive it to completion on the mock Diamond. */
  async function buyAndComplete(who: SignerWithAddress, amount: bigint) {
    const orderIdBefore = await mockDiamond.nextOrderId();
    await integrator.connect(who).userBuyUsdc(amount, INR, 1, "", 0, 0);
    await mockDiamond.simulateOrderComplete(orderIdBefore);
    return orderIdBefore;
  }

  beforeEach(async function () {
    [owner, user, user2, stranger, livenessAttestor, kycAttestor] = await ethers.getSigners();
    chainId = (await ethers.provider.getNetwork()).chainId;

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUsdc = await MockUSDC.deploy();

    const MockDiamond = await ethers.getContractFactory("MockDiamond");
    mockDiamond = await MockDiamond.deploy(await mockUsdc.getAddress());

    const Integrator = await ethers.getContractFactory("UsdcDirectCheckoutIntegrator");
    integrator = await Integrator.deploy(
      await mockDiamond.getAddress(),
      await mockUsdc.getAddress(),
      DAILY_COUNT,
      livenessAttestor.address,
      kycAttestor.address
    );
    integratorAddr = await integrator.getAddress();

    await mockDiamond.registerIntegrator(integratorAddr, await integrator.proxyImpl());
    // Fund the Diamond so completion can deliver USDC to the recipient EOA.
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(1_000_000));
  });

  // ─── Attestation intake ─────────────────────────────────────────────

  describe("attestation intake", function () {
    it("liveness attestation grants the liveness per-tx limit + tier 1", async function () {
      await expect(verify(user, "liveness", LIVENESS_LIMIT))
        .to.emit(integrator, "KycClaimed")
        .withArgs(
          user.address,
          TIER.LIVENESS,
          nullifierFor(`liveness:${user.address}`),
          LIVENESS_LIMIT,
          LIVENESS_LIMIT
        );

      expect(await integrator.grantedLimit(user.address)).to.equal(LIVENESS_LIMIT);
      expect(await integrator.userTier(user.address)).to.equal(TIER.LIVENESS);
      expect(await integrator.effectiveLimit(user.address)).to.equal(LIVENESS_LIMIT);
    });

    it("kyc attestation grants the kyc per-tx limit + tier 2", async function () {
      await verify(user, "kyc", KYC_LIMIT);
      expect(await integrator.grantedLimit(user.address)).to.equal(KYC_LIMIT);
      expect(await integrator.userTier(user.address)).to.equal(TIER.KYC);
    });

    it("tiers stack monotonically — a lower later claim never lowers the limit", async function () {
      await verify(user, "kyc", KYC_LIMIT, "kyc-A");
      await verify(user, "liveness", LIVENESS_LIMIT, "liveness-A");
      expect(await integrator.grantedLimit(user.address)).to.equal(KYC_LIMIT);
      expect(await integrator.userTier(user.address)).to.equal(TIER.KYC);
    });

    it("rejects a replayed nullifier", async function () {
      await verify(user, "liveness", LIVENESS_LIMIT, "dup");
      const expiry = await futureExpiry();
      const sig = await signAttestation(
        "liveness",
        livenessAttestor,
        user.address,
        nullifierFor("dup"),
        LIVENESS_LIMIT,
        expiry
      );
      await expect(
        integrator
          .connect(user)
          .submitLivenessAttestation(nullifierFor("dup"), LIVENESS_LIMIT, expiry, sig)
      ).to.be.revertedWithCustomError(integrator, "NullifierAlreadySpent");
    });

    it("rejects a signature from the wrong signer", async function () {
      const nullifier = nullifierFor("wrong-signer");
      const expiry = await futureExpiry();
      // Sign a liveness attestation with the KYC attestor (wrong key for this path).
      const sig = await signAttestation(
        "liveness",
        kycAttestor,
        user.address,
        nullifier,
        LIVENESS_LIMIT,
        expiry
      );
      await expect(
        integrator.connect(user).submitLivenessAttestation(nullifier, LIVENESS_LIMIT, expiry, sig)
      ).to.be.revertedWithCustomError(integrator, "InvalidSignature");
    });

    it("rejects a signature bound to a different wallet", async function () {
      // Attestor signs for user2, but user submits it.
      const nullifier = nullifierFor("wallet-mismatch");
      const expiry = await futureExpiry();
      const sig = await signAttestation(
        "liveness",
        livenessAttestor,
        user2.address,
        nullifier,
        LIVENESS_LIMIT,
        expiry
      );
      await expect(
        integrator.connect(user).submitLivenessAttestation(nullifier, LIVENESS_LIMIT, expiry, sig)
      ).to.be.revertedWithCustomError(integrator, "InvalidSignature");
    });

    it("rejects an expired attestation", async function () {
      const nullifier = nullifierFor("expired");
      const block = await ethers.provider.getBlock("latest");
      const expiry = BigInt(block!.timestamp) - 1n;
      const sig = await signAttestation(
        "liveness",
        livenessAttestor,
        user.address,
        nullifier,
        LIVENESS_LIMIT,
        expiry
      );
      await expect(
        integrator.connect(user).submitLivenessAttestation(nullifier, LIVENESS_LIMIT, expiry, sig)
      ).to.be.revertedWithCustomError(integrator, "AttestationExpired");
    });

    it("reverts when the attestor is unset (fail closed)", async function () {
      const Integrator = await ethers.getContractFactory("UsdcDirectCheckoutIntegrator");
      const bare = await Integrator.deploy(
        await mockDiamond.getAddress(),
        await mockUsdc.getAddress(),
        DAILY_COUNT,
        ethers.ZeroAddress,
        ethers.ZeroAddress
      );
      const nullifier = nullifierFor("no-attestor");
      const expiry = await futureExpiry();
      await expect(
        bare.connect(user).submitLivenessAttestation(nullifier, LIVENESS_LIMIT, expiry, "0x")
      ).to.be.revertedWithCustomError(bare, "AttestorNotSet");
    });
  });

  // ─── USDC-direct onramp ─────────────────────────────────────────────

  describe("USDC-direct onramp", function () {
    it("blocks a buy with no verification", async function () {
      await expect(
        integrator.connect(user).userBuyUsdc(USDC(5), INR, 1, "", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "NotKycVerified");
    });

    it("delivers USDC straight to the user's EOA on completion", async function () {
      await verify(user, "liveness", LIVENESS_LIMIT);
      const before = await mockUsdc.balanceOf(user.address);

      await buyAndComplete(user, LIVENESS_LIMIT);

      const after = await mockUsdc.balanceOf(user.address);
      expect(after - before).to.equal(LIVENESS_LIMIT);

      // The proxy is only the caller; it must never hold USDC.
      const proxy = await integrator.proxyAddress(user.address);
      expect(await mockUsdc.balanceOf(proxy)).to.equal(0);
      // Nor does the integrator touch USDC.
      expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(0);
    });

    it("rejects a buy above the attested per-tx limit", async function () {
      await verify(user, "liveness", LIVENESS_LIMIT);
      await expect(
        integrator.connect(user).userBuyUsdc(LIVENESS_LIMIT + 1n, INR, 1, "", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "KycLimitExceeded");
    });

    it("a KYC-tier user can buy up to the higher limit", async function () {
      await verify(user, "kyc", KYC_LIMIT);
      const before = await mockUsdc.balanceOf(user.address);
      await buyAndComplete(user, KYC_LIMIT);
      expect((await mockUsdc.balanceOf(user.address)) - before).to.equal(KYC_LIMIT);
    });

    it("marks the session fulfilled on completion", async function () {
      await verify(user, "kyc", KYC_LIMIT);
      const orderId = await buyAndComplete(user, USDC(30));
      const session = await integrator.getSession(orderId);
      expect(session.user).to.equal(user.address);
      expect(session.fulfilled).to.equal(true);
      expect(session.amount).to.equal(USDC(30));
    });
  });

  // ─── Owner ceiling + budgets ────────────────────────────────────────

  describe("limits & budgets", function () {
    it("perTxUsdcCap clamps the effective limit below the attested limit", async function () {
      await verify(user, "kyc", KYC_LIMIT);
      await integrator.setPerTxUsdcCap(USDC(50));
      expect(await integrator.effectiveLimit(user.address)).to.equal(USDC(50));
      await expect(
        integrator.connect(user).userBuyUsdc(USDC(51), INR, 1, "", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "KycLimitExceeded");
      // ...but a buy within the clamp is fine.
      await expect(integrator.connect(user).userBuyUsdc(USDC(50), INR, 1, "", 0, 0)).to.not.be
        .reverted;
    });

    it("enforces the daily order-count limit via validateOrder", async function () {
      await verify(user, "kyc", KYC_LIMIT);
      await integrator.setDailyTxCountLimit(1);
      await buyAndComplete(user, USDC(10));
      // Second placement same day: validateOrder returns false -> the gateway
      // reverts, surfaced through UserProxy.execute as a wrapped CallFailed.
      await expect(integrator.connect(user).userBuyUsdc(USDC(10), INR, 1, "", 0, 0)).to.be.reverted;
    });

    it("enforces an optional daily USDC volume cap", async function () {
      await verify(user, "kyc", KYC_LIMIT);
      await integrator.setDailyUsdcVolumeCap(USDC(30));
      await buyAndComplete(user, USDC(20));
      // 20 + 20 > 30 -> blocked by the pre-check.
      await expect(
        integrator.connect(user).userBuyUsdc(USDC(20), INR, 1, "", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "DailyVolumeExceeded");
      // A smaller top-up that fits is allowed.
      await expect(integrator.connect(user).userBuyUsdc(USDC(10), INR, 1, "", 0, 0)).to.not.be
        .reverted;
    });

    it("releases the daily count slot when an order is cancelled", async function () {
      await verify(user, "kyc", KYC_LIMIT);
      await integrator.setDailyTxCountLimit(1);
      const orderIdBefore = await mockDiamond.nextOrderId();
      await integrator.connect(user).userBuyUsdc(USDC(10), INR, 1, "", 0, 0);
      // Cancel frees the slot, so the user can place again the same day.
      await mockDiamond.simulateOrderCancelled(orderIdBefore);
      await expect(integrator.connect(user).userBuyUsdc(USDC(10), INR, 1, "", 0, 0)).to.not.be
        .reverted;
    });
  });

  // ─── Access control ─────────────────────────────────────────────────

  describe("access control", function () {
    it("only the Diamond can call validateOrder / onOrderComplete / onOrderCancel", async function () {
      await expect(
        integrator.connect(stranger).validateOrder(user.address, USDC(10), INR)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
      await expect(
        integrator.connect(stranger).onOrderComplete(1, user.address, USDC(10), user.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
      await expect(integrator.connect(stranger).onOrderCancel(1)).to.be.revertedWithCustomError(
        integrator,
        "OnlyDiamond"
      );
    });

    it("only the owner can set attestors / caps", async function () {
      await expect(
        integrator.connect(stranger).setKycAttestor(stranger.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
      await expect(
        integrator.connect(stranger).setPerTxUsdcCap(USDC(1))
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
      await expect(
        integrator.connect(stranger).setDailyUsdcVolumeCap(USDC(1))
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });

    it("owner can rotate attestors", async function () {
      await integrator.setLivenessAttestor(stranger.address);
      expect(await integrator.livenessAttestor()).to.equal(stranger.address);
    });
  });
});
