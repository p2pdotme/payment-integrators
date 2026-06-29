import { ethers } from "hardhat";

const V2 = "0xE0799E201f9Ab48C35123839ec2b4Acfb1da4d48";
const DIAMOND = "0x4cad6eC90e65baBec9335cAd728DDC610c316368";
const GRANT = "0x1D925D6691F22899C66788Ea5ea8Af7dac924d14";
const FALLBACK = "0x778E615F607E6FdE12D150753f6baeC03Fcd7A72";
const BATCH = "0x01774B531591b286b9f02C6Bc02ab3fD9526Aa76";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

async function main() {
  const p = ethers.provider;

  // ── Diamond registration ──────────────────────────────────────────
  const dAbi = [
    "function getIntegratorConfig(address) view returns (tuple(bool isActive, bool usdcThroughIntegrator, uint256 activeOrderCount, address proxyImpl))",
  ];
  const d = new ethers.Contract(DIAMOND, dAbi, p);
  console.log("── Diamond registration (V2) ──");
  try {
    const cfg = await d.getIntegratorConfig(V2);
    console.log(
      "  isActive:             ",
      cfg.isActive,
      cfg.isActive ? "✅" : "❌ NOT whitelisted/active"
    );
    console.log(
      "  usdcThroughIntegrator:",
      cfg.usdcThroughIntegrator,
      cfg.usdcThroughIntegrator === false
        ? "✅ (must be false for LotPot)"
        : "❌ MUST be false for LotPot!"
    );
    console.log("  activeOrderCount:     ", cfg.activeOrderCount.toString());
    console.log("  proxyImpl:            ", cfg.proxyImpl);
  } catch (e: any) {
    console.log("  getIntegratorConfig reverted/failed:", e.shortMessage || e.message);
  }

  // ── Vault wiring ──────────────────────────────────────────────────
  const vAbi = [
    "function owner() view returns (address)",
    "function approvedSpender(address) view returns (bool)",
    "function USDC() view returns (address)",
  ];
  const erc20 = ["function balanceOf(address) view returns (uint256)"];
  const usdc = new ethers.Contract(USDC, erc20, p);

  for (const [name, addr] of [
    ["grant", GRANT],
    ["fallback", FALLBACK],
  ] as const) {
    console.log(`\n── ${name} vault ${addr} ──`);
    const code = await p.getCode(addr);
    if (code === "0x") {
      console.log("  ❌ NO CODE at this address");
      continue;
    }
    const v = new ethers.Contract(addr, vAbi, p);
    try {
      const [owner, approved, vusdc, bal] = await Promise.all([
        v.owner(),
        v.approvedSpender(V2),
        v.USDC(),
        usdc.balanceOf(addr),
      ]);
      console.log("  owner:               ", owner);
      console.log(
        "  USDC():              ",
        vusdc,
        vusdc.toLowerCase() === USDC.toLowerCase() ? "✅" : "⚠ unexpected"
      );
      console.log(
        "  approvedSpender[V2]: ",
        approved,
        approved
          ? "✅ integrator can release()"
          : "❌ releases will REVERT → cashback silently degrades"
      );
      console.log(
        "  USDC balance:        ",
        ethers.formatUnits(bal, 6),
        "USDC",
        bal === 0n ? "(empty — nothing to release yet)" : ""
      );
    } catch (e: any) {
      console.log("  not a GrantVault-shaped contract? call failed:", e.shortMessage || e.message);
    }
  }

  // ── Megapot batch allowlist ───────────────────────────────────────
  console.log("\n── Megapot BatchPurchaseFacilitator allowlist ──");
  const bAbi = ["function isAllowed(address) view returns (bool)"];
  const b = new ethers.Contract(BATCH, bAbi, p);
  try {
    const allowed = await b.isAllowed(V2);
    console.log(
      "  isAllowed[V2]:",
      allowed,
      allowed
        ? "✅ >10-ticket orders can fulfill"
        : "❌ NOT allowlisted → batch (>10) orders will skip-and-strand"
    );
  } catch (e: any) {
    console.log("  isAllowed failed:", e.shortMessage || e.message);
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
