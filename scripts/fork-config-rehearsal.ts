/**
 * REHEARSAL on a LOCAL COPY of Base mainnet. Nothing reaches mainnet.
 * Deploys the round-3 integrator (this checkout) as a test deployer, then runs
 * configure-from-v2 against it: dry run (with a Safe batch file), then APPLY, then the
 * read-back must equal V2 on every setting.
 *
 *   npx hardhat node --port 8546 --fork <BASE_MAINNET_RPC>
 *   npx hardhat run scripts/fork-config-rehearsal.ts --network fork
 */
import { ethers, network } from "hardhat";
import { configureFromV2 } from "./configure-from-v2";

const DIAMOND = "0x4cad6eC90e65baBec9335cAd728DDC610c316368";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const V2 = "0xA012B6D5D6d74224C3B046780965D5EC7AAB20a5";

async function main() {
  if (network.name !== "fork") throw new Error("fork only");
  const meta: any = await network.provider.send("hardhat_metadata", []);
  if (Number(meta?.forkedNetwork?.chainId) !== 8453) throw new Error("not a local copy of Base mainnet");
  await network.provider.send("evm_mine", []);
  const [deployer] = await ethers.getSigners();
  console.log(`Local copy of Base mainnet at block ${meta.forkedNetwork.forkBlockNumber}; test deployer ${deployer.address}`);

  // Deploy as the deploy script does: 4 libraries, the integrator, then V2 as the previous integrator.
  const libs: Record<string, string> = {};
  let gas = 0n;
  for (const n of ["PaymentLinksLib", "MerchantRegistryLib", "SettlementLib", "MerchantImportLib"]) {
    const c = await (await ethers.getContractFactory(n)).deploy();
    gas += BigInt((await c.deploymentTransaction()!.wait())!.gasUsed);
    libs[n] = await c.getAddress();
  }
  // Third argument = EXTRA OWNERS (none here). Previous integrators are a separate
  // call, as in scripts/deploy-merchant-terminal.ts (which also copies V2's roles).
  const I: any = await (await ethers.getContractFactory("MerchantTerminalIntegrator", { libraries: libs })).deploy(DIAMOND, USDC, []);
  gas += BigInt((await I.deploymentTransaction()!.wait())!.gasUsed);
  const IA = await I.getAddress();
  gas += BigInt((await (await I.setPreviousIntegrators([V2])).wait()).gasUsed);
  console.log(`New integrator (copy only): ${IA}; deploy gas (4 libraries + integrator): ${gas}`);

  console.log("\n=== 1. Dry run (what differs from V2 on a fresh contract) ===");
  await configureFromV2({ newIntegrator: IA, apply: false, safeJson: process.env.SAFE_JSON_OUT });

  console.log("\n=== 2. Apply as the super admin, then read back ===");
  const res = await configureFromV2({ newIntegrator: IA, apply: true, signer: deployer });

  console.log("\n=== 3. Dry run again (must find nothing to do) ===");
  const again = await configureFromV2({ newIntegrator: IA, apply: false });
  const nothingLeft = again.rows.every((r: any) => r[3]);
  console.log(nothingLeft ? "Nothing left to change." : "Something still differs!");
  if (!res.ok || !nothingLeft) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
