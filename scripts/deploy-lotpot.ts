import { ethers } from "hardhat";

/**
 * Deploy LotPotCheckoutIntegrator. The integrator's constructor also deploys
 * the UserProxy implementation that all per-user clones delegate to.
 *
 * Megapot Base mainnet:
 *   Jackpot:               0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2
 *   BatchPurchaseFacilitator: 0x01774B531591b286b9f02C6Bc02ab3fD9526Aa76
 *   USDC:                  0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
 *   Ticket NFT:            0x48FfE35AbB9f4780a4f1775C2Ce1c46185b366e4
 *
 * Note: BatchPurchaseFacilitator gates createBatchOrder on an allowlist
 * (`isAllowed(msg.sender)`). After deploying this integrator, coordinate
 * with Megapot's owner to add the integrator address to the facilitator's
 * allowlist before any >10-ticket order can fulfill.
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x... MEGAPOT_ADDRESS=0x... \
 *   BATCH_FACILITATOR_ADDRESS=0x... JACKPOT_NFT_ADDRESS=0x... \
 *   npx hardhat run scripts/deploy-lotpot-integrator.ts --network base
 *
 * Optional:
 *   BASE_TX_LIMIT=50000000        (6 decimals, default 50 USDC)
 *   DAILY_TX_COUNT_LIMIT=10
 *   SOURCE_TAG=lotpot             (free-form telemetry, encoded as bytes32)
 *
 * Note: ticket price and ball range are NOT configured here. The integrator
 * reads them from Megapot's active drawing at placement time
 * (`getDrawingState(currentDrawingId())`), so Megapot is the single source of
 * truth and the integrator can never drift out of sync. Fulfillment re-reads
 * the active drawing and refunds inline if a daily rollover invalidated the
 * order's commitment.
 */

const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "";
const MEGAPOT_ADDRESS = process.env.MEGAPOT_ADDRESS || "";
const BATCH_FACILITATOR_ADDRESS = process.env.BATCH_FACILITATOR_ADDRESS || "";
const JACKPOT_NFT_ADDRESS = process.env.JACKPOT_NFT_ADDRESS || "";
const BASE_TX_LIMIT = process.env.BASE_TX_LIMIT || "50000000";
const DAILY_TX_COUNT_LIMIT = process.env.DAILY_TX_COUNT_LIMIT || "10";
const SOURCE_TAG = process.env.SOURCE_TAG || "lotpot";

