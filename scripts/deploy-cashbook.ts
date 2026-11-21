import { ethers } from "hardhat";

/**
 * Deploy CashbookRampIntegrator.
 *
 * Deploys only. It does not register the integrator, set a circle, or fund the
 * reward pool: registration is the Diamond super admin's call, and the rest is
 * the owner's (a Safe on mainnet) once it is registered.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-cashbook.ts --network base
 *   DRY_RUN=1 npx hardhat run scripts/deploy-cashbook.ts --network base
 *
 * Env (all required; the Base mainnet preset fills DIAMOND, USDC and RM):
 *   DIAMOND_ADDRESS     the p2p.me Diamond
 *   USDC_ADDRESS        the Diamond's USDC
 *   OWNER_ADDRESS       becomes the owner (Ownable2Step): setCircle, rewardStake
 *                       (batches), withdrawRewards. Never the deployer by default.
 *   REPUTATION_MANAGER  the Diamond's ReputationManager, for the user blacklist.
 *                       The zero address turns the check off; pass it explicitly.
 *
 * Requires the Diamond to have registerFor / stakeFor (an integrator opening or
 * topping up a merchant account for someone else). Without them every
 * stakeDeposit reverts and delivered USDC waits on the contract until they exist.
 */

const PRESETS: Record<number, { label: string; diamond?: string; usdc?: string; rm?: string }> = {
  8453: {
    label: "Base mainnet",
    diamond: "0x4cad6eC90e65baBec9335cAd728DDC610c316368",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    rm: "0xCF613e08EE1B4c2669DdCf06A7d22c9856f6Aa1D",
  },
  84532: { label: "Base Sepolia" },
};

const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

function need(name: string, value: string): string {
  if (!ethers.isAddress(value)) throw new Error(`${name} missing or not an address: "${value}"`);
  return value;
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const preset = PRESETS[chainId];
  if (!preset) throw new Error(`Unsupported chainId ${chainId}; expected 8453 or 84532`);
  console.log(`Network: ${preset.label} (${chainId})${DRY_RUN ? "  ** DRY RUN **" : ""}`);

  const diamond = need("DIAMOND_ADDRESS", process.env.DIAMOND_ADDRESS || preset.diamond || "");
  const usdc = need("USDC_ADDRESS", process.env.USDC_ADDRESS || preset.usdc || "");
  const owner = need("OWNER_ADDRESS", process.env.OWNER_ADDRESS || "");
  const rm = need("REPUTATION_MANAGER", process.env.REPUTATION_MANAGER || preset.rm || "");

  console.log(`  Diamond            ${diamond}`);
  console.log(`  USDC               ${usdc}`);
  console.log(`  Owner              ${owner}`);
  console.log(
    `  ReputationManager  ${rm}${rm === ethers.ZeroAddress ? "  ** USER BLACKLIST OFF **" : ""}`
  );
  if (DRY_RUN) return;

  const Factory = await ethers.getContractFactory("CashbookRampIntegrator");
  const integrator = await Factory.deploy(diamond, usdc, owner, rm);
  await integrator.deploymentTransaction()?.wait(3);
  const address = await integrator.getAddress();
  const code = await ethers.provider.getCode(address);
  if (code === "0x") throw new Error(`No code at ${address}`);

  // The immutables cannot be fixed after deploy; check them before anyone relies on them.
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!same(await integrator.diamond(), diamond)) throw new Error("diamond() mismatch. ABORT.");
  if (!same(await integrator.usdc(), usdc)) throw new Error("usdc() mismatch. ABORT.");
  if (!same(await integrator.reputationManager(), rm)) throw new Error("RM mismatch. ABORT.");
  if (!same(await integrator.owner(), owner)) throw new Error("owner() mismatch. ABORT.");

  // The user blacklist decodes a struct we do not control; prove it on this chain.
  if (rm !== ethers.ZeroAddress) {
    const r = new ethers.Contract(
      rm,
      ["function rmusers(address) view returns (uint256,uint256,bool)"],
      ethers.provider
    );
    const probe = await r.rmusers(owner);
    if (probe.length !== 3 || typeof probe[2] !== "boolean") {
      throw new Error("rmusers() did not decode as (uint256,uint256,bool). ABORT.");
    }
  }

  const proxyImpl = await integrator.proxyImpl();
  console.log("\n=== Deployed ===");
  console.log(`Integrator:            ${address}`);
  console.log(`proxyImpl:             ${proxyImpl}`);
  console.log(`Runtime bytecode hash: ${ethers.keccak256(code)}`);

  console.log("\n=== Whitelist request (registerIntegrator) ===");
  console.log(`integrator:            ${address}`);
  console.log(`proxyImpl:             ${proxyImpl}`);
  console.log("usdcThroughIntegrator: false   (recipientAddr is this contract)");

  console.log("\n=== Then, from the owner ===");
  console.log("setCircle(currency, circleId)   per currency, before any opening deposit");
  console.log("fundRewards(amount)             anyone, after approving USDC");
  console.log("rewardStake(people[], amounts[])  owner, in batches");

  console.log("\n=== Verify ===");
  console.log(
    `npx hardhat verify --network ${chainId === 8453 ? "base" : "baseSepolia"} ${address} ${diamond} ${usdc} ${owner} ${rm}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
