import { ethers } from "hardhat";

/**
 * Deploy CubeSkinsIntegrator on Base Sepolia or Base mainnet.
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x... TREASURY_ADDRESS=0x... \
 *   INTEGRATOR_OWNER=0x... \
 *   npx hardhat run scripts/deploy-cubeskins.ts --network baseSepolia
 *
 * INTEGRATOR_OWNER is the CubeSkins backend relayer — the only key that can call
 * `registerOrder`. It is set explicitly rather than defaulting to the deployer so
 * P2P can deploy on CubeSkins' behalf for testnet without holding the admin key.
 * It is immutable and cannot be transferred or renounced.
 *
 * LIVENESS_ATTESTOR is fetched from the running liveness service by default
 * rather than accepted as an argument. A partner- or teammate-relayed signer
 * address has been wrong twice (Investabl and CubeSkins both shipped
 * 0x9FEd11b8… while the live signer was 0x6cC780…), and the failure is silent:
 * nothing breaks at deploy, every `submitLivenessAttestation` just reverts
 * InvalidSignature afterwards. Override with LIVENESS_ATTESTOR only if you have
 * a reason to, and the script will warn when it disagrees with the service.
 *
 * Caps default to the approved CubeSkins policy and are bounded by immutable
 * ceilings in the contract — the constructor reverts CapExceedsCeiling above
 * MAX_LIVENESS_TIER_CAP (200 USDC) or MAX_DAILY_TX_COUNT_LIMIT (5), and above 0
 * daily count.
 */

const LIVENESS_ATTESTOR_URL =
  process.env.LIVENESS_ATTESTOR_URL || "https://liveness-api.p2p.cool/v1/attestor";

const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "";
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS || "";
const INTEGRATOR_OWNER = process.env.INTEGRATOR_OWNER || "";
const LIVENESS_TIER_CAP = process.env.LIVENESS_TIER_CAP || "200000000"; // 200 USDC — approved
const DAILY_TX_COUNT_LIMIT = process.env.DAILY_TX_COUNT_LIMIT || "5";

async function liveAttestor(): Promise<string | null> {
  try {
    const res = await fetch(LIVENESS_ATTESTOR_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { address?: string };
    return body.address ? ethers.getAddress(body.address) : null;
  } catch {
    return null;
  }
}

async function resolveAttestor(): Promise<string> {
  const fromService = await liveAttestor();
  const override = process.env.LIVENESS_ATTESTOR;

  if (!override) {
    if (!fromService) {
      throw new Error(
        `Could not reach ${LIVENESS_ATTESTOR_URL} to resolve the liveness attestor. ` +
          `Set LIVENESS_ATTESTOR explicitly only if you have verified it against the service.`
      );
    }
    console.log(`Liveness attestor (from ${LIVENESS_ATTESTOR_URL}):`, fromService);
    return fromService;
  }

  const normalized = ethers.getAddress(override);
  if (fromService && fromService !== normalized) {
    console.warn(
      `\n!! LIVENESS_ATTESTOR mismatch\n` +
        `   override: ${normalized}\n` +
        `   service:  ${fromService}\n` +
        `   Deploying the override. Every submitLivenessAttestation will revert\n` +
        `   InvalidSignature unless the service signs with the override key.\n`
    );
  }
  return normalized;
}

async function main() {
  if (!DIAMOND_ADDRESS || !USDC_ADDRESS || !TREASURY_ADDRESS || !INTEGRATOR_OWNER) {
    throw new Error(
      "DIAMOND_ADDRESS, USDC_ADDRESS, TREASURY_ADDRESS and INTEGRATOR_OWNER are required"
    );
  }

  const attestor = await resolveAttestor();

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", await deployer.getAddress());
  console.log("Diamond:", DIAMOND_ADDRESS);
  console.log("USDC:", USDC_ADDRESS);
  console.log("Treasury:", TREASURY_ADDRESS);
  console.log("Owner (relayer):", INTEGRATOR_OWNER);

  const Integrator = await ethers.getContractFactory("CubeSkinsIntegrator");
  const integrator = await Integrator.deploy(
    DIAMOND_ADDRESS,
    USDC_ADDRESS,
    TREASURY_ADDRESS,
    INTEGRATOR_OWNER,
    BigInt(LIVENESS_TIER_CAP),
    BigInt(DAILY_TX_COUNT_LIMIT),
    attestor
  );
  await integrator.deploymentTransaction()?.wait(2);

  const address = await integrator.getAddress();

  // Read every constructor-set value back from chain rather than echoing the
  // inputs — a deploy that silently bound the wrong Diamond/USDC/attestor looks
  // identical in the logs otherwise.
  const [proxyImpl, onChainAttestor, cap, daily, maxCap, maxDaily, ownerAddr, treasuryAddr] =
    await Promise.all([
      integrator.proxyImpl(),
      integrator.livenessAttestor(),
      integrator.livenessTierCap(),
      integrator.dailyTxCountLimit(),
      integrator.MAX_LIVENESS_TIER_CAP(),
      integrator.MAX_DAILY_TX_COUNT_LIMIT(),
      integrator.owner(),
      integrator.treasury(),
    ]);

  console.log("\n=== CubeSkins deployment ===");
  console.log(`CubeSkinsIntegrator:  ${address}`);
  console.log(`proxyImpl:            ${proxyImpl}`);
  console.log(`owner:                ${ownerAddr}`);
  console.log(`treasury:             ${treasuryAddr}`);
  console.log(`livenessAttestor:     ${onChainAttestor}`);
  console.log(`livenessTierCap:      ${cap} (ceiling ${maxCap})`);
  console.log(`dailyTxCountLimit:    ${daily} (ceiling ${maxDaily})`);

  const problems: string[] = [];
  if (ethers.getAddress(onChainAttestor) !== attestor) problems.push("attestor mismatch");
  if (ethers.getAddress(ownerAddr) !== ethers.getAddress(INTEGRATOR_OWNER))
    problems.push("owner mismatch");
  if (ethers.getAddress(treasuryAddr) !== ethers.getAddress(TREASURY_ADDRESS))
    problems.push("treasury mismatch");
  if (problems.length) throw new Error(`Post-deploy readback failed: ${problems.join(", ")}`);

  console.log("\nVerify:");
  console.log(
    `npx hardhat verify --network <network> ${address} ${DIAMOND_ADDRESS} ${USDC_ADDRESS} ${TREASURY_ADDRESS} ${INTEGRATOR_OWNER} ${LIVENESS_TIER_CAP} ${DAILY_TX_COUNT_LIMIT} ${attestor}`
  );
  console.log(
    "\nNext, in order:" +
      "\n  1. Whitelist with usdcThroughIntegrator=FALSE (matches every other integrator)." +
      `\n  2. Point the liveness tenant's contract_address at ${address} and set its` +
      "\n     limit_usdc to 200 — including existing liveness_identities rows, which" +
      "\n     snapshot the limit at enrollment and will otherwise keep signing $20." +
      "\n  3. Run one real end-to-end order through to onOrderComplete before mainnet."
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
