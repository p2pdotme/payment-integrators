import { ethers } from "hardhat";

/**
 * ONE-OFF: flip the live SimpleERC721Client's product-2 unit price from the
 * legacy 0.01-USDC granularity (10_000 six-dec units) to the smallest USDC unit
 * (1 = 1e-6 USDC), which eliminates the fiat-decimal drift (₹250 → ₹250.00). The
 * integrator computes order total = getProductPrice(2) × quantity, so a unit
 * price of 1 lets the frontend size `quantity` as a plain 6-decimal USDC amount.
 *
 * NO integrator/vault redeploy — this only changes the client's product price.
 *
 * ⚠️ COORDINATE WITH THE FRONTEND: the terminal reads this price LIVE and sizes
 * quantity = usdcTarget / unitPrice, so it stays correct before AND after this
 * flip. Still, deploy the drift-fix frontend around the same time so the UX and
 * on-chain price move together.
 *
 * Env (addresses are NOT hardcoded — repo convention forbids it):
 *   CLIENT   (required) the live SimpleERC721Client (price source) to operate on
 *
 * Run (Base Sepolia), from payment-integrators/:
 *   CLIENT=0x... npx hardhat run scripts/set-product-price.ts --network baseSepolia
 * The signer MUST be the client's owner (the deployer) — setProductPrice is onlyOwner.
 */

// SimpleERC721Client (price source). Required from env — no hardcoded default,
// matching grant-admin.ts / transfer-superadmin.ts (repo convention forbids it).
const CLIENT = process.env.CLIENT || "";
const PRODUCT_ID = 2n;
const NEW_PRICE = 1n; // 1e-6 USDC — full 6-decimal precision

async function main() {
  // Fail loudly BEFORE any on-chain read/write if the target isn't supplied.
  if (!ethers.isAddress(CLIENT)) {
    throw new Error(`CLIENT env var is missing or not a valid address: "${CLIENT}"`);
  }
  const net = await ethers.provider.getNetwork();
  // HARD network guard — this is a mutating one-off aimed at Base Sepolia; a
  // soft "(check network!)" log is not enough for the only script that will
  // happily write on the wrong chain. Explicit env override for a future
  // mainnet run.
  if (net.chainId !== 84532n && process.env.ALLOW_NON_SEPOLIA !== "1") {
    throw new Error(
      `Refusing to run on chainId ${net.chainId} — this one-off targets Base Sepolia (84532). ` +
        "Set ALLOW_NON_SEPOLIA=1 to override deliberately."
    );
  }
  const [signer] = await ethers.getSigners();
  const client = await ethers.getContractAt("SimpleERC721Client", CLIENT);

  const before: bigint = await client.getProductPrice(PRODUCT_ID);
  const owner: string = await client.owner();

  console.log(
    "chainId         :",
    net.chainId.toString(),
    net.chainId === 84532n ? "(Base Sepolia)" : "(check network!)"
  );
  console.log("client          :", CLIENT);
  console.log("signer          :", signer.address);
  console.log("client owner    :", owner);
  console.log("product 2 price :", before.toString(), `(= ${Number(before) / 1e6} USDC/unit)`);

  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      "Signer is NOT the client owner — setProductPrice is onlyOwner. Use the deployer key."
    );
  }
  if (before === NEW_PRICE) {
    console.log("\nAlready at 1e-6 USDC/unit — nothing to do.");
    return;
  }

  console.log(`\nSetting product ${PRODUCT_ID} price → ${NEW_PRICE} (1e-6 USDC/unit)…`);
  const tx = await client.setProductPrice(PRODUCT_ID, NEW_PRICE);
  console.log("tx sent         :", tx.hash);
  await tx.wait(2);

  const after: bigint = await client.getProductPrice(PRODUCT_ID);
  console.log("product 2 price :", after.toString(), `(= ${Number(after) / 1e6} USDC/unit)`);
  console.log(
    after === NEW_PRICE
      ? "✓ done — decimal drift fixed at the source."
      : "✗ price did not update as expected."
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
