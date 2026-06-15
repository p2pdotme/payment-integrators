/**
 * Fund the TradeStars offramp integrator's USDC fee buffer (Base mainnet).
 *
 * WHY THIS IS NEEDED
 *   On a SELL/offramp, the integrator's `deliverOfframpUpi` must pay the Diamond
 *   `actualUsdtAmount` = principal + small-order fee (~0.1 USDC), and it pays
 *   that out of the INTEGRATOR'S OWN USDC balance. Placement only releases the
 *   *principal* from the vault — the fee has no funding source. When the
 *   integrator's USDC float drops below the fee, delivery reverts with
 *   `OfframpInsufficientPool()` and the offramp gets stuck at ACCEPTED with no
 *   payment details (then the merchant cancels it). Keeping a USDC buffer on the
 *   integrator makes delivery always cover the fee. (The vault is wired
 *   correctly and is NOT the problem.)
 *
 * WHAT IT DOES
 *   A plain ERC-20 USDC transfer from YOUR wallet -> the integrator. Nothing
 *   else. ~0.1 USDC is consumed per small-order withdrawal, so e.g. 5 USDC
 *   covers ~50 of them. Top up again when it runs low.
 *
 * SETUP
 *   npm init -y && npm i ethers@6
 *
 * RUN (dry-run first — sends nothing, just prints the plan):
 *   RPC_URL="https://base-mainnet.g.alchemy.com/v2/<key>" \
 *   PRIVATE_KEY="0x<key of a wallet holding USDC>" \
 *   AMOUNT_USDC="5" \
 *   node fund-tradestars-integrator.mjs
 *
 *   Then add EXECUTE=1 to actually send:
 *   EXECUTE=1 RPC_URL=... PRIVATE_KEY=... AMOUNT_USDC="5" node fund-tradestars-integrator.mjs
 *
 * NOTES
 *   - The signing wallet just needs to hold >= AMOUNT_USDC of USDC. It does NOT
 *     have to be the integrator/vault owner — any USDC sender works.
 *   - Base mainnet USDC has 6 decimals.
 */
import { ethers } from "ethers";

// ─── Fixed addresses (Base mainnet) ──────────────────────────────────
const INTEGRATOR = "0xF254aFF19ccC84B108836860c0129199E09a96f1"; // TradeStars offramp integrator
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // native USDC, 6dp

// ─── Inputs ──────────────────────────────────────────────────────────
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const AMOUNT_USDC = process.env.AMOUNT_USDC || "5"; // buffer to send, in USDC
const EXECUTE = process.env.EXECUTE === "1";

const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function transfer(address,uint256) returns (bool)",
];

const f = (n) => `${ethers.formatUnits(n, 6)} USDC`;

async function main() {
  if (!RPC_URL) throw new Error("Set RPC_URL (a Base mainnet RPC URL).");
  if (!PRIVATE_KEY) throw new Error("Set PRIVATE_KEY (a wallet holding USDC).");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const net = await provider.getNetwork();
  if (net.chainId !== 8453n) {
    throw new Error(`Expected Base mainnet (chainId 8453), got ${net.chainId}.`);
  }

  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const usdc = new ethers.Contract(USDC, USDC_ABI, wallet);
  const amount = ethers.parseUnits(AMOUNT_USDC, 6);

  const from = await wallet.getAddress();
  const senderBal = await usdc.balanceOf(from);
  const integBefore = await usdc.balanceOf(INTEGRATOR);

  console.log("── Fund TradeStars integrator USDC buffer ──────────────────");
  console.log(`network              Base mainnet (8453)`);
  console.log(`sender               ${from}`);
  console.log(`sender USDC balance  ${f(senderBal)}`);
  console.log(`integrator           ${INTEGRATOR}`);
  console.log(`integrator USDC now  ${f(integBefore)}`);
  console.log(`amount to send       ${f(amount)}`);

  if (senderBal < amount) {
    throw new Error(
      `Sender holds ${f(senderBal)} but needs ${f(amount)}. ` +
        `Top the wallet up with USDC, or lower AMOUNT_USDC.`,
    );
  }

  if (!EXECUTE) {
    console.log("\nDRY-RUN — nothing sent. Re-run with EXECUTE=1 to transfer.");
    return;
  }

  console.log("\nSending USDC.transfer(integrator, amount) ...");
  const tx = await usdc.transfer(INTEGRATOR, amount);
  console.log(`tx hash: ${tx.hash}`);
  const rcpt = await tx.wait();
  console.log(`confirmed in block ${rcpt.blockNumber}`);
  console.log(`integrator USDC now  ${f(await usdc.balanceOf(INTEGRATOR))}`);
  console.log("\nDone. New offramp deliveries will now cover the fee from this buffer.");
}

main().catch((e) => {
  console.error("\nERROR:", e.message || e);
  process.exitCode = 1;
});
