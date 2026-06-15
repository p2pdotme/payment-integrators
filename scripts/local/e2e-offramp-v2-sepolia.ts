import { ethers } from "hardhat";

/**
 * End-to-end offramp v2 on Base Sepolia. Drives the full user-driven SELL:
 *   allocateOfframp (relayer) → userStartOfframp (user) → [bot accepts]
 *   → userDeliverOfframpUpi (user) → [bot completes] → syncOfframp.
 *
 * The single deployer key acts as BOTH the relayer and the offramp user
 * (allocate is relayer-gated; start/deliver are gated on allocation.user — all
 * the same EOA here). A demo-merchant-bot must be running and registered in the
 * SELL circle for the chosen currency so the order gets accepted + completed.
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x... INTEGRATOR_ADDRESS=0x... VAULT_ADDRESS=0x... \
 *   [OFFRAMP_AMOUNT=2000000] [CURRENCY=INR] [CIRCLE_ID=1] [POLL_TIMEOUT_MS=240000] \
 *   npx hardhat run scripts/e2e-offramp-v2-sepolia.ts --network baseSepolia
 */

const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "";
const INTEGRATOR_ADDRESS = process.env.INTEGRATOR_ADDRESS || "";
const VAULT_ADDRESS = process.env.VAULT_ADDRESS || "";
const OFFRAMP_AMOUNT = process.env.OFFRAMP_AMOUNT || "2000000"; // 2 USDC
const CURRENCY = process.env.CURRENCY || "INR";
const CIRCLE_ID = BigInt(process.env.CIRCLE_ID || "1");
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS || "240000");

const STATUS = ["PLACED", "ACCEPTED", "PAID", "COMPLETED", "CANCELLED"];

// Minimal Diamond read ABI. OrderView tuple shape must match the Diamond
// exactly (positional decode) — mirrors IOrderFlow.OrderView.
const ORDER_TUPLE = {
  type: "tuple",
  components: [
    { name: "amount", type: "uint256" },
    { name: "fiatAmount", type: "uint256" },
    { name: "placedTimestamp", type: "uint256" },
    { name: "completedTimestamp", type: "uint256" },
    { name: "userCompletedTimestamp", type: "uint256" },
    { name: "acceptedMerchant", type: "address" },
    { name: "user", type: "address" },
    { name: "recipientAddr", type: "address" },
    { name: "pubkey", type: "string" },
    { name: "encUpi", type: "string" },
    { name: "userCompleted", type: "bool" },
    { name: "status", type: "uint8" },
    { name: "orderType", type: "uint8" },
    {
      name: "disputeInfo",
      type: "tuple",
      components: [
        { name: "raisedBy", type: "uint8" },
        { name: "status", type: "uint8" },
        { name: "redactTransId", type: "uint256" },
        { name: "accountNumber", type: "uint256" },
      ],
    },
    { name: "id", type: "uint256" },
    { name: "userPubKey", type: "string" },
    { name: "encMerchantUpi", type: "string" },
    { name: "acceptedAccountNo", type: "uint256" },
    { name: "assignedAccountNos", type: "uint256[]" },
    { name: "currency", type: "bytes32" },
    { name: "preferredPaymentChannelConfigId", type: "uint256" },
    { name: "circleId", type: "uint256" },
  ],
} as const;

const DIAMOND_ABI = [
  {
    name: "getOrdersById",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "orderId", type: "uint256" }],
    outputs: [ORDER_TUPLE],
  },
  {
    name: "getSmallOrderThreshold",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "currency", type: "bytes32" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "getSmallOrderFixedFee",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "currency", type: "bytes32" }],
    outputs: [{ type: "uint256" }],
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (n: bigint) => ethers.formatUnits(n, 6);

async function pollStatus(diamond: any, orderId: bigint, want: number[], label: string) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last = -1;
  while (Date.now() < deadline) {
    const o = await diamond.getOrdersById(orderId);
    const s = Number(o.status);
    if (s !== last) {
      console.log(`    [poll] order ${orderId} status = ${s} (${STATUS[s]})`);
      last = s;
    }
    if (want.includes(s)) return s;
    await sleep(5000);
  }
  throw new Error(`Timed out waiting for ${label} on order ${orderId} (last status ${last})`);
}

