import { ethers } from "hardhat";

/**
 * Deploy MerchantTerminalIntegrator + its SimpleERC721Client price source.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-merchant-terminal.ts --network baseSepolia
 *   (DIAMOND_ADDRESS + USDC_ADDRESS from .env)
 *
 * The client's product 2 is priced at 0.01 USDC/unit — the POS maps any
 * INR amount to quantity = USDC cents.
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

  console.log("Deploying MerchantTerminalIntegrator...");
  const Integrator = await ethers.getContractFactory("MerchantTerminalIntegrator");
  const integrator = await Integrator.deploy(DIAMOND_ADDRESS, USDC_ADDRESS);
  await integrator.deploymentTransaction()?.wait(3);
  const address = await integrator.getAddress();

  const code = await ethers.provider.getCode(address);
  if (code === "0x" || code.length <= 2) throw new Error(`No code at ${address}`);

  console.log("Deploying SimpleERC721Client (price source)...");
  const Client = await ethers.getContractFactory("SimpleERC721Client");
  const client = await Client.deploy(address, USDC_ADDRESS, "Merchant Terminal Item", "MTI");
  await client.deploymentTransaction()?.wait(3);
  const clientAddress = await client.getAddress();

  console.log("Pricing product 2 at 0.01 USDC/unit...");
  await (await client.setProductPrice(2, 10_000)).wait(3);

  const proxyImpl = await integrator.proxyImpl();
  const runtimeBytecodeHash = ethers.keccak256(code);

  console.log("");
  console.log("=== Deployment Summary ===");
  console.log(`Integrator:            ${address}`);
  console.log(`proxyImpl (pinned):    ${proxyImpl}`);
  console.log(`Price client:          ${clientAddress}`);
  console.log(`Diamond:               ${await integrator.diamond()}`);
  console.log(`USDC:                  ${await integrator.usdc()}`);
  console.log(`Owner:                 ${await integrator.owner()}`);
  console.log(
    `PER_TX_CAP:            ${ethers.formatUnits(await integrator.PER_TX_CAP(), 6)} USDC`
  );
  console.log(`DAILY_TX_LIMIT:        ${(await integrator.DAILY_TX_LIMIT()).toString()} per day`);
  console.log(
    `SETTLEMENT_PERIOD:     ${(await integrator.SETTLEMENT_PERIOD()).toString()} seconds (30 days)`
  );
  console.log(`Runtime bytecode hash: ${runtimeBytecodeHash}`);
  console.log("");
  console.log("Next steps:");
  console.log(
    `  1. Verify: npx hardhat verify --network baseSepolia ${address} ${DIAMOND_ADDRESS} ${USDC_ADDRESS}`
  );
  console.log(
    `     and:    npx hardhat verify --network baseSepolia ${clientAddress} ${address} ${USDC_ADDRESS} "Merchant Terminal Item" "MTI"`
  );
  console.log("  2. File the whitelist request (docs/WHITELISTING.md):");
  console.log(`       integrator             = ${address}`);
  console.log(`       proxyImpl              = ${proxyImpl}`);
  console.log(
    "       usdcThroughIntegrator  = FALSE  (Diamond pays the merchant proxy; onOrderComplete pulls)"
  );
  console.log("  3. Point backend/frontend env at the integrator + client addresses.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
