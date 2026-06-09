import { ethers } from "hardhat";

/**
 * Live Base Sepolia E2E for the sell-back (offramp) path of the marketplace
 * demo. Buys an NFT straight from SimpleNFTMarketplace (mints to the caller
 * EOA), then drives MarketplaceCheckoutIntegrator.userInitiateSellBack — which
 * must burn the NFT and place a fiat SELL on the Diamond funded from the
 * integrator's pool. Asserts mint → burn → OfframpInitiated(orderId).
 *
 * This is the integrator-side boundary; full fiat settlement (accept / pay /
 * complete) is the merchant bot's job and is covered separately.
 *
 * Usage:
 *   npx hardhat run scripts/local/e2e-marketplace-sellback.ts --network baseSepolia
 */

const INTEGRATOR = process.env.INTEGRATOR_ADDRESS || "0x6daE4C184a32782A72bd99875379fc1E7383213B";
const MARKETPLACE = process.env.MARKETPLACE_ADDRESS || "0xBfB7f7B97E77EF076bf8cbaAC97b89F369867C24";
const USDC = process.env.USDC_ADDRESS || "0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d";
const PRODUCT_ID = BigInt(process.env.PRODUCT_ID || "2");
const CIRCLE_ID = BigInt(process.env.CIRCLE_ID || "1");

const f = (n: bigint) => ethers.formatUnits(n, 6);

async function main() {
  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  console.log("E2E signer:", me);
  console.log("Integrator:", INTEGRATOR, " Marketplace:", MARKETPLACE);

  const usdc = await ethers.getContractAt("IERC20", USDC);
  const mkt = await ethers.getContractAt("SimpleNFTMarketplace", MARKETPLACE);
  const integ = await ethers.getContractAt("MarketplaceCheckoutIntegrator", INTEGRATOR);

  const price = await mkt.productPrices(PRODUCT_ID);
  if (price === 0n) throw new Error(`product ${PRODUCT_ID} has no price set`);
  const bal = await usdc.balanceOf(me);
  const pool = await usdc.balanceOf(INTEGRATOR);
  console.log(
    `Product ${PRODUCT_ID}: ${f(price)} USDC | my USDC: ${f(bal)} | pool: ${f(pool)} USDC`
  );
  if (bal < price) throw new Error("insufficient USDC to buy");
  if (pool < price) throw new Error("sell-back pool underfunded for this product");

  // 1. Buy → NFT minted to me (EOA). Read the tokenId from the mint Transfer
  // event in the receipt (robust against RPC read-after-write lag).
  console.log("\n[1] approve + buy…");
  await (await usdc.approve(MARKETPLACE, price)).wait(1);
  const buyRc = await (await mkt.buy(PRODUCT_ID, 1n)).wait(1);
  let tokenId: bigint | undefined;
  let mintedTo: string | undefined;
  for (const log of buyRc!.logs) {
    try {
      const p = mkt.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (p?.name === "Transfer" && p.args.from === ethers.ZeroAddress) {
        tokenId = p.args.tokenId as bigint;
        mintedTo = p.args.to as string;
        break;
      }
    } catch {
      /* not an ERC721 Transfer */
    }
  }
  if (tokenId === undefined) throw new Error("mint Transfer event not found in buy receipt");
  const mine = mintedTo!.toLowerCase() === me.toLowerCase();
  console.log(`  minted tokenId ${tokenId} → ${mintedTo}  (mine=${mine})`);
  if (!mine) throw new Error("NFT not minted to caller");

  // 2. Sell back → burns NFT + places SELL from the pool.
  console.log("\n[2] userInitiateSellBack…");
  const tx = await integ.userInitiateSellBack(
    MARKETPLACE,
    tokenId,
    ethers.encodeBytes32String("INR"),
    0n,
    CIRCLE_ID,
    0n,
    "demo-pubkey-e2e"
  );
  const rc = await tx.wait(1);
  let orderId: bigint | undefined;
  for (const log of rc!.logs) {
    try {
      const p = integ.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (p?.name === "OfframpInitiated") {
        orderId = p.args.orderId as bigint;
        break;
      }
    } catch {
      /* not our event */
    }
  }
  console.log(`  OfframpInitiated orderId: ${orderId}`);
  if (orderId === undefined) throw new Error("OfframpInitiated not emitted");

  // 3. Assert NFT burned — look for the burn Transfer (→ zero) in the receipt.
  let burned = false;
  for (const log of rc!.logs) {
    try {
      const p = mkt.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (
        p?.name === "Transfer" &&
        p.args.to === ethers.ZeroAddress &&
        (p.args.tokenId as bigint) === tokenId
      ) {
        burned = true;
        break;
      }
    } catch {
      /* not an ERC721 Transfer */
    }
  }
  console.log(`  NFT burned: ${burned}`);
  if (!burned) throw new Error("NFT not burned on sell-back");

  console.log(
    `\n✅ sell-back E2E passed — buy → burn tokenId ${tokenId} → SELL order ${orderId} placed on the Diamond`
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
