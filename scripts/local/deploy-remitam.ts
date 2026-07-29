import { ethers } from "hardhat";

/**
 * Deploy RemitamIntegrator.
 *
 *   - txLimitCeiling:      immutable per-tx USDC cap ceiling. The owner may
 *                          later lower `txLimit` but never raise it past this.
 *   - dailyVolumeCeiling:  immutable per-wallet daily USDC volume ceiling.
 *   - dailyCountCeiling:   immutable per-wallet daily order-count ceiling.
 *
 *   All three adjustable limits (`txLimit`, `dailyVolumeLimit`,
 *   `dailyCountLimit`) start equal to their ceilings and can only be lowered
 *   afterwards via `setLimits` (reverts `LimitAboveCeiling` if any argument
 *   exceeds its ceiling). Changing a ceiling needs a new deployment.
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x... \
 *   TX_LIMIT_CEILING=1000000000 DAILY_VOLUME_CEILING=5000000000 \
 *   DAILY_COUNT_CEILING=50 \
 *     npx hardhat run scripts/local/deploy-remitam.ts --network baseSepolia
 *
 * All limit env vars are USDC amounts in 1e6 units except DAILY_COUNT_CEILING
 * (a raw order count). Defaults below are placeholders for local/testnet use
 * only — production ceilings must be agreed with P2P at whitelisting time.
 */

const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "";
const TX_LIMIT_CEILING = process.env.TX_LIMIT_CEILING || "1000000000"; // 1,000 USDC
const DAILY_VOLUME_CEILING = process.env.DAILY_VOLUME_CEILING || "5000000000"; // 5,000 USDC
const DAILY_COUNT_CEILING = process.env.DAILY_COUNT_CEILING || "50";

async function main() {
  if (!DIAMOND_ADDRESS || !USDC_ADDRESS) {
    throw new Error("DIAMOND_ADDRESS and USDC_ADDRESS env vars required");
  }

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", await deployer.getAddress());
  console.log("Diamond:", DIAMOND_ADDRESS);
  console.log("USDC:", USDC_ADDRESS);
  console.log("Tx limit ceiling:", ethers.formatUnits(TX_LIMIT_CEILING, 6), "USDC per tx");
  console.log(
    "Daily volume ceiling:",
    ethers.formatUnits(DAILY_VOLUME_CEILING, 6),
    "USDC per wallet per day"
  );
  console.log("Daily count ceiling:", DAILY_COUNT_CEILING, "orders per wallet per day");
  console.log("");

  console.log("Deploying RemitamIntegrator...");
  const Integrator = await ethers.getContractFactory("RemitamIntegrator");
  const integrator = await Integrator.deploy(
    DIAMOND_ADDRESS,
    USDC_ADDRESS,
    BigInt(TX_LIMIT_CEILING),
    BigInt(DAILY_VOLUME_CEILING),
    BigInt(DAILY_COUNT_CEILING)
  );
  const deployTx = integrator.deploymentTransaction();
  await deployTx?.wait(5);

  const address = await integrator.getAddress();
  console.log(`RemitamIntegrator deployed to: ${address}`);

  const code = await ethers.provider.getCode(address);
  if (code === "0x" || code.length <= 2) throw new Error(`Contract has no code at ${address}`);

  const proxyImpl = await integrator.proxyImpl();
  console.log("");
  console.log("=== Deployment Summary ===");
  console.log(`Integrator:            ${address}`);
  console.log(`proxyImpl:             ${proxyImpl}`);
  console.log(`Diamond:               ${await integrator.diamond()}`);
  console.log(`USDC:                  ${await integrator.usdc()}`);
  console.log(`Owner:                 ${await integrator.owner()}`);
  console.log(
    `Tx limit:              ${ethers.formatUnits(await integrator.txLimit(), 6)} USDC` +
      ` (immutable ceiling ${ethers.formatUnits(await integrator.txLimitCeiling(), 6)} USDC)`
  );
  console.log(
    `Daily volume limit:    ${ethers.formatUnits(await integrator.dailyVolumeLimit(), 6)} USDC` +
      ` (immutable ceiling ${ethers.formatUnits(await integrator.dailyVolumeCeiling(), 6)} USDC)`
  );
  console.log(
    `Daily count limit:     ${(await integrator.dailyCountLimit()).toString()} per day` +
      ` (immutable ceiling ${(await integrator.dailyCountCeiling()).toString()})`
  );
  console.log("");
  console.log("Verify command:");
  console.log(
    `  npx hardhat verify --network <network> ${address} \\\n` +
      `    ${DIAMOND_ADDRESS} ${USDC_ADDRESS} ${TX_LIMIT_CEILING} ${DAILY_VOLUME_CEILING} ${DAILY_COUNT_CEILING}`
  );
  console.log("");
  console.log("Next steps:");
  console.log("  1. Verify on Basescan / Sourcify (reviewers diff source vs the merged commit).");
  console.log("  2. addAccount(<Remitam server wallet>) for every backend-controlled thirdweb");
  console.log("     wallet that will place orders. No order can be placed for an unwhitelisted");
  console.log("     wallet — this is deliberate fail-closed behaviour.");
  console.log("  3. File a Whitelist request issue (docs/WHITELISTING.md). The P2P super-admin");
  console.log("     calls:");
  console.log(`       registerIntegrator(integrator = ${address},`);
  console.log(`                          usdcThroughIntegrator = false,`);
  console.log(`                          proxyImpl  = ${proxyImpl})`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
