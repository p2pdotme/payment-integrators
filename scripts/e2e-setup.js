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

  // ─── The relayer-free path ────────────────────────────────────────
  //
  // Everything below stands in for infrastructure that already exists on
  // mainnet. Deploying it locally is what lets the worker run UNCHANGED
  // between here and production: only the RPC URLs differ.
  //
  //   EntryPoint            — the same singleton already deployed on Base
  //   SimpleAccountFactory  — the account factory. Both this and a hosted
  //                           provider's derive addresses deterministically, so
  //                           a link's wallet is known before it exists and is
  //                           created lazily on first payment.
  //   VerifyingPaymaster    — sponsorship gated by an off-chain signer, which
  //                           is how a hosted paymaster decides per operation.
  const entryPoint = await (await ethers.getContractFactory("EntryPoint")).deploy();
  await entryPoint.waitForDeployment();

  const accountFactory = await (
    await ethers.getContractFactory("SimpleAccountFactory")
  ).deploy(await entryPoint.getAddress());
  await accountFactory.waitForDeployment();

  // A second factory whose accounts also implement ERC-1271.
  //
  // The reference account can send operations but cannot SIGN — it has no
  // isValidSignature. Hosted accounts, thirdweb's included, implement both,
  // because a smart-account wallet has to be able to sign in to things. The
  // provisioning endpoint depends on that: the merchant signs with the key
  // their login controls, but the address registered as a merchant is the
  // ACCOUNT, so the only way to check is to ask the account. A fixture without
  // 1271 cannot exercise that path at all.
  const account1271Factory = await (
    await ethers.getContractFactory("Account1271Factory")
  ).deploy(await entryPoint.getAddress());
  await account1271Factory.waitForDeployment();

  // Hardhat account #3 signs sponsorship approvals — the hosted paymaster
  // service's role.
  const sponsorSigner = (await ethers.getSigners())[3];
  const paymaster = await (
    await ethers.getContractFactory("VerifyingPaymaster")
  ).deploy(await entryPoint.getAddress(), sponsorSigner.address);
  await paymaster.waitForDeployment();

  // The sponsor funds ITS OWN deposit. This is the money that pays for every
  // payment, and note where it is NOT: no link wallet ever holds a balance.
  await paymaster.deposit({ value: ethers.parseEther("10") });
  await paymaster.addStake(1, { value: ethers.parseEther("1") });

  const router = await (
    await ethers.getContractFactory("LinkRouter")
  ).deploy(await integrator.getAddress());
  await router.waitForDeployment();

  // THE one on-chain change the whole design needs. The trusted relayer becomes
  // a contract that holds nothing, instead of a funded EOA.
  await integrator.setTrustedRelayer(await router.getAddress());

  // The old relayer is still funded here only so the legacy suites keep
  // exercising the path they were written for. Nothing on the Router path
  // touches it, and it is what gets deleted at cutover.
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
    // ─── The relayer-free path ───
    router: await router.getAddress(),
    entryPoint: await entryPoint.getAddress(),
    accountFactory: await accountFactory.getAddress(),
    // Same (address, uint256) shape as the reference factory, so the worker
    // addresses it with ACCOUNT_FACTORY_KIND = "simple" and needs no special
    // case for the fixture.
    account1271Factory: await account1271Factory.getAddress(),
    paymaster: await paymaster.getAddress(),
    // Hardhat account #3: signs sponsorship approvals.
    sponsorKey: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    // Hardhat account #4: submits handleOps, as a bundler's operational key.
    bundlerKey: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
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
