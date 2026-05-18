import { ethers } from "hardhat";

/**
 * Finish the B2B-sell migration: register the freshly deployed integrators on
 * the Diamond's B2BGatewayFacet and deactivate the old ones. Uses a minimal
 * ABI so this repo doesn't need the B2BGatewayFacet artifact.
 */

const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS!;
const NEW_TRADESTARS = process.env.NEW_TRADESTARS!;
const NEW_MARKETPLACE = process.env.NEW_MARKETPLACE!;
const OLD_TRADESTARS = process.env.OLD_TRADESTARS!;
const OLD_MARKETPLACE = process.env.OLD_MARKETPLACE!;

const ABI = [
  "function registerIntegrator(address integrator, bool usdcThroughIntegrator) external",
  "function deactivateIntegrator(address integrator) external",
  "function isActiveIntegrator(address integrator) external view returns (bool)",
];

async function main() {
  for (const [k, v] of Object.entries({
    DIAMOND_ADDRESS,
    NEW_TRADESTARS,
    NEW_MARKETPLACE,
    OLD_TRADESTARS,
    OLD_MARKETPLACE,
  }))
    if (!v) throw new Error(`${k} env var required`);

  const [signer] = await ethers.getSigners();
  console.log("Signer: ", await signer.getAddress());
  console.log("Diamond:", DIAMOND_ADDRESS);
  console.log("");

  const b2b = new ethers.Contract(DIAMOND_ADDRESS, ABI, signer);

  console.log("Registering new TradeStars…");
  await (await b2b.registerIntegrator(NEW_TRADESTARS, true)).wait(1);
  console.log(" ", NEW_TRADESTARS, "active:", await b2b.isActiveIntegrator(NEW_TRADESTARS));

  console.log("Registering new Marketplace…");
  await (await b2b.registerIntegrator(NEW_MARKETPLACE, true)).wait(1);
  console.log(" ", NEW_MARKETPLACE, "active:", await b2b.isActiveIntegrator(NEW_MARKETPLACE));

  console.log("\nDeactivating old TradeStars…");
  await (await b2b.deactivateIntegrator(OLD_TRADESTARS)).wait(1);
  console.log(" ", OLD_TRADESTARS, "active:", await b2b.isActiveIntegrator(OLD_TRADESTARS));

  console.log("Deactivating old Marketplace…");
  await (await b2b.deactivateIntegrator(OLD_MARKETPLACE)).wait(1);
  console.log(" ", OLD_MARKETPLACE, "active:", await b2b.isActiveIntegrator(OLD_MARKETPLACE));

  console.log("\nDone.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
