import { ethers } from "hardhat";
import { getIntegratorConfig } from "./lib/diamond";

/**
 * Deploy + whitelist OwnCheckoutIntegrator — the fiat -> Base USDC onramp for
 * Own Finance, gated on passport + liveness and settling straight into the
 * buyer's own wallet.
 *
 *   OwnCheckoutIntegrator
 *   → register on the Diamond (usdcThroughIntegrator = FALSE)
 *
 * ── Why usdcThroughIntegrator MUST be false ───────────────────────────────
 * Every order pins `recipientAddr` to the buyer, so completion routes the
 * purchased USDC directly to their wallet. Registering `true` would instead
 * route it to the integrator, which has no forwarding path — the funds would
 * strand. The script asserts the registered flag afterwards and fails loudly
 * if it is not false.
 *
 * ── The second leg is not on-chain here ───────────────────────────────────
 * Own settles in USDG on Robinhood Chain (4663). The buyer bridges the USDC
 * from their own wallet via Relay (Base USDC -> Robinhood USDG is a live pair);
 * this contract deliberately never takes custody, so there is nothing to
 * configure for the bridge.
 *
 * ── Limits ────────────────────────────────────────────────────────────────
 * Passport + liveness only — one tier, no ladder:
 *
 *     $100 per tx on INR (India), $200 per tx on any other currency
 *     5 orders/day per wallet
 *
 * Each number is ALSO an immutable MAX_* constant in the bytecode. The
 * constructor and the owner's setters are bounded by them, so
 * the policy holds against a compromised owner key as well as a compromised
 * attestor key. Pass lower values to launch tighter — the owner can still
 * move a limit anywhere at or below its ceiling afterwards, in either
 * direction, so launching low does not burn the headroom.
 *
 * ── The attestor ──────────────────────────────────────────────────────────
 * `ATTESTOR` is the secp256k1 signer of the passport+liveness service. It MUST
 * come from the service's own `GET /v1/attestor` — never a relayed value. A
 * wrong attestor bricks the tier silently: every submitPassportAttestation
 * reverts InvalidSignature, and only surfaces when a real user first tries to
 * verify. On mainnet this script refuses to run without it.
 *
 * On Base Sepolia, ATTESTOR defaults to the DEPLOYER so the end-to-end script
 * can mint test attestations locally. That is a testnet-only placeholder —
 * rotate with `setAttestor` before anything real.
 *
 * Usage:
 *   [DIAMOND_ADDRESS=0x...] [USDC_ADDRESS=0x...] [ATTESTOR=0x...] \
 *   [CAP_INDIA=100000000] [CAP_ABROAD=200000000] [DAILY_TX_COUNT_LIMIT=5] \
 *   [DEPLOY_OWNER=0x...] [SKIP_REGISTER=false] [DRY_RUN=1] \
 *   npx hardhat run scripts/deploy-own.ts --network baseSepolia
 */

/**
 * Network presets. Base Sepolia has no Diamond/USDC preset (they move around) —
 * pass DIAMOND_ADDRESS and USDC_ADDRESS there.
 */
