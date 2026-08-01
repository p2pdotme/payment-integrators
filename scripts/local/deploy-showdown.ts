import { ethers } from "hardhat";

/**
 * Deploy + whitelist ShowdownCheckoutIntegrator: a two-way fiat <-> USDC ramp
 * whose user-facing asset lives on Solana, bridged with Circle CCTP V2.
 *
 *   ShowdownCheckoutIntegrator
 *   → register on the Diamond (usdcThroughIntegrator = FALSE; the onramp pins
 *     recipientAddr = the integrator itself, so completion routes the purchased
 *     USDC here for burning without needing the flag)
 *   → set the simple-kyc attestor signers (liveness + KYC services)
 *
 * Limits are enforced on-chain as a (tier x region) matrix, where region is
 * derived from the order's fiat currency — INR is India, everything else Abroad:
 *
 *     liveness           $20 India / $50  Abroad
 *     passport+liveness  $100 India / $200 Abroad
 *     5 orders/day per user, budgeted separately for onramp and offramp
 *
 * Each of those five numbers is ALSO an immutable MAX_* constant in the
 * bytecode. The constructor and the owner's setters can only ever go at or
 * below them, so the policy holds against a compromised attestor key AND a
 * compromised owner key. Pass lower values here to launch tighter than policy;
 * the owner can lower further later, never raise.
 *
 * ── CCTP / token caveat on Base Sepolia ────────────────────────────────────
 * CCTP burns only Circle-issued USDC. The Base Sepolia Diamond settles in a
 * mock token (GoofyGoober, 0x4095fE…), which Circle's TokenMinter will not burn
 * (`burnLimitsPerMessage == 0`). Deploying against the Diamond therefore gives a
 * live order flow whose bridge leg fails closed: orders complete, the USDC is
 * held and reserved against `unbridgedTotal`, and `retryBridge` /
 * `userRescueStuckBridge` keep it recoverable. On Base mainnet, where the
 * Diamond settles in real USDC, the same code bridges for real.
 *
 * The script reports whether USDC_ADDRESS is CCTP-burnable before deploying.
 *
 * Signer = deployer = Diamond super-admin (contracts-v4 MNEMONIC_KEY).
 *
 * ── Addresses ──────────────────────────────────────────────────────────────
 * Everything network-specific is preset below and picked by chainId, so the
 * mainnet deploy needs no address arguments at all:
 *
 *   LIVENESS_ATTESTOR=0x... KYC_ATTESTOR=0x... \
 *   npx hardhat run scripts/local/deploy-showdown.ts --network base
 *
 * Any preset can still be overridden by the matching env var. Base Sepolia has
 * no Diamond/USDC preset (they move around) — pass DIAMOND_ADDRESS and
 * USDC_ADDRESS there, as before.
 *
 * Full form:
 *   [DIAMOND_ADDRESS=0x...] [USDC_ADDRESS=0x...] \
 *   LIVENESS_ATTESTOR=0x... KYC_ATTESTOR=0x... \
 *   [TOKEN_MESSENGER=0x...] [MESSAGE_TRANSMITTER=0x...] \
 *   [SOLANA_DOMAIN=5] [DAILY_TX_COUNT_LIMIT=5] \
 *   [LIVENESS_CAP_INDIA=20000000] [LIVENESS_CAP_ABROAD=50000000] \
 *   [KYC_CAP_INDIA=100000000] [KYC_CAP_ABROAD=200000000] \
 *   [DEPLOY_OWNER=0x...] [SKIP_REGISTER=false] \
 *   npx hardhat run scripts/local/deploy-showdown.ts --network baseSepolia
 */

/**
 * Network presets.
 *
 * CCTP V2 addresses differ between mainnet and testnet — the testnet pair is
 * shared by every supported EVM testnet, which makes it easy to carry over by
 * mistake. They have NO CODE on Base mainnet, so a burn would simply never
 * happen: the silent failure mode this preset table exists to prevent.
 *
 * Base mainnet values verified on-chain 2026-07-27 via `mainnet.base.org`:
 *   - TokenMessengerV2 `0x28b5…cf5d`: has code; `messageBodyVersion() == 1` (V2);
 *     `localMinter() == 0xfd78EE919681417d192449715b2594ab58f5D002`; and
 *     `remoteTokenMessengers(5)` is populated, i.e. the Solana route exists.
 *   - That minter reports `burnLimitsPerMessage(USDC) == 10_000_000e6`, so
 *     canonical Base USDC is genuinely burnable (contrast Base Sepolia, where
 *     the Diamond's GoofyGoober reports 0).
 *   - MessageTransmitterV2 `0x81D4…4B64`: has code; `localDomain() == 6` (Base);
 *     `version() == 1` (V2).
 *   - USDC `0x8335…2913`: name "USD Coin", symbol "USDC", decimals 6.
 *   - Diamond `0x4cad…6368`: has code and holds canonical USDC, i.e. it settles
 *     in the same token CCTP burns — the single-token assumption this contract
 *     is built on.
 */
