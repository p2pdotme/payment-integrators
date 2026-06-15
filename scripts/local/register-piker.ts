import { ethers } from "hardhat";

/**
 * Whitelist PikerOnrampIntegrator on the Base Sepolia test Diamond via
 * B2BGatewayFacet.registerIntegrator (onlySuperAdmin). Guarded: verifies the
 * signer, refuses to clobber a locked proxyImpl, dry-runs before broadcasting.
 *
 *   DIAMOND_ADDRESS=0x... INTEGRATOR_ADDRESS=0x... PROXY_IMPL=0x... \
 *     USDC_THROUGH_INTEGRATOR=false \
 *     npx hardhat run scripts/local/register-piker.ts --network baseSepolia
 */
const ABI = [
  "function registerIntegrator(address integrator, bool usdcThroughIntegrator, address proxyImpl)",
  "function getIntegratorConfig(address) view returns (tuple(bool isActive, bool usdcThroughIntegrator, uint256 activeOrderCount, address proxyImpl))",
];
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

  const c = new ethers.Contract(DIAMOND, ABI, admin);
  const before = await c.getIntegratorConfig(INTEGRATOR);
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

  // Dry-run first: estimateGas reverts if the signer isn't authorized or args are bad.
  const est = await c.registerIntegrator.estimateGas(INTEGRATOR, through, PROXY_IMPL);
  console.log("estimateGas OK:", est.toString(), "— broadcasting…");

  const tx = await c.registerIntegrator(INTEGRATOR, through, PROXY_IMPL);
  console.log("tx sent:", tx.hash);
  const r = await tx.wait();
  console.log("mined in block:", r?.blockNumber);

  const after = await c.getIntegratorConfig(INTEGRATOR);
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
