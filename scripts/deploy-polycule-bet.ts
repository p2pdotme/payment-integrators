import { ethers } from "hardhat";

/**
 * Deploy PolyculeBetIntegrator. The integrator's constructor also deploys
 * the canonical UserProxy implementation that all per-user clones delegate to.
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x... OWNER_ADDRESS=0x... \
 *   REGISTRAR_ADDRESS=0x... \
 *   npx hardhat run scripts/deploy-polycule-bet.ts --network base
 */

const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "";
const OWNER_ADDRESS = process.env.OWNER_ADDRESS || "";
const REGISTRAR_ADDRESS = process.env.REGISTRAR_ADDRESS || "";

async function main() {
  if (!DIAMOND_ADDRESS || !USDC_ADDRESS || !OWNER_ADDRESS || !REGISTRAR_ADDRESS) {
    throw new Error(
      "DIAMOND_ADDRESS, USDC_ADDRESS, OWNER_ADDRESS, REGISTRAR_ADDRESS env vars required"
    );
  }

  const [deployer] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();
  const balance = await ethers.provider.getBalance(deployerAddr);

  console.log("Deployer:", deployerAddr);
  console.log("Balance:", ethers.formatEther(balance), "ETH");
  console.log("Diamond:", DIAMOND_ADDRESS);
  console.log("USDC:", USDC_ADDRESS);
  console.log("Owner:", OWNER_ADDRESS);
  console.log("Registrar:", REGISTRAR_ADDRESS);
  console.log("");

  const Integrator = await ethers.getContractFactory("PolyculeBetIntegrator");

  const deployTxData = await Integrator.getDeployTransaction(
    DIAMOND_ADDRESS,
    USDC_ADDRESS,
    OWNER_ADDRESS,
    REGISTRAR_ADDRESS
  );
  const estimatedGas = await ethers.provider.estimateGas({
    from: deployerAddr,
    data: deployTxData.data,
  });
  const feeData = await ethers.provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas || feeData.gasPrice || 0n;
  const estCost = estimatedGas * gasPrice;
  console.log("Estimated gas:", estimatedGas.toString());
  console.log("Max fee per gas:", ethers.formatUnits(gasPrice, "gwei"), "gwei");
  console.log("Est. cost:", ethers.formatEther(estCost), "ETH");
  console.log("");

  if (balance < estCost) {
    throw new Error(
      `Insufficient balance: have ${ethers.formatEther(balance)} ETH, need ~${ethers.formatEther(estCost)} ETH`
    );
  }

  console.log("Deploying PolyculeBetIntegrator (deploys UserProxy impl in ctor)...");
  const integrator = await Integrator.deploy(
    DIAMOND_ADDRESS,
    USDC_ADDRESS,
    OWNER_ADDRESS,
    REGISTRAR_ADDRESS
  );
  const deployTx = integrator.deploymentTransaction();
  console.log("Deploy tx:", deployTx?.hash);
  await deployTx?.wait(3);

  const address = await integrator.getAddress();
  const proxyImpl = await integrator.proxyImpl();

  const code = await ethers.provider.getCode(address);
  if (code === "0x" || code.length <= 2) throw new Error(`Contract has no code at ${address}`);

  console.log("");
  console.log("=== Deployment Summary ===");
  console.log(`PolyculeBetIntegrator: ${address}`);
  console.log(`UserProxy impl:        ${proxyImpl}`);
  console.log(`Diamond:               ${await integrator.diamond()}`);
  console.log(`USDC:                  ${await integrator.usdc()}`);
  console.log(`Owner:                 ${await integrator.owner()}`);
  console.log(`Registrar:             ${await integrator.registrar()}`);
  console.log("");
  console.log("Next steps:");
  console.log(`  1. Register on Diamond (super-admin):`);
  console.log(`       registerIntegrator(${address}, true, ${proxyImpl})`);
  console.log(
    `     - usdcThroughIntegrator=true: Diamond transfers USDC to the integrator on completion;`
  );
  console.log(`       onOrderComplete forwards to the user's pinned bridge recipient.`);
  console.log(
    `  2. Registrar calls setBridgeRecipient(user, recipient) per user after off-chain auth.`
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
