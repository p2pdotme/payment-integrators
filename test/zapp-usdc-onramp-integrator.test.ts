import { expect } from "chai";
import { ethers, network } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("ZappUsdcOnrampIntegrator", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let user2: SignerWithAddress;
  let authorizationSigner: SignerWithAddress;
  let replacementSigner: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let integrator: any;
  let integratorAddress: string;
  let chainId: bigint;
  let nonceSequence: number;

  const USDC = (value: number | string) => ethers.parseUnits(value.toString(), 6);
  const INR = ethers.encodeBytes32String("INR");
  const PER_TX_LIMIT = USDC(100);
  const DAILY_COUNT_LIMIT = 2n;
  const DAILY_VOLUME_LIMIT = USDC(150);
  const LIFETIME_VOLUME_LIMIT = USDC(200);
  const PUB_KEY = "zapp-p2p-encryption-key";

  const authorizationTypes = {
    PurchaseAuthorization: [
      { name: "user", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "currency", type: "bytes32" },
      { name: "pubKeyHash", type: "bytes32" },
      { name: "circleId", type: "uint256" },
      { name: "preferredPaymentChannelConfigId", type: "uint256" },
      { name: "fiatAmountLimit", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  };

  async function timestamp(): Promise<bigint> {
    return BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  }

  async function deployIntegrator(
    signer = authorizationSigner.address,
    perTxLimit = PER_TX_LIMIT,
    dailyCountLimit = DAILY_COUNT_LIMIT,
    dailyVolumeLimit = DAILY_VOLUME_LIMIT,
    lifetimeVolumeLimit = LIFETIME_VOLUME_LIMIT
  ) {
    const Integrator = await ethers.getContractFactory("ZappUsdcOnrampIntegrator");
    const deployed = await Integrator.deploy(
      await mockDiamond.getAddress(),
      await mockUsdc.getAddress(),
      owner.address,
      signer,
      perTxLimit,
      dailyCountLimit,
      dailyVolumeLimit,
      lifetimeVolumeLimit
    );
    await mockDiamond.registerIntegrator(await deployed.getAddress(), await deployed.proxyImpl());
    return deployed;
  }

  async function buildAuthorization(overrides: Record<string, unknown> = {}) {
    nonceSequence += 1;
    return {
      user: user.address,
      amount: USDC(25),
      currency: INR,
      pubKeyHash: ethers.keccak256(ethers.toUtf8Bytes(PUB_KEY)),
      circleId: 1n,
      preferredPaymentChannelConfigId: 7n,
      fiatAmountLimit: 2_500n,
      deadline: (await timestamp()) + 900n,
      nonce: ethers.keccak256(ethers.toUtf8Bytes(`zapp-usdc-${nonceSequence}`)),
      ...overrides,
    };
  }

  async function signAuthorization(
    authorization: Awaited<ReturnType<typeof buildAuthorization>>,
    signer: SignerWithAddress = authorizationSigner,
    verifyingContract = integratorAddress
  ) {
    return signer.signTypedData(
      { name: "ZappUsdcOnramp", version: "1", chainId, verifyingContract },
      authorizationTypes,
      authorization
    );
  }

  async function buy(
    authorization: Awaited<ReturnType<typeof buildAuthorization>>,
    buyer: SignerWithAddress = user,
    signer: SignerWithAddress = authorizationSigner,
    pubKey = PUB_KEY
  ) {
    const signature = await signAuthorization(authorization, signer);
    const id = await integrator.authorizationId(authorization);
    const orderId = await mockDiamond.nextOrderId();
    const tx = await integrator.connect(buyer).buyUsdc(authorization, pubKey, signature);
    return { id, orderId, signature, tx };
  }

  async function impersonateDiamond() {
    const address = await mockDiamond.getAddress();
    await network.provider.send("hardhat_impersonateAccount", [address]);
    await network.provider.send("hardhat_setBalance", [address, "0x56BC75E2D63100000"]);
    return ethers.getSigner(address);
  }

  beforeEach(async function () {
    [owner, user, user2, authorizationSigner, replacementSigner] = await ethers.getSigners();
    chainId = (await ethers.provider.getNetwork()).chainId;
    nonceSequence = 0;

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUsdc = await MockUSDC.deploy();

    const MockDiamond = await ethers.getContractFactory("MockDiamond");
    mockDiamond = await MockDiamond.deploy(await mockUsdc.getAddress());
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(1_000_000));

    integrator = await deployIntegrator();
    integratorAddress = await integrator.getAddress();
  });

  describe("configuration", function () {
    it("pins immutable limits and deploys the canonical proxy implementation", async function () {
      expect(await integrator.diamond()).to.equal(await mockDiamond.getAddress());
      expect(await integrator.usdc()).to.equal(await mockUsdc.getAddress());
      expect(await integrator.owner()).to.equal(owner.address);
      expect(await integrator.authorizationSigner()).to.equal(authorizationSigner.address);
      expect(await integrator.perTxUsdcLimit()).to.equal(PER_TX_LIMIT);
      expect(await integrator.userTxLimit()).to.equal(PER_TX_LIMIT);
      expect(await integrator.dailyTxCountLimit()).to.equal(DAILY_COUNT_LIMIT);
      expect(await integrator.dailyUsdcVolumeLimit()).to.equal(DAILY_VOLUME_LIMIT);
      expect(await integrator.lifetimeUsdcVolumeLimit()).to.equal(LIFETIME_VOLUME_LIMIT);
      expect(await integrator.PURCHASE_AUTHORIZATION_TYPEHASH()).to.equal(
        ethers.id(
          "PurchaseAuthorization(address user,uint256 amount,bytes32 currency,bytes32 pubKeyHash,uint256 circleId,uint256 preferredPaymentChannelConfigId,uint256 fiatAmountLimit,uint256 deadline,bytes32 nonce)"
        )
      );
      expect(await ethers.provider.getCode(await integrator.proxyImpl())).not.to.equal("0x");
    });

    it("rejects zero addresses and inconsistent limits", async function () {
      const Integrator = await ethers.getContractFactory("ZappUsdcOnrampIntegrator");
      const diamond = await mockDiamond.getAddress();
      const usdc = await mockUsdc.getAddress();
      const validAddresses = [diamond, usdc, owner.address, authorizationSigner.address];
      for (let index = 0; index < validAddresses.length; index += 1) {
        const addresses = [...validAddresses];
        addresses[index] = ethers.ZeroAddress;
        await expect(
          Integrator.deploy(
            addresses[0],
            addresses[1],
            addresses[2],
            addresses[3],
            PER_TX_LIMIT,
            DAILY_COUNT_LIMIT,
            DAILY_VOLUME_LIMIT,
            LIFETIME_VOLUME_LIMIT
          )
        ).to.be.revertedWithCustomError(Integrator, "InvalidAddress");
      }

      const invalidLimits = [
        [0n, DAILY_COUNT_LIMIT, DAILY_VOLUME_LIMIT, LIFETIME_VOLUME_LIMIT],
        [PER_TX_LIMIT, 0n, DAILY_VOLUME_LIMIT, LIFETIME_VOLUME_LIMIT],
        [USDC(151), DAILY_COUNT_LIMIT, DAILY_VOLUME_LIMIT, LIFETIME_VOLUME_LIMIT],
        [PER_TX_LIMIT, DAILY_COUNT_LIMIT, DAILY_VOLUME_LIMIT, USDC(149)],
      ];
      for (const limits of invalidLimits) {
        await expect(
          Integrator.deploy(
            diamond,
            usdc,
            owner.address,
            authorizationSigner.address,
            limits[0],
            limits[1],
            limits[2],
            limits[3]
          )
        ).to.be.revertedWithCustomError(Integrator, "InvalidLimit");
      }
    });

    it("gates signer rotation and pause controls on the owner", async function () {
      await expect(
        integrator.connect(user).setAuthorizationSigner(replacementSigner.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
      await expect(
        integrator.connect(owner).setAuthorizationSigner(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      await expect(integrator.connect(user).pause()).to.be.revertedWithCustomError(
        integrator,
        "OnlyOwner"
      );
      await expect(integrator.connect(owner).unpause()).not.to.emit(integrator, "Unpaused");
      await expect(integrator.connect(owner).pause()).to.emit(integrator, "Paused");
      await expect(integrator.connect(owner).pause()).not.to.emit(integrator, "Paused");
      await expect(integrator.connect(user).unpause()).to.be.revertedWithCustomError(
        integrator,
        "OnlyOwner"
      );
      await expect(integrator.connect(owner).unpause()).to.emit(integrator, "Unpaused");
    });
  });

  describe("direct settlement", function () {
    it("binds user and recipient to the caller and sends USDC directly there", async function () {
      const authorization = await buildAuthorization({ amount: USDC(50) });
      const { id, orderId, tx } = await buy(authorization);

      await expect(tx)
        .to.emit(integrator, "UsdcOnrampOrderCreated")
        .withArgs(orderId, user.address, USDC(50), INR, id);

      const order = await mockDiamond.orders(orderId);
      expect(order.user).to.equal(user.address);
      expect(order.recipientAddr).to.equal(user.address);
      expect(await mockUsdc.balanceOf(integratorAddress)).to.equal(0n);
      expect(await mockUsdc.balanceOf(await integrator.proxyAddress(user.address))).to.equal(0n);

      await expect(mockDiamond.simulateOrderComplete(orderId))
        .to.emit(integrator, "UsdcOnrampOrderFulfilled")
        .withArgs(orderId, user.address, USDC(50), id);

      expect(await mockUsdc.balanceOf(user.address)).to.equal(USDC(50));
      expect(await mockUsdc.balanceOf(integratorAddress)).to.equal(0n);
      expect(await mockUsdc.balanceOf(await integrator.proxyAddress(user.address))).to.equal(0n);
    });

    it("works when the caller and recipient are a contract smart account", async function () {
      const SmartAccount = await ethers.getContractFactory("MockSmartAccount");
      const smartAccount = await SmartAccount.deploy(user.address);
      const smartAccountAddress = await smartAccount.getAddress();
      const authorization = await buildAuthorization({
        user: smartAccountAddress,
        amount: USDC(40),
      });
      const signature = await signAuthorization(authorization);
      const id = await integrator.authorizationId(authorization);
      const orderId = await mockDiamond.nextOrderId();
      const calldata = integrator.interface.encodeFunctionData("buyUsdc", [
        authorization,
        PUB_KEY,
        signature,
      ]);

      const tx = await smartAccount.connect(user).execute(integratorAddress, calldata);
      await expect(tx)
        .to.emit(integrator, "UsdcOnrampOrderCreated")
        .withArgs(orderId, smartAccountAddress, USDC(40), INR, id);

      const order = await mockDiamond.orders(orderId);
      expect(order.user).to.equal(smartAccountAddress);
      expect(order.recipientAddr).to.equal(smartAccountAddress);

      await mockDiamond.simulateOrderComplete(orderId);
      expect(await mockUsdc.balanceOf(smartAccountAddress)).to.equal(USDC(40));
      expect(await mockUsdc.balanceOf(user.address)).to.equal(0n);
    });
  });

  describe("authorization", function () {
    it("rejects an authorization issued for a different caller", async function () {
      const authorization = await buildAuthorization({ user: user2.address });
      const signature = await signAuthorization(authorization);
      await expect(
        integrator.connect(user).buyUsdc(authorization, PUB_KEY, signature)
      ).to.be.revertedWithCustomError(integrator, "InvalidAuthorization");
    });

    it("rejects altered order parameters and public-key substitution", async function () {
      const authorization = await buildAuthorization();
      const signature = await signAuthorization(authorization);

      await expect(
        integrator.connect(user).buyUsdc({ ...authorization, circleId: 2n }, PUB_KEY, signature)
      ).to.be.revertedWithCustomError(integrator, "InvalidAuthorizationSignature");

      await expect(
        integrator.connect(user).buyUsdc(authorization, "different-key", signature)
      ).to.be.revertedWithCustomError(integrator, "InvalidAuthorization");
    });

    it("rejects malformed authorization fields before placement", async function () {
      const invalidCases: Array<{
        authorization: Awaited<ReturnType<typeof buildAuthorization>>;
        pubKey?: string;
        error: string;
      }> = [
        {
          authorization: await buildAuthorization({ currency: ethers.ZeroHash }),
          error: "InvalidAuthorization",
        },
        {
          authorization: await buildAuthorization({ circleId: 0n }),
          error: "InvalidAuthorization",
        },
        { authorization: await buildAuthorization(), pubKey: "", error: "InvalidAuthorization" },
        {
          authorization: await buildAuthorization({ nonce: ethers.ZeroHash }),
          error: "InvalidAuthorization",
        },
        { authorization: await buildAuthorization({ amount: 0n }), error: "InvalidAmount" },
      ];

      for (const testCase of invalidCases) {
        const signature = await signAuthorization(testCase.authorization);
        await expect(
          integrator
            .connect(user)
            .buyUsdc(testCase.authorization, testCase.pubKey ?? PUB_KEY, signature)
        ).to.be.revertedWithCustomError(integrator, testCase.error);
      }
    });

    it("rejects a wrong signer and malformed signatures", async function () {
      const authorization = await buildAuthorization();
      await expect(
        integrator
          .connect(user)
          .buyUsdc(
            authorization,
            PUB_KEY,
            await signAuthorization(authorization, replacementSigner)
          )
      ).to.be.revertedWithCustomError(integrator, "InvalidAuthorizationSignature");
      await expect(
        integrator.connect(user).buyUsdc(authorization, PUB_KEY, "0x12")
      ).to.be.revertedWithCustomError(integrator, "InvalidAuthorizationSignature");
    });

    it("rejects expired and replayed authorizations", async function () {
      const expired = await buildAuthorization({ deadline: (await timestamp()) - 1n });
      const expiredSignature = await signAuthorization(expired);
      await expect(
        integrator.connect(user).buyUsdc(expired, PUB_KEY, expiredSignature)
      ).to.be.revertedWithCustomError(integrator, "AuthorizationExpired");

      const authorization = await buildAuthorization();
      const { signature } = await buy(authorization);
      await expect(
        integrator.connect(user).buyUsdc(authorization, PUB_KEY, signature)
      ).to.be.revertedWithCustomError(integrator, "AuthorizationAlreadyUsed");
    });

    it("rejects reuse of a nonce even with a newly signed payload", async function () {
      const first = await buildAuthorization();
      await buy(first);

      const second = await buildAuthorization({
        amount: USDC(30),
        nonce: first.nonce,
      });
      const secondSignature = await signAuthorization(second);
      await expect(
        integrator.connect(user).buyUsdc(second, PUB_KEY, secondSignature)
      ).to.be.revertedWithCustomError(integrator, "AuthorizationAlreadyUsed");
    });

    it("lets only the owner rotate the signer", async function () {
      await expect(
        integrator.connect(user).setAuthorizationSigner(replacementSigner.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");

      await integrator.connect(owner).setAuthorizationSigner(replacementSigner.address);
      const authorization = await buildAuthorization();
      const oldSignature = await signAuthorization(authorization);
      await expect(
        integrator.connect(user).buyUsdc(authorization, PUB_KEY, oldSignature)
      ).to.be.revertedWithCustomError(integrator, "InvalidAuthorizationSignature");

      await buy(authorization, user, replacementSigner);
    });
  });

  describe("limits and lifecycle", function () {
    it("enforces immutable transaction and daily limits", async function () {
      const tooLarge = await buildAuthorization({ amount: PER_TX_LIMIT + 1n });
      const tooLargeSignature = await signAuthorization(tooLarge);
      await expect(
        integrator.connect(user).buyUsdc(tooLarge, PUB_KEY, tooLargeSignature)
      ).to.be.revertedWithCustomError(integrator, "InvalidAmount");

      await buy(await buildAuthorization({ amount: USDC(75) }));
      await buy(await buildAuthorization({ amount: USDC(75) }));
      const third = await buildAuthorization({ amount: USDC(1) });
      const thirdSignature = await signAuthorization(third);
      await expect(
        integrator.connect(user).buyUsdc(third, PUB_KEY, thirdSignature)
      ).to.be.revertedWithCustomError(integrator, "DailyCountLimitExceeded");
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(0n);
    });

    it("enforces daily volume independently of the daily count", async function () {
      await buy(await buildAuthorization({ amount: USDC(100) }));
      const next = await buildAuthorization({ amount: USDC(51) });
      const signature = await signAuthorization(next);
      await expect(
        integrator.connect(user).buyUsdc(next, PUB_KEY, signature)
      ).to.be.revertedWithCustomError(integrator, "DailyVolumeLimitExceeded");
    });

    it("enforces the lifetime limit across UTC days", async function () {
      await buy(await buildAuthorization({ amount: USDC(100) }));
      await network.provider.send("evm_increaseTime", [86_400]);
      await network.provider.send("evm_mine");
      await buy(await buildAuthorization({ amount: USDC(100) }));
      await network.provider.send("evm_increaseTime", [86_400]);
      await network.provider.send("evm_mine");

      const authorization = await buildAuthorization({ amount: 1n });
      const signature = await signAuthorization(authorization);
      await expect(
        integrator.connect(user).buyUsdc(authorization, PUB_KEY, signature)
      ).to.be.revertedWithCustomError(integrator, "LifetimeVolumeLimitExceeded");
      expect(await integrator.getRemainingLifetimeVolume(user.address)).to.equal(0n);
    });

    it("releases daily and lifetime reservations when an order is cancelled", async function () {
      const first = await buy(await buildAuthorization({ amount: USDC(75) }));
      await buy(await buildAuthorization({ amount: USDC(75) }));
      expect(await integrator.userLifetimeVolume(user.address)).to.equal(USDC(150));

      await mockDiamond.simulateOrderCancelled(first.orderId);
      expect(await integrator.userLifetimeVolume(user.address)).to.equal(USDC(75));
      expect(
        await integrator.userDailyCount(user.address, await timestamp().then((v) => v / 86400n))
      ).to.equal(1n);

      await buy(await buildAuthorization({ amount: USDC(75) }));
      expect(await integrator.userLifetimeVolume(user.address)).to.equal(USDC(150));
    });

    it("zeroes reservations when the only active order is cancelled", async function () {
      const placed = await buy(await buildAuthorization({ amount: USDC(25) }));
      expect(await integrator.getRemainingLifetimeVolume(user.address)).to.equal(USDC(175));
      await mockDiamond.simulateOrderCancelled(placed.orderId);
      expect(await integrator.userLifetimeVolume(user.address)).to.equal(0n);
      expect(
        await integrator.userDailyVolume(user.address, await timestamp().then((v) => v / 86400n))
      ).to.equal(0n);
    });

    it("pauses only new placements and preserves in-flight completion", async function () {
      const placed = await buy(await buildAuthorization());
      await integrator.connect(owner).pause();

      const blocked = await buildAuthorization();
      const blockedSignature = await signAuthorization(blocked);
      await expect(
        integrator.connect(user).buyUsdc(blocked, PUB_KEY, blockedSignature)
      ).to.be.revertedWithCustomError(integrator, "ContractPaused");

      await mockDiamond.simulateOrderComplete(placed.orderId);
      expect((await integrator.getSession(placed.orderId)).fulfilled).to.equal(true);
    });

    it("allows only the Diamond to invoke lifecycle callbacks", async function () {
      await expect(
        integrator.connect(user).onOrderComplete(1, user.address, USDC(25), user.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
      await expect(integrator.connect(user).onOrderCancel(1)).to.be.revertedWithCustomError(
        integrator,
        "OnlyDiamond"
      );
    });

    it("records but does not accept a mismatched completion callback", async function () {
      const placed = await buy(await buildAuthorization());
      const diamondSigner = await impersonateDiamond();
      await expect(
        integrator
          .connect(diamondSigner)
          .onOrderComplete(placed.orderId, user.address, USDC(25), user2.address)
      )
        .to.emit(integrator, "CompletionCallbackMismatch")
        .withArgs(placed.orderId, user.address, user.address, USDC(25), user2.address);
      expect((await integrator.getSession(placed.orderId)).fulfilled).to.equal(false);

      await expect(
        integrator
          .connect(diamondSigner)
          .onOrderComplete(placed.orderId, user2.address, USDC(25), user.address)
      ).to.emit(integrator, "CompletionCallbackMismatch");
      await expect(
        integrator
          .connect(diamondSigner)
          .onOrderComplete(placed.orderId, user.address, USDC(24), user.address)
      ).to.emit(integrator, "CompletionCallbackMismatch");
    });

    it("makes unknown and terminal callbacks idempotent", async function () {
      const diamondSigner = await impersonateDiamond();
      await expect(integrator.connect(diamondSigner).onOrderCancel(999)).not.to.emit(
        integrator,
        "UsdcOnrampOrderCancelled"
      );
      await expect(
        integrator.connect(diamondSigner).onOrderComplete(999, user.address, 1, user.address)
      ).not.to.emit(integrator, "UsdcOnrampOrderFulfilled");

      const fulfilled = await buy(await buildAuthorization());
      await mockDiamond.simulateOrderComplete(fulfilled.orderId);
      await expect(
        integrator
          .connect(diamondSigner)
          .onOrderComplete(fulfilled.orderId, user.address, USDC(25), user.address)
      ).not.to.emit(integrator, "UsdcOnrampOrderFulfilled");
      await expect(integrator.connect(diamondSigner).onOrderCancel(fulfilled.orderId)).not.to.emit(
        integrator,
        "UsdcOnrampOrderCancelled"
      );

      const cancelled = await buy(await buildAuthorization());
      await mockDiamond.simulateOrderCancelled(cancelled.orderId);
      await expect(integrator.connect(diamondSigner).onOrderCancel(cancelled.orderId)).not.to.emit(
        integrator,
        "UsdcOnrampOrderCancelled"
      );
      await expect(
        integrator
          .connect(diamondSigner)
          .onOrderComplete(cancelled.orderId, user.address, USDC(25), user.address)
      ).not.to.emit(integrator, "UsdcOnrampOrderFulfilled");
    });
  });
});
