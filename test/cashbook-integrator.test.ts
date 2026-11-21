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
 * person's own USDC, only for an account opened here.
 *
 * The properties that carry the design:
 *   - USDC delivered here only ever leaves as that person's stake. No function
 *     sends it to a person (checked by the balance identity in `holds()`).
 *   - stakeDeposit is permissionless but cannot be steered: the account, the
 *     amount, the currency and the circle all come from stored state.
 *   - every deposit must leave the account at the Diamond's stake floor, so no
 *     money waits on a stake the Diamond would refuse.
 *   - the bonus is never part of the floor: it is set aside when the account
 *     opens and vests only on real volume.
 *   - B2B orders skip the Diamond's per-person limits, so the per-tx caps and
 *     daily counts here are the only ones; both directions have them.
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
  const MAX_SELL = USDC(300);
  const BONUS = USDC(5);
  const VEST = USDC(1000);
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
      await diamond.setMaxSell(cur, MAX_SELL);
    }
    await integrator.setCircle(INR, CIRCLE);
    await integrator.setBonus(INR, BONUS, VEST);
    await usdc.mint(owner.address, POOL);
    await usdc.approve(iAddr, POOL);
    await integrator.fundBonus(INR, POOL);
  });

  const deposit = (who: SignerWithAddress, amount: bigint, cur = INR) =>
    integrator.connect(who).depositFiat(amount, cur, ORDER_CIRCLE, "pk", 0, 0, REF);

  const withdraw = (who: SignerWithAddress, amount: bigint, cur = INR) =>
    integrator.connect(who).withdrawFiat(amount, cur, ORDER_CIRCLE, "pk", 0, 0, REF);

  /** The Diamond completes a BUY: it sends the USDC, then calls the hook. */
  async function settle(orderId: number) {
    const o = await diamond.orders(orderId);
    await usdc.mint(dAddr, o.amount);
    await diamond.simulateOrderComplete(orderId);
  }

  /** Open `who`'s account here with one floor deposit; returns its order id. */
  async function open(who: SignerWithAddress) {
    const id = Number(await diamond.nextOrderId());
    await deposit(who, FLOOR);
    await settle(id);
    await integrator.stakeDeposit(id);
    return id;
  }

  async function nextDay() {
    await ethers.provider.send("evm_increaseTime", [86400]);
    await ethers.provider.send("evm_mine", []);
  }

  /** Every USDC this contract holds is someone's pending stake, a vesting
   *  bonus, or a currency's pool. Nothing else can be on it. */
  async function holds(users: SignerWithAddress[]) {
    let sum = 0n;
    for (const u of users) {
      sum += await integrator.pendingStake(u.address);
      sum += (await integrator.vesting(u.address)).amount;
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

    it("pins its immutables, limits and its own UserProxy implementation", async function () {
      expect(await integrator.diamond()).to.equal(dAddr);
      expect(await integrator.usdc()).to.equal(await usdc.getAddress());
      expect(await integrator.reputationManager()).to.equal(await rm.getAddress());
      expect(await ethers.provider.getCode(await integrator.proxyImpl())).to.not.equal("0x");
      expect(await integrator.owner()).to.equal(owner.address);
      expect(await integrator.MAX_DEPOSITS_PER_DAY()).to.equal(5n);
      expect(await integrator.MAX_WITHDRAWALS_PER_DAY()).to.equal(5n);
    });
  });

  describe("access control", function () {
    it("only the owner sets circles and bonuses, or withdraws the pool", async function () {
      const c = integrator.connect(stranger);
      await expect(c.setBonus(INR, 1, 1)).to.be.revertedWithCustomError(
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
      await expect(integrator.setBonus(INR, 1, 1)).to.be.revertedWithCustomError(
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
      await expect(integrator.setBonus(BRL, USDC(3), USDC(500)))
        .to.emit(integrator, "BonusSet")
        .withArgs(BRL, USDC(3), USDC(500));
      await expect(integrator.setCircle(BRL, 2)).to.emit(integrator, "CircleSet").withArgs(BRL, 2);
      expect(await integrator.bonus(BRL)).to.equal(USDC(3));
      expect(await integrator.vestVolume(BRL)).to.equal(USDC(500));
      expect(await integrator.circleOf(BRL)).to.equal(2n);
    });

    it("withdrawBonus takes only the pool, never a vesting bonus", async function () {
      await expect(integrator.withdrawBonus(INR, 0)).to.be.revertedWithCustomError(
        integrator,
        "InvalidAmount"
      );
      await open(alice); // sets BONUS aside
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
      await expect(deposit(alice, FLOOR)).to.be.revertedWithCustomError(
        integrator,
        "MerchantBlacklisted"
      );
    });

    it("a user on ReputationManager's blacklist", async function () {
      await rm.setBlacklisted(alice.address, true);
      await expect(deposit(alice, FLOOR)).to.be.revertedWithCustomError(
        integrator,
        "UserBlacklisted"
      );
    });

    it("with no ReputationManager the user check is off", async function () {
      await rm.setBlacklisted(alice.address, true);
      const i = await deployIntegrator(ethers.ZeroAddress);
      await i.setCircle(INR, CIRCLE);
      await expect(i.connect(alice).depositFiat(FLOOR, INR, ORDER_CIRCLE, "pk", 0, 0, REF)).to.not
        .be.reverted;
    });

    it("more than the Diamond's max buy; a max of 0 closes the currency", async function () {
      await expect(deposit(alice, MAX_BUY + 1n)).to.be.revertedWithCustomError(
        integrator,
        "AmountExceedsCap"
      );
      await diamond.setMaxBuy(INR, 0);
      await expect(deposit(alice, FLOOR)).to.be.revertedWithCustomError(
        integrator,
        "AmountExceedsCap"
      );
    });

    it("an opening in a currency with no circle set", async function () {
      await expect(deposit(alice, FLOOR, BRL)).to.be.revertedWithCustomError(
        integrator,
        "CircleNotSet"
      );
      // the revert leaves the person unbound
      expect(await integrator.currencyOf(alice.address)).to.equal(ethers.ZeroHash);
    });

    it("an opening short of the floor: the bonus never counts toward it", async function () {
      await expect(deposit(alice, FLOOR - 1n)).to.be.revertedWithCustomError(
        integrator,
        "BelowStakeFloor"
      );
      await expect(deposit(alice, FLOOR - BONUS)).to.be.revertedWithCustomError(
        integrator,
        "BelowStakeFloor"
      );
      await expect(deposit(alice, FLOOR)).to.not.be.reverted;
    });

    it("a top-up that would leave the account below the floor", async function () {
      // unstaked to 0 (still registered), or slashed below the floor
      await diamond.setMerchant(alice.address, USDC(40), INR);
      await expect(deposit(alice, USDC(59))).to.be.revertedWithCustomError(
        integrator,
        "BelowStakeFloor"
      );
      await expect(deposit(alice, USDC(60))).to.not.be.reverted;
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

    it("a sixth deposit in one UTC day; the next day counts afresh", async function () {
      await diamond.setMerchant(alice.address, FLOOR, INR);
      for (let i = 0; i < 5; i++) await deposit(alice, USDC(1));
      await expect(deposit(alice, USDC(1))).to.be.revertedWithCustomError(
        integrator,
        "DailyLimitReached"
      );
      // another person's count is their own
      await diamond.setMerchant(bob.address, FLOOR, INR);
      await expect(deposit(bob, USDC(1))).to.not.be.reverted;
      await nextDay();
      await expect(deposit(alice, USDC(1))).to.not.be.reverted;
    });

    it("a cancelled deposit still counts", async function () {
      await diamond.setMerchant(alice.address, FLOOR, INR);
      for (let i = 1; i <= 5; i++) {
        await deposit(alice, USDC(1));
        await diamond.connect(alice).cancelOrder(i);
      }
      await expect(deposit(alice, USDC(1))).to.be.revertedWithCustomError(
        integrator,
        "DailyLimitReached"
      );
    });
  });

  describe("depositFiat: placement", function () {
    it("places a BUY from the person's proxy: user = the person, recipient = us", async function () {
      const proxy = await integrator.proxyAddress(alice.address);
      expect(await ethers.provider.getCode(proxy)).to.equal("0x");
      await expect(deposit(alice, FLOOR))
        .to.emit(integrator, "UserProxyDeployed")
        .withArgs(alice.address, proxy)
        .and.to.emit(integrator, "DepositPlaced")
        .withArgs(1, alice.address, FLOOR, INR, REF);
      const o = await diamond.orders(1);
      expect(o.integrator).to.equal(iAddr);
      expect(o.user).to.equal(alice.address);
      expect(o.recipientAddr).to.equal(iAddr);
      expect(await integrator.currencyOf(alice.address)).to.equal(INR);
      expect(await integrator.depositsOn(alice.address, await today())).to.equal(1n);
      // nothing is set aside at placement: an unpaid order holds no pool money
      expect(await integrator.bonusPool(INR)).to.equal(POOL);
    });

    it("a second deposit counts only delivered money toward the floor", async function () {
      await deposit(alice, FLOOR);
      await expect(deposit(alice, USDC(10))).to.be.revertedWithCustomError(
        integrator,
        "BelowStakeFloor"
      );
      await settle(1);
      await expect(deposit(alice, USDC(10))).to.not.emit(integrator, "UserProxyDeployed");
    });

    it("someone with no account stays bound to their first deposit's currency", async function () {
      await integrator.setCircle(BRL, 2);
      await deposit(alice, FLOOR);
      await diamond.connect(alice).cancelOrder(1);
      await expect(deposit(alice, FLOOR, BRL)).to.be.revertedWithCustomError(
        integrator,
        "SeatCurrencyMismatch"
      );
      await expect(deposit(alice, FLOOR)).to.not.be.reverted;
    });
  });

  async function today() {
    const b = await ethers.provider.getBlock("latest");
    return BigInt(Math.floor(b!.timestamp / 86400));
  }

  describe("completion: onOrderComplete and reconcileDelivery", function () {
    it("the hook credits the person's pending stake and nothing more", async function () {
      await deposit(alice, FLOOR);
      await usdc.mint(dAddr, FLOOR);
      await expect(diamond.simulateOrderComplete(1))
        .to.emit(integrator, "DepositDelivered")
        .withArgs(1, alice.address, FLOOR);
      expect(await integrator.pendingStake(alice.address)).to.equal(FLOOR);
      expect(await integrator.credited(1)).to.equal(true);
      expect((await diamond.getMerchantDetails(alice.address)).isRegistered).to.equal(false);
      await holds([alice]);
    });

    it("a replayed hook credits nothing twice", async function () {
      await deposit(alice, FLOOR);
      await settle(1);
      await diamond.adminCallOnOrderComplete(iAddr, 1, alice.address, FLOOR, iAddr);
      expect(await integrator.pendingStake(alice.address)).to.equal(FLOOR);
    });

    it("the hook ignores a completion not paid to us", async function () {
      await diamond.adminCallOnOrderComplete(iAddr, 9, alice.address, FLOOR, stranger.address);
      expect(await integrator.pendingStake(alice.address)).to.equal(0n);
      expect(await integrator.credited(9)).to.equal(false);
    });

    it("reconcileDelivery credits a completion whose hook never ran", async function () {
      await deposit(alice, FLOOR);
      await expect(integrator.reconcileDelivery(1)).to.be.revertedWithCustomError(
        integrator,
        "DepositNotDelivered"
      );
      await usdc.mint(dAddr, FLOOR);
      await diamond.simulateOrderCompleteNoCallback(1);
      await expect(integrator.connect(stranger).reconcileDelivery(1))
        .to.emit(integrator, "DepositDelivered")
        .withArgs(1, alice.address, FLOOR);
      await expect(integrator.reconcileDelivery(1)).to.be.revertedWithCustomError(
        integrator,
        "OrderAlreadyFulfilled"
      );
      await holds([alice]);
    });

    it("reconcileDelivery refuses another integrator's order", async function () {
      const other = await deployIntegrator(ethers.ZeroAddress);
      await other.setCircle(INR, CIRCLE);
      await other.connect(alice).depositFiat(FLOOR, INR, ORDER_CIRCLE, "pk", 0, 0, REF);
      await expect(integrator.reconcileDelivery(1)).to.be.revertedWithCustomError(
        integrator,
        "NotOurs"
      );
    });

    it("reconcileDelivery refuses our order paid to someone else", async function () {
      await deposit(alice, FLOOR);
      await diamond.setOrderRecipient(1, stranger.address);
      await expect(integrator.reconcileDelivery(1)).to.be.revertedWithCustomError(
        integrator,
        "NotOurs"
      );
    });

    it("a cancellation needs nothing undone and never reverts", async function () {
      await deposit(alice, FLOOR);
      await expect(diamond.simulateOrderCancelled(1)).to.not.emit(
        diamond,
        "MockIntegratorCallbackFailed"
      );
      await holds([alice]);
    });
  });

  describe("stakeDeposit", function () {
    it("refuses an order not delivered here", async function () {
      await deposit(alice, FLOOR);
      await expect(integrator.stakeDeposit(1)).to.be.revertedWithCustomError(
        integrator,
        "DepositNotDelivered"
      );
    });

    it("opens the account with what was paid, in circleOf, and sets the bonus aside", async function () {
      await deposit(alice, FLOOR);
      await settle(1);
      await expect(integrator.connect(stranger).stakeDeposit(1))
        .to.emit(diamond, "MockRegisteredFor")
        .withArgs(alice.address, CIRCLE, FLOOR, INR)
        .and.to.emit(integrator, "BonusSetAside")
        .withArgs(alice.address, BONUS, VEST)
        .and.to.emit(integrator, "DepositStaked")
        .withArgs(1, alice.address, FLOOR, true);
      const m = await diamond.getMerchantDetails(alice.address);
      expect(m.stake).to.equal(FLOOR);
      expect(await diamond.merchantCircle(alice.address)).to.equal(CIRCLE);
      expect(await integrator.pendingStake(alice.address)).to.equal(0n);
      expect(await integrator.openedHere(alice.address)).to.equal(true);
      const v = await integrator.vesting(alice.address);
      expect([v.amount, v.volume]).to.deep.equal([BONUS, VEST]);
      expect(await integrator.bonusPool(INR)).to.equal(POOL - BONUS);
      expect(await usdc.allowance(iAddr, dAddr)).to.equal(0n);
      await holds([alice]);
    });

    it("a pool short of the bonus opens the account with none", async function () {
      await integrator.withdrawBonus(INR, POOL - BONUS + 1n);
      await open(alice);
      expect((await integrator.vesting(alice.address)).amount).to.equal(0n);
      expect(await diamond.getMerchantDetails(alice.address).then((m: any) => m.isRegistered)).to.be
        .true;
      await holds([alice]);
    });

    it("no bonus set: nothing is set aside", async function () {
      await integrator.setBonus(INR, 0, 0);
      await open(alice);
      expect((await integrator.vesting(alice.address)).amount).to.equal(0n);
      expect(await integrator.bonusPool(INR)).to.equal(POOL);
    });

    it("cannot stake the same money twice", async function () {
      await open(alice);
      await expect(integrator.stakeDeposit(1)).to.be.revertedWithCustomError(
        integrator,
        "DepositAlreadyStaked"
      );
    });

    it("tops up an existing account with stakeFor, in its currency, no second bonus", async function () {
      await open(alice);
      await deposit(alice, USDC(10));
      await settle(2);
      await expect(integrator.stakeDeposit(2))
        .to.emit(diamond, "MockStakedFor")
        .withArgs(alice.address, USDC(10), INR)
        .and.to.emit(integrator, "DepositStaked")
        .withArgs(2, alice.address, USDC(10), false)
        .and.to.not.emit(integrator, "BonusSetAside");
      expect((await diamond.getMerchantDetails(alice.address)).stake).to.equal(FLOOR + USDC(10));
      await holds([alice]);
    });

    it("an account opened elsewhere meanwhile: a top-up, no bonus, not openedHere", async function () {
      await deposit(alice, FLOOR);
      await settle(1);
      await diamond.setMerchant(alice.address, FLOOR, INR);
      await expect(integrator.stakeDeposit(1))
        .to.emit(integrator, "DepositStaked")
        .withArgs(1, alice.address, FLOOR, false);
      expect(await integrator.openedHere(alice.address)).to.equal(false);
      expect(await integrator.bonusPool(INR)).to.equal(POOL);
      await holds([alice]);
    });

    it("waits, nothing lost, if the circle was unset after the deposit", async function () {
      await deposit(alice, FLOOR);
      await settle(1);
      await integrator.setCircle(INR, 0);
      await expect(integrator.stakeDeposit(1)).to.be.revertedWithCustomError(
        integrator,
        "CircleNotSet"
      );
      expect(await integrator.pendingStake(alice.address)).to.equal(FLOOR);
      await integrator.setCircle(INR, CIRCLE);
      await expect(integrator.stakeDeposit(1)).to.emit(integrator, "DepositStaked");
    });

    it("a blacklisting after delivery blocks the stake and keeps the money pending", async function () {
      await open(alice);
      await deposit(alice, USDC(10));
      await settle(2);
      await diamond.setMerchantBlacklisted(alice.address, true);
      await expect(integrator.stakeDeposit(2)).to.be.revertedWithCustomError(
        diamond,
        "MerchantBlacklisted"
      );
      expect(await integrator.pendingStake(alice.address)).to.equal(USDC(10));
      await holds([alice]);
    });

    it("stakes only that person's money", async function () {
      await deposit(alice, FLOOR);
      await deposit(bob, USDC(200));
      await settle(1);
      await settle(2);
      await integrator.stakeDeposit(1);
      expect(await integrator.pendingStake(bob.address)).to.equal(USDC(200));
      expect((await diamond.getMerchantDetails(alice.address)).stake).to.equal(FLOOR);
      await holds([alice, bob]);
    });
  });

  describe("vestBonus", function () {
    it("refuses with nothing set aside, or before the vest volume", async function () {
      await expect(integrator.vestBonus(alice.address)).to.be.revertedWithCustomError(
        integrator,
        "NoVestingBonus"
      );
      await open(alice);
      await diamond.setVolume(alice.address, VEST - 1n);
      await expect(integrator.vestBonus(alice.address)).to.be.revertedWithCustomError(
        integrator,
        "NotVested"
      );
    });

    it("anyone stakes it into the account once the volume is reached, once", async function () {
      await open(alice);
      await diamond.setVolume(alice.address, VEST);
      await expect(integrator.connect(stranger).vestBonus(alice.address))
        .to.emit(diamond, "MockStakedFor")
        .withArgs(alice.address, BONUS, INR)
        .and.to.emit(integrator, "BonusVested")
        .withArgs(alice.address, BONUS);
      expect((await diamond.getMerchantDetails(alice.address)).stake).to.equal(FLOOR + BONUS);
      expect(await usdc.allowance(iAddr, dAddr)).to.equal(0n);
      await expect(integrator.vestBonus(alice.address)).to.be.revertedWithCustomError(
        integrator,
        "NoVestingBonus"
      );
      await holds([alice]);
    });

    it("keeps the terms it was set aside with", async function () {
      await open(alice);
      await integrator.setBonus(INR, USDC(9), USDC(1));
      await diamond.setVolume(alice.address, USDC(1));
      await expect(integrator.vestBonus(alice.address)).to.be.revertedWithCustomError(
        integrator,
        "NotVested"
      );
    });

    it("a refused stake reverts and leaves the bonus set aside", async function () {
      await open(alice);
      await diamond.setVolume(alice.address, VEST);
      await diamond.setUnstakeRequested(alice.address, true);
      await expect(integrator.vestBonus(alice.address)).to.be.revertedWithCustomError(
        diamond,
        "UnstakeRequestPending"
      );
      expect((await integrator.vesting(alice.address)).amount).to.equal(BONUS);
    });
  });

  describe("forfeitBonus", function () {
    it("refuses with nothing set aside, or an account in good standing", async function () {
      await expect(integrator.forfeitBonus(alice.address)).to.be.revertedWithCustomError(
        integrator,
        "NoVestingBonus"
      );
      await open(alice);
      await expect(integrator.forfeitBonus(alice.address)).to.be.revertedWithCustomError(
        integrator,
        "NotForfeitable"
      );
    });

    it("anyone returns it to the pool once the account asks to unstake", async function () {
      await open(alice);
      await diamond.setUnstakeRequested(alice.address, true);
      await expect(integrator.connect(stranger).forfeitBonus(alice.address))
        .to.emit(integrator, "BonusForfeited")
        .withArgs(alice.address, BONUS);
      expect(await integrator.bonusPool(INR)).to.equal(POOL);
      expect((await integrator.vesting(alice.address)).amount).to.equal(0n);
      await holds([alice]);
    });

    it("or once the account is blacklisted", async function () {
      await open(alice);
      await diamond.setMerchantBlacklisted(alice.address, true);
      await expect(integrator.forfeitBonus(alice.address)).to.emit(integrator, "BonusForfeited");
      expect(await integrator.bonusPool(INR)).to.equal(POOL);
    });
  });

  describe("withdrawFiat", function () {
    it("refuses a zero amount, or an account not opened here", async function () {
      await expect(withdraw(alice, 0n)).to.be.revertedWithCustomError(integrator, "InvalidAmount");
      await expect(withdraw(alice, USDC(10))).to.be.revertedWithCustomError(integrator, "NoSeat");
      // a merchant opened elsewhere (merchant-app, another integrator)
      await diamond.setMerchant(alice.address, FLOOR, INR);
      await expect(withdraw(alice, USDC(10))).to.be.revertedWithCustomError(integrator, "NoSeat");
    });

    it("places a SELL with user = the person, and holds nothing", async function () {
      await open(alice);
      const held = await usdc.balanceOf(iAddr);
      await expect(withdraw(alice, USDC(10)))
        .to.emit(integrator, "WithdrawalPlaced")
        .withArgs(2, alice.address, USDC(10), INR, REF)
        .and.to.emit(diamond, "MockSellOrderPlaced")
        .withArgs(2, alice.address, USDC(10), INR);
      expect(await usdc.balanceOf(iAddr)).to.equal(held);
    });

    it("refuses an account on the merchant blacklist", async function () {
      await open(alice);
      await diamond.setMerchantBlacklisted(alice.address, true);
      await expect(withdraw(alice, USDC(10))).to.be.revertedWithCustomError(
        integrator,
        "MerchantBlacklisted"
      );
    });

    it("refuses more than the Diamond's max sell; a max of 0 closes the currency", async function () {
      await open(alice);
      await expect(withdraw(alice, MAX_SELL + 1n)).to.be.revertedWithCustomError(
        integrator,
        "AmountExceedsCap"
      );
      await expect(withdraw(alice, MAX_SELL)).to.not.be.reverted;
      await diamond.setMaxSell(INR, 0);
      await expect(withdraw(alice, USDC(1))).to.be.revertedWithCustomError(
        integrator,
        "AmountExceedsCap"
      );
    });

    it("refuses a sixth withdrawal in one UTC day, counted apart from deposits", async function () {
      await open(alice); // one deposit today
      for (let i = 0; i < 5; i++) await withdraw(alice, USDC(1));
      await expect(withdraw(alice, USDC(1))).to.be.revertedWithCustomError(
        integrator,
        "DailyLimitReached"
      );
      expect(await integrator.depositsOn(alice.address, await today())).to.equal(1n);
      await nextDay();
      await expect(withdraw(alice, USDC(1))).to.not.be.reverted;
    });
  });
});
