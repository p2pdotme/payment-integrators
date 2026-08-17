import { ethers, network } from "hardhat";

/**
 * Deploy MerchantTerminalIntegrator + the SimpleERC721Client price source.
 *
 * INTERNAL CUSTODY: the integrator custodies ALL merchant USDC itself — there is
 * no separate vault. USDC swept from a merchant proxy on BUY completion lands on
 * the integrator's own balance, and withdrawals pay out from it. Keeping funds and
 * accounting in ONE contract makes the solvency invariant a local property
 * (usdc.balanceOf(integrator) >= totalOwed) and makes upgrades safe with NO
 * cross-contract fund migration: a replacement is a fresh deploy, the OLD
 * integrator stays live holding its own funds + records for merchants to drain,
 * and dormant leftovers are recovered via adminEscheat.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-merchant-terminal.ts --network baseSepolia
 *
 * Env:
 *   DIAMOND_ADDRESS, USDC_ADDRESS       (required)
 *   EXTRA_OWNERS                        (optional) comma-separated addresses, each
 *                                       seeded as a full-access owner alongside the
 *                                       deployer. For production, hand the
 *                                       super-admin to a multisig via
 *                                       transferSuperAdmin AFTER deploy (H-3).
 *
 * The client's product 2 is priced at 1e-6 USDC/unit (one 6-decimal unit), so the
 * on-chain `quantity` IS the plain 6-dec USDC amount — the POS sizes quantity in
 * full 6-dec units (no cent-snapping), which lands the customer's charged fiat on
 * the exact quote with zero rounding drift (ISSUE-fiat-decimal-drift.md, Option B).
 */

