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
      // grantedLimit is now keyed per tier (#45).
      expect(await integrator.grantedLimit(user.address, TIER.LIVENESS)).to.equal(USDC(1000));
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

  // #75: this was the one owner setter with no bytecode bound, which contradicted
  // the contract's own governance story. CCTP does not reject an arbitrary value
  // — the attestation service silently normalises it, so e.g. 500 becomes a Fast
  // transfer that charges a fee while bridgeMaxFeeBps defaults to 0, turning
  // every burn into a fail-closed retry that reads like a CCTP outage.
  describe("bridge finality threshold is bounded (#75)", function () {
    it("accepts only the two values CCTP V2 defines", async function () {
      await expect(integrator.connect(owner).setBridgeMinFinalityThreshold(1000)).to.emit(
        integrator,
        "BridgeFinalityThresholdUpdated"
      );
      expect(await integrator.bridgeMinFinalityThreshold()).to.equal(1000);
      await integrator.connect(owner).setBridgeMinFinalityThreshold(2000);
      expect(await integrator.bridgeMinFinalityThreshold()).to.equal(2000);
    });

    it("rejects anything else, including the silently-normalised 500", async function () {
      for (const bad of [0, 500, 999, 1500, 2001, 4294967295]) {
        await expect(
          integrator.connect(owner).setBridgeMinFinalityThreshold(bad)
        ).to.be.revertedWithCustomError(integrator, "InvalidFinalityThreshold");
      }
    });

    it("is still owner-only", async function () {
      await expect(
        integrator.connect(stranger).setBridgeMinFinalityThreshold(1000)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });

    // _maxFeeFor(0) used to underflow on `amount - 1`. Newly reachable once the
    // delivery clamp (#73) can pin a session to zero — a panic there would take
    // down onOrderComplete instead of failing closed into BridgeFailed.
    it("a zero-pinned session does not panic in _maxFeeFor", async function () {
      await verify(user, "kyc", KYC_CAP);
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).userBuyUsdcToSolana(USDC(50), INR, SOLANA_ATA, 1, "", 0, 0);
      // Reports $50, transfers nothing -> clamp pins the session to 0.
      await expect(
        mockDiamond.adminCallOnOrderComplete(
          integratorAddr,
          orderId,
          user.address,
          USDC(50),
          integratorAddr
        )
      ).to.not.be.reverted;
      expect((await integrator.getSession(orderId)).amount).to.equal(0);
      expect(await integrator.unbridgedTotal()).to.equal(0);
    });
  });

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

    // gitchadd on #35: the re-pin accepted whatever the Diamond reported, in
    // either direction. Over-reporting would reserve USDC that never arrived,
    // against a POOLED balance — so one order's burn could spend another
    // buyer's funds. Unreachable on today's gateway (it passes exactly what it
    // transferred); pinned here because the integrator is immutable.
    // #73 part 1: the clamp used to be nested inside `if (amount != session.amount)`,
    // so a Diamond reporting the PLACED amount while transferring less skipped it
    // entirely — crediting unbridgedTotal with USDC that never arrived and making
    // withdrawUsdc revert forever on any genuine surplus sent later.
    it("clamps a short delivery even when the Diamond reports the placed amount", async function () {
      await tokenMessenger.setBurnLimitPerMessage(usdcAddr, 0); // keep funds pooled
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).userBuyUsdcToSolana(USDC(50), INR, SOLANA_ATA, 1, "", 0, 0);

      // Reports $50 (exactly what was placed) but transfers nothing.
      await expect(
        mockDiamond.adminCallOnOrderComplete(
          integratorAddr,
          orderId,
          user.address,
          USDC(50),
          integratorAddr
        )
      )
        .to.emit(integrator, "OnrampAmountAdjusted")
        .withArgs(orderId, USDC(50), 0);

      expect(await integrator.unbridgedTotal()).to.equal(0);
      expect((await integrator.getSession(orderId)).amount).to.equal(0);
      // Surplus arriving later stays sweepable, rather than being permanently
      // locked behind an unbridgedTotal that nothing backs.
      await mockUsdc.mint(integratorAddr, USDC(7));
      await expect(integrator.connect(owner).withdrawUsdc(owner.address, USDC(7))).to.not.be
        .reverted;
    });

    // #73 part 2: `backed` was the whole unreserved balance, so an over-report
    // could reserve unrelated surplus — e.g. a user who pointed a Solana burn at
    // the integrator instead of offrampMintRecipient(user).
    it("does not let an over-report reserve pre-existing surplus", async function () {
      await tokenMessenger.setBurnLimitPerMessage(usdcAddr, 0);
      await mockUsdc.mint(integratorAddr, USDC(30)); // unrelated surplus, already here

      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).userBuyUsdcToSolana(USDC(50), INR, SOLANA_ATA, 1, "", 0, 0);
      await mockUsdc.mint(integratorAddr, USDC(50)); // the real delivery

      // Balance is now $80 and none of it is reserved, so the old `backed`-only
      // bound would have pinned the full reported $80 and swallowed the surplus.
      await expect(
        mockDiamond.adminCallOnOrderComplete(
          integratorAddr,
          orderId,
          user.address,
          USDC(80),
          integratorAddr
        )
      )
        .to.emit(integrator, "OnrampAmountAdjusted")
        .withArgs(orderId, USDC(50), USDC(50));

      expect(await integrator.unbridgedTotal()).to.equal(USDC(50));
      // The $30 is still surplus and still the owner's to sweep.
      await expect(integrator.connect(owner).withdrawUsdc(owner.address, USDC(30))).to.not.be
        .reverted;
    });

    it("clamps an over-reported delivery so one order cannot reserve another buyer's USDC", async function () {
      await tokenMessenger.setBurnLimitPerMessage(usdcAddr, 0); // burns fail → funds stay pooled
      await verify(user2, "kyc", KYC_CAP, "kyc-u2");

      // Buyer A: $50 delivered honestly, sitting unbridged in the pool.
      const idA = await mockDiamond.nextOrderId();
      await integrator.connect(user).userBuyUsdcToSolana(USDC(50), INR, SOLANA_ATA, 1, "", 0, 0);
      await mockUsdc.mint(integratorAddr, USDC(50));
      await mockDiamond.adminCallOnOrderComplete(
        integratorAddr,
        idA,
        user.address,
        USDC(50),
        integratorAddr
      );
      expect(await integrator.unbridgedTotal()).to.equal(USDC(50));

      // Buyer B: the Diamond delivers $50 but REPORTS $80.
      const idB = await mockDiamond.nextOrderId();
      await integrator.connect(user2).userBuyUsdcToSolana(USDC(50), INR, SOLANA_ATA, 1, "", 0, 0);
      await mockUsdc.mint(integratorAddr, USDC(50));
      await expect(
        mockDiamond.adminCallOnOrderComplete(
          integratorAddr,
          idB,
          user2.address,
          USDC(80),
          integratorAddr
        )
      )
        .to.emit(integrator, "OnrampAmountAdjusted")
        .withArgs(idB, USDC(50), USDC(50)); // clamped to what arrived, not $80

      // Unclamped this reads $130 against a $100 balance — buyer A's reserve
      // part-funding buyer B's burn.
      expect(await integrator.unbridgedTotal()).to.equal(USDC(100));
      expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(USDC(100));
      expect((await integrator.getSession(idB)).amount).to.equal(USDC(50));
      // Nothing is surplus, so buyer A's reserve stays un-sweepable.
      await expect(
        integrator.connect(owner).withdrawUsdc(owner.address, 1)
      ).to.be.revertedWithCustomError(integrator, "WithdrawExceedsSurplus");
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

    it("settles a cancel-then-complete and re-charges the daily slot", async function () {
      // Forward-compat for when onOrderCancel ships on the live Diamond. The
      // gateway routes the USDC BEFORE calling this hook and try/catches it, so
      // a revert here would be swallowed and strand the delivered amount with
      // no session record (sweepable as owner "surplus"). The contract must
      // instead settle normally, re-charge the daily slot onOrderCancel
      // released, and keep `cancelled = true` as the record.
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).userBuyUsdcToSolana(USDC(50), INR, SOLANA_ATA, 1, "", 0, 0);
      const afterPlacement = await integrator.getRemainingDailyCount(user.address);

      // The mock Diamond drives onOrderCancel (the live Diamond will once
      // feat/integrator-on-order-cancel ships): the daily slot is freed.
      await mockDiamond.simulateOrderCancelled(orderId);
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(afterPlacement + 1n);

      // Gateway completes the cancelled order: USDC routed first, hook after.
      await expect(mockDiamond.simulateOrderComplete(orderId))
        .to.emit(integrator, "CancelledOrderCompleted")
        .withArgs(orderId, user.address);

      // Settled, bridged (money moved on to Solana), honest cancelled record.
      const session = await integrator.getSession(orderId);
      expect(session.fulfilled).to.equal(true);
      expect(session.cancelled).to.equal(true);
      expect(session.bridged).to.equal(true);

      // Nothing stranded, nothing sweepable: no un-reserved balance remains.
      expect(await integrator.unbridgedTotal()).to.equal(0);
      expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(0);
      await expect(
        integrator.connect(owner).withdrawUsdc(owner.address, USDC(50))
      ).to.be.revertedWithCustomError(integrator, "WithdrawExceedsSurplus");

      // The daily slot is re-charged (over-counting is the safe direction).
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(afterPlacement);
    });

    it("CEI in _bridge: a reentrant burn-token cannot double-bridge", async function () {
      // Regression pin for the checks-effects-interactions ordering in
      // _bridge. No standard mock re-enters, so without this fixture the CEI
      // ordering can be reverted with the suite staying green (verified by
      // mutation review on PR #42). The malicious token re-enters
      // retryBridge(orderId) from inside the TokenMessenger's transferFrom —
      // i.e. mid-burn — and records whether the reentrant call succeeded.
      const evilUsdc = await (await ethers.getContractFactory("MockReentrantUSDC")).deploy();
      const evilUsdcAddr = await evilUsdc.getAddress();
      const diamond2 = await (await ethers.getContractFactory("MockDiamond")).deploy(evilUsdcAddr);
      const messenger2 = await (await ethers.getContractFactory("MockTokenMessengerV2")).deploy();
      const transmitter2 = await (
        await ethers.getContractFactory("MockMessageTransmitterV2")
      ).deploy(evilUsdcAddr);

      const integrator2 = await (
        await ethers.getContractFactory("ShowdownCheckoutIntegrator")
      ).deploy(
        await diamond2.getAddress(),
        evilUsdcAddr,
        await messenger2.getAddress(),
        await transmitter2.getAddress(),
        SOLANA_DOMAIN,
        DAILY_COUNT,
        livenessAttestor.address,
        kycAttestor.address,
        LIVENESS_CAP_INDIA,
        LIVENESS_CAP_ABROAD,
        KYC_CAP_INDIA,
        KYC_CAP_ABROAD
      );
      const integrator2Addr = await integrator2.getAddress();
      await diamond2.registerIntegrator(integrator2Addr, await integrator2.proxyImpl());
      await evilUsdc.mint(await diamond2.getAddress(), USDC(1_000_000));
      await messenger2.setBurnLimitPerMessage(evilUsdcAddr, USDC(1_000_000));

      // Attest against the second integrator (EIP-712 domain binds the address).
      const nullifier = nullifierFor(`kyc:reentrancy:${user.address}`);
      const expiry = await futureExpiry();
      const sig = await kycAttestor.signTypedData(
        {
          name: "KycVerifier",
          version: "1",
          chainId,
          verifyingContract: integrator2Addr,
        },
        {
          KycAttestation: [
            { name: "wallet", type: "address" },
            { name: "nullifier", type: "bytes32" },
            { name: "limit", type: "uint256" },
            { name: "expiry", type: "uint256" },
          ],
        },
        { wallet: user.address, nullifier, limit: KYC_CAP, expiry }
      );
      await integrator2.connect(user).submitKycAttestation(nullifier, KYC_CAP, expiry, sig);

      const orderId = await diamond2.nextOrderId();
      await integrator2.connect(user).userBuyUsdcToSolana(USDC(50), INR, SOLANA_ATA, 1, "", 0, 0);
      await evilUsdc.armReentrancy(integrator2Addr, orderId);

      // Complete: USDC routed in, hook bridges, transferFrom re-enters mid-burn.
      await diamond2.simulateOrderComplete(orderId);

      expect(await evilUsdc.reentryAttempted()).to.equal(true);
      // With effects-before-burn the session is already bridged when the
      // reentrant call lands, so it MUST fail (AlreadyBridged). If this reads
      // true, the CEI ordering has been reverted and the burn ran twice.
      expect(await evilUsdc.reentrySucceeded()).to.equal(false);

      const session = await integrator2.getSession(orderId);
      expect(session.bridged).to.equal(true);
      // Custody invariant: nothing burned beyond the session amount.
      expect(await evilUsdc.balanceOf(integrator2Addr)).to.equal(0);
      expect(await integrator2.unbridgedTotal()).to.equal(0);
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

    // #53.2: delivery is initiator-only. `encUpi` IS the fiat payout target, so
    // any third party permitted to supply it could redirect the seller's cash to
    // itself. There is no relayer to opt into — not even the owner.
    // #72: the Diamond names the amount this contract grants an allowance over,
    // out of the seller's own proxy. MerchantTerminalIntegrator bounds that same
    // boundary four ways; this contract carried only the balance check.
    describe("Diamond-trust guards on delivery (#72)", function () {
      async function acceptedOrder(amount = USDC(50)) {
        await bridgeIn(user, USDC(5000)); // no cap on bridging in — that's the point
        const orderId = await mockDiamond.nextOrderId();
        await integrator.connect(user).userInitiateOfframp(amount, INR, 0, 1, 0, "pub");
        await mockDiamond.acceptSellOrder(orderId, "merchant-pubkey");
        return orderId;
      }

      it("refuses when actualUsdtAmount is zero instead of inventing the principal", async function () {
        const orderId = await acceptedOrder();
        await mockDiamond.setAdditionalOrderDetailsFeeUnready(true);
        await expect(
          integrator.connect(user).deliverOfframpUpi(orderId, "enc-upi")
        ).to.be.revertedWithCustomError(integrator, "OfframpFeeNotReady");
      });

      it("refuses when actualUsdtAmount is below the escrowed principal", async function () {
        const orderId = await acceptedOrder(USDC(50));
        // Below principal = a re-price, partial fill or fee-model change.
        await mockDiamond.setActualUsdtAmountOverride(orderId, USDC(40));
        await expect(
          integrator.connect(user).deliverOfframpUpi(orderId, "enc-upi")
        ).to.be.revertedWithCustomError(integrator, "OfframpFeeNotReady");
      });

      it("refuses to deliver an order that is not ACCEPTED", async function () {
        // PLACED: no matched merchant to pay.
        await bridgeIn(user, USDC(100));
        const orderId = await mockDiamond.nextOrderId();
        await integrator.connect(user).userInitiateOfframp(USDC(50), INR, 0, 1, 0, "pub");
        await expect(
          integrator.connect(user).deliverOfframpUpi(orderId, "enc-upi")
        ).to.be.revertedWithCustomError(integrator, "OfframpNotDeliverable");

        // And a replay after a successful delivery (status is now PAID).
        await mockDiamond.acceptSellOrder(orderId, "merchant-pubkey");
        await integrator.connect(user).deliverOfframpUpi(orderId, "enc-upi");
        await expect(
          integrator.connect(user).deliverOfframpUpi(orderId, "enc-upi")
        ).to.be.revertedWithCustomError(integrator, "OfframpNotDeliverable");
      });

      it("delivers normally when the Diamond reports principal + a real fee", async function () {
        await mockDiamond.setSellFeeBps(100); // 1%
        const orderId = await acceptedOrder(USDC(50));
        await expect(integrator.connect(user).deliverOfframpUpi(orderId, "enc-upi")).to.emit(
          integrator,
          "OfframpUpiDelivered"
        );
      });
    });

    it("restricts UPI delivery to the initiator, with no relayer escape", async function () {
      await bridgeIn(user, USDC(50));
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).userInitiateOfframp(USDC(50), INR, 0, 1, 0, "pub");
      await mockDiamond.acceptSellOrder(orderId, "merchant-pubkey");

      await expect(
        integrator.connect(stranger).deliverOfframpUpi(orderId, "enc-upi")
      ).to.be.revertedWithCustomError(integrator, "OfframpNotAuthorized");

      // The owner cannot delegate the power either — the setter does not exist.
      expect((integrator as any).setOfframpRelayer).to.equal(undefined);
      await expect(
        integrator.connect(owner).deliverOfframpUpi(orderId, "enc-upi")
      ).to.be.revertedWithCustomError(integrator, "OfframpNotAuthorized");

      // The initiator can always self-deliver.
      await expect(integrator.connect(user).deliverOfframpUpi(orderId, "enc-upi")).to.emit(
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

  // ─── Pre-deploy hardening (#44/#45/#51/#53/#55/#47) ─────────────────
  describe("pre-deploy hardening", function () {
    // A zero attestor fails closed (`AttestorNotSet`), so it never opens a hole —
    // but `owner` is immutable, so a deploy or a fat-fingered rotation that zeroes
    // one strands every user mid-verification with no remedy but a redeploy and a
    // re-whitelist. Reject it at both entry points instead.
    it("rejects a zero liveness attestor in the constructor", async function () {
      const Factory = await ethers.getContractFactory("ShowdownCheckoutIntegrator");
      await expect(
        Factory.deploy(
          mockDiamond.target,
          usdcAddr,
          tokenMessenger.target,
          messageTransmitter.target,
          SOLANA_DOMAIN,
          DAILY_COUNT,
          ethers.ZeroAddress,
          kycAttestor.address,
          LIVENESS_CAP_INDIA,
          LIVENESS_CAP_ABROAD,
          KYC_CAP_INDIA,
          KYC_CAP_ABROAD
        )
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    });

    it("rejects a zero KYC attestor in the constructor", async function () {
      const Factory = await ethers.getContractFactory("ShowdownCheckoutIntegrator");
      await expect(
        Factory.deploy(
          mockDiamond.target,
          usdcAddr,
          tokenMessenger.target,
          messageTransmitter.target,
          SOLANA_DOMAIN,
          DAILY_COUNT,
          livenessAttestor.address,
          ethers.ZeroAddress,
          LIVENESS_CAP_INDIA,
          LIVENESS_CAP_ABROAD,
          KYC_CAP_INDIA,
          KYC_CAP_ABROAD
        )
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    });

    it("rejects zeroing either attestor via the setters", async function () {
      await expect(
        integrator.connect(owner).setLivenessAttestor(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      await expect(
        integrator.connect(owner).setKycAttestor(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      // A real rotation still works — the check must not block attestor rotation,
      // which is the documented remedy for a leaked signing key.
      await expect(integrator.connect(owner).setLivenessAttestor(stranger.address))
        .to.emit(integrator, "LivenessAttestorUpdated")
        .withArgs(stranger.address);
      expect(await integrator.livenessAttestor()).to.equal(stranger.address);
    });

    it("#45: a lower KYC sub-cap binds even after a higher liveness attestation", async function () {
      // Risk-flagged user: liveness attests a huge limit (clamped to $20 by the
      // tier ceiling), then KYC deliberately signs a $5 per-user sub-cap.
      await verify(user, "liveness", USDC(10_000), "live-hi");
      expect(await integrator.effectiveLimit(user.address, INR)).to.equal(USDC(20));
      await verify(user, "kyc", USDC(5), "kyc-lo");
      // Before the fix this read min(10000, tierCap[2]=100) = $100. Now the
      // tier-2 clamp uses tier 2's OWN attested $5.
      expect(await integrator.userTier(user.address)).to.equal(TIER.KYC);
      expect(await integrator.effectiveLimit(user.address, INR)).to.equal(USDC(5));
    });

    it("#45: a same-tier re-attestation downgrade reduces the effective cap", async function () {
      await verify(user, "kyc", USDC(100), "kyc-1");
      expect(await integrator.effectiveLimit(user.address, INR)).to.equal(USDC(100));
      await verify(user, "kyc", USDC(5), "kyc-2"); // fresh nullifier, risk downgrade
      expect(await integrator.effectiveLimit(user.address, INR)).to.equal(USDC(5));
    });

    it("#53: a seller blocked after placement cannot be delivered", async function () {
      await verify(user, "kyc", KYC_CAP);
      await bridgeIn(user, USDC(50));
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).userInitiateOfframp(USDC(20), INR, 0, 1, 0, "pub");
      await mockDiamond.acceptSellOrder(orderId, "m");
      await integrator.connect(owner).setUserBlocked(user.address, true);
      await expect(
        integrator.connect(user).deliverOfframpUpi(orderId, "enc")
      ).to.be.revertedWithCustomError(integrator, "UserIsBlocked");
    });

    it("#51/#44: escrow blocks over-committing multiple SELLs against one balance", async function () {
      await verify(user, "kyc", KYC_CAP);
      await bridgeIn(user, USDC(100));
      await integrator.connect(user).userInitiateOfframp(USDC(60), INR, 0, 1, 0, "pub");
      expect(await integrator.pendingOfframpTotal(user.address)).to.equal(USDC(60));
      // A second $60 needs $120 of headroom against the $100 balance.
      await expect(
        integrator.connect(user).userInitiateOfframp(USDC(60), INR, 0, 1, 0, "pub")
      ).to.be.revertedWithCustomError(integrator, "InsufficientBridgedFunds");
    });

    it("#44 (known/deferred): a full-balance SELL still strands at delivery once a fee applies", async function () {
      // Documents the half of #44 NOT fixed here: the escrow prevents
      // over-commit, but a single full-balance SELL is still undeliverable when
      // the Diamond charges a fee on top (needed = principal + fee > balance).
      // The fee-headroom fix is deferred pending p2p's max-SELL-fee bound.
      await verify(user, "kyc", KYC_CAP);
      await mockDiamond.setSellFeeBps(100); // 1%
      await bridgeIn(user, USDC(50));
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).userInitiateOfframp(USDC(50), INR, 0, 1, 0, "pub");
      await mockDiamond.acceptSellOrder(orderId, "m");
      await expect(
        integrator.connect(user).deliverOfframpUpi(orderId, "enc")
      ).to.be.revertedWithCustomError(integrator, "InsufficientBridgedFunds");
    });

    it("#51: releases the daily SELL slot when a never-accepted order is cancelled", async function () {
      await verify(user, "kyc", KYC_CAP);
      await bridgeIn(user, USDC(50));
      const before = await integrator.getRemainingOfframpDailyCount(user.address);
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).userInitiateOfframp(USDC(20), INR, 0, 1, 0, "pub");
      expect(await integrator.getRemainingOfframpDailyCount(user.address)).to.equal(before - 1n);
      await mockDiamond.cancelSellOrder(orderId); // never accepted
      await integrator.reconcile(orderId);
      expect(await integrator.getRemainingOfframpDailyCount(user.address)).to.equal(before);
      expect(await integrator.pendingOfframpTotal(user.address)).to.equal(0);
    });

    it("#51: keeps the slot for a merchant-accepted order that cancels", async function () {
      await verify(user, "kyc", KYC_CAP);
      await bridgeIn(user, USDC(50));
      const before = await integrator.getRemainingOfframpDailyCount(user.address);
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).userInitiateOfframp(USDC(20), INR, 0, 1, 0, "pub");
      await mockDiamond.acceptSellOrder(orderId, "m"); // accepted → slot not refundable
      await mockDiamond.cancelSellOrder(orderId);
      await integrator.reconcile(orderId);
      expect(await integrator.getRemainingOfframpDailyCount(user.address)).to.equal(before - 1n);
    });

    it("#55: onOrderCancel tolerates a repeat call without double-freeing the slot", async function () {
      await verify(user, "kyc", KYC_CAP);
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).userBuyUsdcToSolana(USDC(20), INR, SOLANA_ATA, 1, "", 0, 0);
      const afterPlace = await integrator.getRemainingDailyCount(user.address);
      const diamondAddr = await mockDiamond.getAddress();
      await ethers.provider.send("hardhat_setBalance", [diamondAddr, "0xde0b6b3a7640000"]);
      const asDiamond = integrator.connect(await ethers.getImpersonatedSigner(diamondAddr));
      await asDiamond.onOrderCancel(orderId);
      const afterCancel = await integrator.getRemainingDailyCount(user.address);
      expect(afterCancel).to.equal(afterPlace + 1n); // freed exactly one
      await asDiamond.onOrderCancel(orderId); // repeat must not revert or double-free
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(afterCancel);
    });

    it("#47: rejects a malleated (high-s) attestation signature", async function () {
      const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
      const nullifier = nullifierFor("malleate");
      const expiry = await futureExpiry();
      const sig = await signAttestation(
        "liveness",
        livenessAttestor,
        user.address,
        nullifier,
        USDC(20),
        expiry
      );
      const parsed = ethers.Signature.from(sig);
      const s2 = ethers.toBeHex(N - BigInt(parsed.s), 32);
      const v2 = ethers.toBeHex(parsed.v === 27 ? 28 : 27, 1);
      const malleated = ethers.concat([parsed.r, s2, v2]);
      await expect(
        integrator.connect(user).submitLivenessAttestation(nullifier, USDC(20), expiry, malleated)
      ).to.be.revertedWithCustomError(integrator, "InvalidSignature");
    });

    it("#47: userRescueStuckBridge succeeds at exactly completedAt + BRIDGE_RESCUE_DELAY", async function () {
      await verify(user, "kyc", KYC_CAP);
      await tokenMessenger.setBurnLimitPerMessage(usdcAddr, 0); // force fail-closed
      const orderId = await buyAndComplete(user, USDC(50));
      const completedAt = Number((await integrator.getSession(orderId)).completedAt);
      const RESCUE = 7 * 24 * 3600;
      await ethers.provider.send("evm_setNextBlockTimestamp", [completedAt + RESCUE]);
      // `<` boundary: at exactly the deadline it must SUCCEED — the `<=` mutation
      // reverts here, so this kills it.
      await expect(integrator.connect(user).userRescueStuckBridge(orderId)).to.emit(
        integrator,
        "BridgeRescued"
      );
    });
  });

  // ─── Bridging back to Solana ────────────────────────────────────────

  describe("test hardening (#78)", function () {
    beforeEach(async function () {
      await verify(user, "kyc", KYC_CAP);
    });

    // The _bridge idempotency guard survived mutation because both of its
    // callers carry their own check. Reaching it directly is the only way to pin
    // it — impersonating the contract is exactly the "future second caller" the
    // guard was added for.
    it("_bridge refuses an already-bridged session even when reached directly", async function () {
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).userBuyUsdcToSolana(USDC(20), INR, SOLANA_ATA, 1, "", 0, 0);
      await mockDiamond.simulateOrderComplete(orderId);
      expect((await integrator.getSession(orderId)).bridged).to.equal(true);

      await ethers.provider.send("hardhat_setBalance", [integratorAddr, "0xde0b6b3a7640000"]);
      const asSelf = integrator.connect(await ethers.getImpersonatedSigner(integratorAddr));
      // Bypasses onOrderComplete's `fulfilled` guard and retryBridge's own check.
      await expect(asSelf.selfBridge(orderId)).to.be.revertedWithCustomError(
        integrator,
        "AlreadyBridged"
      );
    });

    it("_bridge refuses a rescued session reached directly", async function () {
      await tokenMessenger.setBurnLimitPerMessage(usdcAddr, 0); // force fail-closed
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).userBuyUsdcToSolana(USDC(20), INR, SOLANA_ATA, 1, "", 0, 0);
      await mockDiamond.simulateOrderComplete(orderId);
      const delay = await integrator.BRIDGE_RESCUE_DELAY();
      await ethers.provider.send("evm_increaseTime", [Number(delay) + 1]);
      await ethers.provider.send("evm_mine", []);
      await integrator.connect(user).userRescueStuckBridge(orderId);
      expect((await integrator.getSession(orderId)).rescued).to.equal(true);

      await ethers.provider.send("hardhat_setBalance", [integratorAddr, "0xde0b6b3a7640000"]);
      const asSelf = integrator.connect(await ethers.getImpersonatedSigner(integratorAddr));
      await expect(asSelf.selfBridge(orderId)).to.be.revertedWithCustomError(
        integrator,
        "AlreadyBridged"
      );
    });

    // No test crossed a UTC day boundary, so the day-bucket arithmetic that the
    // whole daily-count limit rests on was never exercised.
    it("the daily count resets across a UTC day boundary", async function () {
      const full = await integrator.getRemainingDailyCount(user.address);
      for (let i = 0; i < Number(full); i++) {
        await integrator.connect(user).userBuyUsdcToSolana(USDC(1), INR, SOLANA_ATA, 1, "", 0, 0);
      }
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(0);
      // validateOrder returns false and the Diamond hard-reverts the placement.
      await expect(
        integrator.connect(user).userBuyUsdcToSolana(USDC(1), INR, SOLANA_ATA, 1, "", 0, 0)
      ).to.be.reverted;

      // Cross into the next UTC day.
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(full);
      await expect(
        integrator.connect(user).userBuyUsdcToSolana(USDC(1), INR, SOLANA_ATA, 1, "", 0, 0)
      ).to.not.be.reverted;
    });

    it("the offramp daily count buckets independently across the same boundary", async function () {
      await bridgeIn(user, USDC(500));
      const full = await integrator.getRemainingOfframpDailyCount(user.address);
      for (let i = 0; i < Number(full); i++) {
        await integrator.connect(user).userInitiateOfframp(USDC(1), INR, 0, 1, 0, "pub");
      }
      expect(await integrator.getRemainingOfframpDailyCount(user.address)).to.equal(0);
      // Onramp budget is untouched by offramp usage.
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(
        await integrator.dailyTxCountLimit()
      );

      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);
      expect(await integrator.getRemainingOfframpDailyCount(user.address)).to.equal(full);
    });
  });

  describe("proxy USDC rescue (#74) and the SELL escrow", function () {
    beforeEach(async function () {
      await verify(user, "kyc", KYC_CAP);
    });

    it("lets a user pull bridged-in USDC out when CCTP is unusable", async function () {
      const proxy = await bridgeIn(user, USDC(300));
      // Circle pauses / migrates the messenger: every burn reverts.
      await tokenMessenger.setBurnLimitPerMessage(usdcAddr, 0);
      await expect(integrator.connect(user).userBridgeBackToSolana(USDC(300), SOLANA_ATA)).to.be
        .reverted;

      const before = await mockUsdc.balanceOf(user.address);
      await expect(integrator.connect(user).userRescueProxyUsdc(USDC(300)))
        .to.emit(integrator, "ProxyUsdcRescued")
        .withArgs(user.address, USDC(300));
      expect(await mockUsdc.balanceOf(user.address)).to.equal(before + USDC(300));
      expect(await mockUsdc.balanceOf(proxy)).to.equal(0);
    });

    it("still works for a blocked user — a block must never trap funds", async function () {
      await bridgeIn(user, USDC(100));
      await integrator.connect(owner).setUserBlocked(user.address, true);
      await expect(integrator.connect(user).userRescueProxyUsdc(USDC(100))).to.emit(
        integrator,
        "ProxyUsdcRescued"
      );
    });

    it("still works with the offramp kill switch off, and for an unverified user", async function () {
      await bridgeIn(user2, USDC(40)); // user2 has no attestation at all
      await integrator.connect(owner).setOfframpEnabled(false);
      await expect(integrator.connect(user2).userRescueProxyUsdc(USDC(40))).to.emit(
        integrator,
        "ProxyUsdcRescued"
      );
    });

    it("cannot touch USDC escrowed against an outstanding SELL", async function () {
      await bridgeIn(user, USDC(100));
      await integrator.connect(user).userInitiateOfframp(USDC(80), INR, 0, 1, 0, "pub");
      // $80 is committed; only $20 is free.
      await expect(
        integrator.connect(user).userRescueProxyUsdc(USDC(30))
      ).to.be.revertedWithCustomError(integrator, "InsufficientBridgedFunds");
      await expect(integrator.connect(user).userRescueProxyUsdc(USDC(20))).to.emit(
        integrator,
        "ProxyUsdcRescued"
      );
    });

    // Low 3 from the same review: bridging out ignored the escrow entirely, so a
    // seller could strand a merchant who had accepted their SELL.
    it("bridging back to Solana also respects the SELL escrow", async function () {
      await bridgeIn(user, USDC(100));
      const orderId = await mockDiamond.nextOrderId();
      await integrator.connect(user).userInitiateOfframp(USDC(80), INR, 0, 1, 0, "pub");
      await mockDiamond.acceptSellOrder(orderId, "merchant-pubkey");

      await expect(
        integrator.connect(user).userBridgeBackToSolana(USDC(100), SOLANA_ATA)
      ).to.be.revertedWithCustomError(integrator, "InsufficientBridgedFunds");
      // The uncommitted remainder is still free to move.
      await expect(integrator.connect(user).userBridgeBackToSolana(USDC(20), SOLANA_ATA)).to.emit(
        integrator,
        "BridgedBackToSolana"
      );
      // And the merchant's order is still deliverable.
      await expect(integrator.connect(user).deliverOfframpUpi(orderId, "enc-upi")).to.emit(
        integrator,
        "OfframpUpiDelivered"
      );
    });

    it("rejects a zero amount and cannot drain someone else's proxy", async function () {
      await bridgeIn(user, USDC(50));
      await expect(integrator.connect(user).userRescueProxyUsdc(0)).to.be.revertedWithCustomError(
        integrator,
        "InvalidAmount"
      );
      // stranger has their own (empty) proxy — they cannot reach user's.
      await expect(
        integrator.connect(stranger).userRescueProxyUsdc(USDC(50))
      ).to.be.revertedWithCustomError(integrator, "InsufficientBridgedFunds");
      expect(await mockUsdc.balanceOf(await integrator.proxyAddress(user.address))).to.equal(
        USDC(50)
      );
    });
  });

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
