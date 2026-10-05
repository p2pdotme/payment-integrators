import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const TIER = { NONE: 0, LIVENESS: 1, KYC: 2 };

describe("UnifyVaultCheckoutIntegrator", function () {
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

  async function buyAndComplete(who: SignerWithAddress, amount: bigint) {
    const orderIdBefore = await mockDiamond.nextOrderId();
    await integrator.connect(who).userBuyUsdc(amount, INR, 1, "test-pubkey", 0, 0);
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

    const Integrator = await ethers.getContractFactory("UnifyVaultCheckoutIntegrator");
    integrator = await Integrator.deploy(
      await mockDiamond.getAddress(),
      await mockUsdc.getAddress(),
      DAILY_COUNT,
      livenessAttestor.address,
      kycAttestor.address
    );
    integratorAddr = await integrator.getAddress();

    await mockDiamond.registerIntegrator(integratorAddr, await integrator.proxyImpl());
    // Fund Diamond for direct buy settlement
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(1_000_000));
  });

  describe("attestation verification", function () {
    it("liveness attestation sets tier 1 and attested limit", async function () {
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

    it("kyc attestation sets tier 2 and higher limit", async function () {
      await verify(user, "kyc", KYC_LIMIT);
      expect(await integrator.grantedLimit(user.address)).to.equal(KYC_LIMIT);
      expect(await integrator.userTier(user.address)).to.equal(TIER.KYC);
    });

    it("rejects replayed nullifiers across claims", async function () {
      await verify(user, "liveness", LIVENESS_LIMIT, "replayed-id");
      const expiry = await futureExpiry();
      const sig = await signAttestation(
        "liveness",
        livenessAttestor,
        user.address,
        nullifierFor("replayed-id"),
        LIVENESS_LIMIT,
        expiry
      );
      await expect(
        integrator
          .connect(user)
          .submitLivenessAttestation(nullifierFor("replayed-id"), LIVENESS_LIMIT, expiry, sig)
      ).to.be.revertedWithCustomError(integrator, "NullifierAlreadySpent");
    });

    it("rejects signatures with incorrect signers", async function () {
      const nullifier = nullifierFor("wrong-signer-test");
      const expiry = await futureExpiry();
      const sig = await signAttestation(
        "liveness",
        kycAttestor, // wrong key for liveness
        user.address,
        nullifier,
        LIVENESS_LIMIT,
        expiry
      );
      await expect(
        integrator.connect(user).submitLivenessAttestation(nullifier, LIVENESS_LIMIT, expiry, sig)
      ).to.be.revertedWithCustomError(integrator, "InvalidSignature");
    });
  });

  describe("BUY flow (INR → USDC → user's wallet)", function () {
    it("blocks order placement without verification", async function () {
      await expect(
        integrator.connect(user).userBuyUsdc(USDC(10), INR, 1, "test-pubkey", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "NotKycVerified");
    });

    it("delivers USDC straight to user's wallet on completion", async function () {
      await verify(user, "liveness", LIVENESS_LIMIT);
      const userBalanceBefore = await mockUsdc.balanceOf(user.address);

      await buyAndComplete(user, LIVENESS_LIMIT);

      const userBalanceAfter = await mockUsdc.balanceOf(user.address);
      expect(userBalanceAfter - userBalanceBefore).to.equal(LIVENESS_LIMIT);

      // UserProxy and Integrator must hold 0 USDC
      const proxy = await integrator.proxyAddress(user.address);
      expect(await mockUsdc.balanceOf(proxy)).to.equal(0);
      expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(0);
    });

    it("rejects BUY orders exceeding verified limit", async function () {
      await verify(user, "liveness", LIVENESS_LIMIT);
      await expect(
        integrator.connect(user).userBuyUsdc(LIVENESS_LIMIT + 1n, INR, 1, "test-pubkey", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "KycLimitExceeded");
    });
  });

  describe("SELL flow (USDC → P2P.me → INR/UPI)", function () {
    it("blocks SELL placement without verification", async function () {
      await expect(
        integrator.connect(user).userPlaceSellOrder(USDC(10), INR, "relay-pubkey", 1, 0, 0)
      ).to.be.revertedWithCustomError(integrator, "NotKycVerified");
    });

    it("successfully places B2B SELL order via UserProxy", async function () {
      await verify(user, "kyc", KYC_LIMIT);

      const orderIdBefore = await mockDiamond.nextOrderId();
      await expect(
        integrator.connect(user).userPlaceSellOrder(USDC(50), INR, "relay-pubkey", 1, 0, 0)
      )
        .to.emit(integrator, "UsdcDirectSellOrderCreated")
        .withArgs(orderIdBefore, user.address, USDC(50), INR);

      const session = await integrator.getSession(orderIdBefore);
      expect(session.user).to.equal(user.address);
      expect(session.amount).to.equal(USDC(50));
      expect(session.isSell).to.equal(true);
      expect(session.fulfilled).to.equal(false);
      expect(session.cancelled).to.equal(false);
    });

    it("userSellUsdc ergonomic alias functions identically", async function () {
      await verify(user, "kyc", KYC_LIMIT);
      const orderIdBefore = await mockDiamond.nextOrderId();
      await expect(integrator.connect(user).userSellUsdc(USDC(30), INR, 1, "relay-pubkey", 0, 0))
        .to.emit(integrator, "UsdcDirectSellOrderCreated")
        .withArgs(orderIdBefore, user.address, USDC(30), INR);
    });

    it("rejects SELL orders exceeding verified limit", async function () {
      await verify(user, "liveness", LIVENESS_LIMIT);
      await expect(
        integrator.connect(user).userPlaceSellOrder(LIVENESS_LIMIT + 1n, INR, "pubkey", 1, 0, 0)
      ).to.be.revertedWithCustomError(integrator, "KycLimitExceeded");
    });
  });

  describe("limits & cancellation lifecycle", function () {
    it("enforces daily transaction count limit and frees slot on cancel", async function () {
      await verify(user, "kyc", KYC_LIMIT);
      await integrator.setDailyTxCountLimit(1);

      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).userBuyUsdc(USDC(10), INR, 1, "pubkey", 0, 0);

      // Next placement is blocked because limit is 1
      await expect(integrator.connect(user).userBuyUsdc(USDC(10), INR, 1, "pubkey", 0, 0)).to.be
        .reverted;

      // Cancellation frees daily count slot
      await mockDiamond.simulateOrderCancelled(orderId);

      const session = await integrator.getSession(orderId);
      expect(session.cancelled).to.equal(true);

      // Now user can place another order
      await expect(integrator.connect(user).userBuyUsdc(USDC(10), INR, 1, "pubkey", 0, 0)).to.not.be
        .reverted;
    });

    it("enforces daily USDC volume cap", async function () {
      await verify(user, "kyc", KYC_LIMIT);
      await integrator.setDailyUsdcVolumeCap(USDC(50));

      await buyAndComplete(user, USDC(30));

      // 30 + 30 > 50 -> reverts DailyVolumeExceeded
      await expect(
        integrator.connect(user).userBuyUsdc(USDC(30), INR, 1, "pubkey", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "DailyVolumeExceeded");

      // 30 + 20 <= 50 -> allowed
      await expect(integrator.connect(user).userBuyUsdc(USDC(20), INR, 1, "pubkey", 0, 0)).to.not.be
        .reverted;
    });
  });

  describe("access controls", function () {
    it("only Diamond can invoke IP2PIntegrator callbacks", async function () {
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

    it("only owner can update caps and attestor keys", async function () {
      await expect(
        integrator.connect(stranger).setPerTxUsdcCap(USDC(100))
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");

      await expect(
        integrator.connect(stranger).setLivenessAttestor(stranger.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");

      await expect(
        integrator.connect(stranger).setKycAttestor(stranger.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });
  });
});
