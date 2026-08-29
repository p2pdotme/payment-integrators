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
 * LinkRouter — the relayer wallet, removed.
 *
 * WHAT THIS SUITE IS PROVING
 * The review rejected both a single funded relayer key and a pool of them, for
 * the same reason: a funded key sits on the payment path, and limits only
 * reduce the damage of losing it. The Router removes it by making the signer
 * worthless — each link is driven by its own account-abstraction wallet that
 * holds nothing, whose gas a paymaster pays.
 *
 * Two properties carry the whole design, and both are asserted here rather than
 * argued:
 *
 *   1. SCOPE IS EXACT. A wallet is bound to one link. A key leaked from link A
 *      cannot act on link B — not because a permission list forbids it, but
 *      because it is the wrong address.
 *
 *   2. A COMPROMISED BACKEND CANNOT SETTLE. Mark-paid and cancel need the
 *      signature of the customer who placed that specific order, generated in
 *      their browser and never held by us. `backend fully compromised` below
 *      holds every link wallet key and still moves nothing.
 *
 * The structural claims — the Router cannot receive value, contains no
 * delegatecall, selfdestruct or arbitrary-call path — are asserted against the
 * COMPILED ARTEFACT at the bottom, not against the source, because the source
 * is not what gets deployed.
 */
describe("LinkRouter — payments without a funded relayer key", function () {
  let owner: SignerWithAddress;
  let merchant1: SignerWithAddress;
  let merchant2: SignerWithAddress;
  let agent1: SignerWithAddress; // the link wallet for LINK  (holds nothing)
  let agent2: SignerWithAddress; // the link wallet for LINK2 (holds nothing)
  let customer: SignerWithAddress;
  let attacker: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let integrator: any;
  let router: any;
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

  beforeEach(async function () {
    [owner, merchant1, merchant2, agent1, agent2, customer, attacker] = await ethers.getSigners();

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

    router = await (
      await ethers.getContractFactory("LinkRouter")
    ).deploy(await integrator.getAddress());

    // The whole integrator-side change: the trusted relayer is a contract that
    // holds nothing, instead of a funded EOA.
    await integrator.setTrustedRelayer(await router.getAddress());

    const lib = await ethers.getContractAt("PaymentLinksLib", await deployPaymentLinksLib());
    LINK = await lib.computeLinkId(merchant1.address, ethers.id("salt-1"));
    LINK2 = await lib.computeLinkId(merchant1.address, ethers.id("salt-2"));
  });

  // ─── Helpers ──────────────────────────────────────────────────────

  const mkLink = (id: string, qty: number, maxUses = 1, as = merchant1) =>
    integrator.connect(as).createLink(id, UNIT_PRICE * BigInt(qty), INR, 0, maxUses, CONFIG);

  const register = (id: string, agent: SignerWithAddress, as = merchant1) =>
    router.connect(as).registerAgent(id, agent.address);

  const place = (id: string, qty: number, agent: SignerWithAddress, cust = customer) =>
    router.connect(agent).place(id, erc721Client.target, PRODUCT_ID, qty, INR, 0, PK, cust.address);

  const accept = (orderId: bigint) => mockDiamond.simulateOrderAccepted(orderId);

  async function lastOrderId(): Promise<bigint> {
    const evs = await router.queryFilter(router.filters.OrderPlaced());
    return evs[evs.length - 1].args[1];
  }

  /**
   * The customer signs the exact action, the way their browser would — real
   * EIP-712 typed data, not a raw digest, so this exercises the same path the
   * pay page will use.
   */
  async function sign712(
    action: "MarkPaid" | "Cancel",
    id: string,
    orderId: bigint,
    who: SignerWithAddress,
    on: any = router
  ) {
    const domain = {
      name: "P2P LinkRouter",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await on.getAddress(),
    };
    const types = {
      [action]: [
        { name: "linkId", type: "bytes32" },
        { name: "orderId", type: "uint256" },
      ],
    };
    return who.signTypedData(domain, types, { linkId: id, orderId });
  }

  const markPaidSig = (id: string, orderId: bigint, who = customer, on: any = router) =>
    sign712("MarkPaid", id, orderId, who, on);
  const cancelSig = (id: string, orderId: bigint, who = customer, on: any = router) =>
    sign712("Cancel", id, orderId, who, on);

  // ─── The happy path ───────────────────────────────────────────────

  describe("a payment, end to end", function () {
    it("places, marks paid and credits the merchant — with no funded key anywhere", async function () {
      await mkLink(LINK, 1);
      await register(LINK, agent1);

      // The link wallet has no balance at any point in this test.
      expect(await ethers.provider.getBalance(await router.getAddress())).to.equal(0);

      await place(LINK, 1, agent1);
      const orderId = await lastOrderId();
      await accept(orderId);

      await router.connect(agent1).markPaid(LINK, orderId, await markPaidSig(LINK, orderId));
      expect((await mockDiamond.orders(orderId)).paid).to.equal(true);

      await mockDiamond.simulateOrderComplete(orderId);
      const m = await integrator.getMerchantBalance(merchant1.address);
      expect(m.totalDeposited).to.equal(UNIT_PRICE);
    });

    it("the merchant is resolved from the link, never from the caller", async function () {
      await mkLink(LINK, 1);
      await register(LINK, agent1);
      await place(LINK, 1, agent1);
      const orderId = await lastOrderId();

      // order.user is merchant1's proxy even though the caller was agent1 —
      // this is the fact the whole design rests on.
      const stored = await mockDiamond.orders(orderId);
      expect(stored.user).to.equal(await integrator.proxyAddress(merchant1.address));
      expect(stored.user).to.not.equal(agent1.address);
    });

    it("cancel releases the link's use, and needs the customer's signature", async function () {
      await mkLink(LINK, 1);
      await register(LINK, agent1);
      await place(LINK, 1, agent1);
      const orderId = await lastOrderId();

      expect((await integrator.getLink(LINK)).uses).to.equal(1);
      await router.connect(agent1).cancel(LINK, orderId, await cancelSig(LINK, orderId));
      expect((await integrator.getLink(LINK)).uses).to.equal(0);
    });
  });

  // ─── Property 1: scope is exact ───────────────────────────────────

  describe("a link wallet is bound to exactly one link", function () {
    it("cannot place on another link, even the same merchant's", async function () {
      await mkLink(LINK, 1);
      await mkLink(LINK2, 1);
      await register(LINK, agent1);
      await register(LINK2, agent2);

      // agent1's key is fully compromised. It still cannot touch LINK2.
      await expect(place(LINK2, 1, agent1)).to.be.revertedWithCustomError(router, "NotLinkAgent");
    });

    it("cannot mark paid or cancel on another link", async function () {
      await mkLink(LINK, 1);
      await mkLink(LINK2, 1);
      await register(LINK, agent1);
      await register(LINK2, agent2);
      await place(LINK2, 1, agent2);
      const orderId = await lastOrderId();
      await accept(orderId);

      await expect(
        router.connect(agent1).markPaid(LINK2, orderId, await markPaidSig(LINK2, orderId))
      ).to.be.revertedWithCustomError(router, "NotLinkAgent");
      await expect(
        router.connect(agent1).cancel(LINK2, orderId, await cancelSig(LINK2, orderId))
      ).to.be.revertedWithCustomError(router, "NotLinkAgent");
    });

    it("an unregistered link cannot be driven at all", async function () {
      await mkLink(LINK, 1);
      await expect(place(LINK, 1, agent1)).to.be.revertedWithCustomError(router, "NotLinkAgent");
    });

    it("a stranger cannot place, even naming a real link", async function () {
      await mkLink(LINK, 1);
      await register(LINK, agent1);
      await expect(place(LINK, 1, attacker)).to.be.revertedWithCustomError(router, "NotLinkAgent");
    });
  });

  describe("registration is the merchant's own act", function () {
    it("only the link's owner can bind a wallet to it", async function () {
      await mkLink(LINK, 1);
      await expect(register(LINK, agent1, merchant2)).to.be.revertedWithCustomError(
        router,
        "NotLinkOwner"
      );
      await expect(
        router.connect(attacker).registerAgent(LINK, attacker.address)
      ).to.be.revertedWithCustomError(router, "NotLinkOwner");
    });

    it("is write-once, so a live link's signer cannot be swapped mid-flight", async function () {
      await mkLink(LINK, 1);
      await register(LINK, agent1);
      await expect(register(LINK, agent2)).to.be.revertedWithCustomError(router, "AgentAlreadySet");
    });

    it("refuses the zero address", async function () {
      await mkLink(LINK, 1);
      await expect(
        router.connect(merchant1).registerAgent(LINK, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(router, "ZeroAddress");
    });
  });

  // ─── Property 2: settlement needs the customer ────────────────────

  describe("mark-paid and cancel need the order's own customer", function () {
    let orderId: bigint;

    beforeEach(async function () {
      await mkLink(LINK, 1);
      await register(LINK, agent1);
      await place(LINK, 1, agent1);
      orderId = await lastOrderId();
      await accept(orderId);
    });

    it("refuses a signature from anyone else", async function () {
      await expect(
        router.connect(agent1).markPaid(LINK, orderId, await markPaidSig(LINK, orderId, attacker))
      ).to.be.revertedWithCustomError(router, "BadCustomerSignature");
    });

    it("refuses a cancel signature replayed as a mark-paid", async function () {
      // Distinct type hashes: authorising a cancel must not authorise payment.
      await expect(
        router.connect(agent1).markPaid(LINK, orderId, await cancelSig(LINK, orderId))
      ).to.be.revertedWithCustomError(router, "BadCustomerSignature");
    });

    it("refuses a signature made for a different order", async function () {
      await mkLink(LINK2, 1);
      await register(LINK2, agent2);
      await place(LINK2, 1, agent2);
      const other = await lastOrderId();

      await expect(
        router.connect(agent1).markPaid(LINK, orderId, await markPaidSig(LINK, other))
      ).to.be.revertedWithCustomError(router, "BadCustomerSignature");
    });

    it("refuses an order this Router never placed", async function () {
      await expect(
        router.connect(agent1).markPaid(LINK, 999999n, "0x" + "11".repeat(65))
      ).to.be.revertedWithCustomError(router, "UnknownOrder");
    });

    it("refuses a malformed signature rather than recovering a junk signer", async function () {
      await expect(router.connect(agent1).markPaid(LINK, orderId, "0x1234")).to.be.reverted;
    });
  });

  // ─── The scenario the review asked about ──────────────────────────

  describe("our backend fully compromised", function () {
    it("holds every link wallet key, and still cannot settle or move anything", async function () {
      await mkLink(LINK, 2, 2);
      await mkLink(LINK2, 1);
      await register(LINK, agent1);
      await register(LINK2, agent2);

      await place(LINK, 2, agent1);
      const orderId = await lastOrderId();
      await accept(orderId);

      // The attacker now has agent1 AND agent2 — every key we hold. What they
      // do NOT have is any customer's browser key.
      await expect(
        router.connect(agent1).markPaid(LINK, orderId, await markPaidSig(LINK, orderId, attacker))
      ).to.be.revertedWithCustomError(router, "BadCustomerSignature");
      await expect(
        router.connect(agent1).cancel(LINK, orderId, await cancelSig(LINK, orderId, attacker))
      ).to.be.revertedWithCustomError(router, "BadCustomerSignature");

      // No balance moved anywhere.
      const m = await integrator.getMerchantBalance(merchant1.address);
      expect(m.totalDeposited).to.equal(0);
      expect(await mockUsdc.balanceOf(attacker.address)).to.equal(0);
      expect(await mockUsdc.balanceOf(await router.getAddress())).to.equal(0);
    });

    it("cannot reach withdrawal or profile edits — the Router has no such call", async function () {
      // The Router's entire interface is three link functions. There is no
      // method on it that names withdrawUSDC, withdrawFiat or updateProfile, so
      // the theft path an approved-target list would have opened does not exist.
      const names = router.interface.fragments
        .filter((f: any) => f.type === "function")
        .map((f: any) => f.name);
      for (const forbidden of [
        "withdrawUSDC",
        "withdrawFiat",
        "updateProfile",
        "execute",
        "call",
        "transfer",
        "approve",
      ]) {
        expect(names).to.not.include(forbidden);
      }
    });

    it("cannot place beyond the link's own limits", async function () {
      await mkLink(LINK, 1, 1); // one use only
      await register(LINK, agent1);
      await place(LINK, 1, agent1);

      // The integrator's rules still bind: the Router re-implements none of
      // them, so there is no second place for them to drift.
      await expect(place(LINK, 1, agent1)).to.be.reverted;
    });
  });

  // ─── Value cannot enter or leave ──────────────────────────────────

  describe("the Router cannot hold or move value", function () {
    it("rejects native value sent to it directly", async function () {
      await expect(owner.sendTransaction({ to: await router.getAddress(), value: 1n })).to.be
        .reverted;
    });

    it("rejects value sent with a call", async function () {
      await mkLink(LINK, 1);
      await register(LINK, agent1);
      await expect(
        router
          .connect(agent1)
          .place(LINK, erc721Client.target, PRODUCT_ID, 1, INR, 0, PK, customer.address, {
            value: 1n,
          })
      ).to.be.reverted;
    });

    it("exposes no payable function, receive or fallback", async function () {
      const art = require("../artifacts/contracts/integrators/merchant-terminal/LinkRouter.sol/LinkRouter.json");
      expect(art.abi.filter((x: any) => x.stateMutability === "payable")).to.have.length(0);
      expect(
        art.abi.filter((x: any) => x.type === "receive" || x.type === "fallback")
      ).to.have.length(0);
    });

    it("contains no delegatecall, callcode or selfdestruct in the COMPILED artefact", async function () {
      // Source review is not enough — what deploys is the bytecode. Walk the
      // instruction stream properly: PUSH immediates are data, so a naive byte
      // search reports opcodes that are not there.
      const art = require("../artifacts/contracts/integrators/merchant-terminal/LinkRouter.sol/LinkRouter.json");
      const code = Buffer.from(art.deployedBytecode.slice(2), "hex");
      const found = new Set<number>();
      for (let i = 0; i < code.length; ) {
        const op = code[i];
        if (op >= 0x60 && op <= 0x7f) {
          i += 1 + (op - 0x5f);
          continue;
        }
        found.add(op);
        i += 1;
      }
      expect(found.has(0xf4), "DELEGATECALL present").to.equal(false);
      expect(found.has(0xf2), "CALLCODE present").to.equal(false);
      expect(found.has(0xff), "SELFDESTRUCT present").to.equal(false);
      expect(found.has(0xf0), "CREATE present").to.equal(false);
      expect(found.has(0xf5), "CREATE2 present").to.equal(false);
    });

    it("is comfortably inside the code-size ceiling", async function () {
      const art = require("../artifacts/contracts/integrators/merchant-terminal/LinkRouter.sol/LinkRouter.json");
      const size = (art.deployedBytecode.length - 2) / 2;
      expect(size).to.be.lessThan(24576);
    });
  });

  // ─── Gaps coverage found ──────────────────────────────────────────

  describe("the remaining guards", function () {
    it("refuses to deploy against the zero address", async function () {
      const F = await ethers.getContractFactory("LinkRouter");
      await expect(F.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        router,
        "ZeroAddress"
      );
    });

    it("refuses a placement with no customer key", async function () {
      // Without this the order would have NO key able to settle it: the
      // customer could never mark it paid, and it would sit until TTL with
      // their fiat already sent.
      await mkLink(LINK, 1);
      await register(LINK, agent1);
      await expect(
        router
          .connect(agent1)
          .place(LINK, erc721Client.target, PRODUCT_ID, 1, INR, 0, PK, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(router, "ZeroAddress");
    });

    it("refuses registering an agent for a link that does not exist", async function () {
      await expect(router.connect(merchant1).registerAgent(LINK, agent1.address)).to.be.reverted;
    });

    it("catches an order/link mismatch even from a legitimate agent", async function () {
      // agent1 IS the right wallet for LINK, and the order IS real — but it
      // belongs to LINK2. Without this check the Router would forward a
      // mismatched pair and rely entirely on the integrator to notice.
      await mkLink(LINK, 1);
      await mkLink(LINK2, 1);
      await register(LINK, agent1);
      await register(LINK2, agent2);
      await place(LINK2, 1, agent2);
      const orderId = await lastOrderId();

      await expect(
        router.connect(agent1).markPaid(LINK, orderId, await markPaidSig(LINK, orderId))
      ).to.be.revertedWithCustomError(router, "OrderLinkMismatch");
    });

    it("exposes the order owner so support can answer who may settle it", async function () {
      await mkLink(LINK, 1);
      await register(LINK, agent1);
      await place(LINK, 1, agent1);
      const orderId = await lastOrderId();

      expect(await router.orderCustomer(orderId)).to.equal(customer.address);
      expect(await router.orderCustomer(999999n)).to.equal(ethers.ZeroAddress);
    });

    it("gives mark-paid and cancel DIFFERENT digests for the same order", async function () {
      // If these collided, authorising a cancel would authorise a payment.
      await mkLink(LINK, 1);
      await register(LINK, agent1);
      await place(LINK, 1, agent1);
      const orderId = await lastOrderId();

      const paid = await router.markPaidDigest(LINK, orderId);
      const cancelled = await router.cancelDigest(LINK, orderId);
      expect(paid).to.not.equal(cancelled);
    });

    it("cannot mark the same order paid twice", async function () {
      await mkLink(LINK, 1);
      await register(LINK, agent1);
      await place(LINK, 1, agent1);
      const orderId = await lastOrderId();
      await accept(orderId);

      const sig = await markPaidSig(LINK, orderId);
      await router.connect(agent1).markPaid(LINK, orderId, sig);
      // The signature is still valid — replay protection here is the ORDER's
      // state, not a nonce. The Diamond refuses a second claim.
      await expect(router.connect(agent1).markPaid(LINK, orderId, sig)).to.be.reverted;
    });

    it("cannot cancel an order that is already paid", async function () {
      await mkLink(LINK, 1);
      await register(LINK, agent1);
      await place(LINK, 1, agent1);
      const orderId = await lastOrderId();
      await accept(orderId);
      await router.connect(agent1).markPaid(LINK, orderId, await markPaidSig(LINK, orderId));

      // The customer's fiat has left their bank. Letting a cancel through here
      // would strand it with the order dead and no wallet to dispute with.
      await expect(router.connect(agent1).cancel(LINK, orderId, await cancelSig(LINK, orderId))).to
        .be.reverted;
    });
  });

  // ─── Reentrancy ───────────────────────────────────────────────────

  describe("the reentrancy guard actually fires", function () {
    // `place` cannot follow checks-effects-interactions: the orderId it must
    // record only exists after the external call returns, so the write happens
    // last. That is the shape reentrancy exploits, and the guard is the reason
    // it is safe. A guard nobody has seen fire is a guard nobody knows works.
    let hostile: any;
    let hostileRouter: any;

    beforeEach(async function () {
      hostile = await (await ethers.getContractFactory("ReentrantIntegrator")).deploy();
      hostileRouter = await (
        await ethers.getContractFactory("LinkRouter")
      ).deploy(await hostile.getAddress());
      await hostile.setRouter(await hostileRouter.getAddress());
      await hostile.setLinkOwner(merchant1.address);
      await hostileRouter.connect(merchant1).registerAgent(LINK, agent1.address);
    });

    it("blocks a re-entrant place, and the outer call still records ONE order", async function () {
      await hostile.setAttack(true, false);

      await hostileRouter
        .connect(agent1)
        .place(LINK, erc721Client.target, PRODUCT_ID, 1, INR, 0, PK, customer.address);

      // The nested call was refused, not silently allowed.
      expect(await hostile.reentryReverted()).to.equal(true);

      // And the outer call completed correctly: exactly one order recorded,
      // owned by the real customer.
      const evs = await hostileRouter.queryFilter(hostileRouter.filters.OrderPlaced());
      expect(evs.length).to.equal(1);
      expect(await hostileRouter.orderCustomer(evs[0].args[1])).to.equal(customer.address);
    });

    it("blocks a re-entrant mark-paid", async function () {
      await hostile.setAttack(true, false);
      await hostileRouter
        .connect(agent1)
        .place(LINK, erc721Client.target, PRODUCT_ID, 1, INR, 0, PK, customer.address);
      const evs = await hostileRouter.queryFilter(hostileRouter.filters.OrderPlaced());
      const orderId = evs[0].args[1];

      await hostile.setAttack(false, true);
      const domain = {
        name: "P2P LinkRouter",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await hostileRouter.getAddress(),
      };
      const sig = await customer.signTypedData(
        domain,
        {
          MarkPaid: [
            { name: "linkId", type: "bytes32" },
            { name: "orderId", type: "uint256" },
          ],
        },
        { linkId: LINK, orderId }
      );

      await hostileRouter.connect(agent1).markPaid(LINK, orderId, sig);
      expect(await hostile.reentryReverted()).to.equal(true);
    });
  });

  // ─── Replay across deployments ────────────────────────────────────

  describe("signatures are bound to this chain and this Router", function () {
    it("a signature for one Router is refused by another", async function () {
      await mkLink(LINK, 1);
      await register(LINK, agent1);
      await place(LINK, 1, agent1);
      const orderId = await lastOrderId();
      await accept(orderId);

      // A second Router on the same chain: same link, same order, same signer —
      // but the EIP-712 domain binds the verifying contract, so the digest
      // differs and the signature does not carry over.
      const other = await (
        await ethers.getContractFactory("LinkRouter")
      ).deploy(await integrator.getAddress());

      const digestHere = await router.markPaidDigest(LINK, orderId);
      const digestThere = await other.markPaidDigest(LINK, orderId);
      expect(digestHere).to.not.equal(digestThere);

      await expect(
        router
          .connect(agent1)
          .markPaid(LINK, orderId, await markPaidSig(LINK, orderId, customer, other))
      ).to.be.revertedWithCustomError(router, "BadCustomerSignature");
    });

    it("the domain separator names this chain", async function () {
      const d = await router.eip712Domain();
      expect(d.chainId).to.equal((await ethers.provider.getNetwork()).chainId);
      expect(d.verifyingContract).to.equal(await router.getAddress());
    });
  });
});
