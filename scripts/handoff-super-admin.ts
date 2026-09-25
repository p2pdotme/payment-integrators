import { ethers } from "hardhat";
import { checkMultisig, handoffStatus, printSafeBatch, proposeHandoff } from "./lib/superAdmin";

/**
 * Hand the integrator's super-admin to a multisig, or check that it is done.
 * (deploy-link-router.ts already runs the "propose" step when
 * SUPER_ADMIN_MULTISIG is set; use this to re-propose after the 7-day window
 * lapses, or to confirm the handoff finished.)
 *
 * Usage:
 *   INTEGRATOR=0x… SUPER_ADMIN_MULTISIG=0x… \
 *     npx hardhat run scripts/handoff-super-admin.ts --network base
 *
 *   ACTION=status  — read-only: is the multisig root, and has the deployer key
 *                    lost its owner access? Exits 1 if not finished.
 *   ALLOW_SINGLE_SIGNER=1 — testnet only: accept a 1-of-N Safe for a rehearsal.
 *   DEPLOYER=0x…   — for ACTION=status run from another key: the key whose
 *                    access should be gone (defaults to the signer).
 */
async function main() {
  const INTEGRATOR = process.env.INTEGRATOR || "";
  const MULTISIG = process.env.SUPER_ADMIN_MULTISIG || "";
  const ACTION = (process.env.ACTION || "propose").toLowerCase();
  if (!ethers.isAddress(INTEGRATOR)) throw new Error("Set INTEGRATOR to the integrator address.");
  if (!ethers.isAddress(MULTISIG))
    throw new Error("Set SUPER_ADMIN_MULTISIG to the multisig address.");

  const [signer] = await ethers.getSigners();
  const deployer = process.env.DEPLOYER || signer.address;
  const { chainId } = await ethers.provider.getNetwork();
  const integrator: any = await ethers.getContractAt("MerchantTerminalIntegrator", INTEGRATOR);

  const ms = await checkMultisig(ethers.provider, MULTISIG, {
    chainId,
    allowSingleSigner: !!process.env.ALLOW_SINGLE_SIGNER,
    deployer,
  });
  console.log(`multisig   : ${ms.address} (${ms.threshold}-of-${ms.owners.length})`);
  console.log(`integrator : ${INTEGRATOR}`);

  if (ACTION === "status") {
    const s = await handoffStatus(integrator, ethers.provider, ms.address, deployer);
    console.log(
      `superAdmin            : ${s.superAdmin}${s.superAdminIsContract ? " (contract)" : " (EOA!)"}`
    );
    console.log(`pendingSuperAdmin     : ${s.pending}`);
    console.log(`deployer still owner  : ${s.deployerStillOwner}`);
    console.log(
      s.done ? "\nDONE — the multisig is root and the deployer key holds no access." : "\nNOT DONE."
    );
    if (!s.done) {
      if (s.superAdmin !== ms.address) printSafeBatch(INTEGRATOR, deployer, ms.address);
      process.exitCode = 1;
    }
    return;
  }

  if (ACTION !== "propose")
    throw new Error(`ACTION must be "propose" or "status", not "${ACTION}"`);
  if ((await integrator.superAdmin()).toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`Signer ${signer.address} is not the super-admin; only it can propose.`);
  }
  if ((await integrator.trustedRelayer()) === ethers.ZeroAddress) {
    console.log(
      "WARNING: trustedRelayer is not set yet. After the handoff only the multisig can set it."
    );
  }
  await proposeHandoff(integrator, ms.address);
  printSafeBatch(INTEGRATOR, deployer, ms.address);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
