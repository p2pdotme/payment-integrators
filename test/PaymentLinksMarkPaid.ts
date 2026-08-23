import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

/** Deploys PaymentLinksLib and returns its address, for linking. */
async function deployPaymentLinksLib(): Promise<string> {
  const Lib = await ethers.getContractFactory("PaymentLinksLib");
  const lib = await Lib.deploy();
  await lib.waitForDeployment();
  return await lib.getAddress();
}

/**
 * Reaching PAID on a link order.
 *
 * THE BUG THIS SUITE EXISTS FOR
 * The Diamond authorises `paidBuyOrder` against `order.user`. Link orders used
 * to place with the MERCHANT as `order.user`, and the merchant is absent by
 * construction — so nothing could ever advance the order. The customer paid
 * fiat, the order sat until TTL, and the merchant was never credited.
 *
 * Nothing caught it because MockDiamond implemented neither `paidBuyOrder` nor
 * `cancelOrder`: the settlement tests jumped straight to `simulateOrderComplete`
 * and skipped the entire fiat leg. MockDiamond now enforces the real
 * `order.user` gate, so this suite fails against the old design.
 *
 * The fix places link orders with the merchant's PROXY as `order.user`, which
 * this contract can drive through `UserProxy.execute`.
 */
describe("MerchantTerminalIntegrator — payment links reach PAID", function () {
  let owner: SignerWithAddress;
  let merchant1: SignerWithAddress;
  let merchant2: SignerWithAddress;
  let relayer: SignerWithAddress;
  let attacker: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let integrator: any;
  let erc721Client: any;

  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
  const UNIT_PRICE = USDC(10);
  const PRODUCT_ID = 1;
  const INR = ethers.encodeBytes32String("INR");
  const enc = (l: string) => ethers.keccak256(ethers.toUtf8Bytes("enc-payout:" + l));
  const PK = "04" + "ab".repeat(64);
  const CONFIG = ethers.hexlify(ethers.toUtf8Bytes("cfg"));

  let LINK: string;
  let LINK2: string;

  const selectorOf = (sig: string) => ethers.id(sig).slice(0, 10);

  /** Asserts the inner revert of a call the proxy wrapped in CallFailed(bytes). */
  async function expectCallFailedWith(txPromise: Promise<any>, errorSig: string) {
    const proxyArtifact = await ethers.getContractFactory("UserProxy");
    await expect(txPromise)
      .to.be.revertedWithCustomError(proxyArtifact, "CallFailed")
      .withArgs(selectorOf(errorSig));
  }

  beforeEach(async function () {
    [owner, merchant1, merchant2, relayer, attacker] = await ethers.getSigners();

    mockUsdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    mockDiamond = await (
      await ethers.getContractFactory("MockDiamond")
    ).deploy(await mockUsdc.getAddress());

    const Integrator = await ethers.getContractFactory("MerchantTerminalIntegrator", {
      libraries: { PaymentLinksLib: await deployPaymentLinksLib() },
    });
    integrator = await Integrator.deploy(
      await mockDiamond.getAddress(),
      await mockUsdc.getAddress(),
      []
    );

    erc721Client = await (
      await ethers.getContractFactory("SimpleERC721Client")
    ).deploy(await integrator.getAddress(), await mockUsdc.getAddress(), "Item", "ITEM");

    await mockDiamond.registerIntegrator(
      await integrator.getAddress(),
      await integrator.proxyImpl()
    );
    await erc721Client.setProductPrice(PRODUCT_ID, UNIT_PRICE);
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(100000));

    await integrator.connect(merchant1).registerMerchant(enc("m1"), "Ramesh Sarees", "INR");
    await integrator.connect(merchant2).registerMerchant(enc("m2"), "Other Shop", "INR");
    await integrator.setTrustedRelayer(relayer.address);

    const lib = await ethers.getContractAt("PaymentLinksLib", await deployPaymentLinksLib());
    LINK = await lib.computeLinkId(merchant1.address, ethers.id("salt-1"));
    LINK2 = await lib.computeLinkId(merchant1.address, ethers.id("salt-2"));
  });

  const mkLink = (id: string, qty: number, maxUses = 1, as = merchant1) =>
    integrator.connect(as).createLink(id, UNIT_PRICE * BigInt(qty), INR, 0, maxUses, CONFIG);

  const mkVariableLink = (id: string, maxUses = 0, as = merchant1) =>
    integrator.connect(as).createLink(id, 0, INR, 0, maxUses, CONFIG);

  const payLink = (id: string, qty: number) =>
    integrator
      .connect(relayer)
      .relayerPlaceOrder(id, erc721Client.target, PRODUCT_ID, qty, INR, 0, PK);

  /** An LP takes the order. On the real Diamond nothing can reach PAID until
   *  this has happened — there is no one to have sent fiat to before it. */
  const accept = (orderId: bigint) => mockDiamond.simulateOrderAccepted(orderId);

  async function lastOrderId(): Promise<bigint> {
    const evs = await integrator.queryFilter(integrator.filters.LinkOrderPlaced());
    return evs[evs.length - 1].args[1];
  }

  // ─── The blocker ──────────────────────────────────────────────────

  describe("order.user", function () {
    it("is the merchant's PROXY, not the merchant — otherwise nobody could ever mark it paid", async function () {
      await mkLink(LINK, 1);
      await payLink(LINK, 1);
      const orderId = await lastOrderId();

      const stored = await mockDiamond.orders(orderId);
      const proxy = await integrator.proxyAddress(merchant1.address);

      expect(stored.user).to.equal(proxy);
      expect(stored.user).to.not.equal(merchant1.address);
      // recipientAddr is the proxy too — that part was always true.
      expect(stored.recipientAddr).to.equal(proxy);
    });

    it("stays the MERCHANT for a POS sale, so the shipped widget keeps working", async function () {
      await integrator
        .connect(merchant1)
        .userPlaceOrder(erc721Client.target, PRODUCT_ID, 1, INR, 0, PK);

      const evs = await integrator.queryFilter(integrator.filters.OrderPlaced());
      const orderId = evs[evs.length - 1].args[0];
      const stored = await mockDiamond.orders(orderId);

      expect(stored.user).to.equal(merchant1.address);
      // The merchant's own signer can therefore still mark it paid directly,
      // once an LP has accepted it.
      await accept(orderId);
      await expect(mockDiamond.connect(merchant1).paidBuyOrder(orderId)).to.not.be.reverted;
    });

    it("the relayer calling the Diamond directly is refused — this is the bug, reproduced", async function () {
      await mkLink(LINK, 1);
      await payLink(LINK, 1);
      const orderId = await lastOrderId();

      // Exactly what worker/src/relayTx.ts used to forward: paidBuyOrder signed
      // by the relayer EOA. The Diamond wants order.user and gets the relayer.
      await expect(
        mockDiamond.connect(relayer).paidBuyOrder(orderId)
      ).to.be.revertedWithCustomError(mockDiamond, "NotAuthorized");

      // Nor can anyone else who is merely adjacent to the order.
      await expect(
        mockDiamond.connect(merchant1).paidBuyOrder(orderId)
      ).to.be.revertedWithCustomError(mockDiamond, "NotAuthorized");
      await expect(
        mockDiamond.connect(attacker).paidBuyOrder(orderId)
      ).to.be.revertedWithCustomError(mockDiamond, "NotAuthorized");
    });
  });

  describe("relayerMarkPaid", function () {
    it("advances a link order to PAID, and the merchant is credited on completion", async function () {
      await mkLink(LINK, 1);
      await payLink(LINK, 1);
      const orderId = await lastOrderId();
      await accept(orderId);

      await expect(integrator.connect(relayer).relayerMarkPaid(LINK, orderId))
        .to.emit(integrator, "LinkOrderPaid")
        .withArgs(LINK, orderId);

      expect((await mockDiamond.orders(orderId)).paid).to.equal(true);

      // The LP then settles. This is the step that was unreachable before.
      await mockDiamond.simulateOrderComplete(orderId);
      const bal = await integrator.getMerchantBalance(merchant1.address);
      expect(bal.totalDeposited).to.equal(UNIT_PRICE);
    });

    it("is relayer-only", async function () {
      await mkLink(LINK, 1);
      await payLink(LINK, 1);
      const orderId = await lastOrderId();

      for (const who of [merchant1, attacker, owner]) {
        await expect(
          integrator.connect(who).relayerMarkPaid(LINK, orderId)
        ).to.be.revertedWithCustomError(integrator, "OnlyTrustedRelayer");
      }
    });

    it("refuses an order that did not come from the link it names", async function () {
      await mkLink(LINK, 1);
      await mkLink(LINK2, 1);
      await payLink(LINK, 1);
      const orderId = await lastOrderId();

      await expect(
        integrator.connect(relayer).relayerMarkPaid(LINK2, orderId)
      ).to.be.revertedWithCustomError(integrator, "LinkNotFound");
    });

    it("refuses a POS order — the relayer has no reach into counter sales", async function () {
      await integrator
        .connect(merchant1)
        .userPlaceOrder(erc721Client.target, PRODUCT_ID, 1, INR, 0, PK);
      const evs = await integrator.queryFilter(integrator.filters.OrderPlaced());
      const orderId = evs[evs.length - 1].args[0];

      await expect(
        integrator.connect(relayer).relayerMarkPaid(LINK, orderId)
      ).to.be.revertedWithCustomError(integrator, "LinkNotFound");
    });

    it("keeps working when link orders are halted — the customer already paid", async function () {
      // The kill switch stops NEW activity. A customer whose bank transfer has
      // already left cannot un-send it, so refusing them here would strand real
      // money with the LP and no one present to explain.
      await mkLink(LINK, 1);
      await payLink(LINK, 1);
      const orderId = await lastOrderId();
      await accept(orderId);

      await integrator.setLinkOrdersEnabled(false);
      await expect(integrator.connect(relayer).relayerMarkPaid(LINK, orderId)).to.emit(
        integrator,
        "LinkOrderPaid"
      );
    });

    it("but CANCEL is stopped by it — that is the direction a stolen key abuses", async function () {
      await mkLink(LINK, 1);
      await payLink(LINK, 1);
      const orderId = await lastOrderId();

      await integrator.setLinkOrdersEnabled(false);
      await expect(
        integrator.connect(relayer).relayerCancelOrder(LINK, orderId)
      ).to.be.revertedWithCustomError(integrator, "LinkOrdersDisabled");
    });
  });

  describe("relayerCancelOrder", function () {
    it("cancels through the proxy and gives the daily slot and the link use back", async function () {
      await mkLink(LINK, 1, 2);
      await payLink(LINK, 1);
      const orderId = await lastOrderId();
      expect((await integrator.getLink(LINK))[6]).to.equal(1); // uses

      await expect(integrator.connect(relayer).relayerCancelOrder(LINK, orderId))
        .to.emit(integrator, "LinkOrderCancelled")
        .withArgs(LINK, orderId);

      expect((await integrator.getLink(LINK))[6]).to.equal(0); // use released
      expect((await integrator.getDailyTxInfo(merchant1.address)).usedToday).to.equal(0);
    });

    it("is relayer-only", async function () {
      await mkLink(LINK, 1);
      await payLink(LINK, 1);
      const orderId = await lastOrderId();
      await expect(
        integrator.connect(attacker).relayerCancelOrder(LINK, orderId)
      ).to.be.revertedWithCustomError(integrator, "OnlyTrustedRelayer");
    });
  });

  // ─── The limits must survive the order.user change ────────────────

  describe("limits still apply to link orders", function () {
    it("enforces the per-tx cap — the SELL carve-out must NOT swallow link orders", async function () {
      // A VARIABLE link (amount 0) is bounded at pay time, not creation — so
      // this is the path that proves validateOrder still sees link orders.
      // INR cap is 50 USDC; 6 x 10 = 60.
      await mkVariableLink(LINK, 0);
      await expectCallFailedWith(payLink(LINK, 6), "ExceedsPerTxCap()");
    });

    it("enforces the daily transaction count", async function () {
      await mkLink(LINK, 1, 0);
      for (let i = 0; i < 25; i++) await payLink(LINK, 1);
      await expectCallFailedWith(payLink(LINK, 1), "DailyLimitReached()");
    });

    it("refuses a frozen merchant at pay time", async function () {
      await mkLink(LINK, 1, 0);
      await integrator.freezeMerchant(merchant1.address);
      await expectCallFailedWith(payLink(LINK, 1), "MerchantIsFrozen()");
    });

    it("still lets the merchant's own fiat withdrawal through the carve-out", async function () {
      // Proves narrowing the carve-out to `_sellPlacement` did not break SELL.
      await mkLink(LINK, 1, 0);
      await payLink(LINK, 1);
      await mockDiamond.simulateOrderComplete(await lastOrderId());
      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        integrator.connect(merchant1).withdrawFiat(UNIT_PRICE, 1, PK, enc("payout"))
      ).to.emit(integrator, "WithdrawalFiat");
    });
  });

  // ─── Multi-use links ──────────────────────────────────────────────

  describe("maxUses", function () {
    it("takes exactly three payments on a three-use link, then refuses", async function () {
      await mkLink(LINK, 1, 3);

      for (let i = 0; i < 3; i++) {
        await payLink(LINK, 1);
        await mockDiamond.simulateOrderComplete(await lastOrderId());
      }
      expect((await integrator.getLink(LINK))[6]).to.equal(3);

      await expect(payLink(LINK, 1)).to.be.revertedWithCustomError(integrator, "LinkAlreadyUsed");
      expect(await integrator.isLinkActive(LINK)).to.equal(false);
    });

    it("treats maxUses == 0 as unlimited", async function () {
      await mkLink(LINK, 1, 0);
      for (let i = 0; i < 5; i++) {
        await payLink(LINK, 1);
        await mockDiamond.simulateOrderComplete(await lastOrderId());
      }
      expect(await integrator.isLinkActive(LINK)).to.equal(true);
    });

    it("an abandoned checkout does not consume a use", async function () {
      await mkLink(LINK, 1, 1);
      await payLink(LINK, 1);
      const orderId = await lastOrderId();

      // Customer walks away; the order expires and the Diamond cancels it.
      await mockDiamond.simulateOrderCancelled(orderId);

      expect((await integrator.getLink(LINK))[6]).to.equal(0);
      expect(await integrator.isLinkActive(LINK)).to.equal(true);
      await expect(payLink(LINK, 1)).to.not.be.reverted;
    });
  });

  // ─── False "I have paid" claims ───────────────────────────────────

  describe("strikes", function () {
    it("records a strike when a marked-paid order is later cancelled", async function () {
      await mkLink(LINK, 1, 3);
      await payLink(LINK, 1);
      const orderId = await lastOrderId();

      await accept(orderId);
      await integrator.connect(relayer).relayerMarkPaid(LINK, orderId);
      expect((await integrator.getLink(LINK))[7]).to.equal(1); // provisional

      // The claim was false, so the order never settles and the keeper cancels
      // it at TTL. That gateway-side cancel is the real strike source — the
      // relayer cannot cancel a PAID order on the live Diamond.
      await mockDiamond.simulateOrderCancelled(orderId);
      expect((await integrator.getLink(LINK))[7]).to.equal(1); // stands: claim was false
    });

    it("clears the strike when the claim proves true", async function () {
      await mkLink(LINK, 1, 3);
      await payLink(LINK, 1);
      const orderId = await lastOrderId();

      await accept(orderId);
      await integrator.connect(relayer).relayerMarkPaid(LINK, orderId);
      await mockDiamond.simulateOrderComplete(orderId);
      expect((await integrator.getLink(LINK))[7]).to.equal(0);
    });

    it("does NOT block the link — that would let anyone kill a merchant's link", async function () {
      await mkLink(LINK, 1, 0);
      for (let i = 0; i < 3; i++) {
        await payLink(LINK, 1);
        const id = await lastOrderId();
        await accept(id);
        await integrator.connect(relayer).relayerMarkPaid(LINK, id);
        await mockDiamond.simulateOrderCancelled(id);
      }
      expect((await integrator.getLink(LINK))[7]).to.equal(3);
      // Still payable: throttling the CLAIMANT is the relayer service's job,
      // because only it can see an IP. Freezing the link would punish the
      // merchant for what an anonymous stranger did.
      expect(await integrator.isLinkActive(LINK)).to.equal(true);
    });

    it("lets the owner or an admin reset strikes, but nobody else", async function () {
      await mkLink(LINK, 1, 0);
      await payLink(LINK, 1);
      const orderId = await lastOrderId();
      await accept(orderId);
      await integrator.connect(relayer).relayerMarkPaid(LINK, orderId);
      await mockDiamond.simulateOrderCancelled(orderId);

      await expect(
        integrator.connect(attacker).resetLinkStrikes(LINK)
      ).to.be.revertedWithCustomError(integrator, "NotLinkOwner");

      await expect(integrator.connect(merchant1).resetLinkStrikes(LINK))
        .to.emit(integrator, "LinkStrikesReset")
        .withArgs(LINK, 1);
      expect((await integrator.getLink(LINK))[7]).to.equal(0);
    });
  });

  // ─── Link ids cannot be squatted ──────────────────────────────────

  describe("computeLinkId", function () {
    it("binds the id to the merchant, so an observer cannot front-run creation", async function () {
      const lib = await ethers.getContractAt("PaymentLinksLib", await deployPaymentLinksLib());
      const salt = ethers.id("same-salt");
      const forM1 = await lib.computeLinkId(merchant1.address, salt);
      const forAttacker = await lib.computeLinkId(attacker.address, salt);

      expect(forM1).to.not.equal(forAttacker);
      // The attacker cannot produce merchant1's id even knowing the salt.
      await expect(mkLink(forM1, 1, 1, merchant1)).to.emit(integrator, "LinkCreated");
    });
  });
});
