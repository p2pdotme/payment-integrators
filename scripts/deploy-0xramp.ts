import { ethers, network } from "hardhat";

/**
 * Deploy ZeroXRampDirectSettlementIntegrator.
 *
 * Base mainnet defaults:
 *   Diamond: 0x4cad6eC90e65baBec9335cAd728DDC610c316368
 *   USDC:    0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... \
 *   OWNER_ADDRESS=0x... \
 *   npx hardhat run scripts/deploy-0xramp.ts --network base
 *
 * Optional app-side guardrails, all in 6-decimal USDC units:
 *   PER_TX_USDC_LIMIT=600000000       (default 0 = inherit P2P.me limits only)
 *   DAILY_TX_COUNT_LIMIT=0            (default 0 = disabled)
 *   DAILY_USDC_VOLUME_LIMIT=0         (default 0 = disabled)
 *   DEPLOY_CONFIRMATIONS=5
 *   DRY_RUN=1                         (estimate on target network, do not deploy)
 */

const BASE_MAINNET_CHAIN_ID = 8453n;
const DEFAULT_DIAMOND_ADDRESS = "0x4cad6eC90e65baBec9335cAd728DDC610c316368";
const DEFAULT_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DRY_RUN_OWNER_ADDRESS = "0x000000000000000000000000000000000000dEaD";

const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || DEFAULT_DIAMOND_ADDRESS;
const USDC_ADDRESS = process.env.USDC_ADDRESS || DEFAULT_USDC_ADDRESS;
const OWNER_ADDRESS = process.env.OWNER_ADDRESS;
const PER_TX_USDC_LIMIT = process.env.PER_TX_USDC_LIMIT || "0";
const DAILY_TX_COUNT_LIMIT = process.env.DAILY_TX_COUNT_LIMIT || "0";
const DAILY_USDC_VOLUME_LIMIT = process.env.DAILY_USDC_VOLUME_LIMIT || "0";
const DEPLOY_CONFIRMATIONS = Number(process.env.DEPLOY_CONFIRMATIONS || "5");
const DRY_RUN = process.env.DRY_RUN === "1";

function requireAddress(name: string, value: string) {
  if (!ethers.isAddress(value)) throw new Error(`${name} must be a valid address`);
}

async function main() {
  requireAddress("DIAMOND_ADDRESS", DIAMOND_ADDRESS);
  requireAddress("USDC_ADDRESS", USDC_ADDRESS);

  const chain = await ethers.provider.getNetwork();
  if (chain.chainId !== BASE_MAINNET_CHAIN_ID && process.env.ALLOW_NON_BASE !== "1") {
    throw new Error(
      `Refusing to deploy to chainId ${chain.chainId}. Set ALLOW_NON_BASE=1 for test deployments.`
    );
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer && !DRY_RUN) {
    throw new Error("No deployer signer. Set DEPLOYER_PRIVATE_KEY or MNEMONIC_KEY.");
  }

  const deployerAddress = deployer ? await deployer.getAddress() : process.env.ESTIMATE_FROM;
  const ownerAddress =
    OWNER_ADDRESS ||
    (DRY_RUN ? deployerAddress || DRY_RUN_OWNER_ADDRESS : undefined) ||
    (chain.chainId === BASE_MAINNET_CHAIN_ID ? undefined : deployerAddress);
  if (!ownerAddress) {
    throw new Error("OWNER_ADDRESS is required for Base mainnet deploys.");
  }
  requireAddress("OWNER_ADDRESS", ownerAddress);

  const balance = deployerAddress ? await ethers.provider.getBalance(deployerAddress) : undefined;
  const args = [
    DIAMOND_ADDRESS,
    USDC_ADDRESS,
    ownerAddress,
    BigInt(PER_TX_USDC_LIMIT),
    BigInt(DAILY_TX_COUNT_LIMIT),
    BigInt(DAILY_USDC_VOLUME_LIMIT),
  ] as const;

  console.log("Network:", network.name, `chainId=${chain.chainId}`);
  console.log("Deployer:", deployerAddress || "(dry-run estimate only)");
  if (balance !== undefined) console.log("Deployer ETH:", ethers.formatEther(balance));
  console.log("Owner:", ownerAddress);
  console.log("Diamond:", DIAMOND_ADDRESS);
  console.log("USDC:", USDC_ADDRESS);
  console.log("Per-tx USDC limit:", ethers.formatUnits(PER_TX_USDC_LIMIT, 6));
  console.log("Daily tx count limit:", DAILY_TX_COUNT_LIMIT);
  console.log("Daily USDC volume limit:", ethers.formatUnits(DAILY_USDC_VOLUME_LIMIT, 6));
  console.log("");

  const Integrator = await ethers.getContractFactory("ZeroXRampDirectSettlementIntegrator");
  const deployTxRequest = await Integrator.getDeployTransaction(...args);
  const estimateRequest = deployerAddress
    ? { ...deployTxRequest, from: deployerAddress }
    : deployTxRequest;
  const gasEstimate = await ethers.provider.estimateGas(estimateRequest);
  const feeData = await ethers.provider.getFeeData();
  console.log("Estimated deploy gas:", gasEstimate.toString());
  if (feeData.gasPrice) {
    console.log("Estimated deploy fee:", ethers.formatEther(gasEstimate * feeData.gasPrice), "ETH");
  }
  console.log("");

  if (DRY_RUN) {
    console.log("DRY_RUN=1: estimate complete; no transaction submitted.");
    return;
  }

  console.log("Deploying ZeroXRampDirectSettlementIntegrator...");
  const integrator = await Integrator.deploy(...args);
  const deployTx = integrator.deploymentTransaction();
  const confirmations = network.name === "hardhat" ? 1 : DEPLOY_CONFIRMATIONS;
  await deployTx?.wait(confirmations);

  const address = await integrator.getAddress();
  const code = await ethers.provider.getCode(address);
  if (code === "0x" || code.length <= 2) throw new Error(`Contract has no code at ${address}`);

  const proxyImpl = await integrator.proxyImpl();
  console.log("");
  console.log("=== Deployment Summary ===");
  console.log(`Integrator:              ${address}`);
  console.log(`proxyImpl:               ${proxyImpl}`);
  console.log(`Diamond:                 ${await integrator.diamond()}`);
  console.log(`USDC:                    ${await integrator.usdc()}`);
  console.log(`Owner:                   ${await integrator.owner()}`);
  console.log(
    `Per-tx USDC limit:       ${ethers.formatUnits(await integrator.perTxUsdcLimit(), 6)}`
  );
  console.log(`Daily tx count limit:    ${(await integrator.dailyTxCountLimit()).toString()}`);
  console.log(
    `Daily USDC volume limit: ${ethers.formatUnits(await integrator.dailyUsdcVolumeLimit(), 6)}`
  );
  console.log("");
  console.log("Verify:");
  console.log(
    `  npx hardhat verify --network ${network.name} ${address} ${DIAMOND_ADDRESS} ${USDC_ADDRESS} ${ownerAddress} ${PER_TX_USDC_LIMIT} ${DAILY_TX_COUNT_LIMIT} ${DAILY_USDC_VOLUME_LIMIT}`
  );
  console.log("");
  console.log("Whitelist request:");
  console.log(`  registerIntegrator(${address}, false, ${proxyImpl})`);
  console.log("  usdcThroughIntegrator=false");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
