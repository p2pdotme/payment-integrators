/**
 * Grant FULL ADMIN (Role.FINANCE) to an address on the v12 Base Sepolia integrator.
 *
 * `addAdmin(who)` is SUPER-ADMIN-ONLY and sets Role.FINANCE — the top tier, matching
 * the old flat-admin "can do everything" behaviour. This is high-privilege and on-chain.
 * Undo later with `removeAdmin(who)` (also super-admin-only), but any action the grantee
 * takes before you revoke still stands.
 *
 * Run:
 *   DEPLOYER_PRIVATE_KEY=<super-admin key>  \
 *   npx hardhat run scripts/grant-admin.ts --network baseSepolia
 *
 * The signer MUST be the current super-admin (0x4f45446a6E934Fd03A353eC4DAc7Cd544f03d426),
 * or the tx reverts OnlySuperAdmin.
 */
import { ethers } from "hardhat";

// v12 Base Sepolia integrator (from deployment-record.json)
const INTEGRATOR = "0xC78222FFead42c8fc05A128966eb29590aD384d3";
const EXPECTED_SUPER_ADMIN = "0x4f45446a6E934Fd03A353eC4DAc7Cd544f03d426";

// The address to promote to full admin.
const GRANTEE = "0x02b51E84a58cd5E5194c4280d3c0d09843cC4513";

// Role enum: NONE=0, VIEWER=1, SUPPORT=2, MANAGER=3, FINANCE=4
const ROLE_NAMES = ["NONE", "VIEWER", "SUPPORT", "MANAGER", "FINANCE"];

async function main() {
  const [signer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();

  // --- pre-flight guards: fail loudly BEFORE sending value-bearing state changes ---
  if (net.chainId !== 84532n) {
    throw new Error(
      `Wrong network: chainId ${net.chainId}, expected 84532 (Base Sepolia). Aborting.`
    );
  }
  if (!ethers.isAddress(GRANTEE)) {
    throw new Error(`Grantee is not a valid address: ${GRANTEE}`);
  }

  const integrator = await ethers.getContractAt("MerchantTerminalIntegrator", INTEGRATOR, signer);

  // Confirm the on-chain super-admin matches, and that we're signing with it.
  const onChainSuperAdmin: string = await integrator.superAdmin();
  console.log("Network         :", "Base Sepolia (84532)");
  console.log("Integrator      :", INTEGRATOR);
  console.log("Signer          :", signer.address);
  console.log("On-chain superAdmin:", onChainSuperAdmin);
  console.log("Grantee         :", GRANTEE);

  if (onChainSuperAdmin.toLowerCase() !== EXPECTED_SUPER_ADMIN.toLowerCase()) {
    throw new Error(
      `On-chain super-admin (${onChainSuperAdmin}) != expected (${EXPECTED_SUPER_ADMIN}). Deployment record may be stale — verify before proceeding.`
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
