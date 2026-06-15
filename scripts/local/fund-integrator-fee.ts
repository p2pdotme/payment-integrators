/**
 * Remediation: top up the TradeStars v1 integrator's USDC so a stuck SELL
 * offramp can be delivered.
 *
 * ROOT CAUSE (prod, order 558990):
 *   `deliverOfframpUpi` pays `actualUsdtAmount` (= principal + small-order fee)
 *   to the system proxy out of the INTEGRATOR'S OWN USDC balance. Placement
 *   (`placeSellOrderForBurn`) only released the *principal* from the vault via
 *   `releaseForOfframp(usdcAmount)`. The fee has no funding source, so once the
 *   integrator's incidental USDC float drops below the fee, delivery reverts
 *   with `OfframpInsufficientPool()` and the order is stuck at ACCEPTED with an
 *   empty `encUpi` (no payment details). The vault itself is wired correctly —
 *   it is never read during delivery.
 *
 * FIX (no redeploy): fund the integrator's USDC balance to cover the shortfall
 * for the stuck order plus a buffer for future orders' fees, then have the
 * relayer re-run delivery (admin replay endpoint).
 *
 * Usage:
 *   # dry-run (default) — prints the plan, sends nothing
 *   BASE_RPC=<rpc> npx hardhat run scripts/local/fund-integrator-fee.ts --network base
 *   # execute — signer (DEPLOYER_PRIVATE_KEY) must hold USDC
 *   EXECUTE=1 BASE_RPC=<rpc> DEPLOYER_PRIVATE_KEY=<key> \
 *     npx hardhat run scripts/local/fund-integrator-fee.ts --network base
 *
 * Env:
 *   ORDER_ID       stuck SELL order id           (default 558990)
 *   BUFFER_USDC    extra buffer on top of the    (default "2") — covers ~20
 *                  exact shortfall, in USDC                      future fees
 */
import { ethers } from "hardhat";

const INTEGRATOR = process.env.INTEGRATOR_ADDRESS || "0xF254aFF19ccC84B108836860c0129199E09a96f1";
const DIAMOND = process.env.DIAMOND_ADDRESS || "0x4cad6eC90e65baBec9335cAd728DDC610c316368";
const USDC = process.env.USDC_ADDRESS || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ORDER_ID = BigInt(process.env.ORDER_ID || "558990");
const BUFFER = ethers.parseUnits(process.env.BUFFER_USDC || "2", 6);
const EXECUTE = process.env.EXECUTE === "1";

const DIAMOND_ABI = [
  "function getAdditionalOrderDetails(uint256) view returns (tuple(uint64 fixedFeePaid,uint64 tipsPaid,uint128 acceptedTimestamp,uint128 paidTimestamp,uint128 reserved2,uint256 actualUsdtAmount,uint256 actualFiatAmount))",
  "function getOrdersById(uint256) view returns (tuple(uint256 amount,uint256 fiatAmount,uint256 placedTimestamp,uint256 completedTimestamp,uint256 userCompletedTimestamp,address acceptedMerchant,address user,address recipientAddr,string pubkey,string encUpi,bool userCompleted,uint8 status,uint8 orderType,tuple(uint8 raisedBy,uint8 status,uint256 redactTransId,uint256 accountNumber) disputeInfo,uint256 id,string userPubKey,string encMerchantUpi,uint256 acceptedAccountNo,uint256[] assignedAccountNos,bytes32 currency,uint256 preferredPaymentChannelConfigId,uint256 circleId))",
];
const STATUS = ["PLACED", "ACCEPTED", "PAID", "COMPLETED", "CANCELLED"];
const INTEGRATOR_ABI = [
  "function offramps(uint256) view returns (bytes32 solanaBurnTx,bytes32 solanaUserPubkey,uint256 usdcAmount,uint8 lastStatus,bool initialized,bool delivered)",
  "function offrampEnabled() view returns (bool)",
];
const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function transfer(address,uint256) returns (bool)",
];

const f = (n: bigint) => `${ethers.formatUnits(n, 6)} USDC (${n})`;

async function main() {
  const [signer] = await ethers.getSigners();
  const diamond = new ethers.Contract(DIAMOND, DIAMOND_ABI, signer);
  const integrator = new ethers.Contract(INTEGRATOR, INTEGRATOR_ABI, signer);
  const usdc = new ethers.Contract(USDC, USDC_ABI, signer);

  const order = await diamond.getOrdersById(ORDER_ID);
  const aod = await diamond.getAdditionalOrderDetails(ORDER_ID);
  const rec = await integrator.offramps(ORDER_ID);
  const status = Number(order.status);
  const needed: bigint = aod.actualUsdtAmount; // principal + fee
  const balance: bigint = await usdc.balanceOf(INTEGRATOR);

  console.log("── Stuck-offramp funding plan ──────────────────────────────");
  console.log(`order id                 ${ORDER_ID}`);
  console.log(`order.status             ${status} (${STATUS[status] ?? "?"})`);
  console.log(`order.encUpi present     ${order.encUpi.length > 0}`);
  console.log(`offramps[].initialized   ${rec.initialized}`);
  console.log(`offramps[].delivered     ${rec.delivered}   (must be false to re-deliver)`);
  console.log(`actualUsdtAmount (need)  ${f(needed)}`);
  console.log(`integrator USDC balance  ${f(balance)}`);

  if (status >= 3) {
    console.log(`\nOrder is TERMINAL (${STATUS[status]}). It cannot be delivered.`);
    console.log("If CANCELLED, the user got no fiat — re-initiate their withdrawal.");
    console.log("This order's principal was never pulled by the Diamond; it is part of");
    console.log("the integrator's USDC balance above (sweep to vault via reconcile/owner).");
    return;
  }
  if (needed === 0n) {
    console.log(
      "\nactualUsdtAmount is 0 — Diamond has not priced the order yet (retry after acceptance). Abort."
    );
    return;
  }
  if (rec.delivered) {
    console.log("\nAlready delivered on-chain — nothing to fund. Aborb.");
    return;
  }

  const shortfall = needed > balance ? needed - balance : 0n;
  console.log(`shortfall                ${f(shortfall)}`);

  if (shortfall === 0n) {
    console.log("\nIntegrator already holds enough — just re-run delivery (no top-up needed).");
    return;
  }

  const topUp = shortfall + BUFFER;
  console.log(`buffer for future fees   ${f(BUFFER)}`);
  console.log(`==> top-up to send       ${f(topUp)}   from signer ${await signer.getAddress()}`);

  if (!EXECUTE) {
    console.log("\nDRY-RUN. Re-run with EXECUTE=1 (signer must hold USDC) to send the top-up.");
    console.log("After funding, re-deliver via the relayer admin replay endpoint (see notes).");
    return;
  }

  const signerBal: bigint = await usdc.balanceOf(await signer.getAddress());
  if (signerBal < topUp) throw new Error(`Signer holds ${f(signerBal)}, needs ${f(topUp)}`);

  console.log("\nSending USDC.transfer(integrator, topUp) ...");
  const tx = await usdc.transfer(INTEGRATOR, topUp);
  console.log(`tx ${tx.hash} — waiting ...`);
  await tx.wait();
  const after: bigint = await usdc.balanceOf(INTEGRATOR);
  console.log(`done. integrator USDC now ${f(after)} (needed ${f(needed)} for order ${ORDER_ID}).`);
  console.log("Now re-deliver: relayer admin replay endpoint, or relayer calls deliverOfframpUpi.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
