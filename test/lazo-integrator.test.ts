import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  USDC,
  ARS,
  CIRCLE_ID,
  PUBKEY,
  DAY,
  FEE_BPS,
  FEE_FIXED,
  RETENTION,
  PER_TX_LIMIT,
  VENDOR_DAILY_VOLUME,
  CEILINGS,
  feeOf,
  actors,
  Actors,
  deployIntegrator,
  deployStack,
  escrowOf,
  placeOrder,
  placeAndComplete,
  invariant,
  asDiamond,
  transfersIn,
  expectCallFailedWith,
  mutableFunctions,
} from "./lazo-fixtures";

/**
 * LazoCheckoutIntegrator — a per-vendor escrow with retention, and the fee
 * charged on release.
 *
 *  - No refund, no hold: the only exit from an escrow is `release`,
 *    permissionless, which pays net → vendor and fee → fee wallet (read from
 *    the integrator at release time).
 *  - Each record snapshots its fee (`feeBps` + `feeFixed`) and its
 *    `unlockAt`: changing the fee or the retention is never retroactive.
 *  - `release` tolerates already-released orders (keeper and vendor may race).
 *  - Roles owner (a Safe, via constructor) / operator (hot key), entrance
 *    pause, vendor blocking, USDC blacklist and limits under immutable
 *    ceilings — all at the entrance, nothing over recorded funds.
 */
