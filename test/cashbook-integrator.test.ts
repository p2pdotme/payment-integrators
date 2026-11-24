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
 * person's own USDC, for any merchant account.
 *
 * The properties that carry the design:
 *   - USDC delivered here only ever leaves as that person's stake. No function
 *     sends it to a person (checked by the balance identity in `holds()`).
 *   - stakeDeposit is permissionless but cannot be steered: the account, the
 *     amount, the currency and the circle all come from stored state.
 *   - every deposit must leave the account at the Diamond's stake floor, so no
 *     money waits on a stake the Diamond would refuse.
 *   - the owner moves only the free balance (any token, and USDC above
 *     totalPending): withdraw, or rewardStake in an all-or-nothing batch into
 *     any registered merchant account. Rewards are funded by a plain transfer.
 *     Who opened here (DepositStaked opened = true) and what each was paid
 *     (Rewarded) are read from events; the contract keeps neither.
 *   - B2B orders skip the Diamond's per-person limits, so the per-tx cap and
 *     daily count on deposits here are the only ones.
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
  let uAddr: string;
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
  const REWARD = USDC(10);

  async function deployIntegrator(rmAddr: string) {
    const f = await ethers.getContractFactory("CashbookRampIntegrator");
    const i = await f.deploy(dAddr, await usdc.getAddress(), owner.address, rmAddr);
    await diamond.registerIntegrator(await i.getAddress(), await i.proxyImpl());
    return i;
  }

  beforeEach(async function () {
    [owner, alice, bob, stranger, carol] = await ethers.getSigners();
    usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    uAddr = await usdc.getAddress();
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
    // rewards are funded by a plain transfer; nothing records it
    await usdc.mint(owner.address, POOL);
    await usdc.transfer(iAddr, POOL);
  });

  /** The person's consent for the account a deposit would open (#518): an
   *  EIP-712 signature over registrationDigest(person, circleOf[cur], cur, ""). */
  async function consent(who: SignerWithAddress, cur = INR, circle?: bigint) {
    return who.signTypedData(
      {
        name: "P2PMerchantRegistration",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await diamond.getAddress(),
      },
      {
        RegisterFor: [
          { name: "merchant", type: "address" },
          { name: "circleId", type: "uint256" },
          { name: "currency", type: "bytes32" },
          { name: "telegramId", type: "string" },
        ],
      },
      {
        merchant: who.address,
        circleId: circle ?? (await integrator.circleOf(cur)),
        currency: cur,
        telegramId: "",
      }
    );
  }

  const deposit = async (who: SignerWithAddress, amount: bigint, cur = INR) =>
    integrator
      .connect(who)
      .depositFiat(amount, cur, ORDER_CIRCLE, "pk", 0, 0, REF, await consent(who, cur));

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

  /** Every USDC this contract holds is someone's pending stake or free.
   *  `users` must list everyone with money pending: totalPending is checked
   *  against their sum, and the balance must cover it. */
  async function holds(users: SignerWithAddress[]) {
    let pending = 0n;
    for (const u of users) pending += await integrator.pendingStake(u.address);
    expect(await integrator.totalPending()).to.equal(pending);
    const bal = await usdc.balanceOf(iAddr);
    expect(bal >= pending).to.equal(true);
    expect(bal).to.equal(pending + (await integrator.available(uAddr)));
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
    it("only the owner sets circles, pays rewards, or withdraws", async function () {
      const c = integrator.connect(stranger);
      await expect(c.rewardStake([alice.address], [1])).to.be.revertedWithCustomError(
        integrator,
        "OwnableUnauthorizedAccount"
      );
      await expect(c.setCircle(INR, 2)).to.be.revertedWithCustomError(
        integrator,
        "OwnableUnauthorizedAccount"
      );
      await expect(c.withdraw(uAddr, stranger.address, 1)).to.be.revertedWithCustomError(
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

    it("a plain USDC transfer funds rewards: it is free, not anyone's pending", async function () {
      await usdc.mint(stranger.address, USDC(10));
      await usdc.connect(stranger).transfer(iAddr, USDC(10));
      expect(await integrator.available(uAddr)).to.equal(POOL + USDC(10));
      expect(await integrator.totalPending()).to.equal(0n);
      await holds([]);
    });

    it("withdraw refuses a zero amount and a zero recipient", async function () {
      await expect(integrator.withdraw(uAddr, owner.address, 0)).to.be.revertedWithCustomError(
        integrator,
        "InvalidAmount"
      );
      await expect(
        integrator.withdraw(uAddr, ethers.ZeroAddress, USDC(1))
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    });

    it("withdraw takes all of any other token", async function () {
      const other = await (await ethers.getContractFactory("MockUSDC")).deploy();
      const oAddr = await other.getAddress();
      await other.mint(iAddr, USDC(7));
      // people's pending USDC does not hold back another token
      await deposit(alice, FLOOR);
      await settle(1);
      expect(await integrator.available(oAddr)).to.equal(USDC(7));
      await expect(integrator.withdraw(oAddr, bob.address, USDC(7)))
        .to.emit(integrator, "Withdrawn")
        .withArgs(oAddr, bob.address, USDC(7));
      expect(await other.balanceOf(bob.address)).to.equal(USDC(7));
      expect(await integrator.available(oAddr)).to.equal(0n);
      await expect(integrator.withdraw(oAddr, bob.address, 1)).to.be.revertedWithCustomError(
        integrator,
        "InsufficientFree"
      );
      await holds([alice]);
    });

    it("withdraw takes only the free USDC, never pending stake", async function () {
      // delivered, not staked: the balance covers POOL + 1, the free part does not
      await deposit(alice, FLOOR);
      await settle(1);
      expect(await usdc.balanceOf(iAddr)).to.equal(POOL + FLOOR);
      expect(await integrator.available(uAddr)).to.equal(POOL);
      await expect(
        integrator.withdraw(uAddr, owner.address, POOL + 1n)
      ).to.be.revertedWithCustomError(integrator, "InsufficientFree");
      await expect(integrator.withdraw(uAddr, owner.address, POOL))
        .to.emit(integrator, "Withdrawn")
        .withArgs(uAddr, owner.address, POOL);
      expect(await usdc.balanceOf(owner.address)).to.equal(POOL);
      expect(await integrator.available(uAddr)).to.equal(0n);
      expect(await integrator.pendingStake(alice.address)).to.equal(FLOOR);
      await expect(integrator.withdraw(uAddr, owner.address, 1)).to.be.revertedWithCustomError(
        integrator,
        "InsufficientFree"
      );
      await holds([alice]);
    });

    it("available floors at 0 when pending exceeds the USDC balance", async function () {
      await integrator.withdraw(uAddr, owner.address, POOL);
      // a credit with no USDC behind it (no honest path does this)
      await diamond.adminCallOnOrderComplete(iAddr, 9, alice.address, FLOOR, iAddr);
      expect(await integrator.totalPending()).to.equal(FLOOR);
      expect(await usdc.balanceOf(iAddr)).to.equal(0n);
      expect(await integrator.available(uAddr)).to.equal(0n);
    });
  });

  describe("depositFiat: refused before any money moves", function () {
    const raw = (who: SignerWithAddress, sig: string, cur = INR) =>
      integrator.connect(who).depositFiat(FLOOR, cur, ORDER_CIRCLE, "pk", 0, 0, REF, sig);

    /* #518: the Diamond opens an account only with the person's signature, so
       an opening deposit without a good one would strand its delivery here. */
    it("an opening deposit without the person's consent for that account", async function () {
      await integrator.setCircle(BRL, 2);
      const wrong = [
        "0x",
        "0x", // replaced below: alice's terms, signed by bob
        await consent(alice, INR, 9n), // another circle
        await consent(alice, BRL), // another currency
      ];
      // bob's signature names bob, so it can never be alice's consent
      wrong[1] = await bob.signTypedData(
        {
          name: "P2PMerchantRegistration",
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await diamond.getAddress(),
        },
        {
          RegisterFor: [
            { name: "merchant", type: "address" },
            { name: "circleId", type: "uint256" },
            { name: "currency", type: "bytes32" },
            { name: "telegramId", type: "string" },
          ],
        },
        { merchant: alice.address, circleId: CIRCLE, currency: INR, telegramId: "" }
      );
      for (const sig of wrong) {
        await expect(raw(alice, sig)).to.be.revertedWithCustomError(integrator, "ConsentInvalid");
      }
      expect(await integrator.depositsOn(alice.address, await today())).to.equal(0n);
      expect(await diamond.nextOrderId()).to.equal(1n);
      await expect(raw(alice, await consent(alice))).to.not.be.reverted;
      expect(await integrator.consentCircleOf(alice.address)).to.equal(CIRCLE);
    });

    it("an existing account needs no consent", async function () {
      await open(alice);
      await expect(
        integrator.connect(alice).depositFiat(USDC(10), INR, ORDER_CIRCLE, "pk", 0, 0, REF, "0x")
      ).to.not.be.reverted;
      expect(await integrator.consentOf(alice.address)).to.equal("0x");
    });

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
      await expect(
        i
          .connect(alice)
          .depositFiat(FLOOR, INR, ORDER_CIRCLE, "pk", 0, 0, REF, await consent(alice, INR, CIRCLE))
      ).to.not.be.reverted;
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

    it("exactly the max buy is allowed", async function () {
      await diamond.setMerchant(alice.address, FLOOR, INR);
      await expect(deposit(alice, MAX_BUY)).to.not.be.reverted;
    });

    it("a refused deposit does not use up the day's count", async function () {
      await diamond.setMerchant(alice.address, FLOOR, INR);
      for (let i = 0; i < 6; i++) {
        await expect(deposit(alice, MAX_BUY + 1n)).to.be.revertedWithCustomError(
          integrator,
          "AmountExceedsCap"
        );
      }
      expect(await integrator.depositsOn(alice.address, await today())).to.equal(0n);
      for (let i = 0; i < 5; i++) await deposit(alice, USDC(1));
    });

    it("the day turns at the Diamond's day key, to the second", async function () {
      await diamond.setMerchant(alice.address, FLOOR, INR);
      const b = await ethers.provider.getBlock("latest");
      const midnight = (Math.floor(b!.timestamp / 86400) + 2) * 86400;
      for (let i = 6; i >= 2; i--) {
        await ethers.provider.send("evm_setNextBlockTimestamp", [midnight - i]);
        await deposit(alice, USDC(1));
      }
      await ethers.provider.send("evm_setNextBlockTimestamp", [midnight - 1]);
      await expect(deposit(alice, USDC(1))).to.be.revertedWithCustomError(
        integrator,
        "DailyLimitReached"
      );
      await ethers.provider.send("evm_setNextBlockTimestamp", [midnight]);
      await expect(deposit(alice, USDC(1))).to.not.be.reverted;
      expect(await integrator.depositsOn(alice.address, BigInt(midnight / 86400))).to.equal(1n);
    });

    it("an opening in a currency with no circle set", async function () {
      await expect(deposit(alice, FLOOR, BRL)).to.be.revertedWithCustomError(
        integrator,
        "CircleNotSet"
      );
      // the revert leaves the person unbound
      expect(await integrator.currencyOf(alice.address)).to.equal(ethers.ZeroHash);
    });

    it("an opening short of the floor: free USDC here never counts toward it", async function () {
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

    it("with no account, the latest deposit picks the currency; pending money counts to its floor", async function () {
      await integrator.setCircle(BRL, 2);
      await diamond.setFloor(BRL, USDC(250));
      await deposit(alice, FLOOR);
      await settle(1);
      // pending FLOOR + 100 is under the BRL floor, so nothing changes
      await expect(deposit(alice, USDC(100), BRL)).to.be.revertedWithCustomError(
        integrator,
        "BelowStakeFloor"
      );
      expect(await integrator.currencyOf(alice.address)).to.equal(INR);
      await expect(deposit(alice, USDC(150), BRL)).to.not.be.reverted;
      expect(await integrator.currencyOf(alice.address)).to.equal(BRL);
    });

    it("a cancelled first deposit does not lock the currency", async function () {
      await integrator.setCircle(BRL, 2);
      await deposit(alice, FLOOR);
      await diamond.connect(alice).cancelOrder(1);
      await expect(deposit(alice, FLOOR, BRL)).to.not.be.reverted;
      expect(await integrator.currencyOf(alice.address)).to.equal(BRL);
    });

    it("a late delivery in the old currency waits for the new floor; a deposit lands it", async function () {
      await integrator.setCircle(BRL, 2);
      await diamond.setFloor(BRL, USDC(250));
      await deposit(alice, FLOOR); // 1: INR, still in flight
      await deposit(alice, USDC(250), BRL); // 2: nothing pending, so it rebinds
      await diamond.connect(alice).cancelOrder(2);
      await settle(1); // the INR deposit lands, bound to BRL now
      expect(await integrator.currencyOf(alice.address)).to.equal(BRL);
      await expect(integrator.stakeDeposit(1)).to.be.revertedWithCustomError(
        diamond,
        "StakeAmountTooLow"
      );
      expect(await integrator.pendingStake(alice.address)).to.equal(FLOOR);
      await holds([alice]);
      // still theirs: a further deposit reaching the BRL floor stakes it all
      await deposit(alice, USDC(150), BRL); // 3
      await settle(3);
      await expect(integrator.stakeDeposit(1))
        .to.emit(integrator, "DepositStaked")
        .withArgs(1, alice.address, USDC(250), true);
      const m = await diamond.getMerchantDetails(alice.address);
      expect(m.currency).to.equal(BRL);
      expect(m.stake).to.equal(USDC(250));
      await holds([alice]);
    });

    it("a late delivery in the old currency lands with one more deposit in that currency", async function () {
      await integrator.setCircle(BRL, 2);
      await diamond.setFloor(BRL, USDC(250));
      await deposit(alice, FLOOR); // 1: INR, still in flight
      await deposit(alice, USDC(250), BRL); // 2: picks BRL
      await diamond.connect(alice).cancelOrder(2);
      await settle(1); // the INR deposit lands while BRL is picked
      await expect(integrator.stakeDeposit(1)).to.be.revertedWithCustomError(
        diamond,
        "StakeAmountTooLow"
      );
      // a small INR deposit picks INR again; pending already meets the INR floor
      await deposit(alice, USDC(10)); // 3, never paid
      expect(await integrator.currencyOf(alice.address)).to.equal(INR);
      await expect(integrator.stakeDeposit(1))
        .to.emit(integrator, "DepositStaked")
        .withArgs(1, alice.address, FLOOR, true);
      const m = await diamond.getMerchantDetails(alice.address);
      expect(m.currency).to.equal(INR);
      expect(m.stake).to.equal(FLOOR);
      await holds([alice]);
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
      await other
        .connect(alice)
        .depositFiat(FLOOR, INR, ORDER_CIRCLE, "pk", 0, 0, REF, await consent(alice, INR, CIRCLE));
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
      // opening takes nothing from the free balance
      expect(await integrator.available(uAddr)).to.equal(POOL);
      expect(await integrator.totalPending()).to.equal(0n);
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

    it("an account opened elsewhere meanwhile: a top-up, opened = false", async function () {
      await deposit(alice, FLOOR);
      await settle(1);
      await diamond.setMerchant(alice.address, FLOOR, INR);
      await expect(integrator.stakeDeposit(1))
        .to.emit(integrator, "DepositStaked")
        .withArgs(1, alice.address, FLOOR, false);
      await holds([alice]);
    });

    it("a circle changed after the deposit cannot void it: it opens where they signed", async function () {
      await deposit(alice, FLOOR);
      await settle(1);
      await integrator.setCircle(INR, 0);
      await expect(integrator.stakeDeposit(1))
        .to.emit(diamond, "MockRegisteredFor")
        .withArgs(alice.address, CIRCLE, FLOOR, INR);
      // the consent is spent and cleared once the account opens
      expect(await integrator.consentOf(alice.address)).to.equal("0x");
      expect(await integrator.consentCircleOf(alice.address)).to.equal(0n);
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

    it("totalPending counts every delivery and falls to 0 once all are staked", async function () {
      await deposit(alice, FLOOR);
      await deposit(bob, USDC(200));
      await settle(1);
      expect(await integrator.totalPending()).to.equal(FLOOR);
      await usdc.mint(dAddr, USDC(200));
      await diamond.simulateOrderCompleteNoCallback(2);
      await integrator.reconcileDelivery(2);
      expect(await integrator.totalPending()).to.equal(FLOOR + USDC(200));
      await integrator.stakeDeposit(1);
      expect(await integrator.totalPending()).to.equal(USDC(200));
      await integrator.stakeDeposit(2);
      expect(await integrator.totalPending()).to.equal(0n);
      expect(await integrator.available(uAddr)).to.equal(POOL);
      await holds([alice, bob]);
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
        await integrator.available(uAddr),
        await integrator.totalPending(),
        await usdc.allowance(iAddr, dAddr),
        await usdc.balanceOf(iAddr),
        await usdc.balanceOf(dAddr),
      ];
      for (const u of who) out.push((await diamond.getMerchantDetails(u.address)).stake);
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

    it("refuses someone with no merchant account", async function () {
      // no account at all
      await expect(reward([bob], [USDC(1)])).to.be.revertedWithCustomError(integrator, "NoSeat");
      // delivered here but not yet staked: still no account
      await deposit(alice, FLOOR);
      await settle(1);
      await expect(reward([alice], [USDC(1)])).to.be.revertedWithCustomError(integrator, "NoSeat");
      // one unregistered account fails the whole batch
      await open(carol);
      await expect(reward([carol, bob], [USDC(1), USDC(1)])).to.be.revertedWithCustomError(
        integrator,
        "NoSeat"
      );
      expect((await diamond.getMerchantDetails(carol.address)).stake).to.equal(FLOOR);
      await holds([alice, bob, carol]);
    });

    it("rewards an account opened elsewhere, in its own currency", async function () {
      // merchant-app or another integrator opened it; cashbook never staked it
      await diamond.setMerchant(bob.address, FLOOR, BRL);
      await expect(reward([bob], [USDC(2)]))
        .to.emit(diamond, "MockStakedFor")
        .withArgs(bob.address, USDC(2), BRL)
        .and.to.emit(integrator, "Rewarded")
        .withArgs(bob.address, USDC(2));
      expect((await diamond.getMerchantDetails(bob.address)).stake).to.equal(FLOOR + USDC(2));
      expect(await integrator.available(uAddr)).to.equal(POOL - USDC(2));
      expect(await usdc.allowance(iAddr, dAddr)).to.equal(0n);
      await holds([bob]);
    });

    it("has no per-account cap; the same account twice counts twice", async function () {
      await open(alice);
      await expect(reward([alice, alice], [REWARD, REWARD])).to.not.be.reverted;
      expect((await diamond.getMerchantDetails(alice.address)).stake).to.equal(FLOOR + 2n * REWARD);
      expect(await integrator.available(uAddr)).to.equal(POOL - 2n * REWARD);
      await holds([alice, bob]);
    });

    it("refuses a batch whose sum is more than the free balance, even when pending would cover it", async function () {
      await open(alice);
      await open(bob);
      await integrator.withdraw(uAddr, owner.address, POOL - USDC(3));
      // carol's delivered, unstaked deposit sits on the contract beside the free USDC
      await deposit(carol, FLOOR);
      await settle(3);
      expect(await usdc.balanceOf(iAddr)).to.equal(USDC(3) + FLOOR);
      expect(await integrator.available(uAddr)).to.equal(USDC(3));
      // each item fits the free balance, the sum does not
      await expect(reward([alice, bob], [USDC(2), USDC(2)])).to.be.revertedWithCustomError(
        integrator,
        "InsufficientFree"
      );
      await expect(reward([alice, bob], [USDC(2), USDC(1)])).to.not.be.reverted;
      expect(await integrator.available(uAddr)).to.equal(0n);
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
      }
      expect(await usdc.balanceOf(dAddr)).to.equal(dBefore + total);
      expect(await integrator.available(uAddr)).to.equal(POOL - total);
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

    it("money delivered here but not yet staked is not an account: refused until staked", async function () {
      await deposit(alice, FLOOR);
      await settle(1);
      await expect(withdraw(alice, USDC(10))).to.be.revertedWithCustomError(integrator, "NoSeat");
      await integrator.stakeDeposit(1);
      await expect(withdraw(alice, USDC(10))).to.emit(integrator, "WithdrawalPlaced");
    });

    it("only for the caller's own account: a stranger cannot cash out someone else's", async function () {
      await open(alice);
      await expect(withdraw(stranger, USDC(10))).to.be.revertedWithCustomError(
        integrator,
        "NoSeat"
      );
      // the order is always the caller's: user = msg.sender
      await diamond.setMerchant(stranger.address, FLOOR, INR);
      await expect(withdraw(stranger, USDC(10)))
        .to.emit(diamond, "MockSellOrderPlaced")
        .withArgs(2, stranger.address, USDC(10), INR);
      expect(await integrator.withdrawalsOn(alice.address, await today())).to.equal(0n);
    });

    it("serves an account opened elsewhere (merchant-app, another integrator)", async function () {
      await diamond.setMerchant(alice.address, FLOOR, INR);
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

    it("a refused withdrawal does not use up the day's count", async function () {
      await open(alice);
      for (let i = 0; i < 6; i++) {
        await expect(withdraw(alice, MAX_SELL + 1n)).to.be.revertedWithCustomError(
          integrator,
          "AmountExceedsCap"
        );
      }
      expect(await integrator.withdrawalsOn(alice.address, await today())).to.equal(0n);
      for (let i = 0; i < 5; i++) await withdraw(alice, USDC(1));
    });

    it("only the merchant blacklist stops a cash out: a pending unstake does not", async function () {
      await open(alice);
      await diamond.setUnstakeRequested(alice.address, true);
      await expect(withdraw(alice, USDC(10))).to.not.be.reverted;
    });

    it("refuses a currency other than the account's, so the cap cannot be shopped", async function () {
      await open(alice);
      await diamond.setMaxSell(BRL, MAX_SELL * 10n);
      await expect(withdraw(alice, MAX_SELL + 1n, BRL)).to.be.revertedWithCustomError(
        integrator,
        "SeatCurrencyMismatch"
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
      expect(await integrator.withdrawalsOn(alice.address, await today())).to.equal(5n);
      // a fully unstaked account (still registered) can still cash out
      await diamond.setMerchant(bob.address, 0n, INR);
      await expect(withdraw(bob, USDC(1))).to.not.be.reverted;
      await nextDay();
      await expect(withdraw(alice, USDC(1))).to.not.be.reverted;
    });
  });

  describe("the person's proxy", function () {
    it("one per person, deployed once, used for both deposits and withdrawals", async function () {
      const proxy = await integrator.proxyAddress(alice.address);
      const tx = await deposit(alice, FLOOR);
      await expect(tx).to.emit(integrator, "UserProxyDeployed").withArgs(alice.address, proxy);
      await settle(1);
      await integrator.stakeDeposit(1);
      await expect(withdraw(alice, USDC(10))).to.not.emit(integrator, "UserProxyDeployed");
      await expect(deposit(alice, USDC(10))).to.not.emit(integrator, "UserProxyDeployed");
      expect(await integrator.proxyAddress(alice.address)).to.equal(proxy);
      expect(await integrator.proxyAddress(bob.address)).to.not.equal(proxy);
    });

    it("a first withdrawal deploys it for an account opened elsewhere", async function () {
      await diamond.setMerchant(bob.address, FLOOR, INR);
      await expect(withdraw(bob, USDC(10)))
        .to.emit(integrator, "UserProxyDeployed")
        .withArgs(bob.address, await integrator.proxyAddress(bob.address));
    });

    it("nobody but the integrator can drive it, the person included", async function () {
      await deposit(alice, FLOOR);
      const proxy = await ethers.getContractAt(
        "UserProxy",
        await integrator.proxyAddress(alice.address)
      );
      const call = diamond.interface.encodeFunctionData("cancelOrder", [1]);
      for (const who of [alice, stranger]) {
        await expect(
          proxy.connect(who).execute(dAddr, call, uAddr, 0)
        ).to.be.revertedWithCustomError(proxy, "OnlyIntegrator");
      }
    });
  });

  describe("reentrancy: a call back in mid-transaction is refused", function () {
    const inner = {
      depositFiat: () =>
        integrator.interface.encodeFunctionData("depositFiat", [
          FLOOR,
          INR,
          ORDER_CIRCLE,
          "pk",
          0,
          0,
          REF,
          "0x",
        ]),
      withdrawFiat: () =>
        integrator.interface.encodeFunctionData("withdrawFiat", [
          USDC(1),
          INR,
          ORDER_CIRCLE,
          "pk",
          0,
          0,
          REF,
        ]),
      reconcileDelivery: () => integrator.interface.encodeFunctionData("reconcileDelivery", [1]),
      stakeDeposit: () => integrator.interface.encodeFunctionData("stakeDeposit", [1]),
    };

    async function refused(outer: () => Promise<any>, call: string) {
      await diamond.setReenter(iAddr, call);
      await expect(outer()).to.be.revertedWithCustomError(
        integrator,
        "ReentrancyGuardReentrantCall"
      );
      await diamond.setReenter(ethers.ZeroAddress, "0x");
    }

    for (const name of Object.keys(inner) as (keyof typeof inner)[]) {
      it(`stakeDeposit, re-entered through ${name}: nothing staked, the money still pending`, async function () {
        await deposit(alice, FLOOR);
        await settle(1);
        await refused(() => integrator.stakeDeposit(1), inner[name]());
        expect(await integrator.pendingStake(alice.address)).to.equal(FLOOR);
        expect((await diamond.getMerchantDetails(alice.address)).isRegistered).to.equal(false);
        await holds([alice]);
        // the same call, not re-entered, still lands it
        await expect(integrator.stakeDeposit(1)).to.emit(integrator, "DepositStaked");
      });
    }

    it("depositFiat, re-entered: no order, no count", async function () {
      await diamond.setMerchant(alice.address, FLOOR, INR);
      await refused(() => deposit(alice, USDC(1)), inner.stakeDeposit());
      expect(await diamond.nextOrderId()).to.equal(1n);
      expect(await integrator.depositsOn(alice.address, await today())).to.equal(0n);
    });

    it("withdrawFiat, re-entered: no order, no count", async function () {
      await diamond.setMerchant(alice.address, FLOOR, INR);
      await refused(() => withdraw(alice, USDC(1)), inner.depositFiat());
      expect(await diamond.nextOrderId()).to.equal(1n);
      expect(await integrator.withdrawalsOn(alice.address, await today())).to.equal(0n);
    });

    it("reconcileDelivery, re-entered: nothing credited", async function () {
      await deposit(alice, FLOOR);
      await usdc.mint(dAddr, FLOOR);
      await diamond.simulateOrderCompleteNoCallback(1);
      await refused(() => integrator.reconcileDelivery(1), inner.withdrawFiat());
      expect(await integrator.credited(1)).to.equal(false);
      expect(await integrator.pendingStake(alice.address)).to.equal(0n);
    });

    it("rewardStake, re-entered: nothing paid, the allowance back to 0", async function () {
      await open(alice);
      await deposit(bob, FLOOR);
      await settle(2);
      await refused(() => integrator.rewardStake([alice.address], [USDC(1)]), inner.stakeDeposit());
      expect(await integrator.available(uAddr)).to.equal(POOL);
      expect(await usdc.allowance(iAddr, dAddr)).to.equal(0n);
      expect(await integrator.pendingStake(bob.address)).to.equal(FLOOR);
      await holds([alice, bob]);
    });
  });
});
