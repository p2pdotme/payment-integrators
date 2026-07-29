import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const TIER = { NONE: 0, LIVENESS: 1, KYC: 2 };
const REGION = { INDIA: 0, ABROAD: 1 };
const SOLANA_DOMAIN = 5;
const STANDARD_TRANSFER = 2000;

/**
 * ShowdownCheckoutIntegrator: a two-way fiat <-> USDC ramp whose user-facing
 * asset lives on Solana, bridged with CCTP V2, gated by tiered simple-kyc
 * attestations ($20 liveness / $50 passport+liveness).
 *
 * The attestor keys are plain hardhat signers; the integrator only checks
 * `ecrecover(...) == attestor`, so a locally-signed EIP-712 struct is
 * indistinguishable from one the real simple-kyc service signs.
 */
describe("ShowdownCheckoutIntegrator", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let user2: SignerWithAddress;
  let stranger: SignerWithAddress;
  let livenessAttestor: SignerWithAddress;
  let kycAttestor: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let tokenMessenger: any;
  let messageTransmitter: any;
  let integrator: any;
  let integratorAddr: string;
  let usdcAddr: string;
  let chainId: bigint;

  const USDC = (n: number | string) => ethers.parseUnits(n.toString(), 6);
  const INR = ethers.encodeBytes32String("INR");
  // Any non-INR currency resolves to the Abroad column.
  const USD = ethers.encodeBytes32String("USD");
  const DAILY_COUNT = 5;

  // The policy matrix. Each is also an immutable MAX_* ceiling in the contract.
  const LIVENESS_CAP_INDIA = USDC(20);
  const LIVENESS_CAP_ABROAD = USDC(50);
  const KYC_CAP_INDIA = USDC(100);
  const KYC_CAP_ABROAD = USDC(200);
  // The existing suite is INR-denominated; these keep it reading naturally.
  const LIVENESS_CAP = LIVENESS_CAP_INDIA;
  const KYC_CAP = KYC_CAP_INDIA;

  // A stand-in for a Solana USDC associated token account (32 raw bytes).
  const SOLANA_ATA = "0x" + "a7".repeat(32);

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
    return attestor.signTypedData(domain, types, { wallet, nullifier, limit, expiry });
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

  /** Place an onramp buy and drive it to completion on the mock Diamond. */
  async function buyAndComplete(who: SignerWithAddress, amount: bigint, ata = SOLANA_ATA) {
    const orderId = await mockDiamond.nextOrderId();
    await integrator.connect(who).userBuyUsdcToSolana(amount, INR, ata, 1, "", 0, 0);
    await mockDiamond.simulateOrderComplete(orderId);
    return orderId;
  }

  /** Simulate a Solana -> Base CCTP delivery landing on `who`'s proxy. */
  async function bridgeIn(who: SignerWithAddress, amount: bigint) {
    const proxy = await integrator.proxyAddress(who.address);
    const message = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256"],
      [proxy, amount]
    );
    await integrator.connect(stranger).receiveFromSolana(message, "0x");
    return proxy;
  }

  /** Drive an offramp from initiation through the Diamond's sell state machine. */
  async function offrampToPaid(who: SignerWithAddress, amount: bigint) {
    const orderId = await mockDiamond.nextOrderId();
    await integrator.connect(who).userInitiateOfframp(amount, INR, 0, 1, 0, "pub");
    await mockDiamond.acceptSellOrder(orderId, "merchant-pubkey");
    await integrator.connect(who).deliverOfframpUpi(orderId, "enc-upi");
    return orderId;
  }

  beforeEach(async function () {
    [owner, user, user2, stranger, livenessAttestor, kycAttestor] = await ethers.getSigners();
    chainId = (await ethers.provider.getNetwork()).chainId;

    mockUsdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    usdcAddr = await mockUsdc.getAddress();

    mockDiamond = await (await ethers.getContractFactory("MockDiamond")).deploy(usdcAddr);
    tokenMessenger = await (await ethers.getContractFactory("MockTokenMessengerV2")).deploy();
    messageTransmitter = await (
      await ethers.getContractFactory("MockMessageTransmitterV2")
    ).deploy(usdcAddr);

    integrator = await (
      await ethers.getContractFactory("ShowdownCheckoutIntegrator")
    ).deploy(
      await mockDiamond.getAddress(),
      usdcAddr,
      await tokenMessenger.getAddress(),
      await messageTransmitter.getAddress(),
      SOLANA_DOMAIN,
      DAILY_COUNT,
      livenessAttestor.address,
      kycAttestor.address,
      LIVENESS_CAP_INDIA,
      LIVENESS_CAP_ABROAD,
      KYC_CAP_INDIA,
      KYC_CAP_ABROAD
    );
    integratorAddr = await integrator.getAddress();

    await mockDiamond.registerIntegrator(integratorAddr, await integrator.proxyImpl());
    // The Diamond needs USDC on hand to settle completed buys.
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(1_000_000));
    // Circle's TokenMinter registers USDC as burnable, with a per-tx burn limit.
    await tokenMessenger.setBurnLimitPerMessage(usdcAddr, USDC(1_000_000));
  });

  // ─── Tier gating ────────────────────────────────────────────────────

  describe("KYC tiers", function () {
    it("blocks a user with no attestation", async function () {
      expect(await integrator.effectiveLimit(user.address, INR)).to.equal(0);
      await expect(
        integrator.connect(user).userBuyUsdcToSolana(USDC(5), INR, SOLANA_ATA, 1, "", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "NotKycVerified");
    });

    it("grants the $20 liveness tier", async function () {
      await verify(user, "liveness", LIVENESS_CAP);
      expect(await integrator.userTier(user.address)).to.equal(TIER.LIVENESS);
      expect(await integrator.effectiveLimit(user.address, INR)).to.equal(USDC(20));
    });

    it("grants the $100 KYC tier for INR", async function () {
      await verify(user, "kyc", KYC_CAP);
      expect(await integrator.userTier(user.address)).to.equal(TIER.KYC);
      expect(await integrator.effectiveLimit(user.address, INR)).to.equal(USDC(100));
    });

    it("clamps an over-generous attested limit to the on-chain tier cap", async function () {
      // A compromised / misconfigured attestor signs $1000 for the liveness
      // tier; the contract's own $20 ceiling still wins.
      await verify(user, "liveness", USDC(1000));
      expect(await integrator.grantedLimit(user.address)).to.equal(USDC(1000));
      expect(await integrator.effectiveLimit(user.address, INR)).to.equal(LIVENESS_CAP);

      await expect(
        integrator.connect(user).userBuyUsdcToSolana(USDC(21), INR, SOLANA_ATA, 1, "", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "KycLimitExceeded");
    });

    it("honours an attested limit below the tier cap", async function () {
      await verify(user, "kyc", USDC(30));
      expect(await integrator.effectiveLimit(user.address, INR)).to.equal(USDC(30));
    });

    it("raises the cap when a liveness user upgrades to KYC", async function () {
      await verify(user, "liveness", LIVENESS_CAP);
      expect(await integrator.effectiveLimit(user.address, INR)).to.equal(USDC(20));
      await verify(user, "kyc", KYC_CAP);
      expect(await integrator.effectiveLimit(user.address, INR)).to.equal(USDC(100));
    });

    it("never lowers a cap when a KYC user later claims liveness", async function () {
      await verify(user, "kyc", KYC_CAP);
      await verify(user, "liveness", LIVENESS_CAP);
      expect(await integrator.userTier(user.address)).to.equal(TIER.KYC);
      expect(await integrator.effectiveLimit(user.address, INR)).to.equal(USDC(100));
    });

    it("rejects a replayed nullifier", async function () {
      await verify(user, "liveness", LIVENESS_CAP, "shared");
      await expect(verify(user2, "liveness", LIVENESS_CAP, "shared")).to.be.revertedWithCustomError(
        integrator,
        "NullifierAlreadySpent"
      );
    });

    it("rejects a liveness attestation signed by the KYC attestor", async function () {
      const nullifier = nullifierFor("cross");
      const expiry = await futureExpiry();
      const sig = await signAttestation(
        "liveness",
        kycAttestor,
        user.address,
        nullifier,
        LIVENESS_CAP,
        expiry
      );
      await expect(
        integrator.connect(user).submitLivenessAttestation(nullifier, LIVENESS_CAP, expiry, sig)
      ).to.be.revertedWithCustomError(integrator, "InvalidSignature");
    });

    it("rejects an expired attestation", async function () {
      const nullifier = nullifierFor("expired");
      const expiry = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) - 1n;
      const sig = await signAttestation(
        "liveness",
        livenessAttestor,
        user.address,
        nullifier,
        LIVENESS_CAP,
        expiry
      );
      await expect(
        integrator.connect(user).submitLivenessAttestation(nullifier, LIVENESS_CAP, expiry, sig)
      ).to.be.revertedWithCustomError(integrator, "AttestationExpired");
    });

    it("lets the owner disable a tier by zeroing its cap", async function () {
      await verify(user, "liveness", LIVENESS_CAP);
      await integrator.connect(owner).setTierCap(TIER.LIVENESS, REGION.INDIA, 0);
      expect(await integrator.effectiveLimit(user.address, INR)).to.equal(0);
    });

    it("rejects a tier cap update from a non-owner", async function () {
      await expect(
        integrator.connect(stranger).setTierCap(TIER.LIVENESS, REGION.INDIA, USDC(999))
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });
  });

  // ─── Region-tiered limits: India (INR) vs Abroad ────────────────────

  describe("region tiers", function () {
    it("maps INR to India and every other currency to Abroad", async function () {
      expect(await integrator.regionFor(INR)).to.equal(REGION.INDIA);
      expect(await integrator.regionFor(USD)).to.equal(REGION.ABROAD);
      expect(await integrator.regionFor(ethers.ZeroHash)).to.equal(REGION.ABROAD);
    });

    it("applies the full $20/$50/$100/$200 matrix", async function () {
      await verify(user, "liveness", USDC(10_000));
      expect(await integrator.effectiveLimit(user.address, INR)).to.equal(USDC(20));
      expect(await integrator.effectiveLimit(user.address, USD)).to.equal(USDC(50));

      await verify(user, "kyc", USDC(10_000));
      expect(await integrator.effectiveLimit(user.address, INR)).to.equal(USDC(100));
      expect(await integrator.effectiveLimit(user.address, USD)).to.equal(USDC(200));
    });

    it("exposes both region limits in one call for the UI", async function () {
      await verify(user, "kyc", USDC(10_000));
      const limits = await integrator.effectiveLimits(user.address);
      expect(limits.india).to.equal(USDC(100));
      expect(limits.abroad).to.equal(USDC(200));
    });

    it("still clamps to the attested limit when it is below the region cap", async function () {
      await verify(user, "kyc", USDC(35));
      expect(await integrator.effectiveLimit(user.address, INR)).to.equal(USDC(35));
      expect(await integrator.effectiveLimit(user.address, USD)).to.equal(USDC(35));
    });

    it("lets an INR-capped liveness user send more in a foreign currency", async function () {
      await verify(user, "liveness", USDC(10_000));
      await expect(
        integrator.connect(user).userBuyUsdcToSolana(USDC(21), INR, SOLANA_ATA, 1, "", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "KycLimitExceeded");
      // Same wallet, same tier, foreign rail — $50 is allowed.
      await expect(
        integrator.connect(user).userBuyUsdcToSolana(USDC(50), USD, SOLANA_ATA, 1, "", 0, 0)
      ).to.emit(integrator, "OnrampOrderCreated");
    });

    it("applies the region column to the offramp too", async function () {
      await verify(user, "liveness", USDC(10_000));
      await bridgeIn(user, USDC(50));
      await expect(
        integrator.connect(user).userInitiateOfframp(USDC(21), INR, 0, 1, 0, "pub")
      ).to.be.revertedWithCustomError(integrator, "KycLimitExceeded");
      await expect(
        integrator.connect(user).userInitiateOfframp(USDC(50), USD, 0, 1, 0, "pub")
      ).to.emit(integrator, "OfframpInitiated");
    });

    it("resolves the region inside validateOrder, not just the entrypoint", async function () {
      await verify(user, "liveness", USDC(10_000));
      const diamondAddr = await mockDiamond.getAddress();
      await ethers.provider.send("hardhat_setBalance", [diamondAddr, "0xde0b6b3a7640000"]);
      const asDiamond = integrator.connect(await ethers.getImpersonatedSigner(diamondAddr));

      expect(await asDiamond.validateOrder.staticCall(user.address, USDC(20), INR)).to.equal(true);
      expect(await asDiamond.validateOrder.staticCall(user.address, USDC(21), INR)).to.equal(false);
      expect(await asDiamond.validateOrder.staticCall(user.address, USDC(50), USD)).to.equal(true);
      expect(await asDiamond.validateOrder.staticCall(user.address, USDC(51), USD)).to.equal(false);
    });

    it("rejects an unknown region on setTierCap", async function () {
      await expect(
        integrator.connect(owner).setTierCap(TIER.KYC, 2, USDC(1))
      ).to.be.revertedWithCustomError(integrator, "InvalidRegion");
    });
  });

  // ─── Immutable policy ceilings ──────────────────────────────────────

  describe("immutable ceilings", function () {
    const CEILINGS: [number, number, bigint][] = [
      [TIER.LIVENESS, REGION.INDIA, USDC(20)],
      [TIER.LIVENESS, REGION.ABROAD, USDC(50)],
      [TIER.KYC, REGION.INDIA, USDC(100)],
      [TIER.KYC, REGION.ABROAD, USDC(200)],
    ];

    it("publishes each ceiling in the bytecode", async function () {
      for (const [tier, region, cap] of CEILINGS) {
        expect(await integrator.maxTierCap(tier, region)).to.equal(cap);
      }
      expect(await integrator.MAX_DAILY_TX_COUNT_LIMIT()).to.equal(5);
      expect(await integrator.MAX_BRIDGE_MAX_FEE_BPS()).to.equal(100);
    });

    it("refuses to raise any cap one unit above its ceiling", async function () {
      for (const [tier, region, cap] of CEILINGS) {
        await expect(
          integrator.connect(owner).setTierCap(tier, region, cap + 1n)
        ).to.be.revertedWithCustomError(integrator, "CapExceedsCeiling");
      }
    });

    it("lets the owner lower a cap, and enforces the lower value", async function () {
      await verify(user, "kyc", USDC(10_000));
      await integrator.connect(owner).setTierCap(TIER.KYC, REGION.ABROAD, USDC(75));
      expect(await integrator.effectiveLimit(user.address, USD)).to.equal(USDC(75));
      // The other cells are untouched.
      expect(await integrator.effectiveLimit(user.address, INR)).to.equal(USDC(100));

      await expect(
        integrator.connect(user).userBuyUsdcToSolana(USDC(76), USD, SOLANA_ATA, 1, "", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "KycLimitExceeded");
    });

    it("refuses a daily count above the ceiling, or of zero", async function () {
      await expect(integrator.connect(owner).setDailyTxCountLimit(6)).to.be.revertedWithCustomError(
        integrator,
        "CapExceedsCeiling"
      );
      // 0 used to mean "unlimited" — that would be a way around the ceiling.
      await expect(integrator.connect(owner).setDailyTxCountLimit(0)).to.be.revertedWithCustomError(
        integrator,
        "InvalidAmount"
      );
      await integrator.connect(owner).setDailyTxCountLimit(5);
      expect(await integrator.dailyTxCountLimit()).to.equal(5);
    });

    it("refuses a bridge fee above the ceiling", async function () {
      await expect(integrator.connect(owner).setBridgeMaxFeeBps(101)).to.be.revertedWithCustomError(
        integrator,
        "CapExceedsCeiling"
      );
      await integrator.connect(owner).setBridgeMaxFeeBps(100);
      expect(await integrator.bridgeMaxFeeBps()).to.equal(100);
    });

    it("refuses a deploy that starts above a ceiling", async function () {
      const Factory = await ethers.getContractFactory("ShowdownCheckoutIntegrator");
      const deployWith = (dailyCount: number, caps: [bigint, bigint, bigint, bigint]) =>
        Factory.deploy(
          mockDiamond.target,
          usdcAddr,
          tokenMessenger.target,
          messageTransmitter.target,
          SOLANA_DOMAIN,
          dailyCount,
          livenessAttestor.address,
          kycAttestor.address,
          caps[0],
          caps[1],
          caps[2],
          caps[3]
        );

      // KYC/abroad one unit over $200.
      await expect(
        deployWith(DAILY_COUNT, [
          LIVENESS_CAP_INDIA,
          LIVENESS_CAP_ABROAD,
          KYC_CAP_INDIA,
          KYC_CAP_ABROAD + 1n,
        ])
      ).to.be.revertedWithCustomError(integrator, "CapExceedsCeiling");
      // ...liveness/India one unit over $20.
      await expect(
        deployWith(DAILY_COUNT, [
          LIVENESS_CAP_INDIA + 1n,
          LIVENESS_CAP_ABROAD,
          KYC_CAP_INDIA,
          KYC_CAP_ABROAD,
        ])
      ).to.be.revertedWithCustomError(integrator, "CapExceedsCeiling");
      // ...and a daily count of 6.
      await expect(
        deployWith(6, [LIVENESS_CAP_INDIA, LIVENESS_CAP_ABROAD, KYC_CAP_INDIA, KYC_CAP_ABROAD])
      ).to.be.revertedWithCustomError(integrator, "CapExceedsCeiling");
    });
  });

  // ─── Daily counts, budgeted per direction ───────────────────────────

  describe("per-direction daily counts", function () {
    beforeEach(async function () {
      await verify(user, "kyc", KYC_CAP);
    });

    it("stops the 6th onramp of the day", async function () {
      for (let i = 0; i < 5; i++) {
        await integrator.connect(user).userBuyUsdcToSolana(USDC(1), INR, SOLANA_ATA, 1, "", 0, 0);
      }
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(0);
      await expect(
        integrator.connect(user).userBuyUsdcToSolana(USDC(1), INR, SOLANA_ATA, 1, "", 0, 0)
      ).to.be.reverted;
    });

    it("stops the 6th offramp of the day", async function () {
      await bridgeIn(user, USDC(10));
      for (let i = 0; i < 5; i++) {
        await integrator.connect(user).userInitiateOfframp(USDC(1), INR, 0, 1, 0, "pub");
      }
      expect(await integrator.getRemainingOfframpDailyCount(user.address)).to.equal(0);
      await expect(integrator.connect(user).userInitiateOfframp(USDC(1), INR, 0, 1, 0, "pub")).to.be
        .reverted;
    });

    it("budgets the two directions independently", async function () {
      await bridgeIn(user, USDC(10));
      // Exhaust the onramp budget...
      for (let i = 0; i < 5; i++) {
        await integrator.connect(user).userBuyUsdcToSolana(USDC(1), INR, SOLANA_ATA, 1, "", 0, 0);
      }
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(0);
      // ...the offramp budget is untouched.
      expect(await integrator.getRemainingOfframpDailyCount(user.address)).to.equal(5);
      await integrator.connect(user).userInitiateOfframp(USDC(1), INR, 0, 1, 0, "pub");
      expect(await integrator.getRemainingOfframpDailyCount(user.address)).to.equal(4);
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(0);
    });

    it("counts the offramp slot inside validateOrder, keyed to the human", async function () {
      await bridgeIn(user, USDC(10));
      await integrator.connect(user).userInitiateOfframp(USDC(1), INR, 0, 1, 0, "pub");
      const day = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) / 86400n;
      // Keyed to the seller's EOA, not their proxy.
      expect(await integrator.userDailyOfframpCount(user.address, day)).to.equal(1);
      const proxy = await integrator.proxyAddress(user.address);
      expect(await integrator.userDailyOfframpCount(proxy, day)).to.equal(0);
    });
  });

  // ─── Owner block / unblock ──────────────────────────────────────────

  describe("blocking", function () {
    beforeEach(async function () {
      await verify(user, "kyc", KYC_CAP);
    });

    it("zeroes a blocked wallet's limit in both directions", async function () {
      await expect(integrator.connect(owner).setUserBlocked(user.address, true))
        .to.emit(integrator, "UserBlockedUpdated")
        .withArgs(user.address, true);

      expect(await integrator.effectiveLimit(user.address, INR)).to.equal(0);
      expect(await integrator.effectiveLimit(user.address, USD)).to.equal(0);
      await expect(
        integrator.connect(user).userBuyUsdcToSolana(USDC(1), INR, SOLANA_ATA, 1, "", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "UserIsBlocked");

      await bridgeIn(user, USDC(10));
      await expect(
        integrator.connect(user).userInitiateOfframp(USDC(1), INR, 0, 1, 0, "pub")
      ).to.be.revertedWithCustomError(integrator, "UserIsBlocked");
    });

    it("blocks at the Diamond's authoritative gate too", async function () {
      await integrator.connect(owner).setUserBlocked(user.address, true);
      const diamondAddr = await mockDiamond.getAddress();
      await ethers.provider.send("hardhat_setBalance", [diamondAddr, "0xde0b6b3a7640000"]);
      const asDiamond = integrator.connect(await ethers.getImpersonatedSigner(diamondAddr));
      expect(await asDiamond.validateOrder.staticCall(user.address, USDC(1), INR)).to.equal(false);
    });

    it("restores the KYC-derived limit on unblock, unchanged", async function () {
      await integrator.connect(owner).setUserBlocked(user.address, true);
      await integrator.connect(owner).setUserBlocked(user.address, false);
      expect(await integrator.effectiveLimit(user.address, INR)).to.equal(USDC(100));
      await expect(
        integrator.connect(user).userBuyUsdcToSolana(USDC(100), INR, SOLANA_ATA, 1, "", 0, 0)
      ).to.emit(integrator, "OnrampOrderCreated");
    });

    it("never traps funds: a blocked user can still bridge back to Solana", async function () {
      await bridgeIn(user, USDC(10));
      await integrator.connect(owner).setUserBlocked(user.address, true);
      await expect(integrator.connect(user).userBridgeBackToSolana(USDC(10), SOLANA_ATA)).to.emit(
        integrator,
        "BridgedBackToSolana"
      );
    });

    it("never traps funds: a blocked user can still rescue a stuck onramp", async function () {
      await tokenMessenger.setBurnLimitPerMessage(usdcAddr, 0);
      const orderId = await buyAndComplete(user, USDC(50));
      await integrator.connect(owner).setUserBlocked(user.address, true);

      await ethers.provider.send("evm_increaseTime", [7 * 24 * 3600 + 1]);
      await ethers.provider.send("evm_mine", []);
      await expect(integrator.connect(user).userRescueStuckBridge(orderId))
        .to.emit(integrator, "BridgeRescued")
        .withArgs(orderId, user.address, USDC(50));
    });

    it("rejects a block from a non-owner, and a zero address", async function () {
      await expect(
        integrator.connect(stranger).setUserBlocked(user.address, true)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
      await expect(
        integrator.connect(owner).setUserBlocked(ethers.ZeroAddress, true)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    });
  });

  // ─── Delivery accounting: never reserve USDC that didn't arrive ─────

  describe("delivery accounting", function () {
    beforeEach(async function () {
      await verify(user, "kyc", KYC_CAP);
    });

    it("re-pins the session to the amount actually delivered", async function () {
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).userBuyUsdcToSolana(USDC(50), INR, SOLANA_ATA, 1, "", 0, 0);

      // The gateway hands over $49 instead of the $50 placed. Fund the
      // integrator with exactly what "arrived" so the burn can be attempted.
      await mockUsdc.mint(integratorAddr, USDC(49));
      await expect(
        mockDiamond.adminCallOnOrderComplete(
          integratorAddr,
          orderId,
          user.address,
          USDC(49),
          integratorAddr
        )
      )
        .to.emit(integrator, "OnrampAmountAdjusted")
        .withArgs(orderId, USDC(50), USDC(49));

      // The burn moved $49 — not the $50 placed, which would have been funded
      // out of another buyer's reserved USDC.
      const session = await integrator.getSession(orderId);
      expect(session.amount).to.equal(USDC(49));
      expect(session.bridged).to.equal(true);
      expect(await integrator.unbridgedTotal()).to.equal(0);
      expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(0);
    });

    it("keeps unbridgedTotal within the balance when a short delivery cannot bridge", async function () {
      await tokenMessenger.setBurnLimitPerMessage(usdcAddr, 0);
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).userBuyUsdcToSolana(USDC(50), INR, SOLANA_ATA, 1, "", 0, 0);
      await mockUsdc.mint(integratorAddr, USDC(49));
      await mockDiamond.adminCallOnOrderComplete(
        integratorAddr,
        orderId,
        user.address,
        USDC(49),
        integratorAddr
      );

      // The invariant every recovery path depends on.
      expect(await integrator.unbridgedTotal()).to.equal(USDC(49));
      expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(USDC(49));
      await expect(
        integrator.connect(owner).withdrawUsdc(owner.address, 1)
      ).to.be.revertedWithCustomError(integrator, "WithdrawExceedsSurplus");
    });

    it("refuses a completion routed to any recipient but itself", async function () {
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).userBuyUsdcToSolana(USDC(50), INR, SOLANA_ATA, 1, "", 0, 0);
      await expect(
        mockDiamond.adminCallOnOrderComplete(
          integratorAddr,
          orderId,
          user.address,
          USDC(50),
          user.address
        )
      ).to.be.revertedWithCustomError(integrator, "UnexpectedRecipient");
      // Nothing was reserved for USDC that never arrived here.
      expect(await integrator.unbridgedTotal()).to.equal(0);
      expect((await integrator.getSession(orderId)).fulfilled).to.equal(false);
    });

    it("refuses to complete an order that was cancelled", async function () {
      // Defense-in-depth for when onOrderCancel ships on the live Diamond:
      // cancel frees the daily slot, so completing afterwards would settle one
      // order over the cap and leave a cancelled-and-fulfilled session.
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).userBuyUsdcToSolana(USDC(50), INR, SOLANA_ATA, 1, "", 0, 0);
      await mockDiamond.simulateOrderCancelled(orderId);

      await mockUsdc.mint(integratorAddr, USDC(50));
      await expect(
        mockDiamond.adminCallOnOrderComplete(
          integratorAddr,
          orderId,
          user.address,
          USDC(50),
          integratorAddr
        )
      ).to.be.revertedWithCustomError(integrator, "OrderAlreadyCancelled");

      const session = await integrator.getSession(orderId);
      expect(session.fulfilled).to.equal(false);
      expect(await integrator.unbridgedTotal()).to.equal(0);
    });
  });

  // ─── Onramp: fiat -> USDC on Solana ─────────────────────────────────

  describe("onramp", function () {
    beforeEach(async function () {
      await verify(user, "kyc", KYC_CAP);
    });

    it("burns the delivered USDC to the user's Solana account on completion", async function () {
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).userBuyUsdcToSolana(USDC(50), INR, SOLANA_ATA, 1, "", 0, 0);

      await expect(mockDiamond.simulateOrderComplete(orderId))
        .to.emit(tokenMessenger, "DepositForBurn")
        .withArgs(
          USDC(50),
          SOLANA_DOMAIN,
          SOLANA_ATA,
          usdcAddr,
          ethers.ZeroHash,
          0,
          STANDARD_TRANSFER
        );

      const session = await integrator.getSession(orderId);
      expect(session.fulfilled).to.equal(true);
      expect(session.bridged).to.equal(true);
      expect(session.solanaRecipient).to.equal(SOLANA_ATA);
      // Nothing lingers on the integrator, and nothing is reserved.
      expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(0);
      expect(await integrator.unbridgedTotal()).to.equal(0);
    });

    it("never routes the onramp's USDC to the user's Base wallet or proxy", async function () {
      const before = await mockUsdc.balanceOf(user.address);
      const orderId = await buyAndComplete(user, USDC(50));
      const proxy = await integrator.proxyAddress(user.address);

      expect(await mockUsdc.balanceOf(user.address)).to.equal(before);
      expect(await mockUsdc.balanceOf(proxy)).to.equal(0);
      expect((await integrator.getSession(orderId)).bridged).to.equal(true);
    });

    it("rejects a zero Solana recipient", async function () {
      await expect(
        integrator.connect(user).userBuyUsdcToSolana(USDC(10), INR, ethers.ZeroHash, 1, "", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "InvalidSolanaRecipient");
    });

    it("rejects an amount above the user's tier cap", async function () {
      await expect(
        integrator.connect(user).userBuyUsdcToSolana(USDC(101), INR, SOLANA_ATA, 1, "", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "KycLimitExceeded");
    });

    it("pins the Solana destination at order time", async function () {
      const other = "0x" + "bb".repeat(32);
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).userBuyUsdcToSolana(USDC(10), INR, SOLANA_ATA, 1, "", 0, 0);
      // No API exists to change it; the burn must use what was pinned.
      await expect(mockDiamond.simulateOrderComplete(orderId))
        .to.emit(tokenMessenger, "DepositForBurn")
        .withArgs(
          USDC(10),
          SOLANA_DOMAIN,
          SOLANA_ATA,
          usdcAddr,
          ethers.ZeroHash,
          0,
          STANDARD_TRANSFER
        );
      expect((await integrator.getSession(orderId)).solanaRecipient).to.not.equal(other);
    });

    it("consumes a daily slot per buy and releases it on cancel", async function () {
      await integrator.connect(owner).setDailyTxCountLimit(1);
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).userBuyUsdcToSolana(USDC(10), INR, SOLANA_ATA, 1, "", 0, 0);
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(0);

      await expect(
        integrator.connect(user).userBuyUsdcToSolana(USDC(10), INR, SOLANA_ATA, 1, "", 0, 0)
      ).to.be.reverted;

      await mockDiamond.simulateOrderCancelled(orderId);
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(1);
    });

    it("rejects callbacks from anyone but the Diamond", async function () {
      await expect(
        integrator.connect(stranger).onOrderComplete(1, user.address, USDC(1), integratorAddr)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
      await expect(
        integrator.connect(stranger).validateOrder(user.address, USDC(1), INR)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
    });

    it("rejects selfBridge from anyone but the contract itself", async function () {
      await expect(integrator.connect(stranger).selfBridge(1)).to.be.revertedWithCustomError(
        integrator,
        "OnlySelf"
      );
    });
  });

  // ─── Bridge failure: fail closed, stay recoverable ──────────────────

  describe("bridge failure", function () {
    beforeEach(async function () {
      await verify(user, "kyc", KYC_CAP);
      // Reproduces Base Sepolia: the Diamond settles in a token Circle's
      // TokenMinter will not burn.
      await tokenMessenger.setBurnLimitPerMessage(usdcAddr, 0);
    });

    it("completes the order and reserves the USDC when CCTP refuses the burn", async function () {
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).userBuyUsdcToSolana(USDC(50), INR, SOLANA_ATA, 1, "", 0, 0);

      await expect(mockDiamond.simulateOrderComplete(orderId)).to.emit(integrator, "BridgeFailed");

      const session = await integrator.getSession(orderId);
      // The order still completed and the bookkeeping survived the failure —
      // this is the property that keeps the funds recoverable.
      expect(session.fulfilled).to.equal(true);
      expect(session.bridged).to.equal(false);
      expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(USDC(50));
      expect(await integrator.unbridgedTotal()).to.equal(USDC(50));
    });

    it("leaves no dangling allowance to the token messenger after a failed burn", async function () {
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).userBuyUsdcToSolana(USDC(50), INR, SOLANA_ATA, 1, "", 0, 0);
      await mockDiamond.simulateOrderComplete(orderId);
      expect(await mockUsdc.allowance(integratorAddr, await tokenMessenger.getAddress())).to.equal(
        0
      );
    });

    it("bridges on retry once the token becomes burnable — callable by anyone", async function () {
      const orderId = await buyAndComplete(user, USDC(50));
      await tokenMessenger.setBurnLimitPerMessage(usdcAddr, USDC(1_000_000));

      await expect(integrator.connect(stranger).retryBridge(orderId))
        .to.emit(tokenMessenger, "DepositForBurn")
        .withArgs(
          USDC(50),
          SOLANA_DOMAIN,
          SOLANA_ATA,
          usdcAddr,
          ethers.ZeroHash,
          0,
          STANDARD_TRANSFER
        );

      expect((await integrator.getSession(orderId)).bridged).to.equal(true);
      expect(await integrator.unbridgedTotal()).to.equal(0);
      expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(0);
    });

    it("bubbles the CCTP reason when a retry still fails", async function () {
      const orderId = await buyAndComplete(user, USDC(50));
      await expect(integrator.connect(stranger).retryBridge(orderId)).to.be.revertedWith(
        "Burn token not supported"
      );
    });

    it("rejects a retry on an already-bridged order", async function () {
      await tokenMessenger.setBurnLimitPerMessage(usdcAddr, USDC(1_000_000));
      const orderId = await buyAndComplete(user, USDC(50));
      await expect(integrator.retryBridge(orderId)).to.be.revertedWithCustomError(
        integrator,
        "AlreadyBridged"
      );
    });

    it("rejects a retry on an unknown or unfulfilled order", async function () {
      await expect(integrator.retryBridge(999)).to.be.revertedWithCustomError(
        integrator,
        "UnknownOrder"
      );
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).userBuyUsdcToSolana(USDC(10), INR, SOLANA_ATA, 1, "", 0, 0);
      await expect(integrator.retryBridge(orderId)).to.be.revertedWithCustomError(
        integrator,
        "OrderNotFulfilled"
      );
    });

    it("pays a max fee once the messenger enforces a minimum", async function () {
      await tokenMessenger.setBurnLimitPerMessage(usdcAddr, USDC(1_000_000));
      await tokenMessenger.setMinFee(10); // 10 bps
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).userBuyUsdcToSolana(USDC(50), INR, SOLANA_ATA, 1, "", 0, 0);

      // maxFee = 0 no longer clears the messenger's floor.
      await expect(mockDiamond.simulateOrderComplete(orderId)).to.emit(integrator, "BridgeFailed");

      await integrator.connect(owner).setBridgeMaxFeeBps(10);
      await expect(integrator.connect(stranger).retryBridge(orderId))
        .to.emit(tokenMessenger, "DepositForBurn")
        .withArgs(
          USDC(50),
          SOLANA_DOMAIN,
          SOLANA_ATA,
          usdcAddr,
          ethers.ZeroHash,
          USDC(50) / 1000n, // 10 bps of 50 USDC
          STANDARD_TRANSFER
        );
    });
  });

  // ─── Stuck-bridge rescue ────────────────────────────────────────────

  describe("stuck-bridge rescue", function () {
    let orderId: bigint;

    beforeEach(async function () {
      await verify(user, "kyc", KYC_CAP);
      await tokenMessenger.setBurnLimitPerMessage(usdcAddr, 0);
      orderId = await buyAndComplete(user, USDC(50));
    });

    it("refuses a rescue before the delay elapses", async function () {
      await expect(
        integrator.connect(user).userRescueStuckBridge(orderId)
      ).to.be.revertedWithCustomError(integrator, "RescueTooEarly");
    });

    it("lets the buyer recover their USDC after the delay", async function () {
      await ethers.provider.send("evm_increaseTime", [7 * 24 * 3600 + 1]);
      await ethers.provider.send("evm_mine", []);

      const before = await mockUsdc.balanceOf(user.address);
      await expect(integrator.connect(user).userRescueStuckBridge(orderId))
        .to.emit(integrator, "BridgeRescued")
        .withArgs(orderId, user.address, USDC(50));

      expect(await mockUsdc.balanceOf(user.address)).to.equal(before + USDC(50));
      expect(await integrator.unbridgedTotal()).to.equal(0);
    });

    it("refuses a rescue by anyone other than the buyer", async function () {
      await ethers.provider.send("evm_increaseTime", [7 * 24 * 3600 + 1]);
      await ethers.provider.send("evm_mine", []);
      await expect(
        integrator.connect(stranger).userRescueStuckBridge(orderId)
      ).to.be.revertedWithCustomError(integrator, "NotOrderOwner");
      await expect(
        integrator.connect(owner).userRescueStuckBridge(orderId)
      ).to.be.revertedWithCustomError(integrator, "NotOrderOwner");
    });

    it("refuses to rescue twice, or to bridge a rescued order", async function () {
      await ethers.provider.send("evm_increaseTime", [7 * 24 * 3600 + 1]);
      await ethers.provider.send("evm_mine", []);
      await integrator.connect(user).userRescueStuckBridge(orderId);

      await expect(
        integrator.connect(user).userRescueStuckBridge(orderId)
      ).to.be.revertedWithCustomError(integrator, "AlreadyBridged");

      await tokenMessenger.setBurnLimitPerMessage(usdcAddr, USDC(1_000_000));
      await expect(integrator.retryBridge(orderId)).to.be.revertedWithCustomError(
        integrator,
        "AlreadyBridged"
      );
    });
  });

  // ─── Owner cannot touch in-flight funds ─────────────────────────────

  describe("withdrawUsdc", function () {
    it("refuses to sweep USDC reserved for an unbridged onramp", async function () {
      await verify(user, "kyc", KYC_CAP);
      await tokenMessenger.setBurnLimitPerMessage(usdcAddr, 0);
      await buyAndComplete(user, USDC(50));

      expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(USDC(50));
      await expect(
        integrator.connect(owner).withdrawUsdc(owner.address, 1)
      ).to.be.revertedWithCustomError(integrator, "WithdrawExceedsSurplus");
    });

    it("sweeps only genuine surplus", async function () {
      await verify(user, "kyc", KYC_CAP);
      await tokenMessenger.setBurnLimitPerMessage(usdcAddr, 0);
      await buyAndComplete(user, USDC(50));
      // Someone sends USDC here by mistake — that, and only that, is sweepable.
      await mockUsdc.mint(integratorAddr, USDC(7));

      await expect(
        integrator.connect(owner).withdrawUsdc(owner.address, USDC(8))
      ).to.be.revertedWithCustomError(integrator, "WithdrawExceedsSurplus");
      await integrator.connect(owner).withdrawUsdc(owner.address, USDC(7));
      expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(USDC(50));
    });

    it("rejects a withdrawal from a non-owner", async function () {
      await expect(
        integrator.connect(stranger).withdrawUsdc(stranger.address, 0)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });
  });

  // ─── Offramp: USDC bridged from Solana -> fiat ──────────────────────

  describe("offramp", function () {
    beforeEach(async function () {
      await verify(user, "kyc", KYC_CAP);
    });

    it("mints a Solana-sourced delivery to the user's proxy, not the submitter", async function () {
      const proxy = await bridgeIn(user, USDC(50));
      expect(await mockUsdc.balanceOf(proxy)).to.equal(USDC(50));
      expect(await integrator.bridgedBalance(user.address)).to.equal(USDC(50));
      expect(await mockUsdc.balanceOf(stranger.address)).to.equal(0);
    });

    it("exposes the proxy as the bytes32 mint recipient for a Solana burn", async function () {
      const proxy = await integrator.proxyAddress(user.address);
      expect(await integrator.offrampMintRecipient(user.address)).to.equal(
        ethers.zeroPadValue(proxy, 32).toLowerCase()
      );
    });

    it("sells the bridged USDC and lets the Diamond pull it from the proxy", async function () {
      const proxy = await bridgeIn(user, USDC(50));
      const orderId = await offrampToPaid(user, USDC(50));

      // The Diamond pulled principal + fee straight off the seller's proxy.
      expect(await mockUsdc.balanceOf(proxy)).to.equal(0);
      const sell = await mockDiamond.getSellOrder(orderId);
      expect(sell.status).to.equal(2); // PAID
      expect(sell.user).to.equal(proxy);

      await mockDiamond.completeSellOrder(orderId);
      await expect(integrator.reconcile(orderId))
        .to.emit(integrator, "OfframpReconciled")
        .withArgs(orderId, 3); // COMPLETED
    });

    it("refunds a cancelled sell back to the seller's own proxy", async function () {
      const proxy = await bridgeIn(user, USDC(50));
      const orderId = await offrampToPaid(user, USDC(50));
      expect(await mockUsdc.balanceOf(proxy)).to.equal(0);

      await mockDiamond.cancelSellOrder(orderId);
      // order.user is the proxy, so the refund lands back where it started —
      // still re-offrampable, and never routed through the integrator.
      expect(await mockUsdc.balanceOf(proxy)).to.equal(USDC(50));
      expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(0);

      await expect(integrator.reconcile(orderId))
        .to.emit(integrator, "OfframpReconciled")
        .withArgs(orderId, 4); // CANCELLED
    });

    it("rejects an offramp above the seller's tier cap", async function () {
      await bridgeIn(user, USDC(200));
      await expect(
        integrator.connect(user).userInitiateOfframp(USDC(101), INR, 0, 1, 0, "pub")
      ).to.be.revertedWithCustomError(integrator, "KycLimitExceeded");
    });

    it("rejects an offramp from an unverified user", async function () {
      await bridgeIn(user2, USDC(50));
      await expect(
        integrator.connect(user2).userInitiateOfframp(USDC(10), INR, 0, 1, 0, "pub")
      ).to.be.revertedWithCustomError(integrator, "NotKycVerified");
    });

    it("rejects an offramp with no bridged funds behind it", async function () {
      await expect(
        integrator.connect(user).userInitiateOfframp(USDC(10), INR, 0, 1, 0, "pub")
      ).to.be.revertedWithCustomError(integrator, "InsufficientBridgedFunds");
    });

    it("cannot be funded from another user's bridged USDC", async function () {
      await bridgeIn(user2, USDC(50)); // user2's proxy holds it
      await expect(
        integrator.connect(user).userInitiateOfframp(USDC(50), INR, 0, 1, 0, "pub")
      ).to.be.revertedWithCustomError(integrator, "InsufficientBridgedFunds");
    });

    it("enforces the seller's tier inside validateOrder, not just the entrypoint", async function () {
      const proxy = await integrator.proxyAddress(user.address);
      await bridgeIn(user, USDC(50));
      await integrator.connect(user).userInitiateOfframp(USDC(10), INR, 0, 1, 0, "pub");
      expect(await integrator.proxyOwner(proxy)).to.equal(user.address);

      // The Diamond's authoritative gate resolves proxy -> seller and applies
      // that human's cap, so a sell can't exceed it even if the placement-time
      // entrypoint check were bypassed.
      const diamondAddr = await mockDiamond.getAddress();
      await ethers.provider.send("hardhat_setBalance", [diamondAddr, "0xde0b6b3a7640000"]);
      const asDiamond = integrator.connect(await ethers.getImpersonatedSigner(diamondAddr));

      expect(await asDiamond.validateOrder.staticCall(proxy, USDC(100), INR)).to.equal(true);
      expect(await asDiamond.validateOrder.staticCall(proxy, USDC(101), INR)).to.equal(false);

      await integrator.connect(owner).setTierCap(TIER.KYC, REGION.INDIA, USDC(5));
      expect(await asDiamond.validateOrder.staticCall(proxy, USDC(10), INR)).to.equal(false);
    });

    it("treats an unknown proxy's sell as unauthorized rather than a buy", async function () {
      const diamondAddr = await mockDiamond.getAddress();
      await ethers.provider.send("hardhat_setBalance", [diamondAddr, "0xde0b6b3a7640000"]);
      const asDiamond = integrator.connect(await ethers.getImpersonatedSigner(diamondAddr));

      // user2 has no attestation, so neither branch of validateOrder lets them
      // through — whether they arrive as an EOA or as an unmapped address.
      expect(await asDiamond.validateOrder.staticCall(user2.address, USDC(1), INR)).to.equal(false);
    });

    it("restricts UPI delivery to the initiator or the relayer", async function () {
      await bridgeIn(user, USDC(50));
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).userInitiateOfframp(USDC(50), INR, 0, 1, 0, "pub");
      await mockDiamond.acceptSellOrder(orderId, "merchant-pubkey");

      await expect(
        integrator.connect(stranger).deliverOfframpUpi(orderId, "enc-upi")
      ).to.be.revertedWithCustomError(integrator, "OfframpNotAuthorized");

      await integrator.connect(owner).setOfframpRelayer(stranger.address);
      await expect(integrator.connect(stranger).deliverOfframpUpi(orderId, "enc-upi")).to.emit(
        integrator,
        "OfframpUpiDelivered"
      );
    });

    it("respects the offramp kill switch", async function () {
      await bridgeIn(user, USDC(50));
      await integrator.connect(owner).setOfframpEnabled(false);
      await expect(
        integrator.connect(user).userInitiateOfframp(USDC(10), INR, 0, 1, 0, "pub")
      ).to.be.revertedWithCustomError(integrator, "OfframpDisabled");
    });

    it("rejects a double reconcile on a terminal order", async function () {
      await bridgeIn(user, USDC(50));
      const orderId = await offrampToPaid(user, USDC(50));
      await mockDiamond.completeSellOrder(orderId);
      await integrator.reconcile(orderId);
      await expect(integrator.reconcile(orderId)).to.be.revertedWithCustomError(
        integrator,
        "OfframpAlreadyReconciled"
      );
    });
  });

  // ─── Bridging back to Solana ────────────────────────────────────────

  describe("userBridgeBackToSolana", function () {
    beforeEach(async function () {
      await verify(user, "kyc", KYC_CAP);
    });

    it("returns bridged-in USDC to Solana", async function () {
      const proxy = await bridgeIn(user, USDC(50));
      await expect(integrator.connect(user).userBridgeBackToSolana(USDC(50), SOLANA_ATA))
        .to.emit(tokenMessenger, "DepositForBurn")
        .withArgs(
          USDC(50),
          SOLANA_DOMAIN,
          SOLANA_ATA,
          usdcAddr,
          ethers.ZeroHash,
          0,
          STANDARD_TRANSFER
        );

      expect(await mockUsdc.balanceOf(proxy)).to.equal(0);
      // Nothing is left parked on the integrator afterwards.
      expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(0);
    });

    it("cannot move another user's bridged USDC", async function () {
      await bridgeIn(user2, USDC(50));
      await expect(
        integrator.connect(user).userBridgeBackToSolana(USDC(50), SOLANA_ATA)
      ).to.be.revertedWithCustomError(integrator, "InsufficientBridgedFunds");
    });

    it("reverts atomically when the burn fails, leaving funds on the proxy", async function () {
      const proxy = await bridgeIn(user, USDC(50));
      await tokenMessenger.setBurnLimitPerMessage(usdcAddr, 0);
      await expect(
        integrator.connect(user).userBridgeBackToSolana(USDC(50), SOLANA_ATA)
      ).to.be.revertedWith("Burn token not supported");
      expect(await mockUsdc.balanceOf(proxy)).to.equal(USDC(50));
      expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(0);
    });

    it("rejects a zero Solana recipient", async function () {
      await bridgeIn(user, USDC(50));
      await expect(
        integrator.connect(user).userBridgeBackToSolana(USDC(50), ethers.ZeroHash)
      ).to.be.revertedWithCustomError(integrator, "InvalidSolanaRecipient");
    });
  });

  // ─── UserProxy invariants still hold ────────────────────────────────

  describe("proxy", function () {
    beforeEach(async function () {
      await verify(user, "kyc", KYC_CAP);
    });

    it("accepts a CCTP delivery before the proxy is deployed, and still spends it after", async function () {
      const proxy = await integrator.proxyAddress(user.address);
      expect(await ethers.provider.getCode(proxy)).to.equal("0x");

      // CCTP mints to the predicted address; nothing is deployed there yet.
      await bridgeIn(user, USDC(50));
      expect(await mockUsdc.balanceOf(proxy)).to.equal(USDC(50));
      expect(await ethers.provider.getCode(proxy)).to.equal("0x");

      // The first offramp deploys the clone to that same CREATE2 address, and
      // the balance that accrued beforehand is spendable.
      const orderId = await offrampToPaid(user, USDC(50));
      expect(await ethers.provider.getCode(proxy)).to.not.equal("0x");
      expect((await mockDiamond.getSellOrder(orderId)).status).to.equal(2); // PAID
      expect(await mockUsdc.balanceOf(proxy)).to.equal(0);
    });

    it("keeps bridged USDC out of the user's EOA", async function () {
      const proxy = await bridgeIn(user, USDC(50));
      await integrator.connect(user).userInitiateOfframp(USDC(10), INR, 0, 1, 0, "pub"); // deploys it
      const proxyContract = await ethers.getContractAt("UserProxy", proxy);
      await expect(proxyContract.connect(user).sweepERC20(usdcAddr)).to.be.revertedWithCustomError(
        proxyContract,
        "USDCSweepBlocked"
      );
    });

    it("only lets the integrator drive a user's proxy", async function () {
      const proxy = await bridgeIn(user, USDC(50));
      await integrator.connect(user).userInitiateOfframp(USDC(10), INR, 0, 1, 0, "pub"); // deploys it
      const proxyContract = await ethers.getContractAt("UserProxy", proxy);
      await expect(
        proxyContract.connect(user).execute(await mockDiamond.getAddress(), "0x", usdcAddr, 0)
      ).to.be.revertedWithCustomError(proxyContract, "OnlyIntegrator");
    });
  });
});
