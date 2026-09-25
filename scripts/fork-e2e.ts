/**
 * FORK END-TO-END — the new integrator against REAL Base Sepolia state.
 *
 *   npx hardhat node --port 8546 --fork <BASE_SEPOLIA_RPC>
 *   npx hardhat run scripts/fork-e2e.ts --network fork
 *
 * Against the contracts ALREADY deployed on Base Sepolia (the exact bytecode
 * in the whitelist request), instead of a fresh copy:
 *   FORK_INTEGRATOR=0x… FORK_ROUTER=0x… FORK_CLIENT=0x… FORK_PAYMENT_LINKS_LIB=0x… \
 *     npx hardhat run scripts/fork-e2e.ts --network fork
 *
 * Nothing here touches the live network. On a local fork it:
 *   - deploys the integrator + LinkRouter exactly as the deploy scripts do;
 *   - copies admin roles/owners from the REAL previous integrators;
 *   - whitelists it on the REAL Diamond (impersonating the Diamond super-admin —
 *     the two calls the whitelist request asks for, cancel callback ON);
 *   - runs real orders through the REAL Diamond with a REAL P2P merchant
 *     (impersonated): a counter sale, a payment-link sale, a customer cancel
 *     (cancel callback returns the link's use and the daily reservation);
 *   - checks the daily limit binds link sales and can be raised to any value;
 *   - checks a real old merchant is carried over, and a freeze on the old
 *     integrator arrives frozen;
 *   - hands the super-admin to a REAL Safe (2-of-3), and checks the deployer key
 *     has lost every root power.
 * Exits non-zero on the first failed check.
 */
import { ethers, network } from "hardhat";
import { applyRoles, planRoles } from "./lib/copyRoles";
import { checkMultisig, handoffStatus, proposeHandoff, safeBatch } from "./lib/superAdmin";

const DIAMOND = "0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9";
const USDC = "0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d";
const PREVIOUS = [
  "0x4c4223DdfD0cc1a252013FBA4b8444eECda8A236",
  "0x2Edcf5E918F181d8CE5b15827a78Ebd83A0efDd6",
  "0x10A08aa7D5078C7210Ba848941ACC36982701eAf",
];
const REAL_MERCHANT = "0x02c8afe208948cDCC18C81D2B49eE18700526647"; // registered on 0x4c42, INR
const P2P_CANDIDATES = [
  "0xa8e665Ace4a4064Ef945235b280ab96A647Cdd9c",
  "0xdFEe1f1eE786C323510B00f4BD9E7273F25f9E9c",
  "0x8E39C979A6b611A3de9fEeAB294F4C3E3a53fFea",
  "0xe83f9037a6deA68314d2155afB9686345DB61815",
];
const SAFE_FACTORY = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67"; // Safe v1.4.1
const SAFE_L2 = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
const SAFE_FALLBACK = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";
const INR = ethers.encodeBytes32String("INR");
const CIRCLE_INR = 1;
const PK = "04" + "ab".repeat(64);
const USDC6 = (n: number) => BigInt(Math.round(n * 1e6));

const DIAMOND_ABI = [
  "function owner() view returns (address)",
  "function registerIntegrator(address,bool,address)",
  "function setIntegratorCancelCallback(address,bool)",
  "function getIntegratorConfig(address) view returns (bytes)",
  "function acceptOrder(uint256,string,string)",
  "function completeOrder(uint256,string)",
  "function paidBuyOrder(uint256)",
  "function fetchMerchantAssignedOrders(address) view returns (uint256[])",
  "function getOrdersById(uint256) view returns (tuple(uint256 amount,uint256 fiatAmount,uint256 placedTimestamp,uint256 completedTimestamp,uint256 userCompletedTimestamp,address acceptedMerchant,address user,address recipientAddr,string pubkey,string encUpi,bool userCompleted,uint8 status,uint8 orderType,tuple(uint8 raisedBy,uint8 status,uint256 redactTransId,uint256 accountNumber) disputeInfo,uint256 id,string userPubKey,string encMerchantUpi,uint256 acceptedAccountNo,uint256[] assignedAccountNos,bytes32 currency,uint256 preferredPaymentChannelConfigId,uint256 circleId))",
];
const STATUS = ["PLACED", "ACCEPTED", "PAID", "COMPLETED", "CANCELLED"];

