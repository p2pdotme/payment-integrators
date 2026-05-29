import { ethers } from "hardhat";

/**
 * Deploy the TradeStars v2 (user-driven offramp) stack:
 * RestrictedYieldVault + TradeStarsCheckoutIntegratorV2, wired together, with
 * fresh MockAavePool + mock aUSDC on Base Sepolia (no Aave V3 there).
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x... \
 *   [AAVE_POOL_ADDRESS=0x...] [AUSDC_ADDRESS=0x...] \
 *   [OFFRAMP_RELAYER=0x...] [MAX_USDC_PER_OFFRAMP=50000000] \
 *   [SEED_VAULT_USDC=50000000] \
 *   npx hardhat run scripts/deploy-tradestars-v2.ts --network baseSepolia
 *
 * On Base Sepolia leave AAVE_POOL_ADDRESS/AUSDC_ADDRESS unset → deploys mocks.
 * OFFRAMP_RELAYER defaults to the deployer (which is also the Diamond superAdmin
 * in the test deployment). SEED_VAULT_USDC (if set and the deployer holds USDC)
 * deposits that much into the vault for offramp liquidity.
 */

const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "";
const AAVE_POOL_ADDRESS = process.env.AAVE_POOL_ADDRESS || "";
const AUSDC_ADDRESS = process.env.AUSDC_ADDRESS || "";
const BASE_TX_LIMIT = process.env.BASE_TX_LIMIT || "50000000";
const DAILY_TX_COUNT_LIMIT = process.env.DAILY_TX_COUNT_LIMIT || "10";
const MAX_USDC_PER_OFFRAMP = process.env.MAX_USDC_PER_OFFRAMP || "50000000";
const OFFRAMP_RELAYER = process.env.OFFRAMP_RELAYER || "";
const SEED_VAULT_USDC = process.env.SEED_VAULT_USDC || "0";

