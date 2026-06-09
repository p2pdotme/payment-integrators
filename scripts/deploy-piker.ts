import { ethers } from "hardhat";

/**
 * Deploy PikerOnrampIntegrator.
 *
 *   - baseTxLimit: max USDC per onramp (6 decimals). 0 = unlimited.
 *   - dailyTxCountLimit: max onramps per user per UTC day. 0 = unlimited.
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x... npx hardhat run scripts/deploy-piker.ts --network base
 *
 * Optional:
 *   BASE_TX_LIMIT=2000000000     (6 decimals, default 2000 USDC per onramp)
 *   DAILY_TX_COUNT_LIMIT=10      (default 10)
 *
 * After deploy:
 *   1. Verify on Basescan so the source matches the merged commit.
 *   2. Open a "Whitelist request" issue with the integrator address, the
 *      pinned `proxyImpl`, the bytecode hash, and the deployer address.
 *   3. Register with usdcThroughIntegrator = false: onramp BUYs use
 *      recipientAddr = the buyer, so USDC is delivered straight to their
 *      wallet on completion. The integrator custodies no USDC.
 */

const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "";
const BASE_TX_LIMIT = process.env.BASE_TX_LIMIT || "2000000000"; // 2000 USDC
const DAILY_TX_COUNT_LIMIT = process.env.DAILY_TX_COUNT_LIMIT || "10";

async function main() {
  if (!DIAMOND_ADDRESS || !USDC_ADDRESS) {
    throw new Error("DIAMOND_ADDRESS and USDC_ADDRESS env vars required");
  }

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", await deployer.getAddress());
  console.log("Diamond:", DIAMOND_ADDRESS);
  console.log("USDC:", USDC_ADDRESS);
  console.log("Base TX Limit:", ethers.formatUnits(BASE_TX_LIMIT, 6), "USDC per onramp");
  console.log("Daily TX Count Limit:", DAILY_TX_COUNT_LIMIT, "onramps per day");
  console.log("");

  console.log("Deploying PikerOnrampIntegrator...");
  const Integrator = await ethers.getContractFactory("PikerOnrampIntegrator");
  const integrator = await Integrator.deploy(
    DIAMOND_ADDRESS,
    USDC_ADDRESS,
    BigInt(BASE_TX_LIMIT),
    BigInt(DAILY_TX_COUNT_LIMIT)
  );
  const deployTx = integrator.deploymentTransaction();
  await deployTx?.wait(5);

  const address = await integrator.getAddress();
  console.log(`PikerOnrampIntegrator deployed to: ${address}`);

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
  console.log(`Daily TX Count:      ${await integrator.dailyTxCountLimit()}`);
  console.log("");
  console.log("Next: verify on Basescan, then file a whitelist request with the");
  console.log("integrator address + proxyImpl above. usdcThroughIntegrator = false.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
