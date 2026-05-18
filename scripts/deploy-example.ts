import { ethers } from "hardhat";

/**
 * Deploy ExampleIntegrator.
 *
 *   - baseTxLimit: max USDC per transaction for 0 RP users (default 50 USDC)
 *   - dailyTxCountLimit: max number of transactions per day per user (default 10)
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x... npx hardhat run scripts/deploy-example.ts --network baseSepolia
 *
 * Optional:
 *   BASE_TX_LIMIT=50000000       (6 decimals, default 50 USDC)
 *   DAILY_TX_COUNT_LIMIT=10      (default 10)
 */

const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "";
const BASE_TX_LIMIT = process.env.BASE_TX_LIMIT || "50000000";
const DAILY_TX_COUNT_LIMIT = process.env.DAILY_TX_COUNT_LIMIT || "10";

async function main() {
  if (!DIAMOND_ADDRESS || !USDC_ADDRESS) {
    throw new Error("DIAMOND_ADDRESS and USDC_ADDRESS env vars required");
  }

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", await deployer.getAddress());
  console.log("Diamond:", DIAMOND_ADDRESS);
  console.log("USDC:", USDC_ADDRESS);
  console.log("Base TX Limit:", ethers.formatUnits(BASE_TX_LIMIT, 6), "USDC per tx");
  console.log("Daily TX Count Limit:", DAILY_TX_COUNT_LIMIT, "transactions per day");
  console.log("");

  console.log("Deploying ExampleIntegrator...");
  const Integrator = await ethers.getContractFactory("ExampleIntegrator");
  const integrator = await Integrator.deploy(
    DIAMOND_ADDRESS,
    USDC_ADDRESS,
    BigInt(BASE_TX_LIMIT),
    BigInt(DAILY_TX_COUNT_LIMIT)
  );
  const deployTx = integrator.deploymentTransaction();
  await deployTx?.wait(5);

  const address = await integrator.getAddress();
  console.log(`ExampleIntegrator deployed to: ${address}`);

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
  console.log(`Base TX Limit:       ${ethers.formatUnits(await integrator.baseTxLimit(), 6)} USDC`);
  console.log(`Daily TX Count:      ${(await integrator.dailyTxCountLimit()).toString()} per day`);
  console.log("");
  console.log("Next steps:");
  console.log(
    "  1. Verify on Etherscan / Sourcify so reviewers can diff source against the merged commit."
  );
  console.log(
    "  2. File a Whitelist request issue (see docs/WHITELISTING.md). The P2P team will call:"
  );
  console.log(`       registerIntegrator(integrator = ${address},`);
  console.log(`                          proxyImpl  = ${proxyImpl},`);
  console.log(`                          source     = bytes32("<your-source-tag>"))`);
  console.log("     on the Diamond once verification passes.");
  console.log("  3. Register your business clients on the integrator: registerClient(clientAddr).");
  console.log("  4. Set per-currency RP rates: setRpToUsdc(currency, usdcPerRp).");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
