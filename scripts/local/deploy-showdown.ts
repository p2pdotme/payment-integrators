import { ethers } from "hardhat";

/**
 * Deploy + whitelist ShowdownCheckoutIntegrator: a two-way fiat <-> USDC ramp
 * whose user-facing asset lives on Solana, bridged with Circle CCTP V2.
 *
 *   ShowdownCheckoutIntegrator
 *   → register on the Diamond (usdcThroughIntegrator = FALSE; the onramp pins
 *     recipientAddr = the integrator itself, so completion routes the purchased
 *     USDC here for burning without needing the flag)
 *   → set the simple-kyc attestor signers (liveness + KYC services)
 *
 * Tiers are enforced on-chain: liveness = $20/tx, passport+liveness = $50/tx.
 * The contract clamps whatever limit the simple-kyc service signs down to these
 * ceilings, so the tiers hold even if an attestor key is compromised.
 *
 * ── CCTP / token caveat on Base Sepolia ────────────────────────────────────
 * CCTP burns only Circle-issued USDC. The Base Sepolia Diamond settles in a
 * mock token (GoofyGoober, 0x4095fE…), which Circle's TokenMinter will not burn
 * (`burnLimitsPerMessage == 0`). Deploying against the Diamond therefore gives a
 * live order flow whose bridge leg fails closed: orders complete, the USDC is
 * held and reserved against `unbridgedTotal`, and `retryBridge` /
 * `userRescueStuckBridge` keep it recoverable. On Base mainnet, where the
 * Diamond settles in real USDC, the same code bridges for real.
 *
 * The script reports whether USDC_ADDRESS is CCTP-burnable before deploying.
 *
 * Signer = deployer = Diamond super-admin (contracts-v4 MNEMONIC_KEY).
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x... \
 *   LIVENESS_ATTESTOR=0x... KYC_ATTESTOR=0x... \
 *   [TOKEN_MESSENGER=0x8FE6...] [MESSAGE_TRANSMITTER=0xE737...] \
 *   [SOLANA_DOMAIN=5] [DAILY_TX_COUNT_LIMIT=10] \
 *   [LIVENESS_TX_CAP=20000000] [KYC_TX_CAP=50000000] [SKIP_REGISTER=false] \
 *   npx hardhat run scripts/local/deploy-showdown.ts --network baseSepolia
 */

// CCTP V2 — same addresses across every supported EVM testnet.
const TOKEN_MESSENGER = process.env.TOKEN_MESSENGER || "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";
const MESSAGE_TRANSMITTER =
  process.env.MESSAGE_TRANSMITTER || "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275";

const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "";
const SOLANA_DOMAIN = Number(process.env.SOLANA_DOMAIN || 5);
const DAILY_TX_COUNT_LIMIT = process.env.DAILY_TX_COUNT_LIMIT || "10";
const LIVENESS_TX_CAP = process.env.LIVENESS_TX_CAP || "20000000"; // $20
const KYC_TX_CAP = process.env.KYC_TX_CAP || "50000000"; // $50
const LIVENESS_ATTESTOR = process.env.LIVENESS_ATTESTOR || "";
const KYC_ATTESTOR = process.env.KYC_ATTESTOR || "";
const SKIP_REGISTER = process.env.SKIP_REGISTER === "true";

const REGISTER_ABI = [
  "function registerIntegrator(address integrator, bool usdcThroughIntegrator, address proxyImpl)",
  "function getIntegratorConfig(address) view returns (tuple(bool isActive, bool usdcThroughIntegrator, uint256 activeOrderCount, address proxyImpl))",
];
const MINTER_ABI = ["function burnLimitsPerMessage(address) view returns (uint256)"];
const TM_ABI = ["function localMinter() view returns (address)"];

const f = (n: bigint) => ethers.formatUnits(n, 6);

