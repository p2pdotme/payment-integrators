import { ethers } from "hardhat";

/**
 * Live Base Sepolia E2E for BlackstripeCheckoutIntegrator — both flows, run
 * from acct1 (a PLAIN EOA; acct0 is 7702-delegated and hits the RPC's
 * in-flight-tx limit). A demo-merchant-bot must be running in circle 1 / INR.
 *
 *   ONRAMP : userBuyUsdc → [bot accepts] → paidBuyOrder (user marks paid) →
 *            [bot completes] → USDC lands in the user's own EOA.
 *   OFFRAMP: approve → userInitiateOfframp → [bot accepts] → deliverOfframpUpi
 *            (pulls principal+fee from the user's wallet) → [bot completes] →
 *            reconcile.
 *
 *   INTEGRATOR_ADDRESS=0x... [ONRAMP_USDC=2000000] [OFFRAMP_USDC=2000000] \
 *   npx hardhat run scripts/local/e2e-blackstripe-sepolia.ts --network baseSepolia
 */

const DIAMOND = process.env.DIAMOND_ADDRESS || "0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9";
const USDC = process.env.USDC_ADDRESS || "0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d";
const INTEGRATOR = process.env.INTEGRATOR_ADDRESS || "0xBf0D82f0E28Bb896B58C09462646F27E57E5ED96";
const ONRAMP_USDC = BigInt(process.env.ONRAMP_USDC || "2000000"); // 2 USDC
const OFFRAMP_USDC = BigInt(process.env.OFFRAMP_USDC || "2000000"); // 2 USDC principal
const CIRCLE_ID = BigInt(process.env.CIRCLE_ID || "1");
const CURRENCY = ethers.encodeBytes32String(process.env.CURRENCY || "INR");
const POLL_ITERS = Number(process.env.POLL_ITERS || "48");
const POLL_MS = Number(process.env.POLL_MS || "5000");

const STATUS = ["PLACED", "ACCEPTED", "PAID", "COMPLETED", "CANCELLED"];
const DIAMOND_ABI = [
  "function getOrdersById(uint256) view returns (tuple(uint256 amount, uint256 fiatAmount, uint256 placedTimestamp, uint256 completedTimestamp, uint256 userCompletedTimestamp, address acceptedMerchant, address user, address recipientAddr, string pubkey, string encUpi, bool userCompleted, uint8 status, uint8 orderType, tuple(uint8 raisedBy, uint8 status, uint256 redactTransId, uint256 accountNumber) disputeInfo, uint256 id, string userPubKey, string encMerchantUpi, uint256 acceptedAccountNo))",
  "function getSmallOrderThreshold(bytes32) view returns (uint256)",
  "function getSmallOrderFixedFeeSell(bytes32) view returns (uint256)",
  "function paidBuyOrder(uint256 _orderId)",
];

const f = (n: bigint) => `${ethers.formatUnits(n, 6)} USDC`;
const heading = (s: string) => console.log(`\n${"─".repeat(70)}\n  ${s}\n${"─".repeat(70)}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pollStatus(diamond: any, id: bigint, target: number, label: string) {
  let last = -1;
  for (let i = 0; i < POLL_ITERS; i++) {
    const s = Number((await diamond.getOrdersById(id)).status);
    if (s !== last) { console.log(`  [poll] order ${id} → ${STATUS[s]}`); last = s; }
    if (s === target) return;
    if (s === 4 && target !== 4) throw new Error(`order ${id} CANCELLED while waiting for ${label}`);
    await sleep(POLL_MS);
  }
  throw new Error(`timeout waiting for ${label} (last=${STATUS[last]})`);
}

/** Poll balanceOf until it equals `want` (survives Alchemy read-after-write lag). */
async function waitForBalance(usdc: any, addr: string, want: bigint, label: string): Promise<bigint> {
  let seen = -1n;
  for (let i = 0; i < 40; i++) {
    const b: bigint = await usdc.balanceOf(addr);
    if (b !== seen) seen = b;
    if (b === want) return b;
    await sleep(3000);
  }
  throw new Error(`${label}: balance settled at ${f(seen)}, expected ${f(want)}`);
}

function eventArg(rc: any, iface: any, name: string, arg: string): bigint | undefined {
  for (const log of rc.logs) {
    try {
      const p = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (p?.name === name) return p.args[arg] as bigint;
    } catch { /* not ours */ }
  }
  return undefined;
}

async function onramp(integ: any, diamond: any, usdc: any, me: string) {
  heading(`ONRAMP — buy ${f(ONRAMP_USDC)} to ${me}`);
  const before: bigint = await usdc.balanceOf(me);
  console.log(`user USDC before: ${f(before)}`);

  const fiatLimit = 1_000_000_000000n; // generous ceiling; slippage never binds for a tiny test buy
  const pubKey = ethers.Wallet.createRandom().signingKey.publicKey.slice(4);
  const rc = await (await integ.userBuyUsdc(ONRAMP_USDC, CURRENCY, CIRCLE_ID, pubKey, 0n, fiatLimit)).wait(1);
  const orderId = eventArg(rc, integ.interface, "OnrampOrderCreated", "orderId");
  if (orderId === undefined) throw new Error("OnrampOrderCreated not emitted");
  console.log(`  placed BUY order ${orderId} (order.user = the EOA)`);

  await pollStatus(diamond, orderId, 1, "ACCEPTED");

  // User marks the fiat paid. The merchant may need a moment post-accept to set
  // its payment details, so retry paidBuyOrder until it lands.
  console.log("  marking paid (paidBuyOrder)…");
  let paid = false;
  for (let i = 0; i < 18 && !paid; i++) {
    try {
      await (await diamond.paidBuyOrder(orderId)).wait(1);
      paid = true;
    } catch (e: any) {
      if (i === 17) throw new Error(`paidBuyOrder kept reverting: ${e.shortMessage || e.message}`);
      await sleep(5000);
    }
  }
  console.log("  marked paid ✓");

  await pollStatus(diamond, orderId, 3, "COMPLETED");
  const after = await waitForBalance(usdc, me, before + ONRAMP_USDC, "onramp credit");
  console.log(`user USDC after:  ${f(after)}   Δ = +${f(after - before)}`);
  console.log(`✅ ONRAMP passed — received exactly ${f(ONRAMP_USDC)} to the user's own wallet`);
}

