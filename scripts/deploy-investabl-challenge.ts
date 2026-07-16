import { ethers } from "hardhat";

/**
 * Deploy InvestablChallengeCheckoutIntegrator.
 *
 *   - perTxUsdcCap:      absolute per-tx USDC cap (default 50 USDC — P2P's
 *                        no-KYC ceiling; the $15 challenge sits well under it)
 *   - dailyTxCountLimit: max challenge orders per user per day (default 10)
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x... \
 *     npx hardhat run scripts/deploy-investabl-challenge.ts --network baseSepolia
 *
 * Optional:
 *   PER_TX_USDC_CAP=50000000     (6 decimals, default 50 USDC)
 *   DAILY_TX_COUNT_LIMIT=10      (default 10)
 */

const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "";
const PER_TX_USDC_CAP = process.env.PER_TX_USDC_CAP || "50000000";
const DAILY_TX_COUNT_LIMIT = process.env.DAILY_TX_COUNT_LIMIT || "10";

async function main() {
  if (!DIAMOND_ADDRESS || !USDC_ADDRESS) {
    throw new Error("DIAMOND_ADDRESS and USDC_ADDRESS env vars required");
  }

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", await deployer.getAddress());
  console.log("Diamond:", DIAMOND_ADDRESS);
  console.log("USDC:", USDC_ADDRESS);
  console.log("Per-TX USDC Cap:", ethers.formatUnits(PER_TX_USDC_CAP, 6), "USDC per tx");
  console.log("Daily TX Count Limit:", DAILY_TX_COUNT_LIMIT, "orders per day");
  console.log("");

  console.log("Deploying InvestablChallengeCheckoutIntegrator...");
  const Integrator = await ethers.getContractFactory("InvestablChallengeCheckoutIntegrator");
  const integrator = await Integrator.deploy(
    DIAMOND_ADDRESS,
    USDC_ADDRESS,
    BigInt(PER_TX_USDC_CAP),
    BigInt(DAILY_TX_COUNT_LIMIT)
  );
  const deployTx = integrator.deploymentTransaction();
  await deployTx?.wait(5);

  const address = await integrator.getAddress();
  console.log(`InvestablChallengeCheckoutIntegrator deployed to: ${address}`);

  const code = await ethers.provider.getCode(address);
  if (code === "0x" || code.length <= 2) throw new Error(`Contract has no code at ${address}`);

  const proxyImpl = await integrator.proxyImpl();
  console.log("");
  console.log("=== Deployment Summary ===");
  console.log(`Integrator:          ${address}`);
  console.log(`proxyImpl:           ${proxyImpl}`);
  console.log(`Diamond:             ${await integrator.diamond()}`);
  console.log(`USDC:                ${await integrator.usdc()}`);
  console.log(`Owner:               ${await integrator.owner()}`);
  console.log(`Treasury:            ${await integrator.treasury()}`);
  console.log(
    `Per-TX USDC Cap:     ${ethers.formatUnits(await integrator.perTxUsdcCap(), 6)} USDC`
  );
  console.log(`Daily TX Count:      ${(await integrator.dailyTxCountLimit()).toString()} per day`);
  console.log("");
  console.log("Verify command:");
  console.log(
    `  npx hardhat verify --network <network> ${address} \\\n` +
      `    ${DIAMOND_ADDRESS} ${USDC_ADDRESS} ${PER_TX_USDC_CAP} ${DAILY_TX_COUNT_LIMIT}`
  );
  console.log("");
  console.log("Next steps:");
  console.log("  1. Verify on Basescan / Sourcify (reviewers diff source vs the merged commit).");
  console.log("  2. File a Whitelist request issue (docs/WHITELISTING.md). The P2P team calls:");
  console.log(`       registerIntegrator(integrator = ${address},`);
  console.log(`                          usdcThroughIntegrator = true,`);
  console.log(`                          proxyImpl  = ${proxyImpl})`);
  console.log(
    "  3. Optionally setTreasury(<Base treasury>) if proceeds should not accrue to owner."
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