async function main() {
  for (const [k, v] of Object.entries({
    DIAMOND_ADDRESS,
    USDC_ADDRESS,
    INTEGRATOR_ADDRESS,
    VAULT_ADDRESS,
  })) {
    if (!v) throw new Error(`${k} env var required`);
  }

  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();

  const integrator = await ethers.getContractAt(
    "TradeStarsCheckoutIntegratorV2",
    INTEGRATOR_ADDRESS
  );
  const vault = await ethers.getContractAt("RestrictedYieldVault", VAULT_ADDRESS);
  const usdc = await ethers.getContractAt("IERC20", USDC_ADDRESS);
  const diamond = new ethers.Contract(DIAMOND_ADDRESS, DIAMOND_ABI, signer);

  const currencyHex = ethers.encodeBytes32String(CURRENCY);
  const amount = BigInt(OFFRAMP_AMOUNT);

  console.log("=== Offramp v2 E2E (Base Sepolia) ===");
  console.log("Signer (relayer+user):", me);
  console.log("Integrator:           ", INTEGRATOR_ADDRESS);
  console.log("Vault:                ", VAULT_ADDRESS);
  console.log("Amount:               ", fmt(amount), CURRENCY);
  console.log("");

  // ── Preflight ──────────────────────────────────────────────────────
  console.log("Preflight:");
  console.log("  offrampEnabled:   ", await integrator.offrampEnabled());
  console.log("  offrampRelayer:   ", await integrator.offrampRelayer());
  console.log("  maxUsdcPerOfframp:", fmt(await integrator.maxUsdcPerOfframp()));
  console.log("  vault offrampQuota:", fmt(await vault.offrampQuota()));
  try {
    const threshold = await diamond.getSmallOrderThreshold(currencyHex);
    const fixedFee = await diamond.getSmallOrderFixedFee(currencyHex);
    console.log(`  smallOrderThreshold(${CURRENCY}):`, fmt(threshold), " fixedFee:", fmt(fixedFee));
  } catch {
    // This Diamond version may not expose the unified fee getters — the
    // authoritative actualUsdtAmount is read from getAdditionalOrderDetails
    // after placement, so this preflight line is best-effort only.
    console.log(
      `  small-order fee getters unavailable here — using getAdditionalOrderDetails post-placement`
    );
  }
  if ((await vault.offrampQuota()) < amount) {
    throw new Error(
      `Vault offrampQuota ${fmt(await vault.offrampQuota())} < amount ${fmt(amount)}. Seed the vault (deposit USDC) first.`
    );
  }
  console.log("");

  // ── 1. allocateOfframp (relayer) ────────────────────────────────────
  const burnTx = ethers.id(`e2e-burn-${me}-${Date.now()}`);
  const solPubkey = ethers.hexlify(ethers.randomBytes(32));
  console.log("1) allocateOfframp …", { burnTx });
  let tx = await integrator.allocateOfframp(me, amount, burnTx, solPubkey);
  let rcpt = await tx.wait();
  const allocEv = rcpt!.logs
    .map((l: any) => {
      try {
        return integrator.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((p: any) => p?.name === "OfframpAllocated");
  const allocationId = allocEv!.args.allocationId as bigint;
  const proxy = await integrator.proxyAddress(me);
  console.log("   allocationId:", allocationId.toString(), " proxy:", proxy);
  console.log("   proxy USDC balance:", fmt(await usdc.balanceOf(proxy)));
  console.log("   availableOfframp:", fmt(await integrator.availableOfframp(me)));

  // ── 2. userStartOfframp (user) ──────────────────────────────────────
  const wallet = ethers.Wallet.createRandom();
  const userPubKey = ethers.SigningKey.computePublicKey(wallet.privateKey, false).slice(4); // 128 hex, no 0x04
  console.log("2) userStartOfframp …");
  tx = await integrator.userStartOfframp(allocationId, currencyHex, 0n, CIRCLE_ID, 0n, userPubKey);
  rcpt = await tx.wait();
  const placedEv = rcpt!.logs
    .map((l: any) => {
      try {
        return integrator.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((p: any) => p?.name === "OfframpOrderPlaced");
  const orderId = placedEv!.args.orderId as bigint;
  const order = await diamond.getOrdersById(orderId);
  console.log("   orderId:", orderId.toString());
  console.log(
    "   order.user:",
    order.user,
    order.user.toLowerCase() === proxy.toLowerCase()
      ? "✓ (user's proxy — history attribution)"
      : "✗ MISMATCH"
  );

  // ── 3. wait for the merchant bot to ACCEPT ──────────────────────────
  console.log("3) waiting for merchant bot to ACCEPT (run demo-merchant-bot now if not running)…");
  await pollStatus(
    diamond,
    orderId,
    [STATUS.indexOf("ACCEPTED"), STATUS.indexOf("CANCELLED")],
    "ACCEPTED"
  );
  let s = Number((await diamond.getOrdersById(orderId)).status);
  if (s === STATUS.indexOf("CANCELLED")) throw new Error("Order was cancelled before acceptance");

  // ── 4. userDeliverOfframpUpi (user) ─────────────────────────────────
  // Top up the integrator's float if there's a small-order fee, so the
  // proxy can cover actualUsdtAmount = amount + fee.
  const aod = await diamond.getOrdersById(orderId); // (status only used above)
  const detailsAbi = [
    "function getAdditionalOrderDetails(uint256) view returns (uint64,uint64,uint128,uint128,uint128,uint256,uint256)",
  ];
  const dd = new ethers.Contract(DIAMOND_ADDRESS, detailsAbi, signer);
  const details = await dd.getAdditionalOrderDetails(orderId);
  const needed = details[5] as bigint; // actualUsdtAmount
  console.log("   actualUsdtAmount (needed):", fmt(needed));
  const proxyBal = await usdc.balanceOf(proxy);
  if (proxyBal < needed) {
    const gap = needed - proxyBal;
    const myBal = await usdc.balanceOf(me);
    if (myBal < gap)
      throw new Error(
        `Need ${fmt(gap)} USDC fee float on the integrator but signer holds ${fmt(myBal)}`
      );
    console.log(`   topping up integrator float by ${fmt(gap)} (small-order fee)…`);
    await (await usdc.transfer(INTEGRATOR_ADDRESS, gap)).wait();
  }
  const encUpi = JSON.stringify({ e2e: true, ts: Date.now() }); // bot doesn't decrypt
  console.log("4) userDeliverOfframpUpi …");
  tx = await integrator.userDeliverOfframpUpi(orderId, encUpi);
  await tx.wait();
  console.log("   delivered. proxy USDC balance:", fmt(await usdc.balanceOf(proxy)));

  // ── 5. wait for COMPLETED, then sync ────────────────────────────────
  console.log("5) waiting for merchant bot to COMPLETE…");
  s = await pollStatus(
    diamond,
    orderId,
    [STATUS.indexOf("COMPLETED"), STATUS.indexOf("CANCELLED")],
    "terminal"
  );
  console.log("   terminal status:", STATUS[s]);
  await (await integrator.syncOfframp(orderId)).wait();
  const a = await integrator.getAllocation(allocationId);
  console.log("   allocation.lastStatus:", STATUS[Number(a.lastStatus)], " settled:", a.settled);
  console.log("   availableOfframp now:", fmt(await integrator.availableOfframp(me)));

  if (s === STATUS.indexOf("COMPLETED")) {
    console.log("\n✅ E2E PASSED — offramp completed end-to-end, attributed to the user's proxy.");
  } else {
    console.log(
      "\n⚠️  Order CANCELLED. USDC is back in the proxy; availableOfframp should still reflect it for retry."
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
