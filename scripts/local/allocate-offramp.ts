import { ethers } from "hardhat";

/**
 * Relayer-side offramp allocation for UI testing. Calls allocateOfframp on the
 * v2 integrator, which pulls `amount` from the vault into the user's per-user
 * proxy and records an unsettled allocation. After this runs, the merchant-app
 * Cashout widget shows `availableOfframp(user)` = amount and the user can drive
 * the SELL.
 *
 * The signer (deployer mnemonic) must be the integrator's offrampRelayer.
 *
 * Usage:
 *   USER_ADDRESS=0x... INTEGRATOR_ADDRESS=0x... VAULT_ADDRESS=0x... USDC_ADDRESS=0x... \
 *   [OFFRAMP_AMOUNT=5000000] \
 *   npx hardhat run scripts/local/allocate-offramp.ts --network baseSepolia
 */

const USER_ADDRESS = process.env.USER_ADDRESS || "";
const INTEGRATOR_ADDRESS = process.env.INTEGRATOR_ADDRESS || "";
const VAULT_ADDRESS = process.env.VAULT_ADDRESS || "";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "";
const OFFRAMP_AMOUNT = process.env.OFFRAMP_AMOUNT || "5000000"; // 5 USDC (6dp)

const fmt = (n: bigint) => ethers.formatUnits(n, 6);

async function main() {
  for (const [k, v] of Object.entries({
    USER_ADDRESS,
    INTEGRATOR_ADDRESS,
    VAULT_ADDRESS,
    USDC_ADDRESS,
  })) {
    if (!v) throw new Error(`${k} env var required`);
  }

  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  const amount = BigInt(OFFRAMP_AMOUNT);

  const ig = await ethers.getContractAt("TradeStarsCheckoutIntegratorV2", INTEGRATOR_ADDRESS);
  const vault = await ethers.getContractAt("RestrictedYieldVault", VAULT_ADDRESS);
  const usdc = await ethers.getContractAt("IERC20", USDC_ADDRESS);

  console.log("=== Allocate offramp (relayer) ===");
  console.log("relayer/signer:    ", me);
  console.log("user (proxy owner):", USER_ADDRESS);
  console.log("amount:            ", fmt(amount), "USDC");

  // Preflight.
  const relayer = await ig.offrampRelayer();
  if (relayer.toLowerCase() !== me.toLowerCase()) {
    throw new Error(`signer ${me} is not the offrampRelayer ${relayer}`);
  }
  if (!(await ig.offrampEnabled())) throw new Error("offramp is disabled on the integrator");
  const cap = await ig.maxUsdcPerOfframp();
  if (cap !== 0n && amount > cap)
    throw new Error(`amount ${fmt(amount)} > maxUsdcPerOfframp ${fmt(cap)}`);
  const quota = await vault.offrampQuota();
  if (quota < amount)
    throw new Error(
      `vault offrampQuota ${fmt(quota)} < amount ${fmt(amount)} — seed the vault first`
    );

  const before = await ig.availableOfframp(USER_ADDRESS);
  console.log("availableOfframp before:", fmt(before));

  const burnTx = ethers.id(`ui-test-burn-${USER_ADDRESS}-${Date.now()}`);
  const solPubkey = ethers.hexlify(ethers.randomBytes(32));
  console.log("allocateOfframp …", { burnTx });
  const tx = await ig.allocateOfframp(USER_ADDRESS, amount, burnTx, solPubkey);
  const rcpt = await tx.wait();
  const ev = rcpt!.logs
    .map((l: any) => {
      try {
        return ig.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((p: any) => p?.name === "OfframpAllocated");
  const allocationId = ev!.args.allocationId as bigint;

  const proxy = await ig.proxyAddress(USER_ADDRESS);
  console.log("\n✅ Allocated.");
  console.log("  allocationId:        ", allocationId.toString());
  console.log("  user proxy:          ", proxy);
  console.log("  proxy USDC balance:  ", fmt(await usdc.balanceOf(proxy)));
  console.log("  availableOfframp now:", fmt(await ig.availableOfframp(USER_ADDRESS)));
  console.log(
    "\nThe Cashout widget for",
    USER_ADDRESS,
    "will now show",
    fmt(amount),
    "USDC available."
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
