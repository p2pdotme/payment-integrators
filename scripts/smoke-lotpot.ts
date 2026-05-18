import { ethers } from "hardhat";

/**
 * Smoke a LotPot BUY through the new integrator. Static-call validates the
 * proxy-only gateway accepts our UserProxy, then we send a real userPlaceOrder.
 *
 *   INTEGRATOR=0x... [QUANTITY=1] [CIRCLE_ID=1] \
 *     npx hardhat run scripts/smoke-lotpot-buy.ts --network baseSepolia
 */

const INTEGRATOR = process.env.INTEGRATOR || "";
const QUANTITY = BigInt(process.env.QUANTITY || "1");
const CIRCLE_ID = BigInt(process.env.CIRCLE_ID || "1");

function makeRelayIdentity() {
  const w = ethers.Wallet.createRandom();
  const sk = new ethers.SigningKey(w.privateKey);
  const uncompressed = ethers.SigningKey.computePublicKey(sk.publicKey, false);
  return { publicKey: uncompressed.slice(4) };
}

async function main() {
  if (!INTEGRATOR) throw new Error("INTEGRATOR env var required");
  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  const id = makeRelayIdentity();

  const integrator = await ethers.getContractAt("LotPotCheckoutIntegrator", INTEGRATOR, signer);
  const proxy = await integrator.proxyAddress(me);
  console.log("Signer:    ", me);
  console.log("Integrator:", INTEGRATOR);
  console.log("Predicted proxy:", proxy);

  const args = [
    QUANTITY,
    ethers.encodeBytes32String("INR"),
    CIRCLE_ID,
    id.publicKey,
    0n,
    0n,
  ] as const;

  console.log("\nstaticCall userPlaceOrder…");
  const out: bigint = await (integrator as any).userPlaceOrder.staticCall(...args);
  console.log("staticCall returned orderId =", out.toString());

  console.log("\nSending real userPlaceOrder…");
  const tx = await (integrator as any).userPlaceOrder(...args, { gasLimit: 1_500_000 });
  const rcpt = await tx.wait(1);
  console.log("tx:", tx.hash, "status:", rcpt?.status, "gas:", rcpt?.gasUsed.toString());
  const ev = rcpt?.logs.find((l: any) => l.fragment?.name === "LotPotOrderCreated");
  if (ev)
    console.log(
      `LotPotOrderCreated → orderId=${ev.args.orderId} user=${ev.args.user} qty=${ev.args.quantity}`
    );
  console.log("\n✓ LotPot BUY placement succeeded.");
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
