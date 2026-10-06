import { ethers } from "hardhat";
import { getIntegratorConfig, registerIntegrator } from "../lib/diamond";

/**
 * Whitelist PikerOnrampIntegrator on the Base Sepolia test Diamond via
 * B2BGatewayFacet.registerIntegrator (onlySuperAdmin). Guarded: verifies the
 * signer, refuses to clobber a locked proxyImpl, dry-runs before broadcasting.
 *
 *   DIAMOND_ADDRESS=0x... INTEGRATOR_ADDRESS=0x... PROXY_IMPL=0x... \
 *     USDC_THROUGH_INTEGRATOR=false \
 *     npx hardhat run scripts/local/register-piker.ts --network baseSepolia
 */
const EXPECTED_SUPERADMIN = "0x9DE9772AfCdf3AFa03CC689fE7AFA5b631088aB9";

async function main() {
  const DIAMOND = process.env.DIAMOND_ADDRESS!;
  const INTEGRATOR = process.env.INTEGRATOR_ADDRESS!;
  const PROXY_IMPL = process.env.PROXY_IMPL!;
  const through = process.env.USDC_THROUGH_INTEGRATOR === "true"; // default false for Piker onramp
  if (!DIAMOND || !INTEGRATOR || !PROXY_IMPL)
    throw new Error("DIAMOND_ADDRESS, INTEGRATOR_ADDRESS, PROXY_IMPL required");

  const [admin] = await ethers.getSigners();
  const bal = await ethers.provider.getBalance(admin.address);
  console.log("signer:        ", admin.address);
  console.log(
    "expected admin:",
    EXPECTED_SUPERADMIN,
    admin.address.toLowerCase() === EXPECTED_SUPERADMIN.toLowerCase() ? "✓" : "✗ MISMATCH"
  );
  console.log("signer ETH:    ", ethers.formatEther(bal));
  console.log("diamond:       ", DIAMOND);
  console.log("integrator:    ", INTEGRATOR);
  console.log("proxyImpl:     ", PROXY_IMPL);
  console.log("usdcThroughIntegrator:", through);
  if (admin.address.toLowerCase() !== EXPECTED_SUPERADMIN.toLowerCase())
    throw new Error("signer is not the expected super-admin — aborting");
  if (bal === 0n) throw new Error("signer has no ETH for gas — aborting");

  const before = await getIntegratorConfig(ethers.provider, DIAMOND, INTEGRATOR);
  console.log("before:", {
    isActive: before.isActive,
    usdcThroughIntegrator: before.usdcThroughIntegrator,
    proxyImpl: before.proxyImpl,
  });
  if (
    before.proxyImpl !== ethers.ZeroAddress &&
    before.proxyImpl.toLowerCase() !== PROXY_IMPL.toLowerCase()
  )
    throw new Error(
      `proxyImpl already locked to ${before.proxyImpl} — refusing to register a different impl`
    );
  if (before.isActive && before.proxyImpl.toLowerCase() === PROXY_IMPL.toLowerCase()) {
    console.log("already registered with this proxyImpl — nothing to do.");
    return;
  }

  // Piker takes no onOrderCancel notification. registerIntegrator picks the
  // 4-arg form or the legacy pair, whichever the Diamond routes.
  const hashes = await registerIntegrator(admin, DIAMOND, {
    integrator: INTEGRATOR,
    usdcThroughIntegrator: through,
    proxyImpl: PROXY_IMPL,
    cancelCallback: false,
  });
  console.log("tx:", hashes.join(", "));

  const after = await getIntegratorConfig(ethers.provider, DIAMOND, INTEGRATOR);
  console.log("after:", {
    isActive: after.isActive,
    usdcThroughIntegrator: after.usdcThroughIntegrator,
    proxyImpl: after.proxyImpl,
  });
  const ok =
    after.isActive &&
    after.proxyImpl.toLowerCase() === PROXY_IMPL.toLowerCase() &&
    after.usdcThroughIntegrator === through;
  console.log(ok ? "✅ registered" : "✗ unexpected post-state");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
