import { ethers } from "hardhat";

/**
 * Deploy + wire the marketplace demo stack on Base Sepolia:
 *   SimpleNFTMarketplace (NFT client) + MarketplaceCheckoutIntegrator
 *   → register on the Diamond (usdcThroughIntegrator = FALSE; the buy routes
 *     USDC to the user's proxy, not the integrator) → recipes + prices →
 *     setOfframpIntegrator on the client → seed the integrator's USDC pool
 *     (sell-backs pay from this pool; buy revenue accumulates on the client).
 *
 * Signer = deployer = Diamond super-admin (contracts-v4 MNEMONIC_KEY).
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x... [BASE_TX_LIMIT=50000000]
 *   [DAILY_TX_COUNT_LIMIT=10] [MAX_USDC_PER_OFFRAMP=1000000000]
 *   [SEED_USDC=200000000] \
 *   npx hardhat run scripts/local/deploy-marketplace-demo.ts --network baseSepolia
 */

const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "";
const BASE_TX_LIMIT = process.env.BASE_TX_LIMIT || "50000000";
const DAILY_TX_COUNT_LIMIT = process.env.DAILY_TX_COUNT_LIMIT || "10";
const MAX_USDC_PER_OFFRAMP = process.env.MAX_USDC_PER_OFFRAMP || "1000000000"; // 1000 USDC
const SEED_USDC = process.env.SEED_USDC || "200000000"; // 200 USDC sell-back pool

// productId → unit price (6dp USDC). Mirrors the demo storefront.
const PRODUCTS: Array<[number, bigint]> = [
  [1, 5_000_000n], // Common  — 5 USDC
  [2, 10_000_000n], // Rare    — 10 USDC
  [3, 25_000_000n], // Legendary — 25 USDC
];

const REGISTER_ABI = [
  "function registerIntegrator(address integrator, bool usdcThroughIntegrator, address proxyImpl)",
  "function getIntegratorConfig(address) view returns (tuple(bool isActive, bool usdcThroughIntegrator, uint256 activeOrderCount, address proxyImpl))",
];

const f = (n: bigint) => ethers.formatUnits(n, 6);

async function main() {
  if (!DIAMOND_ADDRESS || !USDC_ADDRESS) throw new Error("DIAMOND_ADDRESS + USDC_ADDRESS required");
  const [deployer] = await ethers.getSigners();
  const me = await deployer.getAddress();
  console.log("Deployer / super-admin:", me);
  console.log("Diamond:", DIAMOND_ADDRESS, " USDC:", USDC_ADDRESS);

  // 1. NFT marketplace client.
  console.log("\nDeploying SimpleNFTMarketplace…");
  const Mkt = await ethers.getContractFactory("SimpleNFTMarketplace");
  const marketplace = await Mkt.deploy(USDC_ADDRESS, "P2P Demo Collectibles", "P2PNFT");
  await marketplace.deploymentTransaction()?.wait(2);
  const marketplaceAddr = await marketplace.getAddress();
  console.log("  SimpleNFTMarketplace:", marketplaceAddr);

  // 2. Integrator.
  console.log("Deploying MarketplaceCheckoutIntegrator…");
  const Integ = await ethers.getContractFactory("MarketplaceCheckoutIntegrator");
  const integrator = await Integ.deploy(
    DIAMOND_ADDRESS,
    USDC_ADDRESS,
    BigInt(BASE_TX_LIMIT),
    BigInt(DAILY_TX_COUNT_LIMIT)
  );
  await integrator.deploymentTransaction()?.wait(2);
  const integratorAddr = await integrator.getAddress();
  const proxyImpl = await integrator.proxyImpl();
  console.log("  MarketplaceCheckoutIntegrator:", integratorAddr, " proxyImpl:", proxyImpl);

  // 3. Register on the Diamond — usdcThroughIntegrator = FALSE (USDC → proxy).
  console.log("\nRegistering integrator on the Diamond (usdcThroughIntegrator=false)…");
  const b2b = new ethers.Contract(DIAMOND_ADDRESS, REGISTER_ABI, deployer);
  await (await b2b.registerIntegrator(integratorAddr, false, proxyImpl)).wait(1);

  // 4. Client ↔ integrator wiring + recipes + prices.
  console.log("Wiring marketplace + recipes…");
  await (await marketplace.setOfframpIntegrator(integratorAddr)).wait(1);
  const buySelector = marketplace.interface.getFunction("buy")!.selector; // buy(uint256,uint256)
  for (const [productId, price] of PRODUCTS) {
    await (await marketplace.setProductPrice(productId, price)).wait(1);
    const prefixArgs = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [productId]);
    await (
      await integrator.setRecipe(
        marketplaceAddr,
        productId,
        price,
        buySelector,
        prefixArgs,
        true,
        []
      )
    ).wait(1);
    console.log(`  product ${productId}: ${f(price)} USDC  (recipe set)`);
  }

  // 5. Offramp config.
  await (await integrator.setOfframpEnabled(true)).wait(1);
  await (await integrator.setMaxUsdcPerOfframp(BigInt(MAX_USDC_PER_OFFRAMP))).wait(1);
  await (await integrator.setOfframpRelayer(me)).wait(1);

  // 6. Seed the integrator's sell-back USDC pool from the deployer's balance.
  const usdc = await ethers.getContractAt("IERC20", USDC_ADDRESS);
  const seed = BigInt(SEED_USDC);
  if (seed > 0n && (await usdc.balanceOf(me)) >= seed) {
    await (await usdc.transfer(integratorAddr, seed)).wait(1);
    console.log(`  seeded integrator sell-back pool with ${f(seed)} USDC`);
  } else {
    console.log(
      "  ⚠️  skipped pool seed (insufficient deployer USDC) — sell-backs need a funded pool"
    );
  }

  console.log("\n=== Marketplace demo deployment ===");
  console.log(`MarketplaceCheckoutIntegrator: ${integratorAddr}`);
  console.log(`SimpleNFTMarketplace (client): ${marketplaceAddr}`);
  console.log(`proxyImpl:                     ${proxyImpl}`);
  console.log(`offramp pool (integrator) USDC: ${f(await usdc.balanceOf(integratorAddr))}`);
  console.log("\n--- demo app .env ---");
  console.log(`VITE_MARKETPLACE_INTEGRATOR_ADDRESS=${integratorAddr}`);
  console.log(`VITE_MARKETPLACE_ADDRESS=${marketplaceAddr}`);
  console.log(`VITE_DIAMOND_ADDRESS=${DIAMOND_ADDRESS}`);
  console.log(`VITE_USDC_ADDRESS=${USDC_ADDRESS}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
