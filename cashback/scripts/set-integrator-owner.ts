import { ethers } from "hardhat";

/**
 * Assign the cashback owner of an integrator.
 *
 * This is the ONE setup step a registry admin performs per integrator.
 * Afterwards that owner is fully self-service: they create, activate, pause,
 * retune and end campaigns for that integrator, funded from their own wallet,
 * with no further admin involvement.
 *
 * Ownership is registered rather than read from the integrator contract
 * because integrators do not share an ownership interface — some expose
 * `owner()`, others are multi-owner with `isOwner()` and a super-admin. A
 * registered mapping works uniformly and cannot be spoofed.
 *
 * Re-running this transfers ownership: control of existing campaigns follows
 * the new owner, because the permission check reads this mapping live.
 *
 * Required env:
 *   REGISTRY_ADDRESS   deployed CashbackRegistry
 *   INTEGRATOR         integrator address
 *   OWNER              address that will run cashback for it
 *
 * Example:
 *   REGISTRY_ADDRESS=0x… \
 *   INTEGRATOR=0x4aBDf0726cd1B03F43b3d054063b569dFD7772A0 \
 *   OWNER=0x… \
 *   npx hardhat run scripts/set-integrator-owner.ts --network baseSepolia
 */

const REGISTRY_ADDRESS = process.env.REGISTRY_ADDRESS || "";
const INTEGRATOR = process.env.INTEGRATOR || "";
const OWNER = process.env.OWNER || "";

async function main() {
  if (!REGISTRY_ADDRESS || !INTEGRATOR || !OWNER) {
    throw new Error("REGISTRY_ADDRESS, INTEGRATOR and OWNER env vars are required");
  }

  const registry = await ethers.getContractAt("CashbackRegistry", REGISTRY_ADDRESS);
  const previous = await registry.integratorOwner(INTEGRATOR);

  console.log("Integrator:", INTEGRATOR);
  console.log("Previous:  ", previous === ethers.ZeroAddress ? "(unclaimed)" : previous);
  console.log("New owner: ", OWNER);
  console.log("");

  const tx = await registry.setIntegratorOwner(INTEGRATOR, OWNER);
  await tx.wait();

  console.log("Done.", OWNER, "now runs cashback for this integrator.");
  console.log("");
  console.log("They can now, from their own wallet:");
  console.log(`  1. token.approve(${REGISTRY_ADDRESS}, <allowance>)`);
  console.log("  2. npx hardhat run scripts/create-campaign.ts --network <net>");
  console.log("  3. registry.activate(<campaignId>)");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
