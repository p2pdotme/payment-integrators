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
 * THE SEAM BETWEEN LINK PAYMENTS AND FIAT WITHDRAWALS.
 *
 * WHY THIS FILE EXISTS
 * Round-4 review, N1. The integrator has ONE `trustedRelayer` slot, and it gates
 * two unrelated things:
 *
 *   • `relayerPlaceOrder` / `relayerMarkPaid` — the link path, which needs it to
 *     be a CONTRACT (the Router).
 *   • `deliverFiatPayout` / `sweepStrandedBuy` — where it is the THIRD accepted
 *     caller, after the merchant and any owner.
 *
 * Wiring the Router therefore takes that third slot away from whatever held it.
 * No existing suite could see this, and the review named exactly why: the suites
 * that exercise `deliverFiatPayout` (MerchantTerminalIntegrator.ts) never wire a
 * Router, and the suites that wire a Router (LinkRouter.ts, LinkRouterE2E.ts)
 * never call `deliverFiatPayout`. The collision lives on the seam between them,
 * so this fixture deliberately does BOTH in one deployment.
 *
 * WHAT WE DECIDED, AND WHAT THESE TESTS PIN DOWN
 * The third slot is left unused. It was always optional — the integrator's own
 * NatSpec calls it an "optional admin-set keeper" and says "the merchant and
 * owner can always deliver; this just adds a keeper" — and there is no keeper
 * service in this repository: nothing in `worker/src` calls `deliverFiatPayout`,
 * and every one of the 838 contract tests delivers as the merchant.
 *
 * The alternative was to give the keeper role to an owner key, which would also
 * hand a routine payout service `pause`, `unpause` and `revokeLink`. That is far
 * more authority than the job needs, so: merchants deliver their own payouts,
 * and `trustedRelayer` means the link path and nothing else.
 *
 * Test 3 is the one that would have failed before that decision was made
 * explicit. The rest are the regression fence around it.
 */