let passed = 0;
function check(cond: boolean, what: string) {
  if (!cond) throw new Error(`FAILED: ${what}`);
  passed++;
  console.log(`  ✔ ${what}`);
}
async function reverts(p: Promise<any>, what: string) {
  let ok = false;
  try {
    await (await p).wait?.();
  } catch {
    ok = true;
  }
  check(ok, what);
}
async function as(addr: string) {
  await network.provider.send("hardhat_impersonateAccount", [addr]);
  await network.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
  return ethers.getSigner(addr);
}
const tx = async (p: Promise<any>) => (await p).wait();

async function main() {
  if (network.name !== "fork") throw new Error("fork only — never run against a live network");
  await network.provider.send("evm_mine", []); // the fork needs one local block before calls
  const [localDeployer, agent, customer, s1, s2, s3, stranger] = await ethers.getSigners();
  // DEPLOYED mode (FORK_INTEGRATOR, FORK_ROUTER, FORK_CLIENT, FORK_PAYMENT_LINKS_LIB set): run every
  // check against the contracts ALREADY deployed on Base Sepolia — the exact
  // bytecode awaiting whitelist — acting as their real super-admin (impersonated
  // on the fork). Otherwise deploy a fresh copy.
  const DEPLOYED = !!process.env.FORK_INTEGRATOR;
  let deployer: any = localDeployer;
  const diamond: any = new ethers.Contract(DIAMOND, DIAMOND_ABI, ethers.provider);
  const usdc: any = new ethers.Contract(
    USDC,
    ["function balanceOf(address) view returns (uint256)"],
    ethers.provider
  );

  let I: any, client: any, router: any, IA: string;
  const libs: Record<string, string> = {};
  if (DEPLOYED) {
    console.log("\n1. Attach to the DEPLOYED contracts (exact live bytecode)");
    IA = ethers.getAddress(process.env.FORK_INTEGRATOR!);
    const probe: any = await ethers.getContractAt("MerchantTerminalIntegrator", IA);
    deployer = await as(await probe.superAdmin());
    I = probe.connect(deployer);
    router = (await ethers.getContractAt("LinkRouter", process.env.FORK_ROUTER!)).connect(deployer);
    client = await ethers.getContractAt("SimpleERC721Client", process.env.FORK_CLIENT!);
    libs.PaymentLinksLib = process.env.FORK_PAYMENT_LINKS_LIB!;
    check(
      (await ethers.provider.getCode(IA)).length / 2 - 1 <= 24576,
      `integrator ${IA} fits EIP-170`
    );
    check(
      (await I.trustedRelayer()) === (await router.getAddress()),
      "deployed LinkRouter is its trustedRelayer"
    );
    check((await router.integrator()) === IA, "deployed LinkRouter points back at it");
  } else {
    console.log("\n1. Deploy (as the deploy scripts do)");
    for (const n of [
      "PaymentLinksLib",
      "MerchantRegistryLib",
      "SettlementLib",
      "MerchantImportLib",
    ]) {
      const c = await (await ethers.getContractFactory(n)).deploy();
      libs[n] = await c.getAddress();
    }
    I = await (
      await ethers.getContractFactory("MerchantTerminalIntegrator", { libraries: libs })
    ).deploy(DIAMOND, USDC, []);
    IA = await I.getAddress();
    check((await ethers.provider.getCode(IA)).length / 2 - 1 <= 24576, "integrator fits EIP-170");
    await tx(I.setPreviousIntegrators(PREVIOUS));
    client = await (
      await ethers.getContractFactory("SimpleERC721Client")
    ).deploy(IA, USDC, "Merchant Terminal Item", "MTI");
    await tx(client.setProductPrice(2, 1));
    router = await (await ethers.getContractFactory("LinkRouter")).deploy(IA);
    await tx(I.setTrustedRelayer(await router.getAddress()));
    check(
      (await I.trustedRelayer()) === (await router.getAddress()),
      "LinkRouter wired as trustedRelayer"
    );
  }

  console.log("\n2. Copy admin roles + owners from the REAL previous integrators");
  const logs = new ethers.JsonRpcProvider(
    process.env.LOGS_RPC || "https://sepolia.base.org",
    undefined,
    { staticNetwork: true }
  );
  const plan = await planRoles(
    ethers.provider,
    PREVIOUS,
    deployer.address,
    1000,
    console.log,
    logs
  );
  if (DEPLOYED) {
    // The deploy script already copied them: every planned role must be there
    // BEFORE applying anything here.
    for (const p of plan)
      check(
        p.owner ? await I.isOwner(p.address) : Number(await I.roleOf(p.address)) === p.role,
        `deploy already copied ${p.address}`
      );
    check(
      true,
      `${plan.length} role holder(s) besides the super-admin; the deploy copied all of them`
    );
  }
  await applyRoles(I, plan, console.log);
  for (const p of plan) {
    if (p.owner) check(await I.isOwner(p.address), `owner ${p.address} carried over`);
    else
      check(
        Number(await I.roleOf(p.address)) === p.role,
        `role ${p.role} for ${p.address} carried over`
      );
    const old = new ethers.Contract(
      p.from,
      ["function isOwner(address) view returns (bool)"],
      ethers.provider
    );
    if (p.owner)
      check(await old.isOwner(p.address), `…and ${p.address} really is an owner on ${p.from}`);
  }
  if (!DEPLOYED)
    check(plan.length > 0, `${plan.length} role holder(s) found on the old integrators`);

  console.log("\n3. Whitelist on the REAL Diamond (fork only: impersonating its super-admin)");
  const dAdmin = await as(await diamond.owner());
  await tx(diamond.connect(dAdmin).registerIntegrator(IA, false, await I.proxyImpl()));
  await tx(diamond.connect(dAdmin).setIntegratorCancelCallback(IA, true));
  const cfgOf = async (who: string) =>
    (
      await ethers.provider.call({
        to: DIAMOND,
        data: diamond.interface.encodeFunctionData("getIntegratorConfig", [who]),
      })
    )
      .slice(2)
      .match(/.{64}/g)!
      .map((w: string) => BigInt("0x" + w).toString(16))
      .join(" | ");
  console.log(`  new integrator config : ${await cfgOf(IA)}`);
  console.log(`  live 0x4c42 config    : ${await cfgOf(PREVIOUS[0])}`);
  check(
    (await cfgOf(IA)).startsWith("1 | 0 | 1"),
    "registered active, usdcThroughIntegrator=false, cancel callback ON"
  );
  check(
    (await cfgOf(PREVIOUS[0])).startsWith("1 | 0 | 0"),
    "(live 0x4c42 has the cancel callback OFF — as the review found)"
  );

  console.log("\n4. A REAL old merchant is carried over — no registration");
  const m = await as(REAL_MERCHANT);
  check(!(await I.registered(REAL_MERCHANT)), "merchant not registered on the new integrator yet");
  await tx(I.importMerchant(REAL_MERCHANT));
  const info = await I.getMerchantInfo(REAL_MERCHANT);
  check(
    info[1] === "Wissdom" && info[2] === INR && info[4] === false,
    `imported as "${info[1]}", INR, not frozen`
  );

  // Resolve which real P2P merchant the Diamond assigned, accept as them.
  async function acceptAsAssigned(id: bigint) {
    // Simulate acceptOrder from each candidate (touches only this order —
    // fetchMerchantAssignedOrders walks a merchant's whole history, which a
    // fork fetches slot by slot from the remote RPC).
    for (const c of P2P_CANDIDATES) {
      const p2p = await as(c);
      try {
        await diamond.connect(p2p).acceptOrder.staticCall(id, "fork-e2e", "fork-e2e");
      } catch {
        continue;
      }
      await tx(diamond.connect(p2p).acceptOrder(id, "fork-e2e", "fork-e2e"));
      console.log(`  (accepted by real P2P merchant ${c})`);
      return p2p;
    }
    const o = await diamond.getOrdersById(id);
    throw new Error(
      `order ${id} not assigned to a known P2P merchant (assigned accounts ${o.assignedAccountNos})`
    );
  }
  const status = async (id: bigint) => STATUS[Number((await diamond.getOrdersById(id)).status)];
  const lastPlaced = async () => {
    const ev = await I.queryFilter(I.filters.OrderPlaced(), -5);
    return ev[ev.length - 1].args[0] as bigint;
  };

  console.log("\n5. Counter (POS) sale through the REAL Diamond, with a REAL P2P merchant");
  const bal0 = (await I.getMerchantBalance(REAL_MERCHANT)).totalDeposited;
  await tx(
    I.connect(m).userPlaceOrder(await client.getAddress(), 2, USDC6(1), INR, CIRCLE_INR, PK)
  );
  const pos = await lastPlaced();
  check((await status(pos)) === "PLACED", `POS order ${pos} placed on the real Diamond`);
  const p2p = await acceptAsAssigned(pos);
  check((await status(pos)) === "ACCEPTED", "accepted by the real P2P merchant");
  await tx(diamond.connect(m).paidBuyOrder(pos));
  check((await status(pos)) === "PAID", "merchant device marked it paid");
  await tx(diamond.connect(p2p).completeOrder(pos, ""));
  check((await status(pos)) === "COMPLETED", "P2P merchant completed it");
  const bal1 = await I.getMerchantBalance(REAL_MERCHANT);
  check(
    bal1.totalDeposited - bal0 === USDC6(1),
    "merchant credited exactly 1 USDC (onOrderComplete pulled it)"
  );
  check((await usdc.balanceOf(IA)) >= USDC6(1), "USDC is held by the integrator");

  console.log("\n6. Payment-link sale via LinkRouter (customer-signed mark-paid)");
  const lib: any = await ethers.getContractAt("PaymentLinksLib", libs.PaymentLinksLib);
  const LINK = await lib.computeLinkId(REAL_MERCHANT, ethers.id("fork-e2e-1"));
  await tx(I.connect(m).createLink(LINK, USDC6(1), INR, 0, 1, "0x"));
  await tx(router.connect(m).registerAgent(LINK, agent.address));
  const sig = async (kind: "MarkPaid" | "Cancel", link: string, id: bigint) =>
    customer.signTypedData(
      {
        name: "P2P LinkRouter",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await router.getAddress(),
      },
      {
        [kind]: [
          { name: "linkId", type: "bytes32" },
          { name: "orderId", type: "uint256" },
        ],
      },
      { linkId: link, orderId: id }
    );
  const place = async (link: string) => {
    await tx(
      router
        .connect(agent)
        .place(link, await client.getAddress(), 2, USDC6(1), INR, CIRCLE_INR, PK, customer.address)
    );
    return lastPlaced();
  };
  const lk = await place(LINK);
  check((await status(lk)) === "PLACED", `link order ${lk} placed on the real Diamond`);
  const p2pL = await acceptAsAssigned(lk);
  await reverts(
    router.connect(agent).markPaid(LINK, lk, "0x" + "00".repeat(65)),
    "mark-paid without the customer's signature is refused"
  );
  await tx(router.connect(agent).markPaid(LINK, lk, await sig("MarkPaid", LINK, lk)));
  check((await status(lk)) === "PAID", "customer-signed mark-paid advanced the real order");
  await tx(diamond.connect(p2pL).completeOrder(lk, ""));
  check((await status(lk)) === "COMPLETED", "link order completed");
  const l1 = await I.getLink(LINK);
  check(l1.uses === 1n, "single-use link consumed by the payment");
  check(
    (await I.getMerchantBalance(REAL_MERCHANT)).totalDeposited - bal0 === USDC6(2),
    "merchant credited for the link sale"
  );

  console.log(
    "\n7. Customer cancel → REAL Diamond cancel callback returns the link's use and the day's reservation"
  );
  const LINK2 = await lib.computeLinkId(REAL_MERCHANT, ethers.id("fork-e2e-2"));
  await tx(I.connect(m).createLink(LINK2, USDC6(1), INR, 0, 1, "0x"));
  await tx(router.connect(m).registerAgent(LINK2, agent.address));
  const c1 = await place(LINK2);
  check((await I.getLink(LINK2)).uses === 1n, "an open order holds the link's single use");
  await reverts(place(LINK2), "a second customer cannot take the single-use link while it is held");
  await tx(router.connect(agent).cancel(LINK2, c1, await sig("Cancel", LINK2, c1)));
  check((await status(c1)) === "CANCELLED", "order cancelled on the real Diamond");
  check(
    (await I.getLink(LINK2)).uses === 0n,
    "onOrderCancel ran (callback ON): the link's use came back"
  );
  const c2 = await place(LINK2);
  check((await status(c2)) === "PLACED", "…so the link can be paid by the next customer");
  await tx(router.connect(agent).cancel(LINK2, c2, await sig("Cancel", LINK2, c2)));

  console.log("\n8. Limits: MANAGER moves them inside a range that FINANCE/owners set");
  const all = await ethers.getSigners();
  const manager = all[7];
  const finance = all[8];
  await tx(I.setRole(manager.address, 3)); // MANAGER
  await tx(I.setRole(finance.address, 4)); // FINANCE
  const [minD, maxD, minC, maxC] = await I.limitBounds();
  check(
    minD === 1n && maxD === 25n && minC === USDC6(1) && maxC === USDC6(100),
    "starting range: 1-25 orders a day, 1-100 USDC a sale"
  );
  const LINK3 = await lib.computeLinkId(REAL_MERCHANT, ethers.id("fork-e2e-3"));
  await tx(I.connect(m).createLink(LINK3, 0, INR, 0, 0, "0x")); // any amount, unlimited uses
  await tx(router.connect(m).registerAgent(LINK3, agent.address));
  const [used] = await I.getDailyTxInfo(REAL_MERCHANT); // 2 paid today (POS + link)
  await tx(I.connect(manager).setDailyLimit(used + 2n));
  await place(LINK3);
  await place(LINK3); // two pending reservations fill the limit
  await reverts(place(LINK3), `link placement refused at the daily limit (${used + 2n})`);
  await reverts(I.connect(manager).setDailyLimit(500), "MANAGER cannot go past the max (25)");
  await reverts(
    I.connect(manager).setLimitBounds(1, 1000, USDC6(1), USDC6(1000)),
    "MANAGER cannot change the range"
  );
  await tx(I.connect(finance).setLimitBounds(1, 1000, USDC6(1), USDC6(1000)));
  check((await I.limitBounds())[1] === 1000n, "FINANCE admin widened the range to 1-1000 a day");
  await tx(I.connect(manager).setDailyLimit(500));
  check((await I.dailyLimit()) === 500n, "…then MANAGER raised the daily limit to 500");
  await place(LINK3);
  check(true, "placement works again after the raise");
  await tx(I.connect(manager).setPerTxCap(INR, USDC6(1000)));
  check((await I.perTxCap(INR)) === USDC6(1000), "MANAGER raised the per-tx cap to 1000 USDC");
  await tx(I.connect(finance).setLimitBounds(1, 25, USDC6(1), USDC6(100)));
  check((await I.dailyLimit()) === 25n, "narrowing the range pulled the daily limit back to 25");
  check((await I.perTxCap(INR)) === USDC6(100), "…and the 1000 USDC cap back to 100 at once");
  await tx(I.connect(manager).setPerTxCap(INR, 0)); // back to the INR default

  console.log("\n9. Freeze on an OLD integrator carries over (real old contract)");
  const oldI: any = new ethers.Contract(
    PREVIOUS[0],
    [
      "function registerMerchant(bytes,string,string,bytes32)",
      "function freezeMerchant(address)",
      "function superAdmin() view returns (address)",
    ],
    ethers.provider
  );
  await tx(
    oldI
      .connect(stranger)
      .registerMerchant("0x", "Fork Frozen Shop", "INR", ethers.encodeBytes32String("Retail"))
  );
  await tx(oldI.connect(await as(await oldI.superAdmin())).freezeMerchant(stranger.address));
  await reverts(
    I.connect(stranger).registerMerchant(
      "0x",
      "Fresh start",
      "INR",
      ethers.encodeBytes32String("Retail")
    ),
    "frozen old merchant cannot register fresh"
  );
  await tx(I.importMerchant(stranger.address));
  check(
    (await I.getMerchantInfo(stranger.address))[4] === true,
    "arrives FROZEN on the new integrator"
  );

  console.log("\n10. Super-admin → REAL Safe (2-of-3); the deployer key ends with nothing");
  const factory: any = new ethers.Contract(
    SAFE_FACTORY,
    [
      "function createProxyWithNonce(address,bytes,uint256) returns (address)",
      "event ProxyCreation(address indexed proxy, address singleton)",
    ],
    deployer
  );
  const safeIface = new ethers.Interface([
    "function setup(address[],uint256,address,bytes,address,address,uint256,address)",
    "function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns (bytes32)",
    "function nonce() view returns (uint256)",
    "function approveHash(bytes32)",
    "function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) payable returns (bool)",
  ]);
  const owners = [s1, s2, s3].map((s) => s.address);
  const init = safeIface.encodeFunctionData("setup", [
    owners,
    2,
    ethers.ZeroAddress,
    "0x",
    SAFE_FALLBACK,
    ethers.ZeroAddress,
    0,
    ethers.ZeroAddress,
  ]);
  const rc = await tx(factory.createProxyWithNonce(SAFE_L2, init, Date.now()));
  const SAFE = rc.logs
    .map((l: any) => {
      try {
        return factory.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e: any) => e?.name === "ProxyCreation").args.proxy;
  const safe: any = new ethers.Contract(SAFE, safeIface, ethers.provider);
  await checkMultisig(ethers.provider, SAFE, {
    chainId: 8453n /* hold it to the mainnet rule */,
    deployer: deployer.address,
  });
  check(true, `real Safe ${SAFE} passes the mainnet multisig check (2-of-3)`);

  async function safeExec(to: string, data: string) {
    const n = await safe.nonce();
    const h = await safe.getTransactionHash(
      to,
      0,
      data,
      0,
      0,
      0,
      0,
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      n
    );
    const signers = [s1, s2].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
    for (const s of signers) await tx(safe.connect(s).approveHash(h));
    const sigs = ethers.concat(
      signers.map((s) =>
        ethers.concat([ethers.zeroPadValue(s.address, 32), ethers.ZeroHash, "0x01"])
      )
    );
    await tx(
      safe
        .connect(s1)
        .execTransaction(to, 0, data, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, sigs)
    );
  }

  await proposeHandoff(I, SAFE, console.log);
  check((await I.superAdmin()) === deployer.address, "proposal alone moves nothing");
  for (const t of safeBatch(IA, deployer.address)) await safeExec(t.to, t.data);
  const st = await handoffStatus(I, ethers.provider, SAFE, deployer.address);
  check(st.superAdmin === SAFE && st.superAdminIsContract, "super-admin is now the Safe");
  check(!st.deployerStillOwner && st.done, "deployer key is no longer an owner");
  await reverts(
    I.connect(deployer).setTrustedRelayer(stranger.address),
    "deployer can no longer set trustedRelayer"
  );
  await reverts(
    I.connect(deployer).addOwner(stranger.address),
    "deployer can no longer add owners"
  );
  await reverts(I.connect(deployer).setDailyLimit(1000), "deployer can no longer change limits");
  await safeExec(
    IA,
    I.interface.encodeFunctionData("setLimitBounds", [1, 200, USDC6(1), USDC6(500)])
  );
  await safeExec(IA, I.interface.encodeFunctionData("setDailyLimit", [100]));
  check(
    (await I.dailyLimit()) === 100n,
    "the Safe (2 of 3 signing) can widen the range and raise the limit"
  );

  console.log(
    `\nALL ${passed} CHECKS PASSED on a fork of Base Sepolia (block ${await ethers.provider.getBlockNumber()}).`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
