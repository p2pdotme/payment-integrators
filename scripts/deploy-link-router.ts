import { ethers } from "hardhat";

/**
 * Deploys LinkRouter and points the integrator at it.
 *
 * WHY THIS SCRIPT EXISTS
 * Round-3 review, M3: the deployment checklist covered the cancel callback and
 * the library link, on the stated criterion that those things "are silent when
 * missing — nothing reverts, nothing logs, the feature simply does not work".
 * The Router met that criterion exactly and was not on the list, and there was
 * no script. Its only appearance anywhere was in the e2e fixture.
 *
 * Two steps, and the second is the one that makes the path live:
 *
 *   1. deploy LinkRouter(integrator)   — immutable, no admin, no upgrade path
 *   2. setTrustedRelayer(router)       — MANAGER role on the integrator
 *
 * Step 2 is also the rollback: pointing `trustedRelayer` back at the old EOA
 * (or at address(0)) stops every link payment without touching anything else.
 *
 * Usage:
 *   INTEGRATOR=0x… npx hardhat run scripts/deploy-link-router.ts --network base
 *
 * Set SKIP_WIRE=1 to deploy only — useful when the deployer is not the manager
 * and step 2 has to be done from a different key.
 */
async function main() {
  const integrator = process.env.INTEGRATOR;
  if (!integrator || !ethers.isAddress(integrator)) {
    throw new Error("Set INTEGRATOR to the deployed MerchantTerminalIntegrator address.");
  }

  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  console.log(`network    : ${net.name} (${net.chainId})`);
  console.log(`deployer   : ${deployer.address}`);
  console.log(`integrator : ${integrator}`);

  // Refuse to deploy against something that is not the integrator. A Router
  // bound to the wrong address is immutable and therefore unrecoverable —
  // cheaper to catch here than to discover after wiring it.
  const probe = await ethers.getContractAt("MerchantTerminalIntegrator", integrator);
  let existingRelayer: string;
  try {
    existingRelayer = await probe.trustedRelayer();
  } catch {
    // A raw decode error here is unreadable and points nowhere. Say what is
    // actually wrong: the Router binds this address IMMUTABLY, so a wrong one
    // is unrecoverable and worth catching before deployment rather than after.
    throw new Error(
      `No MerchantTerminalIntegrator at ${integrator} on this network. ` +
        `The Router binds it immutably, so check the address and the --network flag.`
    );
  }
  console.log(`current trustedRelayer: ${existingRelayer}`);

  const Router = await ethers.getContractFactory("LinkRouter");
  const router = await Router.deploy(integrator);
  await router.waitForDeployment();
  const routerAddress = await router.getAddress();

  const code = await ethers.provider.getCode(routerAddress);
  console.log(`\nLinkRouter : ${routerAddress}`);
  console.log(`size       : ${(code.length - 2) / 2} bytes`);

  if (process.env.SKIP_WIRE) {
    console.log("\nSKIP_WIRE set — not calling setTrustedRelayer.");
    console.log(
      `Run this from the MANAGER key:\n  integrator.setTrustedRelayer("${routerAddress}")`
    );
  } else {
    console.log("\nsetTrustedRelayer …");
    const tx = await probe.setTrustedRelayer(routerAddress);
    await tx.wait();
    const now: string = await probe.trustedRelayer();
    if (now.toLowerCase() !== routerAddress.toLowerCase()) {
      throw new Error(`setTrustedRelayer did not take: reads ${now}`);
    }
    console.log(`trustedRelayer is now ${now}`);
  }

  console.log(
    [
      "",
      "Still to configure — every one is silent when missing:",
      `  worker  LINK_ROUTER_ADDRESS      = ${routerAddress}`,
      "  worker  ENTRYPOINT_ADDRESS       = the ERC-4337 singleton on this chain",
      "  worker  ACCOUNT_FACTORY_ADDRESS  = your account factory",
      "  worker  ACCOUNT_FACTORY_KIND     = thirdweb | simple  (different SELECTORS)",
      "  worker  BUNDLER_URL, PAYMASTER_URL, PAYMASTER_POLICY_ID",
      "  secret  LINK_KEY_MASTER          32 random bytes, base64",
      "  secret  SPONSOR_VERIFIER_SECRET  the verifier FAILS CLOSED without it",
      "  secret  BUNDLER_SECRET           server side only",
      "",
      "  provider  sponsorship allowed-contracts = this Router, and nothing else",
      `  provider  server verifier URL          = https://<worker>/api/sponsor-check`,
      "",
      "Merchant app: mint a link wallet with POST /api/links/:linkId/wallet, then",
      "batch createLink(linkId, …) BEFORE registerAgent(linkId, account) — that",
      "order matters, and a link created without its agent can never be paid.",
    ].join("\n")
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
