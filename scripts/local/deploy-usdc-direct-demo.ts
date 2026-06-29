import { ethers } from "hardhat";

/**
 * Deploy + wire the USDC-direct onramp demo on Base Sepolia:
 *   UsdcDirectCheckoutIntegrator
 *   → register on the Diamond (usdcThroughIntegrator = FALSE; with
 *     recipientAddr = the user's EOA, completion routes the purchased USDC
 *     straight to the user's wallet)
 *   → set the simple-kyc attestor signers (liveness + KYC services)
 *   → optional owner ceilings (per-tx cap, daily volume cap).
 *
 * Unlike the marketplace demo this integrator delivers spendable USDC to the
 * end-user, so there is NO sell-back pool to seed — USDC liquidity comes from
 * the merchant via the Diamond at completion.
 *
 * To let the demo sign attestations locally (no hosted KYC wizard needed),
 * point LIVENESS_ATTESTOR + KYC_ATTESTOR at a demo signer address you control
 * and sign EIP-712 KycAttestation / LivenessAttestation structs with that key
 * (domain { name: "KycVerifier"|"LivenessVerifier", version: "1", chainId,
 * verifyingContract: <integrator> }). For the real flow, set them to the
 * simple-kyc services' GET /v1/attestor addresses and register this
 * integrator's address as the tenant contract_address in both services.
 *
 * Signer = deployer = Diamond super-admin (contracts-v4 MNEMONIC_KEY).
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x... \
 *   LIVENESS_ATTESTOR=0x... KYC_ATTESTOR=0x... \
 *   [DAILY_TX_COUNT_LIMIT=10] [PER_TX_USDC_CAP=100000000] \
 *   [DAILY_USDC_VOLUME_CAP=0] \
 *   npx hardhat run scripts/local/deploy-usdc-direct-demo.ts --network baseSepolia
 */

const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "";
const DAILY_TX_COUNT_LIMIT = process.env.DAILY_TX_COUNT_LIMIT || "10";
// Default owner ceiling = 100 USDC (the KYC tier limit) so a misbehaving
// attestor can't authorize an unbounded per-tx amount. 0 disables the ceiling.
const PER_TX_USDC_CAP = process.env.PER_TX_USDC_CAP || "100000000"; // 100 USDC
const DAILY_USDC_VOLUME_CAP = process.env.DAILY_USDC_VOLUME_CAP || "0"; // 0 = disabled
// simple-kyc service signers (GET /v1/attestor). The live KYC signer is
// 0xA0bE015133e4dc63c96EBFB6729D34050Ef33Eda; the liveness service has its own.
const LIVENESS_ATTESTOR = process.env.LIVENESS_ATTESTOR || "";
const KYC_ATTESTOR = process.env.KYC_ATTESTOR || "";

const REGISTER_ABI = [
  "function registerIntegrator(address integrator, bool usdcThroughIntegrator, address proxyImpl)",
  "function getIntegratorConfig(address) view returns (tuple(bool isActive, bool usdcThroughIntegrator, uint256 activeOrderCount, address proxyImpl))",
];

const f = (n: bigint) => ethers.formatUnits(n, 6);

async function main() {
  if (!DIAMOND_ADDRESS || !USDC_ADDRESS) throw new Error("DIAMOND_ADDRESS + USDC_ADDRESS required");
  if (!LIVENESS_ATTESTOR || !KYC_ATTESTOR)
    throw new Error(
      "LIVENESS_ATTESTOR + KYC_ATTESTOR required (simple-kyc service signers / demo key)"
    );

  const [deployer] = await ethers.getSigners();
  const me = await deployer.getAddress();
  console.log("Deployer / super-admin:", me);
  console.log("Diamond:", DIAMOND_ADDRESS, " USDC:", USDC_ADDRESS);
  console.log("Liveness attestor:", LIVENESS_ATTESTOR);
  console.log("KYC attestor:     ", KYC_ATTESTOR);

  // 1. Integrator.
  console.log("\nDeploying UsdcDirectCheckoutIntegrator…");
  const Integ = await ethers.getContractFactory("UsdcDirectCheckoutIntegrator");
  const integrator = await Integ.deploy(
    DIAMOND_ADDRESS,
    USDC_ADDRESS,
    BigInt(DAILY_TX_COUNT_LIMIT),
    LIVENESS_ATTESTOR,
    KYC_ATTESTOR
  );
  await integrator.deploymentTransaction()?.wait(2);
  const integratorAddr = await integrator.getAddress();
  const proxyImpl = await integrator.proxyImpl();
  console.log("  UsdcDirectCheckoutIntegrator:", integratorAddr, " proxyImpl:", proxyImpl);

  // 2. Register on the Diamond — usdcThroughIntegrator = FALSE (USDC → recipient
  //    = user EOA on completion).
  console.log("\nRegistering integrator on the Diamond (usdcThroughIntegrator=false)…");
  const b2b = new ethers.Contract(DIAMOND_ADDRESS, REGISTER_ABI, deployer);
  await (await b2b.registerIntegrator(integratorAddr, false, proxyImpl)).wait(1);

  // 3. Optional owner ceilings.
  if (BigInt(PER_TX_USDC_CAP) > 0n) {
    await (await integrator.setPerTxUsdcCap(BigInt(PER_TX_USDC_CAP))).wait(1);
    console.log(`  perTxUsdcCap: ${f(BigInt(PER_TX_USDC_CAP))} USDC`);
  }
  if (BigInt(DAILY_USDC_VOLUME_CAP) > 0n) {
    await (await integrator.setDailyUsdcVolumeCap(BigInt(DAILY_USDC_VOLUME_CAP))).wait(1);
    console.log(`  dailyUsdcVolumeCap: ${f(BigInt(DAILY_USDC_VOLUME_CAP))} USDC`);
  }

  const cfg = await b2b.getIntegratorConfig(integratorAddr);
  console.log("\n=== USDC-direct demo deployment ===");
  console.log(`UsdcDirectCheckoutIntegrator: ${integratorAddr}`);
  console.log(`proxyImpl:                    ${proxyImpl}`);
  console.log(
    `integrator config:            isActive=${cfg.isActive} usdcThroughIntegrator=${cfg.usdcThroughIntegrator}`
  );
  console.log("\n--- demo app .env ---");
  console.log(`VITE_USDC_DIRECT_INTEGRATOR_ADDRESS=${integratorAddr}`);
  console.log(`VITE_DIAMOND_ADDRESS=${DIAMOND_ADDRESS}`);
  console.log(`VITE_USDC_ADDRESS=${USDC_ADDRESS}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
