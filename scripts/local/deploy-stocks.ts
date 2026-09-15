import { ethers } from "hardhat";

/**
 * Deploy StocksIntegrator — stocks.me.
 *
 * Buy tokenized US equities (xStocks on Solana) with local fiat. The Diamond
 * settles USDC on the integrator; the integrator burns it via CCTP V2 to a
 * FIXED Solana treasury USDC account. An off-chain worker then swaps that USDC
 * into the chosen xStock and delivers it to the user's own Solana wallet.
 *
 * ── The Base Sepolia problem, and receipt mode ─────────────────────────────
 * CCTP burns only Circle-issued USDC. The Base Sepolia Diamond settles in a
 * mock token (GoofyGoober, 0x4095fE…) whose `burnLimitsPerMessage == 0`, so a
 * naive testnet deploy gives you an order flow whose bridge leg always fails
 * closed. That is honest, but it means testnet never exercises CCTP — the one
 * leg we have not shipped before.
 *
 * So on testnet we deploy with BRIDGE_RESERVE_TOKEN = real Circle Base Sepolia
 * USDC (0x036CbD…, free from Circle's faucet), pre-fund the integrator with it,
 * and burn the reserve instead. Settlement still arrives as the mock token and
 * is treated as a receipt. The REAL CCTP path then runs end to end on testnet.
 *
 * Receipt mode is derived, not configured: `receiptMode = (reserve != usdc)`.
 * On mainnet the two are the same address, so it is off and cannot be enabled.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────
 *   # Base Sepolia (the Diamond/USDC have no preset — they move around)
 *   EXPECTED_CHAIN_ID=84532 \
 *   DIAMOND_ADDRESS=0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9 \
 *   USDC_ADDRESS=0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d \
 *   TREASURY_USDC_ATA=<base58 Solana USDC ATA | 0x…32 bytes> \
 *   npx hardhat run scripts/local/deploy-stocks.ts --network baseSepolia
 *
 *   # Base mainnet — everything preset except the treasury account
 *   EXPECTED_CHAIN_ID=8453 DEPLOY_OWNER=0x… \
 *   TREASURY_USDC_ATA=<base58> \
 *   npx hardhat run scripts/local/deploy-stocks.ts --network base
 *
 * Run with DRY_RUN=1 first — it performs every preflight check and stops before
 * spending gas.
 */

// Verified against Circle's deployment records and the sibling showdown script.
// NB: the TokenMessenger address DIFFERS between mainnet and Sepolia. Circle's
// docs page lists the testnet set; do not assume they are shared.
const PRESETS: Record<
  number,
  {
    label: string;
    diamond?: string;
    usdc?: string;
    tokenMessenger: string;
    /** Circle-issued USDC, i.e. the only thing CCTP will burn on this chain. */
    circleUsdc: string;
  }
