import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * p2p.me's user blacklist applies to PayQR purchases too.
 *
 * The Diamond checks `ReputationManager.rmusers(user).isBlacklisted` before a
 * consumer BUY, but skips it for integrator orders and leaves the check to the
 * integrator's `validateOrder`. Without it, a wallet p2p.me has blacklisted
 * could register as a PayQR merchant and keep buying through the POS flow.
 *
 * Covered: POS and link orders refused for a blacklisted merchant, a link
 * order refused for a blacklisted merchant proxy, a lift taking effect on the
 * next order, withdrawals (SELL) left open as on p2p.me, a Diamond without the
 * getter (Base Sepolia) skipped, and a manager that does not answer stopping
 * the order.
 */
describe("MerchantTerminalIntegrator — p2p.me blacklist", function () {
  let merchant1: SignerWithAddress;
  let merchant2: SignerWithAddress;
  let relayer: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let rm: any;
  let integrator: any;
  let client: any;

  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
  const UNIT_PRICE = USDC(10);
  const PRODUCT_ID = 1;
  const INR = ethers.encodeBytes32String("INR");
  const SECTOR = ethers.encodeBytes32String("Retail");
  const PK = "04" + "ab".repeat(64);
  const CONFIG = ethers.hexlify(ethers.toUtf8Bytes("encrypted-config-blob"));
  const LINK_A = ethers.id("link-a");
  const enc = (label: string) => ethers.keccak256(ethers.toUtf8Bytes("enc-payout:" + label));

  async function deployLibs(): Promise<Record<string, string>> {
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

  /** validateOrder runs inside the Diamond call, so UserProxy wraps its revert as CallFailed(bytes). */
  async function expectBlacklisted(tx: Promise<any>, account: string) {
    const proxyArtifact = await ethers.getContractFactory("UserProxy");
    const inner = integrator.interface.encodeErrorResult("UserBlacklisted", [account]);
    await expect(tx).to.be.revertedWithCustomError(proxyArtifact, "CallFailed").withArgs(inner);
  }

  const posOrder = (as: SignerWithAddress, qty = 1) =>
    integrator.connect(as).userPlaceOrder(client.target, PRODUCT_ID, qty, INR, 1, "");
  const linkOrder = (linkId: string, qty = 1) =>
    integrator
      .connect(relayer)
      .relayerPlaceOrder(linkId, client.target, PRODUCT_ID, qty, INR, 0, PK);

  beforeEach(async function () {
    [, merchant1, merchant2, relayer] = await ethers.getSigners();

    mockUsdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    mockDiamond = await (
      await ethers.getContractFactory("MockDiamond")
    ).deploy(await mockUsdc.getAddress());
    rm = await (await ethers.getContractFactory("MockReputationManager")).deploy();
    await mockDiamond.setReputationManager(await rm.getAddress());

    const Integrator = await ethers.getContractFactory("MerchantTerminalIntegrator", {
      libraries: await deployLibs(),
    });
    integrator = await Integrator.deploy(
      await mockDiamond.getAddress(),
      await mockUsdc.getAddress(),
      []
    );
    client = await (
      await ethers.getContractFactory("SimpleERC721Client")
    ).deploy(await integrator.getAddress(), await mockUsdc.getAddress(), "Digital Item", "ITEM");

    await mockDiamond.registerIntegrator(
      await integrator.getAddress(),
      await integrator.proxyImpl()
    );
    await client.setProductPrice(PRODUCT_ID, UNIT_PRICE);
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(100000));

    await integrator
      .connect(merchant1)
      .registerMerchant(enc("shop1@upi"), "Shop One", "INR", SECTOR);
    await integrator
      .connect(merchant2)
      .registerMerchant(enc("shop2@upi"), "Shop Two", "INR", SECTOR);
    await integrator.setTrustedRelayer(relayer.address);
  });

  it("refuses a POS order from a blacklisted merchant; other merchants are unaffected", async function () {
    await rm.setBlacklisted(merchant1.address, true);
    await expectBlacklisted(posOrder(merchant1), merchant1.address);
    await expect(posOrder(merchant2)).to.emit(integrator, "OrderPlaced");
  });

  it("does not use a daily slot for the refused order", async function () {
    await rm.setBlacklisted(merchant1.address, true);
    await expectBlacklisted(posOrder(merchant1), merchant1.address);
    await rm.setBlacklisted(merchant1.address, false);
    const [count] = await integrator.getDailyTxInfo(merchant1.address);
    expect(count).to.equal(0);
  });

  it("refuses a link order on a blacklisted merchant's link", async function () {
    await integrator.connect(merchant1).createLink(LINK_A, UNIT_PRICE, INR, 0, 1, CONFIG);
    await rm.setBlacklisted(merchant1.address, true);
    await expectBlacklisted(linkOrder(LINK_A), merchant1.address);
    // The refused order did not take the link's single use.
    await rm.setBlacklisted(merchant1.address, false);
    await expect(linkOrder(LINK_A)).to.emit(integrator, "LinkOrderPlaced");
  });

  it("refuses a link order when p2p.me blacklisted the merchant's proxy (order.user)", async function () {
    await integrator.connect(merchant1).createLink(LINK_A, UNIT_PRICE, INR, 0, 0, CONFIG);
    const proxy = await integrator.proxyAddress(merchant1.address);
    await rm.setBlacklisted(proxy, true);
    await expectBlacklisted(linkOrder(LINK_A), proxy);
  });

  it("a lift on p2p.me applies from the next order", async function () {
    await rm.setBlacklisted(merchant1.address, true);
    await expectBlacklisted(posOrder(merchant1), merchant1.address);
    await rm.setBlacklisted(merchant1.address, false);
    await expect(posOrder(merchant1)).to.emit(integrator, "OrderPlaced");
  });

  it("leaves withdrawals open, as p2p.me does for a blacklisted wallet's SELL", async function () {
    const tx = await posOrder(merchant1, 2);
    await tx.wait();
    const evs = await integrator.queryFilter(integrator.filters.OrderPlaced());
    await mockDiamond.simulateOrderComplete(evs[evs.length - 1].args.orderId);
    const settlement = Number(await integrator.settlementPeriod());
    await ethers.provider.send("evm_increaseTime", [settlement + 3600]);
    await ethers.provider.send("evm_mine", []);

    const proxy = await integrator.proxyAddress(merchant1.address);
    await rm.setBlacklisted(merchant1.address, true);
    await rm.setBlacklisted(proxy, true);
    await expect(integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "")).to.emit(
      integrator,
      "WithdrawalFiat"
    );
  });

  it("skips the check on a Diamond without the getter (Base Sepolia)", async function () {
    await rm.setBlacklisted(merchant1.address, true);
    await mockDiamond.setNoReputationGetter(true);
    await expect(posOrder(merchant1)).to.emit(integrator, "OrderPlaced");
  });

  it("skips the check when the Diamond has no ReputationManager set", async function () {
    await rm.setBlacklisted(merchant1.address, true);
    await mockDiamond.setReputationManager(ethers.ZeroAddress);
    await expect(posOrder(merchant1)).to.emit(integrator, "OrderPlaced");
  });

  it("stops the order when the ReputationManager is set but does not answer", async function () {
    // A contract with no rmusers() in the manager's place: the read reverts.
    await mockDiamond.setReputationManager(await mockUsdc.getAddress());
    const proxyArtifact = await ethers.getContractFactory("UserProxy");
    await expect(posOrder(merchant2)).to.be.revertedWithCustomError(proxyArtifact, "CallFailed");
  });
});
