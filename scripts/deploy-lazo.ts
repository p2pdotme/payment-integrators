import { ethers, network } from "hardhat";

/**
 * Deploy LazoCheckoutIntegrator. Its constructor also deploys the UserProxy and
 * VendorEscrow implementations; each vendor's escrow is a clone created later,
 * at vendor sign-up (`registerVendor`) or on its first order.
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x... OWNER=0x... FEE_WALLET=0x... \
 *     npx hardhat run scripts/deploy-lazo.ts --network baseSepolia
 *
 * Required:
 *   DIAMOND_ADDRESS   P2P Diamond
 *   USDC_ADDRESS      the token the Diamond settles in (Circle USDC on mainnet;
 *                     isBlacklisted is honoured if the token has it)
 *   OWNER             a Safe on mainnet; never defaults to the deployer
 *   FEE_WALLET        where every escrow sends the fee on release (a Safe on mainnet)
 *
 * Optional (USDC amounts in 6 decimals):
 *   OPERATOR                        hot key that can pause and block vendors (default: none)
 *   FEE_BPS=450                     default percentage, 4.5%
 *   FEE_FIXED=100000                fixed fee per order, 0.1 USDC
 *   DEFAULT_RETENTION=0             seconds an order stays locked before release
 *   PER_TX_LIMIT=1000000000         1,000 USDC per order
 *   DAILY_TX_COUNT_LIMIT=5          orders per buyer per UTC day
 *   VENDOR_DAILY_VOLUME_LIMIT=100000000000   100,000 USDC per vendor per UTC day
 *
 * Immutable bounds (cannot be moved after deploy):
 *   MIN_FEE_BPS=100  MAX_FEE_BPS=500                  1% .. 5%
 *   MIN_FEE_FIXED=100000  MAX_FEE_FIXED=2000000       0.1 .. 2 USDC
 *   MAX_PER_TX_LIMIT=50000000000                      50,000 USDC
 *   MAX_DAILY_TX_COUNT_LIMIT=1000
 *   MAX_VENDOR_DAILY_VOLUME_LIMIT=10000000000000      10,000,000 USDC
 *
 * On Base mainnet every optional value must be set explicitly: the defaults
 * are for testnets.
 */

