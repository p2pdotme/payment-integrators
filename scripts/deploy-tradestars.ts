import { ethers } from "hardhat";

/**
 * Deploy the TradeStars stack: RestrictedYieldVault + TradeStarsCheckoutIntegrator
 * with vault ↔ integrator wired together.
 *
 * On mainnet, set AAVE_POOL_ADDRESS + AUSDC_ADDRESS to skip the mock deploys.
 * On Base Sepolia (where Aave V3 isn't deployed), omit both — the script
 * deploys a MockAavePool + mock aUSDC for local testing.
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x... \
 *   [AAVE_POOL_ADDRESS=0x...] [AUSDC_ADDRESS=0x...] \
 *   [OFFRAMP_RELAYER=0x...] \
 *   npx hardhat run scripts/deploy-tradestars.ts --network base
 *
 * Optional:
 *   BASE_TX_LIMIT=50000000           (default 50 USDC)
 *   DAILY_TX_COUNT_LIMIT=10
 *   MAX_USDC_PER_OFFRAMP=50000000    (default 50 USDC per call)
 *   OFFRAMP_RELAYER=0x...            (default: deployer)
 */

const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "";
const AAVE_POOL_ADDRESS = process.env.AAVE_POOL_ADDRESS || "";
const AUSDC_ADDRESS = process.env.AUSDC_ADDRESS || "";
const BASE_TX_LIMIT = process.env.BASE_TX_LIMIT || "50000000";
const DAILY_TX_COUNT_LIMIT = process.env.DAILY_TX_COUNT_LIMIT || "10";
const MAX_USDC_PER_OFFRAMP = process.env.MAX_USDC_PER_OFFRAMP || "50000000";
const OFFRAMP_RELAYER = process.env.OFFRAMP_RELAYER || "";

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

  // 1. aUSDC — pin existing on mainnet, or deploy mock on Sepolia.
  let aUsdcAddress = AUSDC_ADDRESS;
  if (!aUsdcAddress) {
    console.log("Deploying mock aUSDC (MockUSDC instance)…");
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const aUsdc = await MockUSDC.deploy();
    await aUsdc.deploymentTransaction()?.wait(2);
    aUsdcAddress = await aUsdc.getAddress();
    console.log("  Mock aUSDC:     ", aUsdcAddress);
  } else {
    console.log("Using existing aUSDC:", aUsdcAddress);
  }

  // 2. Aave pool — pin existing on mainnet, or deploy mock on Sepolia.
  let aavePoolAddress = AAVE_POOL_ADDRESS;
  if (!aavePoolAddress) {
    console.log("Deploying MockAavePool…");
    const MockAavePool = await ethers.getContractFactory("MockAavePool");
    const pool = await MockAavePool.deploy();
    await pool.deploymentTransaction()?.wait(2);
    aavePoolAddress = await pool.getAddress();
    console.log("  MockAavePool:    ", aavePoolAddress);
    console.log("Configuring mock pool USDC ↔ aUSDC mapping…");
    await (await pool.configure(USDC_ADDRESS, aUsdcAddress)).wait(1);
  } else {
    console.log("Using existing Aave pool:", aavePoolAddress);
  }

  // 3. Vault
  console.log("Deploying RestrictedYieldVault…");
  const Vault = await ethers.getContractFactory("RestrictedYieldVault");
  const vault = await Vault.deploy(USDC_ADDRESS, aUsdcAddress, aavePoolAddress);
  await vault.deploymentTransaction()?.wait(3);
  const vaultAddress = await vault.getAddress();
  console.log("  Vault:           ", vaultAddress);

  // 4. Integrator
  console.log("Deploying TradeStarsCheckoutIntegrator…");
  const Integrator = await ethers.getContractFactory("TradeStarsCheckoutIntegrator");
  const integrator = await Integrator.deploy(
    DIAMOND_ADDRESS,
    USDC_ADDRESS,
    BigInt(BASE_TX_LIMIT),
    BigInt(DAILY_TX_COUNT_LIMIT)
  );
  await integrator.deploymentTransaction()?.wait(3);
  const integratorAddress = await integrator.getAddress();
  const proxyImpl = await integrator.proxyImpl();
  console.log("  Integrator:      ", integratorAddress);
  console.log("  proxyImpl:       ", proxyImpl);

  // 5. Wire vault ↔ integrator
  console.log("Wiring vault ↔ integrator…");
  await (await vault.setOfframpOperator(integratorAddress)).wait(1);
  await (await integrator.setYieldVault(vaultAddress)).wait(1);
  await (await integrator.setOfframpEnabled(true)).wait(1);
  await (await integrator.setOfframpRelayer(relayer)).wait(1);
  await (await integrator.setMaxUsdcPerOfframp(BigInt(MAX_USDC_PER_OFFRAMP))).wait(1);

  // Summary
  console.log("");
  console.log("=== Deployment Summary ===");
  console.log(`Integrator:                  ${integratorAddress}`);
  console.log(`proxyImpl:                   ${proxyImpl}`);
  console.log(`RestrictedYieldVault:        ${vaultAddress}`);
  console.log(`Aave pool:                   ${aavePoolAddress}`);
  console.log(`aUSDC:                       ${aUsdcAddress}`);
  console.log(`Offramp relayer:             ${relayer}`);
  console.log(`MaxUsdcPerOfframp:           ${ethers.formatUnits(MAX_USDC_PER_OFFRAMP, 6)} USDC`);

  console.log("");
  console.log("Next steps:");
  console.log(
    "  1. Verify on Etherscan / Sourcify so reviewers can diff source against the merged commit."
  );
  console.log(
    "  2. Top up the vault so the offramp pool has liquidity (deposit USDC, or let buys fund it organically)."
  );
  console.log(
    "  3. File a Whitelist request issue (see docs/WHITELISTING.md). The P2P team will call:"
  );
  console.log(`       registerIntegrator(integrator = ${integratorAddress},`);
  console.log(`                          proxyImpl  = ${proxyImpl},`);
  console.log(`                          source     = bytes32("tradestars"))`);
  console.log("     on the Diamond once verification passes.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
