import { ethers } from "hardhat";

/**
 * Live Base Sepolia E2E for OwnCheckoutIntegrator.
 *
 * Run from acct1 (a PLAIN EOA; acct0 is 7702-delegated and hits the RPC's
 * in-flight-tx limit). A demo-merchant-bot must be running in circle 1 / INR
 * for the order to be accepted and completed.
 *
 *   1. sign + submit a passport+liveness attestation  → effectiveLimit > 0
 *   2. buyUsdc                                        → order PLACED
 *   3. [bot accepts]                                  → ACCEPTED
 *   4. paidBuyOrder (user marks fiat paid)            → PAID
 *   5. [bot completes]                                → COMPLETED
 *   6. assert the settlement token landed in the USER'S OWN EOA, and that
 *      neither the integrator nor the user's proxy holds any of it.
 *
 * Step 6 is the whole point: this integrator's core claim is that it is never
 * in the funds path. The assertion is the test.
 *
 * The attestation in step 1 is signed locally by the testnet attestor key
 * (the deployer). On mainnet that signature comes from the passport+liveness
 * service instead — the contract cannot tell the difference, which is exactly
 * why the attestor address must be read from the service and never relayed.
 *
 *   INTEGRATOR_ADDRESS=0x... [AMOUNT=2000000] [STOP_AFTER_PLACE=1] \
 *   npx hardhat run scripts/local/e2e-own-sepolia.ts --network baseSepolia
 */

const DIAMOND = process.env.DIAMOND_ADDRESS || "0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9";
const USDC = process.env.USDC_ADDRESS || "0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d";
const INTEGRATOR = process.env.INTEGRATOR_ADDRESS || "0x6e2Feec8434de08732D7ed5A0cDDd748dEFbB032";
const AMOUNT = BigInt(process.env.AMOUNT || "2000000"); // 2 units
const CIRCLE_ID = BigInt(process.env.CIRCLE_ID || "1");
const CURRENCY = ethers.encodeBytes32String(process.env.CURRENCY || "INR");
/** Stop once the order is PLACED — useful when no merchant bot is running. */
const STOP_AFTER_PLACE = process.env.STOP_AFTER_PLACE === "1";
const POLL_ITERS = Number(process.env.POLL_ITERS || "120");
// Orders carry a short TTL on this deployment: an ACCEPTED order that is not
// marked paid quickly reverts `paidBuyOrder` with OrderExpired(). Poll tight so
// the paid call lands in the same window the merchant accepted in.
const POLL_MS = Number(process.env.POLL_MS || "2000");

const STATUS = ["PLACED", "ACCEPTED", "PAID", "COMPLETED", "CANCELLED"];

const DIAMOND_ABI = [
  "function getOrdersById(uint256) view returns (tuple(uint256 amount, uint256 fiatAmount, uint256 placedTimestamp, uint256 completedTimestamp, uint256 userCompletedTimestamp, address acceptedMerchant, address user, address recipientAddr, string pubkey, string encUpi, bool userCompleted, uint8 status, uint8 orderType, tuple(uint8 raisedBy, uint8 status, uint256 redactTransId, uint256 accountNumber) disputeInfo, uint256 id, string userPubKey, string encMerchantUpi, uint256 acceptedAccountNo))",
  "function paidBuyOrder(uint256 _orderId)",
];

const INTEGRATOR_ABI = [
  "function attestor() view returns (address)",
  "function diamond() view returns (address)",
  "function usdc() view returns (address)",
  "function verified(address) view returns (bool)",
  "function grantedLimit(address) view returns (uint256)",
  "function effectiveLimit(address,bytes32) view returns (uint256)",
  "function getRemainingDailyCount(address) view returns (uint256)",
  "function proxyAddress(address) view returns (address)",
  "function domainSeparator() view returns (bytes32)",
  "function getSession(uint256) view returns (tuple(address user, bool settled, bool cancelled, uint32 placementDay, uint256 amount, bytes32 currency))",
  "function submitPassportAttestation(bytes32 nullifier, uint256 limit, uint256 expiry, bytes signature) returns ()",
  "function buyUsdc(uint256 amount, bytes32 currency, uint256 circleId, string pubKey, uint256 preferredPaymentChannelConfigId, uint256 fiatAmountLimit) returns (uint256)",
  "event OnrampOrderCreated(uint256 indexed orderId, address indexed user, uint256 amount, bytes32 currency)",
];

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

