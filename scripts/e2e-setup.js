/**
 * Deploys the full stack to the local node and writes the addresses the Worker
 * E2E test reads. Mirrors a real deployment: register a merchant, appoint the
 * relayer, fund it with gas.
 */
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

/** Deploys PaymentLinksLib and returns its address, for linking. */
async function deployPaymentLinksLib() {
  const Lib = await ethers.getContractFactory("PaymentLinksLib");
  const lib = await Lib.deploy();
  await lib.waitForDeployment();
  return await lib.getAddress();
}

// Resolved from THIS file, not the working directory — hardhat runs scripts
// from the project root, and a bare "../worker" silently resolved outside the
// repo depending on where the contracts live.
const OUT = path.resolve(__dirname, "..", "worker", "test", "e2e-addresses.json");

async function main() {
  const [deployer, merchant, relayer, customer] = await ethers.getSigners();

  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const diamond = await (
    await ethers.getContractFactory("MockDiamond")
  ).deploy(await usdc.getAddress());
  const integrator = await (
    await ethers.getContractFactory("MerchantTerminalIntegrator", {
      libraries: { PaymentLinksLib: await deployPaymentLinksLib() },
    })
  ).deploy(await diamond.getAddress(), await usdc.getAddress(), []);
  const client = await (
    await ethers.getContractFactory("SimpleERC721Client")
  ).deploy(await integrator.getAddress(), await usdc.getAddress(), "Saree", "SAREE");

  await diamond.registerIntegrator(await integrator.getAddress(), await integrator.proxyImpl());
  // 1 USDC per unit, so a 3 USDC link is quantity 3.
  await client.setProductPrice(1, ethers.parseUnits("1", 6));
  await usdc.mint(await diamond.getAddress(), ethers.parseUnits("1000000", 6));

  await integrator
    .connect(merchant)
    .registerMerchant(
      ethers.keccak256(ethers.toUtf8Bytes("enc:ramesh@upi")),
      "Ramesh Sarees",
      "INR"
    );

  // The two deployment steps that need a human in production.
  await integrator.setTrustedRelayer(relayer.address);
  await deployer.sendTransaction({
    to: relayer.address,
    value: ethers.parseEther("1"),
  });

  const out = {
    rpcUrl: "http://127.0.0.1:8545",
    chainId: 1337,
    integrator: await integrator.getAddress(),
    diamond: await diamond.getAddress(),
    client: await client.getAddress(),
    usdc: await usdc.getAddress(),
    merchant: merchant.address,
    relayer: relayer.address,
    customer: customer.address,
    // Hardhat's deterministic account #2 — the relayer in this test.
    relayerKey: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    settlementPeriod: Number(await integrator.SETTLEMENT_PERIOD()),
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