async function main() {
  if (!DIAMOND_ADDRESS || !USDC_ADDRESS) {
    throw new Error("DIAMOND_ADDRESS and USDC_ADDRESS env vars required");
  }

  const [deployer] = await ethers.getSigners();
  const me = await deployer.getAddress();
  const relayer = OFFRAMP_RELAYER || me;

  console.log("Deployer:    ", me);
  console.log("Diamond:     ", DIAMOND_ADDRESS);
  console.log("USDC:        ", USDC_ADDRESS);
  console.log("Relayer:     ", relayer);
  console.log("");

  // 1. aUSDC mock (Base Sepolia has no Aave).
  let aUsdcAddress = AUSDC_ADDRESS;
  if (!aUsdcAddress) {
    console.log("Deploying mock aUSDC…");
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const aUsdc = await MockUSDC.deploy();
    await aUsdc.deploymentTransaction()?.wait(2);
    aUsdcAddress = await aUsdc.getAddress();
    console.log("  Mock aUSDC:     ", aUsdcAddress);
  }

  // 2. Aave pool mock.
  let aavePoolAddress = AAVE_POOL_ADDRESS;
  if (!aavePoolAddress) {
    console.log("Deploying MockAavePool…");
    const MockAavePool = await ethers.getContractFactory("MockAavePool");
    const pool = await MockAavePool.deploy();
    await pool.deploymentTransaction()?.wait(2);
    aavePoolAddress = await pool.getAddress();
    await (await pool.configure(USDC_ADDRESS, aUsdcAddress)).wait(1);
    console.log("  MockAavePool:    ", aavePoolAddress);
  }

  // 3. Vault.
  console.log("Deploying RestrictedYieldVault…");
  const Vault = await ethers.getContractFactory("RestrictedYieldVault");
  const vault = await Vault.deploy(USDC_ADDRESS, aUsdcAddress, aavePoolAddress);
  await vault.deploymentTransaction()?.wait(3);
  const vaultAddress = await vault.getAddress();
  console.log("  Vault:           ", vaultAddress);

  // 4. Integrator v2.
  console.log("Deploying TradeStarsCheckoutIntegratorV2…");
  const Integrator = await ethers.getContractFactory("TradeStarsCheckoutIntegratorV2");
  const integrator = await Integrator.deploy(
    DIAMOND_ADDRESS,
    USDC_ADDRESS,
    BigInt(BASE_TX_LIMIT),
    BigInt(DAILY_TX_COUNT_LIMIT)
  );
  await integrator.deploymentTransaction()?.wait(3);
  const integratorAddress = await integrator.getAddress();
  const proxyImpl = await integrator.proxyImpl();
  console.log("  Integrator v2:   ", integratorAddress);
  console.log("  proxyImpl:       ", proxyImpl);

  // 5. Wire vault ↔ integrator.
  console.log("Wiring vault ↔ integrator…");
  await (await vault.setOfframpOperator(integratorAddress)).wait(1);
  await (await integrator.setYieldVault(vaultAddress)).wait(1);
  await (await integrator.setOfframpEnabled(true)).wait(1);
  await (await integrator.setOfframpRelayer(relayer)).wait(1);
  await (await integrator.setMaxUsdcPerOfframp(BigInt(MAX_USDC_PER_OFFRAMP))).wait(1);

  // 6. Optional: seed vault with USDC for offramp liquidity.
  if (SEED_VAULT_USDC !== "0") {
    const usdc = await ethers.getContractAt("IERC20", USDC_ADDRESS);
    const bal = await usdc.balanceOf(me);
    if (bal >= BigInt(SEED_VAULT_USDC)) {
      console.log(`Seeding vault with ${ethers.formatUnits(SEED_VAULT_USDC, 6)} USDC…`);
      await (await usdc.approve(vaultAddress, BigInt(SEED_VAULT_USDC))).wait(1);
      await (await vault.deposit(BigInt(SEED_VAULT_USDC))).wait(1);
      console.log(
        "  Vault offrampQuota:",
        ethers.formatUnits(await vault.offrampQuota(), 6),
        "USDC"
      );
    } else {
      console.log(
        `! Deployer holds ${ethers.formatUnits(bal, 6)} USDC < SEED_VAULT_USDC; skipping seed.`
      );
    }
  }

  console.log("");
  console.log("=== Deployment Summary (offramp v2) ===");
  console.log(`Integrator v2:               ${integratorAddress}`);
  console.log(`proxyImpl:                   ${proxyImpl}`);
  console.log(`RestrictedYieldVault:        ${vaultAddress}`);
  console.log(`Aave pool (mock):            ${aavePoolAddress}`);
  console.log(`aUSDC (mock):                ${aUsdcAddress}`);
  console.log(`Offramp relayer:             ${relayer}`);
  console.log(`MaxUsdcPerOfframp:           ${ethers.formatUnits(MAX_USDC_PER_OFFRAMP, 6)} USDC`);
  console.log("");
  console.log("Next: whitelist on the Diamond (run from contracts-v4 as superAdmin):");
  console.log(`  DIAMOND_ADDRESS=${DIAMOND_ADDRESS} INTEGRATOR_ADDRESS=${integratorAddress} \\`);
  console.log(`  PROXY_IMPL=${proxyImpl} USDC_THROUGH_INTEGRATOR=true \\`);
  console.log(`  npx hardhat run scripts/registerIntegrator.ts --network baseSepolia`);
  console.log("");
  console.log("Then E2E:");
  console.log(`  DIAMOND_ADDRESS=${DIAMOND_ADDRESS} USDC_ADDRESS=${USDC_ADDRESS} \\`);
  console.log(`  INTEGRATOR_ADDRESS=${integratorAddress} VAULT_ADDRESS=${vaultAddress} \\`);
  console.log(`  npx hardhat run scripts/e2e-offramp-v2-sepolia.ts --network baseSepolia`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
