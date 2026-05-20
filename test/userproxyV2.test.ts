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
