/**
 * FORK CHECK — link-order disputes against the REAL Base Sepolia Diamond.
 *
 *   npx hardhat node --port 8546 --fork <BASE_SEPOLIA_RPC>
 *   FORK_DISPUTE_PART=customer npx hardhat run scripts/fork-dispute.ts --network fork
 *
 * Run each part (customer | merchant | late) on a FRESH fork: the Diamond
 * assigns only the first new order to an LP this script can impersonate, so
 * one scenario per fork keeps it deterministic.
 *
 * Nothing here touches the live network. On a local fork it deploys the new
 * integrator + LinkRouter, whitelists them on the REAL Diamond (impersonating
 * its owner, as fork-e2e.ts does), and runs real link orders with a REAL P2P
 * merchant (impersonated) to prove that:
 *   - a link order cancelled after the customer marked it paid can now be
 *     disputed on the Diamond — by the customer through the Router, and by
 *     the merchant directly;
 *   - the Diamond records it: disputeInfo.status 0 -> 1 (RAISED) with the
 *     last 4 digits. raisedBy stays 0 — 0 is the USER value, so it cannot be
 *     what tells a raised dispute from none;
 *   - the Diamond's own rules still apply (not while open, not too early, not
 *     after 24 h, only once), and the Router's signature checks hold.
 * Exits non-zero on the first failed check.
 */
import { ethers, network } from "hardhat";

const DIAMOND = process.env.FORK_DIAMOND || "0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9";
const USDC = process.env.FORK_USDC || "0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d";
const P2P_CANDIDATES = (
  process.env.FORK_P2P_MERCHANTS ||
  "0xa8e665Ace4a4064Ef945235b280ab96A647Cdd9c,0xdFEe1f1eE786C323510B00f4BD9E7273F25f9E9c,0x8E39C979A6b611A3de9fEeAB294F4C3E3a53fFea,0xe83f9037a6deA68314d2155afB9686345DB61815"
).split(",");
const INR = ethers.encodeBytes32String("INR");
const SECTOR = ethers.encodeBytes32String("Retail");
const CIRCLE_INR = Number(process.env.FORK_CIRCLE_INR || 1);
const PK = "04" + "ab".repeat(64);
const USDC6 = (n: number) => BigInt(Math.round(n * 1e6));
const LAST4 = 4821n;

const DIAMOND_ABI = [
  "function owner() view returns (address)",
  "function registerIntegrator(address,bool,address)",
  "function setIntegratorCancelCallback(address,bool)",
  "function cancelOrder(uint256)",
  "function acceptOrder(uint256,string,string)",
  "function getOrdersById(uint256) view returns (tuple(uint256 amount,uint256 fiatAmount,uint256 placedTimestamp,uint256 completedTimestamp,uint256 userCompletedTimestamp,address acceptedMerchant,address user,address recipientAddr,string pubkey,string encUpi,bool userCompleted,uint8 status,uint8 orderType,tuple(uint8 raisedBy,uint8 status,uint256 redactTransId,uint256 accountNumber) disputeInfo,uint256 id,string userPubKey,string encMerchantUpi,uint256 acceptedAccountNo,uint256[] assignedAccountNos,bytes32 currency,uint256 preferredPaymentChannelConfigId,uint256 circleId))",
  "function getAdditionalOrderDetails(uint256) view returns (tuple(uint64 fixedFeePaid,uint64 tipsPaid,uint128 acceptedTimestamp,uint128 paidTimestamp,uint128 reserved2,uint256 actualUsdtAmount,uint256 actualFiatAmount))",
];
const STATUS = ["PLACED", "ACCEPTED", "PAID", "COMPLETED", "CANCELLED"];

let passed = 0;
function check(cond: boolean, what: string) {
  if (!cond) throw new Error(`FAILED: ${what}`);
  passed++;
  console.log(`  ✔ ${what}`);
}
async function as(addr: string) {
  await network.provider.send("hardhat_impersonateAccount", [addr]);
  await network.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
  return ethers.getSigner(addr);
}
const tx = async (p: Promise<any>) => (await p).wait();
async function warp(seconds: number) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine", []);
}

