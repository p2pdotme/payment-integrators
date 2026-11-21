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
 *   - rewards come only from the reward pool, only in an owner batch, only
 *     into an account opened here, and at most MAX_REWARD_PER_ACCOUNT each.
 *     A batch is all or nothing.
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
  let carol: SignerWithAddress;

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
  const POOL = USDC(50);
  const MAX_REWARD = USDC(10);

  async function deployIntegrator(rmAddr: string) {
    const f = await ethers.getContractFactory("CashbookRampIntegrator");
    const i = await f.deploy(dAddr, await usdc.getAddress(), owner.address, rmAddr);
    await diamond.registerIntegrator(await i.getAddress(), await i.proxyImpl());
    return i;
  }

  beforeEach(async function () {
    [owner, alice, bob, stranger, carol] = await ethers.getSigners();
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
    await usdc.mint(owner.address, POOL);
    await usdc.approve(iAddr, POOL);
    await integrator.fundRewards(POOL);
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
  async function open(who: SignerWithAddress, cur = INR) {
    const id = Number(await diamond.nextOrderId());
    await deposit(who, FLOOR, cur);
    await settle(id);
    await integrator.stakeDeposit(id);
    return id;
  }

  async function nextDay() {
    await ethers.provider.send("evm_increaseTime", [86400]);
    await ethers.provider.send("evm_mine", []);
  }

  /** Every USDC this contract holds is someone's pending stake or the reward
   *  pool. Nothing else can be on it. */
  async function holds(users: SignerWithAddress[]) {
    let sum = await integrator.rewardPool();
    for (const u of users) sum += await integrator.pendingStake(u.address);
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
      expect(await integrator.MAX_REWARD_PER_ACCOUNT()).to.equal(MAX_REWARD);
    });
  });

  describe("access control", function () {
    it("only the owner sets circles, pays rewards, or withdraws the pool", async function () {
      const c = integrator.connect(stranger);
      await expect(c.rewardStake([alice.address], [1])).to.be.revertedWithCustomError(
        integrator,
        "OwnableUnauthorizedAccount"
      );
      await expect(c.setCircle(INR, 2)).to.be.revertedWithCustomError(
        integrator,
        "OwnableUnauthorizedAccount"
      );
      await expect(c.withdrawRewards(1)).to.be.revertedWithCustomError(
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
      await expect(integrator.setCircle(INR, 2)).to.be.revertedWithCustomError(
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
    it("setCircle stores and emits", async function () {
      await expect(integrator.setCircle(BRL, 2)).to.emit(integrator, "CircleSet").withArgs(BRL, 2);
      expect(await integrator.circleOf(BRL)).to.equal(2n);
    });

    it("withdrawRewards takes only the pool, never pending stake", async function () {
      await expect(integrator.withdrawRewards(0)).to.be.revertedWithCustomError(
        integrator,
        "InvalidAmount"
      );
      // delivered, not staked: the balance covers POOL + 1, the pool does not
      await deposit(alice, FLOOR);
      await settle(1);
      expect(await usdc.balanceOf(iAddr)).to.equal(POOL + FLOOR);
      await expect(integrator.withdrawRewards(POOL + 1n)).to.be.revertedWithCustomError(
        integrator,
        "RewardPoolShort"
      );
      await expect(integrator.withdrawRewards(POOL))
        .to.emit(integrator, "RewardsWithdrawn")
        .withArgs(owner.address, POOL);
      expect(await usdc.balanceOf(owner.address)).to.equal(POOL);
      expect(await integrator.rewardPool()).to.equal(0n);
      expect(await integrator.pendingStake(alice.address)).to.equal(FLOOR);
      await expect(integrator.withdrawRewards(1)).to.be.revertedWithCustomError(
        integrator,
        "RewardPoolShort"
      );
      await holds([alice]);
    });

    it("anyone may fund the pool; zero is refused", async function () {
      await expect(integrator.connect(stranger).fundRewards(0)).to.be.revertedWithCustomError(
        integrator,
        "InvalidAmount"
      );
      await usdc.mint(stranger.address, USDC(10));
      await usdc.connect(stranger).approve(iAddr, USDC(10));
      await expect(integrator.connect(stranger).fundRewards(USDC(10)))
        .to.emit(integrator, "RewardsFunded")
        .withArgs(stranger.address, USDC(10));
      expect(await integrator.rewardPool()).to.equal(POOL + USDC(10));
      await holds([]);
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

    it("an opening short of the floor: the reward pool never counts toward it", async function () {
      await expect(deposit(alice, FLOOR - 1n)).to.be.revertedWithCustomError(
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

    it("opens the account with what was paid, in circleOf, and nothing more", async function () {
      await deposit(alice, FLOOR);
      await settle(1);
      await expect(integrator.connect(stranger).stakeDeposit(1))
        .to.emit(diamond, "MockRegisteredFor")
        .withArgs(alice.address, CIRCLE, FLOOR, INR)
        .and.to.emit(integrator, "DepositStaked")
        .withArgs(1, alice.address, FLOOR, true);
      const m = await diamond.getMerchantDetails(alice.address);
      expect(m.stake).to.equal(FLOOR);
      expect(await diamond.merchantCircle(alice.address)).to.equal(CIRCLE);
      expect(await integrator.pendingStake(alice.address)).to.equal(0n);
      expect(await integrator.openedHere(alice.address)).to.equal(true);
      // opening takes nothing from the reward pool
      expect(await integrator.rewardPool()).to.equal(POOL);
      expect(await integrator.rewarded(alice.address)).to.equal(0n);
      expect(await usdc.allowance(iAddr, dAddr)).to.equal(0n);
      await holds([alice]);
    });

    it("cannot stake the same money twice", async function () {
      await open(alice);
      await expect(integrator.stakeDeposit(1)).to.be.revertedWithCustomError(
        integrator,
        "DepositAlreadyStaked"
      );
    });

    it("tops up an existing account with stakeFor, in its currency", async function () {
      await open(alice);
      await deposit(alice, USDC(10));
      await settle(2);
      await expect(integrator.stakeDeposit(2))
        .to.emit(diamond, "MockStakedFor")
        .withArgs(alice.address, USDC(10), INR)
        .and.to.emit(integrator, "DepositStaked")
        .withArgs(2, alice.address, USDC(10), false);
      expect((await diamond.getMerchantDetails(alice.address)).stake).to.equal(FLOOR + USDC(10));
      await holds([alice]);
    });

    it("an account opened elsewhere meanwhile: a top-up, not openedHere", async function () {
      await deposit(alice, FLOOR);
      await settle(1);
      await diamond.setMerchant(alice.address, FLOOR, INR);
      await expect(integrator.stakeDeposit(1))
        .to.emit(integrator, "DepositStaked")
        .withArgs(1, alice.address, FLOOR, false);
      expect(await integrator.openedHere(alice.address)).to.equal(false);
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

  describe("rewardStake", function () {
    /** Everything a refused batch must leave untouched. */
    async function snapshot(who: SignerWithAddress[]) {
      const out: bigint[] = [
        await integrator.rewardPool(),
        await usdc.allowance(iAddr, dAddr),
        await usdc.balanceOf(iAddr),
        await usdc.balanceOf(dAddr),
      ];
      for (const u of who) {
        out.push(await integrator.rewarded(u.address));
        out.push((await diamond.getMerchantDetails(u.address)).stake);
      }
      return out;
    }

    const reward = (who: SignerWithAddress[], amounts: bigint[]) =>
      integrator.rewardStake(
        who.map((u) => u.address),
        amounts
      );

    it("refuses anyone but the owner", async function () {
      await open(alice);
      for (const who of [stranger, alice]) {
        await expect(
          integrator.connect(who).rewardStake([alice.address], [USDC(1)])
        ).to.be.revertedWithCustomError(integrator, "OwnableUnauthorizedAccount");
      }
    });

    it("refuses an empty batch, or lists of different lengths", async function () {
      await open(alice);
      await expect(reward([], [])).to.be.revertedWithCustomError(integrator, "LengthMismatch");
      await expect(reward([alice], [])).to.be.revertedWithCustomError(integrator, "LengthMismatch");
      await expect(reward([alice], [USDC(1), USDC(1)])).to.be.revertedWithCustomError(
        integrator,
        "LengthMismatch"
      );
    });

    it("refuses a zero amount", async function () {
      await open(alice);
      await expect(reward([alice], [0n])).to.be.revertedWithCustomError(
        integrator,
        "InvalidAmount"
      );
    });

    it("refuses an account not opened here", async function () {
      // no account at all
      await expect(reward([bob], [USDC(1)])).to.be.revertedWithCustomError(integrator, "NoSeat");
      // an account opened elsewhere (merchant-app, another integrator)
      await diamond.setMerchant(bob.address, FLOOR, INR);
      await expect(reward([bob], [USDC(1)])).to.be.revertedWithCustomError(integrator, "NoSeat");
      // delivered here but not yet staked: still no account opened here
      await deposit(alice, FLOOR);
      await settle(1);
      await expect(reward([alice], [USDC(1)])).to.be.revertedWithCustomError(integrator, "NoSeat");
      await holds([alice, bob]);
    });

    it("caps each account's lifetime total at MAX_REWARD_PER_ACCOUNT", async function () {
      await open(alice);
      await expect(reward([alice], [MAX_REWARD + 1n])).to.be.revertedWithCustomError(
        integrator,
        "RewardCapReached"
      );
      await expect(reward([alice], [USDC(6)])).to.not.be.reverted;
      await expect(reward([alice], [USDC(5)])).to.be.revertedWithCustomError(
        integrator,
        "RewardCapReached"
      );
      await expect(reward([alice], [USDC(4)])).to.not.be.reverted;
      expect(await integrator.rewarded(alice.address)).to.equal(MAX_REWARD);
      await expect(reward([alice], [1n])).to.be.revertedWithCustomError(
        integrator,
        "RewardCapReached"
      );
      // another account's cap is its own
      await open(bob);
      await expect(reward([bob], [MAX_REWARD])).to.not.be.reverted;
      expect(await integrator.rewardPool()).to.equal(POOL - 2n * MAX_REWARD);
      await holds([alice, bob]);
    });

    it("the same account twice counts twice: crossing the cap reverts the whole batch", async function () {
      await open(alice);
      await open(bob);
      const before = await snapshot([alice, bob]);
      await expect(
        reward([bob, alice, alice], [USDC(2), USDC(6), USDC(5)])
      ).to.be.revertedWithCustomError(integrator, "RewardCapReached");
      expect(await snapshot([alice, bob])).to.deep.equal(before);
      // within the cap, the same account twice is fine
      await expect(reward([alice, alice], [USDC(6), USDC(4)])).to.not.be.reverted;
      expect(await integrator.rewarded(alice.address)).to.equal(MAX_REWARD);
      await holds([alice, bob]);
    });

    it("refuses a batch whose sum is more than the pool, even when pending stake would cover it", async function () {
      await open(alice);
      await open(bob);
      await integrator.withdrawRewards(POOL - USDC(3));
      // carol's delivered, unstaked deposit sits on the contract beside the pool
      await deposit(carol, FLOOR);
      await settle(3);
      expect(await usdc.balanceOf(iAddr)).to.equal(USDC(3) + FLOOR);
      // each item fits the pool, the sum does not
      await expect(reward([alice, bob], [USDC(2), USDC(2)])).to.be.revertedWithCustomError(
        integrator,
        "RewardPoolShort"
      );
      await expect(reward([alice, bob], [USDC(2), USDC(1)])).to.not.be.reverted;
      expect(await integrator.rewardPool()).to.equal(0n);
      expect(await integrator.pendingStake(carol.address)).to.equal(FLOOR);
      await holds([alice, bob, carol]);
    });

    it("a batch stakes each amount into its own account, in that account's currency", async function () {
      await integrator.setCircle(BRL, 2);
      await open(alice);
      await open(bob, BRL);
      await open(carol);
      // someone else's delivered, unstaked deposit must not move
      const dave = stranger;
      await deposit(dave, FLOOR);
      await settle(4);
      const dBefore = await usdc.balanceOf(dAddr);
      const people = [alice, bob, carol];
      const amounts = [USDC(6), USDC(3), USDC(1)];
      const total = USDC(10);
      await expect(reward(people, amounts))
        .to.emit(diamond, "MockStakedFor")
        .withArgs(alice.address, USDC(6), INR)
        .and.to.emit(diamond, "MockStakedFor")
        .withArgs(bob.address, USDC(3), BRL)
        .and.to.emit(diamond, "MockStakedFor")
        .withArgs(carol.address, USDC(1), INR)
        .and.to.emit(integrator, "Rewarded")
        .withArgs(alice.address, USDC(6))
        .and.to.emit(integrator, "Rewarded")
        .withArgs(bob.address, USDC(3))
        .and.to.emit(integrator, "Rewarded")
        .withArgs(carol.address, USDC(1));
      for (let i = 0; i < people.length; i++) {
        expect((await diamond.getMerchantDetails(people[i].address)).stake).to.equal(
          FLOOR + amounts[i]
        );
        expect(await integrator.rewarded(people[i].address)).to.equal(amounts[i]);
      }
      expect(await usdc.balanceOf(dAddr)).to.equal(dBefore + total);
      expect(await integrator.rewardPool()).to.equal(POOL - total);
      expect(await integrator.pendingStake(dave.address)).to.equal(FLOOR);
      expect(await usdc.allowance(iAddr, dAddr)).to.equal(0n);
      await holds([alice, bob, carol, dave]);
    });

    for (const [why, setup, error] of [
      [
        "a pending unstake",
        (a: string) => diamond.setUnstakeRequested(a, true),
        "UnstakeRequestPending",
      ],
      [
        "the merchant blacklist",
        (a: string) => diamond.setMerchantBlacklisted(a, true),
        "MerchantBlacklisted",
      ],
      [
        "an account slashed below the floor",
        (a: string) => diamond.setMerchant(a, USDC(40), INR),
        "StakeAmountTooLow",
      ],
    ] as const) {
      it(`a Diamond refusal mid-batch (${why}) reverts everything`, async function () {
        await open(alice);
        await open(bob);
        await open(carol);
        await setup(bob.address);
        const before = await snapshot([alice, bob, carol]);
        // alice is staked first, bob is refused, carol never runs
        await expect(
          reward([alice, bob, carol], [USDC(2), USDC(2), USDC(2)])
        ).to.be.revertedWithCustomError(diamond, error);
        expect(await snapshot([alice, bob, carol])).to.deep.equal(before);
        await holds([alice, bob, carol]);
      });
    }
  });

  describe("withdrawFiat", function () {
    it("refuses a zero amount, or someone with no merchant account", async function () {
      await expect(withdraw(alice, 0n)).to.be.revertedWithCustomError(integrator, "InvalidAmount");
      await expect(withdraw(alice, USDC(10))).to.be.revertedWithCustomError(integrator, "NoSeat");
    });

    it("serves an account opened elsewhere (merchant-app, another integrator)", async function () {
      await diamond.setMerchant(alice.address, FLOOR, INR);
      expect(await integrator.openedHere(alice.address)).to.equal(false);
      await expect(withdraw(alice, USDC(10)))
        .to.emit(integrator, "WithdrawalPlaced")
        .withArgs(1, alice.address, USDC(10), INR, REF);
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

    it("serves a user on ReputationManager's blacklist (it stops BUYs only)", async function () {
      await open(alice);
      await rm.setBlacklisted(alice.address, true);
      await expect(withdraw(alice, USDC(10))).to.not.be.reverted;
    });

    it("has no amount or count limit: above the Diamond's max sell, six in a day", async function () {
      await open(alice);
      await diamond.setMaxSell(INR, 0);
      await expect(withdraw(alice, MAX_SELL + 1n)).to.not.be.reverted;
      for (let i = 0; i < 5; i++) await withdraw(alice, USDC(1));
    });
  });
});
