import { ethers } from "hardhat";

/**
 * Deploy PantherBuyUsdcIntegrator. Deploy ONLY — registration on the Diamond
 * is done by the P2P team after a whitelist request (docs/WHITELISTING.md),
 * and MUST be `registerIntegrator(integrator, false, proxyImpl)`:
 * every order pins recipientAddr = TREASURY.
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... USDC_ADDRESS=0x... TREASURY=0x... [OPERATOR=0x...] \
 *   [PER_TX_CAP=50000000] [DAILY_TX_COUNT_LIMIT=10] [DAILY_VOLUME_CAP=0] [DRY_RUN=1] \
 *   npx hardhat run scripts/deploy-panther.ts --network baseSepolia
 */
function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return ethers.getAddress(v);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== 8453 && chainId !== 84532) throw new Error(`Unsupported chainId ${chainId}`);

  const DIAMOND = req("DIAMOND_ADDRESS");
  const USDC = req("USDC_ADDRESS");
  const TREASURY = req("TREASURY");
  const OPERATOR = process.env.OPERATOR
    ? ethers.getAddress(process.env.OPERATOR)
    : deployer.address;
  const PER_TX_CAP = BigInt(process.env.PER_TX_CAP || "50000000"); // $50
  const DAILY_TX_COUNT_LIMIT = BigInt(process.env.DAILY_TX_COUNT_LIMIT || "10");
  const DAILY_VOLUME_CAP = BigInt(process.env.DAILY_VOLUME_CAP || "0"); // off

  for (const [label, addr] of [
    ["Diamond", DIAMOND],
    ["USDC", USDC],
  ] as const) {
    if ((await ethers.provider.getCode(addr)) === "0x") throw new Error(`${label} has no code`);
  }

  console.log(`chainId ${chainId}, deployer (= owner) ${deployer.address}`);
  console.log({
    DIAMOND,
    USDC,
    TREASURY,
    OPERATOR,
    PER_TX_CAP,
    DAILY_TX_COUNT_LIMIT,
    DAILY_VOLUME_CAP,
  });
  if (process.env.DRY_RUN) return;

  const F = await ethers.getContractFactory("PantherBuyUsdcIntegrator");
  const c = await F.deploy(
    DIAMOND,
    USDC,
    TREASURY,
    OPERATOR,
    PER_TX_CAP,
    DAILY_TX_COUNT_LIMIT,
    DAILY_VOLUME_CAP
  );
  await c.deploymentTransaction()?.wait(2);
  const addr = await c.getAddress();
  console.log("PantherBuyUsdcIntegrator:", addr);
  console.log("proxyImpl:               ", await c.proxyImpl());
  console.log("bytecode hash:           ", ethers.keccak256(await ethers.provider.getCode(addr)));
  console.log("usdcThroughIntegrator:    false  (request exactly this)");
  console.log(
    `\nnpx hardhat verify --network ${chainId === 8453 ? "base" : "baseSepolia"} ${addr} ` +
      `${DIAMOND} ${USDC} ${TREASURY} ${OPERATOR} ${PER_TX_CAP} ${DAILY_TX_COUNT_LIMIT} ${DAILY_VOLUME_CAP}`
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