async function main() {
  if (!DIAMOND_ADDRESS || !USDC_ADDRESS) throw new Error("DIAMOND_ADDRESS + USDC_ADDRESS required");
  if (!LIVENESS_ATTESTOR || !KYC_ATTESTOR)
    throw new Error("LIVENESS_ATTESTOR + KYC_ATTESTOR required (simple-kyc signers / demo key)");

  const [deployer] = await ethers.getSigners();
  const me = await deployer.getAddress();
  console.log("Deployer / super-admin:", me);
  console.log("Diamond:            ", DIAMOND_ADDRESS);
  console.log("USDC (settle+burn):  ", USDC_ADDRESS);
  console.log("TokenMessengerV2:    ", TOKEN_MESSENGER);
  console.log("MessageTransmitterV2:", MESSAGE_TRANSMITTER);
  console.log("Solana domain:       ", SOLANA_DOMAIN);
  console.log(`Tiers: liveness=$${f(BigInt(LIVENESS_TX_CAP))} kyc=$${f(BigInt(KYC_TX_CAP))}`);

  // Report up front whether the settlement token is actually CCTP-burnable —
  // it decides whether the bridge leg can run at all on this network.
  const minter = await new ethers.Contract(TOKEN_MESSENGER, TM_ABI, deployer).localMinter();
  const burnLimit: bigint = await new ethers.Contract(
    minter,
    MINTER_ABI,
    deployer
  ).burnLimitsPerMessage(USDC_ADDRESS);
  if (burnLimit === 0n) {
    console.log(
      `\n⚠️  ${USDC_ADDRESS} is NOT a CCTP-burnable token (burnLimitsPerMessage = 0).\n` +
        `   Order flow + KYC tiers will work; every bridge attempt will fail closed into\n` +
        `   fulfilled-but-unbridged and stay recoverable via retryBridge / userRescueStuckBridge.`
    );
  } else {
    console.log(`\n✅ CCTP burnable, per-tx burn limit: ${f(burnLimit)} USDC`);
  }

  // 1. Integrator.
  console.log("\nDeploying ShowdownCheckoutIntegrator…");
  const Integ = await ethers.getContractFactory("ShowdownCheckoutIntegrator");
  const integrator = await Integ.deploy(
    DIAMOND_ADDRESS,
    USDC_ADDRESS,
    TOKEN_MESSENGER,
    MESSAGE_TRANSMITTER,
    SOLANA_DOMAIN,
    BigInt(DAILY_TX_COUNT_LIMIT),
    LIVENESS_ATTESTOR,
    KYC_ATTESTOR,
    BigInt(LIVENESS_TX_CAP),
    BigInt(KYC_TX_CAP)
  );
  await integrator.deploymentTransaction()?.wait(2);
  const integratorAddr = await integrator.getAddress();
  const proxyImpl = await integrator.proxyImpl();
  console.log("  ShowdownCheckoutIntegrator:", integratorAddr);
  console.log("  proxyImpl:                 ", proxyImpl);

  // 2. Register on the Diamond — usdcThroughIntegrator = FALSE.
  if (!SKIP_REGISTER) {
    console.log("\nRegistering on the Diamond (usdcThroughIntegrator=false)…");
    const b2b = new ethers.Contract(DIAMOND_ADDRESS, REGISTER_ABI, deployer);
    const before = await b2b.getIntegratorConfig(integratorAddr);
    if (
      before.proxyImpl !== ethers.ZeroAddress &&
      before.proxyImpl.toLowerCase() !== proxyImpl.toLowerCase()
    ) {
      throw new Error(`proxyImpl already locked to ${before.proxyImpl}; refusing to re-register`);
    }
    const tx = await b2b.registerIntegrator(integratorAddr, false, proxyImpl);
    await tx.wait(1);
    console.log("  registerIntegrator tx:", tx.hash);

    const cfg = await b2b.getIntegratorConfig(integratorAddr);
    console.log(
      `  config: isActive=${cfg.isActive} usdcThroughIntegrator=${cfg.usdcThroughIntegrator} proxyImpl=${cfg.proxyImpl}`
    );
    if (!cfg.isActive || cfg.usdcThroughIntegrator !== false) {
      throw new Error("unexpected integrator config after registration");
    }
  }

  console.log("\n=== Showdown deployment ===");
  console.log(`ShowdownCheckoutIntegrator: ${integratorAddr}`);
  console.log(`proxyImpl:                  ${proxyImpl}`);
  console.log(
    `bytecode hash:              ${ethers.keccak256(await ethers.provider.getCode(integratorAddr))}`
  );
  console.log("\n--- demo app .env ---");
  console.log(`VITE_SHOWDOWN_INTEGRATOR_ADDRESS=${integratorAddr}`);
  console.log(`VITE_DIAMOND_ADDRESS=${DIAMOND_ADDRESS}`);
  console.log(`VITE_USDC_ADDRESS=${USDC_ADDRESS}`);
  console.log("\n--- verify ---");
  console.log(
    `npx hardhat verify --network baseSepolia ${integratorAddr} ${DIAMOND_ADDRESS} ${USDC_ADDRESS} ${TOKEN_MESSENGER} ${MESSAGE_TRANSMITTER} ${SOLANA_DOMAIN} ${DAILY_TX_COUNT_LIMIT} ${LIVENESS_ATTESTOR} ${KYC_ATTESTOR} ${LIVENESS_TX_CAP} ${KYC_TX_CAP}`
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
