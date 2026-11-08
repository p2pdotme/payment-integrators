import { expect } from "chai";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import type { Wallet } from "ethers";

describe("BlioCheckoutIntegrator", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let user2: SignerWithAddress;
  let treasury: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let integrator: any;

  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
  const DAILY_COUNT_LIMIT = 5;
  const PRODUCT_ID = 1;
  const PRODUCT_PRICE = USDC(10);
  const INR = ethers.encodeBytes32String("INR");
  const BRL = ethers.encodeBytes32String("BRL");
  const TIER_LIVENESS = 1n;
  const TIER_PASSPORT = 2n;

  // Deterministic per-service attestor / outsider keys, so the helper signs with
  // an explicit `ethers.TypedDataEncoder` digest rather than a JSON-RPC signer
  // (which would hide whether the test domain matches the contract's).
  const livenessSigner = new ethers.Wallet(
    ethers.keccak256(ethers.toUtf8Bytes("blio-test-liveness-v1"))
  );
  const kycSigner = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes("blio-test-kyc-v1")));
  const outsider = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes("blio-test-outsider-v1")));

  const LIVENESS_TYPES = {
    LivenessAttestation: [
      { name: "wallet", type: "address" },
      { name: "nullifier", type: "bytes32" },
      { name: "limit", type: "uint256" },
      { name: "expiry", type: "uint256" },
    ],
  };

  const KYC_TYPES = {
    KycAttestation: [
      { name: "wallet", type: "address" },
      { name: "nullifier", type: "bytes32" },
      { name: "limit", type: "uint256" },
      { name: "expiry", type: "uint256" },
    ],
  };

  /** Current EVM block timestamp (other suites time-travel the chain). */
  async function now(): Promise<bigint> {
    return BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  }

  async function livenessDomain(overrides: Record<string, unknown> = {}) {
    return {
      name: "LivenessVerifier",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await integrator.getAddress(),
      ...overrides,
    } as any;
  }

  async function kycDomain(overrides: Record<string, unknown> = {}) {
    return {
      name: "KycVerifier",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await integrator.getAddress(),
      ...overrides,
    } as any;
  }

  function freshNullifier(label: string, wallet: string) {
    return ethers.keccak256(
      ethers.toUtf8Bytes(`${label}:${wallet}:${Date.now()}:${Math.random()}`)
    );
  }

  /** Builds the exact liveness EIP-712 digest the contract verifies. */
  async function signLiveness(opts: {
    wallet: string;
    nullifier?: string;
    limit?: bigint;
    expiry?: bigint;
    signer?: Wallet;
    domain?: Record<string, unknown>;
  }) {
    const nullifier = opts.nullifier ?? freshNullifier("liveness", opts.wallet);
    const expiry = opts.expiry ?? (await now()) + 600n;
    const value = {
      wallet: opts.wallet,
      nullifier,
      limit: opts.limit ?? 0n,
      expiry,
    };
    const domain = await livenessDomain(opts.domain);
    const digest = ethers.TypedDataEncoder.hash(domain, LIVENESS_TYPES, value);
    const signature = ethers.Signature.from(
      (opts.signer ?? livenessSigner).signingKey.sign(digest)
    ).serialized;
    return { ...value, digest, signature };
  }

  /** Builds the exact KYC EIP-712 digest the contract verifies. */
  async function signKyc(opts: {
    wallet: string;
    nullifier?: string;
    limit?: bigint;
    expiry?: bigint;
    signer?: Wallet;
    domain?: Record<string, unknown>;
  }) {
    const nullifier = opts.nullifier ?? freshNullifier("kyc", opts.wallet);
    const expiry = opts.expiry ?? (await now()) + 600n;
    const value = {
      wallet: opts.wallet,
      nullifier,
      limit: opts.limit ?? 0n,
      expiry,
    };
    const domain = await kycDomain(opts.domain);
    const digest = ethers.TypedDataEncoder.hash(domain, KYC_TYPES, value);
    const signature = ethers.Signature.from(
      (opts.signer ?? kycSigner).signingKey.sign(digest)
    ).serialized;
    return { ...value, digest, signature };
  }

  type LivenessAttestation = Awaited<ReturnType<typeof signLiveness>>;
  type KycAttestation = Awaited<ReturnType<typeof signKyc>>;

  async function submitLiveness(submitter: SignerWithAddress, a: LivenessAttestation) {
    return integrator
      .connect(submitter)
      .submitLivenessAttestation(a.nullifier, a.limit, a.expiry, a.signature);
  }

  async function submitKyc(submitter: SignerWithAddress, a: KycAttestation) {
    return integrator
      .connect(submitter)
      .submitKycAttestation(a.wallet, a.nullifier, a.limit, a.expiry, a.signature);
  }

  async function attest(
    who: SignerWithAddress,
    tier = TIER_LIVENESS,
    opts: { limit?: bigint; expiry?: bigint } = {}
  ) {
    if (tier === TIER_LIVENESS) {
      const a = await signLiveness({ wallet: who.address, ...opts });
      await submitLiveness(who, a);
      return a;
    }
    const a = await signKyc({ wallet: who.address, ...opts });
    await submitKyc(who, a);
    return a;
  }

  beforeEach(async function () {
    [owner, user, user2, treasury] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUsdc = await MockUSDC.deploy();

    const MockDiamond = await ethers.getContractFactory("MockDiamond");
    mockDiamond = await MockDiamond.deploy(await mockUsdc.getAddress());

    const Integrator = await ethers.getContractFactory("BlioCheckoutIntegrator");
    integrator = await Integrator.deploy(
      await mockDiamond.getAddress(),
      await mockUsdc.getAddress(),
      treasury.address,
      owner.address,
      DAILY_COUNT_LIMIT,
      livenessSigner.address,
      kycSigner.address
    );

    await mockDiamond.registerIntegrator(
      await integrator.getAddress(),
      await integrator.proxyImpl()
    );
    await integrator.setProductPrice(PRODUCT_ID, PRODUCT_PRICE);
    await integrator.setProductActive(PRODUCT_ID, true);
    // BRL is a real blio currency but the constructor only seeds INR and the
    // OTHER wildcard, so the owner opts it in explicitly.
    await integrator.setCurrencyAllowed(BRL, true);
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(10000));

    // `user` starts attested at the liveness tier so the pre-existing checkout
    // tests keep exercising the same caps; `user2` stays unattested for the gate.
    await attest(user, TIER_LIVENESS);
  });

  const place = (signer = user, quantity = 1, currency = INR) =>
    integrator.connect(signer).userPlaceOrder(PRODUCT_ID, quantity, currency, 1, "", 0, 0);

  describe("Happy path", function () {
    it("settles USDC to the treasury and emits BlioOrderCompleted", async function () {
      const before = await mockUsdc.balanceOf(treasury.address);
      await place(user, 2);
      const session = await integrator.getSession(1);
      expect(session.user).to.equal(user.address);
      expect(session.usdcAmount).to.equal(USDC(20));
      expect(session.quantity).to.equal(2);

      await expect(mockDiamond.simulateOrderComplete(1))
        .to.emit(integrator, "BlioOrderCompleted")
        .withArgs(1, user.address, PRODUCT_ID, 2, USDC(20));

      expect(await mockUsdc.balanceOf(treasury.address)).to.equal(before + USDC(20));
      expect((await integrator.getSession(1)).fulfilled).to.equal(true);
    });

    it("emits BlioOrderCreated on placement", async function () {
      await expect(place(user, 3, BRL))
        .to.emit(integrator, "BlioOrderCreated")
        .withArgs(1, user.address, PRODUCT_ID, 3, USDC(30));
    });

    it("never holds order USDC on the integrator", async function () {
      await place(user, 1);
      await mockDiamond.simulateOrderComplete(1);
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(0n);
    });
  });

  describe("Products", function () {
    it("reverts ProductNotFound when price is unset", async function () {
      await expect(place(user, 1)).to.not.be.reverted; // id 1 exists
      await expect(
        integrator.connect(user).userPlaceOrder(999, 1, INR, 1, "", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "ProductNotFound");
    });

    it("reverts ProductInactive when the product is retired", async function () {
      await integrator.setProductActive(PRODUCT_ID, false);
      await expect(place(user, 1)).to.be.revertedWithCustomError(integrator, "ProductInactive");
    });

    it("reverts InvalidQuantity on zero quantity", async function () {
      await expect(place(user, 0)).to.be.revertedWithCustomError(integrator, "InvalidQuantity");
    });
  });

  describe("Limits", function () {
    it("reverts AmountExceedsLimit above the per-tx cap", async function () {
      // 6 × 10 = 60 USDC > 20 USDC (INR, liveness)
      await expect(place(user, 6)).to.be.revertedWithCustomError(integrator, "AmountExceedsLimit");
    });

    it("applies a per-currency cap", async function () {
      await integrator.setTxLimit(BRL, TIER_LIVENESS, USDC(20));
      expect(await integrator.userTxLimitFor(user.address, BRL)).to.equal(USDC(20));
      await expect(place(user, 3, BRL)).to.be.revertedWithCustomError(
        integrator,
        "AmountExceedsLimit"
      );
    });

    it("enforces the daily count limit", async function () {
      for (let i = 0; i < DAILY_COUNT_LIMIT; i++) {
        await place(user, 1);
      }
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(0n);
      await expect(place(user, 1)).to.be.revertedWithCustomError(integrator, "DailyCountExceeded");
    });

    it("pauses placements", async function () {
      await integrator.pause();
      await expect(place(user, 1)).to.be.revertedWithCustomError(integrator, "ContractPaused");
      await integrator.unpause();
      await expect(place(user, 1)).to.not.be.reverted;
    });
  });

  describe("Currency and tier limits", function () {
    it("reverts CapExceedsCeiling above the immutable (currency, tier) ceiling", async function () {
      await expect(
        integrator.setTxLimit(BRL, TIER_LIVENESS, USDC(51))
      ).to.be.revertedWithCustomError(integrator, "CapExceedsCeiling");
      await expect(
        integrator.setTxLimit(INR, TIER_PASSPORT, USDC(101))
      ).to.be.revertedWithCustomError(integrator, "CapExceedsCeiling");
    });

    it("gives INR a tighter limit than the rest for the same tier", async function () {
      expect(await integrator.userTxLimitFor(user.address, INR)).to.equal(USDC(20));
      expect(await integrator.userTxLimitFor(user.address, BRL)).to.equal(USDC(50));
      expect(await integrator.maxTxLimitFor(INR, TIER_LIVENESS)).to.equal(USDC(20));
      expect(await integrator.maxTxLimitFor(BRL, TIER_LIVENESS)).to.equal(USDC(50));
    });

    it("gives passport a higher limit than liveness", async function () {
      expect(await integrator.limitFor(INR, TIER_LIVENESS)).to.equal(USDC(20));
      expect(await integrator.limitFor(INR, TIER_PASSPORT)).to.equal(USDC(100));
      expect(await integrator.limitFor(BRL, TIER_LIVENESS)).to.equal(USDC(50));
      expect(await integrator.limitFor(BRL, TIER_PASSPORT)).to.equal(USDC(200));
    });

    it("rejects a quantity whose total exceeds the effective limit", async function () {
      // 2 × 10 = 20 USDC is exactly the INR/liveness cap.
      await expect(place(user, 2)).to.not.be.reverted;
      // 3 × 10 = 30 USDC is above it.
      await expect(place(user, 3)).to.be.revertedWithCustomError(integrator, "AmountExceedsLimit");
    });

    it("rejects the sixth order of the day", async function () {
      for (let i = 0; i < DAILY_COUNT_LIMIT; i++) await place(user, 1);
      expect(await integrator.getTodayCount(user.address)).to.equal(DAILY_COUNT_LIMIT);
      await expect(place(user, 1)).to.be.revertedWithCustomError(integrator, "DailyCountExceeded");
    });

    it("userTxLimit(currency) matches userTxLimitFor(user, currency)", async function () {
      expect(await integrator.connect(user).userTxLimit(INR)).to.equal(
        await integrator.userTxLimitFor(user.address, INR)
      );
      expect(await integrator.connect(user).userTxLimit(BRL)).to.equal(
        await integrator.userTxLimitFor(user.address, BRL)
      );
    });

    it("constructor rejects a daily count above the hard cap", async function () {
      const I = await ethers.getContractFactory("BlioCheckoutIntegrator");
      await expect(
        I.deploy(
          await mockDiamond.getAddress(),
          await mockUsdc.getAddress(),
          treasury.address,
          owner.address,
          DAILY_COUNT_LIMIT + 1,
          livenessSigner.address,
          kycSigner.address
        )
      ).to.be.revertedWithCustomError(integrator, "CapExceedsCeiling");
    });
  });

  describe("Currency allowlist", function () {
    const ZERO = ethers.ZeroHash;

    it("allows INR and bytes32(0) in the constructor", async function () {
      expect(await integrator.allowedCurrency(INR)).to.equal(true);
      expect(await integrator.allowedCurrency(ZERO)).to.equal(true);
      expect(await integrator.allowedCurrency(ethers.encodeBytes32String("PIX"))).to.equal(false);
    });

    it("keeps the canonical INR bucket at 20/100", async function () {
      expect(await integrator.userTxLimitFor(user.address, INR)).to.equal(USDC(20));
      await attest(user2, TIER_PASSPORT);
      expect(await integrator.userTxLimitFor(user2.address, INR)).to.equal(USDC(100));
    });

    it("keeps bytes32(0) in the OTHER bucket at 50/200", async function () {
      expect(await integrator.limitFor(ZERO, TIER_LIVENESS)).to.equal(USDC(50));
      expect(await integrator.limitFor(ZERO, TIER_PASSPORT)).to.equal(USDC(200));

      await expect(place(user, 5, ZERO)).to.not.be.reverted;
      await expect(place(user, 6, ZERO)).to.be.revertedWithCustomError(
        integrator,
        "AmountExceedsLimit"
      );

      await attest(user2, TIER_PASSPORT);
      await expect(place(user2, 20, ZERO)).to.not.be.reverted;
      await expect(place(user2, 21, ZERO)).to.be.revertedWithCustomError(
        integrator,
        "AmountExceedsLimit"
      );
    });

    it("rejects look-alike INR labels that would land in OTHER", async function () {
      const aliases = [
        ethers.keccak256(ethers.toUtf8Bytes("INR")),
        ethers.encodeBytes32String("inr"),
        ethers.encodeBytes32String("INR "),
      ];
      for (const currency of aliases) {
        await expect(place(user, 1, currency)).to.be.revertedWithCustomError(
          integrator,
          "CurrencyNotAllowed"
        );
        expect(await integrator.userTxLimitFor(user.address, currency)).to.equal(0n);
      }
    });

    it("lets the owner add and remove currencies, but not a user", async function () {
      const PIX = ethers.encodeBytes32String("PIX");

      await expect(
        integrator.connect(user).setCurrencyAllowed(PIX, true)
      ).to.be.revertedWithCustomError(integrator, "OwnableUnauthorizedAccount");

      await expect(integrator.setCurrencyAllowed(PIX, true))
        .to.emit(integrator, "CurrencyAllowlistUpdated")
        .withArgs(PIX, true);
      expect(await integrator.allowedCurrency(PIX)).to.equal(true);
      await expect(place(user, 1, PIX)).to.not.be.reverted;

      await expect(integrator.setCurrencyAllowed(PIX, false))
        .to.emit(integrator, "CurrencyAllowlistUpdated")
        .withArgs(PIX, false);
      expect(await integrator.allowedCurrency(PIX)).to.equal(false);
      await expect(place(user, 1, PIX)).to.be.revertedWithCustomError(
        integrator,
        "CurrencyNotAllowed"
      );
    });
  });

  describe("Cancellation", function () {
    it("does not release the daily-count slot on cancel", async function () {
      await place(user, 1);
      expect(await integrator.getTodayCount(user.address)).to.equal(1);
      await mockDiamond.simulateOrderCancelled(1);
      expect(await integrator.getTodayCount(user.address)).to.equal(1);
      expect((await integrator.getSession(1)).cancelled).to.equal(true);
    });

    it("does not release the slot when the cancel callback never fires", async function () {
      await place(user, 1);
      await mockDiamond.simulateOrderCancelledNoCallback(1);
      expect(await integrator.getTodayCount(user.address)).to.equal(1);
    });

    it("completes a cancelled-and-reopened order (bug 4.1)", async function () {
      await place(user, 2);
      const before = await mockUsdc.balanceOf(treasury.address);

      await mockDiamond.simulateOrderCancelled(1);
      expect((await integrator.getSession(1)).cancelled).to.equal(true);
      expect(await integrator.getTodayCount(user.address)).to.equal(1);

      // A CANCELLED BUY is not terminal: the protocol can re-open it and
      // complete it. Premium must still be granted and the Safe must be paid.
      await expect(mockDiamond.simulateOrderComplete(1))
        .to.emit(integrator, "BlioOrderCompleted")
        .withArgs(1, user.address, PRODUCT_ID, 2, USDC(20));

      expect(await mockUsdc.balanceOf(treasury.address)).to.equal(before + USDC(20));
      const session = await integrator.getSession(1);
      expect(session.fulfilled).to.equal(true);
      expect(session.cancelled).to.equal(true);
      expect(await integrator.getTodayCount(user.address)).to.equal(1);
    });

    it("rejects a cancel after completion at the Diamond", async function () {
      await place(user, 1);
      await mockDiamond.simulateOrderComplete(1);
      // second completion reverts at the Diamond (already completed)
      await expect(mockDiamond.simulateOrderComplete(1)).to.be.reverted;
    });
  });

  describe("No vault or affiliate surface", function () {
    it("exposes no affiliate or vault functions in the ABI", async function () {
      const names = integrator.interface.fragments
        .filter((f: any) => f.type === "function")
        .map((f: any) => f.name);
      for (const forbidden of [
        "affiliate",
        "affiliateBps",
        "setAffiliate",
        "distribute",
        "sweep",
        "vault",
      ]) {
        expect(names).to.not.include(forbidden);
      }
    });

    it("has no vault source and no affiliate code", async function () {
      const dir = path.join(__dirname, "..", "contracts", "integrators", "blio");
      const src = fs.readFileSync(path.join(dir, "BlioCheckoutIntegrator.sol"), "utf8");
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      expect(code).to.not.match(/affiliate/i);
      expect(fs.existsSync(path.join(dir, "BlioTreasuryVault.sol"))).to.equal(false);
    });
  });

  describe("Access control", function () {
    it("onOrderComplete is onlyDiamond", async function () {
      await place(user, 1);
      await expect(
        integrator.connect(user).onOrderComplete(1, user.address, PRODUCT_PRICE, treasury.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
    });

    it("onOrderCancel is onlyDiamond", async function () {
      await place(user, 1);
      await expect(integrator.connect(user).onOrderCancel(1)).to.be.revertedWithCustomError(
        integrator,
        "OnlyDiamond"
      );
    });

    it("admin functions are onlyOwner", async function () {
      await expect(
        integrator.connect(user).setProductPrice(2, USDC(1))
      ).to.be.revertedWithCustomError(integrator, "OwnableUnauthorizedAccount");
      await expect(integrator.connect(user).pause()).to.be.revertedWithCustomError(
        integrator,
        "OwnableUnauthorizedAccount"
      );
      await expect(
        integrator.connect(user).sweepUsdc(user.address, 1)
      ).to.be.revertedWithCustomError(integrator, "OwnableUnauthorizedAccount");
    });

    it("renounceOwnership is disabled", async function () {
      await expect(integrator.renounceOwnership()).to.be.revertedWithCustomError(
        integrator,
        "RenounceDisabled"
      );
    });

    it("constructor rejects zero addresses", async function () {
      const I = await ethers.getContractFactory("BlioCheckoutIntegrator");
      const d = await mockDiamond.getAddress();
      const u = await mockUsdc.getAddress();
      await expect(
        I.deploy(
          ethers.ZeroAddress,
          u,
          treasury.address,
          owner.address,
          DAILY_COUNT_LIMIT,
          livenessSigner.address,
          kycSigner.address
        )
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      await expect(
        I.deploy(
          d,
          ethers.ZeroAddress,
          treasury.address,
          owner.address,
          DAILY_COUNT_LIMIT,
          livenessSigner.address,
          kycSigner.address
        )
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      await expect(
        I.deploy(
          d,
          u,
          ethers.ZeroAddress,
          owner.address,
          DAILY_COUNT_LIMIT,
          livenessSigner.address,
          kycSigner.address
        )
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      await expect(
        I.deploy(
          d,
          u,
          treasury.address,
          ethers.ZeroAddress,
          DAILY_COUNT_LIMIT,
          livenessSigner.address,
          kycSigner.address
        )
      ).to.be.revertedWithCustomError(integrator, "OwnableInvalidOwner");
      await expect(
        I.deploy(
          d,
          u,
          treasury.address,
          owner.address,
          DAILY_COUNT_LIMIT,
          ethers.ZeroAddress,
          kycSigner.address
        )
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      await expect(
        I.deploy(
          d,
          u,
          treasury.address,
          owner.address,
          DAILY_COUNT_LIMIT,
          livenessSigner.address,
          ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      await expect(
        I.deploy(
          d,
          u,
          treasury.address,
          owner.address,
          DAILY_COUNT_LIMIT,
          livenessSigner.address,
          livenessSigner.address
        )
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    });
  });

  describe("Mis-registration defence", function () {
    it("flags SettlementRoutingAnomaly when USDC is routed to the integrator", async function () {
      await mockDiamond.setUsdcThroughIntegrator(true);
      await place(user, 1);

      await expect(mockDiamond.simulateOrderComplete(1)).to.emit(
        integrator,
        "SettlementRoutingAnomaly"
      );
      // Not marked fulfilled: the settlement did not reach the treasury.
      expect((await integrator.getSession(1)).fulfilled).to.equal(false);
    });
  });

  describe("Recovery", function () {
    it("owner can sweep stray USDC", async function () {
      await mockUsdc.mint(await integrator.getAddress(), USDC(5));
      await expect(integrator.sweepUsdc(owner.address, USDC(5)))
        .to.emit(integrator, "UsdcSwept")
        .withArgs(owner.address, USDC(5));
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(0n);
    });
  });

  describe("Attestation gate", function () {
    it("records the signed liveness tier, spends the nullifier and applies its limits", async function () {
      const a = await signLiveness({ wallet: user2.address });

      await expect(submitLiveness(user2, a))
        .to.emit(integrator, "AttestationSubmitted")
        .withArgs(user2.address, TIER_LIVENESS, a.nullifier);

      expect(await integrator.tierOf(user2.address)).to.equal(TIER_LIVENESS);
      expect(await integrator.attestedAt(user2.address)).to.be.greaterThan(0);
      expect(await integrator.nullifierWallet(a.nullifier)).to.equal(user2.address);
      expect(await integrator.userTxLimitFor(user2.address, INR)).to.equal(USDC(20));
      expect(await integrator.userTxLimitFor(user2.address, BRL)).to.equal(USDC(50));
    });

    it("applies the passport limits for INR and for the rest", async function () {
      await attest(user2, TIER_PASSPORT);

      expect(await integrator.tierOf(user2.address)).to.equal(TIER_PASSPORT);
      expect(await integrator.userTxLimitFor(user2.address, INR)).to.equal(USDC(100));
      expect(await integrator.userTxLimitFor(user2.address, BRL)).to.equal(USDC(200));
      // 10 units × 10 USDC = 100 USDC lands exactly on the passport/INR cap.
      await expect(place(user2, 10, INR)).to.not.be.reverted;
    });

    it("accepts each service's attestor only in its own flow", async function () {
      const liveness = await signLiveness({ wallet: user2.address });
      await expect(submitLiveness(user2, liveness)).to.not.be.reverted;
      expect(await integrator.tierOf(user2.address)).to.equal(TIER_LIVENESS);

      const kyc = await signKyc({ wallet: user2.address });
      // The KYC signature can be relayed: `wallet`, not `msg.sender`, is bound.
      await expect(submitKyc(owner, kyc)).to.emit(integrator, "AttestationSubmitted");
      expect(await integrator.tierOf(user2.address)).to.equal(TIER_PASSPORT);
    });

    it("rejects a liveness signature made with the KYC key", async function () {
      const a = await signLiveness({ wallet: user2.address, signer: kycSigner });
      await expect(submitLiveness(user2, a)).to.be.revertedWithCustomError(
        integrator,
        "InvalidSignature"
      );
      expect(await integrator.tierOf(user2.address)).to.equal(0n);
    });

    it("rejects a KYC signature made with the liveness key", async function () {
      const a = await signKyc({ wallet: user2.address, signer: livenessSigner });
      await expect(submitKyc(user2, a)).to.be.revertedWithCustomError(
        integrator,
        "InvalidSignature"
      );
      expect(await integrator.tierOf(user2.address)).to.equal(0n);
    });

    it("rejects a crossed type/domain (KYC struct under the LivenessVerifier domain)", async function () {
      const a = await signKyc({
        wallet: user2.address,
        signer: livenessSigner,
        domain: { name: "LivenessVerifier" },
      });
      await expect(submitLiveness(user2, a as any)).to.be.revertedWithCustomError(
        integrator,
        "InvalidSignature"
      );
    });

    it("rejects a signature from another key", async function () {
      const a = await signLiveness({ wallet: user2.address, signer: outsider });
      await expect(submitLiveness(user2, a)).to.be.revertedWithCustomError(
        integrator,
        "InvalidSignature"
      );
      expect(await integrator.tierOf(user2.address)).to.equal(0n);
    });

    it("rejects a signature for the wrong chainId", async function () {
      const a = await signLiveness({
        wallet: user2.address,
        domain: { chainId: 999999 },
      });
      await expect(submitLiveness(user2, a)).to.be.revertedWithCustomError(
        integrator,
        "InvalidSignature"
      );
    });

    it("rejects a signature for the wrong verifyingContract", async function () {
      const a = await signKyc({
        wallet: user2.address,
        domain: { verifyingContract: treasury.address },
      });
      await expect(submitKyc(user2, a)).to.be.revertedWithCustomError(
        integrator,
        "InvalidSignature"
      );
    });

    it("accepts a short-lived claim: expiry = now + 1 hour with a fixed nullifier", async function () {
      const t = await now();
      const a = await signKyc({ wallet: user2.address, expiry: t + 3600n });

      await expect(submitKyc(user2, a)).to.emit(integrator, "AttestationSubmitted");
      expect(await integrator.tierOf(user2.address)).to.equal(TIER_PASSPORT);
      expect(await integrator.nullifierWallet(a.nullifier)).to.equal(user2.address);
    });

    it("allows re-attesting with the same wallet and nullifier after the TTL, renewing expiresAt", async function () {
      const a = await attest(user2, TIER_LIVENESS);
      const firstExpiresAt = await integrator.attestationExpiresAt(user2.address);

      await ethers.provider.send("evm_increaseTime", [180 * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      expect(await integrator.userTxLimitFor(user2.address, INR)).to.equal(0n);
      await expect(place(user2, 1, INR)).to.be.revertedWithCustomError(integrator, "NotAttested");

      const reattest = await signLiveness({ wallet: user2.address, nullifier: a.nullifier });
      await expect(submitLiveness(user2, reattest)).to.emit(integrator, "AttestationSubmitted");

      const renewedExpiresAt = await integrator.attestationExpiresAt(user2.address);
      const renewedAttestedAt = await integrator.attestedAt(user2.address);
      expect(renewedExpiresAt).to.equal(renewedAttestedAt + (await integrator.ATTESTATION_TTL()));
      expect(renewedExpiresAt).to.be.greaterThan(firstExpiresAt);
      expect(await integrator.userTxLimitFor(user2.address, INR)).to.equal(USDC(20));
    });

    it("reverts NullifierUsed when another wallet reuses the same nullifier", async function () {
      const first = await signLiveness({ wallet: user2.address });
      await submitLiveness(user2, first);

      const replay = await signKyc({ wallet: user.address, nullifier: first.nullifier });
      await expect(submitKyc(user, replay)).to.be.revertedWithCustomError(
        integrator,
        "NullifierUsed"
      );
      expect(await integrator.nullifierWallet(first.nullifier)).to.equal(user2.address);
      expect(await integrator.tierOf(user.address)).to.equal(TIER_LIVENESS);
    });

    it("upgrades liveness to passport with the same wallet and nullifier, raising the limit", async function () {
      const first = await signLiveness({ wallet: user2.address });
      await submitLiveness(user2, first);
      expect(await integrator.userTxLimitFor(user2.address, INR)).to.equal(USDC(20));
      expect(await integrator.userTxLimitFor(user2.address, BRL)).to.equal(USDC(50));

      const upgrade = await signKyc({ wallet: user2.address, nullifier: first.nullifier });
      await expect(submitKyc(user2, upgrade)).to.emit(integrator, "AttestationSubmitted");

      expect(await integrator.tierOf(user2.address)).to.equal(TIER_PASSPORT);
      expect(await integrator.userTxLimitFor(user2.address, INR)).to.equal(USDC(100));
      expect(await integrator.userTxLimitFor(user2.address, BRL)).to.equal(USDC(200));
    });

    it("reverts AttestationExpired when the signed expiry has already passed", async function () {
      const a = await signKyc({ wallet: user2.address, expiry: (await now()) - 60n });
      await expect(submitKyc(user2, a)).to.be.revertedWithCustomError(
        integrator,
        "AttestationExpired"
      );
    });

    it("reverts DeadlineTooFar past the 2-hour cap", async function () {
      const t = await now();
      // Pin the next block to t+1 so `expiry = t+7202` is exactly one second
      // beyond `block.timestamp + MAX_ATTESTATION_DEADLINE`.
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(t) + 1]);
      const a = await signKyc({ wallet: user2.address, expiry: t + 7202n });
      await expect(submitKyc(user2, a)).to.be.revertedWithCustomError(integrator, "DeadlineTooFar");
      expect(await integrator.tierOf(user2.address)).to.equal(0n);
    });

    it("accepts a KYC expiry within the cap", async function () {
      const a = await signKyc({ wallet: user2.address, expiry: (await now()) + 600n });
      await expect(submitKyc(user2, a)).to.not.be.reverted;
      expect(await integrator.tierOf(user2.address)).to.equal(TIER_PASSPORT);
    });

    it("outlives the signed claim expiry: the grant lasts ATTESTATION_TTL", async function () {
      const claimExpiry = (await now()) + 600n;
      const a = await signKyc({ wallet: user2.address, expiry: claimExpiry });
      await submitKyc(user2, a);

      const attestedAt = await integrator.attestedAt(user2.address);
      const expiresAt = await integrator.attestationExpiresAt(user2.address);
      expect(expiresAt).to.equal(attestedAt + (await integrator.ATTESTATION_TTL()));
      expect(expiresAt).to.be.greaterThan(claimExpiry);
      await expect(place(user2, 1, INR)).to.not.be.reverted;

      await ethers.provider.send("evm_increaseTime", [601]);
      await ethers.provider.send("evm_mine", []);

      // The claim deadline passed, but the recorded tier is still usable.
      expect(await integrator.tierOf(user2.address)).to.equal(TIER_PASSPORT);
      expect(await integrator.userTxLimitFor(user2.address, INR)).to.equal(USDC(100));
      await expect(place(user2, 1, INR)).to.not.be.reverted;
    });

    it("expires the grant at ATTESTATION_TTL regardless of the claim expiry", async function () {
      await attest(user2, TIER_LIVENESS);
      expect(await integrator.userTxLimitFor(user2.address, INR)).to.equal(USDC(20));

      await ethers.provider.send("evm_increaseTime", [180 * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);

      // Raw tier is still stored, but the gate treats it as None.
      expect(await integrator.tierOf(user2.address)).to.equal(TIER_LIVENESS);
      expect(await integrator.userTxLimitFor(user2.address, INR)).to.equal(0n);
      await expect(place(user2, 1, INR)).to.be.revertedWithCustomError(integrator, "NotAttested");
    });

    it("clamps a KYC limit above policy to 100/200", async function () {
      await attest(user2, TIER_PASSPORT, { limit: USDC(500) });

      expect(await integrator.attestedLimit(user2.address)).to.equal(USDC(500));
      expect(await integrator.userTxLimitFor(user2.address, INR)).to.equal(USDC(100));
      expect(await integrator.userTxLimitFor(user2.address, BRL)).to.equal(USDC(200));
      await expect(place(user2, 11, INR)).to.be.revertedWithCustomError(
        integrator,
        "AmountExceedsLimit"
      );
      await expect(place(user2, 21, BRL)).to.be.revertedWithCustomError(
        integrator,
        "AmountExceedsLimit"
      );
    });

    it("respects a KYC limit below policy", async function () {
      await attest(user2, TIER_PASSPORT, { limit: USDC(30) });

      expect(await integrator.userTxLimitFor(user2.address, INR)).to.equal(USDC(30));
      expect(await integrator.userTxLimitFor(user2.address, BRL)).to.equal(USDC(30));
      await expect(place(user2, 3, INR)).to.not.be.reverted;
      await expect(place(user2, 4, INR)).to.be.revertedWithCustomError(
        integrator,
        "AmountExceedsLimit"
      );
    });

    it("treats a zero KYC limit as 'use the policy'", async function () {
      await attest(user2, TIER_PASSPORT, { limit: 0n });
      expect(await integrator.userTxLimitFor(user2.address, INR)).to.equal(USDC(100));
      expect(await integrator.userTxLimitFor(user2.address, BRL)).to.equal(USDC(200));
    });

    it("also clamps a liveness limit to its policy ceiling", async function () {
      await attest(user2, TIER_LIVENESS, { limit: USDC(999) });
      expect(await integrator.userTxLimitFor(user2.address, INR)).to.equal(USDC(20));
      expect(await integrator.userTxLimitFor(user2.address, BRL)).to.equal(USDC(50));

      await attest(user2, TIER_LIVENESS, { limit: USDC(5) });
      expect(await integrator.userTxLimitFor(user2.address, INR)).to.equal(USDC(5));
    });

    it("rejects a downgrade from Passport to Liveness", async function () {
      await attest(user2, TIER_PASSPORT);

      const down = await signLiveness({ wallet: user2.address });
      await expect(submitLiveness(user2, down)).to.be.revertedWithCustomError(
        integrator,
        "TierDowngrade"
      );
      expect(await integrator.tierOf(user2.address)).to.equal(TIER_PASSPORT);
      // A rejected downgrade must not burn the nullifier.
      expect(await integrator.nullifierWallet(down.nullifier)).to.equal(ethers.ZeroAddress);
    });

    it("blocks an order from an unattested address", async function () {
      await expect(place(user2, 1)).to.be.revertedWithCustomError(integrator, "NotAttested");
    });

    it("lets a relayer submit the KYC attestor's signature for the buyer", async function () {
      const a = await signKyc({ wallet: user2.address });
      await expect(submitKyc(owner, a)).to.emit(integrator, "AttestationSubmitted");
      expect(await integrator.tierOf(user2.address)).to.equal(TIER_PASSPORT);
    });

    it("exposes the two EIP-712 domains the attestors sign under", async function () {
      expect(await integrator.livenessDomainSeparator()).to.equal(
        ethers.TypedDataEncoder.hashDomain(await livenessDomain())
      );
      expect(await integrator.kycDomainSeparator()).to.equal(
        ethers.TypedDataEncoder.hashDomain(await kycDomain())
      );
      expect(await integrator.livenessDomainSeparator()).to.not.equal(
        await integrator.kycDomainSeparator()
      );
    });
  });

  describe("Cancel callback disabled", function () {
    it("completes an order cancelled without onOrderCancel and still grants Premium", async function () {
      // The real Diamond reports cancelCallbackEnabled = false by default, so a
      // cancellation is visible only protocol-side. Premium must still be
      // granted when the order is later reopened and completed.
      const cfg = await mockDiamond.getIntegratorConfig(await integrator.getAddress());
      expect(cfg.cancelCallbackEnabled).to.equal(false);

      await place(user, 2);
      const before = await mockUsdc.balanceOf(treasury.address);

      await mockDiamond.simulateOrderCancelledNoCallback(1);

      // No callback: the integrator never learned about the cancellation.
      expect((await integrator.getSession(1)).cancelled).to.equal(false);
      expect(await integrator.getTodayCount(user.address)).to.equal(1);

      await expect(mockDiamond.simulateOrderComplete(1))
        .to.emit(integrator, "BlioOrderCompleted")
        .withArgs(1, user.address, PRODUCT_ID, 2, USDC(20));

      expect(await mockUsdc.balanceOf(treasury.address)).to.equal(before + USDC(20));
      expect((await integrator.getSession(1)).fulfilled).to.equal(true);
      expect(await integrator.getTodayCount(user.address)).to.equal(1);
    });
  });

  describe("Treasury as a contract", function () {
    it("delivers the USDC to a Safe-like contract with code", async function () {
      const Safe = await ethers.getContractFactory("MockSafe");
      const safe = await Safe.deploy([owner.address], 1);
      const safeAddr = await safe.getAddress();

      const I = await ethers.getContractFactory("BlioCheckoutIntegrator");
      const safeIntegrator = await I.deploy(
        await mockDiamond.getAddress(),
        await mockUsdc.getAddress(),
        safeAddr,
        owner.address,
        DAILY_COUNT_LIMIT,
        livenessSigner.address,
        kycSigner.address
      );
      await mockDiamond.registerIntegrator(
        await safeIntegrator.getAddress(),
        await safeIntegrator.proxyImpl()
      );
      await safeIntegrator.setProductPrice(PRODUCT_ID, PRODUCT_PRICE);
      await safeIntegrator.setProductActive(PRODUCT_ID, true);

      integrator = safeIntegrator;
      await attest(user);

      expect((await ethers.provider.getCode(safeAddr)).length).to.be.greaterThan(2);
      const before = await mockUsdc.balanceOf(safeAddr);

      await place(user, 2);
      await expect(mockDiamond.simulateOrderComplete(1))
        .to.emit(integrator, "BlioOrderCompleted")
        .withArgs(1, user.address, PRODUCT_ID, 2, USDC(20));

      expect(await mockUsdc.balanceOf(safeAddr)).to.equal(before + USDC(20));
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(0n);
    });
  });

  describe("Attestation gate coverage", function () {
    it("rejects a placement from an unattested buyer before validateOrder runs", async function () {
      await expect(place(user2, 1)).to.be.revertedWithCustomError(integrator, "NotAttested");
      expect(await integrator.getTodayCount(user2.address)).to.equal(0);
      expect(await integrator.tierOf(user2.address)).to.equal(0n);
    });

    it("returns false from validateOrder when no placement is in flight", async function () {
      const diamondAddr = await mockDiamond.getAddress();
      await ethers.provider.send("hardhat_setBalance", [diamondAddr, "0x56BC75E2D63100000"]);
      const diamondSigner = await ethers.getImpersonatedSigner(diamondAddr);

      // `_pendingPlacement` is empty here, so the guard short-circuits to
      // false. The NotAttested branch inside validateOrder is shadowed by
      // userPlaceOrder's own pre-check; this documents that ordering.
      expect(
        await integrator
          .connect(diamondSigner)
          .validateOrder.staticCall(user2.address, USDC(10), INR)
      ).to.equal(false);
    });

    it("rejects a nullifier reused by another wallet and a signature from another key", async function () {
      const first = await signLiveness({ wallet: user2.address });
      await submitLiveness(user2, first);

      const replay = await signKyc({ wallet: user.address, nullifier: first.nullifier });
      await expect(submitKyc(user, replay)).to.be.revertedWithCustomError(
        integrator,
        "NullifierUsed"
      );

      const wrongKey = await signLiveness({ wallet: user2.address, signer: outsider });
      await expect(submitLiveness(user2, wrongKey)).to.be.revertedWithCustomError(
        integrator,
        "InvalidSignature"
      );
      expect(await integrator.tierOf(user2.address)).to.equal(TIER_LIVENESS);
    });
  });

  describe("Limits coverage", function () {
    it("enforces INR and other-currency caps for multi-unit orders at liveness", async function () {
      await expect(place(user, 2, INR)).to.not.be.reverted; // 2 × 10 = 20, cap
      await expect(place(user, 3, INR)).to.be.revertedWithCustomError(
        integrator,
        "AmountExceedsLimit"
      );
      await expect(place(user, 5, BRL)).to.not.be.reverted; // 5 × 10 = 50, cap
      await expect(place(user, 6, BRL)).to.be.revertedWithCustomError(
        integrator,
        "AmountExceedsLimit"
      );
      expect(await integrator.getTodayCount(user.address)).to.equal(2);
    });

    it("enforces INR and other-currency caps for multi-unit orders at passport", async function () {
      await attest(user2, TIER_PASSPORT);

      await expect(place(user2, 10, INR)).to.not.be.reverted; // 100, cap
      await expect(place(user2, 11, INR)).to.be.revertedWithCustomError(
        integrator,
        "AmountExceedsLimit"
      );
      await expect(place(user2, 20, BRL)).to.not.be.reverted; // 200, cap
      await expect(place(user2, 21, BRL)).to.be.revertedWithCustomError(
        integrator,
        "AmountExceedsLimit"
      );
      expect(await integrator.getTodayCount(user2.address)).to.equal(2);
    });

    it("rejects the sixth placement even with quantity 1", async function () {
      for (let i = 0; i < DAILY_COUNT_LIMIT; i++) await place(user, 1);

      await expect(place(user, 1)).to.be.revertedWithCustomError(integrator, "DailyCountExceeded");
      expect(await integrator.getTodayCount(user.address)).to.equal(DAILY_COUNT_LIMIT);
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(0n);
    });
  });

  describe("Reentrancy", function () {
    it("userPlaceOrder is nonReentrant against a hostile Diamond", async function () {
      const D = await ethers.getContractFactory("ReentrantBlioDiamond");
      const hostile = await D.deploy();

      const I = await ethers.getContractFactory("BlioCheckoutIntegrator");
      const guarded = await I.deploy(
        await hostile.getAddress(),
        await mockUsdc.getAddress(),
        treasury.address,
        owner.address,
        DAILY_COUNT_LIMIT,
        livenessSigner.address,
        kycSigner.address
      );
      await guarded.setProductPrice(PRODUCT_ID, PRODUCT_PRICE);
      await guarded.setProductActive(PRODUCT_ID, true);

      integrator = guarded;
      await attest(user);
      await hostile.configure(await integrator.getAddress(), true);

      await expect(place(user, 1)).to.not.be.reverted;

      expect(await hostile.reentryAttempted()).to.equal(true);
      expect(await hostile.reentrySucceeded()).to.equal(false);
      expect(await hostile.reentryError()).to.equal(
        ethers.id("ReentrancyGuardReentrantCall()").slice(0, 10)
      );
      expect((await integrator.getSession(1)).user).to.equal(user.address);
      expect(await integrator.getTodayCount(user.address)).to.equal(1);
    });

    it("onOrderComplete is idempotent for an already fulfilled order", async function () {
      await place(user, 1);
      await mockDiamond.simulateOrderComplete(1);

      await expect(
        mockDiamond.adminCallOnOrderComplete(
          await integrator.getAddress(),
          1,
          user.address,
          USDC(10),
          treasury.address
        )
      ).to.not.emit(integrator, "BlioOrderCompleted");
    });
  });

  describe("Deployment footprint", function () {
    it("stays under EIP-170 and reports placement gas", async function () {
      const art = require("../artifacts/contracts/integrators/blio/BlioCheckoutIntegrator.sol/BlioCheckoutIntegrator.json");
      const size = (art.deployedBytecode.length - 2) / 2;
      console.log(`      BlioCheckoutIntegrator deployment size: ${size} bytes`);
      expect(size).to.be.lessThan(24576);

      const first = await place(user, 1, INR);
      const firstReceipt = await first.wait();
      console.log(`      userPlaceOrder gas (first, deploys UserProxy): ${firstReceipt!.gasUsed}`);

      const second = await place(user, 1, BRL);
      const secondReceipt = await second.wait();
      console.log(`      userPlaceOrder gas (subsequent): ${secondReceipt!.gasUsed}`);
      expect(firstReceipt!.gasUsed).to.be.greaterThan(0);
    });
  });
});
