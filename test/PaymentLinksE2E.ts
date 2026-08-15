import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * End-to-end: the money actually moves.
 *
 * The unit suite proves each guard in isolation. This one runs the whole
 * Ramesh → Priya story against the mock Diamond — link created, paid by a
 * walletless customer through the relayer, settled, locked, unlocked,
 * withdrawn — and asserts real USDC balances at every step.
 *
 * The claim under test is settlement PARITY: a link sale must land in the
 * merchant's balance on exactly the same terms as an in-person sale. If links
 * changed lock timing or credited a different amount, this is where it shows.
 */
describe("MerchantTerminalIntegrator — payment links, end to end", function () {
  let owner: SignerWithAddress;
  let ramesh: SignerWithAddress; // the merchant
  let relayer: SignerWithAddress; // the Worker's wallet
  let lp: SignerWithAddress; // liquidity provider

  let mockUsdc: any;
  let mockDiamond: any;
  let integrator: any;
  let client: any;

  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
  const UNIT_PRICE = USDC(1); // 1 USDC per unit — a link for 3 = 3 USDC
  const PRODUCT_ID = 1;
  const INR = ethers.encodeBytes32String("INR");
  const PK = "04" + "ab".repeat(64);
  const CONFIG = ethers.hexlify(ethers.toUtf8Bytes("enc:{orderRef:47}"));
  const LINK = ethers.id("ramesh-saree-order-47");

  let SETTLEMENT: number;

  beforeEach(async function () {
    [owner, ramesh, relayer, lp] = await ethers.getSigners();

    mockUsdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    mockDiamond = await (
      await ethers.getContractFactory("MockDiamond")
    ).deploy(await mockUsdc.getAddress());

    integrator = await (
      await ethers.getContractFactory("MerchantTerminalIntegrator")
    ).deploy(await mockDiamond.getAddress(), await mockUsdc.getAddress(), []);
    SETTLEMENT = Number(await integrator.SETTLEMENT_PERIOD());

    client = await (
      await ethers.getContractFactory("SimpleERC721Client")
    ).deploy(await integrator.getAddress(), await mockUsdc.getAddress(), "Saree", "SAREE");

    await mockDiamond.registerIntegrator(
      await integrator.getAddress(),
      await integrator.proxyImpl()
    );
    await client.setProductPrice(PRODUCT_ID, UNIT_PRICE);
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(1_000_000));

    await integrator
      .connect(ramesh)
      .registerMerchant(
        ethers.keccak256(ethers.toUtf8Bytes("enc:ramesh@upi")),
        "Ramesh Sarees",
        "INR"
      );
    await integrator.setTrustedRelayer(relayer.address);
  });

  /** Drives the mock Diamond through the LP-side completion of a BUY. */
  async function completeOrder(orderId: bigint, _amount: bigint) {
    await mockDiamond.connect(lp).simulateOrderComplete(orderId);
  }

  function balances(who: string) {
    return integrator.getMerchantBalance(who);
  }

  it("the full story: create → pay → settle → unlock → withdraw", async function () {
    // ── 1. Ramesh creates a ₹3,000 single-use link, expiring in 7 days ──
    const expiresAt = (await time.latest()) + 7 * 86400;
    await expect(
      integrator.connect(ramesh).createLink(LINK, USDC(3), INR, expiresAt, true, CONFIG)
    ).to.emit(integrator, "LinkCreated");

    // The pay page reads this with no signature from Ramesh available.
    expect(await integrator.isLinkActive(LINK)).to.equal(true);
    const view = await integrator.getLink(LINK);
    expect(view[0]).to.equal(ramesh.address);
    expect(view[1]).to.equal(USDC(3));

    // Nothing has moved yet.
    let bal = await balances(ramesh.address);
    expect(bal[0]).to.equal(0n); // pending
    expect(bal[1]).to.equal(0n); // available

    // ── 2. Priya taps Pay. She has no wallet; the relayer signs. ──
    const tx = await integrator
      .connect(relayer)
      .relayerPlaceOrder(LINK, client.target, PRODUCT_ID, 3, INR, 0, PK);
    const rcpt = await tx.wait();

    const placed = rcpt.logs
      .map((l: any) => {
        try {
          return integrator.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e: any) => e && e.name === "LinkOrderPlaced");

    expect(placed, "LinkOrderPlaced must be emitted").to.not.be.undefined;
    const orderId: bigint = placed.args[1];
    expect(placed.args[2]).to.equal(ramesh.address); // credited merchant
    expect(placed.args[3]).to.equal(USDC(3));

    // The link self-consumed — a forwarded URL is now dead.
    expect(await integrator.isLinkActive(LINK)).to.equal(false);
    expect((await integrator.getLink(LINK))[6]).to.equal(1);

    // ── 3. Priya pays UPI; the LP completes the order on-chain. ──
    await completeOrder(orderId, USDC(3));

    bal = await balances(ramesh.address);
    expect(bal[0], "3 USDC must be PENDING under the settlement lock").to.equal(USDC(3));
    expect(bal[1], "nothing is withdrawable yet").to.equal(0n);
    expect(bal[2]).to.equal(USDC(3)); // totalDeposited

    // The integrator physically holds the USDC.
    expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(USDC(3));

    // ── 4. The lock expires on the ordinary schedule. ──
    await time.increase(SETTLEMENT + 1);

    bal = await balances(ramesh.address);
    expect(bal[0]).to.equal(0n);
    expect(bal[1], "now fully withdrawable").to.equal(USDC(3));

    // ── 5. Ramesh withdraws to his own wallet. ──
    const before = await mockUsdc.balanceOf(ramesh.address);
    await integrator.connect(ramesh).withdrawUSDC(USDC(3));
    const after = await mockUsdc.balanceOf(ramesh.address);

    expect(after - before, "the merchant received exactly the sale amount").to.equal(USDC(3));
    expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(0n);

    bal = await balances(ramesh.address);
    expect(bal[0]).to.equal(0n);
    expect(bal[1]).to.equal(0n);
  });

  it("settlement parity: a link sale and a POS sale unlock at the same moment", async function () {
    await integrator.connect(ramesh).createLink(LINK, USDC(5), INR, 0, false, CONFIG);

    // Two sales in the same block-ish window: one through the link, one at the
    // counter. If links changed lock timing, these would diverge.
    const linkTx = await integrator
      .connect(relayer)
      .relayerPlaceOrder(LINK, client.target, PRODUCT_ID, 5, INR, 0, PK);
    const posTx = await integrator
      .connect(ramesh)
      .userPlaceOrder(client.target, PRODUCT_ID, 5, INR, 0, PK);

    const idOf = async (t: any, name: string) => {
      const r = await t.wait();
      const ev = r.logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e: any) => e && e.name === name);
      return name === "LinkOrderPlaced" ? ev.args[1] : ev.args[0];
    };

    await completeOrder(await idOf(linkTx, "LinkOrderPlaced"), USDC(5));
    await completeOrder(await idOf(posTx, "OrderPlaced"), USDC(5));

    let bal = await balances(ramesh.address);
    expect(bal[0], "both sales pending together").to.equal(USDC(10));
    expect(bal[1]).to.equal(0n);

    // One second before the lock expires: still nothing available.
    await time.increase(SETTLEMENT - 10);
    bal = await balances(ramesh.address);
    expect(bal[1], "still locked just before the boundary").to.equal(0n);

    // Past the boundary: BOTH unlock, together.
    await time.increase(20);
    bal = await balances(ramesh.address);
    expect(bal[1], "link and POS unlock on the same schedule").to.equal(USDC(10));
  });

  it("a reusable link takes many payments and each one settles", async function () {
    await integrator.connect(ramesh).createLink(LINK, USDC(2), INR, 0, false, CONFIG);

    const ids: bigint[] = [];
    for (let i = 0; i < 4; i++) {
      const t = await integrator
        .connect(relayer)
        .relayerPlaceOrder(LINK, client.target, PRODUCT_ID, 2, INR, 0, PK);
      const r = await t.wait();
      const ev = r.logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e: any) => e && e.name === "LinkOrderPlaced");
      ids.push(ev.args[1]);
    }

    expect((await integrator.getLink(LINK))[6]).to.equal(4);
    expect(await integrator.isLinkActive(LINK)).to.equal(true);

    for (const id of ids) await completeOrder(id, USDC(2));

    const bal = await balances(ramesh.address);
    expect(bal[0], "4 x 2 USDC all credited").to.equal(USDC(8));

    await time.increase(SETTLEMENT + 1);
    await integrator.connect(ramesh).withdrawUSDC(USDC(8));
    expect(await mockUsdc.balanceOf(ramesh.address)).to.equal(USDC(8));
  });

  it("a cancelled link order credits nothing and releases the daily slot", async function () {
    await integrator.setDailyLimit(2);
    await integrator.connect(ramesh).createLink(LINK, USDC(1), INR, 0, false, CONFIG);

    const t = await integrator
      .connect(relayer)
      .relayerPlaceOrder(LINK, client.target, PRODUCT_ID, 1, INR, 0, PK);
    const r = await t.wait();
    const ev = r.logs
      .map((l: any) => {
        try {
          return integrator.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e: any) => e && e.name === "LinkOrderPlaced");
    const orderId = ev.args[1];

    // Priya abandons the payment; the Diamond cancels.
    await mockDiamond.simulateOrderCancelled(orderId);

    const bal = await balances(ramesh.address);
    expect(bal[0], "an abandoned payment credits nothing").to.equal(0n);
    expect(bal[2]).to.equal(0n);

    // ...and the slot it consumed is returned, so the merchant is not
    // penalised for a customer who walked away.
    const info = await integrator.getDailyTxInfo(ramesh.address);
    expect(info[0], "daily count released").to.equal(0n);
  });

  it("the relayer never holds or touches merchant USDC", async function () {
    await integrator.connect(ramesh).createLink(LINK, USDC(3), INR, 0, false, CONFIG);

    const t = await integrator
      .connect(relayer)
      .relayerPlaceOrder(LINK, client.target, PRODUCT_ID, 3, INR, 0, PK);
    const r = await t.wait();
    const ev = r.logs
      .map((l: any) => {
        try {
          return integrator.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e: any) => e && e.name === "LinkOrderPlaced");

    await completeOrder(ev.args[1], USDC(3));
    await time.increase(SETTLEMENT + 1);

    // Through an entire successful payment the relayer's USDC balance never
    // moved off zero — it signs, it does not custody.
    expect(await mockUsdc.balanceOf(relayer.address)).to.equal(0n);

    // And it cannot take the settled funds now that they are unlocked.
    await expect(integrator.connect(relayer).withdrawUSDC(USDC(3))).to.be.revertedWithCustomError(
      integrator,
      "NotRegistered"
    );

    // Only Ramesh can.
    await integrator.connect(ramesh).withdrawUSDC(USDC(3));
    expect(await mockUsdc.balanceOf(ramesh.address)).to.equal(USDC(3));
  });
});
