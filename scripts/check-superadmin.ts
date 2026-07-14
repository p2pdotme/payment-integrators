/**
 * Read-only: print the on-chain super-admin (+ pending) of a deployed integrator.
 *
 * Env (addresses NOT hardcoded):
 *   INTEGRATOR_ADDRESS   (required) the live integrator to read
 *   RECORDED_SUPER_ADMIN (optional) if set, compared against the on-chain value
 *
 *   INTEGRATOR_ADDRESS=0x... npx hardhat run scripts/check-superadmin.ts --network baseSepolia
 */
import { ethers } from "hardhat";

const INTEGRATOR = process.env.INTEGRATOR_ADDRESS || "";
const RECORDED_SA = process.env.RECORDED_SUPER_ADMIN || "";

async function main() {
  if (!ethers.isAddress(INTEGRATOR)) {
    throw new Error(`INTEGRATOR_ADDRESS env var is missing or not an address: "${INTEGRATOR}"`);
  }
  const net = await ethers.provider.getNetwork();
  const c = await ethers.getContractAt("MerchantTerminalIntegrator", INTEGRATOR);
  const sa: string = await c.superAdmin();
  const pending: string = await c.pendingSuperAdmin();
  console.log("chainId            :", net.chainId.toString());
  console.log("integrator         :", INTEGRATOR);
  console.log("on-chain superAdmin:", sa);
  console.log("pendingSuperAdmin  :", pending === ethers.ZeroAddress ? "(none)" : pending);
  if (RECORDED_SA) {
    console.log("recorded superAdmin:", RECORDED_SA);
    console.log("match              :", sa.toLowerCase() === RECORDED_SA.toLowerCase());
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
