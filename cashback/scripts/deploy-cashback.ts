import { ethers } from "hardhat";

/**
 * Deploy CashbackRegistry.
 *
 * Multi-tenant: each integrator has an owner who runs cashback for it,
 * funded from their own wallet. The deployer is the first registry admin —
 * assigning integrator owners and managing watchers, but never able to
 * create a campaign or spend anyone's tokens.
 *
 * Required env:
 *   DIAMOND_ADDRESS   the P2P Diamond — every reported order is verified against it
 *
 * Optional env:
 *   WATCHER_ADDRESS   allowlisted immediately as an accruer (otherwise call
 *                     setAccruer later)
 *
 * After deploying:
 *   1. registry.setAccruer(<watcher>, true)              (if not passed above)
 *   2. registry.setIntegratorOwner(<integrator>, <owner>)
 *      One call per integrator. That owner is then fully self-service.
 *   3. The OWNER approves the registry for their reward token, creates a
 *      campaign, and activates it — no admin involvement.
 *
 * Base Sepolia reference:
 *   Diamond: 0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9
 *   USDC:    0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d
 */

const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "";
const WATCHER_ADDRESS = process.env.WATCHER_ADDRESS || "";

async function main() {
  if (!DIAMOND_ADDRESS) {
    throw new Error("DIAMOND_ADDRESS env var is required");
  }

  const [deployer] = await ethers.getSigners();

  console.log("Deployer:", await deployer.getAddress(), "(first registry admin)");
  console.log("Diamond: ", DIAMOND_ADDRESS);
  console.log("");

  const Registry = await ethers.getContractFactory("CashbackRegistry");
  const registry = await Registry.deploy(DIAMOND_ADDRESS);
  await registry.waitForDeployment();

  const address = await registry.getAddress();

  console.log("─── Deployed ────────────────────────────────────────────");
  console.log("CashbackRegistry:", address);
  console.log("MAX_BPS ceiling: ", (await registry.MAX_BPS()).toString(), "(immutable)");
  console.log("─────────────────────────────────────────────────────────");
  console.log("");

  if (WATCHER_ADDRESS) {
    const tx = await registry.setAccruer(WATCHER_ADDRESS, true);
    await tx.wait();
    console.log("Allowlisted watcher:", WATCHER_ADDRESS);
    console.log("");
  }

  console.log("Next steps:");
  if (!WATCHER_ADDRESS) {
    console.log(`  1. registry.setAccruer(<watcherAddress>, true)`);
  }
  console.log(`  2. registry.setIntegratorOwner(<integrator>, <ownerAddress>)`);
  console.log(`     One call per integrator — then that owner is self-service.`);
  console.log("");
  console.log("  The owner then, from their own wallet:");
  console.log(`     token.approve(${address}, <allowance>)   ← also their kill switch`);
  console.log(`     npx hardhat run scripts/create-campaign.ts --network <net>`);
  console.log(`     registry.activate(<campaignId>)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
