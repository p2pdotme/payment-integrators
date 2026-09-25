/**
 * FORK CHECK — run against a local fork of Base Sepolia, never a live network.
 *
 *   npx hardhat node --port 8546 --fork <BASE_SEPOLIA_RPC>
 *   npx hardhat run scripts/fork-check-import.ts --network fork
 *
 * Deploys the NEW integrator on the fork, points it at the REAL previous
 * integrators, and checks that real merchants are carried over with their
 * real data — no registration — including a payment link created by a merchant
 * who never registered on the new contract.
 */
import { ethers, network } from "hardhat";

const PREVIOUS = [
  "0x4c4223DdfD0cc1a252013FBA4b8444eECda8A236", // current live
  "0x2Edcf5E918F181d8CE5b15827a78Ebd83A0efDd6",
  "0x10A08aa7D5078C7210Ba848941ACC36982701eAf", // oldest (no sector)
];
const MERCHANTS = [
  "0x02c8afe208948cDCC18C81D2B49eE18700526647",
  "0x4f45446a6E934Fd03A353eC4DAc7Cd544f03d426",
];
const DIAMOND = "0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9";
const USDC = "0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d";

async function main() {
  if (network.name !== "fork") throw new Error("fork only");
  const libs: Record<string, string> = {};
  for (const n of [
    "PaymentLinksLib",
    "MerchantRegistryLib",
    "SettlementLib",
    "MerchantImportLib",
  ]) {
    const c = await (await ethers.getContractFactory(n)).deploy();
    await c.waitForDeployment();
    libs[n] = await c.getAddress();
  }
  const F = await ethers.getContractFactory("MerchantTerminalIntegrator", { libraries: libs });
  const i: any = await F.deploy(DIAMOND, USDC, []);
  await i.waitForDeployment();
  await (await i.setPreviousIntegrators(PREVIOUS)).wait();
  console.log("new integrator (fork):", await i.getAddress());

  const old = new ethers.Contract(
    PREVIOUS[0],
    ["function registered(address) view returns (bool)"],
    ethers.provider
  );
  for (const m of MERCHANTS) {
    const before = await i.registered(m);
    const rc = await (await i.importMerchant(m)).wait();
    const ev = rc.logs
      .map((l: any) => {
        try {
          return i.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e: any) => e?.name === "MerchantImported");
    const [payout, name, currency, reg, frozen, sector] = await i.getMerchantInfo(m);
    console.log(
      `${m.slice(0, 6)}: registered before=${before} after=${reg} | from ${ev ? ev.args.fromIntegrator.slice(0, 6) : "-"}` +
        ` | shop="${name}" currency=${ethers.decodeBytes32String(currency)} sector="${ethers.decodeBytes32String(sector)}"` +
        ` payoutBytes=${(payout.length - 2) / 2} frozen=${frozen} | on live 0x4c42: ${await old.registered(m)}`
    );
  }

  // A merchant who never registered on the new contract creates a link.
  const m = MERCHANTS[1];
  const fresh = await i.importMerchant.staticCall(m); // already imported above → false
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [m] });
  await network.provider.request({
    method: "hardhat_setBalance",
    params: [m, "0xDE0B6B3A7640000"],
  });
  const signer = await ethers.getSigner(m);
  const i2 = F.attach(await i.getAddress()).connect(signer) as any;
  await (
    await i2.createLink(ethers.id("fork-link"), 0, ethers.encodeBytes32String("INR"), 0, 0, "0x")
  ).wait();
  console.log(
    `link created by ${m.slice(0, 6)} with no registration: count=${await i.getMerchantLinkCount(m)} (re-import returned ${fresh})`
  );

  // And a registerMerchant attempt by a returning merchant is refused.
  await i2
    .registerMerchant("0x", "Fresh Try", "INR", ethers.encodeBytes32String("X"))
    .then(() => console.log("registerMerchant: UNEXPECTEDLY SUCCEEDED"))
    .catch((e: any) =>
      console.log(
        "registerMerchant by returning merchant refused:",
        e.shortMessage || e.message.slice(0, 80)
      )
    );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
