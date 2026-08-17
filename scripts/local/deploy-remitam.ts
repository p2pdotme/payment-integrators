import { ethers } from "hardhat";

/**
 * Deploy RemitamIntegrator.
 *
 *   All buy/sell limits (per-tx, daily volume, daily count) are enforced
 *   server-side by the Remitam backend, not on-chain. The only on-chain gate
 *   is the owner-managed whitelist of backend-controlled server wallets —
 *   see `addAccount` below.
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x... \
 *     npx hardhat run scripts/local/deploy-remitam.ts --network baseSepolia
 */

const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "";

async function main() {
  if (!DIAMOND_ADDRESS || !USDC_ADDRESS) {
    throw new Error("DIAMOND_ADDRESS and USDC_ADDRESS env vars required");
  }

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", await deployer.getAddress());
  console.log("Diamond:", DIAMOND_ADDRESS);
  console.log("USDC:", USDC_ADDRESS);
  console.log("");

  console.log("Deploying RemitamIntegrator...");
  const Integrator = await ethers.getContractFactory("RemitamIntegrator");
  const integrator = await Integrator.deploy(DIAMOND_ADDRESS, USDC_ADDRESS);
  const deployTx = integrator.deploymentTransaction();
  await deployTx?.wait(5);

  const address = await integrator.getAddress();
  console.log(`RemitamIntegrator deployed to: ${address}`);

  const code = await ethers.provider.getCode(address);
  if (code === "0x" || code.length <= 2) throw new Error(`Contract has no code at ${address}`);

  const proxyImpl = await integrator.proxyImpl();
  console.log("");
  console.log("=== Deployment Summary ===");
  console.log(`Integrator:            ${address}`);
  console.log(`proxyImpl:             ${proxyImpl}`);
  console.log(`Diamond:               ${await integrator.diamond()}`);
  console.log(`USDC:                  ${await integrator.usdc()}`);
  console.log(`Owner:                 ${await integrator.owner()}`);
  console.log("");
  console.log("Verify command:");
  console.log(
    `  npx hardhat verify --network <network> ${address} \\\n` +
      `    ${DIAMOND_ADDRESS} ${USDC_ADDRESS}`
  );
  console.log("");
  console.log("Next steps:");
  console.log("  1. Verify on Basescan / Sourcify (reviewers diff source vs the merged commit).");
  console.log("  2. addAccount(<Remitam server wallet>) for every backend-controlled thirdweb");
  console.log("     wallet that will place orders. No order can be placed for an unwhitelisted");
  console.log("     wallet — this is deliberate fail-closed behaviour. Buy/sell limits are");
  console.log("     enforced by the Remitam backend before it ever signs an order.");
  console.log("  3. File a Whitelist request issue (docs/WHITELISTING.md). The P2P super-admin");
  console.log("     calls:");
  console.log(`       registerIntegrator(integrator = ${address},`);
  console.log(`                          usdcThroughIntegrator = false,`);
  console.log(`                          proxyImpl  = ${proxyImpl})`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