async function offramp(integ: any, diamond: any, usdc: any, me: string) {
  const threshold = await diamond.getSmallOrderThreshold(CURRENCY);
  const fee = OFFRAMP_USDC <= threshold ? await diamond.getSmallOrderFixedFeeSell(CURRENCY) : 0n;
  const needed = OFFRAMP_USDC + fee;
  heading(`OFFRAMP — sell ${f(OFFRAMP_USDC)} (fee ${f(fee)}, pull ${f(needed)}) from ${me}`);

  const before: bigint = await usdc.balanceOf(me);
  console.log(`user USDC before: ${f(before)}`);
  if (before < needed) throw new Error("user has insufficient USDC for the offramp");

  await (await usdc.approve(INTEGRATOR, needed + 500000n)).wait(1);
  console.log(`  approved ${f(needed + 500000n)} to the integrator`);

  const userPubKey = ethers.Wallet.createRandom().signingKey.publicKey.slice(4);
  const rc = await (await integ.userInitiateOfframp(OFFRAMP_USDC, CURRENCY, 0n, CIRCLE_ID, 0n, userPubKey)).wait(1);
  const orderId = eventArg(rc, integ.interface, "OfframpInitiated", "orderId");
  if (orderId === undefined) throw new Error("OfframpInitiated not emitted");
  const sysProxy = await integ.systemProxy();
  console.log(`  placed SELL order ${orderId} (order.user = systemProxy ${sysProxy})`);

  await pollStatus(diamond, orderId, 1, "ACCEPTED");
  console.log("  deliverOfframpUpi → pulling USDC from the user's wallet…");
  await (await integ.deliverOfframpUpi(orderId, "0xmock_enc_upi_e2e")).wait(1);
  await pollStatus(diamond, orderId, 2, "PAID");
  await pollStatus(diamond, orderId, 3, "COMPLETED");

  await (await integ.reconcile(orderId)).wait(1);
  const rec = await integ.getOfframp(orderId);
  console.log(`  reconciled lastStatus = ${STATUS[Number(rec.lastStatus)]}`);

  const after = await waitForBalance(usdc, me, before - needed, "offramp debit");
  console.log(`user USDC after:  ${f(after)}   Δ = -${f(before - after)}`);
  console.log(`✅ OFFRAMP passed — debited exactly ${f(needed)} (principal+fee) from the user's wallet`);
}

async function main() {
  const signers = await ethers.getSigners();
  const user = signers[1]; // plain EOA
  if (!user) throw new Error("need a mnemonic so acct1 exists");
  const me = user.address;
  const integ = (await ethers.getContractAt("BlackstripeCheckoutIntegrator", INTEGRATOR)).connect(user) as any;
  const diamond = new ethers.Contract(DIAMOND, DIAMOND_ABI, user);
  const usdc = await ethers.getContractAt("IERC20", USDC, user);

  heading("Blackstripe E2E — pre-flight");
  const net = await ethers.provider.getNetwork();
  console.log(`chainId:     ${net.chainId}`);
  console.log(`user (acct1):${me}  ETH=${ethers.formatEther(await ethers.provider.getBalance(me))}`);
  console.log(`integrator:  ${INTEGRATOR}`);

  const results: Record<string, string> = {};
  try { await onramp(integ, diamond, usdc, me); results.onramp = "PASS"; }
  catch (e: any) { results.onramp = `FAIL — ${e.message}`; console.error(`\n❌ ONRAMP failed: ${e.message}`); }
  try { await offramp(integ, diamond, usdc, me); results.offramp = "PASS"; }
  catch (e: any) { results.offramp = `FAIL — ${e.message}`; console.error(`\n❌ OFFRAMP failed: ${e.message}`); }

  heading("Summary");
  console.log(`  onramp:  ${results.onramp}`);
  console.log(`  offramp: ${results.offramp}`);
  if (results.onramp !== "PASS" || results.offramp !== "PASS") process.exit(1);
  console.log("\n🎉 Blackstripe onramp + offramp both passed end-to-end.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