const isMainnet = network.name === "base";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var required`);
  if (!ethers.isAddress(v)) throw new Error(`${name} is not an address: ${v}`);
  return ethers.getAddress(v);
}

function uint(name: string, fallback: string): bigint {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (isMainnet) throw new Error(`${name} must be set explicitly on mainnet`);
    return BigInt(fallback);
  }
  if (!/^\d+$/.test(v)) throw new Error(`${name} must be a non-negative integer: ${v}`);
  return BigInt(v);
}

const usdc = (n: bigint) => `${ethers.formatUnits(n, 6)} USDC`;

async function main() {
  const diamond = required("DIAMOND_ADDRESS");
  const usdcAddress = required("USDC_ADDRESS");
  const owner = required("OWNER");
  const feeWallet = required("FEE_WALLET");
  const operator = process.env.OPERATOR ? required("OPERATOR") : ethers.ZeroAddress;

  const config = {
    operator,
    feeWallet,
    feeBps: uint("FEE_BPS", "450"),
    feeFixed: uint("FEE_FIXED", "100000"),
    defaultRetention: uint("DEFAULT_RETENTION", "0"),
    perTxLimit: uint("PER_TX_LIMIT", "1000000000"),
    dailyTxCountLimit: uint("DAILY_TX_COUNT_LIMIT", "5"),
    vendorDailyVolumeLimit: uint("VENDOR_DAILY_VOLUME_LIMIT", "100000000000"),
  };
  const ceilings = {
    minFeeBps: uint("MIN_FEE_BPS", "100"),
    maxFeeBps: uint("MAX_FEE_BPS", "500"),
    minFeeFixed: uint("MIN_FEE_FIXED", "100000"),
    maxFeeFixed: uint("MAX_FEE_FIXED", "2000000"),
    maxPerTxLimit: uint("MAX_PER_TX_LIMIT", "50000000000"),
    maxDailyTxCountLimit: uint("MAX_DAILY_TX_COUNT_LIMIT", "1000"),
    maxVendorDailyVolumeLimit: uint("MAX_VENDOR_DAILY_VOLUME_LIMIT", "10000000000000"),
  };

  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  if (deployerAddress === owner) {
    console.warn(
      "WARNING: the deployer is also the owner. Fine on a testnet; use a Safe on mainnet."
    );
  }

  console.log(`Network:    ${network.name}`);
  console.log(`Deployer:   ${deployerAddress}`);
  console.log(`Diamond:    ${diamond}`);
  console.log(`USDC:       ${usdcAddress}`);
  console.log(`Owner:      ${owner}`);
  console.log(`Operator:   ${operator === ethers.ZeroAddress ? "none" : operator}`);
  console.log(`Fee wallet: ${feeWallet}`);
  console.log(
    `Fee:        ${Number(config.feeBps) / 100}% + ${usdc(config.feeFixed)}` +
      `  (bps ${ceilings.minFeeBps}..${ceilings.maxFeeBps}, fixed ${usdc(ceilings.minFeeFixed)}..${usdc(ceilings.maxFeeFixed)})`
  );
  console.log(`Retention:  ${config.defaultRetention} s`);
  console.log(`Per tx:     ${usdc(config.perTxLimit)} (ceiling ${usdc(ceilings.maxPerTxLimit)})`);
  console.log(
    `Per buyer:  ${config.dailyTxCountLimit} orders/day (ceiling ${ceilings.maxDailyTxCountLimit})`
  );
  console.log(
    `Per vendor: ${usdc(config.vendorDailyVolumeLimit)}/day (ceiling ${usdc(ceilings.maxVendorDailyVolumeLimit)})`
  );
  console.log("");

  console.log("Deploying LazoCheckoutIntegrator...");
  const Integrator = await ethers.getContractFactory("LazoCheckoutIntegrator");
  const integrator = await Integrator.deploy(diamond, usdcAddress, owner, config, ceilings);
  await integrator.deploymentTransaction()?.wait(network.name === "hardhat" ? 1 : 5);

  const address = await integrator.getAddress();
  const code = await ethers.provider.getCode(address);
  if (code === "0x" || code.length <= 2) throw new Error(`Contract has no code at ${address}`);

  const proxyImpl = await integrator.proxyImpl();
  const escrowImpl = await integrator.escrowImpl();

  console.log("");
  console.log("=== Deployment Summary ===");
  console.log(`Integrator:  ${address}`);
  console.log(`proxyImpl:   ${proxyImpl}`);
  console.log(`escrowImpl:  ${escrowImpl}`);
  console.log(`Block:       ${(await integrator.deploymentTransaction()?.wait())?.blockNumber}`);
  console.log("");
  console.log("Next steps:");
  console.log(
    "  1. Verify on Basescan. The constructor takes two structs, so pass them as a module:"
  );
  console.log("       // verify-args.js");
  console.log(
    `       module.exports = ${JSON.stringify(
      [diamond, usdcAddress, owner, stringify(config), stringify(ceilings)],
      null,
      0
    )};`
  );
  console.log(
    `       npx hardhat verify --network ${network.name} --constructor-args verify-args.js ${address}`
  );
  console.log("  2. File a Whitelist request issue (docs/WHITELISTING.md). Registration must use:");
  console.log(`       integrator            = ${address}`);
  console.log(`       proxyImpl             = ${proxyImpl}`);
  console.log(
    "       usdcThroughIntegrator = false   (the Diamond pays each vendor's escrow directly)"
  );
  console.log(
    "       cancelCallbackEnabled = true    (frees buyer and vendor limits on cancellation)"
  );
  console.log(
    "  3. Vendors are registered at sign-up with registerVendor(vendor); anyone can call it."
  );
}

/** BigInts as decimal strings, so the verify-args module is plain JSON. */
function stringify(o: Record<string, bigint | string>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.toString()]));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