describe("LazoCheckoutIntegrator", function () {
  let A: Actors;
  let usdc: any;
  let diamond: any;
  let integrator: any;

  async function blockTs(receipt: any): Promise<number> {
    return (await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp;
  }

  beforeEach(async function () {
    A = await actors();
    ({ u: usdc, d: diamond, i: integrator } = await deployStack());
  });

  // ──────────────────────────────────────────────────────────────────
  describe("vendor onboarding and constructor", function () {
    it("registerVendor deploys the escrow at the predicted address, with the right immutable args", async function () {
      const predicted = await integrator.escrowAddress(A.v1.address);
      expect(await ethers.provider.getCode(predicted)).to.equal("0x");

      await expect(integrator.connect(A.stranger).registerVendor(A.v1.address))
        .to.emit(integrator, "VendorEscrowDeployed")
        .withArgs(A.v1.address, predicted);

      const esc = await escrowOf(integrator, A.v1.address);
      expect(await esc.vendor()).to.equal(A.v1.address);
      expect(await esc.integrator()).to.equal(await integrator.getAddress());
      expect(await esc.usdc()).to.equal(await usdc.getAddress());
      expect(await esc.pendingGross()).to.equal(0n);
    });

    it("registerVendor is idempotent and rejects address(0)", async function () {
      await integrator.registerVendor(A.v1.address);
      await expect(integrator.registerVendor(A.v1.address)).to.not.emit(
        integrator,
        "VendorEscrowDeployed"
      );
      await expect(integrator.registerVendor(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        integrator,
        "InvalidVendor"
      );
    });

    it("userPlaceOrder deploys a missing escrow BEFORE the order reaches the Diamond", async function () {
      const predicted = await integrator.escrowAddress(A.v1.address);
      await expect(
        integrator
          .connect(A.buyer1)
          .userPlaceOrder(A.v1.address, USDC(10), ARS, CIRCLE_ID, PUBKEY, 0, 0)
      )
        .to.emit(integrator, "VendorEscrowDeployed")
        .withArgs(A.v1.address, predicted);
      expect(await ethers.provider.getCode(predicted)).to.not.equal("0x");
    });

    it("each vendor gets its own escrow, and none collides with the UserProxy of the same address", async function () {
      const e1 = await integrator.escrowAddress(A.v1.address);
      const e2 = await integrator.escrowAddress(A.v2.address);
      expect(e1).to.not.equal(e2);
      expect(e1).to.not.equal(await integrator.proxyAddress(A.v1.address));
    });

    it("the owner is the one passed to the constructor (the Safe), not the deployer", async function () {
      expect(await integrator.owner()).to.equal(A.owner.address);
      expect(await integrator.owner()).to.not.equal(A.deployer.address);
      expect(await integrator.pendingOwner()).to.equal(ethers.ZeroAddress);
      expect(await integrator.operator()).to.equal(A.operator.address);
      expect(await integrator.feeWallet()).to.equal(A.feeWallet.address);
      await expect(integrator.connect(A.deployer).setFeeBps(1)).to.be.revertedWithCustomError(
        integrator,
        "OwnableUnauthorizedAccount"
      );
    });

    it("the constructor stores config and ceilings, and deploys the UserProxy and VendorEscrow impls", async function () {
      expect(await integrator.feeBps()).to.equal(FEE_BPS);
      expect(await integrator.defaultRetention()).to.equal(RETENTION);
      expect(await integrator.perTxLimit()).to.equal(PER_TX_LIMIT);
      expect(await integrator.vendorDailyVolumeLimit()).to.equal(VENDOR_DAILY_VOLUME);
      expect(await integrator.MAX_FEE_BPS()).to.equal(CEILINGS.maxFeeBps);
      expect(await integrator.MAX_PER_TX_LIMIT()).to.equal(CEILINGS.maxPerTxLimit);
      expect(await integrator.MAX_DAILY_TX_COUNT_LIMIT()).to.equal(CEILINGS.maxDailyTxCountLimit);
      expect(await integrator.MAX_VENDOR_DAILY_VOLUME_LIMIT()).to.equal(
        CEILINGS.maxVendorDailyVolumeLimit
      );
      expect(await integrator.MAX_RETENTION()).to.equal(30 * DAY);
      expect(await ethers.provider.getCode(await integrator.proxyImpl())).to.not.equal("0x");
      expect(await ethers.provider.getCode(await integrator.escrowImpl())).to.not.equal("0x");
    });

    it("the constructor rejects out-of-range ceilings and values", async function () {
      const d = await diamond.getAddress();
      const u = await usdc.getAddress();
      const o = A.owner.address;
      await expect(
        deployIntegrator(d, u, o, {}, { maxFeeBps: 2001n })
      ).to.be.revertedWithCustomError(integrator, "FeeTooHigh");
      await expect(deployIntegrator(d, u, o, { feeBps: 2000 }, { maxFeeBps: 2000n })).to.not.be
        .reverted;
      await expect(deployIntegrator(d, u, o, { feeBps: 1001 })).to.be.revertedWithCustomError(
        integrator,
        "FeeTooHigh"
      );
      await expect(
        deployIntegrator(d, u, o, { defaultRetention: 30 * DAY + 1 })
      ).to.be.revertedWithCustomError(integrator, "RetentionTooLong");
      await expect(
        deployIntegrator(d, u, o, { perTxLimit: CEILINGS.maxPerTxLimit + 1n })
      ).to.be.revertedWithCustomError(integrator, "LimitTooHigh");
      await expect(
        deployIntegrator(d, u, o, { dailyTxCountLimit: CEILINGS.maxDailyTxCountLimit + 1n })
      ).to.be.revertedWithCustomError(integrator, "LimitTooHigh");
      await expect(
        deployIntegrator(d, u, o, {
          vendorDailyVolumeLimit: CEILINGS.maxVendorDailyVolumeLimit + 1n,
        })
      ).to.be.revertedWithCustomError(integrator, "LimitTooHigh");
    });

    it("the constructor rejects zero addresses, a zero owner and invalid fee wallets (0, USDC, the integrator itself)", async function () {
      const d = await diamond.getAddress();
      const u = await usdc.getAddress();
      const o = A.owner.address;
      await expect(deployIntegrator(ethers.ZeroAddress, u, o)).to.be.revertedWithCustomError(
        integrator,
        "InvalidAddress"
      );
      await expect(deployIntegrator(d, ethers.ZeroAddress, o)).to.be.revertedWithCustomError(
        integrator,
        "InvalidAddress"
      );
      await expect(deployIntegrator(d, u, ethers.ZeroAddress)).to.be.revertedWithCustomError(
        integrator,
        "OwnableInvalidOwner"
      );
      await expect(
        deployIntegrator(d, u, o, { feeWallet: ethers.ZeroAddress })
      ).to.be.revertedWithCustomError(integrator, "InvalidFeeWallet");
      await expect(deployIntegrator(d, u, o, { feeWallet: u })).to.be.revertedWithCustomError(
        integrator,
        "InvalidFeeWallet"
      );
      // The integrator's own address is predicted from the deployer's nonce.
      const nonce = await ethers.provider.getTransactionCount(A.deployer.address);
      const self = ethers.getCreateAddress({ from: A.deployer.address, nonce });
      await expect(deployIntegrator(d, u, o, { feeWallet: self })).to.be.revertedWithCustomError(
        integrator,
        "InvalidFeeWallet"
      );
    });

    it("rejects amount = 0 and vendor = address(0)", async function () {
      await expect(
        integrator.connect(A.buyer1).userPlaceOrder(A.v1.address, 0, ARS, CIRCLE_ID, PUBKEY, 0, 0)
      ).to.be.revertedWithCustomError(integrator, "InvalidAmount");
      await expect(
        integrator
          .connect(A.buyer1)
          .userPlaceOrder(ethers.ZeroAddress, USDC(1), ARS, CIRCLE_ID, PUBKEY, 0, 0)
      ).to.be.revertedWithCustomError(integrator, "InvalidVendor");
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe("happy path", function () {
    it("on completion the Diamond pays the vendor's escrow DIRECTLY; onOrderComplete only records, with the fee and unlockAt", async function () {
      const orderId = await placeOrder(integrator, A.buyer1, A.v1.address, USDC(100));
      const esc = await escrowOf(integrator, A.v1.address);

      const tx = diamond.simulateOrderComplete(orderId);
      const receipt = await (await tx).wait();
      const unlockAt = BigInt((await blockTs(receipt)) + RETENTION);

      await expect(tx)
        .to.emit(integrator, "OrderCompleted")
        .withArgs(
          orderId,
          A.v1.address,
          await esc.getAddress(),
          A.buyer1.address,
          USDC(100),
          FEE_BPS,
          FEE_FIXED,
          unlockAt
        );
      await expect(tx)
        .to.emit(esc, "Recorded")
        .withArgs(orderId, USDC(100), FEE_BPS, FEE_FIXED, unlockAt);

      const transfers = transfersIn(receipt, usdc);
      expect(transfers.length).to.equal(1);
      expect(transfers[0].args.from).to.equal(await diamond.getAddress());
      expect(transfers[0].args.to).to.equal(await esc.getAddress());

      expect(await usdc.balanceOf(await integrator.getAddress())).to.equal(0n);
      expect(await usdc.balanceOf(await esc.getAddress())).to.equal(USDC(100));

      const r = await esc.getRecord(orderId);
      expect(r.gross).to.equal(USDC(100));
      expect(r.feeBps).to.equal(FEE_BPS);
      expect(r.unlockAt).to.equal(unlockAt);
      expect(r.released).to.equal(false);
      expect(await esc.pendingGross()).to.equal(USDC(100));
      expect((await integrator.getOrder(orderId)).completed).to.equal(true);
    });

    it("after unlock, release pays net to the vendor and fee to the fee wallet, exactly, on odd amounts; the escrow ends at 0", async function () {
      const esc = await escrowOf(integrator, A.v1.address);
      const amounts = [USDC(100), USDC(1), 1234567n, 999999999n, 19n, 1n, USDC(9999)];
      for (const amount of amounts) {
        const orderId = await placeAndComplete(diamond, integrator, A.buyer1, A.v1.address, amount);
        await time.increase(RETENTION + 1);

        const vBefore = await usdc.balanceOf(A.v1.address);
        const fBefore = await usdc.balanceOf(A.feeWallet.address);
        const fee = feeOf(amount);
        const net = amount - fee;
        await expect(esc.release([orderId]))
          .to.emit(esc, "Released")
          .withArgs(orderId, net, fee);

        expect(fee + net).to.equal(amount);
        expect((await usdc.balanceOf(A.v1.address)) - vBefore).to.equal(net);
        expect((await usdc.balanceOf(A.feeWallet.address)) - fBefore).to.equal(fee);
        await invariant(integrator, usdc, [A.v1.address]);
      }
      // Everything that came in went out: the escrow ends at exactly zero, no dust.
      expect(await usdc.balanceOf(await esc.getAddress())).to.equal(0n);
      expect(await esc.pendingGross()).to.equal(0n);
    });

    it("rounding goes against the integrator: 19 units at 5% is a zero fee and the vendor gets it all", async function () {
      const orderId = await placeAndComplete(diamond, integrator, A.buyer1, A.v1.address, 19n);
      await time.increase(RETENTION + 1);
      const esc = await escrowOf(integrator, A.v1.address);
      const receipt = await (await esc.release([orderId])).wait();
      // fee = 19 * 500 / 10000 = 0 → a single transfer.
      expect(transfersIn(receipt, usdc).length).to.equal(1);
      expect(await usdc.balanceOf(A.v1.address)).to.equal(19n);
    });

    it("feeBps = 0: the vendor gets 100% in a SINGLE transfer", async function () {
      const { u, d, i } = await deployStack({ cfg: { feeBps: 0 } });
      const orderId = await placeAndComplete(d, i, A.buyer1, A.v1.address, USDC(250));
      await time.increase(RETENTION + 1);

      const esc = await escrowOf(i, A.v1.address);
      const receipt = await (await esc.release([orderId])).wait();
      const transfers = transfersIn(receipt, u);
      expect(transfers.length).to.equal(1);
      expect(transfers[0].args.to).to.equal(A.v1.address);
      expect(await u.balanceOf(A.v1.address)).to.equal(USDC(250));
      expect(await u.balanceOf(A.feeWallet.address)).to.equal(0n);
    });

    it("before unlock, release reverts StillLocked", async function () {
      const orderId = await placeAndComplete(
        diamond,
        integrator,
        A.buyer1,
        A.v1.address,
        USDC(100)
      );
      const esc = await escrowOf(integrator, A.v1.address);
      await expect(esc.release([orderId])).to.be.revertedWithCustomError(esc, "StillLocked");
    });

    it("anyone can trigger release, but payment always goes to the clone's vendor and the fee wallet", async function () {
      const orderId = await placeAndComplete(
        diamond,
        integrator,
        A.buyer1,
        A.v1.address,
        USDC(100)
      );
      await time.increase(RETENTION + 1);
      const esc = await escrowOf(integrator, A.v1.address);

      const strangerBefore = await usdc.balanceOf(A.stranger.address);
      await esc.connect(A.stranger).release([orderId]);
      expect(await usdc.balanceOf(A.v1.address)).to.equal(USDC(100) - feeOf(USDC(100)));
      expect(await usdc.balanceOf(A.feeWallet.address)).to.equal(feeOf(USDC(100)));
      expect(await usdc.balanceOf(A.stranger.address)).to.equal(strangerBefore);
    });

    it("release([]) is a no-op with no transfers", async function () {
      await integrator.registerVendor(A.v1.address);
      const esc = await escrowOf(integrator, A.v1.address);
      const receipt = await (await esc.release([])).wait();
      expect(transfersIn(receipt, usdc).length).to.equal(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe("fee — snapshot per record", function () {
    it("changing feeBps is not retroactive: each order is charged the feeBps in force at completion", async function () {
      const idA = await placeAndComplete(diamond, integrator, A.buyer1, A.v1.address, USDC(1000));
      await expect(integrator.connect(A.owner).setFeeBps(100))
        .to.emit(integrator, "FeeBpsUpdated")
        .withArgs(100);
      // Placed BEFORE the change but completed AFTER it: completion time wins.
      const idB = await placeOrder(integrator, A.buyer1, A.v1.address, USDC(1000));
      await integrator.connect(A.owner).setFeeBps(300);
      await diamond.simulateOrderComplete(idB);

      const esc = await escrowOf(integrator, A.v1.address);
      expect((await esc.getRecord(idA)).feeBps).to.equal(FEE_BPS);
      expect((await esc.getRecord(idB)).feeBps).to.equal(300n);

      await time.increase(RETENTION + 1);
      await expect(esc.release([idA, idB]))
        .to.emit(esc, "Released")
        .withArgs(idA, USDC(1000) - feeOf(USDC(1000), 500n), feeOf(USDC(1000), 500n))
        .and.to.emit(esc, "Released")
        .withArgs(idB, USDC(1000) - feeOf(USDC(1000), 300n), feeOf(USDC(1000), 300n));
      expect(await usdc.balanceOf(A.feeWallet.address)).to.equal(USDC(50) + USDC(30));
    });

    it("setFeeBps honours the immutable ceiling MAX_FEE_BPS", async function () {
      await expect(
        integrator.connect(A.owner).setFeeBps(CEILINGS.maxFeeBps + 1n)
      ).to.be.revertedWithCustomError(integrator, "FeeTooHigh");
      await integrator.connect(A.owner).setFeeBps(CEILINGS.maxFeeBps);
      expect(await integrator.feeBps()).to.equal(CEILINGS.maxFeeBps);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe("fixed fee, floors and per-vendor percentage", function () {
    // Production values: 4.5% + 0.1 USDC, percentage within [1%, 5%], fixed
    // part within [0.1, 2] USDC.
    const REAL = { feeBps: 450n, feeFixed: USDC("0.1") };
    const BOUNDS = {
      minFeeBps: 100n,
      maxFeeBps: 500n,
      minFeeFixed: USDC("0.1"),
      maxFeeFixed: USDC(2),
    };
    const feeReal = (amount: bigint, bps = REAL.feeBps, fixed = REAL.feeFixed) =>
      fixed + (amount * bps) / 10_000n;

    let u: any, d: any, i: any;
    beforeEach(async function () {
      ({ u, d, i } = await deployStack({ cfg: REAL, ceilings: BOUNDS }));
    });

    it("100 USDC at 4.5% + 0.1: fee 4.6 and net 95.4, exactly; the record stores both", async function () {
      const orderId = await placeOrder(i, A.buyer1, A.v1.address, USDC(100));
      const esc = await escrowOf(i, A.v1.address);
      await expect(d.simulateOrderComplete(orderId))
        .to.emit(esc, "Recorded")
        .withArgs(orderId, USDC(100), REAL.feeBps, REAL.feeFixed, (x: bigint) => x > 0n);
      const r = await esc.getRecord(orderId);
      expect(r.feeBps).to.equal(REAL.feeBps);
      expect(r.feeFixed).to.equal(REAL.feeFixed);

      await time.increase(RETENTION + 1);
      await expect(esc.release([orderId]))
        .to.emit(esc, "Released")
        .withArgs(orderId, USDC("95.4"), USDC("4.6"));
      expect(await u.balanceOf(A.v1.address)).to.equal(USDC("95.4"));
      expect(await u.balanceOf(A.feeWallet.address)).to.equal(USDC("4.6"));
      expect(await u.balanceOf(await esc.getAddress())).to.equal(0n);
    });

    it("odd amounts: fee + net == gross always, and the fixed part is charged on every order of a batch", async function () {
      const esc = await escrowOf(i, A.v1.address);
      const amounts = [USDC(1), 1234567n, 999999999n, USDC(9999)];
      const ids: bigint[] = [];
      for (const m of amounts) ids.push(await placeAndComplete(d, i, A.buyer1, A.v1.address, m));
      await time.increase(RETENTION + 1);
      await esc.release(ids);
      const totalFee = amounts.reduce((acc, m) => acc + feeReal(m), 0n);
      const total = amounts.reduce((acc, m) => acc + m, 0n);
      expect(await u.balanceOf(A.feeWallet.address)).to.equal(totalFee);
      expect(await u.balanceOf(A.v1.address)).to.equal(total - totalFee);
      expect(await u.balanceOf(await esc.getAddress())).to.equal(0n);
    });

    it("the constructor requires defaults within [floor, ceiling] and floor <= ceiling", async function () {
      const [dd, uu, o] = [await d.getAddress(), await u.getAddress(), A.owner.address];
      await expect(
        deployIntegrator(dd, uu, o, { ...REAL, feeBps: 99 }, BOUNDS)
      ).to.be.revertedWithCustomError(i, "FeeTooLow");
      await expect(
        deployIntegrator(dd, uu, o, { ...REAL, feeBps: 501 }, BOUNDS)
      ).to.be.revertedWithCustomError(i, "FeeTooHigh");
      await expect(
        deployIntegrator(dd, uu, o, { ...REAL, feeFixed: USDC("0.1") - 1n }, BOUNDS)
      ).to.be.revertedWithCustomError(i, "FeeTooLow");
      await expect(
        deployIntegrator(dd, uu, o, { ...REAL, feeFixed: USDC(2) + 1n }, BOUNDS)
      ).to.be.revertedWithCustomError(i, "FeeTooHigh");
      await expect(
        deployIntegrator(dd, uu, o, REAL, { ...BOUNDS, maxFeeFixed: USDC(5) + 1n })
      ).to.be.revertedWithCustomError(i, "FeeTooHigh");
      await expect(
        deployIntegrator(dd, uu, o, REAL, { ...BOUNDS, minFeeBps: 501n })
      ).to.be.revertedWithCustomError(i, "InvalidFeeBounds");
      await expect(
        deployIntegrator(dd, uu, o, REAL, { ...BOUNDS, minFeeFixed: USDC(3) })
      ).to.be.revertedWithCustomError(i, "InvalidFeeBounds");
      expect(await i.MIN_FEE_BPS()).to.equal(100n);
      expect(await i.MAX_FEE_BPS()).to.equal(500n);
      expect(await i.MIN_FEE_FIXED()).to.equal(USDC("0.1"));
      expect(await i.MAX_FEE_FIXED()).to.equal(USDC(2));
    });

    it("setFeeBps and setFeeFixed honour the immutable floor and ceiling", async function () {
      await expect(i.connect(A.owner).setFeeBps(99)).to.be.revertedWithCustomError(i, "FeeTooLow");
      await expect(i.connect(A.owner).setFeeBps(501)).to.be.revertedWithCustomError(
        i,
        "FeeTooHigh"
      );
      await expect(i.connect(A.owner).setFeeFixed(USDC("0.1") - 1n)).to.be.revertedWithCustomError(
        i,
        "FeeTooLow"
      );
      await expect(i.connect(A.owner).setFeeFixed(USDC(2) + 1n)).to.be.revertedWithCustomError(
        i,
        "FeeTooHigh"
      );
      await expect(i.connect(A.owner).setFeeFixed(USDC(2)))
        .to.emit(i, "FeeFixedUpdated")
        .withArgs(USDC(2));
      expect(await i.feeFixed()).to.equal(USDC(2));
    });

    it("changing the fixed fee is not retroactive: each order is charged the one in force at completion", async function () {
      const idA = await placeAndComplete(d, i, A.buyer1, A.v1.address, USDC(100));
      await i.connect(A.owner).setFeeFixed(USDC(1));
      const idB = await placeAndComplete(d, i, A.buyer1, A.v1.address, USDC(100));
      const esc = await escrowOf(i, A.v1.address);
      expect((await esc.getRecord(idA)).feeFixed).to.equal(USDC("0.1"));
      expect((await esc.getRecord(idB)).feeFixed).to.equal(USDC(1));
      await time.increase(RETENTION + 1);
      await esc.release([idA, idB]);
      expect(await u.balanceOf(A.feeWallet.address)).to.equal(
        feeReal(USDC(100)) + feeReal(USDC(100), REAL.feeBps, USDC(1))
      );
    });

    it("per-vendor override: affects only that vendor, honours the bounds and can be removed", async function () {
      await expect(
        i.connect(A.owner).setVendorFeeBps(A.v1.address, true, 99)
      ).to.be.revertedWithCustomError(i, "FeeTooLow");
      await expect(
        i.connect(A.owner).setVendorFeeBps(A.v1.address, true, 501)
      ).to.be.revertedWithCustomError(i, "FeeTooHigh");
      await expect(i.connect(A.owner).setVendorFeeBps(A.v1.address, true, 200))
        .to.emit(i, "VendorFeeBpsUpdated")
        .withArgs(A.v1.address, true, 200);
      expect(await i.feeBpsOf(A.v1.address)).to.equal(200n);
      expect(await i.feeBpsOf(A.v2.address)).to.equal(REAL.feeBps);

      const id1 = await placeAndComplete(d, i, A.buyer1, A.v1.address, USDC(100));
      const id2 = await placeAndComplete(d, i, A.buyer1, A.v2.address, USDC(100));
      expect((await (await escrowOf(i, A.v1.address)).getRecord(id1)).feeBps).to.equal(200n);
      expect((await (await escrowOf(i, A.v2.address)).getRecord(id2)).feeBps).to.equal(REAL.feeBps);

      // Removing it falls back to the default and leaves recorded orders alone.
      await expect(i.connect(A.owner).setVendorFeeBps(A.v1.address, false, 0))
        .to.emit(i, "VendorFeeBpsUpdated")
        .withArgs(A.v1.address, false, 0);
      expect(await i.feeBpsOf(A.v1.address)).to.equal(REAL.feeBps);
      expect((await (await escrowOf(i, A.v1.address)).getRecord(id1)).feeBps).to.equal(200n);

      await time.increase(RETENTION + 1);
      await (await escrowOf(i, A.v1.address)).release([id1]);
      expect(await u.balanceOf(A.v1.address)).to.equal(USDC(100) - feeReal(USDC(100), 200n));
    });

    it("an order that would leave the vendor nothing reverts AmountBelowFee", async function () {
      // 0.1 + 4.5% of x >= x  ⇔  x <= ~0.10471 USDC
      const place = (vendor: string, amount: bigint) =>
        i.connect(A.buyer1).userPlaceOrder(vendor, amount, ARS, CIRCLE_ID, PUBKEY, 0, 0);
      await expect(place(A.v1.address, USDC("0.1"))).to.be.revertedWithCustomError(
        i,
        "AmountBelowFee"
      );
      await expect(place(A.v1.address, 104712n)).to.be.revertedWithCustomError(i, "AmountBelowFee");
      await expect(place(A.v1.address, 104713n)).to.not.be.reverted;
      // With an override, the minimum follows that vendor's percentage.
      await i.connect(A.owner).setVendorFeeBps(A.v2.address, true, 100);
      await expect(place(A.v2.address, 101011n)).to.not.be.reverted;
    });

    it("if the fixed fee rises between placement and completion, the fee is capped at gross: the vendor gets 0 and nothing reverts", async function () {
      const orderId = await placeOrder(i, A.buyer1, A.v1.address, USDC(1));
      await i.connect(A.owner).setFeeFixed(USDC(2));
      await d.simulateOrderComplete(orderId);
      await time.increase(RETENTION + 1);
      const esc = await escrowOf(i, A.v1.address);
      const receipt = await (await esc.release([orderId])).wait();
      const transfers = transfersIn(receipt, u);
      expect(transfers.length).to.equal(1);
      expect(transfers[0].args.to).to.equal(A.feeWallet.address);
      expect(await u.balanceOf(A.feeWallet.address)).to.equal(USDC(1));
      expect(await u.balanceOf(A.v1.address)).to.equal(0n);
      expect(await esc.pendingGross()).to.equal(0n);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe("retention", function () {
    it("default 0: the order can be released in the block after completion", async function () {
      const { u, d, i } = await deployStack({ cfg: { defaultRetention: 0 } });
      expect(await i.retentionOf(A.v1.address)).to.equal(0n);
      const orderId = await placeOrder(i, A.buyer1, A.v1.address, USDC(100));
      const receipt = await (await d.simulateOrderComplete(orderId)).wait();
      const esc = await escrowOf(i, A.v1.address);
      expect((await esc.getRecord(orderId)).unlockAt).to.equal(BigInt(await blockTs(receipt)));
      await esc.release([orderId]);
      expect(await u.balanceOf(A.v1.address)).to.equal(USDC(95));
    });

    it("per-vendor override: V1 has its own retention, V2 follows the default", async function () {
      await expect(integrator.connect(A.owner).setVendorRetention(A.v1.address, true, 2 * DAY))
        .to.emit(integrator, "VendorRetentionUpdated")
        .withArgs(A.v1.address, true, 2 * DAY);
      expect(await integrator.retentionOf(A.v1.address)).to.equal(2 * DAY);
      expect(await integrator.retentionOf(A.v2.address)).to.equal(RETENTION);

      const id1 = await placeAndComplete(diamond, integrator, A.buyer1, A.v1.address, USDC(10));
      const id2 = await placeAndComplete(diamond, integrator, A.buyer2, A.v2.address, USDC(10));
      await time.increase(RETENTION + 1);
      const e1 = await escrowOf(integrator, A.v1.address);
      const e2 = await escrowOf(integrator, A.v2.address);
      await e2.release([id2]);
      await expect(e1.release([id1])).to.be.revertedWithCustomError(e1, "StillLocked");
      await time.increase(2 * DAY);
      await e1.release([id1]);
    });

    it("a zero override removes a vendor's retention even when the default is higher", async function () {
      await integrator.connect(A.owner).setVendorRetention(A.v1.address, true, 0);
      expect(await integrator.retentionOf(A.v1.address)).to.equal(0n);
      const id = await placeAndComplete(diamond, integrator, A.buyer1, A.v1.address, USDC(10));
      await (await escrowOf(integrator, A.v1.address)).release([id]);
    });

    it("custom = false clears the override and the vendor follows the default again", async function () {
      await integrator.connect(A.owner).setVendorRetention(A.v1.address, true, 5 * DAY);
      await expect(integrator.connect(A.owner).setVendorRetention(A.v1.address, false, 5 * DAY))
        .to.emit(integrator, "VendorRetentionUpdated")
        .withArgs(A.v1.address, false, 0);
      expect(await integrator.retentionOf(A.v1.address)).to.equal(RETENTION);
      const cfg = await integrator.vendorConfig(A.v1.address);
      expect(cfg.customRetention).to.equal(false);
      expect(cfg.retention).to.equal(0n);
    });

    it("immutable 30-day ceiling, on the default and on the override", async function () {
      await expect(integrator.connect(A.owner).setDefaultRetention(30 * DAY))
        .to.emit(integrator, "DefaultRetentionUpdated")
        .withArgs(30 * DAY);
      await expect(
        integrator.connect(A.owner).setDefaultRetention(30 * DAY + 1)
      ).to.be.revertedWithCustomError(integrator, "RetentionTooLong");
      await expect(
        integrator.connect(A.owner).setVendorRetention(A.v1.address, true, 30 * DAY + 1)
      ).to.be.revertedWithCustomError(integrator, "RetentionTooLong");
    });

    it("changing the retention only affects new orders: each record keeps its unlockAt", async function () {
      const idA = await placeAndComplete(diamond, integrator, A.buyer1, A.v1.address, USDC(10));
      const esc = await escrowOf(integrator, A.v1.address);
      const unlockA = (await esc.getRecord(idA)).unlockAt;

      await integrator.connect(A.owner).setDefaultRetention(7 * DAY);
      expect((await esc.getRecord(idA)).unlockAt).to.equal(unlockA);
      const idB = await placeAndComplete(diamond, integrator, A.buyer1, A.v1.address, USDC(10));

      await time.increase(RETENTION + 1);
      await esc.release([idA]);
      await expect(esc.release([idB])).to.be.revertedWithCustomError(esc, "StillLocked");
    });

    it("lowering the retention makes unlocks non-monotonic: a newer order unlocks before an older one", async function () {
      await integrator.connect(A.owner).setDefaultRetention(2 * DAY);
      const older = await placeAndComplete(diamond, integrator, A.buyer1, A.v1.address, USDC(10));
      await integrator.connect(A.owner).setDefaultRetention(0);
      const newer = await placeAndComplete(diamond, integrator, A.buyer1, A.v1.address, USDC(20));

      const esc = await escrowOf(integrator, A.v1.address);
      expect((await esc.getRecord(newer)).unlockAt).to.be.lessThan(
        (await esc.getRecord(older)).unlockAt
      );

      // A batch including the older one reverts entirely; the newer one alone goes through.
      await expect(esc.release([newer, older])).to.be.revertedWithCustomError(esc, "StillLocked");
      await esc.release([newer]);
      expect(await usdc.balanceOf(A.v1.address)).to.equal(USDC(20) - feeOf(USDC(20)));
      await expect(esc.release([older])).to.be.revertedWithCustomError(esc, "StillLocked");
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe("release — tolerant of released ids, strict about everything else", function () {
    it("an already-released order is skipped, without reverting or paying again", async function () {
      const id = await placeAndComplete(diamond, integrator, A.buyer1, A.v1.address, USDC(100));
      await time.increase(RETENTION + 1);
      const esc = await escrowOf(integrator, A.v1.address);
      await esc.release([id]);
      const receipt = await (await esc.release([id])).wait();
      expect(transfersIn(receipt, usdc).length).to.equal(0);
      expect(await usdc.balanceOf(A.v1.address)).to.equal(USDC(95));
    });

    it("an id repeated within one call is paid once", async function () {
      const idA = await placeAndComplete(diamond, integrator, A.buyer1, A.v1.address, USDC(100));
      const idB = await placeAndComplete(diamond, integrator, A.buyer1, A.v1.address, USDC(60));
      await time.increase(RETENTION + 1);
      const esc = await escrowOf(integrator, A.v1.address);
      await esc.release([idA, idA, idB, idA]);
      expect(await usdc.balanceOf(A.v1.address)).to.equal(
        USDC(160) - feeOf(USDC(100)) - feeOf(USDC(60))
      );
      expect(await esc.pendingGross()).to.equal(0n);
      expect(await usdc.balanceOf(await esc.getAddress())).to.equal(0n);
    });

    it("keeper vs vendor race: the vendor releases one, the keeper's batch including it pays only the rest", async function () {
      const ids = [
        await placeAndComplete(diamond, integrator, A.buyer1, A.v1.address, USDC(10)),
        await placeAndComplete(diamond, integrator, A.buyer1, A.v1.address, USDC(20)),
        await placeAndComplete(diamond, integrator, A.buyer1, A.v1.address, USDC(30)),
      ];
      await time.increase(RETENTION + 1);
      const esc = await escrowOf(integrator, A.v1.address);

      await esc.connect(A.v1).release([ids[1]]);
      await expect(esc.connect(A.keeper).release(ids)).to.not.be.reverted;
      const total = USDC(60);
      const fees = feeOf(USDC(10)) + feeOf(USDC(20)) + feeOf(USDC(30));
      expect(await usdc.balanceOf(A.v1.address)).to.equal(total - fees);
      expect(await usdc.balanceOf(A.feeWallet.address)).to.equal(fees);
      expect(await usdc.balanceOf(await esc.getAddress())).to.equal(0n);
    });

    it("N orders of the same vendor settle in ONE tx, with a single transfer per destination", async function () {
      const N = 6;
      const ids: bigint[] = [];
      let total = 0n;
      let totalFee = 0n;
      for (let k = 0; k < N; k++) {
        const amount = USDC(10 + k) + BigInt(k * 7);
        ids.push(await placeAndComplete(diamond, integrator, A.buyer1, A.v1.address, amount));
        total += amount;
        totalFee += feeOf(amount);
      }
      await time.increase(RETENTION + 1);

      const esc = await escrowOf(integrator, A.v1.address);
      const receipt = await (await esc.release(ids)).wait();
      expect(transfersIn(receipt, usdc).length).to.equal(2); // net → vendor, fee → fee wallet

      expect(await usdc.balanceOf(A.v1.address)).to.equal(total - totalFee);
      expect(await usdc.balanceOf(A.feeWallet.address)).to.equal(totalFee);
      expect(await usdc.balanceOf(await esc.getAddress())).to.equal(0n);
      for (const id of ids) expect((await esc.getRecord(id)).released).to.equal(true);
    });

    it("a mixed batch (one unlocked, one not) reverts the WHOLE tx", async function () {
      const idA = await placeAndComplete(diamond, integrator, A.buyer1, A.v1.address, USDC(100));
      await time.increase(RETENTION + 1);
      const idB = await placeAndComplete(diamond, integrator, A.buyer1, A.v1.address, USDC(50));

      const esc = await escrowOf(integrator, A.v1.address);
      await expect(esc.release([idA, idB])).to.be.revertedWithCustomError(esc, "StillLocked");
      expect((await esc.getRecord(idA)).released).to.equal(false);
      expect(await usdc.balanceOf(A.v1.address)).to.equal(0n);
    });

    it("an unknown id reverts UnknownRecord, also when mixed with valid ids", async function () {
      const id = await placeAndComplete(diamond, integrator, A.buyer1, A.v1.address, USDC(100));
      await time.increase(RETENTION + 1);
      const esc = await escrowOf(integrator, A.v1.address);
      await expect(esc.release([999])).to.be.revertedWithCustomError(esc, "UnknownRecord");
      await expect(esc.release([id, 999])).to.be.revertedWithCustomError(esc, "UnknownRecord");
      expect((await esc.getRecord(id)).released).to.equal(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe("THE CORE PROPERTY — per-vendor segregation", function () {
    it("V1's and V2's money live in separate balances; the integrator holds zero", async function () {
      await placeAndComplete(diamond, integrator, A.buyer1, A.v1.address, USDC(100));
      await placeAndComplete(diamond, integrator, A.buyer2, A.v2.address, USDC(250));
      await placeAndComplete(diamond, integrator, A.buyer1, A.v1.address, USDC(40));

      const e1 = await escrowOf(integrator, A.v1.address);
      const e2 = await escrowOf(integrator, A.v2.address);
      expect(await usdc.balanceOf(await e1.getAddress())).to.equal(USDC(140));
      expect(await usdc.balanceOf(await e2.getAddress())).to.equal(USDC(250));
      expect(await e1.pendingGross()).to.equal(USDC(140));
      expect(await e2.pendingGross()).to.equal(USDC(250));
      expect(await usdc.balanceOf(await integrator.getAddress())).to.equal(0n);
    });

    it("V1's escrow does not know V2's orders: a batch with a foreign id reverts entirely", async function () {
      const id1 = await placeAndComplete(diamond, integrator, A.buyer1, A.v1.address, USDC(100));
      const id2 = await placeAndComplete(diamond, integrator, A.buyer2, A.v2.address, USDC(200));
      await time.increase(RETENTION + 1);

      const e1 = await escrowOf(integrator, A.v1.address);
      await expect(e1.release([id2])).to.be.revertedWithCustomError(e1, "UnknownRecord");
      await expect(e1.release([id1, id2])).to.be.revertedWithCustomError(e1, "UnknownRecord");

      expect(await usdc.balanceOf(await e1.getAddress())).to.equal(USDC(100));
      expect(await usdc.balanceOf(await integrator.escrowAddress(A.v2.address))).to.equal(
        USDC(200)
      );
    });

    it("V1's escrow frozen (its address blacklisted): V2 is paid as usual", async function () {
      const id1 = await placeAndComplete(diamond, integrator, A.buyer1, A.v1.address, USDC(100));
      const id2 = await placeAndComplete(diamond, integrator, A.buyer2, A.v2.address, USDC(200));
      await time.increase(RETENTION + 1);

      const e1 = await escrowOf(integrator, A.v1.address);
      const e2 = await escrowOf(integrator, A.v2.address);
      await usdc.blacklist(await e1.getAddress());

      await expect(e1.release([id1])).to.be.reverted;
      await e2.release([id2]);
      expect(await usdc.balanceOf(A.v2.address)).to.equal(USDC(200) - feeOf(USDC(200)));

      // In a pooled design, freezing the contract freezes everyone. Here, only V1.
      expect(await usdc.balanceOf(await e1.getAddress())).to.equal(USDC(100));
      expect((await e1.getRecord(id1)).released).to.equal(false);
    });

    it("only the integrator can call recordCompletion", async function () {
      await integrator.registerVendor(A.v1.address);
      const e1 = await escrowOf(integrator, A.v1.address);
      await expect(
        e1.connect(A.stranger).recordCompletion(1, USDC(1), 0, 0, 0)
      ).to.be.revertedWithCustomError(e1, "OnlyIntegrator");
      await expect(
        e1.connect(A.owner).recordCompletion(1, USDC(1), 0, 0, 0)
      ).to.be.revertedWithCustomError(e1, "OnlyIntegrator");
    });

    it("money that never arrived cannot be recorded: onOrderComplete with an empty escrow reverts Unfunded", async function () {
      const orderId = await placeOrder(integrator, A.buyer1, A.v1.address, USDC(100));
      const diamondSigner = await asDiamond(diamond);
      const e1 = await escrowOf(integrator, A.v1.address);
      await expect(
        integrator
          .connect(diamondSigner)
          .onOrderComplete(orderId, A.buyer1.address, USDC(100), await e1.getAddress())
      ).to.be.revertedWithCustomError(e1, "Unfunded");
    });

    it("a V1 record exceeding what V1 received is not covered, even if V2 holds plenty", async function () {
      await placeAndComplete(diamond, integrator, A.buyer2, A.v2.address, USDC(5000));
      const orderId = await placeOrder(integrator, A.buyer1, A.v1.address, USDC(100));
      const diamondSigner = await asDiamond(diamond);
      const e1 = await escrowOf(integrator, A.v1.address);

      // Each escrow checks against its own balance: no "borrowing" from V2.
      await usdc.mint(await e1.getAddress(), USDC(50));
      await expect(
        integrator
          .connect(diamondSigner)
          .onOrderComplete(orderId, A.buyer1.address, USDC(100), await e1.getAddress())
      ).to.be.revertedWithCustomError(e1, "Unfunded");
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe("fee wallet — two-step change", function () {
    it("propose + accept: the owner proposes, the new wallet accepts, and later fees go there", async function () {
      const idA = await placeAndComplete(diamond, integrator, A.buyer1, A.v1.address, USDC(100));
      await expect(integrator.connect(A.owner).proposeFeeWallet(A.newcomer.address))
        .to.emit(integrator, "FeeWalletProposed")
        .withArgs(A.newcomer.address);
      expect(await integrator.pendingFeeWallet()).to.equal(A.newcomer.address);
      // Proposing changes nothing yet.
      expect(await integrator.feeWallet()).to.equal(A.feeWallet.address);

      await expect(integrator.connect(A.newcomer).acceptFeeWallet())
        .to.emit(integrator, "FeeWalletUpdated")
        .withArgs(A.feeWallet.address, A.newcomer.address);
      expect(await integrator.feeWallet()).to.equal(A.newcomer.address);
      expect(await integrator.pendingFeeWallet()).to.equal(ethers.ZeroAddress);

      // An order recorded BEFORE the change still pays the wallet in force at release.
      await time.increase(RETENTION + 1);
      await (await escrowOf(integrator, A.v1.address)).release([idA]);
      expect(await usdc.balanceOf(A.newcomer.address)).to.equal(feeOf(USDC(100)));
      expect(await usdc.balanceOf(A.feeWallet.address)).to.equal(0n);
    });

    it("rejects address(0), the integrator itself and the USDC token", async function () {
      for (const bad of [
        ethers.ZeroAddress,
        await integrator.getAddress(),
        await usdc.getAddress(),
      ]) {
        await expect(
          integrator.connect(A.owner).proposeFeeWallet(bad)
        ).to.be.revertedWithCustomError(integrator, "InvalidFeeWallet");
      }
    });

    it("only the proposed wallet can accept; with no proposal nobody can", async function () {
      await expect(integrator.connect(A.newcomer).acceptFeeWallet()).to.be.revertedWithCustomError(
        integrator,
        "NotPendingFeeWallet"
      );
      await integrator.connect(A.owner).proposeFeeWallet(A.newcomer.address);
      for (const s of [A.owner, A.operator, A.stranger, A.feeWallet]) {
        await expect(integrator.connect(s).acceptFeeWallet()).to.be.revertedWithCustomError(
          integrator,
          "NotPendingFeeWallet"
        );
      }
    });

    it("proposing another wallet replaces the previous proposal", async function () {
      await integrator.connect(A.owner).proposeFeeWallet(A.stranger.address);
      await integrator.connect(A.owner).proposeFeeWallet(A.newcomer.address);
      await expect(integrator.connect(A.stranger).acceptFeeWallet()).to.be.revertedWithCustomError(
        integrator,
        "NotPendingFeeWallet"
      );
      await integrator.connect(A.newcomer).acceptFeeWallet();
      expect(await integrator.feeWallet()).to.equal(A.newcomer.address);
    });

    it("a blacklisted fee wallet blocks the whole batch (the vendor is not paid either); rotating it unblocks releases", async function () {
      const id = await placeAndComplete(diamond, integrator, A.buyer1, A.v1.address, USDC(100));
      await time.increase(RETENTION + 1);
      const esc = await escrowOf(integrator, A.v1.address);

      await usdc.blacklist(A.feeWallet.address);
      await expect(esc.release([id])).to.be.reverted;
      expect(await usdc.balanceOf(A.v1.address)).to.equal(0n);
      expect((await esc.getRecord(id)).released).to.equal(false);

      await integrator.connect(A.owner).proposeFeeWallet(A.newcomer.address);
      await integrator.connect(A.newcomer).acceptFeeWallet();
      await esc.release([id]);
      expect(await usdc.balanceOf(A.v1.address)).to.equal(USDC(100) - feeOf(USDC(100)));
      expect(await usdc.balanceOf(A.newcomer.address)).to.equal(feeOf(USDC(100)));
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe("vendor blacklisted after placement", function () {
    it("vendor blacklisted BEFORE completion: the order still completes and is recorded", async function () {
      const orderId = await placeOrder(integrator, A.buyer1, A.v1.address, USDC(100));
      await usdc.blacklist(A.v1.address);
      await expect(diamond.simulateOrderComplete(orderId)).to.not.emit(
        diamond,
        "MockIntegratorCallbackFailed"
      );

      const esc = await escrowOf(integrator, A.v1.address);
      expect((await esc.getRecord(orderId)).gross).to.equal(USDC(100));
      expect(await usdc.balanceOf(await esc.getAddress())).to.equal(USDC(100));
    });

    it("vendor blacklisted at release: it reverts, the record stays intact and can be retried later", async function () {
      const orderId = await placeAndComplete(
        diamond,
        integrator,
        A.buyer1,
        A.v1.address,
        USDC(100)
      );
      await usdc.blacklist(A.v1.address);
      await time.increase(RETENTION + 1);
      const esc = await escrowOf(integrator, A.v1.address);

      await expect(esc.release([orderId])).to.be.reverted;
      expect((await esc.getRecord(orderId)).released).to.equal(false);
      expect(await esc.pendingGross()).to.equal(USDC(100));
      // Our fee on its orders stays frozen with it (accepted).
      expect(await usdc.balanceOf(A.feeWallet.address)).to.equal(0n);

      await usdc.unBlacklist(A.v1.address);
      await esc.release([orderId]);
      expect(await usdc.balanceOf(A.v1.address)).to.equal(USDC(100) - feeOf(USDC(100)));
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe("fraud controls at the entrance", function () {
    it("pause: userPlaceOrder reverts OrdersPaused; it works again once unpaused", async function () {
      await expect(integrator.connect(A.operator).pause())
        .to.emit(integrator, "Paused")
        .withArgs(A.operator.address);
      expect(await integrator.paused()).to.equal(true);
      await expect(
        integrator
          .connect(A.buyer1)
          .userPlaceOrder(A.v1.address, USDC(1), ARS, CIRCLE_ID, PUBKEY, 0, 0)
      ).to.be.revertedWithCustomError(integrator, "OrdersPaused");

      await expect(integrator.connect(A.owner).unpause())
        .to.emit(integrator, "Unpaused")
        .withArgs(A.owner.address);
      await placeOrder(integrator, A.buyer1, A.v1.address, USDC(1));
    });

    it("pause and unpause are idempotent (no repeated event)", async function () {
      await integrator.connect(A.owner).pause();
      await expect(integrator.connect(A.operator).pause()).to.not.emit(integrator, "Paused");
      await integrator.connect(A.owner).unpause();
      await expect(integrator.connect(A.owner).unpause()).to.not.emit(integrator, "Unpaused");
    });

    it("blocked vendor: its new orders revert, others' keep working; the owner unblocks it", async function () {
      await expect(integrator.connect(A.operator).blockVendor(A.v1.address))
        .to.emit(integrator, "VendorBlockedUpdated")
        .withArgs(A.v1.address, true, A.operator.address);
      await expect(
        integrator
          .connect(A.buyer1)
          .userPlaceOrder(A.v1.address, USDC(1), ARS, CIRCLE_ID, PUBKEY, 0, 0)
      ).to.be.revertedWithCustomError(integrator, "VendorBlocked");
      await placeOrder(integrator, A.buyer1, A.v2.address, USDC(1));

      await expect(integrator.connect(A.owner).unblockVendor(A.v1.address))
        .to.emit(integrator, "VendorBlockedUpdated")
        .withArgs(A.v1.address, false, A.owner.address);
      await placeOrder(integrator, A.buyer1, A.v1.address, USDC(1));
    });

    it("blocking or pausing AFTER placement stops neither the record nor the release", async function () {
      const orderId = await placeOrder(integrator, A.buyer1, A.v1.address, USDC(100));
      await integrator.connect(A.operator).blockVendor(A.v1.address);
      await integrator.connect(A.operator).pause();
      await diamond.simulateOrderComplete(orderId);
      const esc = await escrowOf(integrator, A.v1.address);
      expect((await esc.getRecord(orderId)).gross).to.equal(USDC(100));
      await time.increase(RETENTION + 1);
      await esc.release([orderId]);
      expect(await usdc.balanceOf(A.v1.address)).to.equal(USDC(95));
    });

    it("vendor blacklisted on USDC: userPlaceOrder reverts VendorBlacklisted", async function () {
      await usdc.blacklist(A.v1.address);
      await expect(
        integrator
          .connect(A.buyer1)
          .userPlaceOrder(A.v1.address, USDC(1), ARS, CIRCLE_ID, PUBKEY, 0, 0)
      ).to.be.revertedWithCustomError(integrator, "VendorBlacklisted");
    });

    it("escrow blacklisted on USDC (even before it exists): userPlaceOrder reverts VendorBlacklisted", async function () {
      await usdc.blacklist(await integrator.escrowAddress(A.v1.address));
      await expect(
        integrator
          .connect(A.buyer1)
          .userPlaceOrder(A.v1.address, USDC(1), ARS, CIRCLE_ID, PUBKEY, 0, 0)
      ).to.be.revertedWithCustomError(integrator, "VendorBlacklisted");
      await placeOrder(integrator, A.buyer1, A.v2.address, USDC(1));
    });

    it("settlement token without isBlacklisted (the Base Sepolia GG mock): orders are placed, recorded and released", async function () {
      const { u, d, i } = await deployStack({ token: "MockUSDC" });
      const orderId = await placeAndComplete(d, i, A.buyer1, A.v1.address, USDC(100));
      await time.increase(RETENTION + 1);
      await (await escrowOf(i, A.v1.address)).release([orderId]);
      expect(await u.balanceOf(A.v1.address)).to.equal(USDC(100) - feeOf(USDC(100)));
    });

    it("daily volume per vendor: accumulates per vendor and UTC day; exceeding it reverts", async function () {
      await integrator.connect(A.owner).setVendorDailyVolumeLimit(USDC(100));
      // Start at the beginning of a UTC day so the test never crosses midnight.
      const now = await time.latest();
      await time.increaseTo(Math.floor(now / DAY + 1) * DAY + 60);

      await placeOrder(integrator, A.buyer1, A.v1.address, USDC(60));
      await placeOrder(integrator, A.buyer2, A.v1.address, USDC(40));
      expect(await integrator.getRemainingVendorVolume(A.v1.address)).to.equal(0n);
      await expect(
        integrator.connect(A.buyer1).userPlaceOrder(A.v1.address, 1n, ARS, CIRCLE_ID, PUBKEY, 0, 0)
      ).to.be.revertedWithCustomError(integrator, "VendorDailyVolumeExceeded");

      // Another vendor has its own allowance.
      await placeOrder(integrator, A.buyer1, A.v2.address, USDC(100));

      // The next day V1's allowance is back.
      await time.increase(DAY);
      expect(await integrator.getRemainingVendorVolume(A.v1.address)).to.equal(USDC(100));
      await placeOrder(integrator, A.buyer1, A.v1.address, USDC(100));
    });

    it("cancelling an order frees the vendor's volume and the buyer's slot, once", async function () {
      await integrator.connect(A.owner).setVendorDailyVolumeLimit(USDC(100));
      const now = await time.latest();
      await time.increaseTo(Math.floor(now / DAY + 1) * DAY + 60);

      const slotsBefore = await integrator.getRemainingDailyCount(A.buyer1.address);
      const id = await placeOrder(integrator, A.buyer1, A.v1.address, USDC(70));
      expect(await integrator.getRemainingVendorVolume(A.v1.address)).to.equal(USDC(30));
      expect(await integrator.getRemainingDailyCount(A.buyer1.address)).to.equal(slotsBefore - 1n);

      await expect(diamond.simulateOrderCancelled(id))
        .to.emit(integrator, "OrderCancelled")
        .withArgs(id, A.buyer1.address);
      expect(await integrator.getRemainingVendorVolume(A.v1.address)).to.equal(USDC(100));
      expect(await integrator.getRemainingDailyCount(A.buyer1.address)).to.equal(slotsBefore);

      // A second cancellation (repeated callback) frees nothing more.
      await placeOrder(integrator, A.buyer2, A.v1.address, USDC(50));
      const diamondSigner = await asDiamond(diamond);
      await integrator.connect(diamondSigner).onOrderCancel(id);
      expect(await integrator.getRemainingVendorVolume(A.v1.address)).to.equal(USDC(50));
      expect(await integrator.getRemainingDailyCount(A.buyer1.address)).to.equal(slotsBefore);
    });

    it("validateOrder enforces the per-tx cap and the daily count per buyer", async function () {
      await expectCallFailedWith(
        integrator
          .connect(A.buyer1)
          .userPlaceOrder(A.v1.address, PER_TX_LIMIT + 1n, ARS, CIRCLE_ID, PUBKEY, 0, 0),
        "Validation failed"
      );

      const { i } = await deployStack({ cfg: { dailyTxCountLimit: 2 } });
      await placeOrder(i, A.buyer1, A.v1.address, USDC(10));
      await placeOrder(i, A.buyer1, A.v1.address, USDC(10));
      expect(await i.getRemainingDailyCount(A.buyer1.address)).to.equal(0);
      await expectCallFailedWith(
        i.connect(A.buyer1).userPlaceOrder(A.v1.address, USDC(10), ARS, CIRCLE_ID, PUBKEY, 0, 0),
        "Validation failed"
      );
      // Another buyer has its own slots.
      await placeOrder(i, A.buyer2, A.v1.address, USDC(10));
    });

    it("limits move within their immutable ceiling and apply to the next order", async function () {
      await expect(integrator.connect(A.owner).setPerTxLimit(USDC(5)))
        .to.emit(integrator, "PerTxLimitUpdated")
        .withArgs(USDC(5));
      await expectCallFailedWith(
        integrator
          .connect(A.buyer1)
          .userPlaceOrder(A.v1.address, USDC(6), ARS, CIRCLE_ID, PUBKEY, 0, 0),
        "Validation failed"
      );
      await expect(integrator.connect(A.owner).setDailyTxCountLimit(3))
        .to.emit(integrator, "DailyTxCountLimitUpdated")
        .withArgs(3);
      await expect(integrator.connect(A.owner).setVendorDailyVolumeLimit(USDC(7)))
        .to.emit(integrator, "VendorDailyVolumeLimitUpdated")
        .withArgs(USDC(7));

      await expect(
        integrator.connect(A.owner).setPerTxLimit(CEILINGS.maxPerTxLimit + 1n)
      ).to.be.revertedWithCustomError(integrator, "LimitTooHigh");
      await expect(
        integrator.connect(A.owner).setDailyTxCountLimit(CEILINGS.maxDailyTxCountLimit + 1n)
      ).to.be.revertedWithCustomError(integrator, "LimitTooHigh");
      await expect(
        integrator
          .connect(A.owner)
          .setVendorDailyVolumeLimit(CEILINGS.maxVendorDailyVolumeLimit + 1n)
      ).to.be.revertedWithCustomError(integrator, "LimitTooHigh");
      // Exactly at the ceiling is fine.
      await integrator.connect(A.owner).setPerTxLimit(CEILINGS.maxPerTxLimit);
      await integrator.connect(A.owner).setDailyTxCountLimit(CEILINGS.maxDailyTxCountLimit);
      await integrator
        .connect(A.owner)
        .setVendorDailyVolumeLimit(CEILINGS.maxVendorDailyVolumeLimit);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe("roles — owner, operator, anyone", function () {
    /** Owner-only functions, with valid args. */
    function ownerOnlyCalls(): [string, any[]][] {
      return [
        ["setOperator", [A.stranger.address]],
        ["unpause", []],
        ["unblockVendor", [A.v1.address]],
        ["proposeFeeWallet", [A.newcomer.address]],
        ["setFeeBps", [100]],
        ["setFeeFixed", [USDC(1)]],
        ["setVendorFeeBps", [A.v1.address, true, 100]],
        ["setDefaultRetention", [DAY]],
        ["setVendorRetention", [A.v1.address, true, DAY]],
        ["setPerTxLimit", [USDC(1)]],
        ["setDailyTxCountLimit", [1]],
        ["setVendorDailyVolumeLimit", [USDC(1)]],
        ["transferOwnership", [A.newcomer.address]],
      ];
    }

    it("every owner admin function reverts for the operator, the deployer and a stranger", async function () {
      for (const [fn, args] of ownerOnlyCalls()) {
        for (const s of [A.operator, A.deployer, A.stranger]) {
          await expect(integrator.connect(s)[fn](...args), `${fn} from ${s.address}`)
            .to.be.revertedWithCustomError(integrator, "OwnableUnauthorizedAccount")
            .withArgs(s.address);
        }
      }
    });

    it("every owner admin function works from the owner", async function () {
      await integrator.connect(A.owner).pause(); // so that unpause has an effect
      for (const [fn, args] of ownerOnlyCalls()) {
        await expect(integrator.connect(A.owner)[fn](...args), fn).to.not.be.reverted;
      }
    });

    it("pause and blockVendor: operator or owner yes, a stranger no", async function () {
      for (const s of [A.stranger, A.deployer]) {
        await expect(integrator.connect(s).pause()).to.be.revertedWithCustomError(
          integrator,
          "OnlyOperatorOrOwner"
        );
        await expect(integrator.connect(s).blockVendor(A.v1.address)).to.be.revertedWithCustomError(
          integrator,
          "OnlyOperatorOrOwner"
        );
      }
      await integrator.connect(A.operator).pause();
      await integrator.connect(A.owner).unpause();
      await integrator.connect(A.owner).pause();
      await integrator.connect(A.operator).blockVendor(A.v1.address);
      await integrator.connect(A.owner).blockVendor(A.v2.address);
      expect((await integrator.vendorConfig(A.v1.address)).blocked).to.equal(true);
      expect((await integrator.vendorConfig(A.v2.address)).blocked).to.equal(true);
    });

    it("the operator can NOT unpause or unblock: only the Safe undoes its DoS", async function () {
      await integrator.connect(A.operator).pause();
      await integrator.connect(A.operator).blockVendor(A.v1.address);
      await expect(integrator.connect(A.operator).unpause()).to.be.revertedWithCustomError(
        integrator,
        "OwnableUnauthorizedAccount"
      );
      await expect(
        integrator.connect(A.operator).unblockVendor(A.v1.address)
      ).to.be.revertedWithCustomError(integrator, "OwnableUnauthorizedAccount");
      expect(await integrator.paused()).to.equal(true);
    });

    it("setOperator rotates the role: the previous one loses it; operator = 0 leaves only the owner", async function () {
      await expect(integrator.connect(A.owner).setOperator(A.newcomer.address))
        .to.emit(integrator, "OperatorUpdated")
        .withArgs(A.operator.address, A.newcomer.address);
      await expect(integrator.connect(A.operator).pause()).to.be.revertedWithCustomError(
        integrator,
        "OnlyOperatorOrOwner"
      );
      await integrator.connect(A.newcomer).pause();

      await integrator.connect(A.owner).setOperator(ethers.ZeroAddress);
      await expect(
        integrator.connect(A.newcomer).blockVendor(A.v1.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyOperatorOrOwner");
      await integrator.connect(A.owner).blockVendor(A.v1.address);
    });

    it("registerVendor, release and reconcileCompletion are open to anyone", async function () {
      await integrator.connect(A.stranger).registerVendor(A.v1.address);
      const id = await placeOrder(integrator, A.buyer1, A.v1.address, USDC(10));
      await diamond.simulateOrderCompleteNoCallback(id);
      await integrator.connect(A.stranger).reconcileCompletion(id);
      await time.increase(RETENTION + 1);
      await (await escrowOf(integrator, A.v1.address)).connect(A.stranger).release([id]);
      expect(await usdc.balanceOf(A.v1.address)).to.equal(USDC(10) - feeOf(USDC(10)));
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe("ownership handoff — Ownable2Step with a 7-day expiry", function () {
    it("transferOwnership proposes, the new address accepts and the old owner loses everything", async function () {
      const tx = integrator.connect(A.owner).transferOwnership(A.newcomer.address);
      await expect(tx)
        .to.emit(integrator, "OwnershipTransferStarted")
        .withArgs(A.owner.address, A.newcomer.address);
      const ts = await blockTs(await (await tx).wait());
      expect(await integrator.pendingOwner()).to.equal(A.newcomer.address);
      expect(await integrator.pendingOwnerExpiry()).to.equal(ts + 7 * DAY);
      // Proposing transfers nothing yet.
      expect(await integrator.owner()).to.equal(A.owner.address);

      await expect(integrator.connect(A.newcomer).acceptOwnership())
        .to.emit(integrator, "OwnershipTransferred")
        .withArgs(A.owner.address, A.newcomer.address);
      expect(await integrator.owner()).to.equal(A.newcomer.address);
      expect(await integrator.pendingOwner()).to.equal(ethers.ZeroAddress);
      expect(await integrator.pendingOwnerExpiry()).to.equal(0n);

      await expect(integrator.connect(A.owner).setFeeBps(1)).to.be.revertedWithCustomError(
        integrator,
        "OwnableUnauthorizedAccount"
      );
      await integrator.connect(A.newcomer).setFeeBps(1);
    });

    it("only the proposed address can accept", async function () {
      await integrator.connect(A.owner).transferOwnership(A.newcomer.address);
      for (const s of [A.stranger, A.operator, A.owner]) {
        await expect(integrator.connect(s).acceptOwnership())
          .to.be.revertedWithCustomError(integrator, "OwnableUnauthorizedAccount")
          .withArgs(s.address);
      }
    });

    it("the proposal expires after 7 days: then it reverts HandoffExpired; it can be proposed again", async function () {
      await integrator.connect(A.owner).transferOwnership(A.newcomer.address);
      await time.increase(7 * DAY + 1);
      await expect(integrator.connect(A.newcomer).acceptOwnership()).to.be.revertedWithCustomError(
        integrator,
        "HandoffExpired"
      );
      expect(await integrator.owner()).to.equal(A.owner.address);

      await integrator.connect(A.owner).transferOwnership(A.newcomer.address);
      await integrator.connect(A.newcomer).acceptOwnership();
      expect(await integrator.owner()).to.equal(A.newcomer.address);
    });

    it("within the window (right before expiry) it can be accepted", async function () {
      await integrator.connect(A.owner).transferOwnership(A.newcomer.address);
      const expiry = await integrator.pendingOwnerExpiry();
      await time.setNextBlockTimestamp(expiry);
      await integrator.connect(A.newcomer).acceptOwnership();
      expect(await integrator.owner()).to.equal(A.newcomer.address);
    });

    it("transferOwnership(address(0)) cancels the proposal", async function () {
      await integrator.connect(A.owner).transferOwnership(A.newcomer.address);
      await expect(integrator.connect(A.owner).transferOwnership(ethers.ZeroAddress))
        .to.emit(integrator, "OwnershipTransferStarted")
        .withArgs(A.owner.address, ethers.ZeroAddress);
      expect(await integrator.pendingOwner()).to.equal(ethers.ZeroAddress);
      expect(await integrator.pendingOwnerExpiry()).to.equal(0n);
      await expect(integrator.connect(A.newcomer).acceptOwnership()).to.be.revertedWithCustomError(
        integrator,
        "OwnableUnauthorizedAccount"
      );
    });

    it("an old proposal is void once another address is proposed", async function () {
      await integrator.connect(A.owner).transferOwnership(A.stranger.address);
      await integrator.connect(A.owner).transferOwnership(A.newcomer.address);
      await expect(integrator.connect(A.stranger).acceptOwnership()).to.be.revertedWithCustomError(
        integrator,
        "OwnableUnauthorizedAccount"
      );
      await integrator.connect(A.newcomer).acceptOwnership();
      expect(await integrator.owner()).to.equal(A.newcomer.address);
    });

    it("renounceOwnership always reverts, even from the owner", async function () {
      await expect(integrator.connect(A.owner).renounceOwnership()).to.be.revertedWithCustomError(
        integrator,
        "RenounceDisabled"
      );
      await expect(
        integrator.connect(A.stranger).renounceOwnership()
      ).to.be.revertedWithCustomError(integrator, "RenounceDisabled");
      expect(await integrator.owner()).to.equal(A.owner.address);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe("pause only stops the entrance", function () {
    it("with the entrance paused, callbacks, reconcile, registerVendor and release keep working", async function () {
      const idA = await placeOrder(integrator, A.buyer1, A.v1.address, USDC(100));
      const idB = await placeOrder(integrator, A.buyer1, A.v1.address, USDC(50));
      const idC = await placeOrder(integrator, A.buyer2, A.v1.address, USDC(20));
      await integrator.connect(A.operator).pause();

      await expect(diamond.simulateOrderComplete(idA)).to.not.emit(
        diamond,
        "MockIntegratorCallbackFailed"
      );
      await diamond.simulateOrderCompleteNoCallback(idB);
      await integrator.connect(A.stranger).reconcileCompletion(idB);
      await expect(diamond.simulateOrderCancelled(idC)).to.emit(integrator, "OrderCancelled");
      await integrator.registerVendor(A.v2.address);

      await time.increase(RETENTION + 1);
      await (await escrowOf(integrator, A.v1.address)).release([idA, idB]);
      expect(await usdc.balanceOf(A.v1.address)).to.equal(
        USDC(150) - feeOf(USDC(100)) - feeOf(USDC(50))
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe("residual risk — callback swallowed by the Diamond", function () {
    it("without the callback, the USDC sits in the vendor's escrow unrecorded: it cannot be released", async function () {
      const orderId = await placeOrder(integrator, A.buyer1, A.v1.address, USDC(100));
      await diamond.simulateOrderCompleteNoCallback(orderId);
      await time.increase(RETENTION + 1);

      const esc = await escrowOf(integrator, A.v1.address);
      expect(await usdc.balanceOf(await esc.getAddress())).to.equal(USDC(100));
      expect(await esc.pendingGross()).to.equal(0n);
      await expect(esc.release([orderId])).to.be.revertedWithCustomError(esc, "UnknownRecord");
    });

    it("reconcileCompletion rebuilds the record from the Diamond, with the fee in force, and it then releases as usual", async function () {
      const orderId = await placeOrder(integrator, A.buyer1, A.v1.address, USDC(100));
      await diamond.simulateOrderCompleteNoCallback(orderId);
      await integrator.connect(A.owner).setFeeBps(200);
      const esc = await escrowOf(integrator, A.v1.address);

      const tx = integrator.connect(A.stranger).reconcileCompletion(orderId);
      const ts = await blockTs(await (await tx).wait());
      await expect(tx)
        .to.emit(integrator, "OrderReconciled")
        .withArgs(orderId, A.v1.address, USDC(100));
      // It also emits OrderCompleted: the keeper indexes that event alone.
      await expect(tx)
        .to.emit(integrator, "OrderCompleted")
        .withArgs(
          orderId,
          A.v1.address,
          await esc.getAddress(),
          A.buyer1.address,
          USDC(100),
          200,
          FEE_FIXED,
          ts + RETENTION
        );

      const r = await esc.getRecord(orderId);
      expect(r.gross).to.equal(USDC(100));
      expect(r.feeBps).to.equal(200n);

      // The retention clock starts at reconciliation.
      await expect(esc.release([orderId])).to.be.revertedWithCustomError(esc, "StillLocked");
      await time.increase(RETENTION + 1);
      await esc.release([orderId]);
      expect(await usdc.balanceOf(A.v1.address)).to.equal(USDC(98));
      expect(await usdc.balanceOf(A.feeWallet.address)).to.equal(USDC(2));
    });

    it("reconcileCompletion rejects an order the Diamond has not completed", async function () {
      const orderId = await placeOrder(integrator, A.buyer1, A.v1.address, USDC(100));
      await expect(integrator.reconcileCompletion(orderId)).to.be.revertedWithCustomError(
        integrator,
        "NotCompletedOnDiamond"
      );
      await diamond.simulateOrderCancelledNoCallback(orderId);
      await expect(integrator.reconcileCompletion(orderId)).to.be.revertedWithCustomError(
        integrator,
        "NotCompletedOnDiamond"
      );
    });

    it("reconcileCompletion does not duplicate an order already recorded by the callback", async function () {
      const orderId = await placeAndComplete(
        diamond,
        integrator,
        A.buyer1,
        A.v1.address,
        USDC(100)
      );
      await expect(integrator.reconcileCompletion(orderId)).to.be.revertedWithCustomError(
        integrator,
        "OrderAlreadyFulfilled"
      );
    });

    it("reconcileCompletion rejects orderIds not placed through this integrator", async function () {
      await expect(integrator.reconcileCompletion(999)).to.be.revertedWithCustomError(
        integrator,
        "UnknownOrder"
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe("cancellation without callback — reconcileCancellation", function () {
    async function cancelSinCallback(amount: bigint) {
      await integrator.connect(A.owner).setVendorDailyVolumeLimit(USDC(100));
      const now = await time.latest();
      await time.increaseTo(Math.floor(now / DAY + 1) * DAY + 60);
      const slots = await integrator.getRemainingDailyCount(A.buyer1.address);
      const id = await placeOrder(integrator, A.buyer1, A.v1.address, amount);
      await diamond.simulateOrderCancelledNoCallback(id);
      return { id, slots };
    }

    it("without the callback, the vendor's volume and the buyer's slot stay consumed", async function () {
      const { slots } = await cancelSinCallback(USDC(70));
      expect(await integrator.getRemainingVendorVolume(A.v1.address)).to.equal(USDC(30));
      expect(await integrator.getRemainingDailyCount(A.buyer1.address)).to.equal(slots - 1n);
    });

    it("reconcileCancellation (anyone) frees both allowances from the Diamond's state, once", async function () {
      const { id, slots } = await cancelSinCallback(USDC(70));

      const tx = integrator.connect(A.stranger).reconcileCancellation(id);
      await expect(tx).to.emit(integrator, "OrderCancelled").withArgs(id, A.buyer1.address);
      await expect(tx).to.emit(integrator, "OrderCancelReconciled").withArgs(id);
      expect(await integrator.getRemainingVendorVolume(A.v1.address)).to.equal(USDC(100));
      expect(await integrator.getRemainingDailyCount(A.buyer1.address)).to.equal(slots);
      expect((await integrator.getOrder(id)).cancelled).to.equal(true);

      await expect(integrator.reconcileCancellation(id)).to.be.revertedWithCustomError(
        integrator,
        "OrderAlreadyCancelled"
      );
      // And a late callback frees nothing more.
      await integrator.connect(await asDiamond(diamond)).onOrderCancel(id);
      expect(await integrator.getRemainingVendorVolume(A.v1.address)).to.equal(USDC(100));
    });

    it("if the callback already ran, reconcileCancellation reverts OrderAlreadyCancelled", async function () {
      const id = await placeOrder(integrator, A.buyer1, A.v1.address, USDC(10));
      await diamond.simulateOrderCancelled(id);
      await expect(integrator.reconcileCancellation(id)).to.be.revertedWithCustomError(
        integrator,
        "OrderAlreadyCancelled"
      );
    });

    it("rejects an order the Diamond has not cancelled (in flight or completed) and foreign ids", async function () {
      const inFlight = await placeOrder(integrator, A.buyer1, A.v1.address, USDC(10));
      await expect(integrator.reconcileCancellation(inFlight)).to.be.revertedWithCustomError(
        integrator,
        "NotCancelledOnDiamond"
      );
      const completedId = await placeAndComplete(
        diamond,
        integrator,
        A.buyer1,
        A.v1.address,
        USDC(10)
      );
      await expect(integrator.reconcileCancellation(completedId)).to.be.revertedWithCustomError(
        integrator,
        "OrderAlreadyFulfilled"
      );
      const swallowed = await placeOrder(integrator, A.buyer1, A.v1.address, USDC(10));
      await diamond.simulateOrderCompleteNoCallback(swallowed);
      await expect(integrator.reconcileCancellation(swallowed)).to.be.revertedWithCustomError(
        integrator,
        "NotCancelledOnDiamond"
      );
      await expect(integrator.reconcileCancellation(999)).to.be.revertedWithCustomError(
        integrator,
        "UnknownOrder"
      );
    });

    it("works with the entrance paused", async function () {
      const { id } = await cancelSinCallback(USDC(70));
      await integrator.connect(A.operator).pause();
      await expect(integrator.reconcileCancellation(id)).to.emit(
        integrator,
        "OrderCancelReconciled"
      );
    });

    it("a cancelled, reconciled order that the Diamond reopens and completes (dispute) is still recorded and released", async function () {
      const { id } = await cancelSinCallback(USDC(70));
      await integrator.reconcileCancellation(id);

      await diamond.simulateOrderComplete(id);
      const esc = await escrowOf(integrator, A.v1.address);
      expect((await esc.getRecord(id)).gross).to.equal(USDC(70));
      await time.increase(RETENTION + 1);
      await esc.release([id]);
      expect(await usdc.balanceOf(A.v1.address)).to.equal(USDC(70) - feeOf(USDC(70)));
      // The allowances stay freed: the order does not count against the limit again.
      expect(await integrator.getRemainingVendorVolume(A.v1.address)).to.equal(USDC(100));
    });

    it("same if, after reopening, the completion callback is lost too: reconcileCompletion records it", async function () {
      const { id } = await cancelSinCallback(USDC(70));
      await integrator.reconcileCancellation(id);
      await diamond.simulateOrderCompleteNoCallback(id);
      await expect(integrator.reconcileCompletion(id)).to.emit(integrator, "OrderReconciled");
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe("full interface", function () {
    let diamondSigner: SignerWithAddress;

    beforeEach(async function () {
      diamondSigner = await asDiamond(diamond);
    });

    it("onlyDiamond on validateOrder, onOrderComplete and onOrderCancel", async function () {
      await expect(
        integrator.connect(A.stranger).validateOrder(A.buyer1.address, USDC(10), ARS)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
      await expect(
        integrator
          .connect(A.owner)
          .onOrderComplete(1, A.buyer1.address, USDC(10), A.stranger.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
      await expect(integrator.connect(A.operator).onOrderCancel(1)).to.be.revertedWithCustomError(
        integrator,
        "OnlyDiamond"
      );
    });

    it("onOrderComplete with an unknown orderId reverts UnknownOrder", async function () {
      await expect(
        integrator
          .connect(diamondSigner)
          .onOrderComplete(999, A.buyer1.address, USDC(10), A.stranger.address)
      ).to.be.revertedWithCustomError(integrator, "UnknownOrder");
    });

    it("onOrderComplete called twice reverts OrderAlreadyFulfilled", async function () {
      const orderId = await placeAndComplete(
        diamond,
        integrator,
        A.buyer1,
        A.v1.address,
        USDC(100)
      );
      await expect(
        integrator
          .connect(diamondSigner)
          .onOrderComplete(
            orderId,
            A.buyer1.address,
            USDC(100),
            await integrator.escrowAddress(A.v1.address)
          )
      ).to.be.revertedWithCustomError(integrator, "OrderAlreadyFulfilled");
    });

    it("onOrderComplete with amount = 0 reverts InvalidAmount", async function () {
      const orderId = await placeOrder(integrator, A.buyer1, A.v1.address, USDC(100));
      await expect(
        integrator
          .connect(diamondSigner)
          .onOrderComplete(
            orderId,
            A.buyer1.address,
            0,
            await integrator.escrowAddress(A.v1.address)
          )
      ).to.be.revertedWithCustomError(integrator, "InvalidAmount");
    });

    it("onOrderComplete with recipientAddr = the integrator or ANOTHER vendor's escrow reverts UnexpectedRecipient", async function () {
      const orderId = await placeOrder(integrator, A.buyer1, A.v1.address, USDC(100));
      await integrator.registerVendor(A.v2.address);
      for (const wrong of [
        await integrator.getAddress(),
        await integrator.escrowAddress(A.v2.address),
        A.stranger.address,
      ]) {
        await expect(
          integrator
            .connect(diamondSigner)
            .onOrderComplete(orderId, A.buyer1.address, USDC(100), wrong)
        ).to.be.revertedWithCustomError(integrator, "UnexpectedRecipient");
      }
    });

    it("a cancelled order that the Diamond reopens and completes (dispute) is still recorded", async function () {
      const orderId = await placeOrder(integrator, A.buyer1, A.v1.address, USDC(100));
      await diamond.simulateOrderCancelled(orderId);
      await diamond.simulateOrderComplete(orderId);
      expect((await (await escrowOf(integrator, A.v1.address)).getRecord(orderId)).gross).to.equal(
        USDC(100)
      );
    });

    it("misconfigured Diamond (usdcThroughIntegrator = true): the callback fails, the USDC stays on the integrator and nothing is recorded", async function () {
      await diamond.setUsdcThroughIntegrator(true);
      const orderId = await placeOrder(integrator, A.buyer1, A.v1.address, USDC(100));
      await expect(diamond.simulateOrderComplete(orderId)).to.emit(
        diamond,
        "MockIntegratorCallbackFailed"
      );
      // The escrow is empty → recordCompletion reverts Unfunded inside the
      // try/catch. The integrator has no way to move that USDC: registering
      // with usdcThroughIntegrator = false is part of the deploy, not optional.
      expect(await usdc.balanceOf(await integrator.getAddress())).to.equal(USDC(100));
      expect((await integrator.getOrder(orderId)).completed).to.equal(false);
      // Nor can reconcile record it: the escrow does not hold the money.
      const esc = await escrowOf(integrator, A.v1.address);
      await expect(integrator.reconcileCompletion(orderId)).to.be.revertedWithCustomError(
        esc,
        "Unfunded"
      );
    });

    it("onOrderCancel: tolerates an unknown id and is a no-op on a completed order", async function () {
      await expect(integrator.connect(diamondSigner).onOrderCancel(999)).to.not.be.reverted;

      const done = await placeAndComplete(diamond, integrator, A.buyer1, A.v1.address, USDC(100));
      const esc = await escrowOf(integrator, A.v1.address);
      const slots = await integrator.getRemainingDailyCount(A.buyer1.address);
      await expect(integrator.connect(diamondSigner).onOrderCancel(done)).to.not.emit(
        integrator,
        "OrderCancelled"
      );
      expect(await esc.pendingGross()).to.equal(USDC(100));
      expect(await integrator.getRemainingDailyCount(A.buyer1.address)).to.equal(slots);
    });

    it("two concurrent buyers: distinct proxies, no orderId collision, the right payer in each event", async function () {
      const id1 = await placeOrder(integrator, A.buyer1, A.v1.address, USDC(10));
      const id2 = await placeOrder(integrator, A.buyer2, A.v1.address, USDC(20));
      expect(id1).to.not.equal(id2);
      const esc = await integrator.escrowAddress(A.v1.address);
      await expect(diamond.simulateOrderComplete(id1))
        .to.emit(integrator, "OrderCompleted")
        .withArgs(
          id1,
          A.v1.address,
          esc,
          A.buyer1.address,
          USDC(10),
          FEE_BPS,
          FEE_FIXED,
          (x: bigint) => x > 0n
        );
      await expect(diamond.simulateOrderComplete(id2))
        .to.emit(integrator, "OrderCompleted")
        .withArgs(
          id2,
          A.v1.address,
          esc,
          A.buyer2.address,
          USDC(20),
          FEE_BPS,
          FEE_FIXED,
          (x: bigint) => x > 0n
        );
    });

    it("fiatAmountLimit and preferredPaymentChannelConfigId reach the Diamond unchanged", async function () {
      const PCID = 7n;
      const FIAT_LIMIT = 123_456_789n;
      const tx = await integrator
        .connect(A.buyer1)
        .userPlaceOrder(A.v1.address, USDC(10), ARS, CIRCLE_ID, PUBKEY, PCID, FIAT_LIMIT);
      const receipt = await tx.wait();

      // UserProxy emits Executed(target, data) with the exact calldata it sent the Diamond.
      const proxy = await ethers.getContractAt(
        "UserProxy",
        await integrator.proxyAddress(A.buyer1.address)
      );
      const executed = receipt!.logs
        .map((l: any) => {
          try {
            return proxy.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p: any) => p?.name === "Executed");
      expect(executed!.args.target).to.equal(await diamond.getAddress());

      const gw = await ethers.getContractAt("IB2BGateway", await diamond.getAddress());
      const args = gw.interface.decodeFunctionData("placeB2BOrder", executed!.args.data);
      expect(args.user).to.equal(A.buyer1.address);
      expect(args.amount).to.equal(USDC(10));
      expect(args.currency).to.equal(ARS);
      expect(args.recipientAddr).to.equal(await integrator.escrowAddress(A.v1.address));
      expect(args.pubKey).to.equal(PUBKEY);
      expect(args.circleId).to.equal(CIRCLE_ID);
      expect(args.preferredPaymentChannelConfigId).to.equal(PCID);
      expect(args.fiatAmountLimit).to.equal(FIAT_LIMIT);
    });

    it("OrderPlaced carries orderId, buyer, vendor and amount", async function () {
      const orderId = await integrator
        .connect(A.buyer1)
        .userPlaceOrder.staticCall(A.v1.address, USDC(10), ARS, CIRCLE_ID, PUBKEY, 0, 0);
      await expect(
        integrator
          .connect(A.buyer1)
          .userPlaceOrder(A.v1.address, USDC(10), ARS, CIRCLE_ID, PUBKEY, 0, 0)
      )
        .to.emit(integrator, "OrderPlaced")
        .withArgs(orderId, A.buyer1.address, A.v1.address, USDC(10));
      const o = await integrator.getOrder(orderId);
      expect(o.vendor).to.equal(A.v1.address);
      expect(o.placer).to.equal(A.buyer1.address);
      expect(o.amount).to.equal(USDC(10));
    });
  });

  // ──────────────────────────────────────────────────────────────────
  describe("money surface + attack attempts", function () {
    it("the escrow has EXACTLY two state-changing functions: recordCompletion and release", async function () {
      expect(await mutableFunctions("VendorEscrow")).to.deep.equal(["recordCompletion", "release"]);
    });

    it("the integrator's state-changing functions are these, and none moves USDC", async function () {
      expect(await mutableFunctions("LazoCheckoutIntegrator")).to.deep.equal([
        "acceptFeeWallet",
        "acceptOwnership",
        "blockVendor",
        "onOrderCancel",
        "onOrderComplete",
        "pause",
        "proposeFeeWallet",
        "reconcileCancellation",
        "reconcileCompletion",
        "registerVendor",
        "setDailyTxCountLimit",
        "setDefaultRetention",
        "setFeeBps",
        "setFeeFixed",
        "setOperator",
        "setPerTxLimit",
        "setVendorDailyVolumeLimit",
        "setVendorFeeBps",
        "setVendorRetention",
        "transferOwnership",
        "unblockVendor",
        "unpause",
        "userPlaceOrder",
        "validateOrder",
      ]);
    });

    it("the per-escrow invariant holds after every mixed operation, and the integrator never holds a balance", async function () {
      const vs = [A.v1.address, A.v2.address];
      const check = () => invariant(integrator, usdc, vs);
      const placedIds: { id: bigint; v: string }[] = [];

      for (let k = 0; k < 12; k++) {
        const v = vs[k % 2];
        const buyer = k % 3 ? A.buyer2 : A.buyer1;
        const id = await placeOrder(integrator, buyer, v, USDC(37 + k * 13) + BigInt(k));
        if (k % 5 === 4) {
          await diamond.simulateOrderCancelled(id); // cancelled: nothing to record
        } else if (k % 4 === 3) {
          await diamond.simulateOrderCompleteNoCallback(id); // callback swallowed
          await check(); // unrecorded money: bal > pending, the invariant still holds
          await integrator.reconcileCompletion(id);
          placedIds.push({ id, v });
        } else {
          await diamond.simulateOrderComplete(id);
          placedIds.push({ id, v });
        }
        if (k === 6) await integrator.connect(A.owner).setFeeBps(123);
        await check();
      }

      await time.increase(RETENTION + 1);
      const ofV1 = placedIds.filter((x) => x.v === A.v1.address).map((x) => x.id);
      const ofV2 = placedIds.filter((x) => x.v === A.v2.address).map((x) => x.id);
      const e1 = await escrowOf(integrator, A.v1.address);
      const e2 = await escrowOf(integrator, A.v2.address);
      await e1.release(ofV1.slice(0, 2));
      await check();
      await integrator.connect(A.owner).proposeFeeWallet(A.newcomer.address);
      await integrator.connect(A.newcomer).acceptFeeWallet();
      await e2.release(ofV2);
      await e1.release(ofV1); // includes already-released ones: they are skipped
      await check();

      for (const v of vs) {
        expect(await usdc.balanceOf(await integrator.escrowAddress(v))).to.equal(0n);
        expect(await (await escrowOf(integrator, v)).pendingGross()).to.equal(0n);
      }
    });

    async function setupHookedStack() {
      const { u, d, i } = await deployStack({ token: "MockUSDCHooked" });
      const malicious = await (await ethers.getContractFactory("MaliciousVendor")).deploy();
      return { usdcH: u, diamondH: d, integratorH: i, malicious };
    }

    it("reentrancy: a malicious vendor with a hostile receive() cannot re-enter its escrow's release", async function () {
      const { integratorH, diamondH, usdcH, malicious } = await setupHookedStack();
      const mAddr = await malicious.getAddress();

      const idA = await placeAndComplete(diamondH, integratorH, A.buyer1, mAddr, USDC(300));
      const idB = await placeAndComplete(diamondH, integratorH, A.buyer1, mAddr, USDC(400));
      await time.increase(RETENTION + 1);
      const esc = await escrowOf(integratorH, mAddr);

      await malicious.arm(await esc.getAddress(), [idB]);
      await esc.release([idA]);
      expect(await malicious.reentered()).to.equal(true);
      expect(await malicious.reentrantCallReverted()).to.equal(true);

      expect(await usdcH.balanceOf(mAddr)).to.equal(USDC(300) - feeOf(USDC(300)));
      expect((await esc.getRecord(idB)).released).to.equal(false);
      expect(await usdcH.balanceOf(await esc.getAddress())).to.equal(USDC(400));
      expect(await esc.pendingGross()).to.equal(USDC(400));
    });

    it("releasing the same orderId twice never pays twice", async function () {
      const orderId = await placeAndComplete(
        diamond,
        integrator,
        A.buyer1,
        A.v1.address,
        USDC(100)
      );
      await time.increase(RETENTION + 1);
      const esc = await escrowOf(integrator, A.v1.address);
      await esc.release([orderId]);
      await esc.release([orderId]);
      await esc.release([orderId, orderId]);
      expect(await usdc.balanceOf(A.v1.address)).to.equal(USDC(100) - feeOf(USDC(100)));
      expect(await usdc.balanceOf(A.feeWallet.address)).to.equal(feeOf(USDC(100)));
    });
  });
});
