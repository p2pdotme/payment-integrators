import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/** Deploys PaymentLinksLib and returns its address, for linking. */
async function deployPaymentLinksLib(): Promise<string> {
  const Lib = await ethers.getContractFactory("PaymentLinksLib");
  const lib = await Lib.deploy();
  await lib.waitForDeployment();
  return await lib.getAddress();
}

/**
 * Payment links: a merchant creates a shareable link, a WALLETLESS customer pays
 * it, and `trustedRelayer` places the order on the merchant's behalf.
 *
 * The security claim under test is structural, not behavioural: the relayer can
 * place orders bounded by what the merchant committed to at creation, and it can
 * reach NOTHING else — no withdrawal, no profile, no link lifecycle. Several
 * tests below assert on that boundary directly rather than on happy-path flow.
 */
describe("MerchantTerminalIntegrator — payment links", function () {
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
  const INR_CODE = "INR";
  const INR = ethers.encodeBytes32String("INR");
  const BRL = ethers.encodeBytes32String("BRL");
  const DAY = 86400;

  const enc = (label: string) => ethers.keccak256(ethers.toUtf8Bytes("enc-payout:" + label));
  const UPI_1 = enc("shop1@upi");
  const UPI_2 = enc("shop2@upi");
  const PK = "04" + "ab".repeat(64);

  // Opaque blob standing in for the merchant's client-side-encrypted
  // {orderRef, description}. The contract emits it and never decodes it.
  const CONFIG = ethers.hexlify(ethers.toUtf8Bytes("encrypted-config-blob"));

  const LINK_A = ethers.id("link-a");
  const LINK_B = ethers.id("link-b");

  /**
   * `validateOrder` runs INSIDE the Diamond call, so its revert reaches us
   * wrapped by UserProxy as `CallFailed(bytes)`. Asserting on the inner
   * selector is what actually proves link orders and POS orders hit the same
   * guard with the same outcome — a plain `revertedWithCustomError` would
   * only see the wrapper.
   */
  const selectorOf = (sig: string) => ethers.id(sig).slice(0, 10);

  async function expectCallFailedWith(txPromise: Promise<any>, errorSig: string) {
    // `CallFailed` is declared on UserProxy (the wrapper), not the integrator.
    const proxyArtifact = await ethers.getContractFactory("UserProxy");
    await expect(txPromise)
      .to.be.revertedWithCustomError(proxyArtifact, "CallFailed")
      .withArgs(selectorOf(errorSig));
  }

  /** A link priced at exactly `qty * UNIT_PRICE`, so a matching order settles. */
  const linkAmount = (qty: number) => UNIT_PRICE * BigInt(qty);

  beforeEach(async function () {
    [owner, merchant1, merchant2, relayer, attacker] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUsdc = await MockUSDC.deploy();

    const MockDiamond = await ethers.getContractFactory("MockDiamond");
    mockDiamond = await MockDiamond.deploy(await mockUsdc.getAddress());

    const Integrator = await ethers.getContractFactory("MerchantTerminalIntegrator", {
      libraries: { PaymentLinksLib: await deployPaymentLinksLib() },
    });
    integrator = await Integrator.deploy(
      await mockDiamond.getAddress(),
      await mockUsdc.getAddress(),
      []
    );

    const Client = await ethers.getContractFactory("SimpleERC721Client");
    erc721Client = await Client.deploy(
      await integrator.getAddress(),
      await mockUsdc.getAddress(),
      "Digital Item",
      "ITEM"
    );

    await mockDiamond.registerIntegrator(
      await integrator.getAddress(),
      await integrator.proxyImpl()
    );
    await erc721Client.setProductPrice(PRODUCT_ID, UNIT_PRICE);
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(100000));

    await integrator.connect(merchant1).registerMerchant(UPI_1, "Ramesh Sarees", INR_CODE);
    await integrator.connect(merchant2).registerMerchant(UPI_2, "Other Shop", INR_CODE);
    await integrator.setTrustedRelayer(relayer.address);
  });

  /** Places an order through a link exactly as the relayer Worker would. */
  function payLink(linkId: string, qty: number, currency: string = INR, as = relayer) {
    return integrator
      .connect(as)
      .relayerPlaceOrder(linkId, erc721Client.target, PRODUCT_ID, qty, currency, 0, PK);
  }

  /** orderId from the most recent LinkOrderPlaced in the last block. */
  async function lastOrderId(): Promise<bigint> {
    const evs = await integrator.queryFilter(integrator.filters.LinkOrderPlaced());
    return evs[evs.length - 1].args[1];
  }

  // `singleUse` is now expressed as `maxUses`: 1 is the old single-use link, 0
  // is unlimited. The helper keeps accepting `singleUse` so the existing cases
  // read unchanged, and `maxUses` is available for the multi-use cases.
  function createLink(
    as: SignerWithAddress,
    linkId: string,
    amount: bigint,
    opts: {
      currency?: string;
      expiresAt?: number;
      singleUse?: boolean;
      maxUses?: number;
    } = {}
  ) {
    const maxUses = opts.maxUses ?? (opts.singleUse ? 1 : 0);
    return integrator
      .connect(as)
      .createLink(linkId, amount, opts.currency ?? INR, opts.expiresAt ?? 0, maxUses, CONFIG);
  }

  // ─── Creation ─────────────────────────────────────────────────────

  describe("createLink", function () {
    it("stores the link and emits its config blob for the merchant to read back", async function () {
      await expect(createLink(merchant1, LINK_A, linkAmount(3), { singleUse: true }))
        .to.emit(integrator, "LinkCreated")
        .withArgs(LINK_A, merchant1.address, linkAmount(3), INR, 0, 1, CONFIG);

      const L = await integrator.getLink(LINK_A);
      expect(L[0]).to.equal(merchant1.address);
      expect(L[1]).to.equal(linkAmount(3));
      expect(L[2]).to.equal(INR);
      expect(L[4]).to.equal(1); // maxUses — 1 is the old singleUse
      expect(L[5]).to.equal(0); // ACTIVE
      expect(L[6]).to.equal(0); // uses
      expect(L[7]).to.equal(0); // strikes
    });

    it("records the owner from msg.sender, so a link cannot be created for someone else", async function () {
      await createLink(merchant1, LINK_A, linkAmount(1));
      expect((await integrator.getLink(LINK_A))[0]).to.equal(merchant1.address);
    });

    it("rejects an unregistered caller", async function () {
      await expect(createLink(attacker, LINK_A, linkAmount(1))).to.be.revertedWithCustomError(
        integrator,
        "NotRegistered"
      );
    });

    it("rejects a duplicate id rather than overwriting an existing link", async function () {
      await createLink(merchant1, LINK_A, linkAmount(1));
      // Even the owner cannot clobber their own link...
      await expect(createLink(merchant1, LINK_A, linkAmount(9))).to.be.revertedWithCustomError(
        integrator,
        "LinkExists"
      );
      // ...and another merchant certainly cannot hijack the id.
      await expect(createLink(merchant2, LINK_A, linkAmount(9))).to.be.revertedWithCustomError(
        integrator,
        "LinkExists"
      );
      expect((await integrator.getLink(LINK_A))[0]).to.equal(merchant1.address);
    });

    it("rejects an already-expired link, which could never be paid", async function () {
      const past = (await time.latest()) - 1;
      await expect(
        createLink(merchant1, LINK_A, linkAmount(1), { expiresAt: past })
      ).to.be.revertedWithCustomError(integrator, "LinkExpired");
    });

    it("rejects a zero id and a zero currency", async function () {
      await expect(
        createLink(merchant1, ethers.ZeroHash, linkAmount(1))
      ).to.be.revertedWithCustomError(integrator, "LinkNotFound");
      await expect(
        createLink(merchant1, LINK_A, linkAmount(1), { currency: ethers.ZeroHash })
      ).to.be.revertedWithCustomError(integrator, "InvalidCurrency");
    });

    it("rejects a fixed amount above the per-tx cap, so a link is payable the moment it exists", async function () {
      // The alternative is a link that looks fine to the merchant and then
      // reverts at PAY time, in front of a customer, with the merchant absent.
      await integrator.setPerTxCap(INR, USDC(25));
      await expect(createLink(merchant1, LINK_A, USDC(30))).to.be.revertedWithCustomError(
        integrator,
        "ExceedsPerTxCap"
      );
      // At the cap exactly is fine.
      await expect(createLink(merchant1, LINK_A, USDC(25))).to.emit(integrator, "LinkCreated");
    });

    it("still allows a variable-amount link when the cap is low — it is bounded at pay time", async function () {
      await integrator.setPerTxCap(INR, USDC(25));
      await expect(createLink(merchant1, LINK_B, 0n)).to.emit(integrator, "LinkCreated");
    });

    it("keys the cap off the merchant's REGISTERED currency, matching validateOrder", async function () {
      // merchant1 is registered in INR. A cross-currency link must still be
      // checked against the INR cap, because that is what validateOrder
      // enforces at pay time. Keying off the link's own currency would let a
      // merchant create a link that passes creation and then reverts in front
      // of a customer — the exact failure this check exists to prevent.
      await integrator.setPerTxCap(INR, USDC(20)); // registered currency
      await integrator.setPerTxCap(BRL, USDC(500)); // link currency, generous

      // 100 USDC is under the BRL cap but way over the INR one.
      await expect(
        createLink(merchant1, LINK_A, USDC(100), { currency: BRL })
      ).to.be.revertedWithCustomError(integrator, "ExceedsPerTxCap");

      // Within the INR cap, the cross-currency link is fine and really pays.
      await createLink(merchant1, LINK_B, linkAmount(2), { currency: BRL });
      await expect(payLink(LINK_B, 2, BRL)).to.emit(integrator, "LinkOrderPlaced");
    });

    it("refuses a frozen merchant — the freeze switch means the same thing everywhere", async function () {
      // A frozen merchant cannot be paid, so minting links would only produce
      // ones that fail in front of a customer. `updateProfile` already refuses
      // a frozen merchant; this keeps the behaviour consistent.
      await integrator.freezeMerchant(merchant1.address);
      await expect(createLink(merchant1, LINK_A, linkAmount(1))).to.be.revertedWithCustomError(
        integrator,
        "MerchantIsFrozen"
      );

      await integrator.unfreezeMerchant(merchant1.address);
      await expect(createLink(merchant1, LINK_A, linkAmount(1))).to.emit(integrator, "LinkCreated");
    });

    it("getLink reverts for an id that was never created", async function () {
      await expect(integrator.getLink(LINK_B)).to.be.revertedWithCustomError(
        integrator,
        "LinkNotFound"
      );
    });
  });

  // ─── Access control ───────────────────────────────────────────────

  describe("relayerPlaceOrder access", function () {
    beforeEach(async function () {
      await createLink(merchant1, LINK_A, linkAmount(3));
    });

    it("is callable by the trusted relayer", async function () {
      await expect(payLink(LINK_A, 3)).to.emit(integrator, "LinkOrderPlaced");
    });

    it("rejects EVERY other caller — including the link's own merchant and an admin", async function () {
      for (const who of [merchant1, merchant2, attacker, owner]) {
        await expect(payLink(LINK_A, 3, INR, who)).to.be.revertedWithCustomError(
          integrator,
          "OnlyTrustedRelayer"
        );
      }
    });

    it("follows the relayer slot when it is reassigned", async function () {
      await integrator.setTrustedRelayer(attacker.address);
      await expect(payLink(LINK_A, 3, INR, relayer)).to.be.revertedWithCustomError(
        integrator,
        "OnlyTrustedRelayer"
      );
      await expect(payLink(LINK_A, 3, INR, attacker)).to.emit(integrator, "LinkOrderPlaced");
    });
  });

  // ─── The structural security boundary ─────────────────────────────

  describe("the relayer cannot reach anything but order placement", function () {
    it("cannot withdraw USDC, withdraw fiat, or change a profile", async function () {
      // Not a registered merchant — every funds-moving entry point rejects it
      // before any balance is even consulted.
      expect(await integrator.registered(relayer.address)).to.equal(false);

      await expect(integrator.connect(relayer).withdrawUSDC(USDC(1))).to.be.revertedWithCustomError(
        integrator,
        "NotRegistered"
      );

      await expect(
        integrator.connect(relayer).withdrawFiat(USDC(1), 0, PK, "")
      ).to.be.revertedWithCustomError(integrator, "NotRegistered");

      await expect(
        integrator.connect(relayer).withdrawFiatIn(USDC(1), 0, INR, PK)
      ).to.be.revertedWithCustomError(integrator, "NotRegistered");

      await expect(
        integrator.connect(relayer).updateProfile(UPI_2, "Hijacked")
      ).to.be.revertedWithCustomError(integrator, "NotRegistered");
    });

    it("cannot revoke a link — lifecycle stays with the merchant", async function () {
      await createLink(merchant1, LINK_A, linkAmount(1));
      await expect(integrator.connect(relayer).revokeLink(LINK_A)).to.be.revertedWithCustomError(
        integrator,
        "NotLinkOwner"
      );
    });

    it("cannot create a link, so it can never author its own payment target", async function () {
      await expect(createLink(relayer, LINK_B, linkAmount(1))).to.be.revertedWithCustomError(
        integrator,
        "NotRegistered"
      );
    });

    it("cannot flip the kill switch it is governed by", async function () {
      await expect(
        integrator.connect(relayer).setLinkOrdersEnabled(false)
      ).to.be.revertedWithCustomError(integrator, "NotAuthorized");
    });

    it("credits the LINK's owner, never an address the relayer supplies", async function () {
      await createLink(merchant2, LINK_B, linkAmount(2));
      await expect(payLink(LINK_B, 2))
        .to.emit(integrator, "LinkOrderPlaced")
        .withArgs(LINK_B, anyUint, merchant2.address, linkAmount(2));
    });

    it("a compromised relayer cannot redirect one merchant's link to another", async function () {
      // merchant1 owns the link; merchant2 is the attacker's intended payee.
      // There is no calldata field that could express "credit merchant2" —
      // the merchant is read from storage, which only the owner could write.
      await createLink(merchant1, LINK_A, linkAmount(1));
      const before2 = await integrator.getMerchantBalance(merchant2.address);

      await payLink(LINK_A, 1);

      const after2 = await integrator.getMerchantBalance(merchant2.address);
      expect(after2[2], "the non-owner merchant is untouched").to.equal(before2[2]);
      expect(await integrator.orderToMerchant(await lastOrderId())).to.equal(merchant1.address);
    });

    it("a leaked link URL grants an attacker nothing — only the relayer can spend it", async function () {
      // The URL carries the linkId and nothing else: no key material. Knowing it
      // is exactly as useful as knowing a shop's address.
      await createLink(merchant1, LINK_A, linkAmount(1));
      for (const who of [attacker, merchant2]) {
        await expect(payLink(LINK_A, 1, INR, who)).to.be.revertedWithCustomError(
          integrator,
          "OnlyTrustedRelayer"
        );
      }
    });
  });

  // ─── Amount and currency pinning ──────────────────────────────────

  describe("amount and currency are pinned to what the merchant committed to", function () {
    it("rejects an order below a fixed link's amount", async function () {
      await createLink(merchant1, LINK_A, linkAmount(3));
      await expect(payLink(LINK_A, 2)).to.be.revertedWithCustomError(
        integrator,
        "LinkAmountMismatch"
      );
    });

    it("rejects an order above a fixed link's amount", async function () {
      await createLink(merchant1, LINK_A, linkAmount(3));
      await expect(payLink(LINK_A, 4)).to.be.revertedWithCustomError(
        integrator,
        "LinkAmountMismatch"
      );
    });

    it("accepts any quantity on a variable link (amount == 0)", async function () {
      await createLink(merchant1, LINK_A, 0n);
      await expect(payLink(LINK_A, 1)).to.emit(integrator, "LinkOrderPlaced");
      await expect(payLink(LINK_A, 4)).to.emit(integrator, "LinkOrderPlaced");
    });

    it("rejects a currency the link was not created in", async function () {
      await createLink(merchant1, LINK_A, linkAmount(3), { currency: INR });
      // A compromised relayer must not be able to re-price a link into another
      // currency's cap / lock-period regime.
      await expect(payLink(LINK_A, 3, BRL)).to.be.revertedWithCustomError(
        integrator,
        "InvalidCurrency"
      );
    });

    it("rejects a zero quantity and an unpriced product, same as the POS path", async function () {
      // `_quote` is shared with userPlaceOrder — these guard the relayer against
      // submitting a degenerate order even for a perfectly valid link.
      await createLink(merchant1, LINK_A, 0n);
      await expect(payLink(LINK_A, 0)).to.be.revertedWithCustomError(integrator, "InvalidQuantity");

      const Client = await ethers.getContractFactory("SimpleERC721Client");
      const unpriced = await Client.deploy(
        await integrator.getAddress(),
        await mockUsdc.getAddress(),
        "No Price",
        "NP"
      );
      await expect(
        integrator
          .connect(relayer)
          .relayerPlaceOrder(LINK_A, unpriced.target, PRODUCT_ID, 1, INR, 0, PK)
      ).to.be.revertedWithCustomError(integrator, "ProductNotFound");
    });

    it("still enforces the per-tx cap on a variable link", async function () {
      await integrator.setPerTxCap(INR, USDC(25));
      await createLink(merchant1, LINK_A, 0n);
      // 3 x 10 USDC = 30 > the 25 cap — a variable link is NOT an unbounded one.
      await expectCallFailedWith(payLink(LINK_A, 3), "ExceedsPerTxCap()");
      await expect(payLink(LINK_A, 2)).to.emit(integrator, "LinkOrderPlaced");
    });
  });

  // ─── Lifecycle ────────────────────────────────────────────────────

  describe("expiry, revocation, single-use", function () {
    it("rejects a payment after expiry", async function () {
      const expiresAt = (await time.latest()) + 3600;
      await createLink(merchant1, LINK_A, linkAmount(1), { expiresAt });

      await expect(payLink(LINK_A, 1)).to.emit(integrator, "LinkOrderPlaced");

      await time.increaseTo(expiresAt + 1);
      await expect(payLink(LINK_A, 1)).to.be.revertedWithCustomError(integrator, "LinkExpired");
      expect(await integrator.isLinkActive(LINK_A)).to.equal(false);
    });

    it("treats expiresAt == 0 as never expiring", async function () {
      await createLink(merchant1, LINK_A, linkAmount(1), { expiresAt: 0 });
      await time.increase(365 * DAY);
      await expect(payLink(LINK_A, 1)).to.emit(integrator, "LinkOrderPlaced");
    });

    it("lets the owner revoke, and a revoked link stops accepting payments immediately", async function () {
      await createLink(merchant1, LINK_A, linkAmount(1));
      await expect(integrator.connect(merchant1).revokeLink(LINK_A))
        .to.emit(integrator, "LinkRevoked")
        .withArgs(LINK_A, merchant1.address);

      await expect(payLink(LINK_A, 1)).to.be.revertedWithCustomError(integrator, "LinkNotActive");
      expect(await integrator.isLinkActive(LINK_A)).to.equal(false);
    });

    it("lets an admin revoke, but not an unrelated merchant", async function () {
      await createLink(merchant1, LINK_A, linkAmount(1));
      await expect(integrator.connect(merchant2).revokeLink(LINK_A)).to.be.revertedWithCustomError(
        integrator,
        "NotLinkOwner"
      );
      await expect(integrator.connect(owner).revokeLink(LINK_A)).to.emit(integrator, "LinkRevoked");
    });

    it("cannot revoke twice, and revocation is terminal", async function () {
      await createLink(merchant1, LINK_A, linkAmount(1));
      await integrator.connect(merchant1).revokeLink(LINK_A);
      await expect(integrator.connect(merchant1).revokeLink(LINK_A)).to.be.revertedWithCustomError(
        integrator,
        "LinkNotActive"
      );
    });

    it("lets a merchant revoke an EXPIRED link — tidying up must never error", async function () {
      const expiresAt = (await time.latest()) + 100;
      await createLink(merchant1, LINK_A, linkAmount(1), { expiresAt });
      await time.increaseTo(expiresAt + 1);

      await expect(integrator.connect(merchant1).revokeLink(LINK_A)).to.emit(
        integrator,
        "LinkRevoked"
      );
    });

    it("lets a merchant revoke a CONSUMED single-use link", async function () {
      await createLink(merchant1, LINK_A, linkAmount(1), { singleUse: true });
      await payLink(LINK_A, 1);
      await expect(integrator.connect(merchant1).revokeLink(LINK_A)).to.emit(
        integrator,
        "LinkRevoked"
      );
    });

    it("consumes a single-use link after one payment — a replay reverts", async function () {
      await createLink(merchant1, LINK_A, linkAmount(2), { singleUse: true });

      await expect(payLink(LINK_A, 2)).to.emit(integrator, "LinkOrderPlaced");
      expect((await integrator.getLink(LINK_A))[6]).to.equal(1); // uses
      expect(await integrator.isLinkActive(LINK_A)).to.equal(false);

      await expect(payLink(LINK_A, 2)).to.be.revertedWithCustomError(integrator, "LinkAlreadyUsed");
    });

    it("a single-use link cannot be replayed with different call parameters either", async function () {
      await createLink(merchant1, LINK_A, 0n, { singleUse: true }); // variable amount
      await payLink(LINK_A, 1);
      // Different quantity, same link — the use counter, not the amount, is what
      // closes it.
      await expect(payLink(LINK_A, 5)).to.be.revertedWithCustomError(integrator, "LinkAlreadyUsed");
    });

    it("a multi-use link keeps accepting payments and counts each one", async function () {
      await createLink(merchant1, LINK_A, linkAmount(1), { singleUse: false });
      for (let i = 0; i < 3; i++) await payLink(LINK_A, 1);
      expect((await integrator.getLink(LINK_A))[6]).to.equal(3);
      expect(await integrator.isLinkActive(LINK_A)).to.equal(true);
    });

    it("rejects a payment against an id that was never created", async function () {
      await expect(payLink(LINK_B, 1)).to.be.revertedWithCustomError(integrator, "LinkNotFound");
    });
  });

  // ─── The pay page's precheck ──────────────────────────────────────

  describe("isLinkActive tells the pay page the truth", function () {
    // The pay page shows a Pay button based on this. If it says true and the
    // payment then reverts, the customer is alone with a failure and the
    // merchant is asleep. So it has to see every gate the payment would hit.

    it("goes false when the merchant is frozen after creation", async function () {
      await createLink(merchant1, LINK_A, linkAmount(1));
      expect(await integrator.isLinkActive(LINK_A)).to.equal(true);

      await integrator.freezeMerchant(merchant1.address);
      expect(await integrator.isLinkActive(LINK_A)).to.equal(false);
      await expectCallFailedWith(payLink(LINK_A, 1), "MerchantIsFrozen()");

      await integrator.unfreezeMerchant(merchant1.address);
      expect(await integrator.isLinkActive(LINK_A)).to.equal(true);
    });

    it("goes false when an admin lowers the cap below a fixed link's amount", async function () {
      await integrator.setPerTxCap(INR, USDC(50));
      await createLink(merchant1, LINK_A, linkAmount(4)); // 40 USDC
      expect(await integrator.isLinkActive(LINK_A)).to.equal(true);

      await integrator.setPerTxCap(INR, USDC(10));
      expect(await integrator.isLinkActive(LINK_A)).to.equal(false);
      await expectCallFailedWith(payLink(LINK_A, 4), "ExceedsPerTxCap()");
    });

    it("goes false when link orders are halted, and true again when resumed", async function () {
      await createLink(merchant1, LINK_A, linkAmount(1));
      await integrator.setLinkOrdersEnabled(false);
      expect(await integrator.isLinkActive(LINK_A)).to.equal(false);

      await integrator.setLinkOrdersEnabled(true);
      expect(await integrator.isLinkActive(LINK_A)).to.equal(true);
    });

    it("goes false while the contract is paused", async function () {
      await createLink(merchant1, LINK_A, linkAmount(1));
      await integrator.pause();
      expect(await integrator.isLinkActive(LINK_A)).to.equal(false);

      await integrator.unpause();
      expect(await integrator.isLinkActive(LINK_A)).to.equal(true);
    });

    it("stays true for a variable-amount link under a low cap — bounded at pay time", async function () {
      await createLink(merchant1, LINK_A, 0n);
      await integrator.setPerTxCap(INR, USDC(10));
      // The link itself is payable; only an over-cap QUANTITY would fail.
      expect(await integrator.isLinkActive(LINK_A)).to.equal(true);
    });
  });

  // ─── Kill switch ──────────────────────────────────────────────────

  describe("linkOrdersEnabled kill switch", function () {
    beforeEach(async function () {
      await createLink(merchant1, LINK_A, linkAmount(1));
    });

    it("defaults open", async function () {
      expect(await integrator.linkOrdersEnabled()).to.equal(true);
    });

    it("halts link orders when closed, and resumes them when reopened", async function () {
      await expect(integrator.setLinkOrdersEnabled(false))
        .to.emit(integrator, "LinkOrdersEnabledSet")
        .withArgs(false);

      await expect(payLink(LINK_A, 1)).to.be.revertedWithCustomError(
        integrator,
        "LinkOrdersDisabled"
      );

      await integrator.setLinkOrdersEnabled(true);
      await expect(payLink(LINK_A, 1)).to.emit(integrator, "LinkOrderPlaced");
    });

    it("does NOT disturb the POS flow — the whole point of a scoped switch", async function () {
      await integrator.setLinkOrdersEnabled(false);
      await expect(
        integrator.connect(merchant1).userPlaceOrder(erc721Client.target, PRODUCT_ID, 1, INR, 0, PK)
      ).to.emit(integrator, "OrderPlaced");
    });

    it("rejects a non-manager caller", async function () {
      await expect(
        integrator.connect(merchant1).setLinkOrdersEnabled(false)
      ).to.be.revertedWithCustomError(integrator, "NotAuthorized");
    });
  });

  // ─── Parity with the in-person flow ───────────────────────────────

  describe("merchant-level controls apply identically to link orders", function () {
    it("a frozen merchant cannot be paid through a link — the same guard the POS flow hits", async function () {
      await createLink(merchant1, LINK_A, linkAmount(1));
      await integrator.freezeMerchant(merchant1.address);

      // Byte-identical revert on both paths: the freeze kill-switch is not
      // re-implemented for links, it is the same check reached the same way.
      await expectCallFailedWith(payLink(LINK_A, 1), "MerchantIsFrozen()");
      await expectCallFailedWith(
        integrator
          .connect(merchant1)
          .userPlaceOrder(erc721Client.target, PRODUCT_ID, 1, INR, 0, PK),
        "MerchantIsFrozen()"
      );

      await integrator.unfreezeMerchant(merchant1.address);
      await expect(payLink(LINK_A, 1)).to.emit(integrator, "LinkOrderPlaced");
    });

    it("link orders consume the same daily limit as in-person sales", async function () {
      await integrator.setDailyLimit(2);
      await createLink(merchant1, LINK_A, linkAmount(1));

      await payLink(LINK_A, 1);
      // A POS sale and a link sale draw on ONE shared allowance.
      await integrator
        .connect(merchant1)
        .userPlaceOrder(erc721Client.target, PRODUCT_ID, 1, INR, 0, PK);

      await expectCallFailedWith(payLink(LINK_A, 1), "DailyLimitReached()");
    });

    it("a paused contract rejects link orders and link creation", async function () {
      await createLink(merchant1, LINK_A, linkAmount(1));
      await integrator.pause();

      // `whenNotPaused` is on the integrator itself, so this one is NOT wrapped.
      await expect(payLink(LINK_A, 1)).to.be.revertedWithCustomError(integrator, "Paused");
      await expect(createLink(merchant1, LINK_B, linkAmount(1))).to.be.revertedWithCustomError(
        integrator,
        "Paused"
      );
      // Revoking must still work while paused — a merchant should always be able
      // to shut off a link.
      await expect(integrator.connect(merchant1).revokeLink(LINK_A)).to.emit(
        integrator,
        "LinkRevoked"
      );
    });

    it("emits OrderPlaced alongside LinkOrderPlaced, so existing indexers still see the sale", async function () {
      await createLink(merchant1, LINK_A, linkAmount(2));
      const tx = await payLink(LINK_A, 2);
      await expect(tx)
        .to.emit(integrator, "OrderPlaced")
        .and.to.emit(integrator, "LinkOrderPlaced");
    });

    it("records orderToMerchant so cancellation releases the daily slot, exactly like a POS sale", async function () {
      await createLink(merchant1, LINK_A, linkAmount(1));
      const tx = await payLink(LINK_A, 1);
      const rcpt = await tx.wait();
      const ev = rcpt.logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e: any) => e && e.name === "LinkOrderPlaced");

      const orderId = ev.args[1];
      expect(await integrator.orderToMerchant(orderId)).to.equal(merchant1.address);
    });
  });
});

/** Matches any uint in a withArgs assertion (orderId is assigned by the Diamond). */
const anyUint = (v: any) => {
  expect(v).to.be.a("bigint");
  return true;
};
