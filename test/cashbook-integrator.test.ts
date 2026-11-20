import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * CashbookRampIntegrator: fiat in, merchant stake out.
 *
 * A person pays fiat (a B2B BUY). The USDC lands on this contract and is
 * recorded against them (pendingStake). A second transaction, stakeDeposit,
 * stakes it into the person's OWN merchant account on the Diamond: registerFor
 * on the first deposit, stakeFor after. Withdrawing is a B2B SELL of the
 * person's own USDC.
 *
 * The properties that carry the design:
 *   - USDC delivered here only ever leaves as that person's stake. No function
 *     sends it to a person (checked by the balance identity in `holds()`).
 *   - stakeDeposit is permissionless but cannot be steered: the account, the
 *     amount, the currency and the circle all come from stored state.
 *   - an opening deposit reserves its bonus at placement and must reach the
 *     Diamond's stake floor on its own, so no money waits on a top-up.
 *
 * Not provable here: the Diamond's shared reentrancy lock, which is why the
 * hook records and a second transaction stakes. The mock has no such lock.
 */
describe("CashbookRampIntegrator", function () {
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let stranger: SignerWithAddress;

  let usdc: any;
  let diamond: any;
  let rm: any;
  let integrator: any;
  let iAddr: string;
  let dAddr: string;

  const USDC = (n: number | string) => ethers.parseUnits(n.toString(), 6);
  const INR = ethers.encodeBytes32String("INR");
  const BRL = ethers.encodeBytes32String("BRL");
  const REF = ethers.encodeBytes32String("ref-1");
  const CIRCLE = 1n;
  const ORDER_CIRCLE = 7n; // where an order is matched; never where the account opens
  const FLOOR = USDC(100);
  const MAX_BUY = USDC(400);
  const BONUS = USDC(5);
  const POOL = USDC(50);

  async function deployIntegrator(rmAddr: string) {
    const f = await ethers.getContractFactory("CashbookRampIntegrator");
    const i = await f.deploy(dAddr, await usdc.getAddress(), owner.address, rmAddr);
    await diamond.registerIntegrator(await i.getAddress(), await i.proxyImpl());
    return i;
  }

  beforeEach(async function () {
    [owner, alice, bob, stranger] = await ethers.getSigners();
    usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    diamond = await (
      await ethers.getContractFactory("MockCashbookDiamond")
    ).deploy(await usdc.getAddress());
    dAddr = await diamond.getAddress();
    rm = await (await ethers.getContractFactory("MockReputationManager")).deploy();
    integrator = await deployIntegrator(await rm.getAddress());
    iAddr = await integrator.getAddress();
    // Registered with usdcThroughIntegrator = false: the Diamond pays the
    // order's recipientAddr, which this integrator always sets to itself.
    await diamond.setUsdcThroughIntegrator(false);

    for (const cur of [INR, BRL]) {
      await diamond.setFloor(cur, FLOOR);
      await diamond.setMaxBuy(cur, MAX_BUY);
    }
    await integrator.setCircle(INR, CIRCLE);
    await integrator.setBonus(INR, BONUS);
    await usdc.mint(owner.address, POOL);
    await usdc.approve(iAddr, POOL);
    await integrator.fundBonus(INR, POOL);
  });

  const deposit = (who: SignerWithAddress, amount: bigint, cur = INR) =>
    integrator.connect(who).depositFiat(amount, cur, ORDER_CIRCLE, "pk", 0, 0, REF);

  /** The Diamond completes a BUY: it sends the USDC, then calls the hook. */
  async function settle(orderId: number) {
    const o = await diamond.orders(orderId);
    await usdc.mint(dAddr, o.amount);
    await diamond.simulateOrderComplete(orderId);
  }

  /** Every USDC this contract holds is someone's pending stake, a reserved
   *  bonus, or a currency's pool. Nothing else can be on it. */
  async function holds(users: SignerWithAddress[]) {
    let sum = 0n;
    for (const u of users) {
      sum += await integrator.pendingStake(u.address);
      sum += (await integrator.openings(u.address)).bonus;
    }
    sum += (await integrator.bonusPool(INR)) + (await integrator.bonusPool(BRL));
    expect(await usdc.balanceOf(iAddr)).to.equal(sum);
  }

  describe("deployment", function () {
    it("refuses a zero Diamond or USDC", async function () {
      const f = await ethers.getContractFactory("CashbookRampIntegrator");
      const u = await usdc.getAddress();
      await expect(
        f.deploy(ethers.ZeroAddress, u, owner.address, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(f, "InvalidAddress");
      await expect(
        f.deploy(dAddr, ethers.ZeroAddress, owner.address, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(f, "InvalidAddress");
    });

    it("refuses a zero owner", async function () {
      const f = await ethers.getContractFactory("CashbookRampIntegrator");
      await expect(
        f.deploy(dAddr, await usdc.getAddress(), ethers.ZeroAddress, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(f, "OwnableInvalidOwner");
    });

    it("pins its immutables and deploys its own UserProxy implementation", async function () {
      expect(await integrator.diamond()).to.equal(dAddr);
      expect(await integrator.usdc()).to.equal(await usdc.getAddress());
      expect(await integrator.reputationManager()).to.equal(await rm.getAddress());
      expect(await ethers.provider.getCode(await integrator.proxyImpl())).to.not.equal("0x");
      expect(await integrator.owner()).to.equal(owner.address);
    });
  });

  describe("access control", function () {
    it("only the owner sets circles and bonuses, or withdraws the pool", async function () {
      const c = integrator.connect(stranger);
      await expect(c.setBonus(INR, 1)).to.be.revertedWithCustomError(
        integrator,
        "OwnableUnauthorizedAccount"
      );
      await expect(c.setCircle(INR, 2)).to.be.revertedWithCustomError(
        integrator,
        "OwnableUnauthorizedAccount"
      );
      await expect(c.withdrawBonus(INR, 1)).to.be.revertedWithCustomError(
        integrator,
        "OwnableUnauthorizedAccount"
      );
    });

    it("ownership can never be renounced, even by the owner", async function () {
      await expect(integrator.renounceOwnership()).to.be.revertedWithCustomError(
        integrator,
        "CannotRenounce"
      );
    });

    it("ownership moves in two steps", async function () {
      await integrator.transferOwnership(bob.address);
      expect(await integrator.owner()).to.equal(owner.address);
      await expect(integrator.connect(stranger).acceptOwnership()).to.be.revertedWithCustomError(
        integrator,
        "OwnableUnauthorizedAccount"
      );
      await integrator.connect(bob).acceptOwnership();
      expect(await integrator.owner()).to.equal(bob.address);
      await expect(integrator.setBonus(INR, 1)).to.be.revertedWithCustomError(
        integrator,
        "OwnableUnauthorizedAccount"
      );
    });

    it("the Diamond callbacks refuse anyone but the Diamond", async function () {
      const c = integrator.connect(stranger);
      await expect(c.validateOrder(alice.address, 1, INR)).to.be.revertedWithCustomError(
        integrator,
        "OnlyDiamond"
      );
      await expect(
        c.onOrderComplete(1, alice.address, USDC(100), iAddr)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
      await expect(c.onOrderCancel(1)).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
    });
  });

  describe("owner settings", function () {
    it("setBonus and setCircle store and emit", async function () {
      await expect(integrator.setBonus(BRL, USDC(3)))
        .to.emit(integrator, "BonusSet")
        .withArgs(BRL, USDC(3));
      await expect(integrator.setCircle(BRL, 2)).to.emit(integrator, "CircleSet").withArgs(BRL, 2);
      expect(await integrator.bonus(BRL)).to.equal(USDC(3));
      expect(await integrator.circleOf(BRL)).to.equal(2n);
    });

    it("withdrawBonus takes only unreserved pool money, to the owner", async function () {
      await expect(integrator.withdrawBonus(INR, 0)).to.be.revertedWithCustomError(
        integrator,
        "InvalidAmount"
      );
      await deposit(alice, USDC(100)); // reserves BONUS
      await expect(integrator.withdrawBonus(INR, POOL - BONUS + 1n)).to.be.revertedWithCustomError(
        integrator,
        "BonusPoolShort"
      );
      await expect(integrator.withdrawBonus(INR, POOL - BONUS))
        .to.emit(integrator, "BonusWithdrawn")
        .withArgs(INR, owner.address, POOL - BONUS);
      expect(await usdc.balanceOf(owner.address)).to.equal(POOL - BONUS);
      await holds([alice]);
    });

    it("anyone may fund a pool; zero is refused", async function () {
      await expect(integrator.connect(stranger).fundBonus(BRL, 0)).to.be.revertedWithCustomError(
        integrator,
        "InvalidAmount"
      );
      await usdc.mint(stranger.address, USDC(10));
      await usdc.connect(stranger).approve(iAddr, USDC(10));
      await expect(integrator.connect(stranger).fundBonus(BRL, USDC(10)))
        .to.emit(integrator, "BonusFunded")
        .withArgs(stranger.address, BRL, USDC(10));
      expect(await integrator.bonusPool(BRL)).to.equal(USDC(10));
    });
  });

  describe("depositFiat: refused before any money moves", function () {
    it("a zero amount", async function () {
      await expect(deposit(alice, 0n)).to.be.revertedWithCustomError(integrator, "InvalidAmount");
    });

    it("a merchant on the Diamond's blacklist", async function () {
      await diamond.setMerchantBlacklisted(alice.address, true);
      await expect(deposit(alice, USDC(100))).to.be.revertedWithCustomError(
        integrator,
        "MerchantBlacklisted"
      );
    });

    it("a user on ReputationManager's blacklist", async function () {
      await rm.setBlacklisted(alice.address, true);
      await expect(deposit(alice, USDC(100))).to.be.revertedWithCustomError(
        integrator,
        "UserBlacklisted"
      );
    });

    it("with no ReputationManager the user check is off", async function () {
      await rm.setBlacklisted(alice.address, true);
      const open = await deployIntegrator(ethers.ZeroAddress);
      await open.setCircle(INR, CIRCLE);
      await expect(open.connect(alice).depositFiat(USDC(100), INR, ORDER_CIRCLE, "pk", 0, 0, REF))
        .to.not.be.reverted;
    });

    it("more than the Diamond's max buy; a max of 0 closes the currency", async function () {
      await expect(deposit(alice, MAX_BUY + 1n)).to.be.revertedWithCustomError(
        integrator,
        "AmountExceedsCap"
      );
      await diamond.setMaxBuy(INR, 0);
      await expect(deposit(alice, USDC(100))).to.be.revertedWithCustomError(
        integrator,
        "AmountExceedsCap"
      );
    });

    it("an opening in a currency with no circle set", async function () {
      await expect(deposit(alice, USDC(100), BRL)).to.be.revertedWithCustomError(
        integrator,
        "CircleNotSet"
      );
    });

    it("an opening the pool cannot cover; a bonus of 0 passes", async function () {
      await integrator.setBonus(INR, POOL + 1n);
      await expect(deposit(alice, USDC(100))).to.be.revertedWithCustomError(integrator, "NoBonus");
      await integrator.setBonus(INR, 0);
      await integrator.withdrawBonus(INR, POOL);
      await expect(deposit(alice, USDC(100))).to.not.be.reverted;
    });

    it("an opening short of the floor, with the bonus counted", async function () {
      await expect(deposit(alice, FLOOR - BONUS - 1n)).to.be.revertedWithCustomError(
        integrator,
        "BelowStakeFloor"
      );
      await expect(deposit(alice, FLOOR - BONUS)).to.not.be.reverted;
    });

    it("an account in another currency", async function () {
      await diamond.setMerchant(alice.address, FLOOR, BRL);
      await expect(deposit(alice, USDC(10))).to.be.revertedWithCustomError(
        integrator,
        "SeatCurrencyMismatch"
      );
    });

    it("an account mid-unstake", async function () {
      await diamond.setMerchant(alice.address, FLOOR, INR);
      await diamond.setUnstakeRequested(alice.address, true);
      await expect(deposit(alice, USDC(10))).to.be.revertedWithCustomError(
        integrator,
        "UnstakePending"
      );
    });
  });

  describe("depositFiat: placement", function () {
    it("places a BUY from the person's proxy: user = the person, recipient = us", async function () {
      const proxy = await integrator.proxyAddress(alice.address);
      expect(await ethers.provider.getCode(proxy)).to.equal("0x");
      await expect(deposit(alice, USDC(100)))
        .to.emit(integrator, "UserProxyDeployed")
        .withArgs(alice.address, proxy)
        .and.to.emit(integrator, "BonusReserved")
        .withArgs(1, alice.address, BONUS)
        .and.to.emit(integrator, "DepositPlaced")
        .withArgs(1, alice.address, USDC(100), INR, REF);
      const o = await diamond.orders(1);
      expect(o.integrator).to.equal(iAddr);
      expect(o.user).to.equal(alice.address);
      expect(o.recipientAddr).to.equal(iAddr);
      const op = await integrator.openings(alice.address);
      expect([op.orderId, op.bonus, op.currency]).to.deep.equal([1n, BONUS, INR]);
      expect(await integrator.bonusPool(INR)).to.equal(POOL - BONUS);
    });

    it("a second deposit while the opening is live takes no second bonus", async function () {
      await deposit(alice, USDC(100));
      // undelivered money does not count toward the floor
      await expect(deposit(alice, USDC(10))).to.be.revertedWithCustomError(
        integrator,
        "BelowStakeFloor"
      );
      await settle(1);
      await expect(deposit(alice, USDC(10)))
        .to.not.emit(integrator, "BonusReserved")
        .and.to.not.emit(integrator, "UserProxyDeployed");
      expect((await integrator.openings(alice.address)).orderId).to.equal(1n);
      expect(await integrator.bonusPool(INR)).to.equal(POOL - BONUS);
    });

    it("a live opening refuses a deposit in another currency", async function () {
      await integrator.setCircle(BRL, 2);
      await deposit(alice, USDC(100));
      await expect(deposit(alice, USDC(100), BRL)).to.be.revertedWithCustomError(
        integrator,
        "SeatCurrencyMismatch"
      );
    });

    it("a cancelled opening is released and the next deposit reserves afresh", async function () {
      await deposit(alice, USDC(100));
      await diamond.connect(alice).cancelOrder(1);
      await expect(deposit(alice, USDC(100)))
        .to.emit(integrator, "BonusReleased")
        .withArgs(1, alice.address, BONUS)
        .and.to.emit(integrator, "BonusReserved")
        .withArgs(2, alice.address, BONUS);
      expect((await integrator.openings(alice.address)).orderId).to.equal(2n);
      await holds([alice]);
    });

    it("a top-up has no floor and reserves nothing", async function () {
      await diamond.setMerchant(alice.address, FLOOR, INR);
      await expect(deposit(alice, 1n)).to.not.emit(integrator, "BonusReserved");
      expect((await integrator.openings(alice.address)).orderId).to.equal(0n);
    });
  });

  describe("completion: onOrderComplete and reconcileDelivery", function () {
    it("the hook credits the person's pending stake and nothing more", async function () {
      await deposit(alice, USDC(100));
      await usdc.mint(dAddr, USDC(100));
      await expect(diamond.simulateOrderComplete(1))
        .to.emit(integrator, "DepositDelivered")
        .withArgs(1, alice.address, USDC(100));
      expect(await integrator.pendingStake(alice.address)).to.equal(USDC(100));
      expect(await integrator.credited(1)).to.equal(true);
      expect((await diamond.getMerchantDetails(alice.address)).isRegistered).to.equal(false);
      await holds([alice]);
    });

    it("a replayed hook credits nothing twice", async function () {
      await deposit(alice, USDC(100));
      await settle(1);
      await diamond.adminCallOnOrderComplete(iAddr, 1, alice.address, USDC(100), iAddr);
      expect(await integrator.pendingStake(alice.address)).to.equal(USDC(100));
    });

    it("the hook ignores a completion not paid to us", async function () {
      await diamond.adminCallOnOrderComplete(iAddr, 9, alice.address, USDC(100), stranger.address);
      expect(await integrator.pendingStake(alice.address)).to.equal(0n);
      expect(await integrator.credited(9)).to.equal(false);
    });

    it("reconcileDelivery credits a completion whose hook never ran", async function () {
      await deposit(alice, USDC(100));
      await expect(integrator.reconcileDelivery(1)).to.be.revertedWithCustomError(
        integrator,
        "DepositNotDelivered"
      );
      await usdc.mint(dAddr, USDC(100));
      await diamond.simulateOrderCompleteNoCallback(1);
      await expect(integrator.connect(stranger).reconcileDelivery(1))
        .to.emit(integrator, "DepositDelivered")
        .withArgs(1, alice.address, USDC(100));
      await expect(integrator.reconcileDelivery(1)).to.be.revertedWithCustomError(
        integrator,
        "OrderAlreadyFulfilled"
      );
      await holds([alice]);
    });

    it("reconcileDelivery refuses another integrator's order", async function () {
      const other = await deployIntegrator(ethers.ZeroAddress);
      await other.setCircle(INR, CIRCLE);
      await other.connect(alice).depositFiat(USDC(100), INR, ORDER_CIRCLE, "pk", 0, 0, REF);
      await expect(integrator.reconcileDelivery(1)).to.be.revertedWithCustomError(
        integrator,
        "NotOurs"
      );
    });

    it("reconcileDelivery refuses our order paid to someone else", async function () {
      await deposit(alice, USDC(100));
      await diamond.setOrderRecipient(1, stranger.address);
      await expect(integrator.reconcileDelivery(1)).to.be.revertedWithCustomError(
        integrator,
        "NotOurs"
      );
    });

    it("a cancellation needs nothing undone and never reverts", async function () {
      await deposit(alice, USDC(100));
      await expect(diamond.simulateOrderCancelled(1)).to.not.emit(
        diamond,
        "MockIntegratorCallbackFailed"
      );
      // the reservation stands until releaseBonus or the next deposit
      expect((await integrator.openings(alice.address)).bonus).to.equal(BONUS);
    });
  });

  describe("stakeDeposit", function () {
    it("refuses an order not delivered here", async function () {
      await deposit(alice, USDC(100));
      await expect(integrator.stakeDeposit(1)).to.be.revertedWithCustomError(
        integrator,
        "DepositNotDelivered"
      );
    });

    it("opens the account: registerFor with pending + bonus, in circleOf", async function () {
      await deposit(alice, USDC(100));
      await settle(1);
      await expect(integrator.connect(stranger).stakeDeposit(1))
        .to.emit(diamond, "MockRegisteredFor")
        .withArgs(alice.address, CIRCLE, USDC(100) + BONUS, INR)
        .and.to.emit(integrator, "DepositStaked")
        .withArgs(1, alice.address, USDC(100), BONUS, true);
      const m = await diamond.getMerchantDetails(alice.address);
      expect(m.stake).to.equal(USDC(100) + BONUS);
      expect(await diamond.merchantCircle(alice.address)).to.equal(CIRCLE);
      expect(await integrator.pendingStake(alice.address)).to.equal(0n);
      expect((await integrator.openings(alice.address)).orderId).to.equal(0n);
      expect(await usdc.allowance(iAddr, dAddr)).to.equal(0n);
      await holds([alice]);
    });

    it("cannot stake the same money twice", async function () {
      await deposit(alice, USDC(100));
      await settle(1);
      await integrator.stakeDeposit(1);
      await expect(integrator.stakeDeposit(1)).to.be.revertedWithCustomError(
        integrator,
        "DepositAlreadyStaked"
      );
    });

    it("tops up an existing account with stakeFor, in its currency", async function () {
      await deposit(alice, USDC(100));
      await settle(1);
      await integrator.stakeDeposit(1);
      await deposit(alice, USDC(10));
      await settle(2);
      await expect(integrator.stakeDeposit(2))
        .to.emit(diamond, "MockStakedFor")
        .withArgs(alice.address, USDC(10), INR)
        .and.to.emit(integrator, "DepositStaked")
        .withArgs(2, alice.address, USDC(10), 0, false);
      expect((await diamond.getMerchantDetails(alice.address)).stake).to.equal(USDC(110) + BONUS);
      await holds([alice]);
    });

    it("an account opened elsewhere meanwhile: the bonus goes back to the pool", async function () {
      await deposit(alice, USDC(100));
      await settle(1);
      await diamond.setMerchant(alice.address, FLOOR, INR);
      await expect(integrator.stakeDeposit(1))
        .to.emit(integrator, "BonusReleased")
        .withArgs(1, alice.address, BONUS)
        .and.to.emit(integrator, "DepositStaked")
        .withArgs(1, alice.address, USDC(100), 0, false);
      expect(await integrator.bonusPool(INR)).to.equal(POOL);
      await holds([alice]);
    });

    it("waits, nothing lost, if the circle was unset after the deposit", async function () {
      await deposit(alice, USDC(100));
      await settle(1);
      await integrator.setCircle(INR, 0);
      await expect(integrator.stakeDeposit(1)).to.be.revertedWithCustomError(
        integrator,
        "CircleNotSet"
      );
      await integrator.setCircle(INR, CIRCLE);
      await expect(integrator.stakeDeposit(1)).to.emit(integrator, "DepositStaked");
    });

    it("opens in the opening's currency and circle, not the named order's", async function () {
      await integrator.setCircle(BRL, 2);
      await deposit(alice, USDC(100)); // 1: INR opening
      await diamond.connect(alice).cancelOrder(1);
      await integrator.releaseBonus(alice.address);
      await deposit(alice, USDC(100), BRL); // 2: BRL opening
      await settle(1); // the cancelled INR order completes after all (dispute)
      await expect(integrator.stakeDeposit(1))
        .to.emit(diamond, "MockRegisteredFor")
        .withArgs(alice.address, 2, USDC(100), BRL);
      await holds([alice]);
    });

    it("with no opening left, opens in the order's own currency, no bonus", async function () {
      await deposit(alice, USDC(100));
      await diamond.connect(alice).cancelOrder(1);
      await integrator.releaseBonus(alice.address);
      await settle(1);
      await expect(integrator.stakeDeposit(1))
        .to.emit(diamond, "MockRegisteredFor")
        .withArgs(alice.address, CIRCLE, USDC(100), INR);
      await holds([alice]);
    });

    it("stakes only that person's money", async function () {
      await deposit(alice, USDC(100));
      await deposit(bob, USDC(200));
      await settle(1);
      await settle(2);
      await integrator.stakeDeposit(1);
      expect(await integrator.pendingStake(bob.address)).to.equal(USDC(200));
      expect((await diamond.getMerchantDetails(alice.address)).stake).to.equal(USDC(100) + BONUS);
      await holds([alice, bob]);
    });
  });

  describe("releaseBonus", function () {
    it("refuses with no opening, or an opening still live", async function () {
      await expect(integrator.releaseBonus(alice.address)).to.be.revertedWithCustomError(
        integrator,
        "NotCancelled"
      );
      await deposit(alice, USDC(100));
      await expect(integrator.releaseBonus(alice.address)).to.be.revertedWithCustomError(
        integrator,
        "NotCancelled"
      );
    });

    it("anyone returns a cancelled opening's bonus to its pool, once", async function () {
      await deposit(alice, USDC(100));
      await diamond.connect(alice).cancelOrder(1);
      await expect(integrator.connect(stranger).releaseBonus(alice.address))
        .to.emit(integrator, "BonusReleased")
        .withArgs(1, alice.address, BONUS);
      expect(await integrator.bonusPool(INR)).to.equal(POOL);
      await expect(integrator.releaseBonus(alice.address)).to.be.revertedWithCustomError(
        integrator,
        "NotCancelled"
      );
      await holds([alice]);
    });
  });

  describe("withdrawFiat", function () {
    it("refuses a zero amount or someone with no account", async function () {
      await expect(
        integrator.connect(alice).withdrawFiat(0, INR, ORDER_CIRCLE, "pk", 0, 0, REF)
      ).to.be.revertedWithCustomError(integrator, "InvalidAmount");
      await expect(
        integrator.connect(alice).withdrawFiat(USDC(10), INR, ORDER_CIRCLE, "pk", 0, 0, REF)
      ).to.be.revertedWithCustomError(integrator, "NoSeat");
    });

    it("places a SELL with user = the person, and holds nothing", async function () {
      await diamond.setMerchant(alice.address, FLOOR, INR);
      await expect(
        integrator.connect(alice).withdrawFiat(USDC(10), INR, ORDER_CIRCLE, "pk", 0, 0, REF)
      )
        .to.emit(integrator, "WithdrawalPlaced")
        .withArgs(1, alice.address, USDC(10), INR, REF)
        .and.to.emit(diamond, "MockSellOrderPlaced")
        .withArgs(1, alice.address, USDC(10), INR);
      expect(await usdc.balanceOf(iAddr)).to.equal(POOL);
    });
  });
});
