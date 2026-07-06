import { ethers } from "hardhat";

/**
 * Deploy CubeSkinsIntegrator on Base Sepolia or Base mainnet.
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x... TREASURY_ADDRESS=0x... \
 *   BASE_TX_LIMIT=20000000 DAILY_TX_COUNT_LIMIT=5 \
 *   npx hardhat run scripts/deploy-cubeskins.ts --network baseSepolia
 */

const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "";
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS || "";
const BASE_TX_LIMIT = process.env.BASE_TX_LIMIT || "20000000"; // 20 USDC
const DAILY_TX_COUNT_LIMIT = process.env.DAILY_TX_COUNT_LIMIT || "5";

async function main() {
  if (!DIAMOND_ADDRESS || !USDC_ADDRESS || !TREASURY_ADDRESS) {
    throw new Error("DIAMOND_ADDRESS, USDC_ADDRESS and TREASURY_ADDRESS are required");
  }

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", await deployer.getAddress());
  console.log("Diamond:", DIAMOND_ADDRESS);
  console.log("USDC:", USDC_ADDRESS);
  console.log("Treasury:", TREASURY_ADDRESS);

  const Integrator = await ethers.getContractFactory("CubeSkinsIntegrator");
  const integrator = await Integrator.deploy(
    DIAMOND_ADDRESS,
    USDC_ADDRESS,
    TREASURY_ADDRESS,
    BigInt(BASE_TX_LIMIT),
    BigInt(DAILY_TX_COUNT_LIMIT)
  );
  await integrator.deploymentTransaction()?.wait(2);

  const address = await integrator.getAddress();
  const proxyImpl = await integrator.proxyImpl();

  console.log("\n=== CubeSkins deployment ===");
  console.log(`CubeSkinsIntegrator: ${address}`);
  console.log(`proxyImpl:             ${proxyImpl}`);
  console.log(`baseTxLimit:           ${BASE_TX_LIMIT} (6dp USDC)`);
  console.log(`dailyTxCountLimit:     ${DAILY_TX_COUNT_LIMIT}`);
  console.log("\nVerify:");
  console.log(
    `npx hardhat verify --network <network> ${address} ${DIAMOND_ADDRESS} ${USDC_ADDRESS} ${TREASURY_ADDRESS} ${BASE_TX_LIMIT} ${DAILY_TX_COUNT_LIMIT}`
  );
  console.log("\nWhitelist with usdcThroughIntegrator=true (USDC → integrator → treasury).");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
