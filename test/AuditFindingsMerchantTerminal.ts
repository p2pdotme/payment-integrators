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
});
