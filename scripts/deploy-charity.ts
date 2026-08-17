import { ethers } from "hardhat";

/**
 * Deploy CharityCheckoutIntegrator.
 *
 * Donation onramp: users pay local fiat and the purchased USDC is delivered
 * directly to a single charity wallet. No per-tx amount cap; each wallet is
 * limited to 1 donation order per UTC day.
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x... CHARITY_WALLET=0x... \
 *   npx hardhat run scripts/deploy-charity.ts --network baseSepolia
 */

const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "";
const CHARITY_WALLET = process.env.CHARITY_WALLET || "";

async function main() {
  if (!DIAMOND_ADDRESS || !USDC_ADDRESS || !CHARITY_WALLET) {
    throw new Error("DIAMOND_ADDRESS, USDC_ADDRESS and CHARITY_WALLET env vars required");
  }

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", await deployer.getAddress());
  console.log("Diamond:", DIAMOND_ADDRESS);
  console.log("USDC:", USDC_ADDRESS);
  console.log("Charity wallet:", CHARITY_WALLET);
  console.log("");

  console.log("Deploying CharityCheckoutIntegrator...");
  const Integrator = await ethers.getContractFactory("CharityCheckoutIntegrator");
  const integrator = await Integrator.deploy(DIAMOND_ADDRESS, USDC_ADDRESS, CHARITY_WALLET);
  const deployTx = integrator.deploymentTransaction();
  await deployTx?.wait(5);

  const address = await integrator.getAddress();
  console.log(`CharityCheckoutIntegrator deployed to: ${address}`);

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
  console.log(`Charity wallet:      ${await integrator.charityWallet()}`);
  console.log(
    `Max orders per day:  ${(await integrator.MAX_ORDERS_PER_DAY()).toString()} per wallet`
  );
  console.log("");
  console.log("Next steps:");
  console.log(
    "  1. Verify on Etherscan / Sourcify so reviewers can diff source against the merged commit:"
  );
  console.log(
    `       npx hardhat verify --network <network> ${address} ${DIAMOND_ADDRESS} ${USDC_ADDRESS} ${CHARITY_WALLET}`
  );
  console.log(
    "  2. File a Whitelist request issue (see docs/WHITELISTING.md). The P2P team will call:"
  );
  console.log(`       registerIntegrator(integrator = ${address},`);
  console.log(`                          proxyImpl  = ${proxyImpl},`);
  console.log(`                          source     = bytes32("charity"))`);
  console.log("     on the Diamond once verification passes.");
  console.log("     IMPORTANT: register with usdcThroughIntegrator = false — the Diamond must");
  console.log(
    "     transfer purchased USDC straight to the order's recipientAddr (the charity wallet)."
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
