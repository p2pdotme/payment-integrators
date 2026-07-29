import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("RemitamIntegrator", function () {
  let owner: SignerWithAddress; // admin wallet (deployer)
  let walletA: SignerWithAddress; // whitelisted user server wallet
  let walletB: SignerWithAddress; // second user server wallet
  let attacker: SignerWithAddress;

  let usdc: any;
  let diamond: any;
  let integrator: any;

  const USDC = (n: number | string) => ethers.parseUnits(n.toString(), 6);
  const INR = ethers.encodeBytes32String("INR");
  const CIRCLE = 1;
  const PK = "04" + "ab".repeat(64); // valid-shape relay pubkey
  const DAY = 86400;
  // Ceilings chosen for tests: 1_000 USDC/tx, 5_000 USDC/day, 10 orders/day
  const TX_CEIL = USDC(1000);
  const VOL_CEIL = USDC(5000);
  const COUNT_CEIL = 10n;

  async function diamondSigner(): Promise<SignerWithAddress> {
    const addr = await diamond.getAddress();
    await ethers.provider.send("hardhat_impersonateAccount", [addr]);
    await ethers.provider.send("hardhat_setBalance", [addr, "0x1000000000000000000"]);
    return await ethers.getSigner(addr);
  }

  beforeEach(async function () {
    [owner, walletA, walletB, attacker] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();

    const MockDiamond = await ethers.getContractFactory("MockDiamond");
    diamond = await MockDiamond.deploy(await usdc.getAddress());

    const Integrator = await ethers.getContractFactory("RemitamIntegrator");
    integrator = await Integrator.deploy(
      await diamond.getAddress(),
      await usdc.getAddress(),
      TX_CEIL,
      VOL_CEIL,
      COUNT_CEIL
    );

    await diamond.registerIntegrator(await integrator.getAddress(), await integrator.proxyImpl());
    // Fund the mock diamond so simulateOrderComplete can pay out buys.
    await usdc.mint(await diamond.getAddress(), USDC(100000));
  });

  describe("whitelist", function () {
    it("owner can add and remove accounts", async function () {
      await expect(integrator.addAccount(walletA.address))
        .to.emit(integrator, "AccountAdded")
        .withArgs(walletA.address);
      expect(await integrator.whitelisted(walletA.address)).to.equal(true);

      await expect(integrator.removeAccount(walletA.address))
        .to.emit(integrator, "AccountRemoved")
        .withArgs(walletA.address);
      expect(await integrator.whitelisted(walletA.address)).to.equal(false);
    });

    it("non-owner cannot add accounts", async function () {
      await expect(
        integrator.connect(attacker).addAccount(attacker.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });

    it("rejects zero address", async function () {
      await expect(integrator.addAccount(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        integrator,
        "InvalidAddress"
      );
    });
  });

  describe("limits admin", function () {
    it("initial limits equal ceilings", async function () {
      expect(await integrator.txLimit()).to.equal(TX_CEIL);
      expect(await integrator.dailyVolumeLimit()).to.equal(VOL_CEIL);
      expect(await integrator.dailyCountLimit()).to.equal(COUNT_CEIL);
    });

    it("owner can lower and re-raise limits up to the ceiling", async function () {
      await expect(integrator.setLimits(USDC(100), USDC(500), 3))
        .to.emit(integrator, "LimitsUpdated")
        .withArgs(USDC(100), USDC(500), 3);
      expect(await integrator.txLimit()).to.equal(USDC(100));

      await integrator.setLimits(TX_CEIL, VOL_CEIL, COUNT_CEIL); // back to ceiling: ok
    });

    it("cannot raise any limit above its immutable ceiling", async function () {
      await expect(
        integrator.setLimits(TX_CEIL + 1n, VOL_CEIL, COUNT_CEIL)
      ).to.be.revertedWithCustomError(integrator, "LimitAboveCeiling");
      await expect(
        integrator.setLimits(TX_CEIL, VOL_CEIL + 1n, COUNT_CEIL)
      ).to.be.revertedWithCustomError(integrator, "LimitAboveCeiling");
      await expect(
        integrator.setLimits(TX_CEIL, VOL_CEIL, COUNT_CEIL + 1n)
      ).to.be.revertedWithCustomError(integrator, "LimitAboveCeiling");
    });

    it("non-owner cannot set limits", async function () {
      await expect(integrator.connect(attacker).setLimits(1, 1, 1)).to.be.revertedWithCustomError(
        integrator,
        "OnlyOwner"
      );
    });
  });

  describe("proxy derivation", function () {
    it("proxyAddress is deterministic and stable", async function () {
      const p1 = await integrator.proxyAddress(walletA.address);
      const p2 = await integrator.proxyAddress(walletA.address);
      expect(p1).to.equal(p2);
      expect(p1).to.not.equal(await integrator.proxyAddress(walletB.address));
    });
  });

  describe("validateOrder", function () {
    let dia: SignerWithAddress;
    beforeEach(async function () {
      dia = await diamondSigner();
      await integrator.addAccount(walletA.address);
    });

    it("only the diamond can call it", async function () {
      await expect(
        integrator.connect(attacker).validateOrder(walletA.address, USDC(1), INR)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
    });

    it("rejects non-whitelisted users", async function () {
      await expect(
        integrator.connect(dia).validateOrder(attacker.address, USDC(1), INR)
      ).to.be.revertedWithCustomError(integrator, "NotWhitelisted");
    });

    it("accepts a whitelisted wallet and debits daily accounting", async function () {
      await integrator.connect(dia).validateOrder.staticCall(walletA.address, USDC(100), INR);
      await integrator.connect(dia).validateOrder(walletA.address, USDC(100), INR);
      const day = BigInt(Math.floor((await ethers.provider.getBlock("latest"))!.timestamp / DAY));
      expect(await integrator.dailyVolume(walletA.address, day)).to.equal(USDC(100));
      expect(await integrator.dailyCount(walletA.address, day)).to.equal(1n);
    });

    it("enforces the per-tx limit", async function () {
      await expect(
        integrator.connect(dia).validateOrder(walletA.address, TX_CEIL + 1n, INR)
      ).to.be.revertedWithCustomError(integrator, "TxLimitExceeded");
    });

    it("enforces the daily volume limit across orders", async function () {
      // 5 x 1000 = the 5000 ceiling; a 6th tx of 1 must fail.
      for (let i = 0; i < 5; i++) {
        await integrator.connect(dia).validateOrder(walletA.address, USDC(1000), INR);
      }
      await expect(
        integrator.connect(dia).validateOrder(walletA.address, USDC(1), INR)
      ).to.be.revertedWithCustomError(integrator, "DailyVolumeExceeded");
    });

    it("enforces the daily count limit", async function () {
      await integrator.setLimits(USDC(1), VOL_CEIL, 2);
      await integrator.connect(dia).validateOrder(walletA.address, USDC(1), INR);
      await integrator.connect(dia).validateOrder(walletA.address, USDC(1), INR);
      await expect(
        integrator.connect(dia).validateOrder(walletA.address, USDC(1), INR)
      ).to.be.revertedWithCustomError(integrator, "DailyCountExceeded");
    });

    it("day rollover resets the buckets", async function () {
      await integrator.setLimits(USDC(1000), USDC(1000), 1);
      await integrator.connect(dia).validateOrder(walletA.address, USDC(1000), INR);
      await ethers.provider.send("evm_increaseTime", [DAY]);
      await ethers.provider.send("evm_mine", []);
      await integrator.connect(dia).validateOrder(walletA.address, USDC(1000), INR); // fresh day: ok
    });

    it("removing an account blocks further orders", async function () {
      await integrator.removeAccount(walletA.address);
      await expect(
        integrator.connect(dia).validateOrder(walletA.address, USDC(1), INR)
      ).to.be.revertedWithCustomError(integrator, "NotWhitelisted");
    });
  });
});
