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
 *   MAX_REWARD_PER_ORDER  per-order ceiling, token units. Required unless
 *                      UNLIMITED=true — see the note below.
 *
 * Optional env:
 *   ORDER_TYPE         "BUY" | "ANY"            (default BUY)
 *                      SELL and PAY are rejected by the registry: on offramp
 *                      flows the order's `user` is a UserProxy, not a person,
 *                      so the reward is trapped or unattributable. Note a
 *                      wildcard ("ANY") campaign will not pay them either.
 *   CURRENCY           e.g. "INR", or "ANY"     (default ANY)
 *   DAILY_BUDGET       max reward units per UTC day       (0 = unlimited)
 *   TOTAL_BUDGET       lifetime cap in reward units       (0 = unlimited)
 *   DAILY_PER_USER     max per recipient per UTC day      (0 = unlimited)
 *   START_TIME         unix seconds; floored at now       (default now)
 *   END_TIME           unix seconds, 0 = open-ended       (default 0)
 *   UNLIMITED          "true" to create with NO budget caps at all. This is
 *                      a deliberate speed bump, not a formality: budgets are
 *                      the primary spend control, the contract accepts 0 as
 *                      "unlimited", and a campaign created without them is
 *                      bounded only by the funding wallet's ERC-20 allowance.
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
 *   MAX_REWARD_PER_ORDER=5000000 DAILY_BUDGET=500000000 \
 *   npx hardhat run scripts/create-campaign.ts --network baseSepolia
 *
 *   (6dp USDC: 5 USDC per order, 500 USDC per day.)
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
const MAX_REWARD_PER_ORDER = process.env.MAX_REWARD_PER_ORDER || "0";
const DAILY_BUDGET = process.env.DAILY_BUDGET || "0";
const TOTAL_BUDGET = process.env.TOTAL_BUDGET || "0";
const DAILY_PER_USER = process.env.DAILY_PER_USER || "0";
const START_TIME = process.env.START_TIME || "0";
const END_TIME = process.env.END_TIME || "0";
const UNLIMITED = (process.env.UNLIMITED || "").toLowerCase() === "true";

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

  // AUDIT N8/F6. `createCampaign` takes a Budget struct and this script did
  // not pass one, so it threw on argument count — there was no CLI path to
  // set the budgets at all, and they are the primary spend control.
  //
  // The contract accepts 0 as "unlimited" by design, so the requirement is
  // enforced here, where an operator is standing up a campaign, rather than
  // by changing on-chain semantics. Opting out has to be typed out loud.
  const budget = {
    maxRewardPerOrder: BigInt(MAX_REWARD_PER_ORDER),
    dailyBudget: BigInt(DAILY_BUDGET),
    totalBudget: BigInt(TOTAL_BUDGET),
    dailyPerUser: BigInt(DAILY_PER_USER),
    startTime: BigInt(START_TIME),
    endTime: BigInt(END_TIME),
  };
  if (budget.maxRewardPerOrder === 0n && !UNLIMITED) {
    throw new Error(
      "MAX_REWARD_PER_ORDER is required (a per-order ceiling in reward-token units).\n" +
        "  Without it this campaign is bounded only by the funding wallet's allowance.\n" +
        "  Set UNLIMITED=true to create an uncapped campaign deliberately."
    );
  }
  if (budget.endTime !== 0n && budget.endTime <= BigInt(Math.floor(Date.now() / 1000))) {
    throw new Error("END_TIME is in the past — the campaign could never pay an order");
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
  console.log(
    "Per order max: ",
    budget.maxRewardPerOrder === 0n ? "UNLIMITED" : budget.maxRewardPerOrder.toString()
  );
  console.log(
    "Daily budget:  ",
    budget.dailyBudget === 0n ? "unlimited" : budget.dailyBudget.toString()
  );
  console.log(
    "Total budget:  ",
    budget.totalBudget === 0n ? "unlimited" : budget.totalBudget.toString()
  );
  console.log(
    "Per user/day:  ",
    budget.dailyPerUser === 0n ? "unlimited" : budget.dailyPerUser.toString()
  );
  console.log(
    "Window:        ",
    `${budget.startTime || "now"} → ${budget.endTime || "open-ended"}`
  );
  console.log("─────────────────────────────────────────────────────────");
  console.log("");

  const tx = await registry.createCampaign(
    INTEGRATOR,
    orderType,
    currency,
    REWARD_TOKEN,
    bps,
    flat,
    fundingWallet,
    budget
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
