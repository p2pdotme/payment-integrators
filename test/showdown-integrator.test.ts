import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const TIER = { NONE: 0, LIVENESS: 1, KYC: 2 };
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
  const DAILY_COUNT = 10;
  const LIVENESS_CAP = USDC(20);
  const KYC_CAP = USDC(50);

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
      LIVENESS_CAP,
      KYC_CAP
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
      expect(await integrator.effectiveLimit(user.address)).to.equal(0);
      await expect(
        integrator.connect(user).userBuyUsdcToSolana(USDC(5), INR, SOLANA_ATA, 1, "", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "NotKycVerified");
    });

    it("grants the $20 liveness tier", async function () {
      await verify(user, "liveness", LIVENESS_CAP);
      expect(await integrator.userTier(user.address)).to.equal(TIER.LIVENESS);
      expect(await integrator.effectiveLimit(user.address)).to.equal(USDC(20));
    });

    it("grants the $50 KYC tier", async function () {
      await verify(user, "kyc", KYC_CAP);
      expect(await integrator.userTier(user.address)).to.equal(TIER.KYC);
      expect(await integrator.effectiveLimit(user.address)).to.equal(USDC(50));
    });

    it("clamps an over-generous attested limit to the on-chain tier cap", async function () {
      // A compromised / misconfigured attestor signs $1000 for the liveness
      // tier; the contract's own $20 ceiling still wins.
      await verify(user, "liveness", USDC(1000));
      expect(await integrator.grantedLimit(user.address)).to.equal(USDC(1000));
      expect(await integrator.effectiveLimit(user.address)).to.equal(LIVENESS_CAP);

      await expect(
        integrator.connect(user).userBuyUsdcToSolana(USDC(21), INR, SOLANA_ATA, 1, "", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "KycLimitExceeded");
    });

    it("honours an attested limit below the tier cap", async function () {
      await verify(user, "kyc", USDC(30));
      expect(await integrator.effectiveLimit(user.address)).to.equal(USDC(30));
    });

    it("raises the cap when a liveness user upgrades to KYC", async function () {
      await verify(user, "liveness", LIVENESS_CAP);
      expect(await integrator.effectiveLimit(user.address)).to.equal(USDC(20));
      await verify(user, "kyc", KYC_CAP);
      expect(await integrator.effectiveLimit(user.address)).to.equal(USDC(50));
    });

    it("never lowers a cap when a KYC user later claims liveness", async function () {
      await verify(user, "kyc", KYC_CAP);
      await verify(user, "liveness", LIVENESS_CAP);
      expect(await integrator.userTier(user.address)).to.equal(TIER.KYC);
      expect(await integrator.effectiveLimit(user.address)).to.equal(USDC(50));
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
      await integrator.connect(owner).setTierCap(TIER.LIVENESS, 0);
      expect(await integrator.effectiveLimit(user.address)).to.equal(0);
    });

    it("rejects a tier cap update from a non-owner", async function () {
      await expect(
        integrator.connect(stranger).setTierCap(TIER.LIVENESS, USDC(999))
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
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
        integrator.connect(user).userBuyUsdcToSolana(USDC(51), INR, SOLANA_ATA, 1, "", 0, 0)
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
      await bridgeIn(user, USDC(100));
      await expect(
        integrator.connect(user).userInitiateOfframp(USDC(51), INR, 0, 1, 0, "pub")
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

      expect(await asDiamond.validateOrder.staticCall(proxy, USDC(50), INR)).to.equal(true);
      expect(await asDiamond.validateOrder.staticCall(proxy, USDC(51), INR)).to.equal(false);

      await integrator.connect(owner).setTierCap(TIER.KYC, USDC(5));
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
