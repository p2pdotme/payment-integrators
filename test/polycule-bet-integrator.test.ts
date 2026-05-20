import { expect } from "chai";
import { ethers, network } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("PolyculeBetIntegrator", function () {
  let owner: SignerWithAddress;
  let registrar: SignerWithAddress;
  let user: SignerWithAddress;
  let user2: SignerWithAddress;
  let outsider: SignerWithAddress;
  let bridgeRecipient: SignerWithAddress;
  let bridgeRecipient2: SignerWithAddress;
  let rescueTo: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let integrator: any;

  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
  const USD = USDC(10);
  const INR = ethers.encodeBytes32String("INR");

  beforeEach(async function () {
    [owner, registrar, user, user2, outsider, bridgeRecipient, bridgeRecipient2, rescueTo] =
      await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUsdc = await MockUSDC.deploy();

    const MockDiamond = await ethers.getContractFactory("MockDiamond");
    mockDiamond = await MockDiamond.deploy(await mockUsdc.getAddress());

    const Integrator = await ethers.getContractFactory("PolyculeBetIntegrator");
    integrator = await Integrator.deploy(
      await mockDiamond.getAddress(),
      await mockUsdc.getAddress(),
      owner.address,
      registrar.address
    );

    await mockDiamond.registerIntegrator(
      await integrator.getAddress(),
      await integrator.proxyImpl()
    );
  });

  // ─── Constructor ──────────────────────────────────────────────────

  describe("constructor", function () {
    it("sets all immutables and deploys proxyImpl", async function () {
      expect(await integrator.diamond()).to.equal(await mockDiamond.getAddress());
      expect(await integrator.usdc()).to.equal(await mockUsdc.getAddress());
      expect(await integrator.owner()).to.equal(owner.address);
      expect(await integrator.registrar()).to.equal(registrar.address);

      const proxyImpl = await integrator.proxyImpl();
      expect(proxyImpl).to.not.equal(ethers.ZeroAddress);
      const code = await ethers.provider.getCode(proxyImpl);
      expect(code).to.not.equal("0x");
    });

    it("reverts InvalidAddress when diamond is zero", async function () {
      const Integrator = await ethers.getContractFactory("PolyculeBetIntegrator");
      await expect(
        Integrator.deploy(
          ethers.ZeroAddress,
          await mockUsdc.getAddress(),
          owner.address,
          registrar.address
        )
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    });

    it("reverts InvalidAddress when usdc is zero", async function () {
      const Integrator = await ethers.getContractFactory("PolyculeBetIntegrator");
      await expect(
        Integrator.deploy(
          await mockDiamond.getAddress(),
          ethers.ZeroAddress,
          owner.address,
          registrar.address
        )
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    });

    it("reverts InvalidAddress when owner is zero", async function () {
      const Integrator = await ethers.getContractFactory("PolyculeBetIntegrator");
      await expect(
        Integrator.deploy(
          await mockDiamond.getAddress(),
          await mockUsdc.getAddress(),
          ethers.ZeroAddress,
          registrar.address
        )
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    });

    it("reverts InvalidAddress when registrar is zero", async function () {
      const Integrator = await ethers.getContractFactory("PolyculeBetIntegrator");
      await expect(
        Integrator.deploy(
          await mockDiamond.getAddress(),
          await mockUsdc.getAddress(),
          owner.address,
          ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    });

    it("emits RegistrarUpdated at construction", async function () {
      const Integrator = await ethers.getContractFactory("PolyculeBetIntegrator");
      const tx = await Integrator.deploy(
        await mockDiamond.getAddress(),
        await mockUsdc.getAddress(),
        owner.address,
        registrar.address
      );
      await expect(tx.deploymentTransaction())
        .to.emit(tx, "RegistrarUpdated")
        .withArgs(registrar.address);
    });
  });

  // ─── setBridgeRecipient ───────────────────────────────────────────

  describe("setBridgeRecipient", function () {
    it("happy path sets mapping and emits event", async function () {
      await expect(
        integrator.connect(registrar).setBridgeRecipient(user.address, bridgeRecipient.address)
      )
        .to.emit(integrator, "BridgeRecipientSet")
        .withArgs(user.address, bridgeRecipient.address);
      expect(await integrator.bridgeRecipientOf(user.address)).to.equal(bridgeRecipient.address);
    });

    it("is idempotent — can be overwritten with a new non-zero address", async function () {
      await integrator.connect(registrar).setBridgeRecipient(user.address, bridgeRecipient.address);
      await integrator
        .connect(registrar)
        .setBridgeRecipient(user.address, bridgeRecipient2.address);
      expect(await integrator.bridgeRecipientOf(user.address)).to.equal(bridgeRecipient2.address);
    });

    it("reverts OnlyRegistrar from non-registrar (owner)", async function () {
      await expect(
        integrator.connect(owner).setBridgeRecipient(user.address, bridgeRecipient.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyRegistrar");
    });

    it("reverts OnlyRegistrar from non-registrar (random)", async function () {
      await expect(
        integrator.connect(outsider).setBridgeRecipient(user.address, bridgeRecipient.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyRegistrar");
    });

    it("reverts InvalidAddress when user is zero", async function () {
      await expect(
        integrator
          .connect(registrar)
          .setBridgeRecipient(ethers.ZeroAddress, bridgeRecipient.address)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    });

    it("reverts InvalidAddress when recipient is zero", async function () {
      await expect(
        integrator.connect(registrar).setBridgeRecipient(user.address, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    });

    it("isRegistered reflects mapping state", async function () {
      expect(await integrator.isRegistered(user.address)).to.equal(false);
      await integrator.connect(registrar).setBridgeRecipient(user.address, bridgeRecipient.address);
      expect(await integrator.isRegistered(user.address)).to.equal(true);
    });
  });

  // ─── setRegistrar ─────────────────────────────────────────────────

  describe("setRegistrar", function () {
    it("happy path rotates registrar and emits event", async function () {
      await expect(integrator.connect(owner).setRegistrar(outsider.address))
        .to.emit(integrator, "RegistrarUpdated")
        .withArgs(outsider.address);
      expect(await integrator.registrar()).to.equal(outsider.address);
    });

    it("new registrar can write; old registrar cannot", async function () {
      await integrator.connect(owner).setRegistrar(outsider.address);
      await integrator.connect(outsider).setBridgeRecipient(user.address, bridgeRecipient.address);
      await expect(
        integrator.connect(registrar).setBridgeRecipient(user2.address, bridgeRecipient.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyRegistrar");
    });

    it("reverts OnlyOwner from non-owner", async function () {
      await expect(
        integrator.connect(registrar).setRegistrar(outsider.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });

    it("reverts InvalidAddress when zero", async function () {
      await expect(
        integrator.connect(owner).setRegistrar(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    });
  });

  // ─── userPlaceOrder ───────────────────────────────────────────────

  describe("userPlaceOrder", function () {
    beforeEach(async function () {
      await integrator.connect(registrar).setBridgeRecipient(user.address, bridgeRecipient.address);
    });

    it("reverts InvalidAmount on amount = 0", async function () {
      await expect(
        integrator.connect(user).userPlaceOrder(0, INR, "pk", 1, 1, 0)
      ).to.be.revertedWithCustomError(integrator, "InvalidAmount");
    });

    it("reverts NoBridgeRecipient if caller is not mapped", async function () {
      await expect(
        integrator.connect(user2).userPlaceOrder(USD, INR, "pk", 1, 1, 0)
      ).to.be.revertedWithCustomError(integrator, "NoBridgeRecipient");
    });

    it("happy path deploys proxy, places order, emits events, returns orderId", async function () {
      const predicted = await integrator.proxyAddress(user.address);
      expect(await integrator.isProxyDeployed(user.address)).to.equal(false);

      const tx = await integrator.connect(user).userPlaceOrder(USD, INR, "pk", 1, 1, 0);

      await expect(tx).to.emit(integrator, "UserProxyDeployed").withArgs(user.address, predicted);
      await expect(tx)
        .to.emit(integrator, "PolyculeOrderPlaced")
        .withArgs(1, user.address, bridgeRecipient.address, USD, INR);

      expect(await integrator.isProxyDeployed(user.address)).to.equal(true);

      const order = await mockDiamond.orders(1);
      expect(order.user).to.equal(user.address);
      expect(order.amount).to.equal(USD);
      expect(order.currency).to.equal(INR);
      expect(order.recipientAddr).to.equal(bridgeRecipient.address);
    });

    it("second placement reuses existing proxy (no UserProxyDeployed event)", async function () {
      await integrator.connect(user).userPlaceOrder(USD, INR, "pk", 1, 1, 0);
      const tx2 = await integrator.connect(user).userPlaceOrder(USD, INR, "pk", 1, 1, 0);
      await expect(tx2).to.not.emit(integrator, "UserProxyDeployed");
      await expect(tx2).to.emit(integrator, "PolyculeOrderPlaced");
    });

    it("uses the current mapping at placement time (re-map between placements)", async function () {
      await integrator.connect(user).userPlaceOrder(USD, INR, "pk", 1, 1, 0);
      // Re-map to a different recipient
      await integrator
        .connect(registrar)
        .setBridgeRecipient(user.address, bridgeRecipient2.address);
      await integrator.connect(user).userPlaceOrder(USD, INR, "pk", 1, 1, 0);

      const order1 = await mockDiamond.orders(1);
      const order2 = await mockDiamond.orders(2);
      expect(order1.recipientAddr).to.equal(bridgeRecipient.address);
      expect(order2.recipientAddr).to.equal(bridgeRecipient2.address);
    });
  });

  // ─── validateOrder ────────────────────────────────────────────────

  describe("validateOrder", function () {
    it("reverts OnlyDiamond when called by non-diamond", async function () {
      await expect(
        integrator.connect(outsider).validateOrder(user.address, USD, INR)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
    });

    it("returns true when called by diamond (impersonated)", async function () {
      const diamondAddr = await mockDiamond.getAddress();
      await impersonate(diamondAddr);
      const diamondSigner = await ethers.getSigner(diamondAddr);
      const result = await integrator
        .connect(diamondSigner)
        .validateOrder.staticCall(user.address, USD, INR);
      expect(result).to.equal(true);
      await stopImpersonate(diamondAddr);
    });
  });

  // ─── onOrderComplete ──────────────────────────────────────────────

  describe("onOrderComplete", function () {
    let diamondSigner: any;

    beforeEach(async function () {
      const diamondAddr = await mockDiamond.getAddress();
      await impersonate(diamondAddr);
      diamondSigner = await ethers.getSigner(diamondAddr);
      // The mock contract has no ETH for gas — fund it
      await network.provider.send("hardhat_setBalance", [
        diamondAddr,
        "0xDE0B6B3A7640000", // 1 ETH
      ]);

      await integrator.connect(registrar).setBridgeRecipient(user.address, bridgeRecipient.address);
    });

    afterEach(async function () {
      await stopImpersonate(await mockDiamond.getAddress());
    });

    it("reverts OnlyDiamond when called by non-diamond", async function () {
      await expect(
        integrator.connect(outsider).onOrderComplete(1, user.address, USD, bridgeRecipient.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
    });

    it("forwards USDC to mapped recipient and emits PolyculeOrderSettled", async function () {
      // Simulate the Diamond transferring USDC to the integrator (usdcThroughIntegrator=true)
      await mockUsdc.mint(await integrator.getAddress(), USD);
      const balBefore = await mockUsdc.balanceOf(bridgeRecipient.address);

      await expect(
        integrator.connect(diamondSigner).onOrderComplete(1, user.address, USD, ethers.ZeroAddress)
      )
        .to.emit(integrator, "PolyculeOrderSettled")
        .withArgs(user.address, bridgeRecipient.address, USD);

      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(0);
      expect(await mockUsdc.balanceOf(bridgeRecipient.address)).to.equal(balBefore + USD);
    });

    it("reads mapping at settlement time (re-map after placement, before settlement)", async function () {
      await mockUsdc.mint(await integrator.getAddress(), USD);
      await integrator
        .connect(registrar)
        .setBridgeRecipient(user.address, bridgeRecipient2.address);

      await integrator
        .connect(diamondSigner)
        .onOrderComplete(1, user.address, USD, bridgeRecipient.address);

      expect(await mockUsdc.balanceOf(bridgeRecipient.address)).to.equal(0);
      expect(await mockUsdc.balanceOf(bridgeRecipient2.address)).to.equal(USD);
    });

    it("reverts NoBridgeRecipient if user has never been mapped (defense-in-depth)", async function () {
      await mockUsdc.mint(await integrator.getAddress(), USD);
      await expect(
        integrator
          .connect(diamondSigner)
          .onOrderComplete(2, user2.address, USD, bridgeRecipient.address)
      ).to.be.revertedWithCustomError(integrator, "NoBridgeRecipient");
    });
  });

  // ─── onOrderCancel ────────────────────────────────────────────────

  describe("onOrderCancel", function () {
    it("reverts OnlyDiamond when called by non-diamond", async function () {
      await expect(integrator.connect(outsider).onOrderCancel(1)).to.be.revertedWithCustomError(
        integrator,
        "OnlyDiamond"
      );
    });

    it("no-ops when called by diamond", async function () {
      const diamondAddr = await mockDiamond.getAddress();
      await impersonate(diamondAddr);
      await network.provider.send("hardhat_setBalance", [
        diamondAddr,
        "0xDE0B6B3A7640000", // 1 ETH
      ]);
      const diamondSigner = await ethers.getSigner(diamondAddr);
      // Should not revert
      await integrator.connect(diamondSigner).onOrderCancel(1);
      await stopImpersonate(diamondAddr);
    });
  });

  // ─── rescueStrandedUsdc ───────────────────────────────────────────

  describe("rescueStrandedUsdc", function () {
    beforeEach(async function () {
      await mockUsdc.mint(await integrator.getAddress(), USD);
    });

    it("happy path transfers USDC to recipient", async function () {
      await integrator.connect(owner).rescueStrandedUsdc(rescueTo.address, USD);
      expect(await mockUsdc.balanceOf(rescueTo.address)).to.equal(USD);
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(0);
    });

    it("supports partial rescue", async function () {
      const half = USD / 2n;
      await integrator.connect(owner).rescueStrandedUsdc(rescueTo.address, half);
      expect(await mockUsdc.balanceOf(rescueTo.address)).to.equal(half);
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(USD - half);
    });

    it("reverts OnlyOwner from non-owner", async function () {
      await expect(
        integrator.connect(registrar).rescueStrandedUsdc(rescueTo.address, USD)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });

    it("reverts InvalidAddress when to is zero", async function () {
      await expect(
        integrator.connect(owner).rescueStrandedUsdc(ethers.ZeroAddress, USD)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    });
  });

  // ─── Views ────────────────────────────────────────────────────────

  describe("views", function () {
    it("proxyAddress is deterministic and stable", async function () {
      const a = await integrator.proxyAddress(user.address);
      const b = await integrator.proxyAddress(user.address);
      expect(a).to.equal(b);
      expect(a).to.not.equal(ethers.ZeroAddress);
    });

    it("proxyAddress differs per user", async function () {
      const a = await integrator.proxyAddress(user.address);
      const b = await integrator.proxyAddress(user2.address);
      expect(a).to.not.equal(b);
    });

    it("isProxyDeployed flips after first placement", async function () {
      await integrator.connect(registrar).setBridgeRecipient(user.address, bridgeRecipient.address);
      expect(await integrator.isProxyDeployed(user.address)).to.equal(false);
      await integrator.connect(user).userPlaceOrder(USD, INR, "pk", 1, 1, 0);
      expect(await integrator.isProxyDeployed(user.address)).to.equal(true);
    });

    it("isRegistered is false before mapping, true after", async function () {
      expect(await integrator.isRegistered(user.address)).to.equal(false);
      await integrator.connect(registrar).setBridgeRecipient(user.address, bridgeRecipient.address);
      expect(await integrator.isRegistered(user.address)).to.equal(true);
    });
  });
});

async function impersonate(addr: string) {
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [addr],
  });
}

async function stopImpersonate(addr: string) {
  await network.provider.request({
    method: "hardhat_stopImpersonatingAccount",
    params: [addr],
  });
}