describe("LinkRouter — the fiat-withdrawal seam (round-4 N1)", function () {
  let owner: SignerWithAddress;
  let merchant1: SignerWithAddress;
  let agent1: SignerWithAddress; // the link wallet (holds nothing)
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

  let SETTLEMENT: number;
  let LINK: string;

  beforeEach(async function () {
    [owner, merchant1, agent1, customer, attacker] = await ethers.getSigners();

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
    SETTLEMENT = Number(await integrator.SETTLEMENT_PERIOD());

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

    router = await (
      await ethers.getContractFactory("LinkRouter")
    ).deploy(await integrator.getAddress());

    // THE WIRING UNDER TEST. Every test below runs with the Router holding the
    // slot — which is the production configuration, and the thing that made N1
    // invisible everywhere else.
    await integrator.setTrustedRelayer(await router.getAddress());

    const lib = await ethers.getContractAt("PaymentLinksLib", await deployPaymentLinksLib());
    LINK = await lib.computeLinkId(merchant1.address, ethers.id("salt-1"));
  });

  // ─── Helpers ──────────────────────────────────────────────────────

  async function increaseTime(seconds: number) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  /** Settles a BUY so the merchant has an unlocked balance to withdraw. */
  async function depositFor(merchant: SignerWithAddress, quantity = 3): Promise<void> {
    const tx = await integrator
      .connect(merchant)
      .userPlaceOrder(await erc721Client.getAddress(), PRODUCT_ID, quantity, INR, 1, "");
    await tx.wait();
    const events = await integrator.queryFilter(integrator.filters.OrderPlaced());
    await mockDiamond.simulateOrderComplete(events[events.length - 1].args.orderId);
  }

  /** Places a fiat withdrawal and returns its orderId, LP already accepted. */
  async function pendingWithdrawal(amount = USDC(20)): Promise<bigint> {
    const tx = await integrator.connect(merchant1).withdrawFiat(amount, 1, PK, "");
    const rcpt = await tx.wait();
    const ev = rcpt.logs
      .map((l: any) => {
        try {
          return integrator.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((l: any) => l?.name === "WithdrawalFiat");
    const orderId = ev.args.orderId;
    await mockDiamond.acceptSellOrder(orderId, "lpPubkey");
    return orderId;
  }

  // ─── The seam ─────────────────────────────────────────────────────

  it("1. the Router really does hold the slot (the premise of everything below)", async function () {
    expect(await integrator.trustedRelayer()).to.equal(await router.getAddress());
  });

  it("2. the Router cannot deliver a payout — it has no such function", async function () {
    // Not a policy choice: the ABI has no entry for it. This is what makes the
    // slot's second role unusable once the Router holds it, and it is asserted
    // here so that ADDING such a function to the Router becomes a deliberate,
    // visible act rather than a quiet widening of its surface.
    expect(router.interface.hasFunction("deliverFiatPayout")).to.equal(false);
    expect(router.interface.hasFunction("sweepStrandedBuy")).to.equal(false);

    // And the surface as a whole is still only the link path.
    const fns = router.interface.fragments
      .filter((f: any) => f.type === "function")
      .map((f: any) => f.name)
      .sort();
    expect(fns).to.deep.equal([
      "cancel",
      "cancelDigest",
      "eip712Domain",
      "integrator",
      "linkAgent",
      "markPaid",
      "markPaidDigest",
      "orderCustomer",
      "orders",
      "place",
      "registerAgent",
    ]);
  });

  it("3. N1: with the Router wired, the MERCHANT can still deliver their own payout", async function () {
    // THE TEST THAT CLOSES N1. Before this decision was made explicit, wiring
    // the Router was believed to break fiat withdrawals. It does not — it
    // removes only the optional third caller. The merchant's own path, which is
    // how all 838 other tests deliver, is untouched.
    await depositFor(merchant1);
    await increaseTime(SETTLEMENT + 3600);

    const orderId = await pendingWithdrawal();

    await expect(integrator.connect(merchant1).deliverFiatPayout(orderId, "encUpi")).to.emit(
      integrator,
      "WithdrawalUpiDelivered"
    );

    // And it settles all the way through, so this is a real withdrawal rather
    // than a call that merely did not revert.
    await mockDiamond.completeSellOrder(orderId);
    await integrator.finalizeWithdrawal(orderId);
  });

  it("4. an owner can still deliver, so operations retains a recovery path", async function () {
    await depositFor(merchant1);
    await increaseTime(SETTLEMENT + 3600);
    const orderId = await pendingWithdrawal();

    await expect(integrator.connect(owner).deliverFiatPayout(orderId, "encUpi")).to.emit(
      integrator,
      "WithdrawalUpiDelivered"
    );
  });

  it("5. a stranger still cannot deliver — the griefing guard survives the rewiring", async function () {
    // AUDIT-MED on the integrator: `encPayout` is the payload the LP decrypts,
    // so a permissionless deliver would let an attacker front-run the merchant
    // with a bogus payload and brick the fiat channel. Removing the keeper must
    // not have relaxed that.
    await depositFor(merchant1);
    await increaseTime(SETTLEMENT + 3600);
    const orderId = await pendingWithdrawal();

    await expect(
      integrator.connect(attacker).deliverFiatPayout(orderId, "evil")
    ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
  });

  it("6. link payments and a fiat withdrawal coexist in ONE deployment", async function () {
    // The seam itself. Both halves of the contract exercised against the same
    // wiring, in the order production would see them — which is precisely the
    // combination no pre-existing suite ran.
    await depositFor(merchant1);
    await increaseTime(SETTLEMENT + 3600);

    // The link half.
    await integrator.connect(merchant1).createLink(LINK, UNIT_PRICE, INR, 0, 5, CONFIG);
    await router.connect(merchant1).registerAgent(LINK, agent1.address);
    await expect(
      router
        .connect(agent1)
        .place(LINK, await erc721Client.getAddress(), PRODUCT_ID, 1, INR, 1, PK, customer.address)
    ).to.emit(router, "OrderPlaced");

    // The fiat half, same deployment, still works.
    const orderId = await pendingWithdrawal(USDC(20));
    await expect(integrator.connect(merchant1).deliverFiatPayout(orderId, "encUpi")).to.emit(
      integrator,
      "WithdrawalUpiDelivered"
    );
  });

  it("7. linkOrdersEnabled is the rollback lever, and it leaves the fiat path alone", async function () {
    // The checklist previously said to roll back by re-pointing
    // `setTrustedRelayer`, "without touching anything else" — which was untrue,
    // since that slot is also the third payout caller. The contract already
    // ships the narrower lever; this pins down that it IS narrower.
    await depositFor(merchant1);
    await increaseTime(SETTLEMENT + 3600);

    await integrator.connect(merchant1).createLink(LINK, UNIT_PRICE, INR, 0, 5, CONFIG);
    await router.connect(merchant1).registerAgent(LINK, agent1.address);

    await integrator.setLinkOrdersEnabled(false);

    // Link orders stop.
    await expect(
      router
        .connect(agent1)
        .place(LINK, await erc721Client.getAddress(), PRODUCT_ID, 1, INR, 1, PK, customer.address)
    ).to.be.reverted;

    // Fiat withdrawals do not.
    const orderId = await pendingWithdrawal();
    await expect(integrator.connect(merchant1).deliverFiatPayout(orderId, "encUpi")).to.emit(
      integrator,
      "WithdrawalUpiDelivered"
    );
  });
});
