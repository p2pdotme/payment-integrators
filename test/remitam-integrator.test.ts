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

    it("non-owner cannot remove accounts", async function () {
      await integrator.addAccount(walletA.address);
      await expect(
        integrator.connect(attacker).removeAccount(walletA.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });

    it("removeAccount of a never-added account is a no-op (stays false)", async function () {
      expect(await integrator.whitelisted(walletA.address)).to.equal(false);
      await expect(integrator.removeAccount(walletA.address))
        .to.emit(integrator, "AccountRemoved")
        .withArgs(walletA.address);
      expect(await integrator.whitelisted(walletA.address)).to.equal(false);
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

  describe("constructor", function () {
    it("rejects a zero diamond address", async function () {
      const Integrator = await ethers.getContractFactory("RemitamIntegrator");
      await expect(
        Integrator.deploy(
          ethers.ZeroAddress,
          await usdc.getAddress(),
          TX_CEIL,
          VOL_CEIL,
          COUNT_CEIL
        )
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    });

    it("rejects a zero usdc address", async function () {
      const Integrator = await ethers.getContractFactory("RemitamIntegrator");
      await expect(
        Integrator.deploy(
          await diamond.getAddress(),
          ethers.ZeroAddress,
          TX_CEIL,
          VOL_CEIL,
          COUNT_CEIL
        )
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
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

    it("rejects a proxy whose owning wallet was later removed (proxyOwner resolves non-zero)", async function () {
      // Create the proxy (and proxyOwner mapping) via a SELL placement, then
      // remove the wallet: _resolveWallet must fall through past the
      // wallet == address(0) short-circuit into the whitelisted check.
      await integrator.connect(walletA).userStartSell(USDC(1), INR, PK, CIRCLE, 0, 0);
      const proxy = await integrator.proxyAddress(walletA.address);
      await integrator.removeAccount(walletA.address);
      await expect(
        integrator.connect(dia).validateOrder(proxy, USDC(1), INR)
      ).to.be.revertedWithCustomError(integrator, "NotWhitelisted");
    });
  });

  describe("buy leg", function () {
    beforeEach(async function () {
      await integrator.addAccount(walletA.address);
    });

    it("whitelisted wallet places a buy; USDC lands on the wallet at completion", async function () {
      const tx = await integrator
        .connect(walletA)
        .userPlaceBuyOrder(USDC(300), INR, PK, CIRCLE, 0, 0);
      const rc = await tx.wait();
      const ev = rc!.logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p: any) => p?.name === "BuyPlaced");
      expect(ev).to.not.be.undefined;
      const orderId = ev!.args[0];

      const before = await usdc.balanceOf(walletA.address);
      await expect(diamond.simulateOrderComplete(orderId)).to.emit(integrator, "LegCompleted");
      expect(await usdc.balanceOf(walletA.address)).to.equal(before + USDC(300));

      const session = await integrator.buySessions(orderId);
      expect(session.active).to.equal(false);
    });

    it("non-whitelisted wallet cannot place", async function () {
      await expect(
        integrator.connect(attacker).userPlaceBuyOrder(USDC(1), INR, PK, CIRCLE, 0, 0)
      ).to.be.revertedWithCustomError(integrator, "NotWhitelisted");
    });

    it("cancellation releases the daily debit and is idempotent", async function () {
      const day = BigInt(Math.floor((await ethers.provider.getBlock("latest"))!.timestamp / DAY));
      await integrator.connect(walletA).userPlaceBuyOrder(USDC(300), INR, PK, CIRCLE, 0, 0);
      // The just-placed order got id nextOrderId-1.
      const orderId = (await diamond.getNextOrderId()) - 1n;
      expect(await integrator.dailyVolume(walletA.address, day)).to.equal(USDC(300));

      await expect(diamond.simulateOrderCancelled(orderId)).to.emit(integrator, "LegCancelled");
      expect(await integrator.dailyVolume(walletA.address, day)).to.equal(0n);
      expect(await integrator.dailyCount(walletA.address, day)).to.equal(0n);
    });

    it("onOrderCancel tolerates unknown orderIds (no revert, no state change)", async function () {
      const dia = await diamondSigner();
      await integrator.connect(dia).onOrderCancel(999999); // must not revert
    });

    it("onOrderCancel and onOrderComplete are diamond-only", async function () {
      await expect(integrator.connect(attacker).onOrderCancel(1)).to.be.revertedWithCustomError(
        integrator,
        "OnlyDiamond"
      );
      await expect(
        integrator.connect(attacker).onOrderComplete(1, walletA.address, USDC(1), attacker.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
    });

    it("onOrderComplete tolerates unknown / already-settled orderIds (no revert)", async function () {
      const dia = await diamondSigner();
      // Never-placed orderId.
      await integrator
        .connect(dia)
        .onOrderComplete(999999, walletA.address, USDC(1), walletA.address);

      // A real order that already completed once.
      await integrator.connect(walletA).userPlaceBuyOrder(USDC(300), INR, PK, CIRCLE, 0, 0);
      const orderId = (await diamond.getNextOrderId()) - 1n;
      await diamond.simulateOrderComplete(orderId);
      // Second callback for the same (now-inactive) session must be a no-op.
      await integrator
        .connect(dia)
        .onOrderComplete(orderId, walletA.address, USDC(300), walletA.address);
    });

    it("splitting: two buy legs 300 + 200 both settle to the wallet", async function () {
      await integrator.connect(walletA).userPlaceBuyOrder(USDC(300), INR, PK, CIRCLE, 0, 0);
      const id1 = (await diamond.getNextOrderId()) - 1n;
      await integrator.connect(walletA).userPlaceBuyOrder(USDC(200), INR, PK, CIRCLE, 0, 0);
      const id2 = (await diamond.getNextOrderId()) - 1n;

      await diamond.simulateOrderComplete(id1);
      await diamond.simulateOrderComplete(id2);
      expect(await usdc.balanceOf(walletA.address)).to.equal(USDC(500));
    });
  });

  describe("sell leg placement", function () {
    beforeEach(async function () {
      await integrator.addAccount(walletA.address);
    });

    it("places a sell with order.user = the wallet's proxy", async function () {
      await expect(
        integrator.connect(walletA).userStartSell(USDC(300), INR, PK, CIRCLE, 0, 0)
      ).to.emit(integrator, "SellPlaced");
      const orderId = (await diamond.getNextOrderId()) - 1n;

      const order = await diamond.getSellOrder(orderId);
      expect(order.user).to.equal(await integrator.proxyAddress(walletA.address));
      expect(order.amount).to.equal(USDC(300));

      const leg = await integrator.sellLegs(orderId);
      expect(leg.user).to.equal(walletA.address);
      expect(leg.initialized).to.equal(true);
      expect(await integrator.activeSellCount(walletA.address)).to.equal(1n);
    });

    it("supports concurrent sell legs (the split case: 300 + 200)", async function () {
      await integrator.connect(walletA).userStartSell(USDC(300), INR, PK, CIRCLE, 0, 0);
      await integrator.connect(walletA).userStartSell(USDC(200), INR, PK, CIRCLE, 0, 0);
      expect(await integrator.activeSellCount(walletA.address)).to.equal(2n);
    });

    it("caps concurrent sells at MAX_CONCURRENT_SELLS", async function () {
      const max = await integrator.MAX_CONCURRENT_SELLS();
      for (let i = 0n; i < max; i++) {
        await integrator.connect(walletA).userStartSell(USDC(1), INR, PK, CIRCLE, 0, 0);
      }
      await expect(
        integrator.connect(walletA).userStartSell(USDC(1), INR, PK, CIRCLE, 0, 0)
      ).to.be.revertedWithCustomError(integrator, "TooManyActiveSells");
    });

    it("non-whitelisted wallet cannot start a sell", async function () {
      await expect(
        integrator.connect(attacker).userStartSell(USDC(1), INR, PK, CIRCLE, 0, 0)
      ).to.be.revertedWithCustomError(integrator, "NotWhitelisted");
    });

    it("sell placement debits the wallet's daily buckets via the proxy resolution", async function () {
      const day = BigInt(Math.floor((await ethers.provider.getBlock("latest"))!.timestamp / DAY));
      await integrator.connect(walletA).userStartSell(USDC(250), INR, PK, CIRCLE, 0, 0);
      expect(await integrator.dailyVolume(walletA.address, day)).to.equal(USDC(250));
    });
  });

  describe("deliverPayout", function () {
    let orderId: bigint;
    let proxy: string;
    const ENC = "0x" + "cd".repeat(48); // opaque encrypted payout blob

    beforeEach(async function () {
      await integrator.addAccount(walletA.address);
      await integrator.connect(walletA).userStartSell(USDC(300), INR, PK, CIRCLE, 0, 0);
      orderId = (await diamond.getNextOrderId()) - 1n;
      proxy = await integrator.proxyAddress(walletA.address);
      await diamond.acceptSellOrder(orderId, PK);
      await diamond.setSellFee(USDC(2)); // actualUsdtAmount = 302
      await usdc.mint(walletA.address, USDC(1000));
    });

    it("happy path: pulls the shortfall JIT from the wallet's approved balance, order goes PAID", async function () {
      await usdc.connect(walletA).approve(await integrator.getAddress(), USDC(302));
      const walletBefore = await usdc.balanceOf(walletA.address);

      await expect(integrator.connect(walletA).deliverPayout(orderId, ENC)).to.emit(
        integrator,
        "PayoutDelivered"
      );
      const order = await diamond.getSellOrder(orderId);
      expect(order.status).to.equal(2); // PAID
      expect(await usdc.balanceOf(proxy)).to.equal(0n); // exact pull, nothing left parked
      expect(await usdc.balanceOf(walletA.address)).to.equal(walletBefore - USDC(302));
    });

    it("reverts FeeNotReady while the Diamond has not computed the fee", async function () {
      await diamond.setAdditionalOrderDetailsFeeUnready(true);
      await usdc.connect(walletA).approve(await integrator.getAddress(), USDC(302));
      await expect(
        integrator.connect(walletA).deliverPayout(orderId, ENC)
      ).to.be.revertedWithCustomError(integrator, "FeeNotReady");
    });

    it("reverts InsufficientFunding when the wallet's USDC balance is too low", async function () {
      // walletA only ever received 1000 in beforeEach; drain it below the 302 needed.
      const bal = await usdc.balanceOf(walletA.address);
      await usdc.connect(walletA).transfer(owner.address, bal - USDC(100)); // leaves 100 < 302
      await usdc.connect(walletA).approve(await integrator.getAddress(), USDC(302));
      await expect(
        integrator.connect(walletA).deliverPayout(orderId, ENC)
      ).to.be.revertedWithCustomError(integrator, "InsufficientFunding");
    });

    it("reverts InsufficientFunding when the wallet has balance but insufficient allowance", async function () {
      await usdc.connect(walletA).approve(await integrator.getAddress(), USDC(300)); // short by the fee
      await expect(
        integrator.connect(walletA).deliverPayout(orderId, ENC)
      ).to.be.revertedWithCustomError(integrator, "InsufficientFunding");
    });

    it("only the leg's wallet or the owner can deliver", async function () {
      await usdc.connect(walletA).approve(await integrator.getAddress(), USDC(302));
      await expect(
        integrator.connect(attacker).deliverPayout(orderId, ENC)
      ).to.be.revertedWithCustomError(integrator, "NotAuthorized");
      await integrator.connect(owner).deliverPayout(orderId, ENC); // keeper path ok
    });

    it("surfaces the Diamond's silent auto-cancel in the emitted status", async function () {
      await diamond.setForceSellUpiAutoCancel(true);
      await usdc.connect(walletA).approve(await integrator.getAddress(), USDC(302));
      const tx = await integrator.connect(walletA).deliverPayout(orderId, ENC);
      const rc = await tx.wait();
      const ev = rc!.logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p: any) => p?.name === "PayoutDelivered");
      expect(ev!.args[1]).to.equal(4); // CANCELLED — keeper must reconcile
    });

    it("unknown orderId reverts SellLegNotFound", async function () {
      await expect(
        integrator.connect(walletA).deliverPayout(999999, ENC)
      ).to.be.revertedWithCustomError(integrator, "SellLegNotFound");
    });

    it("an unswept refund on the proxy reduces the shortfall pulled from the wallet", async function () {
      // Deliver this leg (needed = 302) fully, then have it cancelled-after-PAID
      // so the mock refunds 302 back onto the proxy — and deliberately do NOT
      // reconcile, leaving it there as unswept dust.
      await usdc.connect(walletA).approve(await integrator.getAddress(), USDC(1000));
      await integrator.connect(walletA).deliverPayout(orderId, ENC);
      await diamond.cancelSellOrder(orderId); // refunds 302 to the proxy
      expect(await usdc.balanceOf(proxy)).to.equal(USDC(302));

      // Start a second leg needing 202 (principal 200 + fee 2). The 302
      // already sitting on the proxy fully covers it, so no wallet pull.
      await integrator.connect(walletA).userStartSell(USDC(200), INR, PK, CIRCLE, 0, 0);
      const orderId2 = (await diamond.getNextOrderId()) - 1n;
      await diamond.acceptSellOrder(orderId2, PK);

      const walletBefore = await usdc.balanceOf(walletA.address);
      await integrator.connect(walletA).deliverPayout(orderId2, ENC);
      expect(await usdc.balanceOf(walletA.address)).to.equal(walletBefore); // no pull needed
      expect(await usdc.balanceOf(proxy)).to.equal(USDC(100)); // 302 - 202 leftover dust
    });

    it("attack is gone: leg A cancelled and reconciled AFTER leg B was already delivered and paid", async function () {
      // Start a second leg B (200 + fee 2 = 202) alongside leg A (300 + fee 2 = 302).
      await integrator.connect(walletA).userStartSell(USDC(200), INR, PK, CIRCLE, 0, 0);
      const orderIdB = (await diamond.getNextOrderId()) - 1n;
      await diamond.acceptSellOrder(orderIdB, PK);

      await usdc.connect(walletA).approve(await integrator.getAddress(), USDC(1000));

      // Deliver B fully — funded and pulled entirely JIT, nothing parked on
      // the proxy for A to ever front-run.
      await integrator.connect(walletA).deliverPayout(orderIdB, ENC);
      const orderB = await diamond.getSellOrder(orderIdB);
      expect(orderB.status).to.equal(2); // PAID
      expect(await usdc.balanceOf(proxy)).to.equal(0n);

      // Now cancel leg A (still ACCEPTED, never delivered) and reconcile it —
      // under the old whole-balance-sweep design a permissionless reconcile
      // on A, timed after B's funding landed on the shared proxy, could have
      // swept B's parked funds. Here there is nothing to sweep and B is
      // untouched: its PAID status and pulled funds are unaffected.
      await diamond.cancelSellOrder(orderId);
      await integrator.reconcile(orderId);

      const orderBAfter = await diamond.getSellOrder(orderIdB);
      expect(orderBAfter.status).to.equal(2); // still PAID, undisturbed
      expect(await usdc.balanceOf(proxy)).to.equal(0n);
    });
  });

  describe("reconcile", function () {
    let orderId: bigint;
    let proxy: string;
    const ENC = "0x" + "cd".repeat(48);

    beforeEach(async function () {
      await integrator.addAccount(walletA.address);
      await integrator.connect(walletA).userStartSell(USDC(300), INR, PK, CIRCLE, 0, 0);
      orderId = (await diamond.getNextOrderId()) - 1n;
      proxy = await integrator.proxyAddress(walletA.address);
      await diamond.acceptSellOrder(orderId, PK);
      await diamond.setSellFee(USDC(2));
      await usdc.mint(walletA.address, USDC(1000));
    });

    it("completed leg: settles, frees the concurrency slot, keeps the daily debit", async function () {
      const day = BigInt(Math.floor((await ethers.provider.getBlock("latest"))!.timestamp / DAY));
      await usdc.connect(walletA).transfer(proxy, USDC(302));
      await integrator.connect(walletA).deliverPayout(orderId, ENC);
      await diamond.completeSellOrder(orderId);

      await expect(integrator.connect(attacker).reconcile(orderId)) // permissionless
        .to.emit(integrator, "SellReconciled");
      expect(await integrator.activeSellCount(walletA.address)).to.equal(0n);
      expect(await integrator.dailyVolume(walletA.address, day)).to.equal(USDC(300)); // consumed capacity stays
      const leg = await integrator.sellLegs(orderId);
      expect(leg.settled).to.equal(true);
      expect(leg.lastStatus).to.equal(3);
    });

    it("cancelled-after-PAID leg: refund swept from proxy back to the wallet, debit released", async function () {
      const day = BigInt(Math.floor((await ethers.provider.getBlock("latest"))!.timestamp / DAY));
      await usdc.connect(walletA).transfer(proxy, USDC(302));
      await integrator.connect(walletA).deliverPayout(orderId, ENC);
      const balBefore = await usdc.balanceOf(walletA.address);

      await diamond.cancelSellOrder(orderId); // mock refunds 302 to order.user = proxy
      await integrator.reconcile(orderId);

      expect(await usdc.balanceOf(walletA.address)).to.equal(balBefore + USDC(302));
      expect(await usdc.balanceOf(proxy)).to.equal(0n);
      expect(await integrator.activeSellCount(walletA.address)).to.equal(0n);
      expect(await integrator.dailyVolume(walletA.address, day)).to.equal(0n); // released
    });

    it("reverts DisputedOrder on a CANCELLED leg with a raised dispute, leaving it unsettled", async function () {
      await usdc.connect(walletA).transfer(proxy, USDC(302));
      await integrator.connect(walletA).deliverPayout(orderId, ENC);
      await diamond.cancelSellOrder(orderId); // refunds 302 to the proxy

      await diamond.setSellDispute(orderId, /* raisedBy */ 1, /* status */ 0);
      await expect(integrator.reconcile(orderId)).to.be.revertedWithCustomError(
        integrator,
        "DisputedOrder"
      );
      // Nothing was mutated: leg still unsettled, slot still held, funds untouched.
      const leg = await integrator.sellLegs(orderId);
      expect(leg.settled).to.equal(false);
      expect(await integrator.activeSellCount(walletA.address)).to.equal(1n);
      expect(await usdc.balanceOf(proxy)).to.equal(USDC(302));
    });

    it("reverts DisputedOrder on a CANCELLED leg with a settled dispute (status != 0)", async function () {
      await diamond.cancelSellOrder(orderId); // still ACCEPTED pre-delivery
      await diamond.setSellDispute(orderId, /* raisedBy */ 0, /* status */ 2);
      await expect(integrator.reconcile(orderId)).to.be.revertedWithCustomError(
        integrator,
        "DisputedOrder"
      );
    });

    it("COMPLETED legs are unaffected by the dispute guard (only checked on CANCELLED)", async function () {
      await usdc.connect(walletA).transfer(proxy, USDC(302));
      await integrator.connect(walletA).deliverPayout(orderId, ENC);
      await diamond.completeSellOrder(orderId);
      await diamond.setSellDispute(orderId, 1, 1); // even a raised+settled dispute
      await expect(integrator.reconcile(orderId)).to.emit(integrator, "SellReconciled");
    });

    it("cancelled-before-funding leg: nothing to sweep, slot freed", async function () {
      await diamond.cancelSellOrder(orderId);
      await integrator.reconcile(orderId);
      expect(await integrator.activeSellCount(walletA.address)).to.equal(0n);
    });

    it("unknown orderId reverts SellLegNotFound", async function () {
      await expect(integrator.reconcile(999999)).to.be.revertedWithCustomError(
        integrator,
        "SellLegNotFound"
      );
    });

    it("rejects non-terminal status and double reconciliation", async function () {
      await expect(integrator.reconcile(orderId)).to.be.revertedWithCustomError(
        integrator,
        "NotTerminal"
      ); // still ACCEPTED
      await diamond.cancelSellOrder(orderId);
      await integrator.reconcile(orderId);
      await expect(integrator.reconcile(orderId)).to.be.revertedWithCustomError(
        integrator,
        "AlreadyReconciled"
      );
    });

    it("full split scenario: 300 + 200 legs, one completes, one cancels and refunds", async function () {
      // Second leg.
      await integrator.connect(walletA).userStartSell(USDC(200), INR, PK, CIRCLE, 0, 0);
      const orderId2 = (await diamond.getNextOrderId()) - 1n;
      await diamond.acceptSellOrder(orderId2, PK);

      // Leg 1 completes.
      await usdc.connect(walletA).transfer(proxy, USDC(302));
      await integrator.connect(walletA).deliverPayout(orderId, ENC);
      await diamond.completeSellOrder(orderId);
      await integrator.reconcile(orderId);

      // Leg 2 funded, then cancelled by the protocol.
      await usdc.connect(walletA).transfer(proxy, USDC(202));
      await integrator.connect(walletA).deliverPayout(orderId2, ENC);
      const balBefore = await usdc.balanceOf(walletA.address);
      await diamond.cancelSellOrder(orderId2);
      await integrator.reconcile(orderId2);

      expect(await usdc.balanceOf(walletA.address)).to.equal(balBefore + USDC(202));
      expect(await integrator.activeSellCount(walletA.address)).to.equal(0n);
    });
  });
});
