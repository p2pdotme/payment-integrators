import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("GrantVault", function () {
  let owner: SignerWithAddress;
  let newOwner: SignerWithAddress;
  let spender: SignerWithAddress;
  let other: SignerWithAddress;
  let recipient: SignerWithAddress;

  let vault: any;
  let usdc: any;

  const INITIAL_FUND = ethers.parseUnits("1000", 6); // 1000 USDC

  beforeEach(async function () {
    [owner, newOwner, spender, other, recipient] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();

    const Vault = await ethers.getContractFactory("GrantVault");
    vault = await Vault.deploy(await usdc.getAddress(), owner.address);

    // Fund the vault by plain transfer.
    await usdc.mint(await vault.getAddress(), INITIAL_FUND);
  });

  describe("construction", function () {
    it("stores usdc + owner and emits OwnershipTransferred(0, owner)", async function () {
      expect(await vault.USDC()).to.equal(await usdc.getAddress());
      expect(await vault.owner()).to.equal(owner.address);
    });

    it("reverts InvalidAddress on zero usdc", async function () {
      const Vault = await ethers.getContractFactory("GrantVault");
      await expect(Vault.deploy(ethers.ZeroAddress, owner.address)).to.be.revertedWithCustomError(
        vault,
        "InvalidAddress"
      );
    });

    it("reverts InvalidAddress on zero owner", async function () {
      const Vault = await ethers.getContractFactory("GrantVault");
      await expect(
        Vault.deploy(await usdc.getAddress(), ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(vault, "InvalidAddress");
    });
  });

  describe("setApprovedSpender", function () {
    it("owner can approve and revoke a spender + emits event", async function () {
      await expect(vault.connect(owner).setApprovedSpender(spender.address, true))
        .to.emit(vault, "SpenderSet")
        .withArgs(spender.address, true);
      expect(await vault.approvedSpender(spender.address)).to.equal(true);

      await expect(vault.connect(owner).setApprovedSpender(spender.address, false))
        .to.emit(vault, "SpenderSet")
        .withArgs(spender.address, false);
      expect(await vault.approvedSpender(spender.address)).to.equal(false);
    });

    it("reverts OnlyOwner when called by non-owner", async function () {
      await expect(
        vault.connect(other).setApprovedSpender(spender.address, true)
      ).to.be.revertedWithCustomError(vault, "OnlyOwner");
    });

    it("reverts InvalidAddress on zero spender", async function () {
      await expect(
        vault.connect(owner).setApprovedSpender(ethers.ZeroAddress, true)
      ).to.be.revertedWithCustomError(vault, "InvalidAddress");
    });
  });

  describe("release", function () {
    beforeEach(async function () {
      await vault.connect(owner).setApprovedSpender(spender.address, true);
    });

    it("approved spender can release USDC to a destination + emits event", async function () {
      const amount = ethers.parseUnits("10", 6);
      const before = await usdc.balanceOf(recipient.address);

      await expect(vault.connect(spender).release(recipient.address, amount))
        .to.emit(vault, "Released")
        .withArgs(spender.address, recipient.address, amount);

      expect(await usdc.balanceOf(recipient.address)).to.equal(before + amount);
    });

    it("reverts OnlyApprovedSpender when called by non-spender", async function () {
      const amount = ethers.parseUnits("10", 6);
      await expect(
        vault.connect(other).release(recipient.address, amount)
      ).to.be.revertedWithCustomError(vault, "OnlyApprovedSpender");
    });

    it("reverts OnlyApprovedSpender for a previously-approved but now-revoked spender", async function () {
      await vault.connect(owner).setApprovedSpender(spender.address, false);
      await expect(
        vault.connect(spender).release(recipient.address, 1n)
      ).to.be.revertedWithCustomError(vault, "OnlyApprovedSpender");
    });

    it("reverts InvalidAddress on zero to", async function () {
      await expect(
        vault.connect(spender).release(ethers.ZeroAddress, 1n)
      ).to.be.revertedWithCustomError(vault, "InvalidAddress");
    });

    it("reverts InvalidAmount on zero amount", async function () {
      await expect(
        vault.connect(spender).release(recipient.address, 0)
      ).to.be.revertedWithCustomError(vault, "InvalidAmount");
    });

    it("reverts on insufficient vault balance (SafeERC20 propagates)", async function () {
      const tooMuch = INITIAL_FUND + 1n;
      await expect(vault.connect(spender).release(recipient.address, tooMuch)).to.be.reverted;
    });
  });

  describe("withdraw", function () {
    it("owner can withdraw at any time + emits event", async function () {
      const amount = ethers.parseUnits("100", 6);
      const before = await usdc.balanceOf(recipient.address);

      await expect(vault.connect(owner).withdraw(recipient.address, amount))
        .to.emit(vault, "Withdrawn")
        .withArgs(recipient.address, amount);

      expect(await usdc.balanceOf(recipient.address)).to.equal(before + amount);
    });

    it("reverts OnlyOwner when called by non-owner", async function () {
      await expect(
        vault.connect(other).withdraw(recipient.address, 1n)
      ).to.be.revertedWithCustomError(vault, "OnlyOwner");
    });

    it("approved spenders cannot withdraw (only release)", async function () {
      await vault.connect(owner).setApprovedSpender(spender.address, true);
      await expect(
        vault.connect(spender).withdraw(recipient.address, 1n)
      ).to.be.revertedWithCustomError(vault, "OnlyOwner");
    });

    it("reverts InvalidAddress on zero to", async function () {
      await expect(
        vault.connect(owner).withdraw(ethers.ZeroAddress, 1n)
      ).to.be.revertedWithCustomError(vault, "InvalidAddress");
    });

    it("reverts InvalidAmount on zero amount", async function () {
      await expect(
        vault.connect(owner).withdraw(recipient.address, 0)
      ).to.be.revertedWithCustomError(vault, "InvalidAmount");
    });
  });

  describe("transferOwnership", function () {
    it("owner can transfer + emits event", async function () {
      await expect(vault.connect(owner).transferOwnership(newOwner.address))
        .to.emit(vault, "OwnershipTransferred")
        .withArgs(owner.address, newOwner.address);
      expect(await vault.owner()).to.equal(newOwner.address);
    });

    it("old owner loses access after transfer", async function () {
      await vault.connect(owner).transferOwnership(newOwner.address);
      await expect(
        vault.connect(owner).withdraw(recipient.address, 1n)
      ).to.be.revertedWithCustomError(vault, "OnlyOwner");
    });

    it("new owner gains access after transfer", async function () {
      await vault.connect(owner).transferOwnership(newOwner.address);
      const amount = ethers.parseUnits("5", 6);
      await expect(vault.connect(newOwner).withdraw(recipient.address, amount)).to.emit(
        vault,
        "Withdrawn"
      );
    });

    it("reverts OnlyOwner when called by non-owner", async function () {
      await expect(
        vault.connect(other).transferOwnership(newOwner.address)
      ).to.be.revertedWithCustomError(vault, "OnlyOwner");
    });

    it("reverts InvalidAddress on zero new owner", async function () {
      await expect(
        vault.connect(owner).transferOwnership(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(vault, "InvalidAddress");
    });
  });
});
