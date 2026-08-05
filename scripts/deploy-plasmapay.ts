import { ethers } from "hardhat";

/**
 * Deploy + whitelist PlasmaPayCheckoutIntegrator — the fiat -> Base USDC onramp
 * for PlasmaPay, gated on a liveness attestation and settling straight into the
 * buyer's own wallet.
 *
 *   PlasmaPayCheckoutIntegrator
 *   → register on the Diamond (usdcThroughIntegrator = FALSE)
 *
 * ── Why usdcThroughIntegrator MUST be false ───────────────────────────────
 * Every order pins `recipientAddr` to the buyer, so completion routes the
 * purchased USDC directly to their wallet. Registering `true` would instead
 * route it to the integrator, which has no forwarding path — the funds would
 * strand. The script asserts the registered flag afterwards and fails loudly
 * if it is not false.
 *
 * ── Limits ────────────────────────────────────────────────────────────────
 * Liveness only — one tier, no ladder:
 *
 *     $20 per tx, 5 orders/day per wallet
 *
 * Both numbers are ALSO immutable MAX_* constants in the bytecode. The
 * constructor and the owner's setters can only ever go at or below them, so the
 * policy holds against a compromised owner key as well as a compromised
 * attestor key. Pass lower values to launch tighter; the owner can lower
 * further later, never raise.
 *
 * ── The attestor ──────────────────────────────────────────────────────────
 * `ATTESTOR` is the secp256k1 signer of the simple-kyc liveness service. It
 * MUST come from the service's own `GET /v1/attestor` — never a relayed value.
 * A wrong attestor bricks the tier silently: every submitLivenessAttestation
 * reverts InvalidSignature, and only surfaces when a real user first tries to
 * verify. On mainnet this script refuses to run without it.
 *
 * On Base Sepolia, ATTESTOR defaults to the DEPLOYER so an end-to-end script
 * can mint test attestations locally. That is a testnet-only placeholder —
 * rotate with `setAttestor` before anything real.
 *
 * Usage:
 *   [DIAMOND_ADDRESS=0x...] [USDC_ADDRESS=0x...] [ATTESTOR=0x...] \
 *   [TIER_CAP=20000000] [DAILY_TX_COUNT_LIMIT=5] \
 *   [DEPLOY_OWNER=0x...] [SKIP_REGISTER=false] [DRY_RUN=1] \
 *   npx hardhat run scripts/deploy-plasmapay.ts --network baseSepolia
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

const TIER_CAP = process.env.TIER_CAP || "20000000"; // $20
const DAILY_TX_COUNT_LIMIT = process.env.DAILY_TX_COUNT_LIMIT || "5";
const SKIP_REGISTER = process.env.SKIP_REGISTER === "true";
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

const REGISTER_ABI = [
  "function registerIntegrator(address integrator, bool usdcThroughIntegrator, address proxyImpl)",
  // NOTE the tuple wrapper and `activeOrderCount` — decoding this as a flat
  // 3-field return silently reads activeOrderCount as `proxyImpl` (i.e. 0) and
  // makes a perfectly good registration look failed.
  "function getIntegratorConfig(address) view returns (tuple(bool isActive, bool usdcThroughIntegrator, uint256 activeOrderCount, address proxyImpl))",
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

const usd = (raw: string) => `$${(Number(raw) / 1e6).toLocaleString()}`;

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

  console.log(`\n=== PlasmaPayCheckoutIntegrator — ${preset.label} (${chainId}) ===`);
  console.log("Deployer:", deployer.address);
  console.log(
    "Balance: ",
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
    "ETH"
  );

  if (!DIAMOND_ADDRESS || !USDC_ADDRESS) {
    throw new Error("DIAMOND_ADDRESS and USDC_ADDRESS are required (no preset on this network)");
  }

  // ── Attestor ────────────────────────────────────────────────────────────
  if (!ATTESTOR) {
    if (isMainnet) {
      throw new Error(
        "ATTESTOR is required on mainnet. Read it from the liveness service's " +
          "own GET /v1/attestor — never a relayed value."
      );
    }
    ATTESTOR = deployer.address;
    console.log(
      "\n⚠️  ATTESTOR unset — defaulting to the DEPLOYER for testnet so an E2E\n" +
        "    script can sign attestations locally. Rotate with setAttestor(A)\n" +
        "    to the real service signer before any real traffic."
    );
  }
  if (!ethers.isAddress(ATTESTOR)) throw new Error(`ATTESTOR is not an address: ${ATTESTOR}`);

  // ── Preflight ───────────────────────────────────────────────────────────
  for (const [label, addr] of [
    ["Diamond", DIAMOND_ADDRESS],
    ["USDC", USDC_ADDRESS],
  ] as const) {
    const code = await ethers.provider.getCode(addr);
    if (code === "0x") throw new Error(`${label} ${addr} has NO CODE on chain ${chainId}`);
    console.log(`✅ ${label}: ${addr} (${(code.length - 2) / 2} bytes)`);
  }

  // The settlement token the Diamond pays out in. On Sepolia it is a mock,
  // which is fine because this integrator never touches the token itself.
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
  console.log(`  owner:            ${DEPLOY_OWNER}`);
  console.log(
    `  attestor:         ${ATTESTOR}${ATTESTOR === deployer.address ? "  (⚠️ deployer placeholder)" : ""}`
  );
  console.log(`  liveness cap:     ${usd(TIER_CAP)}    (ceiling $20)`);
  console.log(`  daily tx count:   ${DAILY_TX_COUNT_LIMIT}       (ceiling 5)`);

  if (BigInt(TIER_CAP) > 20_000_000n) throw new Error("TIER_CAP above the $20 ceiling");
  if (BigInt(DAILY_TX_COUNT_LIMIT) > 5n || BigInt(DAILY_TX_COUNT_LIMIT) === 0n) {
    throw new Error("DAILY_TX_COUNT_LIMIT must be 1..5");
  }

  if (DRY_RUN) {
    console.log("\n✅ DRY_RUN: preflight passed. Nothing deployed.");
    return;
  }

  // ── 1. Deploy ───────────────────────────────────────────────────────────
  console.log("\nDeploying PlasmaPayCheckoutIntegrator…");
  const Integ = await ethers.getContractFactory("PlasmaPayCheckoutIntegrator");
  const integrator = await Integ.deploy(
    DIAMOND_ADDRESS,
    USDC_ADDRESS,
    DEPLOY_OWNER,
    ATTESTOR,
    BigInt(TIER_CAP),
    BigInt(DAILY_TX_COUNT_LIMIT)
  );
  await integrator.deploymentTransaction()?.wait(2);
  const integratorAddr = await integrator.getAddress();
  const proxyImpl = await integrator.proxyImpl();
  console.log("  PlasmaPayCheckoutIntegrator:", integratorAddr);
  console.log("  proxyImpl:                  ", proxyImpl);

  // ── 2. Register on the Diamond — usdcThroughIntegrator = FALSE ──────────
  if (!SKIP_REGISTER) {
    console.log("\nRegistering on the Diamond (usdcThroughIntegrator=false)…");
    const b2b = new ethers.Contract(DIAMOND_ADDRESS, REGISTER_ABI, deployer);
    const before = await b2b.getIntegratorConfig(integratorAddr);
    if (
      before.proxyImpl !== ethers.ZeroAddress &&
      before.proxyImpl.toLowerCase() !== proxyImpl.toLowerCase()
    ) {
      throw new Error(`proxyImpl already locked to ${before.proxyImpl}; refusing to re-register`);
    }
    const tx = await b2b.registerIntegrator(integratorAddr, false, proxyImpl);
    await tx.wait(1);
    console.log("  registerIntegrator tx:", tx.hash);

    const cfg = await b2b.getIntegratorConfig(integratorAddr);
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
  console.log("\n=== PlasmaPay deployment ===");
  console.log(`PlasmaPayCheckoutIntegrator: ${integratorAddr}`);
  console.log(`proxyImpl:                   ${proxyImpl}`);
  console.log(`bytecode hash:               ${ethers.keccak256(code)}`);
  console.log(`domainSeparator:             ${await integrator.domainSeparator()}`);

  console.log("\n--- PlasmaPay app .env ---");
  console.log(`VITE_P2P_INTEGRATOR=${integratorAddr}`);
  console.log(`VITE_P2P_USDC=${USDC_ADDRESS}`);
  console.log(`VITE_P2P_CHAIN_ID=${chainId}`);

  console.log("\n--- verify ---");
  console.log(
    `npx hardhat verify --network ${isMainnet ? "base" : "baseSepolia"} ${integratorAddr} ` +
      `${DIAMOND_ADDRESS} ${USDC_ADDRESS} ${DEPLOY_OWNER} ${ATTESTOR} ${TIER_CAP} ${DAILY_TX_COUNT_LIMIT}`
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
