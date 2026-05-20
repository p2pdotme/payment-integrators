import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("UserProxyV2", function () {
  let deployer: SignerWithAddress;
  let user: SignerWithAddress;
  let stranger: SignerWithAddress;
  let proxy: any;
  let shim: any;
  let mockUsdc: any;
  let diamondAddr: string;

  beforeEach(async function () {
    [deployer, user, stranger] = await ethers.getSigners();
    diamondAddr = ethers.Wallet.createRandom().address;

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUsdc = await MockUSDC.deploy();

    const Shim = await ethers.getContractFactory("MockV2IntegratorShim");
    shim = await Shim.deploy(await mockUsdc.getAddress(), diamondAddr);

    const Impl = await ethers.getContractFactory("UserProxyV2");
    const impl = await Impl.deploy();

    const Cloner = await ethers.getContractFactory("MockV2Cloner");
    const cloner = await Cloner.deploy();
    const tx = await cloner.clone(
      await impl.getAddress(),
      user.address,
      await shim.getAddress(),
      ethers.id("salt")
    );
    const receipt = await tx.wait();
    // Cloned(address indexed clone) — indexed args appear in topics, not args
    const cloneAddr = "0x" + receipt!.logs[0].topics[1].slice(26);
    proxy = await ethers.getContractAt("UserProxyV2", cloneAddr);

    // One-shot initialize via the shim (acting as integrator)
    await shim.callInitialize(cloneAddr);
  });

  it("sets _lastActivityTimestamp on initialize", async function () {
    expect(await proxy.lastActivityTimestamp()).to.be.greaterThan(0n);
  });

  it("reverts AlreadyInitialized on second initialize", async function () {
    await expect(shim.callInitialize(await proxy.getAddress())).to.be.revertedWithCustomError(
      proxy,
      "AlreadyInitialized"
    );
  });

  it("execute bumps _lastActivityTimestamp", async function () {
    const before = await proxy.lastActivityTimestamp();
    await time.increase(60);
    // Use mockUsdc as the target (deployed contract with code). balanceOf is a
    // view that succeeds with empty calldata on OZ ERC20 (falls back gracefully).
    // We pass a valid no-op call: balanceOf(proxy) — usdcAllowance=0 so no approve traffic.
    const data = mockUsdc.interface.encodeFunctionData("balanceOf", [await proxy.getAddress()]);
    await shim.callExecute(
      await proxy.getAddress(),
      await mockUsdc.getAddress(),
      0n,
      data,
      await mockUsdc.getAddress(),
      0n
    );
    expect(await proxy.lastActivityTimestamp()).to.be.greaterThan(before);
  });
});

describe("UserProxyV2 — notifyCashbackCredit", function () {
  let deployer: SignerWithAddress;
  let user: SignerWithAddress;
  let stranger: SignerWithAddress;
  let proxy: any;
  let shim: any;
  let mockUsdc: any;

  beforeEach(async function () {
    [deployer, user, stranger] = await ethers.getSigners();
    const diamondAddr = ethers.Wallet.createRandom().address;

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUsdc = await MockUSDC.deploy();

    const Shim = await ethers.getContractFactory("MockV2IntegratorShim");
    shim = await Shim.deploy(await mockUsdc.getAddress(), diamondAddr);

    const Impl = await ethers.getContractFactory("UserProxyV2");
    const impl = await Impl.deploy();

    const Cloner = await ethers.getContractFactory("MockV2Cloner");
    const cloner = await Cloner.deploy();
    const tx = await cloner.clone(
      await impl.getAddress(),
      user.address,
      await shim.getAddress(),
      ethers.id("salt2")
    );
    const receipt = await tx.wait();
    const cloneAddr = "0x" + receipt!.logs[0].topics[1].slice(26);
    proxy = await ethers.getContractAt("UserProxyV2", cloneAddr);

    await shim.callInitialize(cloneAddr);
  });

  it("bumps timestamp when called by integrator", async function () {
    const before = await proxy.lastActivityTimestamp();
    await time.increase(60);
    await shim.callNotifyCashbackCredit(await proxy.getAddress());
    expect(await proxy.lastActivityTimestamp()).to.be.greaterThan(before);
  });

  it("bumps timestamp when called by configured Diamond address", async function () {
    const before = await proxy.lastActivityTimestamp();
    await time.increase(60);

    const diamondAddr = await shim.diamond();
    await ethers.provider.send("hardhat_impersonateAccount", [diamondAddr]);
    await ethers.provider.send("hardhat_setBalance", [diamondAddr, "0x100000000000000000"]);
    const diamondSigner = await ethers.getSigner(diamondAddr);

    await proxy.connect(diamondSigner).notifyCashbackCredit();

    await ethers.provider.send("hardhat_stopImpersonatingAccount", [diamondAddr]);

    expect(await proxy.lastActivityTimestamp()).to.be.greaterThan(before);
  });

  it("reverts OnlyIntegrator when called by a stranger", async function () {
    await expect(proxy.connect(stranger).notifyCashbackCredit()).to.be.revertedWithCustomError(
      proxy,
      "OnlyIntegrator"
    );
  });

  it("emits CashbackCredited event", async function () {
    await expect(shim.callNotifyCashbackCredit(await proxy.getAddress())).to.emit(
      proxy,
      "CashbackCredited"
    );
  });
});

