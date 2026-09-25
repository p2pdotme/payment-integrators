import { ethers } from "hardhat";
import { checkMultisig, MAINNET_CHAIN_IDS, printSafeBatch, proposeHandoff } from "./lib/superAdmin";

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
 * SUPER_ADMIN_MULTISIG=0x… (required on mainnet): after wiring, propose handing
 * the super-admin to this multisig and print the Safe batch that completes it.
 * setTrustedRelayer is a super-admin power, so this is the last step the
 * deployer key does; after the multisig accepts, the deployer holds nothing.
 *
 * Set SKIP_WIRE=1 to deploy only — useful when the deployer is not the manager
 * and step 2 has to be done from a different key.
 */
/**
 * Re-reads until the node agrees, instead of trusting the first answer.
 *
 * A public RPC can serve state from a block behind the one that just mined, so a
 * read taken immediately after `wait()` legitimately returns the OLD value. This
 * script hit that on three separate deploys — reporting "size: 0 bytes" for a
 * router that was deployed, and "setTrustedRelayer did not take" for a call that
 * had taken — and every time the state was correct seconds later.
 *
 * A deploy script that cries wolf is worse than a slow one: the next person
 * either re-runs a deploy that already succeeded, or starts ignoring its errors.
 */
async function settle<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  let last: T = await read();
  for (let i = 0; i < 10; i++) {
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 2000));
    last = await read();
  }
  throw new Error(`${what}: still wrong after 20s — last read ${String(last)}`);
}

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

  const MULTISIG = process.env.SUPER_ADMIN_MULTISIG || "";
  if (!MULTISIG && MAINNET_CHAIN_IDS.has(net.chainId)) {
    throw new Error("Mainnet: set SUPER_ADMIN_MULTISIG — the super-admin must end up a multisig.");
  }
  // Check before deploying anything, so a bad address fails for free.
  const ms = MULTISIG
    ? await checkMultisig(ethers.provider, MULTISIG, {
        chainId: net.chainId,
        allowSingleSigner: !!process.env.ALLOW_SINGLE_SIGNER,
        deployer: deployer.address,
      })
    : null;

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

  const code = await settle(
    () => ethers.provider.getCode(routerAddress),
    (c) => c.length > 2,
    "router code never appeared"
  );
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
    const now = await settle<string>(
      () => probe.trustedRelayer(),
      (v) => v.toLowerCase() === routerAddress.toLowerCase(),
      "setTrustedRelayer did not take"
    );
    console.log(`trustedRelayer is now ${now}`);
  }

  if (ms) {
    console.log("");
    await proposeHandoff(probe as any, ms.address);
    printSafeBatch(integrator, deployer.address, ms.address);
  } else {
    console.log("\nNo SUPER_ADMIN_MULTISIG: the deployer key is still super-admin (testnet only).");
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
