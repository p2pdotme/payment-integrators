import { ethers } from "hardhat";

/**
 * Deploy FundingAlphaXIntegrator.
 *
 *   - operator:            FundingAlphaX backend hot key (places capped orders only)
 *   - maxPerTxUsdc:        per-transaction USDC cap, 6 decimals (default 200 USDC)
 *   - maxDailyCountPerUser: max orders per user per UTC day (default 20)
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x... OPERATOR_ADDRESS=0x... \
 *     npx hardhat run scripts/deploy-funding-alphax.ts --network baseSepolia
 *
 * Optional:
 *   MAX_PER_TX_USDC=200000000   (6 decimals, default 200 USDC)
 *   MAX_DAILY_COUNT=20          (default 20)
 *
 * This script does NOT call registerIntegrator — whitelisting is a separate
 * P2P-team step (see docs/WHITELISTING.md). After deploy, verify on Basescan
 * and open a "Whitelist request" issue.
 */
const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "";
const OPERATOR_ADDRESS = process.env.OPERATOR_ADDRESS || "";
const MAX_PER_TX_USDC = process.env.MAX_PER_TX_USDC || "200000000";
const MAX_DAILY_COUNT = process.env.MAX_DAILY_COUNT || "20";

async function main() {
  if (!DIAMOND_ADDRESS || !USDC_ADDRESS || !OPERATOR_ADDRESS) {
    throw new Error("DIAMOND_ADDRESS, USDC_ADDRESS and OPERATOR_ADDRESS env vars required");
  }

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", await deployer.getAddress());
  console.log("Diamond:", DIAMOND_ADDRESS);
  console.log("USDC:", USDC_ADDRESS);
  console.log("Operator:", OPERATOR_ADDRESS);
  console.log("Max per-tx:", ethers.formatUnits(MAX_PER_TX_USDC, 6), "USDC");
  console.log("Max daily count:", MAX_DAILY_COUNT, "orders / user / day");
  console.log("");

  console.log("Deploying FundingAlphaXIntegrator...");
  const Integrator = await ethers.getContractFactory("FundingAlphaXIntegrator");
  const integrator = await Integrator.deploy(
    DIAMOND_ADDRESS,
    USDC_ADDRESS,
    OPERATOR_ADDRESS,
    BigInt(MAX_PER_TX_USDC),
    BigInt(MAX_DAILY_COUNT)
  );
  const deployTx = integrator.deploymentTransaction();
  await deployTx?.wait(5);

  const address = await integrator.getAddress();
  const code = await ethers.provider.getCode(address);
  if (code === "0x" || code.length <= 2) throw new Error(`Contract has no code at ${address}`);

  const proxyImpl = await integrator.proxyImpl();
  console.log("");
  console.log("=== Deployment Summary ===");
  console.log(`Integrator:          ${address}`);
  console.log(`proxyImpl:           ${proxyImpl}`);
  console.log(`Diamond:             ${await integrator.diamond()}`);
  console.log(`USDC:                ${await integrator.usdc()}`);
  console.log(`Operator:            ${await integrator.operator()}`);
  console.log(`Owner:               ${await integrator.owner()}`);
  console.log(
    `Max per-tx:          ${ethers.formatUnits(await integrator.maxPerTxUsdc(), 6)} USDC`
  );
  console.log(
    `Max daily count:     ${(await integrator.maxDailyCountPerUser()).toString()} / user / day`
  );
  console.log("");
  console.log("Verify on Basescan:");
  console.log(
    `  npx hardhat verify --network <net> ${address} \\\n` +
      `    ${DIAMOND_ADDRESS} ${USDC_ADDRESS} ${OPERATOR_ADDRESS} ${MAX_PER_TX_USDC} ${MAX_DAILY_COUNT}`
  );
  console.log("");
  console.log("Next steps:");
  console.log(
    "  1. Verify on Basescan / Sourcify so reviewers can diff source against the merged commit."
  );
  console.log(
    "  2. transferOwnership(multisig) → acceptOwnership() from the multisig (Ownable2Step)."
  );
  console.log(
    "  3. File a Whitelist request issue (see docs/WHITELISTING.md). The P2P team will call:"
  );
  console.log(`       registerIntegrator(integrator = ${address}, proxyImpl = ${proxyImpl}, ...)`);
  console.log("     on the Diamond once verification passes.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
