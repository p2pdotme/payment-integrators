import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * Carrying merchants over from previous integrators (MerchantImportLib).
 *
 * The promise under test: after an upgrade, a merchant registered on an older
 * integrator does NOT register again — their record (shop name, currency,
 * sector, payout handle) is copied on first use — and a merchant FROZEN there
 * arrives frozen here and cannot escape the freeze by registering fresh.
 */

const SECTOR = ethers.encodeBytes32String("Salon");
const INR = ethers.encodeBytes32String("INR");
const BRL = ethers.encodeBytes32String("BRL");
const PK = "04" + "ab".repeat(64);
const USDC = (n: number) => ethers.parseUnits(String(n), 6);

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

describe("MerchantImport — no re-registration after an upgrade", function () {
  let owner: SignerWithAddress;
  let shopA: SignerWithAddress; // on the old integrator, with sector + payout
  let shopFrozen: SignerWithAddress; // frozen on the old integrator
  let shopOldest: SignerWithAddress; // only on the oldest (no sector)
  let fresh: SignerWithAddress; // never registered anywhere
  let manager: SignerWithAddress;

  let usdc: any, diamond: any, client: any;
  let oldI: any, newI: any, oldest: any;
  const PAYOUT = ethers.hexlify(ethers.toUtf8Bytes("encrypted-upi-blob"));

  async function deployIntegrator() {
    const F = await ethers.getContractFactory("MerchantTerminalIntegrator", {
      libraries: await deployLibs(),
    });
    const i: any = await F.deploy(await diamond.getAddress(), await usdc.getAddress(), []);
    await diamond.registerIntegrator(await i.getAddress(), await i.proxyImpl());
    return i;
  }

  beforeEach(async function () {
    [owner, shopA, shopFrozen, shopOldest, fresh, manager] = await ethers.getSigners();
    usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    diamond = await (
      await ethers.getContractFactory("MockDiamond")
    ).deploy(await usdc.getAddress());
    await usdc.mint(await diamond.getAddress(), USDC(100000));

    // The OLD integrator: a real one, as deployed today.
    oldI = await deployIntegrator();
    await oldI.connect(shopA).registerMerchant(PAYOUT, "Wissdom", "INR", SECTOR);
    await oldI.connect(shopFrozen).registerMerchant("0x", "Frozen Shop", "INR", SECTOR);
    await oldI.connect(owner).freezeMerchant(shopFrozen.address);

    // The OLDEST shape: no sector, 5-value getMerchantInfo.
    oldest = await (await ethers.getContractFactory("MockOldestIntegrator")).deploy();
    await oldest.seed(shopOldest.address, PAYOUT, "Oldest Shop", BRL, false);
    // shopA exists on the oldest too, under a different name — newest must win.
    await oldest.seed(shopA.address, "0x", "OLD NAME", BRL, false);

    // The NEW integrator, told about both, newest first.
    newI = await deployIntegrator();
    await newI.setPreviousIntegrators([await oldI.getAddress(), await oldest.getAddress()]);

    client = await (
      await ethers.getContractFactory("SimpleERC721Client")
    ).deploy(await newI.getAddress(), await usdc.getAddress(), "Item", "ITEM");
    await client.setProductPrice(1, USDC(1));
  });

  const sale = (who: SignerWithAddress) =>
    newI.connect(who).userPlaceOrder(client.target, 1, 2, INR, 0, PK);

  it("a returning merchant makes a sale with NO registration — their record is copied", async function () {
    expect(await newI.registered(shopA.address)).to.equal(false);
    await expect(sale(shopA))
      .to.emit(newI, "MerchantImported")
      .withArgs(shopA.address, await oldI.getAddress(), false)
      .and.to.emit(newI, "OrderPlaced");

    expect(await newI.registered(shopA.address)).to.equal(true);
    const [payout, name, currency, isReg, frozen, sector] = await newI.getMerchantInfo(
      shopA.address
    );
    expect(name).to.equal("Wissdom"); // from the NEWEST previous, not "OLD NAME"
    expect(currency).to.equal(INR);
    expect(sector).to.equal(SECTOR);
    expect(payout).to.equal(PAYOUT);
    expect(isReg).to.equal(true);
    expect(frozen).to.equal(false);
  });

  it("a returning merchant can create a payment link with no registration", async function () {
    await expect(newI.connect(shopA).createLink(ethers.id("l1"), 0, INR, 0, 0, "0x")).to.emit(
      newI,
      "MerchantImported"
    );
    expect(await newI.getMerchantLinkCount(shopA.address)).to.equal(1n);
  });

  it("a returning merchant cannot register fresh — the old record is used instead", async function () {
    await expect(
      newI.connect(shopA).registerMerchant("0x", "A New Name", "BRL", SECTOR)
    ).to.be.revertedWithCustomError(newI, "AlreadyRegistered");
  });

  it("a merchant FROZEN on the old integrator arrives frozen and cannot register fresh", async function () {
    // Every way in is refused…
    await expect(sale(shopFrozen)).to.be.reverted; // MerchantIsFrozen inside the Diamond call
    await expect(
      newI.connect(shopFrozen).createLink(ethers.id("l2"), 0, INR, 0, 0, "0x")
    ).to.be.revertedWithCustomError(newI, "MerchantIsFrozen");
    await expect(
      newI.connect(shopFrozen).registerMerchant("0x", "Totally New Shop", "INR", SECTOR)
    ).to.be.revertedWithCustomError(newI, "AlreadyRegistered");

    // …and an explicit import records them as frozen here too.
    await expect(newI.importMerchant(shopFrozen.address))
      .to.emit(newI, "MerchantImported")
      .withArgs(shopFrozen.address, await oldI.getAddress(), true);
    const [, , , frozen] = await newI.getMerchantBalance(shopFrozen.address);
    expect(frozen).to.equal(true);
    expect(await newI.escheatableAt(shopFrozen.address)).to.be.greaterThan(0n);
  });

  it("an admin can unfreeze an imported merchant on the new integrator", async function () {
    await newI.importMerchant(shopFrozen.address);
    await newI.connect(owner).unfreezeMerchant(shopFrozen.address);
    await expect(sale(shopFrozen)).to.emit(newI, "OrderPlaced");
  });

  it("a merchant from the OLDEST contract (no sector) is imported with 'Unspecified'", async function () {
    await expect(newI.importMerchant(shopOldest.address))
      .to.emit(newI, "MerchantImported")
      .withArgs(shopOldest.address, await oldest.getAddress(), false);
    const [payout, name, currency, , , sector] = await newI.getMerchantInfo(shopOldest.address);
    expect(name).to.equal("Oldest Shop");
    expect(currency).to.equal(BRL);
    expect(payout).to.equal(PAYOUT);
    expect(ethers.decodeBytes32String(sector)).to.equal("Unspecified");
    // …and can fix it themselves.
    await newI
      .connect(shopOldest)
      .updateProfile("0x", "Oldest Shop", ethers.encodeBytes32String("Bakery"));
    expect((await newI.getMerchantInfo(shopOldest.address))[5]).to.equal(
      ethers.encodeBytes32String("Bakery")
    );
  });

  it("an imported lowercase currency is normalised to uppercase (review)", async function () {
    const [, , , , , , , legacy] = await ethers.getSigners();
    await oldest.seed(
      legacy.address,
      "0x",
      "Legacy Shop",
      ethers.encodeBytes32String("inr"),
      false
    );
    await newI.importMerchant(legacy.address);
    expect((await newI.getMerchantInfo(legacy.address))[2]).to.equal(INR);
  });

  it("import is idempotent and never overwrites a record already here", async function () {
    await newI.importMerchant(shopA.address);
    await newI.connect(shopA).updateProfile("0x", "Renamed Here", SECTOR);
    expect(await newI.importMerchant.staticCall(shopA.address)).to.equal(false);
    await expect(newI.importMerchant(shopA.address)).to.not.emit(newI, "MerchantImported");
    expect((await newI.getMerchantInfo(shopA.address))[1]).to.equal("Renamed Here");
  });

  it("a brand-new merchant still registers normally, and an unknown address imports nothing", async function () {
    expect(await newI.importMerchant.staticCall(fresh.address)).to.equal(false);
    await expect(newI.connect(fresh).registerMerchant("0x", "Fresh", "INR", SECTOR)).to.emit(
      newI,
      "MerchantRegistered"
    );
  });

  it("with NO previous integrators set, nothing is imported and old rules apply", async function () {
    const plain = await deployIntegrator();
    await expect(
      plain.connect(shopA).createLink(ethers.id("l3"), 0, INR, 0, 0, "0x")
    ).to.be.revertedWithCustomError(plain, "NotRegistered");
    expect(await plain.importMerchant.staticCall(shopA.address)).to.equal(false);
  });

  it("a previous address that is not an integrator (EOA, other contract) is skipped, never reverts", async function () {
    const plain = await deployIntegrator();
    await plain.setPreviousIntegrators([
      manager.address,
      await usdc.getAddress(),
      await oldI.getAddress(),
    ]);
    await expect(plain.importMerchant(shopA.address))
      .to.emit(plain, "MerchantImported")
      .withArgs(shopA.address, await oldI.getAddress(), false);
  });

  it("setPreviousIntegrators: super-admin only, once, 1-5 real addresses", async function () {
    const plain = await deployIntegrator();
    const o = await oldI.getAddress();
    await plain.setRole(manager.address, 4); // even FINANCE can't
    await expect(plain.connect(manager).setPreviousIntegrators([o])).to.be.revertedWithCustomError(
      plain,
      "OnlySuperAdmin"
    );
    await expect(plain.setPreviousIntegrators([])).to.be.reverted;
    await expect(plain.setPreviousIntegrators([ethers.ZeroAddress])).to.be.reverted;
    await expect(plain.setPreviousIntegrators([await plain.getAddress()])).to.be.reverted;
    await expect(plain.setPreviousIntegrators([o, o, o, o, o, o])).to.be.reverted;
    await plain.setPreviousIntegrators([o]);
    await expect(plain.setPreviousIntegrators([o])).to.be.reverted; // only once
  });
});