describe("UserProxyV2 — sweepStale", function () {
  let deployer: SignerWithAddress;
  let user: SignerWithAddress;
  let stranger: SignerWithAddress;
  let proxy: any;
  let shim: any;
  let mockUsdc: any;

  const TEN_USDC = ethers.parseUnits("10", 6);
  const NINETY_DAYS = 90 * 24 * 60 * 60;

  beforeEach(async function () {
    [deployer, user, stranger] = await ethers.getSigners();
    const diamondAddr = ethers.Wallet.createRandom().address;

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUsdc = await MockUSDC.deploy();

    const Shim = await ethers.getContractFactory("MockV2IntegratorShim");
    shim = await Shim.deploy(await mockUsdc.getAddress(), diamondAddr);

    const Impl = await ethers.getContractFactory("UserProxyV2");
    const impl = await Impl.deploy();

    const Cloner = await ethers.getContractFactory("MockV2Cloner");
    const cloner = await Cloner.deploy();
    const tx = await cloner.clone(
      await impl.getAddress(),
      user.address,
      await shim.getAddress(),
      ethers.id("salt3")
    );
    const receipt = await tx.wait();
    const cloneAddr = "0x" + receipt!.logs[0].topics[1].slice(26);
    proxy = await ethers.getContractAt("UserProxyV2", cloneAddr);

    await shim.callInitialize(cloneAddr);

    // Mint 10 USDC to the proxy so sweepStale has something to recover
    await mockUsdc.mint(cloneAddr, TEN_USDC);
  });

  it("reverts SweepLocked before 90 days", async function () {
    await expect(
      shim.callSweepStale(await proxy.getAddress(), user.address)
    ).to.be.revertedWithCustomError(proxy, "SweepLocked");
  });

  it("succeeds after 90 days of inactivity", async function () {
    await time.increase(NINETY_DAYS + 1);
    const balanceBefore = await mockUsdc.balanceOf(user.address);
    await shim.callSweepStale(await proxy.getAddress(), user.address);
    const balanceAfter = await mockUsdc.balanceOf(user.address);
    expect(balanceAfter - balanceBefore).to.equal(TEN_USDC);
  });

  it("succeeds immediately when deprecate flag is set", async function () {
    await shim.setDeprecated(true);
    await expect(shim.callSweepStale(await proxy.getAddress(), user.address)).to.emit(
      proxy,
      "SweepStale"
    );
  });

  it("reverts when called by non-integrator", async function () {
    await time.increase(NINETY_DAYS + 1);
    await expect(proxy.connect(stranger).sweepStale(user.address)).to.be.revertedWithCustomError(
      proxy,
      "OnlyIntegrator"
    );
  });

  it("reverts InvalidAddress when to is zero", async function () {
    await time.increase(NINETY_DAYS + 1);
    await expect(
      shim.callSweepStale(await proxy.getAddress(), ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(proxy, "InvalidAddress");
  });

  it("reverts NothingToSweep on empty proxy", async function () {
    await time.increase(NINETY_DAYS + 1);
    // First sweep drains the 10 USDC
    await shim.callSweepStale(await proxy.getAddress(), user.address);
    // Second sweep on now-empty proxy should revert
    // Need to advance time again since sweepStale resets the activity clock
    await time.increase(NINETY_DAYS + 1);
    await expect(
      shim.callSweepStale(await proxy.getAddress(), user.address)
    ).to.be.revertedWithCustomError(proxy, "NothingToSweep");
  });
});
