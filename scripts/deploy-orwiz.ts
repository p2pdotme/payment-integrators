import { ethers } from "hardhat";

/**
 * Deploy OrwizIntegrator for Base Sepolia or Base Mainnet.
 *
 * Registration on B2BGatewayFacet MUST use:
 *   usdcThroughIntegrator = true
 *   proxyImpl             = <integrator.proxyImpl()>
 *
 * Usage (Base Sepolia — DIAMOND_ADDRESS and USDC_ADDRESS default to Sepolia presets):
 *   TREASURY_ADDRESS=0x... \
 *     npx hardhat run scripts/deploy-orwiz.ts --network baseSepolia
 *
 * Usage (Base Mainnet):
 *   TREASURY_ADDRESS=0x... \
 *     npx hardhat run scripts/deploy-orwiz.ts --network base
 *
 * Optional env vars:
 *   DIAMOND_ADDRESS=0x...        (overrides network preset)
 *   USDC_ADDRESS=0x...           (overrides network preset)
 *   MAX_TX_LIMIT=50000000        (6 decimals, default 50 USDC; ceiling 500 USDC)
 *   DAILY_TX_COUNT_LIMIT=5       (default 5; ceiling 20)
 */

const PRESETS: Record<number, { label: string; diamond?: string; usdc?: string }> = {
  8453: {
    label: "Base Mainnet",
    diamond: "0x4cad6eC90e65baBec9335cAd728DDC610c316368",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  84532: {
    label: "Base Sepolia",
    diamond: "0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9",
    usdc: "0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d", // GG mock settlement token (6 decimals)
  },
};

const MAX_TX_LIMIT = process.env.MAX_TX_LIMIT || "50000000"; // 50 USDC
const DAILY_TX_COUNT_LIMIT = process.env.DAILY_TX_COUNT_LIMIT || "5";

async function main() {
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const preset = PRESETS[chainId];

  const diamondAddress = process.env.DIAMOND_ADDRESS || preset?.diamond || "";
  const usdcAddress = process.env.USDC_ADDRESS || preset?.usdc || "";
  const treasuryAddress = process.env.TREASURY_ADDRESS || "";

  if (!diamondAddress || !usdcAddress || !treasuryAddress) {
    throw new Error("DIAMOND_ADDRESS, USDC_ADDRESS, and TREASURY_ADDRESS env vars are required");
  }

  if (!ethers.isAddress(diamondAddress))
    throw new Error(`Invalid DIAMOND_ADDRESS: ${diamondAddress}`);
  if (!ethers.isAddress(usdcAddress)) throw new Error(`Invalid USDC_ADDRESS: ${usdcAddress}`);
  if (!ethers.isAddress(treasuryAddress))
    throw new Error(`Invalid TREASURY_ADDRESS: ${treasuryAddress}`);

  const [deployer] = await ethers.getSigners();
  console.log("Network:", preset?.label ?? `chainId ${chainId}`);
  console.log("Deployer:", await deployer.getAddress());
  console.log("Diamond:", diamondAddress);
  console.log("USDC:", usdcAddress);
  console.log("Treasury:", treasuryAddress);
  console.log("Max TX Limit:", ethers.formatUnits(MAX_TX_LIMIT, 6), "USDC");
  console.log("Daily TX Count Limit:", DAILY_TX_COUNT_LIMIT, "orders/day");
  console.log("");

  console.log("Deploying OrwizIntegrator...");
  const OrwizIntegrator = await ethers.getContractFactory("OrwizIntegrator");
  const integrator = await OrwizIntegrator.deploy(
    diamondAddress,
    usdcAddress,
    treasuryAddress,
    BigInt(MAX_TX_LIMIT),
    BigInt(DAILY_TX_COUNT_LIMIT)
  );
  const deployTx = integrator.deploymentTransaction();
  await deployTx?.wait(5);

  const address = await integrator.getAddress();
  const code = await ethers.provider.getCode(address);
  if (code === "0x" || code.length <= 2) {
    throw new Error(`Contract has no code at ${address}`);
  }

  const proxyImpl = await integrator.proxyImpl();
  console.log("");
  console.log("=== OrwizIntegrator Deployment Summary ===");
  console.log(`Integrator:           ${address}`);
  console.log(`proxyImpl:            ${proxyImpl}`);
  console.log(`Diamond:              ${await integrator.diamond()}`);
  console.log(`USDC:                 ${await integrator.usdc()}`);
  console.log(`Treasury:             ${await integrator.treasury()}`);
  console.log(`Owner:                ${await integrator.owner()}`);
  console.log(`Max TX Limit:         ${ethers.formatUnits(await integrator.maxTxLimit(), 6)} USDC`);
  console.log(`Daily TX Count Limit: ${(await integrator.dailyTxCountLimit()).toString()} per day`);
  console.log("");
  console.log("Next steps:");
  console.log("  1. Verify on Basescan:");
  console.log(
    `       npx hardhat verify --network ${chainId === 8453 ? "base" : "baseSepolia"} ${address} ${diamondAddress} ${usdcAddress} ${treasuryAddress} ${MAX_TX_LIMIT} ${DAILY_TX_COUNT_LIMIT}`
  );
  console.log("  2. Register on B2BGatewayFacet with:");
  console.log(`       B2BGatewayFacet.registerIntegrator(`);
  console.log(`         integrator:            ${address},`);
  console.log(`         usdcThroughIntegrator: true,`);
  console.log(`         proxyImpl:             ${proxyImpl}`);
  console.log(`       )`);
  console.log("  3. Enable cancel callback on B2BGatewayFacet (required for onOrderCancel):");
  console.log(`       B2BGatewayFacet.setIntegratorCancelCallback(${address}, true)`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