const f = (n: bigint) => ethers.formatUnits(n, 6);
const heading = (s: string) => console.log(`\n${"─".repeat(70)}\n  ${s}\n${"─".repeat(70)}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pollStatus(diamond: any, id: bigint, target: number, label: string) {
  let last = -1;
  for (let i = 0; i < POLL_ITERS; i++) {
    const s = Number((await diamond.getOrdersById(id)).status);
    if (s !== last) {
      console.log(`  [poll] order ${id} → ${STATUS[s]}`);
      last = s;
    }
    if (s === target) return;
    if (s === 4 && target !== 4)
      throw new Error(`order ${id} CANCELLED while waiting for ${label}`);
    await sleep(POLL_MS);
  }
  throw new Error(`timeout waiting for ${label} (last=${STATUS[last]})`);
}

async function main() {
  const signers = await ethers.getSigners();
  // acct0 is 7702-delegated on Base and only tolerates ~1 in-flight tx; prefer
  // a plain EOA for the multi-step user journey.
  const user = signers[1] ?? signers[0];
  const attestorSigner = signers[0];
  const chainId = (await ethers.provider.getNetwork()).chainId;

  heading("Setup");
  console.log("user (buyer)  :", user.address);
  console.log("integrator    :", INTEGRATOR);
  console.log("amount        :", f(AMOUNT));

  const integ = new ethers.Contract(INTEGRATOR, INTEGRATOR_ABI, user);
  const diamond = new ethers.Contract(DIAMOND, DIAMOND_ABI, user);
  const token = new ethers.Contract(USDC, ERC20_ABI, ethers.provider);

  const onchainAttestor: string = await integ.attestor();
  console.log("attestor      :", onchainAttestor);
  if (onchainAttestor.toLowerCase() !== attestorSigner.address.toLowerCase()) {
    throw new Error(
      `This script can only mint test attestations when the on-chain attestor is ` +
        `the local signer ${attestorSigner.address}. It is ${onchainAttestor} — ` +
        `on a real deployment the attestation must come from the service.`
    );
  }
  if ((await integ.diamond()).toLowerCase() !== DIAMOND.toLowerCase()) {
    throw new Error("integrator.diamond() != DIAMOND");
  }
  if ((await integ.usdc()).toLowerCase() !== USDC.toLowerCase()) {
    throw new Error("integrator.usdc() != USDC");
  }

  // ── 1. Attestation ──────────────────────────────────────────────────────
  heading("1. Passport + liveness attestation");
  if (await integ.verified(user.address)) {
    console.log("  already verified — grant:", f(await integ.grantedLimit(user.address)));
  } else {
    const nullifier = ethers.keccak256(ethers.toUtf8Bytes(`own-e2e:${user.address}:${Date.now()}`));
    const limit = 100_000_000n; // $100 attested; region ceiling still applies
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);

    const signature = await attestorSigner.signTypedData(
      { name: "KycVerifier", version: "1", chainId, verifyingContract: INTEGRATOR },
      {
        KycAttestation: [
          { name: "wallet", type: "address" },
          { name: "nullifier", type: "bytes32" },
          { name: "limit", type: "uint256" },
          { name: "expiry", type: "uint256" },
        ],
      },
      { wallet: user.address, nullifier, limit, expiry }
    );

    console.log("  submitting attestation…");
    await (await integ.submitPassportAttestation(nullifier, limit, expiry, signature)).wait(1);
    console.log("  ✅ verified");
  }

  // Read-after-write on this RPC lags the receipt by a few blocks, so a fresh
  // grant reads back as 0 for a moment. Poll rather than trusting one read.
  let limIndia = 0n;
  for (let i = 0; i < 20; i++) {
    limIndia = await integ.effectiveLimit(user.address, CURRENCY);
    if (limIndia > 0n) break;
    await sleep(3000);
  }
  console.log(`  effectiveLimit (${process.env.CURRENCY || "INR"}): $${f(limIndia)}`);
  console.log(`  remaining today          : ${await integ.getRemainingDailyCount(user.address)}`);
  if (limIndia < AMOUNT) throw new Error(`effectiveLimit ${f(limIndia)} < amount ${f(AMOUNT)}`);

  // ── 2. Place the buy ────────────────────────────────────────────────────
  heading("2. Place the onramp order");
  const proxy: string = await integ.proxyAddress(user.address);
  const userBefore: bigint = await token.balanceOf(user.address);
  console.log("  user proxy    :", proxy);
  console.log("  user balance  :", f(userBefore));

  const pubKey = ethers.Wallet.createRandom().signingKey.publicKey.slice(4);
  const rc = await (await integ.buyUsdc(AMOUNT, CURRENCY, CIRCLE_ID, pubKey, 0n, 0n)).wait(1);

  let orderId = 0n;
  for (const log of rc!.logs) {
    try {
      const parsed = integ.interface.parseLog(log as any);
      if (parsed?.name === "OnrampOrderCreated") orderId = parsed.args.orderId;
    } catch {
      /* not ours */
    }
  }
  if (orderId === 0n) throw new Error("OnrampOrderCreated not found in receipt");
  console.log("  ✅ order placed:", orderId.toString(), `(tx ${rc!.hash})`);

  if (STOP_AFTER_PLACE) {
    console.log("\nSTOP_AFTER_PLACE=1 — stopping before the merchant leg.");
    return;
  }

  // ── 3-5. Merchant leg ───────────────────────────────────────────────────
  //
  // Orders on this deployment carry a SHORT TTL, and it runs from placement —
  // not from acceptance. Anything that inserts a delay between placing and
  // paying (even re-reading the order record, which lags on this RPC) burns the
  // window and makes `paidBuyOrder` revert OrderExpired(). So: one tight loop,
  // no intermediate awaits, pay the instant the merchant accepts. The
  // recipientAddr assertion moves after settlement for the same reason.
  heading("3-5. Merchant leg — accept → paid → complete (tight loop, short TTL)");
  let last = -1;
  let paid = false;
  let order: any = null;

  for (let i = 0; i < POLL_ITERS; i++) {
    order = await diamond.getOrdersById(orderId);
    const st = Number(order.status);
    if (st !== last) {
      console.log(`  [poll] ${new Date().toISOString().slice(11, 19)} → ${STATUS[st]}`);
      last = st;
    }
    if (st === 4) throw new Error(`order ${orderId} CANCELLED / expired`);
    if (st === 3) break;
    if (st === 1 && !paid) {
      console.log("  marking fiat paid…");
      await (await diamond.paidBuyOrder(orderId)).wait(1);
      paid = true;
      console.log("  ✅ paidBuyOrder sent");
    }
    await sleep(POLL_MS);
  }
  if (Number(order.status) !== 3) throw new Error("timed out before COMPLETED");

  console.log("  diamond.user         :", order.user);
  console.log("  diamond.recipientAddr:", order.recipientAddr);
  if (order.recipientAddr.toLowerCase() !== user.address.toLowerCase()) {
    throw new Error(
      `recipientAddr is ${order.recipientAddr}, expected the buyer ${user.address} — ` +
        `settlement would NOT land in the user's wallet`
    );
  }
  console.log("  ✅ recipientAddr is the buyer's own wallet");

  // ── 6. The invariant ────────────────────────────────────────────────────
  heading("6. Where did the money go?");
  let userAfter: bigint = await token.balanceOf(user.address);
  for (let i = 0; i < 20 && userAfter === userBefore; i++) {
    await sleep(3000);
    userAfter = await token.balanceOf(user.address);
  }
  const integBal: bigint = await token.balanceOf(INTEGRATOR);
  const proxyBal: bigint = await token.balanceOf(proxy);

  console.log(`  user      : ${f(userBefore)} → ${f(userAfter)}  (+${f(userAfter - userBefore)})`);
  console.log(`  integrator: ${f(integBal)}`);
  console.log(`  proxy     : ${f(proxyBal)}`);

  const session = await integ.getSession(orderId);
  console.log(`  session.settled: ${session.settled}`);

  const problems: string[] = [];
  if (userAfter - userBefore !== AMOUNT) {
    problems.push(`user received ${f(userAfter - userBefore)}, expected ${f(AMOUNT)}`);
  }
  if (integBal !== 0n) problems.push(`integrator holds ${f(integBal)} — it must hold nothing`);
  if (proxyBal !== 0n) problems.push(`proxy holds ${f(proxyBal)} — it must hold nothing`);
  if (!session.settled) problems.push("session not marked settled (onOrderComplete did not fire)");

  if (problems.length) {
    console.log("\n❌ FAILED:");
    for (const p of problems) console.log("   -", p);
    process.exit(1);
  }

  console.log("\n✅ E2E PASSED — settlement landed directly in the buyer's own wallet,");
  console.log("   with zero balance held by the integrator or its proxy.");
  console.log("\n   Next leg (off this chain, from the user's own wallet): bridge the");
  console.log("   USDC to USDG on Robinhood Chain via Relay. Not available on Sepolia —");
  console.log("   Relay routes Base mainnet (8453) → Robinhood (4663) only.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
