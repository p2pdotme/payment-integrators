import { ethers } from "hardhat";

/**
 * Deploy InvestablChallengeCheckoutIntegrator.
 *
 *   - tierCap[LIVENESS]: per-tx USDC cap for the liveness tier (default 20 USDC,
 *                        P2P's agreed liveness ceiling; the $15 challenge fits)
 *   - dailyTxCountLimit: max challenge orders per user per day (default 10)
 *   - livenessAttestor:  simple-kyc signer. Until this is set, every user is
 *                        TIER_NONE with a per-tx limit of 0 and NO order can be
 *                        placed — the contract fails closed.
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x... LIVENESS_ATTESTOR=0x... \
 *     npx hardhat run scripts/deploy-investabl-challenge.ts --network baseSepolia
 *
 * Optional:
 *   LIVENESS_TIER_CAP=20000000   (6 decimals, default 20 USDC)
 *   DAILY_TX_COUNT_LIMIT=10      (default 10)
 */

const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "";
const LIVENESS_TIER_CAP = process.env.LIVENESS_TIER_CAP || "20000000";
const LIVENESS_ATTESTOR = process.env.LIVENESS_ATTESTOR || "";
const DAILY_TX_COUNT_LIMIT = process.env.DAILY_TX_COUNT_LIMIT || "10";

async function main() {
  if (!DIAMOND_ADDRESS || !USDC_ADDRESS) {
    throw new Error("DIAMOND_ADDRESS and USDC_ADDRESS env vars required");
  }

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", await deployer.getAddress());
  console.log("Diamond:", DIAMOND_ADDRESS);
  console.log("USDC:", USDC_ADDRESS);
  console.log("Liveness tier cap:", ethers.formatUnits(LIVENESS_TIER_CAP, 6), "USDC per tx");
  console.log("Liveness attestor:", LIVENESS_ATTESTOR || "(unset — no order can be placed until set)");
  console.log("Daily TX Count Limit:", DAILY_TX_COUNT_LIMIT, "orders per day");
  console.log("");

  console.log("Deploying InvestablChallengeCheckoutIntegrator...");
  const Integrator = await ethers.getContractFactory("InvestablChallengeCheckoutIntegrator");
  const integrator = await Integrator.deploy(
    DIAMOND_ADDRESS,
    USDC_ADDRESS,
    BigInt(LIVENESS_TIER_CAP),
    BigInt(DAILY_TX_COUNT_LIMIT),
    LIVENESS_ATTESTOR || ethers.ZeroAddress
  );
  const deployTx = integrator.deploymentTransaction();
  await deployTx?.wait(5);

  const address = await integrator.getAddress();
  console.log(`InvestablChallengeCheckoutIntegrator deployed to: ${address}`);

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
  console.log(`Treasury:            ${await integrator.treasury()}`);
  console.log(
    `Liveness tier cap:   ${ethers.formatUnits(await integrator.tierCap(1), 6)} USDC`
  );
  console.log(`Liveness attestor:   ${await integrator.livenessAttestor()}`);
  console.log(`Daily TX Count:      ${(await integrator.dailyTxCountLimit()).toString()} per day`);
  console.log("");
  console.log("Verify command:");
  console.log(
    `  npx hardhat verify --network <network> ${address} \\\n` +
      `    ${DIAMOND_ADDRESS} ${USDC_ADDRESS} ${LIVENESS_TIER_CAP} ${DAILY_TX_COUNT_LIMIT} ${LIVENESS_ATTESTOR || ethers.ZeroAddress}`
  );
  console.log("");
  console.log("Next steps:");
  console.log("  1. Verify on Basescan / Sourcify (reviewers diff source vs the merged commit).");
  console.log("  2. File a Whitelist request issue (docs/WHITELISTING.md). The P2P team calls:");
  console.log(`       registerIntegrator(integrator = ${address},`);
  console.log(`                          usdcThroughIntegrator = false,`);
  console.log(`                          proxyImpl  = ${proxyImpl})`);
  console.log(
    "  3. Optionally setTreasury(<Base treasury>) if proceeds should not accrue to owner."
  );
  console.log("  4. setLivenessAttestor(<simple-kyc signer>) if it was not set at deploy —");
  console.log("     until then effectiveLimit() is 0 for everyone and buyChallenge reverts.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