async function main() {
  if (network.name !== "fork") throw new Error("fork only — never run against a live network");
  await network.provider.send("evm_mine", []); // the fork needs one local block before calls
  const [deployer, merchant, agent, customer, otherMerchant, stranger] = await ethers.getSigners();
  const diamond: any = new ethers.Contract(DIAMOND, DIAMOND_ABI, ethers.provider);

  // Names a revert: our own errors, and the Diamond's error inside the proxy's CallFailed.
  const ifaces: any[] = [];
  const why = (e: any): string => {
    // The revert data sits at a different depth per provider and error kind.
    const find = (v: any, depth = 0): string | undefined => {
      if (typeof v === "string") return /^0x[0-9a-f]{8}/i.test(v) ? v : undefined;
      if (!v || typeof v !== "object" || depth > 4) return undefined;
      for (const k of ["data", "error", "info", "cause"]) {
        const r = find(v[k], depth + 1);
        if (r) return r;
      }
      return undefined;
    };
    const data = find(e);
    if (!data) return e?.shortMessage ?? String(e?.message ?? e).slice(0, 120);
    for (const i of ifaces) {
      try {
        const p = i.parseError(data);
        if (!p) continue;
        if (p.name === "CallFailed") return `CallFailed(Diamond ${p.args[0].slice(0, 10)})`;
        return p.name;
      } catch {}
    }
    return `unknown ${data.slice(0, 10)}`;
  };
  async function refused(p: () => Promise<any>, what: string): Promise<string> {
    try {
      await (await p()).wait();
    } catch (e) {
      const reason = why(e);
      check(true, `${what} — refused (${reason})`);
      return reason;
    }
    throw new Error(`FAILED: ${what} — it went through`);
  }

  console.log("\n1. Deploy the new integrator + LinkRouter (as the deploy scripts do)");
  const libs: Record<string, string> = {};
  for (const n of [
    "PaymentLinksLib",
    "MerchantRegistryLib",
    "SettlementLib",
    "MerchantImportLib",
  ]) {
    libs[n] = await (await (await ethers.getContractFactory(n)).deploy()).getAddress();
  }
  const I: any = await (
    await ethers.getContractFactory("MerchantTerminalIntegrator", { libraries: libs })
  ).deploy(DIAMOND, USDC, []);
  const IA = await I.getAddress();
  const size = (await ethers.provider.getCode(IA)).length / 2 - 1;
  check(size <= 24576, `integrator fits EIP-170 (${size} bytes, ${24576 - size} free)`);
  const client: any = await (
    await ethers.getContractFactory("SimpleERC721Client")
  ).deploy(IA, USDC, "Merchant Terminal Item", "MTI");
  await tx(client.setProductPrice(2, 1));
  const router: any = await (await ethers.getContractFactory("LinkRouter")).deploy(IA);
  await tx(I.setTrustedRelayer(await router.getAddress()));
  ifaces.push(
    I.interface,
    router.interface,
    (await ethers.getContractFactory("UserProxy")).interface
  );

  console.log("\n2. Whitelist on the REAL Diamond (fork only: impersonating its owner)");
  const dAdmin = await as(await diamond.owner());
  await tx(diamond.connect(dAdmin).registerIntegrator(IA, false, await I.proxyImpl()));
  await tx(diamond.connect(dAdmin).setIntegratorCancelCallback(IA, true));
  check(true, "registered, cancel callback ON");

  console.log("\n3. A merchant and a payment link");
  await tx(I.connect(merchant).registerMerchant("0x", "Fork Dispute Shop", "INR", SECTOR));
  await tx(I.connect(otherMerchant).registerMerchant("0x", "Other Shop", "INR", SECTOR));
  const lib: any = await ethers.getContractAt("PaymentLinksLib", libs.PaymentLinksLib);
  const LINK = await lib.computeLinkId(merchant.address, ethers.id("fork-dispute"));
  await tx(I.connect(merchant).createLink(LINK, USDC6(1), INR, 0, 0, "0x"));
  await tx(router.connect(merchant).registerAgent(LINK, agent.address));
  const proxy = await I.proxyAddress(merchant.address);
  check(true, `link ${LINK.slice(0, 10)}…, merchant proxy ${proxy}`);

  const domain = async () => ({
    name: "P2P LinkRouter",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await router.getAddress(),
  });
  const ORDER = [
    { name: "linkId", type: "bytes32" },
    { name: "orderId", type: "uint256" },
  ];
  const sig = async (kind: "MarkPaid" | "Cancel", id: bigint, who = customer) =>
    who.signTypedData(await domain(), { [kind]: ORDER }, { linkId: LINK, orderId: id });
  const disputeSig = async (id: bigint, last4 = LAST4, who = customer) =>
    who.signTypedData(
      await domain(),
      { Dispute: [...ORDER, { name: "redactTransId", type: "uint256" }] },
      { linkId: LINK, orderId: id, redactTransId: last4 }
    );
  const order = (id: bigint) => diamond.getOrdersById(id);
  const status = async (id: bigint) => STATUS[Number((await order(id)).status)];

  const cancelSigs = new Map<bigint, string>();

  async function acceptAsAssigned(id: bigint) {
    for (const c of P2P_CANDIDATES) {
      const p2p = await as(c);
      try {
        await diamond.connect(p2p).acceptOrder.staticCall(id, "fork-dispute", "fork-dispute");
      } catch {
        continue;
      }
      await tx(diamond.connect(p2p).acceptOrder(id, "fork-dispute", "fork-dispute"));
      return c;
    }
    return null;
  }

  /** Place, LP accepts, customer marks paid: the state just before a dispute. */
  async function paidLinkOrder(): Promise<bigint> {
    await tx(
      router
        .connect(agent)
        .place(LINK, await client.getAddress(), 2, USDC6(1), INR, CIRCLE_INR, PK, customer.address)
    );
    let id = 0n;
    let lp: string | null = null;
    // The Diamond rotates assignment across LPs; one outside the known list
    // cannot be impersonated here, so drop that order (PLACED is
    // customer-cancellable) and place again.
    for (let attempt = 0; attempt < 8 && !lp; attempt++) {
      if (attempt > 0) {
        await tx(router.connect(agent).cancel(LINK, id, await sig("Cancel", id)));
        await tx(
          router
            .connect(agent)
            .place(
              LINK,
              await client.getAddress(),
              2,
              USDC6(1),
              INR,
              CIRCLE_INR,
              PK,
              customer.address
            )
        );
      }
      const ev = await router.queryFilter(router.filters.OrderPlaced(), -3);
      id = ev[ev.length - 1].args[1] as bigint;
      lp = await acceptAsAssigned(id);
    }
    if (!lp) throw new Error(`no known P2P merchant was assigned in 8 placements`);
    await tx(router.connect(agent).markPaid(LINK, id, await sig("MarkPaid", id)));
    cancelSigs.set(id, await sig("Cancel", id));
    check(
      (await status(id)) === "PAID",
      `order ${id}: placed, accepted by real LP ${lp.slice(0, 10)}…, marked paid`
    );
    return id;
  }

  /**
   * The case a dispute is for: paid, then cancelled anyway. On the real
   * Diamond a PAID BUY cannot be cancelled by `order.user` (NotAuthorized) or
   * by the LP — only by p2p.me's admin, which is the real-world route.
   */
  async function cancelAfterPaying(id: bigint) {
    await refused(
      () => router.connect(agent).cancel(LINK, id, cancelSigs.get(id)!),
      `order ${id}: the customer cannot cancel it once PAID`
    );
    await tx(diamond.connect(dAdmin).cancelOrder(id));
    const aod = await diamond.getAdditionalOrderDetails(id);
    check(
      (await status(id)) === "CANCELLED" && aod.paidTimestamp > 0n,
      `order ${id}: cancelled on the real Diamond after being marked paid`
    );
  }

  const part = process.env.FORK_DISPUTE_PART || "customer";
  if (part === "customer") {
    console.log("\n4. The customer's dispute, through the Router");
    const o1 = await paidLinkOrder();
    const s1 = await disputeSig(o1);
    const d0 = (await order(o1)).disputeInfo;
    check(
      Number(d0.status) === 0 && Number(d0.raisedBy) === 0,
      `before: no dispute (raisedBy ${d0.raisedBy}, status ${d0.status})`
    );
    const notCancelled = await refused(
      () => router.connect(agent).dispute(LINK, o1, LAST4, s1),
      "dispute while the order is still open (PAID)"
    );
    await cancelAfterPaying(o1);
    const placedAt = Number((await order(o1)).placedTimestamp);
    const now = async () => (await ethers.provider.getBlock("latest"))!.timestamp;
    let tooEarly = "(window already open)";
    if ((await now()) - placedAt < 15 * 60) {
      tooEarly = await refused(
        () => router.connect(agent).dispute(LINK, o1, LAST4, s1),
        "dispute before 15 minutes"
      );
    }
    await warp(15 * 60 + 5 - ((await now()) - placedAt));
    check(true, `15 minutes after placement`);

    const sStranger = await disputeSig(o1, LAST4, stranger);
    await refused(
      () => router.connect(agent).dispute(LINK, o1, LAST4, sStranger),
      "dispute signed by someone other than the customer"
    );
    await refused(
      () => router.connect(agent).dispute(LINK, o1, 1111n, s1),
      "dispute with last 4 digits the customer did not sign"
    );
    await refused(
      () => router.connect(stranger).dispute(LINK, o1, LAST4, s1),
      "dispute sent by a wallet that is not the link's"
    );
    await refused(
      () => I.connect(stranger).linkDispute(LINK, o1, LAST4, false),
      "a stranger naming the link on the integrator directly (acts as itself)"
    );
    await refused(
      () => I.connect(otherMerchant).linkDispute(ethers.ZeroHash, o1, LAST4, false),
      "another merchant disputing this merchant's order"
    );

    check(
      (await router.disputeDigest(LINK, o1, LAST4)) ===
        ethers.TypedDataEncoder.hash(
          await domain(),
          { Dispute: [...ORDER, { name: "redactTransId", type: "uint256" }] },
          { linkId: LINK, orderId: o1, redactTransId: LAST4 }
        ),
      "disputeDigest matches the pay page's typed data"
    );
    await tx(router.connect(agent).dispute(LINK, o1, LAST4, s1));
    const d1 = (await order(o1)).disputeInfo;
    check(
      Number(d1.status) !== 0 && d1.redactTransId === LAST4,
      `REAL Diamond recorded the dispute (raisedBy ${d1.raisedBy}, status ${d1.status}, last 4 ${d1.redactTransId})`
    );
    await refused(
      () => router.connect(agent).dispute(LINK, o1, LAST4, s1),
      "the same dispute again"
    );

    console.log(
      `\nThe REAL Diamond's refusals: open order → ${notCancelled}; too early → ${tooEarly}`
    );
  } else if (part === "merchant") {
    console.log("\n5. The merchant's own dispute, directly on the integrator");
    const o2 = await paidLinkOrder();
    await cancelAfterPaying(o2);
    await warp(15 * 60 + 5);
    await refused(
      () => I.connect(merchant).linkDispute(ethers.ZeroHash, o2, 1234n, false),
      "the merchant before 6 hours (the customer goes first)"
    );
    await warp(6 * 3600);
    await tx(I.connect(merchant).linkDispute(ethers.ZeroHash, o2, 1234n, false));
    const d2 = (await order(o2)).disputeInfo;
    check(
      Number(d2.status) !== 0 && d2.redactTransId === 1234n,
      `REAL Diamond recorded the merchant's dispute (raisedBy ${d2.raisedBy}, status ${d2.status}, last 4 ${d2.redactTransId})`
    );
  } else if (part === "late") {
    console.log("\n6. The 24-hour limit");
    const o3 = await paidLinkOrder();
    await cancelAfterPaying(o3);
    const s3 = await disputeSig(o3);
    await warp(24 * 3600 + 60);
    const late = await refused(
      () => router.connect(agent).dispute(LINK, o3, LAST4, s3),
      "dispute more than 24 hours after placement"
    );
    // The paid-then-cancelled order held its link use; with the window closed
    // and no dispute, anyone can give it back.
    const usesBefore = (await I.getLink(LINK)).uses;
    await tx(I.connect(stranger).releaseLinkClaim(o3));
    check(
      (await I.getLink(LINK)).uses === usesBefore - 1n,
      `after 24 h with no dispute, releaseLinkClaim gave the link use back (${usesBefore} → ${usesBefore - 1n})`
    );

    console.log(`\nThe REAL Diamond's refusal after 24 h → ${late}`);
  } else {
    throw new Error(`unknown FORK_DISPUTE_PART ${part} (customer | merchant | late)`);
  }
  console.log(`\n${passed} checks passed (${part})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