const PRESETS: Record<
  number,
  {
    label: string;
    diamond?: string;
    usdc?: string;
    tokenMessenger: string;
    messageTransmitter: string;
  }
> = {
  8453: {
    label: "Base mainnet",
    diamond: "0x4cad6eC90e65baBec9335cAd728DDC610c316368",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    tokenMessenger: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
    messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  },
  84532: {
    label: "Base Sepolia",
    // No Diamond/USDC preset — the testnet Diamond settles in a mock token
    // (GoofyGoober) that CCTP will not burn. Pass both explicitly.
    tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
    messageTransmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
  },
};

const SOLANA_DOMAIN = Number(process.env.SOLANA_DOMAIN || 5);
const DAILY_TX_COUNT_LIMIT = process.env.DAILY_TX_COUNT_LIMIT || "5";
const LIVENESS_CAP_INDIA = process.env.LIVENESS_CAP_INDIA || "20000000"; // $20
const LIVENESS_CAP_ABROAD = process.env.LIVENESS_CAP_ABROAD || "50000000"; // $50
const KYC_CAP_INDIA = process.env.KYC_CAP_INDIA || "100000000"; // $100
const KYC_CAP_ABROAD = process.env.KYC_CAP_ABROAD || "200000000"; // $200
const LIVENESS_ATTESTOR = process.env.LIVENESS_ATTESTOR || "";
const KYC_ATTESTOR = process.env.KYC_ATTESTOR || "";
const SKIP_REGISTER = process.env.SKIP_REGISTER === "true";
/** Run every preflight check and print the resolved config, then stop. */
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

const REGISTER_ABI = [
  "function registerIntegrator(address integrator, bool usdcThroughIntegrator, address proxyImpl)",
  "function getIntegratorConfig(address) view returns (tuple(bool isActive, bool usdcThroughIntegrator, uint256 activeOrderCount, address proxyImpl))",
];
const MINTER_ABI = ["function burnLimitsPerMessage(address) view returns (uint256)"];
const TM_ABI = ["function localMinter() view returns (address)"];

const f = (n: bigint) => ethers.formatUnits(n, 6);