const PRESETS: Record<number, { label: string; diamond?: string; usdc?: string }> = {
  8453: {
    label: "Base mainnet",
    diamond: "0x4cad6eC90e65baBec9335cAd728DDC610c316368",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  84532: { label: "Base Sepolia" },
};

const CAP_INDIA = process.env.CAP_INDIA || "100000000"; // $100
const CAP_ABROAD = process.env.CAP_ABROAD || "200000000"; // $200
const DAILY_TX_COUNT_LIMIT = process.env.DAILY_TX_COUNT_LIMIT || "5";
const SKIP_REGISTER = process.env.SKIP_REGISTER === "true";
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

const REGISTER_ABI = [
  "function registerIntegrator(address integrator, bool usdcThroughIntegrator, address proxyImpl)",
];

/*
 * Reading the registration back goes through scripts/lib/diamond.ts (#60),
 * which decodes by SHAPE rather than by a hardcoded ABI literal.
 *
 * This script used to carry its own literal. That is wrong in a way worth
 * naming, because it looked fine: `IntegratorConfig` grew a third field in
 * contracts-v4 #362, mainnet and Sepolia upgraded on different days, and
 * during that window NO single literal was correct on both. A 4-field literal
 * against a 5-field Diamond does not even revert — ethers reads `proxyImpl`
 * off the `activeOrderCount` slot and hands back address(0), which then fails
 * the post-registration assertion on a registration that was perfectly good.
 * A selector check cannot catch it either; return types are not part of the
 * selector.
 */

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

const usd = (raw: string) => `$${(Number(raw) / 1e6).toLocaleString()}`;

/**
 * Require `addr` to be exactly its EIP-55 checksummed form. A checksum cannot
 * be validated on-chain — an address is 20 opaque bytes by the time it reaches
 * the constructor — so this script is the last place a single mutated
 * character can still be caught. Rejecting all-lowercase input is deliberate:
 * lowercase carries no checksum, so "valid but unchecksummable" is
 * indistinguishable from "mutated".
 */
function requireChecksummed(label: string, addr: string): string {
  let checksummed: string;
  try {
    checksummed = ethers.getAddress(addr.toLowerCase());
  } catch {
    throw new Error(`${label} is not an address: ${addr}`);
  }
  if (addr !== checksummed) {
    throw new Error(
      `${label} fails its EIP-55 checksum: got ${addr}. A mutated character is ` +
        `exactly what the checksum exists to catch — re-copy the address from ` +
        `the source of truth rather than "fixing" the casing.`
    );
  }
  return checksummed;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const preset = PRESETS[chainId];
  const isMainnet = chainId === 8453;

  if (!preset) throw new Error(`Unsupported chainId ${chainId} — expected 8453 or 84532`);

  const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || preset.diamond || "";
  const USDC_ADDRESS = process.env.USDC_ADDRESS || preset.usdc || "";
  const DEPLOY_OWNER = process.env.DEPLOY_OWNER || deployer.address;
  let ATTESTOR = process.env.ATTESTOR || "";

  console.log(`\n=== OwnCheckoutIntegrator — ${preset.label} (${chainId}) ===`);
  console.log("Deployer:", deployer.address);
  console.log(
    "Balance: ",
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
    "ETH"
  );

  if (!DIAMOND_ADDRESS || !USDC_ADDRESS) {
    throw new Error("DIAMOND_ADDRESS and USDC_ADDRESS are required (no preset on this network)");
  }

  // ── Owner ───────────────────────────────────────────────────────────────
  // `owner` is OZ `Ownable` and transferable after deploy, so a wrong value
  // is recoverable — but only by whoever holds the wrongly-set key. Defaulting
  // silently to the deployer EOA would still put pause/setBlocked/setRegionCap/
  // sweepUsdc on a hot key until someone notices and transfers, so mainnet
  // must name the Own multisig explicitly.
  if (isMainnet && !process.env.DEPLOY_OWNER) {
    throw new Error(
      "DEPLOY_OWNER is required on mainnet — pass the Own multisig. " +
        "Defaulting to the deployer EOA would hand pause/setBlocked/" +
        "setRegionCap/sweepUsdc to a hot key until ownership is transferred."
    );
  }
  if (process.env.DEPLOY_OWNER) requireChecksummed("DEPLOY_OWNER", DEPLOY_OWNER);

  // ── Attestor ────────────────────────────────────────────────────────────
  if (!ATTESTOR) {
    if (isMainnet) {
      throw new Error(
        "ATTESTOR is required on mainnet. Read it from the passport+liveness " +
          "service's own GET /v1/attestor — never a relayed value."
      );
    }
    ATTESTOR = deployer.address;
    console.log(
      "\n⚠️  ATTESTOR unset — defaulting to the DEPLOYER for testnet so the E2E\n" +
        "    script can sign attestations locally. Rotate with setAttestor(A)\n" +
        "    to the real service signer before any real traffic."
    );
  }
  requireChecksummed("ATTESTOR", ATTESTOR);

  // ── Preflight ───────────────────────────────────────────────────────────
  for (const [label, addr] of [
    ["Diamond", DIAMOND_ADDRESS],
    ["USDC", USDC_ADDRESS],
  ] as const) {
    const code = await ethers.provider.getCode(addr);
    if (code === "0x") throw new Error(`${label} ${addr} has NO CODE on chain ${chainId}`);
    console.log(`✅ ${label}: ${addr} (${(code.length - 2) / 2} bytes)`);
  }

  // The settlement token the Diamond pays out in. Own's second leg bridges
  // whatever this is; on Sepolia it is a mock, which is fine because this
  // integrator never touches the token itself.
  const token = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, ethers.provider);
  try {
    const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
    console.log(`   settlement token: ${symbol}, ${decimals} decimals`);
    if (Number(decimals) !== 6) {
      throw new Error(`settlement token has ${decimals} decimals — limits assume 6`);
    }
  } catch (e) {
    if (isMainnet) throw e;
    console.log(`   ⚠️  could not read token metadata: ${(e as Error).message}`);
  }

  console.log("\nConfig:");
  // Marked for the same reason the attestor is: an unmarked address in a
  // DRY_RUN print reads as "configured" whether or not anyone chose it. This
  // one is permanent, so it gets the louder marker.
  console.log(
    `  owner:            ${DEPLOY_OWNER}${
      DEPLOY_OWNER === deployer.address ? "  (⚠️ DEPLOYER EOA — use a multisig)" : ""
    }`
  );
  console.log(
    `  attestor:         ${ATTESTOR}${ATTESTOR === deployer.address ? "  (⚠️ deployer placeholder)" : ""}`
  );
  console.log(`  cap India (INR):  ${usd(CAP_INDIA)}   (ceiling $100)`);
  console.log(`  cap Abroad:       ${usd(CAP_ABROAD)}   (ceiling $200)`);
  console.log(`  daily tx count:   ${DAILY_TX_COUNT_LIMIT}      (ceiling 5)`);

  if (BigInt(CAP_INDIA) > 100_000_000n) throw new Error("CAP_INDIA above the $100 ceiling");
  if (BigInt(CAP_ABROAD) > 200_000_000n) throw new Error("CAP_ABROAD above the $200 ceiling");
  if (BigInt(DAILY_TX_COUNT_LIMIT) > 5n || BigInt(DAILY_TX_COUNT_LIMIT) === 0n) {
    throw new Error("DAILY_TX_COUNT_LIMIT must be 1..5");
  }

  if (DRY_RUN) {
    console.log("\n✅ DRY_RUN: preflight passed. Nothing deployed.");
    return;
  }

  // ── 1. Deploy ───────────────────────────────────────────────────────────
  console.log("\nDeploying OwnCheckoutIntegrator…");
  const Integ = await ethers.getContractFactory("OwnCheckoutIntegrator");
  const integrator = await Integ.deploy(
    DIAMOND_ADDRESS,
    USDC_ADDRESS,
    DEPLOY_OWNER,
    ATTESTOR,
    BigInt(CAP_INDIA),
    BigInt(CAP_ABROAD),
    BigInt(DAILY_TX_COUNT_LIMIT)
  );
  await integrator.deploymentTransaction()?.wait(2);
  const integratorAddr = await integrator.getAddress();
  const proxyImpl = await integrator.proxyImpl();
  console.log("  OwnCheckoutIntegrator:", integratorAddr);
  console.log("  proxyImpl:            ", proxyImpl);

  // ── 2. Register on the Diamond — usdcThroughIntegrator = FALSE ──────────
  if (!SKIP_REGISTER) {
    console.log("\nRegistering on the Diamond (usdcThroughIntegrator=false)…");
    const b2b = new ethers.Contract(DIAMOND_ADDRESS, REGISTER_ABI, deployer);
    const before = await getIntegratorConfig(ethers.provider, DIAMOND_ADDRESS, integratorAddr);
    if (
      before.proxyImpl !== ethers.ZeroAddress &&
      before.proxyImpl.toLowerCase() !== proxyImpl.toLowerCase()
    ) {
      throw new Error(`proxyImpl already locked to ${before.proxyImpl}; refusing to re-register`);
    }
    const tx = await b2b.registerIntegrator(integratorAddr, false, proxyImpl);
    await tx.wait(1);
    console.log("  registerIntegrator tx:", tx.hash);

    const cfg = await getIntegratorConfig(ethers.provider, DIAMOND_ADDRESS, integratorAddr);
    console.log(
      `  config: isActive=${cfg.isActive} usdcThroughIntegrator=${cfg.usdcThroughIntegrator} proxyImpl=${cfg.proxyImpl}`
    );
    // A `true` here would strand every buyer's settlement on the integrator.
    if (!cfg.isActive || cfg.usdcThroughIntegrator !== false) {
      throw new Error("unexpected integrator config after registration");
    }
    if (cfg.proxyImpl.toLowerCase() !== proxyImpl.toLowerCase()) {
      throw new Error("registered proxyImpl does not match the deployed one");
    }
  }

  // ── 3. Report ───────────────────────────────────────────────────────────
  const code = await ethers.provider.getCode(integratorAddr);
  console.log("\n=== Own deployment ===");
  console.log(`OwnCheckoutIntegrator: ${integratorAddr}`);
  console.log(`proxyImpl:             ${proxyImpl}`);
  console.log(`bytecode hash:         ${ethers.keccak256(code)}`);
  console.log(`domainSeparator:       ${await integrator.domainSeparator()}`);

  console.log("\n--- Own app .env ---");
  console.log(`NEXT_PUBLIC_P2P_INTEGRATOR=${integratorAddr}`);
  console.log(`NEXT_PUBLIC_P2P_USDC=${USDC_ADDRESS}`);
  console.log(`NEXT_PUBLIC_P2P_CHAIN_ID=${chainId}`);

  console.log("\n--- verify ---");
  console.log(
    `npx hardhat verify --network ${isMainnet ? "base" : "baseSepolia"} ${integratorAddr} ` +
      `${DIAMOND_ADDRESS} ${USDC_ADDRESS} ${DEPLOY_OWNER} ${ATTESTOR} ${CAP_INDIA} ${CAP_ABROAD} ${DAILY_TX_COUNT_LIMIT}`
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
