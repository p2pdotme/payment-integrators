import { ethers, network } from "hardhat";

/**
 * Deploy ZappUsdcOnrampIntegrator.
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... \
 *   USDC_ADDRESS=0x... \
 *   OWNER_ADDRESS=0x... \
 *   AUTHORIZATION_SIGNER=0x... \
 *   PER_TX_USDC_LIMIT=20000000 \
 *   DAILY_TX_COUNT_LIMIT=1 \
 *   DAILY_USDC_VOLUME_LIMIT=20000000 \
 *   LIFETIME_USDC_VOLUME_LIMIT=100000000 \
 *   npx hardhat run scripts/deploy-zapp-usdc-onramp.ts --network baseSepolia
 *
 * USDC values use 6 decimals. This script does not register the integrator on
 * the Diamond; registration follows merge, verification, and whitelist review.
 */

const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "";
const OWNER_ADDRESS = process.env.OWNER_ADDRESS || "";
const AUTHORIZATION_SIGNER = process.env.AUTHORIZATION_SIGNER || "";
const PER_TX_USDC_LIMIT = process.env.PER_TX_USDC_LIMIT || "";
const DAILY_TX_COUNT_LIMIT = process.env.DAILY_TX_COUNT_LIMIT || "";
const DAILY_USDC_VOLUME_LIMIT = process.env.DAILY_USDC_VOLUME_LIMIT || "";
const LIFETIME_USDC_VOLUME_LIMIT = process.env.LIFETIME_USDC_VOLUME_LIMIT || "";
const CONFIRMATIONS = Number(process.env.DEPLOY_CONFIRMATIONS || "2");

function requiredAddress(name: string, value: string): string {
  if (!ethers.isAddress(value) || value === ethers.ZeroAddress) {
    throw new Error(`${name} must be a non-zero address; received "${value}"`);
  }
  return value;
}

function requiredPositiveInteger(name: string, value: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an unsigned integer`);
  const parsed = BigInt(value);
  if (parsed === 0n) throw new Error(`${name} must be greater than zero`);
  return parsed;
}

async function main() {
  const diamond = requiredAddress("DIAMOND_ADDRESS", DIAMOND_ADDRESS);
  const usdc = requiredAddress("USDC_ADDRESS", USDC_ADDRESS);
  const owner = requiredAddress("OWNER_ADDRESS", OWNER_ADDRESS);
  const authorizationSigner = requiredAddress("AUTHORIZATION_SIGNER", AUTHORIZATION_SIGNER);
  const perTxLimit = requiredPositiveInteger("PER_TX_USDC_LIMIT", PER_TX_USDC_LIMIT);
  const dailyCountLimit = requiredPositiveInteger("DAILY_TX_COUNT_LIMIT", DAILY_TX_COUNT_LIMIT);
  const dailyVolumeLimit = requiredPositiveInteger(
    "DAILY_USDC_VOLUME_LIMIT",
    DAILY_USDC_VOLUME_LIMIT
  );
  const lifetimeVolumeLimit = requiredPositiveInteger(
    "LIFETIME_USDC_VOLUME_LIMIT",
    LIFETIME_USDC_VOLUME_LIMIT
  );
  if (dailyVolumeLimit < perTxLimit) {
    throw new Error("DAILY_USDC_VOLUME_LIMIT must be at least PER_TX_USDC_LIMIT");
  }
  if (lifetimeVolumeLimit < dailyVolumeLimit) {
    throw new Error("LIFETIME_USDC_VOLUME_LIMIT must be at least DAILY_USDC_VOLUME_LIMIT");
  }
  if (!Number.isInteger(CONFIRMATIONS) || CONFIRMATIONS < 1) {
    throw new Error("DEPLOY_CONFIRMATIONS must be a positive integer");
  }

  const [deployer] = await ethers.getSigners();
  console.log("Network:", network.name);
  console.log("Deployer:", await deployer.getAddress());
  console.log("Immutable owner:", owner);
  console.log("Diamond:", diamond);
  console.log("USDC:", usdc);
  console.log("Authorization signer:", authorizationSigner);
  console.log("Per-tx limit:", ethers.formatUnits(perTxLimit, 6), "USDC");
  console.log("Daily count limit:", dailyCountLimit.toString());
  console.log("Daily volume limit:", ethers.formatUnits(dailyVolumeLimit, 6), "USDC");
  console.log("Lifetime volume limit:", ethers.formatUnits(lifetimeVolumeLimit, 6), "USDC");

  const Integrator = await ethers.getContractFactory("ZappUsdcOnrampIntegrator");
  const integrator = await Integrator.deploy(
    diamond,
    usdc,
    owner,
    authorizationSigner,
    perTxLimit,
    dailyCountLimit,
    dailyVolumeLimit,
    lifetimeVolumeLimit
  );
  await integrator.deploymentTransaction()?.wait(CONFIRMATIONS);

  const integratorAddress = await integrator.getAddress();
  const proxyImpl = await integrator.proxyImpl();
  if ((await ethers.provider.getCode(integratorAddress)) === "0x") {
    throw new Error(`No runtime code found at ${integratorAddress}`);
  }
  if ((await ethers.provider.getCode(proxyImpl)) === "0x") {
    throw new Error(`No UserProxy runtime code found at ${proxyImpl}`);
  }

  console.log("\n=== Deployment summary ===");
  console.log("Integrator:", integratorAddress);
  console.log("proxyImpl:", proxyImpl);
  console.log("Owner:", await integrator.owner());
  console.log("EIP-712 domain: ZappUsdcOnramp / 1");
  console.log("\nVerification:");
  console.log(
    `npx hardhat verify --network ${network.name} ${integratorAddress} ${diamond} ${usdc} ${owner} ${authorizationSigner} ${perTxLimit} ${dailyCountLimit} ${dailyVolumeLimit} ${lifetimeVolumeLimit}`
  );
  console.log("\nWhitelisting request values:");
  console.log("  integrator:", integratorAddress);
  console.log("  proxyImpl:", proxyImpl);
  console.log("  usdcThroughIntegrator: false");
  console.log("  expected circleId(s): restricted by backend-signed authorizations");
  console.log("\nDo not register until source verification and whitelist review are complete.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
