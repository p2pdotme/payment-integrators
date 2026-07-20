import { ethers } from "hardhat";

/**
 * Deploy CubeSkinsIntegrator on Base Sepolia or Base mainnet.
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x... TREASURY_ADDRESS=0x... \
 *   INTEGRATOR_OWNER=0x... LIVENESS_TIER_CAP=600000000 DAILY_TX_COUNT_LIMIT=5 \
 *   LIVENESS_ATTESTOR=0x... \
 *   npx hardhat run scripts/deploy-cubeskins.ts --network baseSepolia
 *
 * INTEGRATOR_OWNER is the CubeSkins backend relayer — the only key that can call
 * `registerOrder`. It is set explicitly rather than defaulting to the deployer so
 * P2P can deploy on CubeSkins' behalf for testnet without holding the admin key.
 *
 * LIVENESS_ATTESTOR may be left empty and set later with `setLivenessAttestor`,
 * but no order can be placed until it is set — an unset attestor means every
 * user is TIER_NONE, whose effective per-tx limit is 0.
 */

const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "";
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS || "";
const INTEGRATOR_OWNER = process.env.INTEGRATOR_OWNER || "";
const LIVENESS_TIER_CAP = process.env.LIVENESS_TIER_CAP || "600000000"; // 600 USDC
const DAILY_TX_COUNT_LIMIT = process.env.DAILY_TX_COUNT_LIMIT || "5";
const LIVENESS_ATTESTOR = process.env.LIVENESS_ATTESTOR || ethers.ZeroAddress;

async function main() {
  if (!DIAMOND_ADDRESS || !USDC_ADDRESS || !TREASURY_ADDRESS || !INTEGRATOR_OWNER) {
    throw new Error(
      "DIAMOND_ADDRESS, USDC_ADDRESS, TREASURY_ADDRESS and INTEGRATOR_OWNER are required"
    );
  }

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", await deployer.getAddress());
  console.log("Diamond:", DIAMOND_ADDRESS);
  console.log("USDC:", USDC_ADDRESS);
  console.log("Treasury:", TREASURY_ADDRESS);
  console.log("Owner (relayer):", INTEGRATOR_OWNER);
  console.log("Liveness attestor:", LIVENESS_ATTESTOR);

  const Integrator = await ethers.getContractFactory("CubeSkinsIntegrator");
  const integrator = await Integrator.deploy(
    DIAMOND_ADDRESS,
    USDC_ADDRESS,
    TREASURY_ADDRESS,
    INTEGRATOR_OWNER,
    BigInt(LIVENESS_TIER_CAP),
    BigInt(DAILY_TX_COUNT_LIMIT),
    LIVENESS_ATTESTOR
  );
  await integrator.deploymentTransaction()?.wait(2);

  const address = await integrator.getAddress();
  const proxyImpl = await integrator.proxyImpl();

  console.log("\n=== CubeSkins deployment ===");
  console.log(`CubeSkinsIntegrator:  ${address}`);
  console.log(`proxyImpl:            ${proxyImpl}`);
  console.log(`tierCap[LIVENESS]:    ${LIVENESS_TIER_CAP} (6dp USDC)`);
  console.log(`dailyTxCountLimit:    ${DAILY_TX_COUNT_LIMIT}`);
  console.log("\nVerify:");
  console.log(
    `npx hardhat verify --network <network> ${address} ${DIAMOND_ADDRESS} ${USDC_ADDRESS} ${TREASURY_ADDRESS} ${INTEGRATOR_OWNER} ${LIVENESS_TIER_CAP} ${DAILY_TX_COUNT_LIMIT} ${LIVENESS_ATTESTOR}`
  );
  console.log(
    "\nWhitelist with usdcThroughIntegrator=FALSE — userPlaceOrder pins" +
      "\nrecipientAddr=address(this), so the recipient pin already routes" +
      "\nsettlement USDC to the integrator (same shape as Showdown)."
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
