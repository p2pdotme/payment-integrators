import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("MarketplaceCheckoutIntegrator + UserProxy", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let user2: SignerWithAddress;
  let stranger: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let integrator: any;
  let marketplace: any;

  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
  const BASE_TX_LIMIT = USDC(100);
  const DAILY_COUNT_LIMIT = 10;
  const UNIT_PRICE = USDC(10);
  const PRODUCT_ID = 1;
  const INR = ethers.encodeBytes32String("INR");

  // SimpleNFTMarketplace.buy(uint256 productId, uint256 quantity)
  const buySelector = ethers.id("buy(uint256,uint256)").slice(0, 10);

  beforeEach(async function () {
    [owner, user, user2, stranger] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUsdc = await MockUSDC.deploy();

    const MockDiamond = await ethers.getContractFactory("MockDiamond");
    mockDiamond = await MockDiamond.deploy(await mockUsdc.getAddress());

    const Integrator = await ethers.getContractFactory("MarketplaceCheckoutIntegrator");
    integrator = await Integrator.deploy(
      await mockDiamond.getAddress(),
      await mockUsdc.getAddress(),
      BASE_TX_LIMIT,
      DAILY_COUNT_LIMIT
    );

    const Marketplace = await ethers.getContractFactory("SimpleNFTMarketplace");
    marketplace = await Marketplace.deploy(await mockUsdc.getAddress(), "Demo NFT", "DNFT");

    await mockDiamond.registerIntegrator(
      await integrator.getAddress(),
      await integrator.proxyImpl()
    );
    await marketplace.setProductPrice(PRODUCT_ID, UNIT_PRICE);
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(10000));

    // Register recipe: buy(productId, quantity)
    const prefixArgs = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [PRODUCT_ID]);
    await integrator.setRecipe(
      await marketplace.getAddress(),
      PRODUCT_ID,
      UNIT_PRICE,
      buySelector,
      prefixArgs,
      true,
      [await marketplace.getAddress()]
    );
  });

  describe("End-to-end via UserProxy", function () {
    it("places, fulfills, and lands NFTs on the user's proxy (not on the user EOA)", async function () {
      const proxyAddr = await integrator.proxyAddress(user.address);
      expect(await ethers.provider.getCode(proxyAddr)).to.equal("0x");

      // Proxy is deployed lazily during userPlaceOrder — it is the placer that
      // calls placeB2BOrder, so the gateway can re-derive its CREATE2 address.
      await expect(
        integrator
          .connect(user)
          .userPlaceOrder(await marketplace.getAddress(), PRODUCT_ID, 2, INR, 1, "", 0, 0)
      )
        .to.emit(integrator, "UserProxyDeployed")
        .withArgs(user.address, proxyAddr);

      await mockDiamond.simulateOrderComplete(1);

      // NFTs land on the proxy, not the user
      expect(await marketplace.balanceOf(proxyAddr)).to.equal(2);
      expect(await marketplace.balanceOf(user.address)).to.equal(0);
      expect(await marketplace.ownerOf(1)).to.equal(proxyAddr);
      expect(await marketplace.ownerOf(2)).to.equal(proxyAddr);
    });

    it("user can manually sweep NFTs out of the proxy", async function () {
      await integrator
        .connect(user)
        .userPlaceOrder(await marketplace.getAddress(), PRODUCT_ID, 1, INR, 1, "", 0, 0);
      await mockDiamond.simulateOrderComplete(1);

      const proxyAddr = await integrator.proxyAddress(user.address);
      const proxy = await ethers.getContractAt("UserProxy", proxyAddr);

      await proxy.connect(user).sweepERC721(await marketplace.getAddress(), 1);

      expect(await marketplace.ownerOf(1)).to.equal(user.address);
      expect(await marketplace.balanceOf(proxyAddr)).to.equal(0);
    });

    it("reuses the same proxy across multiple orders", async function () {
      await integrator
        .connect(user)
        .userPlaceOrder(await marketplace.getAddress(), PRODUCT_ID, 1, INR, 1, "", 0, 0);
      await mockDiamond.simulateOrderComplete(1);

      const proxyAfterFirst = await integrator.proxyAddress(user.address);

      // Second order should not emit UserProxyDeployed again
      await integrator
        .connect(user)
        .userPlaceOrder(await marketplace.getAddress(), PRODUCT_ID, 1, INR, 1, "", 0, 0);
      const tx = await mockDiamond.simulateOrderComplete(2);
      const receipt = await tx.wait();
      const deployedTopic = integrator.interface.getEvent("UserProxyDeployed").topicHash;
      const hasDeployedEvent = receipt.logs.some((l: any) => l.topics[0] === deployedTopic);
      expect(hasDeployedEvent).to.equal(false);

      expect(await integrator.proxyAddress(user.address)).to.equal(proxyAfterFirst);
      expect(await marketplace.balanceOf(proxyAfterFirst)).to.equal(2);
    });

    it("different users get different proxies", async function () {
      const p1 = await integrator.proxyAddress(user.address);
      const p2 = await integrator.proxyAddress(user2.address);
      expect(p1).to.not.equal(p2);
    });

    it("predicted address matches deployed address", async function () {
      const predicted = await integrator.proxyAddress(user.address);

      await integrator
        .connect(user)
        .userPlaceOrder(await marketplace.getAddress(), PRODUCT_ID, 1, INR, 1, "", 0, 0);
      await mockDiamond.simulateOrderComplete(1);

      expect(await ethers.provider.getCode(predicted)).to.not.equal("0x");
    });

    it("USDC remainder stays on the proxy when the client charges less than the recipe price", async function () {
      // Set marketplace price lower than the recipe price → client pulls less
      // than the integrator forwarded. UserProxy no longer auto-refunds USDC
      // remainder to the user EOA (closes a fraud-bypass surface where
      // B2B-mediated fiat-to-USDC conversion would evade consumer-side
      // fraud checks). The 3 USDC remainder sits on the proxy until a
      // future flow consumes it.
      await marketplace.setProductPrice(PRODUCT_ID, USDC(7));

      const proxyAddr = await integrator.proxyAddress(user.address);
      const userBefore = await mockUsdc.balanceOf(user.address);
      await integrator
        .connect(user)
        .userPlaceOrder(await marketplace.getAddress(), PRODUCT_ID, 1, INR, 1, "", 0, 0);
      await mockDiamond.simulateOrderComplete(1);

      expect(await mockUsdc.balanceOf(user.address)).to.equal(userBefore);
      expect(await mockUsdc.balanceOf(proxyAddr)).to.equal(USDC(3));
    });

    it("proxy stores immutable owner and integrator", async function () {
      await integrator
        .connect(user)
        .userPlaceOrder(await marketplace.getAddress(), PRODUCT_ID, 1, INR, 1, "", 0, 0);
      await mockDiamond.simulateOrderComplete(1);

      const proxyAddr = await integrator.proxyAddress(user.address);
      const proxy = await ethers.getContractAt("UserProxy", proxyAddr);

      expect(await proxy.owner()).to.equal(user.address);
      expect(await proxy.integrator()).to.equal(await integrator.getAddress());
    });
  });

  describe("Access control", function () {
    it("non-integrator cannot call execute on proxy", async function () {
      await integrator
        .connect(user)
        .userPlaceOrder(await marketplace.getAddress(), PRODUCT_ID, 1, INR, 1, "", 0, 0);
      await mockDiamond.simulateOrderComplete(1);

      const proxyAddr = await integrator.proxyAddress(user.address);
      const proxy = await ethers.getContractAt("UserProxy", proxyAddr);

      await expect(
        proxy
          .connect(stranger)
          .execute(await marketplace.getAddress(), "0x", await mockUsdc.getAddress(), 0)
      ).to.be.revertedWithCustomError(proxy, "OnlyIntegrator");
    });

    it("non-owner cannot sweep from proxy", async function () {
      await integrator
        .connect(user)
        .userPlaceOrder(await marketplace.getAddress(), PRODUCT_ID, 1, INR, 1, "", 0, 0);
      await mockDiamond.simulateOrderComplete(1);

      const proxyAddr = await integrator.proxyAddress(user.address);
      const proxy = await ethers.getContractAt("UserProxy", proxyAddr);

      await expect(
        proxy.connect(stranger).sweepERC721(await marketplace.getAddress(), 1)
      ).to.be.revertedWithCustomError(proxy, "OnlyOwner");

      await expect(
        proxy.connect(stranger).sweepERC20(await mockUsdc.getAddress())
      ).to.be.revertedWithCustomError(proxy, "OnlyOwner");
    });

    it("user cannot place order for unregistered recipe", async function () {
      await integrator.removeRecipe(await marketplace.getAddress(), PRODUCT_ID);
      await expect(
        integrator
          .connect(user)
          .userPlaceOrder(await marketplace.getAddress(), PRODUCT_ID, 1, INR, 1, "", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "RecipeNotFound");
    });

    it("non-owner cannot register a recipe", async function () {
      await expect(
        integrator
          .connect(stranger)
          .setRecipe(await marketplace.getAddress(), 999, UNIT_PRICE, buySelector, "0x", true, [])
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });
  });

  describe("Escape hatch (proxy keeps working if integrator is paused/removed)", function () {
    it("user can sweep airdropped non-USDC tokens from proxy at any time", async function () {
      // Predict proxy address before deploy
      const proxyAddr = await integrator.proxyAddress(user.address);

      // Trigger deploy via a normal order
      await integrator
        .connect(user)
        .userPlaceOrder(await marketplace.getAddress(), PRODUCT_ID, 1, INR, 1, "", 0, 0);
      await mockDiamond.simulateOrderComplete(1);

      // Simulate an unrelated airdrop directly to the proxy (any ERC-20
      // except USDC, since USDC sweep is now blocked universally).
      const Token = await ethers.getContractFactory("MockUSDC");
      const airdrop = await Token.deploy();
      await airdrop.mint(proxyAddr, USDC(42));

      const proxy = await ethers.getContractAt("UserProxy", proxyAddr);
      const before = await airdrop.balanceOf(user.address);
      await proxy.connect(user).sweepERC20(await airdrop.getAddress());
      const after = await airdrop.balanceOf(user.address);

      expect(after - before).to.equal(USDC(42));
    });

    it("user CANNOT sweep USDC out of the proxy (blocked universally)", async function () {
      const proxyAddr = await integrator.proxyAddress(user.address);
      await integrator
        .connect(user)
        .userPlaceOrder(await marketplace.getAddress(), PRODUCT_ID, 1, INR, 1, "", 0, 0);
      await mockDiamond.simulateOrderComplete(1);

      // Stranded USDC arriving on the proxy (e.g. airdrop) can only exit
      // via integrator-driven flows, not direct user-initiated sweep.
      await mockUsdc.mint(proxyAddr, USDC(5));
      const proxy = await ethers.getContractAt("UserProxy", proxyAddr);
      await expect(
        proxy.connect(user).sweepERC20(await mockUsdc.getAddress())
      ).to.be.revertedWithCustomError(proxy, "USDCSweepBlocked");
    });
  });

  describe("Recipe & limits sanity", function () {
    it("rejects setRecipe with non-contract client", async function () {
      await expect(
        integrator.setRecipe(stranger.address, 99, UNIT_PRICE, buySelector, "0x", true, [])
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    });

    it("rejects setRecipe with zero price", async function () {
      await expect(
        integrator.setRecipe(await marketplace.getAddress(), 99, 0, buySelector, "0x", true, [])
      ).to.be.revertedWithCustomError(integrator, "InvalidUnitPrice");
    });

    it("enforces per-tx limit on quantity × unitPrice", async function () {
      // baseTxLimit=100, unit=10 → 11 units (110) exceeds
      await expect(
        integrator
          .connect(user)
          .userPlaceOrder(await marketplace.getAddress(), PRODUCT_ID, 11, INR, 1, "", 0, 0)
      ).to.be.reverted;
    });

    it("enforces daily count limit", async function () {
      await integrator.setDailyTxCountLimit(2);
      await integrator
        .connect(user)
        .userPlaceOrder(await marketplace.getAddress(), PRODUCT_ID, 1, INR, 1, "", 0, 0);
      await integrator
        .connect(user)
        .userPlaceOrder(await marketplace.getAddress(), PRODUCT_ID, 1, INR, 1, "", 0, 0);
      await expect(
        integrator
          .connect(user)
          .userPlaceOrder(await marketplace.getAddress(), PRODUCT_ID, 1, INR, 1, "", 0, 0)
      ).to.be.reverted;
    });
  });
});