async function main() {
  if (!LIVENESS_ATTESTOR || !KYC_ATTESTOR)
    throw new Error("LIVENESS_ATTESTOR + KYC_ATTESTOR required (simple-kyc signers / demo key)");

  const [deployer] = await ethers.getSigners();
  const me = await deployer.getAddress();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const isMainnet = chainId === 8453;

  // ── Resolve addresses: explicit env var wins, else the network preset. ────
  const preset = PRESETS[chainId];
  if (!preset) {
    throw new Error(
      `No preset for chainId ${chainId}. Add one, or pass TOKEN_MESSENGER + ` +
        `MESSAGE_TRANSMITTER + DIAMOND_ADDRESS + USDC_ADDRESS explicitly.`
    );
  }
  const src: string[] = [];
  const pick = (envName: string, presetValue: string | undefined, what: string) => {
    const fromEnv = process.env[envName];
    const differs = fromEnv && presetValue && fromEnv.toLowerCase() !== presetValue.toLowerCase();

    // On MAINNET the verified preset wins by default. `.env` carries testnet
    // DIAMOND_ADDRESS / USDC_ADDRESS for day-to-day work and dotenv applies it to
    // every network, so honouring it here would silently point a mainnet deploy at
    // a testnet Diamond — the exact mistake this table exists to prevent. Opting
    // back in has to be deliberate.
    if (isMainnet && differs && process.env.ALLOW_ADDRESS_OVERRIDE !== "true") {
      console.log(
        `   ignoring ${envName}=${fromEnv} for ${what} — using the verified mainnet preset. ` +
          `Pass ALLOW_ADDRESS_OVERRIDE=true to use the env value instead.`
      );
      return presetValue as string;
    }
    if (fromEnv) {
      src.push(`${what}: ${envName}${differs ? " override" : ""}`);
      return fromEnv;
    }
    if (!presetValue) {
      throw new Error(`${envName} required on ${preset.label} — no preset for ${what}.`);
    }
    return presetValue;
  };
  const DIAMOND_ADDRESS = pick("DIAMOND_ADDRESS", preset.diamond, "Diamond");
  const USDC_ADDRESS = pick("USDC_ADDRESS", preset.usdc, "USDC");
  const TOKEN_MESSENGER = pick("TOKEN_MESSENGER", preset.tokenMessenger, "TokenMessengerV2");
  const MESSAGE_TRANSMITTER = pick(
    "MESSAGE_TRANSMITTER",
    preset.messageTransmitter,
    "MessageTransmitterV2"
  );

  console.log(`Network:              ${preset.label} (chainId ${chainId})`);
  console.log("Deployer / owner:    ", me);
  console.log("Diamond:             ", DIAMOND_ADDRESS);
  console.log("USDC (settle+burn):  ", USDC_ADDRESS);
  console.log("TokenMessengerV2:    ", TOKEN_MESSENGER);
  console.log("MessageTransmitterV2:", MESSAGE_TRANSMITTER);
  console.log("Solana domain:       ", SOLANA_DOMAIN);
  console.log(
    src.length ? `Overrides:            ${src.join(", ")}` : "Addresses:            all from preset"
  );
  console.log(
    `Caps: liveness $${f(BigInt(LIVENESS_CAP_INDIA))}/$${f(BigInt(LIVENESS_CAP_ABROAD))} ` +
      `kyc $${f(BigInt(KYC_CAP_INDIA))}/$${f(BigInt(KYC_CAP_ABROAD))} (India/Abroad), ` +
      `${DAILY_TX_COUNT_LIMIT}/day per direction`
  );

  // ── Mainnet guard: owner is immutable, so it must be right at deploy time. ─
  // DEPLOY_OWNER is MANDATORY on mainnet: `owner` becomes this signer forever
  // (no transfer, no renounce), so a deploy from the wrong key is a full
  // redeploy + re-whitelist. Refuse to guess rather than warn-and-proceed.
  if (isMainnet) {
    if (!process.env.DEPLOY_OWNER) {
      throw new Error(
        "DEPLOY_OWNER is required on mainnet. `owner` is immutable — it becomes the deploy signer " +
          "forever, with no transfer and no renounce. Set DEPLOY_OWNER to the intended Showdown " +
          "multisig and deploy FROM it."
      );
    }
    // Under DRY_RUN nothing can deploy, so a read-only mainnet preflight must
    // not require the real owner key in hand — skip the signer-identity
    // assertion (the DEPLOY_OWNER presence check above still applies).
    if (!DRY_RUN && me.toLowerCase() !== process.env.DEPLOY_OWNER.toLowerCase()) {
      throw new Error(
        `owner is immutable and is set to the deployer (${me}), but DEPLOY_OWNER is ` +
          `${process.env.DEPLOY_OWNER}. Deploy FROM the intended owner — it cannot be transferred.`
      );
    }
    console.log(
      DRY_RUN
        ? "Owner check:          ✅ DEPLOY_OWNER set (signer identity skipped under DRY_RUN)"
        : "Owner check:          ✅ signer matches DEPLOY_OWNER"
    );
  }

  // solanaDomain is immutable and CCTP domain IDs are network-agnostic — Solana
  // is 5 on devnet exactly as on mainnet — so this guard applies on EVERY
  // network, testnets included (where we actually iterate). A stray
  // SOLANA_DOMAIN in a shared .env would bake a wrong destination in silently:
  // the route preflight below only checks *routability*, not that the domain is
  // Solana, so e.g. SOLANA_DOMAIN=0 (Ethereum) passes and every onramp then
  // burns to an EVM chain with the 32-byte ATA truncated — unrecoverable.
  // Deliberate overrides use ALLOW_DOMAIN_OVERRIDE — its own flag, NOT
  // ALLOW_ADDRESS_OVERRIDE, so overriding a CCTP address never silently
  // disables the domain check too.
  if (SOLANA_DOMAIN !== 5 && process.env.ALLOW_DOMAIN_OVERRIDE !== "true") {
    throw new Error(
      `SOLANA_DOMAIN is ${SOLANA_DOMAIN}, not 5 (Solana). It is baked into an immutable and a wrong ` +
        `value silently loses every onramp's funds. Pass ALLOW_DOMAIN_OVERRIDE=true only if you ` +
        `genuinely intend a non-Solana destination.`
    );
  }

  // Whether the settlement token is actually CCTP-burnable decides whether the
  // bridge leg can run at all. On mainnet a `0` here means every onramp would
  // complete and then never reach Solana, so refuse rather than warn.
  const minter = await new ethers.Contract(TOKEN_MESSENGER, TM_ABI, deployer).localMinter();
  const burnLimit: bigint = await new ethers.Contract(
    minter,
    MINTER_ABI,
    deployer
  ).burnLimitsPerMessage(USDC_ADDRESS);
  if (burnLimit === 0n && isMainnet) {
    throw new Error(
      `${USDC_ADDRESS} is NOT CCTP-burnable (burnLimitsPerMessage = 0) via minter ${minter}. ` +
        `On mainnet that means every onramp would complete and then fail to reach Solana. ` +
        `Check USDC_ADDRESS is canonical Circle USDC and TOKEN_MESSENGER is the Base mainnet ` +
        `TokenMessengerV2 — the testnet pair has no code on mainnet and would fail here.`
    );
  }
  if (burnLimit === 0n) {
    console.log(
      `\n⚠️  ${USDC_ADDRESS} is NOT a CCTP-burnable token (burnLimitsPerMessage = 0).\n` +
        `   Order flow + KYC tiers will work; every bridge attempt will fail closed into\n` +
        `   fulfilled-but-unbridged and stay recoverable via retryBridge / userRescueStuckBridge.`
    );
  } else {
    console.log(`\n✅ CCTP burnable, per-tx burn limit: ${f(burnLimit)} USDC`);
  }

  // The destination domain must actually be routable from here, or the burn
  // authorizes a mint no one can execute.
  const remote: string = await new ethers.Contract(
    TOKEN_MESSENGER,
    ["function remoteTokenMessengers(uint32) view returns (bytes32)"],
    deployer
  ).remoteTokenMessengers(SOLANA_DOMAIN);
  if (/^0x0*$/.test(remote)) {
    const msg = `TokenMessengerV2 has no remote messenger for domain ${SOLANA_DOMAIN} — burns to it can never be minted.`;
    if (isMainnet) throw new Error(msg);
    console.log(`⚠️  ${msg}`);
  } else {
    console.log(`✅ Solana route present: remoteTokenMessengers(${SOLANA_DOMAIN}) = ${remote}`);
  }

  if (DRY_RUN) {
    console.log(
      "\n✅ DRY_RUN: preflight passed. Nothing deployed. Re-run without DRY_RUN to deploy."
    );
    return;
  }

  // 1. Integrator.
  console.log("\nDeploying ShowdownCheckoutIntegrator…");
  const Integ = await ethers.getContractFactory("ShowdownCheckoutIntegrator");
  const integrator = await Integ.deploy(
    DIAMOND_ADDRESS,
    USDC_ADDRESS,
    TOKEN_MESSENGER,
    MESSAGE_TRANSMITTER,
    SOLANA_DOMAIN,
    BigInt(DAILY_TX_COUNT_LIMIT),
    LIVENESS_ATTESTOR,
    KYC_ATTESTOR,
    BigInt(LIVENESS_CAP_INDIA),
    BigInt(LIVENESS_CAP_ABROAD),
    BigInt(KYC_CAP_INDIA),
    BigInt(KYC_CAP_ABROAD)
  );
  await integrator.deploymentTransaction()?.wait(2);
  const integratorAddr = await integrator.getAddress();
  const proxyImpl = await integrator.proxyImpl();
  console.log("  ShowdownCheckoutIntegrator:", integratorAddr);
  console.log("  proxyImpl:                 ", proxyImpl);

  // 2. Register on the Diamond — usdcThroughIntegrator = FALSE.
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
    if (!cfg.isActive || cfg.usdcThroughIntegrator !== false) {
      throw new Error("unexpected integrator config after registration");
    }
  }

  console.log("\n=== Showdown deployment ===");
  console.log(`ShowdownCheckoutIntegrator: ${integratorAddr}`);
  console.log(`proxyImpl:                  ${proxyImpl}`);
  console.log(
    `bytecode hash:              ${ethers.keccak256(await ethers.provider.getCode(integratorAddr))}`
  );
  console.log("\n--- demo app .env ---");
  console.log(`VITE_SHOWDOWN_INTEGRATOR_ADDRESS=${integratorAddr}`);
  console.log(`VITE_DIAMOND_ADDRESS=${DIAMOND_ADDRESS}`);
  console.log(`VITE_USDC_ADDRESS=${USDC_ADDRESS}`);
  console.log("\n--- verify ---");
  console.log(
    `npx hardhat verify --network ${isMainnet ? "base" : "baseSepolia"} ${integratorAddr} ${DIAMOND_ADDRESS} ${USDC_ADDRESS} ${TOKEN_MESSENGER} ${MESSAGE_TRANSMITTER} ${SOLANA_DOMAIN} ${DAILY_TX_COUNT_LIMIT} ${LIVENESS_ATTESTOR} ${KYC_ATTESTOR} ${LIVENESS_CAP_INDIA} ${LIVENESS_CAP_ABROAD} ${KYC_CAP_INDIA} ${KYC_CAP_ABROAD}`
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
