import { ethers } from "hardhat";

/**
 * Deploy PayQRVault + MerchantTerminalIntegrator + the SimpleERC721Client price
 * source, wired vault-first with the airtight mutual handshake.
 *
 * Custody now lives in PayQRVault; the integrator holds no funds and moves USDC
 * only via vault.pull. The deploy order matters — the integrator must know its
 * vault BEFORE the vault authorises it, because vault.setIntegrator requires the
 * integrator's vault() to already point back (the handshake). So:
 *   1. deploy vault
 *   2. deploy integrator(diamond, usdc, vaultAddr, [owners])   ← back-pointer set
 *   3. vault.setIntegrator(integrator)                          ← handshake passes
 *
 * Usage:
 *   npx hardhat run scripts/deploy-merchant-terminal.ts --network baseSepolia
 *
 * Env:
 *   DIAMOND_ADDRESS, USDC_ADDRESS       (required)
 *   EXTRA_OWNERS                        (optional) comma-separated addresses, each
 *                                       seeded as a full-access owner on BOTH the
 *                                       vault and the integrator alongside the
 *                                       deployer. Keep the two owner sets aligned.
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
  if (!DIAMOND_ADDRESS || !USDC_ADDRESS) {
    throw new Error("DIAMOND_ADDRESS and USDC_ADDRESS env vars required");
  }
  for (const o of EXTRA_OWNERS) {
    if (!ethers.isAddress(o)) throw new Error(`EXTRA_OWNERS contains a non-address: ${o}`);
  }

  const [deployer] = await ethers.getSigners();
  console.log("Deployer (first owner):", await deployer.getAddress());
  console.log("Diamond:", DIAMOND_ADDRESS);
  console.log("USDC:", USDC_ADDRESS);
  console.log("Extra owners:", EXTRA_OWNERS.length ? EXTRA_OWNERS.join(", ") : "(none)");
  console.log("");

  // 1. Vault (custody). Deployer + any extra owners each get full access.
  console.log("Deploying PayQRVault...");
  const Vault = await ethers.getContractFactory("PayQRVault");
  const vault = await Vault.deploy(USDC_ADDRESS, EXTRA_OWNERS);
  await vault.deploymentTransaction()?.wait(3);
  const vaultAddress = await vault.getAddress();
  {
    const vcode = await ethers.provider.getCode(vaultAddress);
    if (vcode === "0x" || vcode.length <= 2) throw new Error(`No code at vault ${vaultAddress}`);
  }

  // 2. Integrator, pointed at the vault (back-pointer set in the constructor so the
  //    handshake in step 3 passes). Same owner set as the vault.
  console.log("Deploying MerchantTerminalIntegrator (vault-wired)...");
  const Integrator = await ethers.getContractFactory("MerchantTerminalIntegrator");
  const integrator = await Integrator.deploy(DIAMOND_ADDRESS, USDC_ADDRESS, vaultAddress, EXTRA_OWNERS);
  await integrator.deploymentTransaction()?.wait(3);
  const address = await integrator.getAddress();
  const code = await ethers.provider.getCode(address);
  if (code === "0x" || code.length <= 2) throw new Error(`No code at ${address}`);

  // 3. Authorise the integrator on the vault — the mutual handshake:
  //    vault.setIntegrator checks integrator.vault() == vault, which holds because
  //    step 2 set it in the constructor. After this, the link is airtight.
  console.log("Wiring the airtight link: vault.setIntegrator(integrator)...");
  await (await vault.setIntegrator(address)).wait(3);
  const linkedIntegrator = await vault.integrator();
  const integratorVault = await integrator.vault();
  if (linkedIntegrator.toLowerCase() !== address.toLowerCase()) {
    throw new Error(`Handshake check failed: vault.integrator()=${linkedIntegrator} != ${address}`);
  }
  if (integratorVault.toLowerCase() !== vaultAddress.toLowerCase()) {
    throw new Error(`Handshake check failed: integrator.vault()=${integratorVault} != ${vaultAddress}`);
  }
  console.log("  ✓ mutual link verified (vault ↔ integrator point at each other)");

  // 4. Price source.
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
  console.log(`Vault (custody):       ${vaultAddress}`);
  console.log(`Integrator:            ${address}`);
  console.log(`proxyImpl (pinned):    ${proxyImpl}`);
  console.log(`Price client:          ${clientAddress}`);
  console.log(`Diamond:               ${await integrator.diamond()}`);
  console.log(`USDC:                  ${await integrator.usdc()}`);
  console.log(`Owners (count):        ${(await integrator.ownerCount()).toString()} (integrator), ${(await vault.ownerCount()).toString()} (vault)`);
  console.log(`Vault→integrator:      ${linkedIntegrator}`);
  console.log(`Integrator→vault:      ${integratorVault}`);
  console.log(`Vault locked:          ${await vault.locked()}`);
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
  console.log("  1. Verify on the explorer:");
  console.log(
    `     vault:      npx hardhat verify --network baseSepolia ${vaultAddress} ${USDC_ADDRESS} "[${EXTRA_OWNERS.map((o) => `\\"${o}\\"`).join(",")}]"`
  );
  console.log(
    `     integrator: npx hardhat verify --network baseSepolia ${address} ${DIAMOND_ADDRESS} ${USDC_ADDRESS} ${vaultAddress} "[${EXTRA_OWNERS.map((o) => `\\"${o}\\"`).join(",")}]"`
  );
  console.log(
    `     client:     npx hardhat verify --network baseSepolia ${clientAddress} ${address} ${USDC_ADDRESS} "Merchant Terminal Item" "MTI"`
  );
  console.log("  2. File the whitelist request (docs/WHITELISTING.md) — INTEGRATOR only:");
  console.log(`       integrator             = ${address}`);
  console.log(`       proxyImpl              = ${proxyImpl}`);
  console.log(
    "       usdcThroughIntegrator  = FALSE  (Diamond pays the merchant proxy; onOrderComplete pulls → vault)"
  );
  console.log("       (the vault is NOT whitelisted — it never calls the Diamond)");
  console.log("  3. Point backend/frontend env at the integrator + client addresses.");
  console.log("  4. (migration only) if replacing an old integrator on this vault, call");
  console.log("     integrator.migrateState(oldIntegrator) BEFORE vault.setIntegrator, to");
  console.log("     carry over aggregate totalOwed. Fresh deploy: skip (totalOwed starts 0).");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
