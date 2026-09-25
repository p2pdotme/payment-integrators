import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Regression tests for the merchant-terminal audit (Sept 2026).
 *
 * Each of these started life as a proof of concept that PASSED while the bug
 * was present (see docs/audits/merchant-terminal-2026-09.md). The fixes have
 * landed, so every assertion is flipped to pin the FIXED behaviour: if one of
 * these fails, a finding has come back.
 */

const SECTOR = ethers.encodeBytes32String("Retail");

async function deployLibs(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of [
    "PaymentLinksLib",
    "MerchantRegistryLib",
    "SettlementLib",
    "MerchantImportLib",
  ]) {
    const F = await ethers.getContractFactory(name);
    const c = await F.deploy();
    await c.waitForDeployment();
    out[name] = await c.getAddress();
  }
  return out;
}

describe("Audit 2026-09 regressions — merchant terminal", function () {
  let owner: SignerWithAddress;
  let merchant: SignerWithAddress;
  let relayer: SignerWithAddress;
  let manager: SignerWithAddress;
  let other: SignerWithAddress;

  let usdc: any;
  let diamond: any;
  let integrator: any;
  let client: any;

  const USDC = (n: number | string) => ethers.parseUnits(n.toString(), 6);
  const UNIT = USDC(1);
  const INR_CODE = "INR";
  const INR = ethers.encodeBytes32String("INR");
  const PK = "04" + "ab".repeat(64);
  const UPI = ethers.keccak256(ethers.toUtf8Bytes("enc-payout:shop@upi"));
  const CONFIG = "0x";
  const LINK = ethers.id("audit-link");

  beforeEach(async function () {
    [owner, merchant, relayer, manager, other] = await ethers.getSigners();
    usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    diamond = await (
      await ethers.getContractFactory("MockDiamond")
    ).deploy(await usdc.getAddress());
    const Integrator = await ethers.getContractFactory("MerchantTerminalIntegrator", {
      libraries: await deployLibs(),
    });
    integrator = await Integrator.deploy(await diamond.getAddress(), await usdc.getAddress(), []);
    client = await (
      await ethers.getContractFactory("SimpleERC721Client")
    ).deploy(await integrator.getAddress(), await usdc.getAddress(), "Item", "ITEM");
    await diamond.registerIntegrator(await integrator.getAddress(), await integrator.proxyImpl());
    await client.setProductPrice(1, UNIT);
    await usdc.mint(await diamond.getAddress(), USDC(100000));

    await integrator.connect(merchant).registerMerchant(UPI, "Shop", INR_CODE, SECTOR);
    await integrator.setTrustedRelayer(relayer.address);
  });

  const placeLinkOrder = (qty = 1) =>
    integrator.connect(relayer).relayerPlaceOrder(LINK, client.target, 1, qty, INR, 0, PK);

  async function lastLinkOrderId(): Promise<bigint> {
    const evs = await integrator.queryFilter(integrator.filters.LinkOrderPlaced());
    return evs[evs.length - 1].args[1];
  }

  /** Gives `merchant` an unlocked balance of `qty` USDC. */
  async function fund(qty: number) {
    await integrator.connect(merchant).userPlaceOrder(client.target, 1, qty, INR, 0, PK);
    await diamond.simulateOrderComplete((await diamond.nextOrderId()) - 1n);
    await time.increase(3600);
  }

  // ─── M-1 ──────────────────────────────────────────────────────────
  it("M-1: abandoned link checkouts no longer block the merchant's own till", async function () {
    await integrator.connect(merchant).createLink(LINK, 0, INR, 0, 0, CONFIG);
    const limit = Number(await integrator.dailyLimit()); // 25
    for (let i = 0; i < limit; i++) await placeLinkOrder(1);

    // 25 walk-aways later, the merchant can still sell at the counter.
    await expect(
      integrator.connect(merchant).userPlaceOrder(client.target, 1, 1, INR, 0, PK)
    ).to.emit(integrator, "OrderPlaced");
    const [used] = await integrator.getDailyTxInfo(merchant.address);
    expect(used).to.equal(1n);
  });

  // ─── H-1 ──────────────────────────────────────────────────────────
  it("H-1: a MANAGER can no longer make itself trustedRelayer", async function () {
    await integrator.connect(owner).setRole(manager.address, 3); // MANAGER
    await integrator.connect(merchant).createLink(LINK, 0, INR, 0, 0, CONFIG);
    await placeLinkOrder(5);
    const orderId = await lastLinkOrderId();

    await expect(
      integrator.connect(manager).setTrustedRelayer(manager.address)
    ).to.be.revertedWithCustomError(integrator, "OnlySuperAdmin");
    await expect(
      integrator.connect(manager).relayerCancelOrder(LINK, orderId)
    ).to.be.revertedWithCustomError(integrator, "OnlyTrustedRelayer");
  });

  it("H-1b: the relayer, whoever it is, cannot deliver a merchant's fiat payout", async function () {
    await fund(20);
    const sellId = await diamond.nextOrderId();
    await integrator.connect(merchant).withdrawFiat(USDC(10), 1, PK, "");
    await diamond.acceptSellOrder(sellId, "lp");

    // `relayer` IS the trusted relayer here, set by the super-admin.
    await expect(
      integrator.connect(relayer).deliverFiatPayout(sellId, "relayer-chosen-payload")
    ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    await expect(integrator.connect(merchant).deliverFiatPayout(sellId, "p")).to.emit(
      integrator,
      "WithdrawalUpiDelivered"
    );
  });

  // ─── M-2 ──────────────────────────────────────────────────────────
  it("M-2: a delivery the Diamond leaves in ACCEPTED reverts, so a retry cannot double-charge", async function () {
    await fund(40);
    const FEE = USDC(1);
    await diamond.setSellFee(FEE);
    const sellId = await diamond.nextOrderId();
    await integrator.connect(merchant).withdrawFiat(USDC(10), 1, PK, "");
    await diamond.acceptSellOrder(sellId, "lp");
    const availBefore = (await integrator.getMerchantBalance(merchant.address))[1];

    await diamond.setForceSellUpiNoOp(true);
    for (let i = 0; i < 2; i++) {
      await expect(
        integrator.connect(merchant).deliverFiatPayout(sellId, "p")
      ).to.be.revertedWithCustomError(integrator, "WithdrawalNotDeliverable");
    }
    expect((await integrator.getMerchantBalance(merchant.address))[1]).to.equal(availBefore);

    // Once the Diamond behaves, the SAME order delivers and charges one fee.
    await diamond.setForceSellUpiNoOp(false);
    await integrator.connect(merchant).deliverFiatPayout(sellId, "p");
    expect(availBefore - (await integrator.getMerchantBalance(merchant.address))[1]).to.equal(FEE);
    expect((await integrator.withdrawals(sellId)).feeAdvanced).to.equal(FEE);
  });

  // ─── L-1 ──────────────────────────────────────────────────────────
  it("L-1: SUPPORT-tier admins and above can revoke a link; VIEWER cannot", async function () {
    await integrator.connect(merchant).createLink(LINK, 0, INR, 0, 0, CONFIG);
    await integrator.connect(owner).setRole(other.address, 1); // VIEWER
    await expect(integrator.connect(other).revokeLink(LINK)).to.be.revertedWithCustomError(
      integrator,
      "NotLinkOwner"
    );
    await integrator.connect(owner).setRole(manager.address, 2); // SUPPORT
    await expect(integrator.connect(manager).revokeLink(LINK)).to.emit(integrator, "LinkRevoked");
  });

  // ─── L-2 ──────────────────────────────────────────────────────────
  it("L-2: currency codes must be uppercase A-Z, at registration and on links", async function () {
    for (const bad of ["inr", "In", "IN1", "I-R"]) {
      await expect(
        integrator.connect(other).registerMerchant(UPI, "Shop2", bad, SECTOR)
      ).to.be.revertedWithCustomError(integrator, "InvalidCurrency");
    }
    await expect(
      integrator
        .connect(merchant)
        .createLink(LINK, 0, ethers.encodeBytes32String("brl"), 0, 0, CONFIG)
    ).to.be.revertedWithCustomError(integrator, "InvalidCurrency");
    await integrator.connect(other).registerMerchant(UPI, "Shop2", "BRL", SECTOR);
  });

  // ─── L-3 ──────────────────────────────────────────────────────────
  it("L-3: shop name, payout blob and link config are length-capped", async function () {
    await expect(
      integrator.connect(other).registerMerchant(UPI, "x".repeat(129), INR_CODE, SECTOR)
    ).to.be.revertedWithCustomError(integrator, "FieldTooLong");
    await expect(
      integrator
        .connect(other)
        .registerMerchant(ethers.hexlify(ethers.randomBytes(1025)), "Shop", INR_CODE, SECTOR)
    ).to.be.revertedWithCustomError(integrator, "FieldTooLong");
    await expect(
      integrator
        .connect(merchant)
        .createLink(ethers.id("big"), 0, INR, 0, 0, ethers.hexlify(ethers.randomBytes(1025)))
    ).to.be.revertedWithCustomError(integrator, "FieldTooLong");
    await expect(
      integrator.connect(merchant).updateProfile("0x", "x".repeat(129), SECTOR)
    ).to.be.revertedWithCustomError(integrator, "FieldTooLong");

    // At the limits, everything is accepted.
    await integrator
      .connect(other)
      .registerMerchant(
        ethers.hexlify(ethers.randomBytes(1024)),
        "x".repeat(128),
        INR_CODE,
        SECTOR
      );
    await integrator
      .connect(merchant)
      .createLink(ethers.id("max"), 0, INR, 0, 0, ethers.hexlify(ethers.randomBytes(1024)));
  });

  // ─── I-1 ──────────────────────────────────────────────────────────
  it("I-1: a merchant without a payout handle can fix their shop name; a set handle is never blanked", async function () {
    await integrator.connect(other).registerMerchant("0x", "Tpyo", INR_CODE, SECTOR);
    await integrator.connect(other).updateProfile("0x", "Typo", SECTOR);
    expect((await integrator.getMerchantInfo(other.address))[1]).to.equal("Typo");

    await integrator.connect(merchant).updateProfile("0x", "Renamed", SECTOR);
    expect((await integrator.getMerchantInfo(merchant.address))[0]).to.equal(UPI);
  });

  // ─── I-3 ──────────────────────────────────────────────────────────
  it("I-3: recovering a stranded LINK buy clears its false-claim strike", async function () {
    await integrator.connect(merchant).createLink(LINK, 0, INR, 0, 0, CONFIG);
    await placeLinkOrder(3);
    const orderId = await lastLinkOrderId();
    await diamond.simulateOrderAccepted(orderId); // an LP took it
    await integrator.connect(relayer).relayerMarkPaid(LINK, orderId);
    expect((await integrator.getLink(LINK))[7]).to.equal(1n); // provisional strike

    // The Diamond completes the order, but the integrator callback never runs.
    await diamond.simulateOrderCompleteNoCallback(orderId);
    await integrator.connect(merchant).sweepStrandedBuy(orderId);

    expect((await integrator.getLink(LINK))[7]).to.equal(0n); // the claim was true
    expect(await integrator.orderToLink(orderId)).to.equal(ethers.ZeroHash);
  });

  // ─── Re-audit R-2 ─────────────────────────────────────────────────
  it("R-2: the order and fiat-withdrawal paths cap pubKey at 256 bytes", async function () {
    await integrator.connect(merchant).createLink(LINK, 0, INR, 0, 0, CONFIG);
    const long = "04" + "ab".repeat(128); // 258 chars
    await expect(
      integrator.connect(relayer).relayerPlaceOrder(LINK, client.target, 1, 1, INR, 0, long)
    ).to.be.revertedWithCustomError(integrator, "FieldTooLong");
    await expect(
      integrator.connect(merchant).userPlaceOrder(client.target, 1, 1, INR, 0, long)
    ).to.be.revertedWithCustomError(integrator, "FieldTooLong");
    await fund(10);
    await expect(
      integrator.connect(merchant).withdrawFiat(USDC(5), 1, long, "")
    ).to.be.revertedWithCustomError(integrator, "FieldTooLong");
    // A real key (130 hex chars) still works everywhere.
    await expect(placeLinkOrder(1)).to.emit(integrator, "LinkOrderPlaced");
  });

  // ─── PR #108 review, blocker #3 — link orders are bounded again ────
  describe("review #3: pending link orders keep link sales under dailyLimit", function () {
    // The reviewer's PoC, flipped: it used to pass with dailyTxCount = 100.
    it("orders placed before mark-paid can no longer complete past dailyLimit", async function () {
      await integrator.connect(merchant).createLink(LINK, 0, INR, 0, 0, CONFIG); // unlimited uses
      const limit = Number(await integrator.dailyLimit()); // 25
      const ids: bigint[] = [];
      for (let i = 0; i < limit * 4; i++) {
        try {
          await placeLinkOrder(1);
          ids.push(await lastLinkOrderId());
        } catch {
          // refused once paid + pending reaches the limit
        }
      }
      expect(ids.length).to.equal(limit); // only `limit` placements got through
      for (const id of ids) {
        await diamond.simulateOrderAccepted(id);
        await integrator.connect(relayer).relayerMarkPaid(LINK, id);
        await diamond.simulateOrderComplete(id);
      }
      const [used] = await integrator.getDailyTxInfo(merchant.address);
      expect(used).to.equal(BigInt(limit)); // was 100 before the fix
    });

    it("abandoned link orders never block counter (POS) sales", async function () {
      await integrator.connect(merchant).createLink(LINK, 0, INR, 0, 0, CONFIG);
      for (let i = 0; i < 25; i++) await placeLinkOrder(1);
      await expect(placeLinkOrder(1)).to.be.reverted; // link room used up (pending)
      await expect(
        integrator.connect(merchant).userPlaceOrder(client.target, 1, 1, INR, 0, PK)
      ).to.emit(integrator, "OrderPlaced"); // the till still works
    });

    it("a cancelled pending order frees its reservation", async function () {
      await integrator.connect(merchant).createLink(LINK, 0, INR, 0, 0, CONFIG);
      for (let i = 0; i < 25; i++) await placeLinkOrder(1);
      await expect(placeLinkOrder(1)).to.be.reverted;
      await diamond.simulateOrderCancelled(await lastLinkOrderId()); // the Diamond's cancel callback
      await expect(placeLinkOrder(1)).to.emit(integrator, "LinkOrderPlaced");
    });

    it("pending reservations expire with the UTC day", async function () {
      await integrator.connect(merchant).createLink(LINK, 0, INR, 0, 0, CONFIG);
      for (let i = 0; i < 25; i++) await placeLinkOrder(1);
      await expect(placeLinkOrder(1)).to.be.reverted;
      await time.increase(86400);
      await expect(placeLinkOrder(1)).to.emit(integrator, "LinkOrderPlaced");
    });

    it("a link order completed WITHOUT mark-paid (dispute path) still frees its reservation", async function () {
      await integrator.connect(merchant).createLink(LINK, 0, INR, 0, 0, CONFIG);
      for (let i = 0; i < 25; i++) await placeLinkOrder(1);
      await diamond.simulateOrderComplete(await lastLinkOrderId()); // no relayerMarkPaid
      await expect(placeLinkOrder(1)).to.emit(integrator, "LinkOrderPlaced");
    });
  });

  // ─── PR #108 review, blocker #4 — a range around the limits ──────
  // FINANCE admins / owners / super-admin set a [min, max] range; MANAGER
  // admins move the limits inside it. Starting range 1-25 a day, 1-100 USDC.
  describe("review #4: limit range (min/max) set by FINANCE/owners, limits by MANAGER", function () {
    let finance: SignerWithAddress;
    beforeEach(async function () {
      finance = (await ethers.getSigners())[6];
      await integrator.connect(owner).setRole(manager.address, 3); // MANAGER
      await integrator.connect(owner).setRole(finance.address, 4); // FINANCE
    });

    it("starts at 1-25 orders a day and 1-100 USDC a sale", async function () {
      const [minD, maxD, minC, maxC] = await integrator.limitBounds();
      expect([minD, maxD, minC, maxC]).to.deep.equal([1n, 25n, USDC(1), USDC(100)]);
    });

    it("a MANAGER moves limits inside the range, never outside it", async function () {
      await integrator.connect(manager).setDailyLimit(10);
      await integrator.connect(manager).setDailyLimit(25); // = max: fine
      await integrator.connect(manager).setPerTxCap(INR, USDC(100)); // = max: fine
      await integrator.connect(manager).setPerTxCap(INR, USDC(1)); // = min: fine
      for (const bad of [0, 26, 1000])
        await expect(integrator.connect(manager).setDailyLimit(bad)).to.be.revertedWithCustomError(
          integrator,
          "LimitOutOfBounds"
        );
      for (const bad of [USDC("0.5"), USDC("100.000001"), USDC(5000)])
        await expect(
          integrator.connect(manager).setPerTxCap(INR, bad)
        ).to.be.revertedWithCustomError(integrator, "LimitOutOfBounds");
      await integrator.connect(manager).setPerTxCap(INR, 0); // clearing an override is always allowed
      expect(await integrator.perTxCap(INR)).to.equal(USDC(50)); // back to the INR default
    });

    it("a MANAGER cannot change the range — so the max is a real ceiling for them", async function () {
      await expect(
        integrator.connect(manager).setLimitBounds(1, 1000, USDC(1), USDC(5000))
      ).to.be.revertedWithCustomError(integrator, "NotAuthorized");
      await integrator.connect(owner).setRole(other.address, 2); // SUPPORT
      await expect(
        integrator.connect(other).setLimitBounds(1, 1000, USDC(1), USDC(5000))
      ).to.be.revertedWithCustomError(integrator, "NotAuthorized");
      await expect(
        integrator.connect(merchant).setLimitBounds(1, 1000, USDC(1), USDC(5000))
      ).to.be.revertedWithCustomError(integrator, "NotAuthorized");
    });

    it("a FINANCE admin, an owner and the super-admin can all change the range", async function () {
      await expect(integrator.connect(finance).setLimitBounds(1, 1000, USDC(1), USDC(5000)))
        .to.emit(integrator, "LimitBoundsSet")
        .withArgs(1, 1000, USDC(1), USDC(5000));
      await integrator.connect(owner).addOwner(other.address);
      await integrator.connect(other).setLimitBounds(2, 500, USDC(2), USDC(2000));
      await integrator.connect(owner).setLimitBounds(1, 800, USDC(1), USDC(3000)); // super-admin
      expect((await integrator.limitBounds())[1]).to.equal(800n);
    });

    it("raising the max lets a MANAGER raise the limit — any number the range allows", async function () {
      await integrator.connect(finance).setLimitBounds(1, 1000, USDC(1), USDC(5000));
      await integrator.connect(manager).setDailyLimit(1000);
      await integrator.connect(manager).setPerTxCap(INR, USDC(5000));
      expect(await integrator.dailyLimit()).to.equal(1000n);
      expect(await integrator.perTxCap(INR)).to.equal(USDC(5000));
      // …and link sales follow the new limit (review #3 bound moves with it).
      await integrator.connect(manager).setDailyLimit(40);
      await integrator.connect(merchant).createLink(LINK, 0, INR, 0, 0, CONFIG);
      for (let i = 0; i < 40; i++) await placeLinkOrder(1);
      await expect(placeLinkOrder(1)).to.be.reverted; // 41st refused at the new limit
    });

    it("narrowing the range takes effect at once, for the daily limit and every per-tx cap", async function () {
      await integrator.connect(manager).setDailyLimit(20);
      const BRL = ethers.encodeBytes32String("BRL");
      await integrator.connect(manager).setPerTxCap(BRL, USDC(90)); // an existing override
      await expect(integrator.connect(finance).setLimitBounds(1, 5, USDC(1), USDC(30)))
        .to.emit(integrator, "DailyLimitSet")
        .withArgs(5); // the live limit is pulled down into the range
      expect(await integrator.dailyLimit()).to.equal(5n);
      expect(await integrator.perTxCap(INR)).to.equal(USDC(30)); // default 50 → capped at 30
      expect(await integrator.perTxCap(BRL)).to.equal(USDC(30)); // override 90 → capped at 30
      await integrator.connect(merchant).createLink(LINK, 0, INR, 0, 0, CONFIG);
      await expect(placeLinkOrder(31)).to.be.reverted; // over the new cap
      await placeLinkOrder(30);
      // Raising the min pulls limits up the same way.
      await integrator.connect(finance).setLimitBounds(10, 50, USDC(40), USDC(100));
      expect(await integrator.dailyLimit()).to.equal(10n);
      expect(await integrator.perTxCap(INR)).to.equal(USDC(50)); // default back inside [40, 100]
    });

    it("refuses a broken range", async function () {
      const bad: [number | bigint, number | bigint, bigint, bigint][] = [
        [0, 10, USDC(1), USDC(100)], // min daily 0 would allow blocking every sale
        [11, 10, USDC(1), USDC(100)], // min > max
        [1, 10, 0n, USDC(100)], // min cap 0
        [1, 10, USDC(101), USDC(100)], // min > max
        [1, 2n ** 64n, USDC(1), USDC(100)], // does not fit the stored uint64
        [1, 10, USDC(1), 2n ** 64n],
      ];
      for (const [a, b, c, d] of bad)
        await expect(
          integrator.connect(finance).setLimitBounds(a, b, c, d)
        ).to.be.revertedWithCustomError(integrator, "LimitOutOfBounds");
    });
  });
});
