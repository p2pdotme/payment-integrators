/**
 * PROPOSE a SUPER-ADMIN root handoff on the deployed MerchantTerminalIntegrator.
 * This targets the LIVE contract — it does NOT redeploy anything.
 *
 * TWO-STEP handoff (this is the important correction): the current contract uses a
 * PROPOSE + ACCEPT flow, NOT a single-step immediate transfer. This script only
 * PROPOSES `NEW_SUPER_ADMIN` (sets pendingSuperAdmin). Root does NOT move until the
 * NEW address itself calls `acceptSuperAdmin()` from its own key, proving control.
 * That two-step design is exactly what prevents a fat-fingered handoff to an
 * uncontrolled address from bricking governance — a wrong/uncontrolled target can
 * never accept, and you can re-propose or cancel (propose address(0)) meanwhile.
 *
 * For the H-3 hardening, NEW_SUPER_ADMIN should be a MULTISIG. After this script
 * proposes it, complete the handoff from the multisig by calling acceptSuperAdmin().
 *
 * The signer MUST be the CURRENT super-admin, or the tx reverts OnlySuperAdmin.
 * We check this on-chain BEFORE sending and abort on any mismatch.
 *
 * Env (addresses are NOT hardcoded — repo convention forbids it):
 *   INTEGRATOR_ADDRESS   (required) the live integrator to operate on
 *   NEW_SUPER_ADMIN      (required) the address (ideally a multisig) to propose
 *   DEPLOYER_PRIVATE_KEY (required) the CURRENT super-admin's key
 *
 * Run:
 *   INTEGRATOR_ADDRESS=0x... NEW_SUPER_ADMIN=0x... \
 *   npx hardhat run scripts/transfer-superadmin.ts --network baseSepolia
 */
import { ethers } from "hardhat";

const INTEGRATOR = process.env.INTEGRATOR_ADDRESS || "";
const NEW_SUPER_ADMIN = process.env.NEW_SUPER_ADMIN || "";

// Minimal ABI pinned to what the contract exposes for a two-step handoff.
const ABI = [
  "function superAdmin() view returns (address)",
  "function pendingSuperAdmin() view returns (address)",
  "function isOwner(address) view returns (bool)",
  "function transferSuperAdmin(address next)",
  "function acceptSuperAdmin()",
  "event SuperAdminTransferStarted(address indexed current, address indexed next)",
  "event SuperAdminTransferred(address indexed previous, address indexed next)",
];

async function main() {
  if (!ethers.isAddress(INTEGRATOR)) {
    throw new Error(`INTEGRATOR_ADDRESS env var is missing or not an address: "${INTEGRATOR}"`);
  }
  if (!ethers.isAddress(NEW_SUPER_ADMIN) || NEW_SUPER_ADMIN === ethers.ZeroAddress) {
    throw new Error(
      `NEW_SUPER_ADMIN env var is missing or not a valid non-zero address: "${NEW_SUPER_ADMIN}"`
    );
  }

  const net = await ethers.provider.getNetwork();
  const [signer] = await ethers.getSigners();
  const c = new ethers.Contract(INTEGRATOR, ABI, signer);

  const currentSA: string = await c.superAdmin();
  const pending: string = await c.pendingSuperAdmin();
  const signerAddr = await signer.getAddress();

  console.log("network            :", net.chainId.toString());
  console.log("integrator         :", INTEGRATOR);
  console.log("current superAdmin :", currentSA);
  console.log("pending superAdmin :", pending === ethers.ZeroAddress ? "(none)" : pending);
  console.log("signer             :", signerAddr);
  console.log("PROPOSE new super  :", NEW_SUPER_ADMIN);
  console.log("");

  // ─── Pre-flight safety checks (abort before sending on any problem) ───
  if (signerAddr.toLowerCase() !== currentSA.toLowerCase()) {
    throw new Error(
      `Signer (${signerAddr}) is NOT the current super-admin (${currentSA}). ` +
        `Only the current super-admin can propose a handoff — the tx would revert OnlySuperAdmin. ` +
        `Set DEPLOYER_PRIVATE_KEY to the current super-admin's key.`
    );
  }
  if (NEW_SUPER_ADMIN.toLowerCase() === currentSA.toLowerCase()) {
    throw new Error(
      `NEW_SUPER_ADMIN is already the super-admin — a no-op handoff reverts InvalidAddress.`
    );
  }

  console.log(
    "All checks passed. Sending transferSuperAdmin(NEW_SUPER_ADMIN) — this PROPOSES only."
  );
  const tx = await c.transferSuperAdmin(NEW_SUPER_ADMIN);
  console.log("tx sent:", tx.hash);
  const rc = await tx.wait();
  console.log(
    "mined in block:",
    rc?.blockNumber,
    "status:",
    rc?.status === 1 ? "success" : "REVERTED"
  );

  // ─── Verify the on-chain result — root should NOT have moved yet ───
  const nowSA: string = await c.superAdmin();
  const nowPending: string = await c.pendingSuperAdmin();
  console.log("");
  console.log("superAdmin (unchanged):", nowSA);
  console.log("pendingSuperAdmin      :", nowPending);
  if (
    nowSA.toLowerCase() === currentSA.toLowerCase() &&
    nowPending.toLowerCase() === NEW_SUPER_ADMIN.toLowerCase()
  ) {
    console.log("");
    console.log("✓ Handoff PROPOSED. Root has NOT moved yet.");
    console.log(
      "  To COMPLETE it, the new super-admin must call acceptSuperAdmin() from its own key:"
    );
    console.log(`    (from ${NEW_SUPER_ADMIN}) integrator.acceptSuperAdmin()`);
    console.log("  To CANCEL, re-run transferSuperAdmin with NEW_SUPER_ADMIN = the zero address.");
  } else {
    console.log("✗ Unexpected state — investigate before assuming the proposal succeeded.");
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
