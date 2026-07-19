import { expect } from "chai";
import { ethers } from "hardhat";
import {
  loadFixture,
  impersonateAccount,
  setBalance,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";

// USDC has 6 decimals.
const USDC = (n: number) => BigInt(Math.round(n * 1_000_000));
const MAX_PER_TX = USDC(200); // 200 USDC cap
const MAX_DAILY = 5; // orders per user per UTC day
const CURRENCY = ethers.encodeBytes32String("INR");

describe("FundingAlphaXIntegrator", () => {
  async function deploy() {
    const [owner, operator, user, nowpayments, attacker, multisig] = await ethers.getSigners();

    const usdc = await ethers.deployContract("MockUSDC");
    const diamond = await ethers.deployContract("MockDiamond", [usdc.target]);
    const integrator = await ethers.deployContract("FundingAlphaXIntegrator", [
      diamond.target,
      usdc.target,
      operator.address,
      MAX_PER_TX,
      MAX_DAILY,
    ]);

    // Register the integrator on the (mock) Diamond with its pinned proxyImpl,
    // exactly as the real whitelist/registerIntegrator step would.
    await diamond.registerIntegrator(integrator.target, await integrator.proxyImpl());

    return { owner, operator, user, nowpayments, attacker, multisig, usdc, diamond, integrator };
  }

  // Place an order as the operator and return its orderId (parsed from the event).
  async function place(
    integrator: any,
    operator: any,
    user: string,
    amount: bigint,
    recipient: string
  ) {
    const tx = await integrator
      .connect(operator)
      .placeChallengeOrder(user, amount, recipient, CURRENCY, 0, "pk");
    const rc = await tx.wait();
    for (const log of rc!.logs) {
      try {
        const parsed = integrator.interface.parseLog(log);
        if (parsed?.name === "ChallengeOrderPlaced") return parsed.args.orderId as bigint;
      } catch {
        /* not our event */
      }
    }
    throw new Error("ChallengeOrderPlaced not emitted");
  }

  // Returns a signer that IS the Diamond, so onlyDiamond functions can be unit-tested directly.
  async function asDiamond(diamond: any) {
    const addr = await diamond.getAddress();
    await impersonateAccount(addr);
    await setBalance(addr, ethers.parseEther("100"));
    return await ethers.getSigner(addr);
  }

  describe("happy path", () => {
    it("forwards the exact settled USDC to the NowPayments deposit address", async () => {
      const { operator, user, nowpayments, usdc, diamond, integrator } = await loadFixture(deploy);
      const amount = USDC(38); // $38 entry fee

      const orderId = await place(integrator, operator, user.address, amount, nowpayments.address);
      expect(orderId).to.equal(1n);

      // Simulate the buyer paying fiat -> protocol settles USDC to the proxy.
      await usdc.mint(diamond.target, amount);

      await expect(diamond.simulateOrderComplete(orderId))
        .to.emit(integrator, "ChallengePaymentForwarded")
        .withArgs(orderId, user.address, nowpayments.address, amount);

      // The NowPayments address received exactly the entry fee; nothing stuck on the integrator.
      expect(await usdc.balanceOf(nowpayments.address)).to.equal(amount);
      expect(await usdc.balanceOf(integrator.target)).to.equal(0n);

      const s = await integrator.getSession(orderId);
      expect(s.fulfilled).to.equal(true);
      expect(await integrator.getTodayCount(user.address)).to.equal(1n);
    });

    it("re-uses the same proxy across orders for one user", async () => {
      const { operator, user, nowpayments, integrator } = await loadFixture(deploy);
      const proxy = await integrator.proxyAddress(user.address);
      await place(integrator, operator, user.address, USDC(10), nowpayments.address);
      await place(integrator, operator, user.address, USDC(10), nowpayments.address);
      // Same deterministic proxy, deployed once then re-used (covers both _ensureProxy branches).
      expect(await integrator.proxyAddress(user.address)).to.equal(proxy);
      expect(await ethers.provider.getCode(proxy)).to.not.equal("0x");
    });
  });

  describe("access control", () => {
    it("only the operator can place orders", async () => {
      const { attacker, user, nowpayments, integrator } = await loadFixture(deploy);
      await expect(
        integrator
          .connect(attacker)
          .placeChallengeOrder(user.address, USDC(10), nowpayments.address, CURRENCY, 0, "pk")
      ).to.be.revertedWithCustomError(integrator, "OnlyOperator");
    });

    it("only the Diamond can call validateOrder / onOrderComplete / onOrderCancel", async () => {
      const { attacker, user, nowpayments, operator, integrator } = await loadFixture(deploy);
      const orderId = await place(
        integrator,
        operator,
        user.address,
        USDC(10),
        nowpayments.address
      );
      await expect(
        integrator.connect(attacker).validateOrder(user.address, USDC(10), CURRENCY)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
      await expect(
        integrator.connect(attacker).onOrderComplete(orderId, user.address, USDC(10), user.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
      await expect(
        integrator.connect(attacker).onOrderCancel(orderId)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
    });

    it("only the owner can set operator / caps / pause / rescue", async () => {
      const { attacker, integrator, usdc } = await loadFixture(deploy);
      await expect(
        integrator.connect(attacker).setOperator(attacker.address)
      ).to.be.revertedWithCustomError(integrator, "OwnableUnauthorizedAccount");
      await expect(
        integrator.connect(attacker).setMaxPerTxUsdc(USDC(1))
      ).to.be.revertedWithCustomError(integrator, "OwnableUnauthorizedAccount");
      await expect(
        integrator.connect(attacker).setMaxDailyCountPerUser(1)
      ).to.be.revertedWithCustomError(integrator, "OwnableUnauthorizedAccount");
      await expect(integrator.connect(attacker).pause()).to.be.revertedWithCustomError(
        integrator,
        "OwnableUnauthorizedAccount"
      );
      await expect(
        integrator.connect(attacker).rescueERC20(usdc.target, attacker.address, 1n)
      ).to.be.revertedWithCustomError(integrator, "OwnableUnauthorizedAccount");
    });
  });

  describe("defense-in-depth guards (onOrderComplete)", () => {
    it("reverts AmountMismatch when the callback amount != the placed amount", async () => {
      const { operator, user, nowpayments, diamond, integrator } = await loadFixture(deploy);
      const orderId = await place(
        integrator,
        operator,
        user.address,
        USDC(38),
        nowpayments.address
      );
      await expect(
        diamond.adminCallOnOrderComplete(
          integrator.target,
          orderId,
          user.address,
          USDC(37),
          nowpayments.address
        )
      ).to.be.revertedWithCustomError(integrator, "AmountMismatch");
    });

    it("reverts UnknownOrder for an order that was never placed", async () => {
      const { user, nowpayments, diamond, integrator } = await loadFixture(deploy);
      await expect(
        diamond.adminCallOnOrderComplete(
          integrator.target,
          999n,
          user.address,
          USDC(10),
          nowpayments.address
        )
      ).to.be.revertedWithCustomError(integrator, "UnknownOrder");
    });

    it("reverts OrderAlreadyFulfilled on a second completion (replay)", async () => {
      const { operator, user, nowpayments, usdc, diamond, integrator } = await loadFixture(deploy);
      const amount = USDC(38);
      const orderId = await place(integrator, operator, user.address, amount, nowpayments.address);
      await usdc.mint(diamond.target, amount);
      await diamond.simulateOrderComplete(orderId);
      await expect(
        diamond.adminCallOnOrderComplete(
          integrator.target,
          orderId,
          user.address,
          amount,
          nowpayments.address
        )
      ).to.be.revertedWithCustomError(integrator, "OrderAlreadyFulfilled");
    });

    it("marks a cancelled order so it can never be fulfilled", async () => {
      const { operator, user, nowpayments, diamond, integrator } = await loadFixture(deploy);
      const amount = USDC(38);
      const orderId = await place(integrator, operator, user.address, amount, nowpayments.address);
      await expect(diamond.simulateOrderCancelled(orderId))
        .to.emit(integrator, "ChallengeOrderCancelled")
        .withArgs(orderId);
      await expect(
        diamond.adminCallOnOrderComplete(
          integrator.target,
          orderId,
          user.address,
          amount,
          nowpayments.address
        )
      ).to.be.revertedWithCustomError(integrator, "OrderAlreadyCancelled");
    });
  });

  describe("reentrancy / replay of the completion callback", () => {
    it("onOrderComplete is nonReentrant + onlyDiamond: a settled order cannot be re-driven", async () => {
      const { operator, user, nowpayments, usdc, diamond, integrator } = await loadFixture(deploy);
      const amount = USDC(38);
      const orderId = await place(integrator, operator, user.address, amount, nowpayments.address);
      await usdc.mint(diamond.target, amount);
      await diamond.simulateOrderComplete(orderId);

      // Settlement is single-shot. A direct (non-Diamond) re-entry is rejected by onlyDiamond,
      // and a second Diamond-driven completion is rejected by the fulfilled flag — so the
      // forward can never run twice. (With standard USDC there is no transfer hook, so there is
      // no token-callback reentrancy surface; nonReentrant is belt-and-suspenders.)
      await expect(
        integrator.connect(user).onOrderComplete(orderId, user.address, amount, nowpayments.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
      await expect(
        diamond.adminCallOnOrderComplete(
          integrator.target,
          orderId,
          user.address,
          amount,
          nowpayments.address
        )
      ).to.be.revertedWithCustomError(integrator, "OrderAlreadyFulfilled");
      // Recipient received the amount exactly once.
      expect(await usdc.balanceOf(nowpayments.address)).to.equal(amount);
    });
  });

  describe("per-tx limit + pause", () => {
    it("placeChallengeOrder rejects amounts above the per-tx cap and zero", async () => {
      const { operator, user, nowpayments, integrator } = await loadFixture(deploy);
      await expect(
        integrator
          .connect(operator)
          .placeChallengeOrder(
            user.address,
            MAX_PER_TX + 1n,
            nowpayments.address,
            CURRENCY,
            0,
            "pk"
          )
      ).to.be.revertedWithCustomError(integrator, "AmountOutOfRange");
      await expect(
        integrator
          .connect(operator)
          .placeChallengeOrder(user.address, 0n, nowpayments.address, CURRENCY, 0, "pk")
      ).to.be.revertedWithCustomError(integrator, "AmountOutOfRange");
    });

    it("placeChallengeOrder rejects the zero user / zero recipient", async () => {
      const { operator, user, nowpayments, integrator } = await loadFixture(deploy);
      await expect(
        integrator
          .connect(operator)
          .placeChallengeOrder(ethers.ZeroAddress, USDC(10), nowpayments.address, CURRENCY, 0, "pk")
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      await expect(
        integrator
          .connect(operator)
          .placeChallengeOrder(user.address, USDC(10), ethers.ZeroAddress, CURRENCY, 0, "pk")
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    });

    it("validateOrder (as the Diamond) returns false above cap, on zero, and when paused", async () => {
      const { owner, user, integrator, diamond } = await loadFixture(deploy);
      const d = await asDiamond(diamond);
      expect(
        await integrator.connect(d).validateOrder.staticCall(user.address, USDC(10), CURRENCY)
      ).to.equal(true);
      expect(
        await integrator
          .connect(d)
          .validateOrder.staticCall(user.address, MAX_PER_TX + 1n, CURRENCY)
      ).to.equal(false);
      expect(
        await integrator.connect(d).validateOrder.staticCall(user.address, 0n, CURRENCY)
      ).to.equal(false);
      await integrator.connect(owner).pause();
      expect(
        await integrator.connect(d).validateOrder.staticCall(user.address, USDC(10), CURRENCY)
      ).to.equal(false);
    });

    it("blocks new placements while paused, but admin can unpause", async () => {
      const { owner, operator, user, nowpayments, integrator } = await loadFixture(deploy);
      await integrator.connect(owner).pause();
      await expect(
        integrator
          .connect(operator)
          .placeChallengeOrder(user.address, USDC(10), nowpayments.address, CURRENCY, 0, "pk")
      ).to.be.revertedWithCustomError(integrator, "EnforcedPause");
      await integrator.connect(owner).unpause();
      const orderId = await place(
        integrator,
        operator,
        user.address,
        USDC(10),
        nowpayments.address
      );
      expect(orderId).to.be.greaterThan(0n);
    });
  });

  describe("per-user daily-count limit", () => {
    it("enforces the daily count, then frees a slot on cancellation", async () => {
      const { operator, user, nowpayments, diamond, integrator } = await loadFixture(deploy);
      for (let i = 0; i < MAX_DAILY; i++) {
        await place(integrator, operator, user.address, USDC(10), nowpayments.address);
      }
      expect(await integrator.getTodayCount(user.address)).to.equal(BigInt(MAX_DAILY));
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(0n);

      // The (MAX_DAILY + 1)th placement is blocked by validateOrder.
      await expect(
        integrator
          .connect(operator)
          .placeChallengeOrder(user.address, USDC(10), nowpayments.address, CURRENCY, 0, "pk")
      ).to.be.reverted;

      // Cancelling order #1 releases its daily-count slot (keyed on placementDay).
      await diamond.simulateOrderCancelled(1);
      expect(await integrator.getTodayCount(user.address)).to.equal(BigInt(MAX_DAILY - 1));
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(1n);

      // A placement now succeeds again.
      const id = await place(integrator, operator, user.address, USDC(10), nowpayments.address);
      expect(id).to.be.greaterThan(0n);
    });

    it("validateOrder (as the Diamond) returns false once the daily count is exhausted", async () => {
      const { user, integrator, diamond } = await loadFixture(deploy);
      const d = await asDiamond(diamond);
      for (let i = 0; i < MAX_DAILY; i++) {
        await integrator.connect(d).validateOrder(user.address, USDC(10), CURRENCY);
      }
      expect(
        await integrator.connect(d).validateOrder.staticCall(user.address, USDC(10), CURRENCY)
      ).to.equal(false);
    });

    it("onOrderCancel is a no-op for unknown / already-cancelled orders", async () => {
      const { operator, user, nowpayments, integrator, diamond } = await loadFixture(deploy);
      const d = await asDiamond(diamond);
      const orderId = await place(
        integrator,
        operator,
        user.address,
        USDC(10),
        nowpayments.address
      );

      // Unknown order: no revert, no event, no decrement.
      await expect(integrator.connect(d).onOrderCancel(999n)).to.not.emit(
        integrator,
        "ChallengeOrderCancelled"
      );

      // First cancel decrements + emits.
      await expect(integrator.connect(d).onOrderCancel(orderId))
        .to.emit(integrator, "ChallengeOrderCancelled")
        .withArgs(orderId);
      expect(await integrator.getTodayCount(user.address)).to.equal(0n);

      // Second cancel is a silent no-op (already cancelled).
      await expect(integrator.connect(d).onOrderCancel(orderId)).to.not.emit(
        integrator,
        "ChallengeOrderCancelled"
      );
    });
  });

  describe("admin", () => {
    it("constructor validates addresses + limits", async () => {
      const { operator, usdc, diamond } = await loadFixture(deploy);
      const F = await ethers.getContractFactory("FundingAlphaXIntegrator");
      await expect(
        F.deploy(ethers.ZeroAddress, usdc.target, operator.address, MAX_PER_TX, MAX_DAILY)
      ).to.be.revertedWithCustomError(F, "InvalidAddress");
      await expect(
        F.deploy(diamond.target, ethers.ZeroAddress, operator.address, MAX_PER_TX, MAX_DAILY)
      ).to.be.revertedWithCustomError(F, "InvalidAddress");
      await expect(
        F.deploy(diamond.target, usdc.target, ethers.ZeroAddress, MAX_PER_TX, MAX_DAILY)
      ).to.be.revertedWithCustomError(F, "InvalidAddress");
      await expect(
        F.deploy(diamond.target, usdc.target, operator.address, 0, MAX_DAILY)
      ).to.be.revertedWithCustomError(F, "AmountOutOfRange");
      await expect(
        F.deploy(diamond.target, usdc.target, operator.address, MAX_PER_TX, 0)
      ).to.be.revertedWithCustomError(F, "AmountOutOfRange");
    });

    it("owner can rotate operator + caps (with events) and reject zero/invalid", async () => {
      const { owner, operator, integrator } = await loadFixture(deploy);
      await expect(integrator.connect(owner).setOperator(owner.address))
        .to.emit(integrator, "OperatorUpdated")
        .withArgs(operator.address, owner.address);
      await expect(
        integrator.connect(owner).setOperator(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      await expect(integrator.connect(owner).setMaxPerTxUsdc(USDC(500)))
        .to.emit(integrator, "MaxPerTxUpdated")
        .withArgs(MAX_PER_TX, USDC(500));
      await expect(integrator.connect(owner).setMaxPerTxUsdc(0)).to.be.revertedWithCustomError(
        integrator,
        "AmountOutOfRange"
      );
      await expect(integrator.connect(owner).setMaxDailyCountPerUser(20))
        .to.emit(integrator, "MaxDailyCountUpdated")
        .withArgs(MAX_DAILY, 20);
      await expect(
        integrator.connect(owner).setMaxDailyCountPerUser(0)
      ).to.be.revertedWithCustomError(integrator, "AmountOutOfRange");
    });

    it("owner can hand off to a multisig (Ownable2Step)", async () => {
      const { owner, multisig, integrator } = await loadFixture(deploy);
      await integrator.connect(owner).transferOwnership(multisig.address);
      await integrator.connect(multisig).acceptOwnership();
      expect(await integrator.owner()).to.equal(multisig.address);
      await expect(integrator.connect(multisig).setOperator(owner.address)).to.emit(
        integrator,
        "OperatorUpdated"
      );
    });

    it("owner can recover a stuck order, and recovery guards hold", async () => {
      const { owner, operator, user, nowpayments, usdc, integrator } = await loadFixture(deploy);
      const amount = USDC(38);
      const orderId = await place(integrator, operator, user.address, amount, nowpayments.address);
      // Funds land on the proxy but completion never ran (fund the proxy directly).
      const proxy = await integrator.proxyAddress(user.address);
      await usdc.mint(proxy, amount);
      await expect(integrator.connect(owner).recoverStuckOrder(orderId))
        .to.emit(integrator, "StuckOrderRecovered")
        .withArgs(orderId, nowpayments.address, amount);
      expect(await usdc.balanceOf(nowpayments.address)).to.equal(amount);

      // Re-recovery is rejected (already fulfilled), and unknown orders revert.
      await expect(
        integrator.connect(owner).recoverStuckOrder(orderId)
      ).to.be.revertedWithCustomError(integrator, "OrderAlreadyFulfilled");
      await expect(integrator.connect(owner).recoverStuckOrder(999n)).to.be.revertedWithCustomError(
        integrator,
        "UnknownOrder"
      );
    });

    it("owner can rescue stray ERC-20s (and rejects the zero recipient)", async () => {
      const { owner, attacker, usdc, integrator } = await loadFixture(deploy);
      await usdc.mint(integrator.target, USDC(7));
      await expect(integrator.connect(owner).rescueERC20(usdc.target, attacker.address, USDC(7)))
        .to.emit(integrator, "Rescued")
        .withArgs(usdc.target, attacker.address, USDC(7));
      expect(await usdc.balanceOf(attacker.address)).to.equal(USDC(7));
      await expect(
        integrator.connect(owner).rescueERC20(usdc.target, ethers.ZeroAddress, 1n)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    });
  });
});