> = {
  8453: {
    label: "Base mainnet",
    diamond: "0x4cad6eC90e65baBec9335cAd728DDC610c316368",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    tokenMessenger: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
    circleUsdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  84532: {
    label: "Base Sepolia",
    // No Diamond/USDC preset — the testnet Diamond settles in a mock token and
    // both addresses move. Pass them explicitly.
    tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
    circleUsdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
};

/** CCTP domain for Solana — 5 on both mainnet and devnet. */
const SOLANA_DOMAIN = 5;

/** Our stock ids. Pinned on-chain forever; see lib/stocks.ts. NEVER renumber. */
const STOCKS = [
  { id: 1, symbol: "AAPLx" },
  { id: 2, symbol: "TSLAx" },
  { id: 3, symbol: "NVDAx" },
  { id: 4, symbol: "SPYx" },
];

const TM_ABI = ["function localMinter() view returns (address)"];
const MINTER_ABI = ["function burnLimitsPerMessage(address) view returns (uint256)"];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Solana addresses are base58-encoded 32-byte keys; CCTP wants raw bytes32.
 * Accepts either form so the operator can paste whatever their wallet shows.
 */
function toBytes32(input: string): string {
  const v = input.trim();
  if (v.startsWith("0x")) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(v))
      throw new Error(`TREASURY_USDC_ATA: not 32 hex bytes: ${v}`);
    return v.toLowerCase();
  }
  let num = 0n;
  for (const ch of v) {
    const idx = B58.indexOf(ch);
    if (idx < 0) throw new Error(`TREASURY_USDC_ATA: '${ch}' is not valid base58`);
    num = num * 58n + BigInt(idx);
  }
  // Leading '1's are leading zero bytes.
  let leading = 0;
  for (const ch of v) {
    if (ch === "1") leading++;
    else break;
  }
  const body = num === 0n ? "" : num.toString(16);
  const hex = "00".repeat(leading) + (body.length % 2 ? "0" + body : body);
  if (hex.length !== 64) {
    throw new Error(
      `TREASURY_USDC_ATA decoded to ${hex.length / 2} bytes, expected 32. ` +
        `Is '${v}' really a Solana account address?`
    );
  }
  return "0x" + hex;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

/**
 * Read from a freshly deployed contract, tolerating an RPC node that has not
 * yet seen it. Losing a deployment to a stale read is expensive: the address is
 * what gets whitelisted, so "just redeploy" is not free.
 */
async function retryRead<T>(fn: () => Promise<T>, what: string, attempts = 8): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const wait = 1500 * (i + 1);
      console.log(`  (${what} not readable yet, retrying in ${wait}ms — RPC lag)`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error(
    `${what} still unreadable after ${attempts} attempts. The contract is very ` +
      `likely deployed — recover it with scripts/find-deployment.mjs rather than ` +
      `redeploying. Last error: ${(last as Error)?.message}`
  );
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const isMainnet = chainId === 8453;
  const dryRun = process.env.DRY_RUN === "1";

  // Required on EVERY network: a stale --network or RPC would otherwise skip
  // every mainnet-only guard below and deploy to the wrong chain with a green
  // exit.
  const expected = req("EXPECTED_CHAIN_ID");
  if (String(chainId) !== expected) {
    throw new Error(
      `chainId ${chainId} != EXPECTED_CHAIN_ID ${expected} — refusing to deploy on the wrong network`
    );
  }

  const preset = PRESETS[chainId];
  if (!preset) throw new Error(`No preset for chainId ${chainId}`);

  const diamond = process.env.DIAMOND_ADDRESS ?? preset.diamond;
  const usdc = process.env.USDC_ADDRESS ?? preset.usdc;
  if (!diamond) throw new Error("DIAMOND_ADDRESS is required on this network");
  if (!usdc) throw new Error("USDC_ADDRESS is required on this network");

  const tokenMessenger = process.env.TOKEN_MESSENGER ?? preset.tokenMessenger;
  const treasuryAta = toBytes32(req("TREASURY_USDC_ATA"));

  // The token CCTP actually burns. Defaults to the chain's Circle USDC, which
  // on mainnet IS the settlement token (so receiptMode stays off).
  const reserve = process.env.BRIDGE_RESERVE_TOKEN ?? preset.circleUsdc;
  const receiptMode = reserve.toLowerCase() !== usdc.toLowerCase();

  const txLimit = ethers.parseUnits(process.env.TX_LIMIT ?? "50", 6);
  const dailyCount = Number(process.env.DAILY_TX_COUNT ?? "5");

  const [deployer] = await ethers.getSigners();

  console.log("─".repeat(72));
  console.log(`Network:            ${preset.label} (chainId ${chainId})`);
  console.log(`Deployer:           ${deployer.address}`);
  console.log(`Diamond:            ${diamond}`);
  console.log(`USDC (settlement):  ${usdc}`);
  console.log(`Burn token:         ${reserve}`);
  console.log(`Receipt mode:       ${receiptMode ? "ON (testnet)" : "off"}`);
  console.log(`TokenMessengerV2:   ${tokenMessenger}`);
  console.log(`Solana domain:      ${SOLANA_DOMAIN}`);
  console.log(`Treasury USDC ATA:  ${treasuryAta}`);
  console.log(`Per-tx limit:       ${ethers.formatUnits(txLimit, 6)} USDC`);
  console.log(`Daily count:        ${dailyCount}`);
  console.log("─".repeat(72));

  if (isMainnet) {
    // `owner` is immutable — deploying from the wrong key means a full redeploy
    // AND a re-whitelist.
    const want = req("DEPLOY_OWNER");
    if (want.toLowerCase() !== deployer.address.toLowerCase()) {
      throw new Error(`DEPLOY_OWNER ${want} != signer ${deployer.address}`);
    }
    if (receiptMode) {
      throw new Error(
        "receiptMode must be OFF on mainnet. BRIDGE_RESERVE_TOKEN must equal USDC_ADDRESS."
      );
    }
  }

  // ── Preflight: is the burn token actually burnable? ────────────────────
  let burnable = false;
  try {
    const minter = await new ethers.Contract(tokenMessenger, TM_ABI, deployer).localMinter();
    const limit = await new ethers.Contract(minter, MINTER_ABI, deployer).burnLimitsPerMessage(
      reserve
    );
    burnable = limit > 0n;
    console.log(
      burnable
        ? `CCTP:               ✅ burnable, per-tx limit ${ethers.formatUnits(limit, 6)}`
        : `CCTP:               ⚠️  NOT burnable (burnLimitsPerMessage = 0)`
    );
  } catch (e) {
    console.log(`CCTP:               ⚠️  could not read minter: ${(e as Error).message}`);
  }

  if (isMainnet && !burnable) {
    throw new Error(
      `${reserve} is NOT CCTP-burnable on mainnet. Every burn would fail closed. Refusing to deploy.`
    );
  }
  if (!burnable) {
    console.log(
      `\n⚠️  The burn token is not CCTP-burnable here. Orders will complete and\n` +
        `   fail closed into fulfilled-but-unbridged, recoverable via retryBridge.\n` +
        `   To exercise real CCTP on Sepolia, set BRIDGE_RESERVE_TOKEN to Circle's\n` +
        `   testnet USDC (${preset.circleUsdc}) and pre-fund the integrator with it.\n`
    );
  }

  // ── Preflight: does the Diamond actually settle in the configured token? ─
  try {
    const bal = await new ethers.Contract(usdc, ERC20_ABI, deployer).balanceOf(diamond);
    console.log(`Settlement check:   Diamond holds ${ethers.formatUnits(bal, 6)} of USDC_ADDRESS`);
    if (isMainnet && bal === 0n) {
      throw new Error(`Diamond ${diamond} holds 0 of ${usdc} — wrong settlement token?`);
    }
  } catch (e) {
    if (isMainnet) throw e;
    console.log(`Settlement check:   ⚠️  ${(e as Error).message}`);
  }

  if (dryRun) {
    console.log("\nDRY_RUN=1 — all preflight checks passed. Nothing deployed.");
    return;
  }

  // ── Deploy ─────────────────────────────────────────────────────────────
  const integrator = await (
    await ethers.getContractFactory("StocksIntegrator")
  ).deploy(diamond, usdc, tokenMessenger, reserve, treasuryAta, SOLANA_DOMAIN, txLimit, dailyCount);
  await integrator.waitForDeployment();
  const addr = await integrator.getAddress();

  // `waitForDeployment` only proves the receipt exists. A public RPC behind a
  // load balancer can still answer a read from a node that has not caught up,
  // returning "0x" and failing to decode — which is exactly what happened on
  // the first Base Sepolia deploy, aborting the script AFTER a good contract
  // was already on chain and before any stock was enabled. Retry the first
  // read rather than throwing away a deployment over RPC lag.
  const proxyImpl = await retryRead(() => integrator.proxyImpl(), "proxyImpl()");

  console.log(`\n✅ StocksIntegrator:  ${addr}`);
  console.log(`   proxyImpl:         ${proxyImpl}`);

  // ── Enable the deliverable stocks ──────────────────────────────────────
  for (const s of STOCKS) {
    const tx = await integrator.setStockEnabled(s.id, true);
    await tx.wait();
    console.log(`   enabled #${s.id} ${s.symbol}`);
  }

  // Assert Fast Transfer really is on: it needs BOTH the finality threshold and
  // a non-zero fee budget. The constructor sets both; verify rather than trust.
  const finality = await integrator.bridgeMinFinalityThreshold();
  const feeBps = await integrator.bridgeMaxFeeBps();
  if (finality !== 1000n || feeBps === 0n) {
    console.log(`\n⚠️  Fast Transfer NOT engaged (finality=${finality}, maxFeeBps=${feeBps}).`);
    console.log(`   Burns will take ~13-19 min instead of ~8-20s.`);
  } else {
    console.log(`   Fast Transfer:     ✅ finality=${finality}, maxFeeBps=${feeBps}`);
  }

  // ── Register on the Diamond (super-admin only) ─────────────────────────
  // usdcThroughIntegrator = FALSE: the onramp pins recipientAddr = the
  // integrator itself, so completion routes the USDC here without the flag.
  try {
    const d = new ethers.Contract(
      diamond,
      ["function registerIntegrator(address,bool,address) external"],
      deployer
    );
    const tx = await d.registerIntegrator(addr, false, proxyImpl);
    await tx.wait();
    console.log(`   Registered on the Diamond (usdcThroughIntegrator = false)`);
  } catch (e) {
    console.log(
      `\n⚠️  Could not self-register: ${(e as Error).message.split("\n")[0]}\n` +
        `   This is expected unless the deployer is the Diamond super-admin.\n` +
        `   File a whitelist request instead — see docs/WHITELISTING.md, or run\n` +
        `   the repo's /whitelist-request skill with this address.`
    );
  }

  console.log("\n── Next ──────────────────────────────────────────────────────");
  console.log(
    `1. Verify:  npx hardhat verify --network ${isMainnet ? "base" : "baseSepolia"} ${addr} \\`
  );
  console.log(`      ${diamond} ${usdc} ${tokenMessenger} ${reserve} \\`);
  console.log(`      ${treasuryAta} ${SOLANA_DOMAIN} ${txLimit} ${dailyCount}`);
  console.log(`2. File the whitelist request (see docs/WHITELISTING.md).`);
  if (receiptMode) {
    console.log(`3. Pre-fund the integrator with Circle testnet USDC:`);
    console.log(`      ${reserve} -> ${addr}   (faucet: faucet.circle.com)`);
  }
  console.log(`4. Put STOCKS_INTEGRATOR_ADDRESS=${addr} in the app .env`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
