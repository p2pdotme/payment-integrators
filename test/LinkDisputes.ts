import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const SECTOR = ethers.encodeBytes32String("Retail");

async function deployMerchantTerminalLibs(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of [
    "PaymentLinksLib",
    "MerchantRegistryLib",
    "SettlementLib",
    "MerchantImportLib",
  ]) {
    const c = await (await ethers.getContractFactory(name)).deploy();
    await c.waitForDeployment();
    out[name] = await c.getAddress();
  }
  return out;
}

/**
 * Disputes on payment-link orders.
 *
 * WHY THIS EXISTS
 * The Diamond accepts `raiseDispute` only from `order.user`, and a link order's
 * `order.user` is the merchant's proxy — which has no key. Before this change
 * nobody could dispute a link order on-chain: not the customer, not the
 * merchant. Now:
 *
 *   - the CUSTOMER disputes through the Router, with their own EIP-712
 *     signature over (link, order, last 4 digits), sent by the link wallet;
 *   - the MERCHANT disputes their own link order directly on the integrator.
 *
 * Both reach the Diamond as the merchant's proxy. The Diamond keeps every rule
 * of its own (cancelled after being marked paid, 15 min to 24 h, once), and
 * the MockDiamond models them so the tests below prove they still bind.
 */
describe("Link-order disputes", function () {
  let owner: SignerWithAddress;
  let merchant1: SignerWithAddress;
  let merchant2: SignerWithAddress;
  let agent1: SignerWithAddress;
  let agent2: SignerWithAddress;
  let customer: SignerWithAddress;
  let attacker: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let integrator: any;
  let router: any;
  let erc721Client: any;
  let proxy1: any; // merchant1's UserProxy, for its CallFailed error

  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
  const UNIT_PRICE = USDC(10);
  const PRODUCT_ID = 1;
  const INR = ethers.encodeBytes32String("INR");
  const enc = (l: string) => ethers.keccak256(ethers.toUtf8Bytes("enc-payout:" + l));
  const PK = "04" + "ab".repeat(64);
  const CONFIG = ethers.hexlify(ethers.toUtf8Bytes("cfg"));
  const LAST4 = 4821n;
  /** The merchant's own dispute opens 6 h after placement (the customer goes first). */
  const MERCHANT_DELAY = 6 * 3600;

  let LINK: string;
  let LINK2: string;
  let LINK_M2: string;

  beforeEach(async function () {
    [owner, merchant1, merchant2, agent1, agent2, customer, attacker] = await ethers.getSigners();

    mockUsdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    mockDiamond = await (
      await ethers.getContractFactory("MockDiamond")
    ).deploy(await mockUsdc.getAddress());

    const libs = await deployMerchantTerminalLibs();
    integrator = await (
      await ethers.getContractFactory("MerchantTerminalIntegrator", { libraries: libs })
    ).deploy(await mockDiamond.getAddress(), await mockUsdc.getAddress(), []);

    erc721Client = await (
      await ethers.getContractFactory("SimpleERC721Client")
    ).deploy(await integrator.getAddress(), await mockUsdc.getAddress(), "Item", "ITEM");

    await mockDiamond.registerIntegrator(
      await integrator.getAddress(),
      await integrator.proxyImpl()
    );
    await erc721Client.setProductPrice(PRODUCT_ID, UNIT_PRICE);
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(100000));

    await integrator.connect(merchant1).registerMerchant(enc("m1"), "Ramesh Sarees", "INR", SECTOR);
    await integrator.connect(merchant2).registerMerchant(enc("m2"), "Other Shop", "INR", SECTOR);

    router = await (
      await ethers.getContractFactory("LinkRouter")
    ).deploy(await integrator.getAddress());
    await integrator.setTrustedRelayer(await router.getAddress());

    const lib = await ethers.getContractAt("PaymentLinksLib", libs.PaymentLinksLib);
    LINK = await lib.computeLinkId(merchant1.address, ethers.id("salt-1"));
    LINK2 = await lib.computeLinkId(merchant1.address, ethers.id("salt-2"));
    LINK_M2 = await lib.computeLinkId(merchant2.address, ethers.id("salt-1"));
  });

  // ─── Helpers ──────────────────────────────────────────────────────

  const mkLink = (id: string, as = merchant1) =>
    integrator.connect(as).createLink(id, UNIT_PRICE, INR, 0, 0, CONFIG);

  const register = (id: string, agent: SignerWithAddress, as = merchant1) =>
    router.connect(as).registerAgent(id, agent.address);

  async function domain(on: any = router) {
    return {
      name: "P2P LinkRouter",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await on.getAddress(),
    };
  }

  const ORDER_TYPES = [
    { name: "linkId", type: "bytes32" },
    { name: "orderId", type: "uint256" },
  ];
  const DISPUTE_TYPES = {
    Dispute: [...ORDER_TYPES, { name: "redactTransId", type: "uint256" }],
  };

  /** The customer's dispute signature, as the pay page makes it (lib/paymentLinks.ts). */
  async function disputeSig(
    id: string,
    orderId: bigint,
    last4 = LAST4,
    who = customer,
    on: any = router
  ) {
    return who.signTypedData(await domain(on), DISPUTE_TYPES, {
      linkId: id,
      orderId,
      redactTransId: last4,
    });
  }

  async function sig(action: "MarkPaid" | "Cancel", id: string, orderId: bigint, who = customer) {
    return who.signTypedData(await domain(), { [action]: ORDER_TYPES }, { linkId: id, orderId });
  }

  async function lastOrderId(): Promise<bigint> {
    const evs = await router.queryFilter(router.filters.OrderPlaced());
    return evs[evs.length - 1].args[1];
  }

  /** Place on `id`, LP accepts, customer marks paid. */
  async function paidOrder(id = LINK, agent = agent1): Promise<bigint> {
    await router
      .connect(agent)
      .place(id, erc721Client.target, PRODUCT_ID, 1, INR, 0, PK, customer.address);
    const orderId = await lastOrderId();
    await mockDiamond.simulateOrderAccepted(orderId);
    await router.connect(agent).markPaid(id, orderId, await sig("MarkPaid", id, orderId));
    return orderId;
  }

  /**
   * The case a dispute is for: the customer paid and marked it, but the order
   * was cancelled anyway (the LP said no money arrived), and 15 minutes have
   * passed since placement.
   */
  async function cancelledAfterPaying(id = LINK, agent = agent1): Promise<bigint> {
    const orderId = await paidOrder(id, agent);
    await mockDiamond.simulateOrderCancelled(orderId);
    await time.increase(15 * 60);
    return orderId;
  }

  async function proxyOf(m: SignerWithAddress) {
    return ethers.getContractAt("UserProxy", await integrator.proxyAddress(m.address));
  }

  beforeEach(async function () {
    await mkLink(LINK);
    await register(LINK, agent1);
    proxy1 = await proxyOf(merchant1);
  });

  // ─── The customer's dispute, through the Router ───────────────────

  describe("the customer disputes through the Router", function () {
    it("files the dispute on the Diamond as the merchant's proxy, with the last 4 digits", async function () {
      const orderId = await cancelledAfterPaying();

      await expect(
        router.connect(agent1).dispute(LINK, orderId, LAST4, await disputeSig(LINK, orderId))
      )
        .to.emit(router, "OrderDisputed")
        .withArgs(LINK, orderId)
        .and.to.emit(mockDiamond, "MockDisputeRaised")
        .withArgs(orderId, await integrator.proxyAddress(merchant1.address), LAST4);

      const o = await mockDiamond.getOrdersById(orderId);
      expect(o.disputeInfo.status).to.equal(1); // raised (raisedBy stays 0 = USER)
      expect(o.disputeInfo.raisedBy).to.equal(0);
      expect(o.disputeInfo.redactTransId).to.equal(LAST4);
    });

    it("the digest is the one the pay page signs (disputeDigest == EIP-712 typed data)", async function () {
      const orderId = await cancelledAfterPaying();
      const expected = ethers.TypedDataEncoder.hash(await domain(), DISPUTE_TYPES, {
        linkId: LINK,
        orderId,
        redactTransId: LAST4,
      });
      expect(await router.disputeDigest(LINK, orderId, LAST4)).to.equal(expected);
      expect(await router.disputeDigest(LINK, orderId, LAST4)).to.not.equal(
        await router.cancelDigest(LINK, orderId)
      );
    });

    it("works while paused and with link orders switched off — it protects a customer who paid", async function () {
      const orderId = await cancelledAfterPaying();
      await integrator.pause();
      await integrator.setLinkOrdersEnabled(false);
      await router.connect(agent1).dispute(LINK, orderId, LAST4, await disputeSig(LINK, orderId));
      expect((await mockDiamond.getOrdersById(orderId)).disputeInfo.status).to.equal(1);
    });
  });

  // ─── Who may file it ──────────────────────────────────────────────

  describe("only the order's own customer can authorise it", function () {
    it("refuses a signature from anyone else, including the link wallet itself", async function () {
      const orderId = await cancelledAfterPaying();
      for (const who of [attacker, agent1, merchant1]) {
        await expect(
          router
            .connect(agent1)
            .dispute(LINK, orderId, LAST4, await disputeSig(LINK, orderId, LAST4, who))
        ).to.be.revertedWithCustomError(router, "BadCustomerSignature");
      }
    });

    it("binds the last 4 digits: the link wallet cannot file different ones", async function () {
      const orderId = await cancelledAfterPaying();
      await expect(
        router.connect(agent1).dispute(LINK, orderId, 1111n, await disputeSig(LINK, orderId, LAST4))
      ).to.be.revertedWithCustomError(router, "BadCustomerSignature");
    });

    it("a mark-paid or cancel signature cannot be replayed as a dispute", async function () {
      const orderId = await cancelledAfterPaying();
      for (const action of ["MarkPaid", "Cancel"] as const) {
        await expect(
          router.connect(agent1).dispute(LINK, orderId, LAST4, await sig(action, LINK, orderId))
        ).to.be.revertedWithCustomError(router, "BadCustomerSignature");
      }
    });

    it("a dispute signature for another Router is refused", async function () {
      const orderId = await cancelledAfterPaying();
      const other = await (
        await ethers.getContractFactory("LinkRouter")
      ).deploy(await integrator.getAddress());
      await expect(
        router
          .connect(agent1)
          .dispute(LINK, orderId, LAST4, await disputeSig(LINK, orderId, LAST4, customer, other))
      ).to.be.revertedWithCustomError(router, "BadCustomerSignature");
    });

    it("only this link's wallet can send it, and only for this link's orders", async function () {
      const orderId = await cancelledAfterPaying();
      const s = await disputeSig(LINK, orderId);
      await expect(
        router.connect(attacker).dispute(LINK, orderId, LAST4, s)
      ).to.be.revertedWithCustomError(router, "NotLinkAgent");

      await mkLink(LINK2);
      await register(LINK2, agent2);
      await expect(
        router.connect(agent2).dispute(LINK2, orderId, LAST4, await disputeSig(LINK2, orderId))
      ).to.be.revertedWithCustomError(router, "OrderLinkMismatch");
      await expect(
        router.connect(agent1).dispute(LINK, 999n, LAST4, await disputeSig(LINK, 999n))
      ).to.be.revertedWithCustomError(router, "UnknownOrder");
    });

    it("nobody but the Router can call the integrator's relayer entry point", async function () {
      const orderId = await cancelledAfterPaying();
      for (const who of [attacker, merchant1, agent1]) {
        await expect(
          integrator.connect(who).relayerRaiseDispute(LINK, orderId, LAST4)
        ).to.be.revertedWithCustomError(integrator, "OnlyTrustedRelayer");
      }
    });

    it("the relayer entry point refuses a link that does not exist", async function () {
      await integrator.setTrustedRelayer(owner.address);
      await expect(
        integrator.relayerRaiseDispute(ethers.id("no-such-link"), 1n, LAST4)
      ).to.be.revertedWithCustomError(integrator, "LinkNotFound");
    });
  });

  // ─── The Diamond's own rules still bind ───────────────────────────

  describe("the Diamond's rules still decide when a dispute is allowed", function () {
    it("not before 15 minutes after placement", async function () {
      const orderId = await paidOrder();
      await mockDiamond.simulateOrderCancelled(orderId);
      await expect(
        router.connect(agent1).dispute(LINK, orderId, LAST4, await disputeSig(LINK, orderId))
      ).to.be.revertedWithCustomError(proxy1, "CallFailed");
    });

    it("not after 24 hours", async function () {
      const orderId = await cancelledAfterPaying();
      await time.increase(24 * 3600);
      await expect(
        router.connect(agent1).dispute(LINK, orderId, LAST4, await disputeSig(LINK, orderId))
      ).to.be.revertedWithCustomError(proxy1, "CallFailed");
    });

    it("not on an order that was never marked paid, nor one still open", async function () {
      await router
        .connect(agent1)
        .place(LINK, erc721Client.target, PRODUCT_ID, 1, INR, 0, PK, customer.address);
      const unpaid = await lastOrderId();
      await mockDiamond.simulateOrderCancelled(unpaid);
      const open = await paidOrder();
      await time.increase(15 * 60);
      for (const orderId of [unpaid, open]) {
        await expect(
          router.connect(agent1).dispute(LINK, orderId, LAST4, await disputeSig(LINK, orderId))
        ).to.be.revertedWithCustomError(proxy1, "CallFailed");
      }
    });

    it("only once: the same signature cannot be replayed", async function () {
      const orderId = await cancelledAfterPaying();
      const s = await disputeSig(LINK, orderId);
      await router.connect(agent1).dispute(LINK, orderId, LAST4, s);
      await expect(
        router.connect(agent1).dispute(LINK, orderId, LAST4, s)
      ).to.be.revertedWithCustomError(proxy1, "CallFailed");
    });
  });

  // ─── The merchant's own dispute ───────────────────────────────────

  describe("the merchant disputes their own link order", function () {
    it("files it through their proxy, from 6 hours after placement", async function () {
      const orderId = await cancelledAfterPaying();
      await time.increase(MERCHANT_DELAY);
      await expect(integrator.connect(merchant1).raiseLinkDispute(orderId, LAST4))
        .to.emit(mockDiamond, "MockDisputeRaised")
        .withArgs(orderId, await integrator.proxyAddress(merchant1.address), LAST4);
    });

    it("not before 6 hours: the customer gets the first chance (review #118, 2)", async function () {
      const orderId = await cancelledAfterPaying(); // 15 min after placement
      await expect(
        integrator.connect(merchant1).raiseLinkDispute(orderId, 1111n)
      ).to.be.revertedWithCustomError(integrator, "DisputeTooEarly");
      // The customer can file in that time, with their own digits.
      await router.connect(agent1).dispute(LINK, orderId, LAST4, await disputeSig(LINK, orderId));
      expect((await mockDiamond.getOrdersById(orderId)).disputeInfo.redactTransId).to.equal(LAST4);
      // Later the merchant cannot replace it: the Diamond takes one dispute per order.
      await time.increase(MERCHANT_DELAY);
      await expect(integrator.connect(merchant1).raiseLinkDispute(orderId, 1111n)).to.be.reverted;
      expect((await mockDiamond.getOrdersById(orderId)).disputeInfo.redactTransId).to.equal(LAST4);
    });

    it("cannot dispute another merchant's order: the Diamond refuses their proxy", async function () {
      const orderId = await cancelledAfterPaying();
      await time.increase(MERCHANT_DELAY);
      // Without a proxy at all (never sold anything), the call has nothing to reach.
      await expect(integrator.connect(attacker).raiseLinkDispute(orderId, LAST4)).to.be.reverted;
      await expect(integrator.connect(merchant2).raiseLinkDispute(orderId, LAST4)).to.be.reverted;

      // With a real proxy of their own, it is the Diamond that says no.
      await mkLink(LINK_M2, merchant2);
      await register(LINK_M2, agent2, merchant2);
      await router
        .connect(agent2)
        .place(LINK_M2, erc721Client.target, PRODUCT_ID, 1, INR, 0, PK, customer.address);
      const proxy2 = await proxyOf(merchant2);
      const diamondErr = mockDiamond.interface.encodeErrorResult("NotAuthorized", []);
      await expect(integrator.connect(merchant2).raiseLinkDispute(orderId, LAST4))
        .to.be.revertedWithCustomError(proxy2, "CallFailed")
        .withArgs(diamondErr);
    });

    it("a frozen merchant cannot", async function () {
      const orderId = await cancelledAfterPaying();
      await integrator.freezeMerchant(merchant1.address);
      await expect(
        integrator.connect(merchant1).raiseLinkDispute(orderId, LAST4)
      ).to.be.revertedWithCustomError(integrator, "MerchantIsFrozen");
    });

    it("a dispute on one merchant's link never reaches another merchant's proxy", async function () {
      // merchant2's link and order: merchant1's link wallet cannot touch it.
      await mkLink(LINK_M2, merchant2);
      await register(LINK_M2, agent2, merchant2);
      const orderId = await cancelledAfterPaying(LINK_M2, agent2);
      await expect(
        router.connect(agent1).dispute(LINK, orderId, LAST4, await disputeSig(LINK, orderId))
      ).to.be.revertedWithCustomError(router, "OrderLinkMismatch");
      await router
        .connect(agent2)
        .dispute(LINK_M2, orderId, LAST4, await disputeSig(LINK_M2, orderId));
      expect((await mockDiamond.getOrdersById(orderId)).disputeInfo.status).to.equal(1);
    });
  });

  // ─── Review #118, finding 1: link orders only ────────────────────

  describe("a fiat withdrawal cannot be disputed through this contract", function () {
    it("refuses the merchant's own withdrawal, though their proxy owns it too", async function () {
      // A balance to withdraw: a counter sale, settled and past the 10 min lock.
      await integrator
        .connect(merchant1)
        .userPlaceOrder(erc721Client.target, PRODUCT_ID, 3, INR, 1, "");
      const sale = (await integrator.queryFilter(integrator.filters.OrderPlaced())).at(-1)!.args
        .orderId;
      await mockDiamond.simulateOrderComplete(sale);
      await time.increase(11 * 60);

      const rcpt = await (
        await integrator.connect(merchant1).withdrawFiat(USDC(5), 1, PK, "")
      ).wait();
      const w = rcpt.logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((l: any) => l?.name === "WithdrawalFiat");
      const withdrawalId = w.args.orderId;
      // Its order.user IS the merchant's proxy, so without the guard the Diamond
      // would take the dispute, and a won one strands the refund on the proxy.
      expect((await mockDiamond.getOrdersById(withdrawalId)).user).to.equal(
        await integrator.proxyAddress(merchant1.address)
      );
      await time.increase(MERCHANT_DELAY);
      await expect(
        integrator.connect(merchant1).raiseLinkDispute(withdrawalId, LAST4)
      ).to.be.revertedWithCustomError(integrator, "NotALinkOrder");
    });
  });

  // ─── Review #118, finding 3: the link's records ──────────────────

  describe("a paid-then-cancelled order keeps its link use until it cannot come back", function () {
    let ONE: string;
    beforeEach(async function () {
      ONE = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "bytes32"],
          [merchant1.address, ethers.id("single-use")]
        )
      );
      await integrator.connect(merchant1).createLink(ONE, UNIT_PRICE, INR, 0, 1, CONFIG);
      await register(ONE, agent2);
    });
    const uses = async () => (await integrator.getLink(ONE)).uses;
    const strikes = async () => (await integrator.getLink(ONE)).strikes;
    const placeOne = () =>
      router
        .connect(agent2)
        .place(ONE, erc721Client.target, PRODUCT_ID, 1, INR, 0, PK, customer.address);

    it("a single-use link cannot be paid twice while a dispute is possible", async function () {
      await cancelledAfterPaying(ONE, agent2);
      expect(await uses()).to.equal(1);
      await expect(placeOne()).to.be.revertedWithCustomError(integrator, "LinkAlreadyUsed");
    });

    it("a won dispute completes it: use stays counted, strike cleared, merchant paid", async function () {
      const orderId = await cancelledAfterPaying(ONE, agent2);
      expect(await strikes()).to.equal(1);
      await router.connect(agent2).dispute(ONE, orderId, LAST4, await disputeSig(ONE, orderId));
      await mockDiamond.simulateDisputeSettled(orderId); // merchant fault, so…
      await mockDiamond.simulateOrderComplete(orderId); // …the order reopens and completes
      expect(await uses()).to.equal(1);
      expect(await strikes()).to.equal(0);
      expect((await integrator.getMerchantBalance(merchant1.address)).totalDeposited).to.equal(
        UNIT_PRICE
      );
      await expect(integrator.releaseLinkClaim(orderId)).to.be.revertedWithCustomError(
        integrator,
        "LinkNotFound"
      );
    });

    it("no dispute: after the 24 h window anyone can give the use back (the strike stays)", async function () {
      const orderId = await cancelledAfterPaying(ONE, agent2);
      await expect(
        integrator.connect(attacker).releaseLinkClaim(orderId)
      ).to.be.revertedWithCustomError(integrator, "ClaimStillDisputable");
      await time.increase(24 * 3600);
      await integrator.connect(attacker).releaseLinkClaim(orderId);
      expect(await uses()).to.equal(0);
      expect(await strikes()).to.equal(1); // a claim that never came true
      await placeOne(); // the link takes a new payment
      await expect(integrator.releaseLinkClaim(orderId)).to.be.revertedWithCustomError(
        integrator,
        "LinkNotFound"
      );
    });

    it("an open dispute holds it past 24 h; a lost one lets it go", async function () {
      const orderId = await cancelledAfterPaying(ONE, agent2);
      await router.connect(agent2).dispute(ONE, orderId, LAST4, await disputeSig(ONE, orderId));
      await time.increase(24 * 3600);
      await expect(integrator.releaseLinkClaim(orderId)).to.be.revertedWithCustomError(
        integrator,
        "ClaimStillDisputable"
      );
      await mockDiamond.simulateDisputeSettled(orderId); // user fault: stays cancelled
      await integrator.releaseLinkClaim(orderId);
      expect(await uses()).to.equal(0);
    });

    it("an order still in flight cannot be released", async function () {
      const orderId = await paidOrder(ONE, agent2);
      await time.increase(24 * 3600);
      await expect(integrator.releaseLinkClaim(orderId)).to.be.revertedWithCustomError(
        integrator,
        "ClaimStillDisputable"
      );
    });

    it("an order the customer never marked paid still frees its use at once", async function () {
      await placeOne();
      const orderId = await lastOrderId();
      await mockDiamond.simulateOrderCancelled(orderId);
      expect(await uses()).to.equal(0);
      await placeOne();
    });
  });

  // ─── Size ─────────────────────────────────────────────────────────

  describe("the integrator stays deployable", function () {
    it("keeps at least 200 bytes under the EIP-170 limit", async function () {
      // Under `hardhat coverage` the artifact is instrumented (a counter in every
      // branch, about 3x the size), so its size says nothing about what deploys.
      if ((hre as any).__SOLIDITY_COVERAGE_RUNNING) this.skip();
      const art = require("../artifacts/contracts/integrators/merchant-terminal/MerchantTerminalIntegrator.sol/MerchantTerminalIntegrator.json");
      const size = (art.deployedBytecode.length - 2) / 2;
      expect(size).to.be.at.most(24576 - 200);
    });
  });
});
