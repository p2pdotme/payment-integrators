import { ethers } from "hardhat";

/**
 * Deploy + whitelist the Blackstripe integrator on Base Sepolia:
 *   BlackstripeCheckoutIntegrator
 *   → register on the Diamond (usdcThroughIntegrator = FALSE):
 *       • onramp completion routes the purchased USDC straight to the user's
 *         own EOA (recipientAddr = user);
 *       • the offramp SELL pulls USDC from order.user (the system proxy),
 *         funded just-in-time from the seller's wallet — never routed back
 *         through the integrator.
 *
 * No liveness, no KYC, no sell-back pool: a deliberately minimal onramp +
 * user-wallet offramp for an integrator to test against.
 *
 * Signer = deployer = Diamond super-admin (contracts-v4 MNEMONIC_KEY).
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x... \
 *   [BASE_TX_LIMIT=50000000] [DAILY_TX_COUNT_LIMIT=10] \
 *   npx hardhat run scripts/local/deploy-blackstripe.ts --network baseSepolia
 */

const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "";
// Per-tx onramp USDC cap. Default 50 USDC. 0 disables the per-tx limit.
const BASE_TX_LIMIT = process.env.BASE_TX_LIMIT || "50000000"; // 50 USDC
// Max onramp BUYs per user per day. 0 disables the daily count limit.
const DAILY_TX_COUNT_LIMIT = process.env.DAILY_TX_COUNT_LIMIT || "10";

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
  console.log(`baseTxLimit: ${f(BigInt(BASE_TX_LIMIT))} USDC   dailyTxCountLimit: ${DAILY_TX_COUNT_LIMIT}`);

  // 1. Integrator.
  console.log("\nDeploying BlackstripeCheckoutIntegrator…");
  const Integ = await ethers.getContractFactory("BlackstripeCheckoutIntegrator");
  const integrator = await Integ.deploy(
    DIAMOND_ADDRESS,
    USDC_ADDRESS,
    BigInt(BASE_TX_LIMIT),
    BigInt(DAILY_TX_COUNT_LIMIT)
  );
  await integrator.deploymentTransaction()?.wait(2);
  const integratorAddr = await integrator.getAddress();
  const proxyImpl = await integrator.proxyImpl();
  const systemProxy = await integrator.systemProxy();
  console.log("  BlackstripeCheckoutIntegrator:", integratorAddr);
  console.log("  proxyImpl:                    ", proxyImpl);
  console.log("  systemProxy:                  ", systemProxy);

  // 2. Register on the Diamond — usdcThroughIntegrator = FALSE.
  console.log("\nRegistering integrator on the Diamond (usdcThroughIntegrator=false)…");
  const b2b = new ethers.Contract(DIAMOND_ADDRESS, REGISTER_ABI, deployer);
  await (await b2b.registerIntegrator(integratorAddr, false, proxyImpl)).wait(1);

  const cfg = await b2b.getIntegratorConfig(integratorAddr);
  console.log("\n=== Blackstripe deployment ===");
  console.log(`BlackstripeCheckoutIntegrator: ${integratorAddr}`);
  console.log(`proxyImpl:                     ${proxyImpl}`);
  console.log(
    `integrator config:             isActive=${cfg.isActive} usdcThroughIntegrator=${cfg.usdcThroughIntegrator} proxyImpl=${cfg.proxyImpl}`
  );
  console.log("\n--- integrator app env ---");
  console.log(`BLACKSTRIPE_INTEGRATOR_ADDRESS=${integratorAddr}`);
  console.log(`DIAMOND_ADDRESS=${DIAMOND_ADDRESS}`);
  console.log(`USDC_ADDRESS=${USDC_ADDRESS}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
