import { ethers } from "hardhat";
import { getIntegratorConfig } from "./lib/diamond";

/**
 * Deploy + register BlioCheckoutIntegrator — the consumer checkout for blio.me
 * Premium: users pay in local fiat, the Diamond settles USDC on Base straight
 * into the blio treasury.
 *
 *   BlioCheckoutIntegrator
 *   → register on the Diamond (usdcThroughIntegrator = FALSE)
 *
 * ── Why usdcThroughIntegrator MUST be false ───────────────────────────────
 * Every order pins `recipientAddr` to the immutable `treasury`, so completion
 * routes the USDC directly there. Registering `true` would route it to the
 * integrator instead, which has no forwarding path — the funds would strand.
 * The script asserts the registered flag afterwards and fails loudly otherwise.
 *
 * ── Owner + treasury ──────────────────────────────────────────────────────
 * `owner` (limits, products, pause, sweep) and `treasury` (settlement
 * destination) should both be the blio multisig. On mainnet the script refuses
 * to default either to the deployer EOA.
 *
 * Usage:
 *   [DIAMOND_ADDRESS=0x...] [USDC_ADDRESS=0x...] TREASURY=0x... [DEPLOY_OWNER=0x...] \
 *   [BASE_TX_LIMIT=50000000] [DAILY_TX_COUNT_LIMIT=10] [SKIP_REGISTER=false] [DRY_RUN=1] \
 *   npx hardhat run scripts/deploy-blio.ts --network base
 */

const PRESETS: Record<number, { label: string; diamond?: string; usdc?: string }> = {
  8453: {
    label: "Base mainnet",
    diamond: "0x4cad6eC90e65baBec9335cAd728DDC610c316368",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  84532: { label: "Base Sepolia" },
};

const BASE_TX_LIMIT = process.env.BASE_TX_LIMIT || "50000000"; // $50
const DAILY_TX_COUNT_LIMIT = process.env.DAILY_TX_COUNT_LIMIT || "10";
const SKIP_REGISTER = process.env.SKIP_REGISTER === "true";
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

const REGISTER_ABI = [
  "function registerIntegrator(address integrator, bool usdcThroughIntegrator, address proxyImpl)",
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

const usd = (raw: string) => `$${(Number(raw) / 1e6).toLocaleString()}`;

function requireChecksummed(label: string, addr: string): string {
  let checksummed: string;
  try {
    checksummed = ethers.getAddress(addr.toLowerCase());
  } catch {
    throw new Error(`${label} is not an address: ${addr}`);
  }
  if (addr !== checksummed) {
    throw new Error(
      `${label} fails its EIP-55 checksum: got ${addr}. Re-copy the address from ` +
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
  const TREASURY = process.env.TREASURY || "";
  const DEPLOY_OWNER = process.env.DEPLOY_OWNER || deployer.address;

  console.log(`\n=== BlioCheckoutIntegrator — ${preset.label} (${chainId}) ===`);
  console.log("Deployer:", deployer.address);
  console.log(
    "Balance: ",
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
    "ETH"
  );

  if (!DIAMOND_ADDRESS || !USDC_ADDRESS) {
    throw new Error("DIAMOND_ADDRESS and USDC_ADDRESS are required (no preset on this network)");
  }
  if (!TREASURY) throw new Error("TREASURY is required — the blio multisig");
  requireChecksummed("TREASURY", TREASURY);

  if (isMainnet && !process.env.DEPLOY_OWNER) {
    throw new Error(
      "DEPLOY_OWNER is required on mainnet — pass the blio multisig. Defaulting to " +
        "the deployer EOA would hand limits/products/pause/sweep to a hot key."
    );
  }
  if (process.env.DEPLOY_OWNER) requireChecksummed("DEPLOY_OWNER", DEPLOY_OWNER);

  for (const [label, addr] of [
    ["Diamond", DIAMOND_ADDRESS],
    ["USDC", USDC_ADDRESS],
  ] as const) {
    const code = await ethers.provider.getCode(addr);
    if (code === "0x") throw new Error(`${label} ${addr} has NO CODE on chain ${chainId}`);
    console.log(`✅ ${label}: ${addr} (${(code.length - 2) / 2} bytes)`);
  }

  const token = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, ethers.provider);
  try {
    const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
    console.log(`   settlement token: ${symbol}, ${decimals} decimals`);
    if (Number(decimals) !== 6)
      throw new Error(`settlement token has ${decimals} decimals — limits assume 6`);
  } catch (e) {
    if (isMainnet) throw e;
    console.log(`   ⚠️  could not read token metadata: ${(e as Error).message}`);
  }

  console.log("\nConfig:");
  console.log(
    `  treasury:         ${TREASURY}${TREASURY === deployer.address ? "  (⚠️ DEPLOYER EOA — use a multisig)" : ""}`
  );
  console.log(
    `  owner:            ${DEPLOY_OWNER}${DEPLOY_OWNER === deployer.address ? "  (⚠️ DEPLOYER EOA — use a multisig)" : ""}`
  );
  console.log(`  base tx limit:    ${usd(BASE_TX_LIMIT)}`);
  console.log(`  daily tx count:   ${DAILY_TX_COUNT_LIMIT}`);

  if (BigInt(DAILY_TX_COUNT_LIMIT) === 0n) throw new Error("DAILY_TX_COUNT_LIMIT must be > 0");

  if (DRY_RUN) {
    console.log("\n✅ DRY_RUN: preflight passed. Nothing deployed.");
    return;
  }

  console.log("\nDeploying BlioCheckoutIntegrator…");
  const Integ = await ethers.getContractFactory("BlioCheckoutIntegrator");
  const integrator = await Integ.deploy(
    DIAMOND_ADDRESS,
    USDC_ADDRESS,
    TREASURY,
    DEPLOY_OWNER,
    BigInt(BASE_TX_LIMIT),
    BigInt(DAILY_TX_COUNT_LIMIT)
  );
  await integrator.deploymentTransaction()?.wait(2);
  const integratorAddr = await integrator.getAddress();
  const proxyImpl = await integrator.proxyImpl();
  console.log("  BlioCheckoutIntegrator:", integratorAddr);
  console.log("  proxyImpl:             ", proxyImpl);

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
    if (!cfg.isActive || cfg.usdcThroughIntegrator !== false) {
      throw new Error("unexpected integrator config after registration");
    }
    if (cfg.proxyImpl.toLowerCase() !== proxyImpl.toLowerCase()) {
      throw new Error("registered proxyImpl does not match the deployed one");
    }
  }

  const code = await ethers.provider.getCode(integratorAddr);
  console.log("\n=== blio deployment ===");
  console.log(`BlioCheckoutIntegrator: ${integratorAddr}`);
  console.log(`proxyImpl:              ${proxyImpl}`);
  console.log(`bytecode hash:          ${ethers.keccak256(code)}`);

  console.log("\n--- blio app .env ---");
  console.log(`NEXT_PUBLIC_P2P_INTEGRATOR=${integratorAddr}`);
  console.log(`NEXT_PUBLIC_P2P_USDC=${USDC_ADDRESS}`);
  console.log(`NEXT_PUBLIC_P2P_CHAIN_ID=${chainId}`);

  console.log("\n--- verify ---");
  console.log(
    `npx hardhat verify --network ${isMainnet ? "base" : "baseSepolia"} ${integratorAddr} ` +
      `${DIAMOND_ADDRESS} ${USDC_ADDRESS} ${TREASURY} ${DEPLOY_OWNER} ${BASE_TX_LIMIT} ${DAILY_TX_COUNT_LIMIT}`
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
