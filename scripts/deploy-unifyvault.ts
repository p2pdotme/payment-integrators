import { ethers } from "hardhat";
import { getIntegratorConfig } from "./lib/diamond";

/**
 * Deploy script for UnifyVaultCheckoutIntegrator.
 *
 * Requirements:
 *   - DIAMOND_ADDRESS: P2P Diamond address
 *   - USDC_ADDRESS: USDC token address
 *   - LIVENESS_ATTESTOR: P2P.me Simple KYC Liveness service signer address
 *   - KYC_ATTESTOR: P2P.me Simple KYC KYC service signer address
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x... \
 *   LIVENESS_ATTESTOR=0x... KYC_ATTESTOR=0x... \
 *   [DAILY_TX_COUNT_LIMIT=25] [PER_TX_USDC_CAP=100000000] [DAILY_USDC_VOLUME_CAP=0] \
 *   npx hardhat run scripts/deploy-unifyvault.ts --network baseSepolia
 */

const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "";
const DAILY_TX_COUNT_LIMIT = process.env.DAILY_TX_COUNT_LIMIT || "25";
const PER_TX_USDC_CAP = process.env.PER_TX_USDC_CAP || "100000000"; // 100 USDC (micro-USDC)
const DAILY_USDC_VOLUME_CAP = process.env.DAILY_USDC_VOLUME_CAP || "0"; // 0 = disabled
const LIVENESS_ATTESTOR = process.env.LIVENESS_ATTESTOR || "";
const KYC_ATTESTOR = process.env.KYC_ATTESTOR || "";

const f = (n: bigint) => ethers.formatUnits(n, 6);

async function main() {
  if (!DIAMOND_ADDRESS || !USDC_ADDRESS) {
    throw new Error("DIAMOND_ADDRESS and USDC_ADDRESS are required");
  }
  if (!LIVENESS_ATTESTOR || !KYC_ATTESTOR) {
    throw new Error("LIVENESS_ATTESTOR and KYC_ATTESTOR are required");
  }

  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  console.log("=== UnifyVault Integrator Deployment ===");
  console.log("Deployer:", deployerAddress);
  console.log("Diamond: ", DIAMOND_ADDRESS);
  console.log("USDC:    ", USDC_ADDRESS);
  console.log("Liveness Attestor:", LIVENESS_ATTESTOR);
  console.log("KYC Attestor:     ", KYC_ATTESTOR);

  console.log("\nDeploying UnifyVaultCheckoutIntegrator...");
  const Factory = await ethers.getContractFactory("UnifyVaultCheckoutIntegrator");
  const integrator = await Factory.deploy(
    DIAMOND_ADDRESS,
    USDC_ADDRESS,
    BigInt(DAILY_TX_COUNT_LIMIT),
    LIVENESS_ATTESTOR,
    KYC_ATTESTOR
  );

  await integrator.deploymentTransaction()?.wait(2);
  const integratorAddr = await integrator.getAddress();
  const proxyImpl = await integrator.proxyImpl();

  console.log("  Contract Address:", integratorAddr);
  console.log("  ProxyImpl:       ", proxyImpl);

  if (BigInt(PER_TX_USDC_CAP) > 0n) {
    console.log(`\nSetting perTxUsdcCap to ${f(BigInt(PER_TX_USDC_CAP))} USDC...`);
    await (await integrator.setPerTxUsdcCap(BigInt(PER_TX_USDC_CAP))).wait(1);
  }

  if (BigInt(DAILY_USDC_VOLUME_CAP) > 0n) {
    console.log(`Setting dailyUsdcVolumeCap to ${f(BigInt(DAILY_USDC_VOLUME_CAP))} USDC...`);
    await (await integrator.setDailyUsdcVolumeCap(BigInt(DAILY_USDC_VOLUME_CAP))).wait(1);
  }

  console.log("\n=== Deployment Summary for Whitelist Request ===");
  console.log(`Integrator Address:     ${integratorAddr}`);
  console.log(`ProxyImpl Address:      ${proxyImpl}`);
  console.log(`usdcThroughIntegrator:  false`);
  console.log(`Deployer Address:       ${deployerAddress}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
