import { ethers } from "hardhat";
import { applyRoles, logsProviderFor, planRoles } from "./lib/copyRoles";

/**
 * Copy every admin role and owner from previous integrators onto a new one
 * (deploy-merchant-terminal.ts already does this; run this to re-run or catch
 * up). Must run from the NEW integrator's super-admin — i.e. BEFORE the
 * super-admin is handed to the multisig. Idempotent.
 *
 * Usage:
 *   INTEGRATOR=0x… PREVIOUS_INTEGRATORS=0xnewest,…,0xoldest \
 *     npx hardhat run scripts/copy-roles.ts --network baseSepolia
 *
 *   DRY_RUN=1          print the plan, send nothing
 *   LOG_CHUNK=1000     getLogs block range per request (auto-splits if refused)
 *   LOGS_RPC=https://… RPC for the log scan (default: the chain's public RPC —
 *                      free-tier keys cap eth_getLogs at 10 blocks)
 */
async function main() {
  const INTEGRATOR = process.env.INTEGRATOR || "";
  const PREVIOUS = (process.env.PREVIOUS_INTEGRATORS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ethers.isAddress(INTEGRATOR))
    throw new Error("Set INTEGRATOR to the new integrator address.");
  if (!PREVIOUS.length) throw new Error("Set PREVIOUS_INTEGRATORS (newest first).");
  for (const p of PREVIOUS) if (!ethers.isAddress(p)) throw new Error(`Not an address: ${p}`);

  const [signer] = await ethers.getSigners();
  const integrator: any = await ethers.getContractAt("MerchantTerminalIntegrator", INTEGRATOR);
  const superAdmin = await integrator.superAdmin();
  if (!process.env.DRY_RUN && superAdmin.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `Signer ${signer.address} is not the super-admin (${superAdmin}). If the multisig already ` +
        `holds root, run with DRY_RUN=1 and submit the printed calls from the multisig.`
    );
  }

  console.log("Reading roles from previous integrators…");
  const { chainId } = await ethers.provider.getNetwork();
  const plan = await planRoles(
    ethers.provider,
    PREVIOUS,
    superAdmin,
    Number(process.env.LOG_CHUNK || 1000),
    console.log,
    logsProviderFor(chainId, ethers.provider)
  );
  console.log(`\n${plan.length} address(es) to carry over:`);
  for (const p of plan)
    console.log(`  ${p.address}  ${p.owner ? "OWNER" : `role ${p.role}`}  (from ${p.from})`);
  if (process.env.DRY_RUN) return;
  await applyRoles(integrator, plan, console.log);
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
