/**
 * Transfer the SUPER-ADMIN root of the DEPLOYED (whitelisted) v12 integrator to a
 * new address. This targets the LIVE contract on Base Sepolia — it does NOT
 * redeploy anything.
 *
 * ⚠️ IRREVERSIBLE. The deployed contract has the SINGLE-STEP transferSuperAdmin:
 *    this call moves root IMMEDIATELY. There is no undo and no accept step on the
 *    live contract. If NEW_SUPER_ADMIN is wrong or uncontrolled, all governance
 *    (roles, owners, setVault, migrateState, and the vault link) is bricked
 *    forever. Double-check NEW_SUPER_ADMIN before running.
 *
 * The signer MUST be the CURRENT super-admin (the deployer), or the tx reverts
 * OnlySuperAdmin. We check this on-chain BEFORE sending and abort on any mismatch.
 *
 * Run:
 *   DEPLOYER_PRIVATE_KEY=<current super-admin key> \
 *   npx hardhat run scripts/transfer-superadmin.ts --network baseSepolia
 */
import { ethers } from "hardhat";

// LIVE whitelisted v12 integrator (deployment-record.json). NOT redeployed.
const INTEGRATOR = "0xC78222FFead42c8fc05A128966eb29590aD384d3";
// The address to hand root control to.
const NEW_SUPER_ADMIN = "0x05e0555a49Faea2E16cf4f3520Db0e4a774aA4fe";

// Minimal ABI pinned to what the DEPLOYED contract exposes — independent of which
// source version is checked out locally. The deployed transferSuperAdmin is
// single-step (moves root in this one tx).
const ABI = [
  "function superAdmin() view returns (address)",
  "function isOwner(address) view returns (bool)",
  "function transferSuperAdmin(address next)",
  "event SuperAdminTransferred(address indexed previous, address indexed next)",
];

async function main() {
  const net = await ethers.provider.getNetwork();
  if (net.chainId !== 84532n) {
    throw new Error(`Wrong network: chainId ${net.chainId}. Expected 84532 (Base Sepolia).`);
  }

  const [signer] = await ethers.getSigners();
  const c = new ethers.Contract(INTEGRATOR, ABI, signer);

  const currentSA: string = await c.superAdmin();
  const signerAddr = await signer.getAddress();

  console.log("network            :", net.chainId.toString(), "(Base Sepolia)");
  console.log("integrator         :", INTEGRATOR);
  console.log("current superAdmin :", currentSA);
  console.log("signer             :", signerAddr);
  console.log("NEW superAdmin     :", NEW_SUPER_ADMIN);
  console.log("");

  // ─── Pre-flight safety checks (abort before sending on any problem) ───
  if (!ethers.isAddress(NEW_SUPER_ADMIN) || NEW_SUPER_ADMIN === ethers.ZeroAddress) {
    throw new Error(`NEW_SUPER_ADMIN is not a valid non-zero address: ${NEW_SUPER_ADMIN}`);
  }
  if (signerAddr.toLowerCase() !== currentSA.toLowerCase()) {
    throw new Error(
      `Signer (${signerAddr}) is NOT the current super-admin (${currentSA}). ` +
      `Only the current super-admin can transfer root — the tx would revert OnlySuperAdmin. ` +
      `Set DEPLOYER_PRIVATE_KEY to the current super-admin's key.`
    );
  }
  if (NEW_SUPER_ADMIN.toLowerCase() === currentSA.toLowerCase()) {
    throw new Error(`NEW_SUPER_ADMIN is already the super-admin — nothing to do (a no-op handoff reverts).`);
  }

  console.log("All checks passed. Sending transferSuperAdmin(NEW_SUPER_ADMIN)…");
  console.log("⚠️  This is IRREVERSIBLE on the deployed contract.");
  const tx = await c.transferSuperAdmin(NEW_SUPER_ADMIN);
  console.log("tx sent:", tx.hash);
  const rc = await tx.wait();
  console.log("mined in block:", rc?.blockNumber, "status:", rc?.status === 1 ? "success" : "REVERTED");

  // ─── Verify the on-chain result ───
  const newSA: string = await c.superAdmin();
  console.log("");
  console.log("on-chain superAdmin now:", newSA);
  if (newSA.toLowerCase() === NEW_SUPER_ADMIN.toLowerCase()) {
    console.log("✓ Super-admin successfully transferred to", NEW_SUPER_ADMIN);
    console.log("NOTE: update deployment-record.json `superAdmin` to the new address.");
  } else {
    console.log("✗ superAdmin did NOT change to the target — investigate before assuming success.");
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
