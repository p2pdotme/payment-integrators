import { ethers } from "hardhat";

/**
 * Create a cashback campaign — this script IS the five-field form.
 *
 * Run this as the INTEGRATOR OWNER — the address a registry admin assigned
 * via setIntegratorOwner. Nobody else can create campaigns for it.
 *
 * Required env:
 *   REGISTRY_ADDRESS   deployed CashbackRegistry
 *   INTEGRATOR         integrator address the campaign applies to (you must own it)
 *   REWARD_TOKEN       ERC-20 paid out as cashback
 *   RATE_BPS           percentage in basis points (100 = 1%)   — XOR FLAT_AMOUNT
 *   FLAT_AMOUNT        fixed reward per order, token units     — XOR RATE_BPS
 *
 * Optional env:
 *   ORDER_TYPE         "BUY" | "SELL" | "ANY"   (default BUY)
 *   CURRENCY           e.g. "INR", or "ANY"     (default ANY)
 *   FUNDING_WALLET     wallet paying for THIS campaign (default: your own
 *                      address). Must be you, or a wallet that has approved
 *                      you as a spender of REWARD_TOKEN — proving control.
 *   ACTIVATE           "true" to activate immediately (default false — a
 *                      campaign starts as a draft so it cannot pay out
 *                      half-configured)
 *
 * Example — 1% back in INR on the payqr merchant terminal:
 *   REGISTRY_ADDRESS=0x… \
 *   INTEGRATOR=0x4aBDf0726cd1B03F43b3d054063b569dFD7772A0 \
 *   REWARD_TOKEN=0x… ORDER_TYPE=BUY CURRENCY=INR RATE_BPS=100 \
 *   npx hardhat run scripts/create-campaign.ts --network baseSepolia
 */

const REGISTRY_ADDRESS = process.env.REGISTRY_ADDRESS || "";
const INTEGRATOR = process.env.INTEGRATOR || "";
const REWARD_TOKEN = process.env.REWARD_TOKEN || "";
const RATE_BPS = process.env.RATE_BPS || "0";
const FLAT_AMOUNT = process.env.FLAT_AMOUNT || "0";
const ORDER_TYPE = process.env.ORDER_TYPE || "BUY";
const CURRENCY = process.env.CURRENCY || "ANY";
const FUNDING_WALLET = process.env.FUNDING_WALLET || "";
const ACTIVATE = (process.env.ACTIVATE || "").toLowerCase() === "true";

/** "ANY" maps to bytes32(0), the registry's wildcard. */
function toBytes32(label: string): string {
  if (label.toUpperCase() === "ANY") return ethers.ZeroHash;
  return ethers.encodeBytes32String(label);
}

async function main() {
  if (!REGISTRY_ADDRESS || !INTEGRATOR || !REWARD_TOKEN) {
    throw new Error("REGISTRY_ADDRESS, INTEGRATOR and REWARD_TOKEN env vars are required");
  }

  const bps = BigInt(RATE_BPS);
  const flat = BigInt(FLAT_AMOUNT);
  if (bps > 0n === flat > 0n) {
    throw new Error("Set exactly one of RATE_BPS or FLAT_AMOUNT (not both, not neither)");
  }

  const orderType = toBytes32(ORDER_TYPE);
  const currency = toBytes32(CURRENCY);

  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  const fundingWallet = FUNDING_WALLET || me;

  const registry = await ethers.getContractAt("CashbackRegistry", REGISTRY_ADDRESS);

  // Fail early with a clear message rather than an opaque revert.
  const owner = await registry.integratorOwner(INTEGRATOR);
  if (owner === ethers.ZeroAddress) {
    throw new Error(
      `Integrator ${INTEGRATOR} has no cashback owner yet. ` +
        `A registry admin must call setIntegratorOwner first.`
    );
  }
  if (owner.toLowerCase() !== me.toLowerCase()) {
    throw new Error(`Integrator ${INTEGRATOR} is owned by ${owner}, not you (${me}).`);
  }

  console.log("─── Campaign ────────────────────────────────────────────");
  console.log("Integrator:    ", INTEGRATOR);
  console.log("Order type:    ", ORDER_TYPE);
  console.log("Currency:      ", CURRENCY);
  console.log("Reward token:  ", REWARD_TOKEN);
  console.log(
    "Rate:          ",
    bps > 0n ? `${Number(bps) / 100}% (${bps} bps)` : `flat ${flat} token units`
  );
  console.log("Funded by:     ", fundingWallet);
  console.log("─────────────────────────────────────────────────────────");
  console.log("");

  const tx = await registry.createCampaign(
    INTEGRATOR,
    orderType,
    currency,
    REWARD_TOKEN,
    bps,
    flat,
    fundingWallet
  );
  const receipt = await tx.wait();

  const created = receipt!.logs
    .map((log) => {
      try {
        return registry.interface.parseLog(log as never);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === "CampaignCreated");

  const campaignId = created!.args.campaignId as string;
  console.log("Campaign created:", campaignId);

  if (ACTIVATE) {
    const activateTx = await registry.activate(campaignId);
    await activateTx.wait();
    console.log("Status:           ACTIVE — now paying");
  } else {
    console.log("Status:           DRAFT (not paying yet)");
    console.log("");
    console.log(`Activate with:    registry.activate("${campaignId}")`);
  }

  console.log("");
  console.log(`Reminder: ${fundingWallet} must approve the registry for`);
  console.log(`${REWARD_TOKEN}, or payouts log PayFailed and stay retryable.`);
  console.log("That approval is also your kill switch — revoke to stop instantly.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
