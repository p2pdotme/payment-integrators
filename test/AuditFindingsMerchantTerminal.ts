import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Proofs of concept for the merchant-terminal audit (Sept 2026).
 *
 * These tests DOCUMENT CURRENT BEHAVIOUR — each one passes today, and each
 * asserts the problematic outcome. The contract was deliberately not changed;
 * see docs/audits/merchant-terminal-2026-09.md for the suggested fixes. When a
 * fix lands, flip the matching assertion so the test pins the fixed behaviour.
 */

const SECTOR = ethers.encodeBytes32String("Retail");

async function deployLibs(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of ["PaymentLinksLib", "MerchantRegistryLib", "SettlementLib"]) {
    const F = await ethers.getContractFactory(name);
    const c = await F.deploy();
    await c.waitForDeployment();
    out[name] = await c.getAddress();
  }
  return out;
}

describe("Audit PoCs — merchant terminal", function () {
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

  // ─── M-1 ──────────────────────────────────────────────────────────
  it("M-1: abandoned link checkouts use up the merchant's daily limit and block their own till", async function () {
    // An unlimited, customer-entered-amount link — the standing counter QR.
    await integrator.connect(merchant).createLink(LINK, 0, INR, 0, 0, CONFIG);

    const limit = Number(await integrator.dailyLimit()); // 25
    // Each visitor who opens the pay page and walks away leaves a PLACED order.
    // Nobody marks it paid, nobody cancels; it waits for the Diamond's own expiry.
    for (let i = 0; i < limit; i++) await placeLinkOrder(1);

    // The merchant is now standing at their own counter and cannot take a sale.
    await expect(integrator.connect(merchant).userPlaceOrder(client.target, 1, 1, INR, 0, PK)).to.be
      .reverted; // DailyLimitReached, wrapped by UserProxy.CallFailed

    const [used] = await integrator.getDailyTxInfo(merchant.address);
    expect(used).to.equal(BigInt(limit));
  });

  // ─── H-1 ──────────────────────────────────────────────────────────
  it("H-1: a MANAGER can make itself trustedRelayer and cancel a customer's link order without the customer's signature", async function () {
    await integrator.connect(owner).setRole(manager.address, 3); // MANAGER
    await integrator.connect(merchant).createLink(LINK, 0, INR, 0, 0, CONFIG);
    await placeLinkOrder(5);
    const orderId = await lastLinkOrderId();

    // LinkRouter's promise: cancel needs the customer's own key. But the
    // integrator's only gate is `msg.sender == trustedRelayer`, and a MANAGER
    // can point that at any address it likes.
    await integrator.connect(manager).setTrustedRelayer(manager.address);
    await expect(integrator.connect(manager).relayerCancelOrder(LINK, orderId)).to.emit(
      integrator,
      "LinkOrderCancelled"
    );
  });

  it("H-1b: the same MANAGER passes deliverFiatPayout's authorisation, where it chooses the payout payload", async function () {
    await integrator.connect(owner).setRole(manager.address, 3);
    // Give the merchant an unlocked balance and a SELL waiting for delivery.
    await integrator.connect(merchant).userPlaceOrder(client.target, 1, 20, INR, 0, PK);
    await diamond.simulateOrderComplete((await diamond.nextOrderId()) - 1n);
    await time.increase(3600);
    const sellId = await diamond.nextOrderId();
    await integrator.connect(merchant).withdrawFiat(USDC(10), 1, PK, "");
    await diamond.acceptSellOrder(sellId, "lp");

    await integrator.connect(manager).setTrustedRelayer(manager.address);
    // `encPayout` is what the LP decrypts to know where to send the fiat.
    await expect(
      integrator.connect(manager).deliverFiatPayout(sellId, "manager-chosen-payload")
    ).to.emit(integrator, "WithdrawalUpiDelivered");
  });

  // ─── M-2 ──────────────────────────────────────────────────────────
  it("M-2: if setSellOrderUpi leaves the SELL in ACCEPTED, a retry charges the offramp fee twice", async function () {
    await integrator.connect(merchant).userPlaceOrder(client.target, 1, 40, INR, 0, PK);
    await diamond.simulateOrderComplete((await diamond.nextOrderId()) - 1n);
    await time.increase(3600);

    const FEE = USDC(1);
    await diamond.setSellFee(FEE);
    const sellId = await diamond.nextOrderId();
    await integrator.connect(merchant).withdrawFiat(USDC(10), 1, PK, "");
    await diamond.acceptSellOrder(sellId, "lp");
    const availBefore = (await integrator.getMerchantBalance(merchant.address))[1];

    // Diamond returns success but neither pulls nor moves the order.
    await diamond.setForceSellUpiNoOp(true);
    await integrator.connect(merchant).deliverFiatPayout(sellId, "p");
    await integrator.connect(merchant).deliverFiatPayout(sellId, "p"); // retry is allowed

    const availAfter = (await integrator.getMerchantBalance(merchant.address))[1];
    expect(availBefore - availAfter).to.equal(FEE * 2n); // charged twice
    expect((await integrator.withdrawals(sellId)).feeAdvanced).to.equal(FEE); // but only one recorded
  });

  // ─── L-1 ──────────────────────────────────────────────────────────
  it("L-1: revokeLink admits owners only, not the admin roles its docs name", async function () {
    await integrator.connect(owner).setRole(manager.address, 4); // even FINANCE
    await integrator.connect(merchant).createLink(LINK, 0, INR, 0, 0, CONFIG);
    await expect(integrator.connect(manager).revokeLink(LINK)).to.be.reverted;
    await expect(integrator.connect(owner).revokeLink(LINK)).to.emit(integrator, "LinkRevoked");
  });

  // ─── L-2 ──────────────────────────────────────────────────────────
  it("L-2: a lowercase currency code registers as a distinct currency with the 100 USDC default cap", async function () {
    await integrator.connect(other).registerMerchant(UPI, "Shop2", "inr", SECTOR);
    expect(await integrator.perTxCap(ethers.encodeBytes32String("inr"))).to.equal(USDC(100));
    expect(await integrator.perTxCap(INR)).to.equal(USDC(50));
  });

  // ─── L-3 ──────────────────────────────────────────────────────────
  it("L-3: shop name and link config are unbounded (sponsored gas pays for it)", async function () {
    const big = "x".repeat(20_000);
    await integrator.connect(other).registerMerchant(UPI, big, INR_CODE, SECTOR);
    const [, name] = await integrator.getMerchantInfo(other.address);
    expect(name.length).to.equal(20_000);
    await integrator
      .connect(merchant)
      .createLink(ethers.id("big"), 0, INR, 0, 0, ethers.hexlify(ethers.randomBytes(20_000)));
  });

  // ─── I-1 ──────────────────────────────────────────────────────────
  it("I-1: a merchant who registered without a payout handle cannot fix a typo in their shop name", async function () {
    await integrator.connect(other).registerMerchant("0x", "Tpyo", INR_CODE, SECTOR);
    await expect(
      integrator.connect(other).updateProfile("0x", "Typo", SECTOR)
    ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
  });
});
