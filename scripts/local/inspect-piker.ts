import { ethers, artifacts } from "hardhat";

/**
 * Read-only verification of the deployed PikerOnrampIntegrator on Base Sepolia.
 * Confirms immutables + bytecode parity vs the reviewed PR source (masking the
 * immutable byte-ranges), and reads the Diamond's current registration config.
 */
const ADDR = process.env.PIKER || "0xEaD7aF84b4c778008E09846809344c0703c2DBb4";
const FQN = "contracts/integrators/piker/PikerOnrampIntegrator.sol:PikerOnrampIntegrator";
const DIAMOND = process.env.DIAMOND_ADDRESS || "0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9";

function stripMetadata(hex: string): string {
  const len = parseInt(hex.slice(-4), 16);
  const cut = (len + 2) * 2;
  return cut >= hex.length ? hex : hex.slice(0, hex.length - cut);
}
function maskImmutables(hex: string, refs: Record<string, { start: number; length: number }[]>) {
  const arr = hex.split("");
  for (const id of Object.keys(refs))
    for (const { start, length } of refs[id])
      for (let i = start * 2; i < (start + length) * 2; i++) arr[i] = "0";
  return arr.join("");
}

async function main() {
  const provider = ethers.provider;
  console.log("network:", (await provider.getNetwork()).chainId.toString(), "| integrator:", ADDR);

  const onchainRaw = await provider.getCode(ADDR);
  if (onchainRaw === "0x") throw new Error("NO CODE at address");
  const onchain = onchainRaw.slice(2);

  const abi = [
    "function diamond() view returns (address)",
    "function usdc() view returns (address)",
    "function owner() view returns (address)",
    "function proxyImpl() view returns (address)",
    "function baseTxLimit() view returns (uint256)",
    "function dailyTxCountLimit() view returns (uint256)",
  ];
  const c = new ethers.Contract(ADDR, abi, provider);
  const [diamond, usdc, owner, proxyImpl, baseTx, daily] = await Promise.all([
    c.diamond(),
    c.usdc(),
    c.owner(),
    c.proxyImpl(),
    c.baseTxLimit(),
    c.dailyTxCountLimit(),
  ]);
  console.log("--- integrator config ---");
  console.log(
    "diamond:          ",
    diamond,
    diamond.toLowerCase() === DIAMOND.toLowerCase() ? "✓ our test Diamond" : "✗ MISMATCH"
  );
  console.log("usdc:             ", usdc);
  console.log("owner:            ", owner);
  console.log("proxyImpl:        ", proxyImpl);
  console.log("baseTxLimit:      ", ethers.formatUnits(baseTx, 6), "USDC");
  console.log("dailyTxCountLimit:", daily.toString());

  // Bytecode parity (immutables masked).
  const buildInfo = await artifacts.getBuildInfo(FQN);
  const out: any =
    buildInfo!.output.contracts["contracts/integrators/piker/PikerOnrampIntegrator.sol"][
      "PikerOnrampIntegrator"
    ];
  const refs = out.evm.deployedBytecode.immutableReferences || {};
  const nRefs = Object.values(refs).reduce((a: number, r: any) => a + r.length, 0);
  const art = await artifacts.readArtifact("PikerOnrampIntegrator");
  const localMasked = stripMetadata(maskImmutables(art.deployedBytecode.slice(2), refs));
  const onchainMasked = stripMetadata(maskImmutables(onchain, refs));
  console.log("--- bytecode parity (immutables masked) ---");
  console.log("immutable slots masked:", nRefs);
  console.log("code-only MATCH:       ", localMasked === onchainMasked);

  // Current registration state on the Diamond.
  const dAbi = [
    "function getIntegratorConfig(address) view returns (tuple(bool isActive, bool usdcThroughIntegrator, uint256 activeOrderCount, address proxyImpl))",
  ];
  try {
    const d = new ethers.Contract(DIAMOND, dAbi, provider);
    const cfg = await d.getIntegratorConfig(ADDR);
    console.log("--- diamond registration (current) ---");
    console.log(
      "isActive:",
      cfg.isActive,
      "| usdcThroughIntegrator:",
      cfg.usdcThroughIntegrator,
      "| proxyImpl:",
      cfg.proxyImpl
    );
  } catch (e: any) {
    console.log(
      "--- diamond registration: could not read getIntegratorConfig:",
      e.message?.slice(0, 80)
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
