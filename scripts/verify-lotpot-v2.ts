import { ethers, artifacts } from "hardhat";

// Deployed V2 addresses provided by the operator.
const V2 = "0xE0799E201f9Ab48C35123839ec2b4Acfb1da4d48";
const PROXY_IMPL = "0x63429F2793F844C3161d18Ff24c309e87458cf19";

// Known Base mainnet references (from docs/integrators/lotpot.md).
const REF = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  MEGAPOT: "0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2",
  BATCH: "0x01774B531591b286b9f02C6Bc02ab3fD9526Aa76",
  NFT: "0x48FfE35AbB9f4780a4f1775C2Ce1c46185b366e4",
};

function eq(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

async function main() {
  const provider = ethers.provider;
  const net = await provider.getNetwork();
  console.log("Network chainId:", net.chainId.toString());

  // ── 1. proxyImpl bytecode parity (the security gate) ──────────────
  const onchainProxyCode = await provider.getCode(PROXY_IMPL);
  const localProxy = await artifacts.readArtifact("UserProxy");
  const onchainHash = ethers.keccak256(onchainProxyCode);
  const localHash = ethers.keccak256(localProxy.deployedBytecode);
  console.log("\n── proxyImpl bytecode parity ──");
  console.log("  on-chain runtime keccak:", onchainHash);
  console.log("  repo UserProxy keccak:  ", localHash);
  console.log("  MATCH:", onchainHash === localHash ? "YES ✅" : "NO ❌");

  // ── 2. integrator deployed? ───────────────────────────────────────
  const v2Code = await provider.getCode(V2);
  console.log("\n── integrator ──");
  console.log("  has code:", v2Code !== "0x");

  const v2 = await ethers.getContractAt("LotPotCheckoutIntegratorV2", V2);

  const [
    owner,
    diamond,
    usdc,
    megapot,
    batch,
    nft,
    proxyImpl,
    grantVault,
    fallbackVault,
    source,
    baseTxLimit,
    dailyTxCountLimit,
  ] = await Promise.all([
    v2.owner(),
    v2.diamond(),
    v2.usdc(),
    v2.megapot(),
    v2.batchFacilitator(),
    v2.jackpotNft(),
    v2.proxyImpl(),
    v2.grantVault(),
    v2.fallbackVault(),
    v2.source(),
    v2.baseTxLimit(),
    v2.dailyTxCountLimit(),
  ]);

  console.log("\n── immutables / config ──");
  console.log("  owner:           ", owner);
  console.log("  diamond:         ", diamond);
  console.log(
    "  usdc:            ",
    usdc,
    eq(usdc, REF.USDC) ? "(✅ canonical USDC)" : "(⚠ unexpected)"
  );
  console.log("  megapot:         ", megapot, eq(megapot, REF.MEGAPOT) ? "(✅)" : "(⚠ unexpected)");
  console.log("  batchFacilitator:", batch, eq(batch, REF.BATCH) ? "(✅)" : "(⚠ unexpected)");
  console.log("  jackpotNft:      ", nft, eq(nft, REF.NFT) ? "(✅)" : "(⚠ unexpected)");
  console.log(
    "  proxyImpl getter:",
    proxyImpl,
    eq(proxyImpl, PROXY_IMPL) ? "(✅ matches given)" : "(❌ mismatch)"
  );
  console.log("  source(bytes32): ", source);
  try {
    console.log("  source(decoded): ", ethers.decodeBytes32String(source));
  } catch {
    /* non-utf8 */
  }
  console.log(
    "  baseTxLimit:     ",
    baseTxLimit.toString(),
    `(${ethers.formatUnits(baseTxLimit, 6)} USDC)`
  );
  console.log("  dailyTxCountLimit:", dailyTxCountLimit.toString());

  console.log("\n── V2 cashback wiring (inert until set) ──");
  console.log(
    "  grantVault:    ",
    grantVault,
    eq(grantVault, ethers.ZeroAddress) ? "(unset — primary leg disabled)" : ""
  );
  console.log(
    "  fallbackVault: ",
    fallbackVault,
    eq(fallbackVault, ethers.ZeroAddress) ? "(unset — fallback leg disabled)" : ""
  );
  // Is the Diamond a credit issuer yet?
  const diamondIsIssuer = await v2.creditIssuer(diamond);
  console.log(
    "  creditIssuer[diamond]:",
    diamondIsIssuer,
    diamondIsIssuer ? "(✅ wired)" : "(not yet wired)"
  );

  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
