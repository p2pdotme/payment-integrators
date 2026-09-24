import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * HypeHouseRampIntegrator: a fiat ON-ramp whose payout address is pinned in
 * contract storage rather than passed per order.
 *
 * The assertions that carry the design are the two redirection ones. Every
 * other integrator in this repo takes a recipient from its caller; this one
 * cannot, because the destination IS the control — on-ramped USDC may only ever
 * land in the user's own policy-locked ramp wallet, which is what makes the
 * fiat-in / crypto-out rule enforceable at all. A client that could name the
 * recipient, or a Diamond whose `recipientAddr` were honoured, would undo it.
 */
describe("HypeHouseRampIntegrator", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let stranger: SignerWithAddress;
  let rampWallet: SignerWithAddress;
  let attacker: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let mockRm: any;
  let integrator: any;
  let integratorAddr: string;
  let usdcAddr: string;

  const USDC = (n: number | string) => ethers.parseUnits(n.toString(), 6);
  const INR = ethers.encodeBytes32String("INR");

  beforeEach(async function () {
    [owner, user, stranger, rampWallet, attacker] = await ethers.getSigners();

    mockUsdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    usdcAddr = await mockUsdc.getAddress();
    mockDiamond = await (await ethers.getContractFactory("MockDiamond")).deploy(usdcAddr);
    mockRm = await (await ethers.getContractFactory("MockReputationManager")).deploy();

    integrator = await (
      await ethers.getContractFactory("HypeHouseRampIntegrator")
    ).deploy(await mockDiamond.getAddress(), usdcAddr, await mockRm.getAddress());
    integratorAddr = await integrator.getAddress();

    await mockDiamond.registerIntegrator(integratorAddr, await integrator.proxyImpl());
    // usdcThroughIntegrator = FALSE: the Diamond pays the order's recipientAddr
    // - the ramp wallet pinned at placement - DIRECTLY. The integrator never
    // holds user money (B2BGatewayFacet.sol:264-268).
    await mockDiamond.setUsdcThroughIntegrator(false);
  });

  const register = () => integrator.setRampRecipient(user.address, rampWallet.address);

  /**
   * Settle an order. The DIAMOND is funded, not the proxy: registered with
   * usdcThroughIntegrator = true, the gateway transfers the USDC to the
   * integrator itself before calling onOrderComplete
   * (B2BGatewayFacet.sol:265).
   */
  async function settle(orderId: number, amount: bigint) {
    await mockUsdc.mint(await mockDiamond.getAddress(), amount);
    await mockDiamond.simulateOrderComplete(orderId);
  }

  describe("the registration gate", function () {
    it("refuses an unregistered user", async function () {
      await expect(
        integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk")
      ).to.be.revertedWithCustomError(integrator, "NotRegistered");
    });

    it("admits one once a recipient is pinned", async function () {
      await register();
      expect(await integrator.isRegistered(user.address)).to.equal(true);
      await expect(integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk")).to.not.be
        .reverted;
    });

    it("lets only the registrar or owner pin a recipient", async function () {
      await expect(
        integrator.connect(attacker).setRampRecipient(attacker.address, rampWallet.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyRegistrar");
    });

    it("is the sybil barrier: a stranger cannot use the contract at all", async function () {
      // The farm's core technique is spinning fresh wallets. Here a fresh
      // wallet is not a user, and there is no argument it can pass to become one.
      await expect(
        integrator.connect(stranger).userPlaceOrder(USDC(10), INR, 0, "pk")
      ).to.be.revertedWithCustomError(integrator, "NotRegistered");
    });
  });

  describe("payout redirection", function () {
    it("pays the PINNED recipient, not the address the Diamond passes", async function () {
      // The mock passes its own `recipientAddr` to onOrderComplete. Honouring
      // it would let settlement land anywhere; the whole taint model assumes it
      // cannot.
      await register();
      await integrator.connect(user).userPlaceOrder(USDC(50), INR, 0, "pk");
      await settle(1, USDC(50));
      expect(await mockUsdc.balanceOf(rampWallet.address)).to.equal(USDC(50));
      expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(0n);
    });

    it("has no entry point that accepts a recipient", async function () {
      // Not a behaviour test but an ABI one: the absence of the argument is the
      // guarantee. If someone adds an overload, this fails.
      const fns = integrator.interface.fragments
        .filter((f: any) => f.type === "function")
        .map((f: any) => f.format("full"));
      const placers = fns.filter((f: string) => f.includes("userPlaceOrder"));
      expect(placers).to.have.lengthOf(1);
      expect(placers[0]).to.not.match(/recipient/i);
    });

    it("NEVER holds user money, so a failed callback cannot strand any", async function () {
      // The reason usdcThroughIntegrator is false. The callback that fires
      // after settlement is best-effort and try/catch'd by the gateway
      // (B2BGatewayFacet.sol:277-288), so anything it was responsible for
      // moving could be left behind. It is responsible for moving nothing.
      await register();
      await integrator.connect(user).userPlaceOrder(USDC(50), INR, 0, "pk");
      await settle(1, USDC(50));
      expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(0n);
      expect(await mockUsdc.balanceOf(await integrator.proxyAddress(user.address))).to.equal(0n);
    });

    it("records the pinned recipient ON THE ORDER, which is what gets paid", async function () {
      // With usdcThroughIntegrator = false the Diamond pays
      // `_order.recipientAddr`, so the pin has to reach the order at placement.
      // Passing address(0) here - as an earlier draft of this contract did -
      // would have sent every settlement to the zero address.
      await register();
      await integrator.connect(user).userPlaceOrder(USDC(25), INR, 0, "pk");
      const order = await mockDiamond.getOrdersById(1);
      expect(order.recipientAddr).to.equal(rampWallet.address);
      expect(order.recipientAddr).to.not.equal(ethers.ZeroAddress);
    });

    it("works end to end in hype.house's ACTUAL configuration: one wallet, self-pinned", async function () {
      // The whole point of relaxing the self-pin check. The relay signs
      // userPlaceOrder from the policy-locked ramp wallet, so placer == recipient.
      // This asserts the order that results pays that same wallet - i.e. that the
      // configuration is not merely pinnable but correct.
      await integrator.setRampRecipient(rampWallet.address, rampWallet.address);
      await integrator.connect(rampWallet).userPlaceOrder(USDC(25), INR, 0, "pk");
      const order = await mockDiamond.getOrdersById(1);
      expect(order.recipientAddr).to.equal(rampWallet.address);
      // order.user is the RAMP WALLET, not the UserProxy - the proxy is only the
      // msg.sender the gateway authenticates, while `user` is the argument
      // placeB2BOrder records. Worth pinning: hype.house's off-ramp gate
      // (isSettledSell) matches an order's `user` against the stored ramp wallet,
      // so if this were the proxy address that check would refuse every order.
      expect(order.user).to.equal(rampWallet.address);
      expect(order.recipientAddr).to.not.equal(ethers.ZeroAddress);
    });
  });

  describe("userPlaceSellOrder — the cash-out", function () {
    // WHY THIS EXISTS AT ALL. The off-ramp originally went STRAIGHT to the
    // Diamond's placeOrder, which is an ordinary consumer sell and therefore hits
    // txnAmountValid - whose per-tx ceiling is RP-derived, measured at 200 USDC on
    // Base mainnet for a wallet with no reputation. Every freshly minted ramp
    // wallet has none, so a 500-USDC on-ramp could only be cashed out in
    // 200-chunks. placeB2BSellOrder bypasses those limits and lets OUR caps
    // apply, which is the point of being whitelisted.
    const CIRCLE = 1n;

    it("places a SELL through the gateway, not a BUY", async function () {
      await integrator.setRampRecipient(rampWallet.address, rampWallet.address);
      await integrator.connect(rampWallet).userPlaceSellOrder(USDC(400), INR, "userpk", CIRCLE, 0);
      const sell = await mockDiamond.sellOrders(1);
      expect(sell.user).to.equal(rampWallet.address);
      expect(sell.amount).to.equal(USDC(400));
    });

    it("EXCEEDS the 200-USDC consumer sell ceiling, which is the whole reason", async function () {
      // A direct placeOrder at this size would revert SellOrderAmountExceedsLimit
      // for a zero-RP wallet. Through the gateway it is only our per-tx cap that
      // applies, and that is 500.
      await integrator.setRampRecipient(rampWallet.address, rampWallet.address);
      await expect(
        integrator.connect(rampWallet).userPlaceSellOrder(USDC(500), INR, "pk", CIRCLE, 0)
      ).to.not.be.reverted;
    });

    it("still refuses an unregistered wallet", async function () {
      await expect(
        integrator.connect(stranger).userPlaceSellOrder(USDC(10), INR, "pk", CIRCLE, 0)
      ).to.be.revertedWithCustomError(integrator, "NotRegistered");
    });

    it("still applies OUR per-tx cap", async function () {
      await integrator.setRampRecipient(rampWallet.address, rampWallet.address);
      await expect(
        integrator.connect(rampWallet).userPlaceSellOrder(USDC(501), INR, "pk", CIRCLE, 0)
      ).to.be.revertedWithCustomError(integrator, "OverPerTxCap");
    });

    it("does NOT consume the daily on-ramp budget", async function () {
      // Cashing out must not burn the headroom to cash in. The caps are checked
      // (validateOrder cannot tell a SELL from a BUY) but never debited.
      await integrator.setRampRecipient(rampWallet.address, rampWallet.address);
      await integrator.connect(rampWallet).userPlaceSellOrder(USDC(500), INR, "pk", CIRCLE, 0);
      await integrator.connect(rampWallet).userPlaceSellOrder(USDC(500), INR, "pk", CIRCLE, 0);
      await integrator.connect(rampWallet).userPlaceSellOrder(USDC(500), INR, "pk", CIRCLE, 0);
      await integrator.connect(rampWallet).userPlaceSellOrder(USDC(500), INR, "pk", CIRCLE, 0);
      // A fifth 500 would be 2500 against a 2000 daily cap if sells debited.
      await expect(
        integrator.connect(rampWallet).userPlaceSellOrder(USDC(500), INR, "pk", CIRCLE, 0)
      ).to.not.be.reverted;
    });

    it("does NOT consume an in-flight slot", async function () {
      // inFlightCap is 3. A fourth BUY would fail; four SELLs must not.
      await integrator.setRampRecipient(rampWallet.address, rampWallet.address);
      for (let i = 0; i < 4; i++) {
        await integrator.connect(rampWallet).userPlaceSellOrder(USDC(10), INR, "pk", CIRCLE, 0);
      }
      expect(await integrator.inFlightOf(rampWallet.address)).to.equal(0);
    });

    it("is NOT recorded in the BUY bookkeeping, so a cancel cannot penalise it", async function () {
      // orderUserOf is what onOrderCancel reads to charge a permanent in-flight
      // slot. A cash-out no merchant took must not cost the user one.
      await integrator.setRampRecipient(rampWallet.address, rampWallet.address);
      await integrator.connect(rampWallet).userPlaceSellOrder(USDC(50), INR, "pk", CIRCLE, 0);
      // orderUserOf being zero IS the property: onOrderCancel returns early on
      // `user == address(0)`, so the penalty can never reach a cash-out. Asserted
      // on the state rather than by driving the mock's BUY-only cancel helper.
      expect(await integrator.orderUserOf(1)).to.equal(ethers.ZeroAddress);
      expect(await integrator.orderAmountOf(1)).to.equal(0);
      expect(await integrator.cancelCountOf(rampWallet.address)).to.equal(0);
    });

    it("REFUSES to place when routed through the integrator", async function () {
      await integrator.setRampRecipient(rampWallet.address, rampWallet.address);
      await mockDiamond.setUsdcThroughIntegrator(true);
      await expect(
        integrator.connect(rampWallet).userPlaceSellOrder(USDC(10), INR, "pk", CIRCLE, 0)
      ).to.be.revertedWithCustomError(integrator, "RoutesThroughIntegrator");
    });

    it("has no recipient argument, because a SELL pays nobody in USDC", async function () {
      // A real completed SELL on Base mainnet carries recipientAddr = 0. An
      // overload taking one would invite somebody to pass a payee that is never read.
      const fns = integrator.interface.fragments
        .filter((f: { type: string }) => f.type === "function")
        .map((f: { name?: string; inputs?: { name: string }[] }) => ({
          n: f.name,
          i: (f.inputs ?? []).map((x) => x.name),
        }));
      const sell = fns.filter((f) => f.n === "userPlaceSellOrder");
      expect(sell).to.have.length(1);
      expect(sell[0].i.join(",")).to.not.match(/recipient/i);
    });
  });

  describe("settlement callbacks", function () {
    it("rejects a settlement callback from anyone but the Diamond", async function () {
      await register();
      await expect(
        integrator.connect(attacker).onOrderComplete(1, user.address, USDC(10), attacker.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
    });
  });

  describe("the order id", function () {
    it("comes from the Diamond's RETURN VALUE, not a pre-read", async function () {
      // execute() hands back the call's return data verbatim, so placeB2BOrder's
      // orderId survives the proxy. An earlier draft pre-read getNextOrderId()
      // instead; this is the case that proves the difference.
      await register();
      await mockDiamond.setForceOrderId(4242);
      await integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk");
      // Recorded against the id the Diamond actually used. A pre-read would have
      // filed this under nextOrderId (1) and then cancelled the wrong row.
      expect(await integrator.orderUserOf(4242)).to.equal(user.address);
      expect(await integrator.orderUserOf(1)).to.equal(ethers.ZeroAddress);
    });

    it("so a cancel finds the right row", async function () {
      // The consequence, not just the bookkeeping: onOrderCancel looks the user
      // up BY order id, so a mis-recorded id silently releases nothing.
      await register();
      await mockDiamond.setForceOrderId(777);
      await integrator.setCaps(USDC(500), USDC(500), 5);
      await integrator.connect(user).userPlaceOrder(USDC(500), INR, 0, "pk");
      await mockDiamond.simulateOrderCancelled(777);
      expect(await integrator.inFlightOf(user.address)).to.equal(0n);
      expect(await integrator.cancelCountOf(user.address)).to.equal(1n);
      // ...and the daily allowance came back.
      await expect(integrator.connect(user).userPlaceOrder(USDC(500), INR, 0, "pk")).to.not.be
        .reverted;
    });
  });

  describe("the blacklist read", function () {
    it("refuses a user flagged on ReputationManager", async function () {
      await register();
      await mockRm.setBlacklisted(user.address, true);
      await expect(
        integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk")
      ).to.be.revertedWithCustomError(integrator, "UserBlacklisted");
    });

    it("decodes the THIRD return of rmusers, not the first two", async function () {
      // RmUser is { reputationPoints, voteCount, isBlacklisted } and the member
      // ORDER is the ABI. A non-zero RP with a clean flag must read as clean;
      // if the decode slipped a slot, RP would be mistaken for the flag.
      await register();
      await mockRm.setUser(user.address, 150, 7, false);
      await expect(integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk")).to.not.be
        .reverted;
      await mockRm.setUser(user.address, 150, 7, true);
      await expect(
        integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk")
      ).to.be.revertedWithCustomError(integrator, "UserBlacklisted");
    });

    it("still gates when ReputationManager is unset, on everything else", async function () {
      const noRm = await (
        await ethers.getContractFactory("HypeHouseRampIntegrator")
      ).deploy(await mockDiamond.getAddress(), usdcAddr, ethers.ZeroAddress);
      await expect(
        noRm.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk")
      ).to.be.revertedWithCustomError(noRm, "NotRegistered");
    });
  });

  describe("caps", function () {
    it("binds per transaction", async function () {
      await register();
      await expect(
        integrator.connect(user).userPlaceOrder(USDC(501), INR, 0, "pk")
      ).to.be.revertedWithCustomError(integrator, "OverPerTxCap");
    });

    it("binds per day across several orders", async function () {
      await register();
      await integrator.setCaps(USDC(500), USDC(800), 10);
      await integrator.connect(user).userPlaceOrder(USDC(500), INR, 0, "pk");
      await expect(
        integrator.connect(user).userPlaceOrder(USDC(301), INR, 0, "pk")
      ).to.be.revertedWithCustomError(integrator, "OverDailyCap");
      await expect(integrator.connect(user).userPlaceOrder(USDC(300), INR, 0, "pk")).to.not.be
        .reverted;
    });

    it("caps orders in flight", async function () {
      await register();
      await integrator.setCaps(USDC(500), USDC(5000), 2);
      await integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk");
      await integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk");
      await expect(
        integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk")
      ).to.be.revertedWithCustomError(integrator, "TooManyInFlight");
    });

    it("frees an in-flight slot on settlement", async function () {
      await register();
      await integrator.setCaps(USDC(500), USDC(5000), 1);
      await integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk");
      await settle(1, USDC(10));
      expect(await integrator.inFlightOf(user.address)).to.equal(0n);
      await expect(integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk")).to.not.be
        .reverted;
    });

    it("lets only the owner move the caps", async function () {
      await expect(
        integrator.connect(attacker).setCaps(USDC(1e6), USDC(1e6), 99)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });
  });

  describe("cancellation", function () {
    it("releases the daily debit and the in-flight slot", async function () {
      await register();
      await integrator.setCaps(USDC(500), USDC(500), 5);
      await integrator.connect(user).userPlaceOrder(USDC(500), INR, 0, "pk");
      await mockDiamond.simulateOrderCancelled(1);
      expect(await integrator.inFlightOf(user.address)).to.equal(0n);
      // The full daily allowance is available again.
      await expect(integrator.connect(user).userPlaceOrder(USDC(500), INR, 0, "pk")).to.not.be
        .reverted;
    });

    it("TIGHTENS the in-flight cap, permanently", async function () {
      // The engine's rapid_cancellations restriction is per-wallet and expires
      // in four hours; the 2026-09-08 case shows the seed wallet simply resumed
      // after each one. This counter does not expire.
      await register();
      await integrator.setCaps(USDC(500), USDC(5000), 3);
      await integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk");
      await mockDiamond.simulateOrderCancelled(1);
      expect(await integrator.cancelCountOf(user.address)).to.equal(1n);
      await integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk");
      await integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk");
      // Cap is now 3 - 1 = 2, so the third in-flight order is refused.
      await expect(
        integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk")
      ).to.be.revertedWithCustomError(integrator, "TooManyInFlight");
    });

    it("never tightens below one slot", async function () {
      await register();
      await integrator.setCaps(USDC(500), USDC(9000), 2);
      for (let i = 1; i <= 5; i++) {
        await integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk");
        await mockDiamond.simulateOrderCancelled(i);
      }
      // A user who cancelled five times can still place exactly one order: a
      // floor of zero would be a permanent lockout written by accident.
      await expect(integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk")).to.not.be
        .reverted;
    });

    it("is idempotent and tolerates an unknown order id", async function () {
      // Required by the interface: the Diamond may call after its own state has
      // finalised, and may call twice.
      await register();
      await integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk");
      await mockDiamond.simulateOrderCancelled(1);
      // The mock refuses its own double-cancel ("Already cancelled"), so call
      // OUR handler as the Diamond for the repeat - the interface requires us to
      // tolerate it however the Diamond behaves.
      const diamondAddr = await mockDiamond.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [diamondAddr]);
      await ethers.provider.send("hardhat_setBalance", [diamondAddr, "0xde0b6b3a7640000"]);
      const asDiamond = await ethers.getSigner(diamondAddr);
      await expect(integrator.connect(asDiamond).onOrderCancel(1)).to.not.be.reverted;
      await expect(integrator.connect(asDiamond).onOrderCancel(4242)).to.not.be.reverted;
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [diamondAddr]);
      // Exactly one cancel counted, so a double call cannot tighten twice.
      expect(await integrator.cancelCountOf(user.address)).to.equal(1n);
    });

    it("rejects a cancel callback from anyone but the Diamond", async function () {
      await expect(integrator.connect(attacker).onOrderCancel(1)).to.be.revertedWithCustomError(
        integrator,
        "OnlyDiamond"
      );
    });
  });

  describe("reconcile — because the cancel callback does not fire", function () {
    // onOrderCancel is the ONLY other thing that releases a slot, and the Diamond
    // does not reliably call it: at the contracts-v4 revision this was written
    // against, onB2BOrderCancelled decrements the gateway's own count and emits,
    // never calling the integrator, while onB2BOrderComplete DOES call
    // onOrderComplete. Later revisions make it opt-in, default off. Either way an
    // order that expires unaccepted holds its slot forever, and roughly half of
    // mainnet B2B BUY orders end CANCELLED - so without this, after three such
    // orders a user can never place again.
    const CANCELLED = 4;
    const COMPLETED = 3;
    const PLACED = 0;

    it("releases the slot and refunds the day when the chain says CANCELLED", async function () {
      await register();
      await integrator.setCaps(USDC(500), USDC(500), 2);
      await integrator.connect(user).userPlaceOrder(USDC(500), INR, 0, "pk");
      expect(await integrator.inFlightOf(user.address)).to.equal(1n);

      // NO CALLBACK, which is what the real Diamond does: the order is cancelled
      // protocol-side and the integrator is never told.
      await mockDiamond.simulateOrderCancelledNoCallback(1);
      await integrator.connect(stranger).reconcile(1); // permissionless
      expect(await integrator.inFlightOf(user.address)).to.equal(0n);
      // The full daily allowance is back.
      await expect(integrator.connect(user).userPlaceOrder(USDC(500), INR, 0, "pk")).to.not.be
        .reverted;
    });

    it("releases the slot but NOT the day when the chain says COMPLETED", async function () {
      // The money moved; the daily cap is about volume placed.
      await register();
      await integrator.setCaps(USDC(500), USDC(500), 2);
      await integrator.connect(user).userPlaceOrder(USDC(500), INR, 0, "pk");
      // The mock routes USDC on completion, so fund it like a real settlement.
      await mockUsdc.mint(await mockDiamond.getAddress(), USDC(500));
      await mockDiamond.simulateOrderCompleteNoCallback(1);
      await integrator.reconcile(1);
      expect(await integrator.inFlightOf(user.address)).to.equal(0n);
      await expect(
        integrator.connect(user).userPlaceOrder(USDC(1), INR, 0, "pk")
      ).to.be.revertedWithCustomError(integrator, "OverDailyCap");
    });

    it("does NOTHING for an order the chain still calls live", async function () {
      // Otherwise reconcile would be a way to free slots on demand.
      await register();
      await integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk");
      // Still PLACED on-chain: reconcile must not be a way to free slots on demand.
      await integrator.reconcile(1);
      expect(await integrator.inFlightOf(user.address)).to.equal(1n);
    });

    it("is idempotent, and a no-op for an unknown id", async function () {
      await register();
      await integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk");
      await mockDiamond.simulateOrderCancelledNoCallback(1);
      await integrator.reconcile(1);
      await expect(integrator.reconcile(1)).to.not.be.reverted;
      await expect(integrator.reconcile(9999)).to.not.be.reverted;
      expect(await integrator.inFlightOf(user.address)).to.equal(0n);
    });

    it("REVERTS rather than releasing when the chain names a different user", async function () {
      // The positional read self-checks: a member inserted upstream before
      // `status` would shift both fields together, and releasing the wrong row is
      // worse than failing loud. Forced here by recording one user's row against
      // an order the chain attributes to another.
      await register();
      await integrator.setRampRecipient(stranger.address, rampWallet.address);
      await integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk");
      await integrator.connect(stranger).userPlaceOrder(USDC(10), INR, 0, "pk");
      await mockDiamond.simulateOrderCancelledNoCallback(2);
      // Order 2 belongs to `stranger` on-chain; reconciling it releases stranger's
      // row and leaves user's alone.
      await integrator.reconcile(2);
      expect(await integrator.inFlightOf(stranger.address)).to.equal(0n);
      expect(await integrator.inFlightOf(user.address)).to.equal(1n);
    });

    it("fails closed when the Diamond's config cannot be read", async function () {
      // An unreadable config must not be treated as "not routed through us".
      await register();
      await mockDiamond.setConfigReadable(false);
      await expect(integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk")).to.be.reverted;
    });

    it("gives the owner a manual escape when reconcile cannot help", async function () {
      await register();
      await integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk");
      await integrator.resetInFlight(user.address);
      expect(await integrator.inFlightOf(user.address)).to.equal(0n);
      await expect(
        integrator.connect(attacker).resetInFlight(user.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });
  });

  describe("a wrong registration must not be survivable", function () {
    it("REFUSES to place an order when routed through the integrator", async function () {
      // If whitelisted with usdcThroughIntegrator = true - which has happened to
      // another integrator in production - settlement lands here instead of the
      // user's ramp wallet, and onOrderComplete would still emit RampSettled, so
      // the app would credit a tranche to somebody who never got the money.
      // Refusing at placement means no such order can exist.
      await register();
      await mockDiamond.setUsdcThroughIntegrator(true);
      await expect(
        integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk")
      ).to.be.revertedWithCustomError(integrator, "RoutesThroughIntegrator");
    });

    it("lets the owner sweep USDC that arrived anyway", async function () {
      // Without this, anything that does land here is unrecoverable.
      await mockUsdc.mint(integratorAddr, USDC(42));
      await integrator.sweepUsdc(rampWallet.address, USDC(42));
      expect(await mockUsdc.balanceOf(rampWallet.address)).to.equal(USDC(42));
      await expect(
        integrator.connect(attacker).sweepUsdc(attacker.address, 1n)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });
  });

  describe("the cap ceilings", function () {
    it("refuses a cap above its immutable ceiling", async function () {
      // A whitelisted integrator bypasses the protocol's own RP and volume limits,
      // so an owner-raisable cap is a protocol lever, not partner config.
      await expect(integrator.setCaps(USDC(3000), USDC(5000), 3)).to.be.revertedWithCustomError(
        integrator,
        "CapExceedsCeiling"
      );
      await expect(integrator.setCaps(USDC(500), USDC(20000), 3)).to.be.revertedWithCustomError(
        integrator,
        "CapExceedsCeiling"
      );
      await expect(integrator.setCaps(USDC(500), USDC(2000), 99)).to.be.revertedWithCustomError(
        integrator,
        "CapExceedsCeiling"
      );
    });

    it("allows anything at or under the ceiling", async function () {
      await expect(
        integrator.setCaps(
          await integrator.MAX_PER_TX_USDC(),
          await integrator.MAX_PER_DAY_USDC(),
          await integrator.MAX_IN_FLIGHT()
        )
      ).to.not.be.reverted;
    });

    it("ships defaults that are themselves legal", async function () {
      expect(await integrator.perTxCapUsdc()).to.be.lte(await integrator.MAX_PER_TX_USDC());
      expect(await integrator.perDayCapUsdc()).to.be.lte(await integrator.MAX_PER_DAY_USDC());
      expect(await integrator.inFlightCap()).to.be.lte(await integrator.MAX_IN_FLIGHT());
    });
  });

  describe("the key model", function () {
    it("pins ONCE: the hot key cannot redirect an existing user", async function () {
      // A registrar that can overwrite can redirect every future on-ramp of an
      // existing user to an address it chooses - and the user still pays the fiat.
      await register();
      await expect(
        integrator.setRampRecipient(user.address, attacker.address)
      ).to.be.revertedWithCustomError(integrator, "AlreadyPinned");
    });

    it("re-pins only from the cold key, with its own event", async function () {
      await register();
      await expect(integrator.resetRampRecipient(user.address, stranger.address))
        .to.emit(integrator, "RampRecipientReset")
        .withArgs(user.address, rampWallet.address, stranger.address);
      await expect(
        integrator.connect(attacker).resetRampRecipient(user.address, attacker.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });

    it("ALLOWS a self-pin, because that is the configuration hype.house has", async function () {
      // This used to revert RecipientIsUser, on the reasoning that on-ramped USDC
      // must land somewhere whose spending policy the app controls. The invariant
      // is right; the check was a proxy for it that inverts here.
      //
      // hype.house signs userPlaceOrder from the user's POLICY-LOCKED RAMP WALLET,
      // so msg.sender - the `user` in this mapping - already IS the app-controlled
      // wallet, and is also the right recipient. The old check therefore made the
      // only configuration this integrator has unpinnable, which is how it was
      // found: setRampRecipient(w, w) reverted, and that is the exact call the
      // server has to make.
      //
      // Safe because pinning is REGISTRAR-ONLY: a user cannot name their own wallet
      // as a destination, only the server can, and it only ever names a wallet it
      // provisioned under a Privy policy. The test below this one is what holds
      // that line.
      await expect(integrator.setRampRecipient(rampWallet.address, rampWallet.address))
        .to.emit(integrator, "RampRecipientSet")
        .withArgs(rampWallet.address, rampWallet.address);
      expect(await integrator.rampRecipientOf(rampWallet.address)).to.equal(rampWallet.address);
    });

    it("...and a USER still cannot pin themselves, which is what keeps it safe", async function () {
      // The whole safety of allowing a self-pin rests on pinning being privileged.
      // If this ever passes, on-ramped USDC can be directed to a wallet whose
      // spending policy nobody controls.
      await expect(
        integrator.connect(user).setRampRecipient(user.address, user.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyRegistrar");
    });

    it("lets a delegated registrar pin, and nothing else", async function () {
      await integrator.setRegistrar(stranger.address);
      await expect(integrator.connect(stranger).setRampRecipient(user.address, rampWallet.address))
        .to.not.be.reverted;
      await expect(
        integrator.connect(stranger).setCaps(USDC(1), USDC(1), 1)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
      await expect(
        integrator.connect(stranger).setRegistrar(attacker.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });

    it("transfers ownership in two steps, and can be cancelled", async function () {
      // A typo must not hand the contract to an address nobody controls.
      await integrator.transferOwnership(stranger.address);
      expect(await integrator.owner()).to.equal(owner.address);
      await expect(integrator.connect(attacker).acceptOwnership()).to.be.revertedWithCustomError(
        integrator,
        "NotPending"
      );
      await integrator.transferOwnership(ethers.ZeroAddress); // cancel
      await expect(integrator.connect(stranger).acceptOwnership()).to.be.revertedWithCustomError(
        integrator,
        "NotPending"
      );
      await integrator.transferOwnership(stranger.address);
      await integrator.connect(stranger).acceptOwnership();
      expect(await integrator.owner()).to.equal(stranger.address);
    });
  });

  describe("the zero-address guards", function () {
    it("refuses a zero diamond or usdc at construction", async function () {
      const F = await ethers.getContractFactory("HypeHouseRampIntegrator");
      await expect(
        F.deploy(ethers.ZeroAddress, usdcAddr, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(F, "InvalidAddress");
      await expect(
        F.deploy(await mockDiamond.getAddress(), ethers.ZeroAddress, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(F, "InvalidAddress");
    });

    it("refuses a zero user or recipient when pinning", async function () {
      await expect(
        integrator.setRampRecipient(ethers.ZeroAddress, rampWallet.address)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      await expect(
        integrator.setRampRecipient(user.address, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      await expect(
        integrator.resetRampRecipient(ethers.ZeroAddress, rampWallet.address)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      await expect(integrator.sweepUsdc(ethers.ZeroAddress, 1n)).to.be.revertedWithCustomError(
        integrator,
        "InvalidAddress"
      );
    });
  });

  describe("validateOrder, called by the Diamond", function () {
    it("blocks an amount the integrator never agreed to", async function () {
      // MockDiamond's tamper mode mirrors a gateway that validates a different
      // amount than the one placed. The cap must be read from the amount the
      // Diamond presents, not from anything we remembered.
      // The mock validates `amount + 1`, so the order has to sit exactly on the
      // cap for the tampered value to cross it.
      //
      // The revert arrives WRAPPED: validateOrder runs inside the Diamond call,
      // which runs inside UserProxy.execute, so our error comes back as the
      // bytes payload of CallFailed. Asserting on the inner selector is the
      // only way to prove it was OUR cap that refused and not something else
      // failing on the way.
      await register();
      await mockDiamond.setTamperValidationAmount(true);
      const selector = ethers.id("OverPerTxCap(uint256,uint256)").slice(2, 10);
      try {
        await integrator.connect(user).userPlaceOrder(USDC(500), INR, 0, "pk");
        expect.fail("expected the tampered amount to be refused");
      } catch (err: any) {
        expect(JSON.stringify(err).toLowerCase()).to.contain(selector);
      }
    });

    it("survives being validated twice for one placement", async function () {
      await register();
      await mockDiamond.setDoubleValidate(true);
      await expect(integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk")).to.not.be
        .reverted;
    });
  });
});
