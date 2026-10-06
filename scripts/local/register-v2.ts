import { ethers } from "hardhat";
import { getIntegratorConfig, registerIntegrator } from "../lib/diamond";

/**
 * Whitelist the v2 integrator on the live Diamond's B2BGatewayFacet
 * (registerIntegrator). Run by the Diamond superAdmin. proxyImpl is set-once
 * on-chain (B2BProxyImplLocked) — this script aborts if a different impl is
 * already pinned, to avoid bricking the registration.
 *
 *   DIAMOND_ADDRESS=0x... INTEGRATOR_ADDRESS=0x... PROXY_IMPL=0x... \
 *     [USDC_THROUGH_INTEGRATOR=true] \
 *     npx hardhat run scripts/register-v2.ts --network baseSepolia
 */

async function main() {
  const DIAMOND = process.env.DIAMOND_ADDRESS!;
  const INTEGRATOR = process.env.INTEGRATOR_ADDRESS!;
  const PROXY_IMPL = process.env.PROXY_IMPL!;
  const through = process.env.USDC_THROUGH_INTEGRATOR !== "false";
  if (!DIAMOND || !INTEGRATOR || !PROXY_IMPL)
    throw new Error("DIAMOND_ADDRESS, INTEGRATOR_ADDRESS, PROXY_IMPL required");

  const [admin] = await ethers.getSigners();
  console.log("admin:", admin.address);
  console.log(
    "diamond:",
    DIAMOND,
    " integrator:",
    INTEGRATOR,
    " proxyImpl:",
    PROXY_IMPL,
    " through:",
    through
  );

  const before = await getIntegratorConfig(ethers.provider, DIAMOND, INTEGRATOR);
  console.log("before:", { isActive: before.isActive, proxyImpl: before.proxyImpl });
  if (
    before.proxyImpl !== ethers.ZeroAddress &&
    before.proxyImpl.toLowerCase() !== PROXY_IMPL.toLowerCase()
  ) {
    throw new Error(
      `proxyImpl already locked to ${before.proxyImpl}, refusing to register a different impl`
    );
  }

  // cancelCallback MUST stay false for this integrator: it latches a cancel in
  // onOrderCancel and then refuses onOrderComplete, so with the callback on, a
  // dispute the user WON (CANCELLED -> PAID -> COMPLETED) would deliver nothing.
  const hashes = await registerIntegrator(admin, DIAMOND, {
    integrator: INTEGRATOR,
    usdcThroughIntegrator: through,
    proxyImpl: PROXY_IMPL,
    cancelCallback: false,
  });
  console.log("registerIntegrator tx:", hashes.join(", "));

  const cfg = await getIntegratorConfig(ethers.provider, DIAMOND, INTEGRATOR);
  console.log("after:", {
    isActive: cfg.isActive,
    usdcThroughIntegrator: cfg.usdcThroughIntegrator,
    proxyImpl: cfg.proxyImpl,
  });
  console.log(
    cfg.isActive && cfg.proxyImpl.toLowerCase() === PROXY_IMPL.toLowerCase()
      ? "✅ registered"
      : "✗ unexpected config"
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