const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "";
const EXTRA_OWNERS = (process.env.EXTRA_OWNERS || "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

async function main() {
  // Validate as ADDRESSES, not just non-empty — a malformed value would
  // otherwise die later inside an opaque ethers ABI-encode error.
  if (!ethers.isAddress(DIAMOND_ADDRESS)) {
    throw new Error(
      `DIAMOND_ADDRESS env var is missing or not a valid address: "${DIAMOND_ADDRESS}"`
    );
  }
  if (!ethers.isAddress(USDC_ADDRESS)) {
    throw new Error(`USDC_ADDRESS env var is missing or not a valid address: "${USDC_ADDRESS}"`);
  }
  for (const o of EXTRA_OWNERS) {
    if (!ethers.isAddress(o)) throw new Error(`EXTRA_OWNERS contains a non-address: ${o}`);
  }

  const [deployer] = await ethers.getSigners();
  console.log("Deployer (first owner + super-admin):", await deployer.getAddress());
  console.log("Diamond:", DIAMOND_ADDRESS);
  console.log("USDC:", USDC_ADDRESS);
  console.log("Extra owners:", EXTRA_OWNERS.length ? EXTRA_OWNERS.join(", ") : "(none)");
  console.log("");

  // 1. Integrator (internal custody). Deployer + any extra owners each get full
  //    access; the deployer is also the super-admin (hand off to a multisig later).
  console.log("Deploying MerchantTerminalIntegrator (internal custody)...");
  const Integrator = await ethers.getContractFactory("MerchantTerminalIntegrator");
  const integrator = await Integrator.deploy(DIAMOND_ADDRESS, USDC_ADDRESS, EXTRA_OWNERS);
  await integrator.deploymentTransaction()?.wait(3);
  const address = await integrator.getAddress();
  const code = await ethers.provider.getCode(address);
  if (code === "0x" || code.length <= 2) throw new Error(`No code at ${address}`);

  // L-1 (audit): the integrator's immutable `usdc` is load-bearing — UserProxy's
  // USDC-sweep block resolves the token live via IUsdcSource(integrator()).usdc(),
  // and a prior MerchantTerminal deploy was once bound to the WRONG token. Assert
  // the constructor actually pinned the token we passed (catches an arg mix-up or
  // an address(0) that slipped the constructor guard) BEFORE anyone relies on it.
  const boundDiamond: string = await integrator.diamond();
  const boundUsdc: string = await integrator.usdc();
  if (boundUsdc.toLowerCase() !== USDC_ADDRESS.toLowerCase()) {
    throw new Error(
      `integrator.usdc() (${boundUsdc}) != USDC_ADDRESS (${USDC_ADDRESS}) — wrong token bound. ABORT.`
    );
  }
  if (boundDiamond.toLowerCase() !== DIAMOND_ADDRESS.toLowerCase()) {
    throw new Error(
      `integrator.diamond() (${boundDiamond}) != DIAMOND_ADDRESS (${DIAMOND_ADDRESS}) — wrong Diamond bound. ABORT.`
    );
  }

  // 2. Price source.
  console.log("Deploying SimpleERC721Client (price source)...");
  const Client = await ethers.getContractFactory("SimpleERC721Client");
  const client = await Client.deploy(address, USDC_ADDRESS, "Merchant Terminal Item", "MTI");
  await client.deploymentTransaction()?.wait(3);
  const clientAddress = await client.getAddress();

  // Product 2 priced at the SMALLEST USDC unit (1 = 1e-6 USDC). The integrator
  // computes total = getProductPrice(2) * quantity, so a unit price of 1 makes
  // `quantity` a plain 6-decimal USDC amount — the order can land on ANY 6-dec
  // value, not just whole cents. This removes the fiat-decimal drift at the
  // source: a round ₹250 quote maps to a USDC amount whose fiat rounds to
  // ₹250.00 (was 0.01-USDC granularity → ~₹0.91 grid → ₹249.57). See
  // ISSUE-fiat-decimal-drift.md (Option B). The frontend sizes `quantity` in
  // full 6-dec units to match (no cent-snapping).
  console.log("Pricing product 2 at 1e-6 USDC/unit (full 6-decimal precision)...");
  await (await client.setProductPrice(2, 1)).wait(3);

  const proxyImpl = await integrator.proxyImpl();
  const runtimeBytecodeHash = ethers.keccak256(code);

  console.log("");
  console.log("=== Deployment Summary ===");
  console.log(`Integrator (custody):  ${address}`);
  console.log(`proxyImpl (pinned):    ${proxyImpl}`);
  console.log(`Price client:          ${clientAddress}`);
  console.log(`Diamond:               ${await integrator.diamond()}`);
  console.log(`USDC:                  ${await integrator.usdc()}`);
  console.log(`Super-admin:           ${await integrator.superAdmin()}`);
  console.log(`Owners (count):        ${(await integrator.ownerCount()).toString()}`);
  console.log(
    `PER_TX_CAP:            ${ethers.formatUnits(await integrator.PER_TX_CAP(), 6)} USDC`
  );
  console.log(`DAILY_TX_LIMIT:        ${(await integrator.DAILY_TX_LIMIT()).toString()} per day`);
  const settlement = await integrator.SETTLEMENT_PERIOD();
  console.log(
    `SETTLEMENT_PERIOD:     ${settlement.toString()} seconds (${(Number(settlement) / 60).toString()} min)`
  );
  console.log(`Runtime bytecode hash: ${runtimeBytecodeHash}`);
  console.log("");
  console.log("Next steps:");
  console.log("  0. (L-1) CONFIRM the USDC above is the CANONICAL token for this chain (Base");
  console.log("     Sepolia: 0x036CbD53842c5426634e7929541eC2318f3dCF7e; Base mainnet:");
  console.log("     0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913). The constructor pinned it as");
  console.log("     immutable and this script already asserted usdc()==USDC_ADDRESS, but the");
  console.log("     RIGHT-token check is manual — a valid-but-wrong ERC-20 would still pass.");
  console.log("  1. Verify on the explorer (hardhat-verify can't take an ARRAY constructor");
  console.log("     arg inline — write it to a --constructor-args module):");
  console.log("       // verify-args.js");
  console.log(
    `       module.exports = ["${DIAMOND_ADDRESS}", "${USDC_ADDRESS}", ${JSON.stringify(EXTRA_OWNERS)}];`
  );
  console.log(
    `     integrator: npx hardhat verify --network ${network.name} --constructor-args verify-args.js ${address}`
  );
  console.log(
    `     client:     npx hardhat verify --network ${network.name} ${clientAddress} ${address} ${USDC_ADDRESS} "Merchant Terminal Item" "MTI"`
  );
  console.log("  2. File the whitelist request (docs/WHITELISTING.md):");
  console.log(`       integrator             = ${address}`);
  console.log(`       proxyImpl              = ${proxyImpl}`);
  console.log(
    "       usdcThroughIntegrator  = FALSE  (Diamond pays the merchant proxy; onOrderComplete pulls into the integrator)"
  );
  console.log("  3. Point backend/frontend env at the integrator + client addresses:");
  console.log("       NEXT_PUBLIC_CONTRACT_ADDRESS = this integrator");
  console.log("       NEXT_PUBLIC_CLIENT_ADDRESS   = this price client");
  console.log("     IF THIS IS AN UPGRADE (replacing a live integrator), also set the OLD");
  console.log("     integrator as NEXT_PUBLIC_PREV_CONTRACT_ADDRESS so the withdraw page");
  console.log("     shows a 'Previous terminal balance' card and merchants can drain funds");
  console.log("     still held on the old contract (incl. balances that unlock AFTER the");
  console.log("     switch). Clear it once the old contract is fully drained/retired.");
  console.log("  4. (H-3) hand the super-admin to a multisig via");
  console.log("     integrator.transferSuperAdmin(multisig) → multisig.acceptSuperAdmin().");
  console.log("  5. UPGRADE (later): deploy a fresh integrator for NEW orders; leave THIS one");
  console.log("     live so merchants drain their balances from it. No fund migration exists");
  console.log("     or is needed — dormant leftovers are recovered via adminEscheat.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