async function main() {
  if (
    !DIAMOND_ADDRESS ||
    !USDC_ADDRESS ||
    !MEGAPOT_ADDRESS ||
    !BATCH_FACILITATOR_ADDRESS ||
    !JACKPOT_NFT_ADDRESS
  ) {
    throw new Error(
      "DIAMOND_ADDRESS, USDC_ADDRESS, MEGAPOT_ADDRESS, BATCH_FACILITATOR_ADDRESS, and JACKPOT_NFT_ADDRESS env vars required"
    );
  }

  const [deployer] = await ethers.getSigners();
  const sourceBytes32 = ethers.encodeBytes32String(SOURCE_TAG);

  // Probe Megapot's live drawing state so the deploy log records the values
  // the integrator will see on its first order. Pure read; not stored on-chain.
  const megapot = await ethers.getContractAt(
    [
      "function currentDrawingId() view returns (uint256)",
      "function getDrawingState(uint256) view returns (tuple(uint256 prizePool, uint256 ticketPrice, uint256 edgePerTicket, uint256 referralWinShare, uint256 referralFee, uint256 globalTicketsBought, uint256 lpEarnings, uint256 drawingTime, uint256 winningTicket, uint8 ballMax, uint8 bonusballMax, address payoutCalculator, bool jackpotLock))",
    ],
    MEGAPOT_ADDRESS
  );
  const liveDrawingId = await megapot.currentDrawingId();
  const liveDrawing = await megapot.getDrawingState(liveDrawingId);
  const livePrice = liveDrawing.ticketPrice;
  const liveBallMax = liveDrawing.ballMax;
  const liveBonusMax = liveDrawing.bonusballMax;

  console.log("Deployer:", await deployer.getAddress());
  console.log("Diamond:", DIAMOND_ADDRESS);
  console.log("USDC:", USDC_ADDRESS);
  console.log("Megapot:", MEGAPOT_ADDRESS);
  console.log("BatchFacilitator:", BATCH_FACILITATOR_ADDRESS);
  console.log("JackpotNFT:", JACKPOT_NFT_ADDRESS);
  console.log("Source:", SOURCE_TAG, "→", sourceBytes32);
  console.log("Base TX Limit:", ethers.formatUnits(BASE_TX_LIMIT, 6), "USDC per tx");
  console.log("Daily TX Count Limit:", DAILY_TX_COUNT_LIMIT, "transactions per day");
  console.log("");
  console.log("Megapot active drawing (read at deploy time, not stored):");
  console.log(`  currentDrawingId():  ${liveDrawingId}`);
  console.log(`  ticketPrice:         ${ethers.formatUnits(livePrice, 6)} USDC`);
  console.log(`  ballMax:             ${liveBallMax}`);
  console.log(`  bonusballMax:        ${liveBonusMax}`);
  console.log("");

  console.log("Deploying LotPotCheckoutIntegrator (deploys UserProxy impl in ctor)...");
  const Integrator = await ethers.getContractFactory("LotPotCheckoutIntegrator");
  const integrator = await Integrator.deploy(
    DIAMOND_ADDRESS,
    USDC_ADDRESS,
    MEGAPOT_ADDRESS,
    BATCH_FACILITATOR_ADDRESS,
    JACKPOT_NFT_ADDRESS,
    BigInt(BASE_TX_LIMIT),
    BigInt(DAILY_TX_COUNT_LIMIT),
    sourceBytes32
  );
  const deployTx = integrator.deploymentTransaction();
  await deployTx?.wait(5);

  const address = await integrator.getAddress();
  const proxyImpl = await integrator.proxyImpl();
  console.log(`LotPotCheckoutIntegrator deployed to: ${address}`);
  console.log(`UserProxy implementation:             ${proxyImpl}`);

  const code = await ethers.provider.getCode(address);
  if (code === "0x" || code.length <= 2) throw new Error(`Contract has no code at ${address}`);

  console.log("");
  console.log("=== Deployment Summary ===");
  console.log(`LotPotIntegrator:      ${address}`);
  console.log(`UserProxy impl:        ${proxyImpl}`);
  console.log(`Diamond:               ${await integrator.diamond()}`);
  console.log(`USDC:                  ${await integrator.usdc()}`);
  console.log(`Megapot:               ${await integrator.megapot()}`);
  console.log(`JackpotNFT:            ${await integrator.jackpotNft()}`);
  console.log(`Owner:                 ${await integrator.owner()}`);
  console.log(
    `Base TX Limit:         ${ethers.formatUnits(await integrator.baseTxLimit(), 6)} USDC`
  );
  console.log(
    `Daily TX Count:        ${(await integrator.dailyTxCountLimit()).toString()} per day`
  );
  console.log("");
  console.log("Next steps:");
  console.log(`  1. Register on Diamond (super-admin):`);
  console.log(`       registerIntegrator(${address}, false, ${proxyImpl})`);
  console.log(
    `     - usdcThroughIntegrator=false: Diamond routes USDC to recipientAddr (= proxy) on completion.`
  );
  console.log(
    `     - proxyImpl is pinned at registration; gateway re-derives clone CREATE2 addresses against it.`
  );
  console.log(`  2. Set currency rates:   setRpToUsdc(currency, rate)`);
  console.log(
    `  3. Coordinate with Megapot's owner to allowlist this integrator on BatchPurchaseFacilitator.`
  );
  console.log(`     (Required before any >10-ticket order can fulfill.)`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
