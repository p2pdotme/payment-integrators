/**
 * Grant FULL ADMIN (Role.FINANCE) to an address on the deployed integrator.
 *
 * `addAdmin(who)` is SUPER-ADMIN-ONLY and sets Role.FINANCE — the top tier, matching
 * the old flat-admin "can do everything" behaviour. This is high-privilege and on-chain.
 * Undo later with `removeAdmin(who)` (also super-admin-only), but any action the grantee
 * takes before you revoke still stands.
 *
 * Env (addresses are NOT hardcoded — repo convention forbids it):
 *   INTEGRATOR_ADDRESS   (required) the live integrator to operate on
 *   GRANTEE              (required) the address to promote to full admin
 *   EXPECTED_SUPER_ADMIN (optional) if set, asserted against the on-chain value
 *   DEPLOYER_PRIVATE_KEY (required) the CURRENT super-admin's key
 *
 * Run:
 *   INTEGRATOR_ADDRESS=0x... GRANTEE=0x... \
 *   npx hardhat run scripts/grant-admin.ts --network baseSepolia
 */
import { ethers } from "hardhat";

const INTEGRATOR = process.env.INTEGRATOR_ADDRESS || "";
const EXPECTED_SUPER_ADMIN = process.env.EXPECTED_SUPER_ADMIN || "";
const GRANTEE = process.env.GRANTEE || "";

// Role enum: NONE=0, VIEWER=1, SUPPORT=2, MANAGER=3, FINANCE=4
const ROLE_NAMES = ["NONE", "VIEWER", "SUPPORT", "MANAGER", "FINANCE"];

async function main() {
  const [signer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();

  // --- pre-flight guards: fail loudly BEFORE sending value-bearing state changes ---
  if (!ethers.isAddress(INTEGRATOR)) {
    throw new Error(`INTEGRATOR_ADDRESS env var is missing or not an address: "${INTEGRATOR}"`);
  }
  if (!ethers.isAddress(GRANTEE)) {
    throw new Error(`GRANTEE env var is missing or not a valid address: "${GRANTEE}"`);
  }

  const integrator = await ethers.getContractAt("MerchantTerminalIntegrator", INTEGRATOR, signer);

  // Confirm the on-chain super-admin matches, and that we're signing with it.
  const onChainSuperAdmin: string = await integrator.superAdmin();
  console.log("Network         :", net.chainId.toString());
  console.log("Integrator      :", INTEGRATOR);
  console.log("Signer          :", signer.address);
  console.log("On-chain superAdmin:", onChainSuperAdmin);
  console.log("Grantee         :", GRANTEE);

  if (
    EXPECTED_SUPER_ADMIN &&
    onChainSuperAdmin.toLowerCase() !== EXPECTED_SUPER_ADMIN.toLowerCase()
  ) {
    throw new Error(
      `On-chain super-admin (${onChainSuperAdmin}) != EXPECTED_SUPER_ADMIN (${EXPECTED_SUPER_ADMIN}). Verify before proceeding.`
    );
  }
  if (signer.address.toLowerCase() !== onChainSuperAdmin.toLowerCase()) {
    throw new Error(
      `Signer ${signer.address} is NOT the super-admin ${onChainSuperAdmin}. addAdmin would revert. Use the super-admin key.`
    );
  }

  // Report current role so a re-run is obvious.
  const before: bigint = await integrator.roleOf(GRANTEE);
  console.log(`Grantee current role: ${ROLE_NAMES[Number(before)] ?? before}`);
  if (Number(before) === 4) {
    console.log("Grantee already has Role.FINANCE (full admin). Nothing to do.");
    return;
  }

  console.log("\nSending addAdmin(...) — grants Role.FINANCE (full admin tier)...");
  const tx = await integrator.addAdmin(GRANTEE);
  console.log("tx hash:", tx.hash);
  const rcpt = await tx.wait();
  console.log("Mined in block:", rcpt?.blockNumber);

  const after: bigint = await integrator.roleOf(GRANTEE);
  console.log(`Grantee new role: ${ROLE_NAMES[Number(after)] ?? after}`);
  console.log(
    after === 4n ? "✅ Full admin granted." : "⚠️ Role not FINANCE — check contract state."
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
