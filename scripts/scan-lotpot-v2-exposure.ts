import { ethers } from "hardhat";

// Measure outstanding liabilities on the deployed V2 that would NOT migrate
// to a fresh V3: (a) unredeemed issuedCredit ledger, (b) stranded proxy USDC.
const V2 = "0xE0799E201f9Ab48C35123839ec2b4Acfb1da4d48";
const DIAMOND = "0x4cad6eC90e65baBec9335cAd728DDC610c316368";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

async function findDeployBlock(addr: string, latest: number): Promise<number> {
  const p = ethers.provider;
  let lo = 0;
  let hi = latest;
  // Binary search: lowest block where code exists.
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const code = await p.getCode(addr, mid);
    if (code === "0x") lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

async function getLogsChunked(addr: string, topic: string, from: number, to: number) {
  const p = ethers.provider;
  const out: any[] = [];
  let step = 40000;
  let start = from;
  while (start <= to) {
    const end = Math.min(start + step - 1, to);
    try {
      const logs = await p.getLogs({
        address: addr,
        topics: [topic],
        fromBlock: start,
        toBlock: end,
      });
      out.push(...logs);
      start = end + 1;
    } catch (e: any) {
      if (step > 1000) {
        step = Math.floor(step / 2);
        continue;
      }
      throw e;
    }
  }
  return out;
}

async function main() {
  const p = ethers.provider;
  const latest = await p.getBlockNumber();
  console.log("latest block:", latest);

  const deployBlock = await findDeployBlock(V2, latest);
  console.log("V2 deploy block:", deployBlock, `(~${latest - deployBlock} blocks of history)`);

  const iface = new ethers.Interface([
    "event CreditIssued(address indexed issuer, address indexed user, uint256 amount)",
    "event UserProxyDeployed(address indexed user, address proxy)",
  ]);
  const creditTopic = iface.getEvent("CreditIssued")!.topicHash;
  const proxyTopic = iface.getEvent("UserProxyDeployed")!.topicHash;

  console.log("\nscanning CreditIssued + UserProxyDeployed logs…");
  const [creditLogs, proxyLogs] = await Promise.all([
    getLogsChunked(V2, creditTopic, deployBlock, latest),
    getLogsChunked(V2, proxyTopic, deployBlock, latest),
  ]);
  console.log("  CreditIssued events:     ", creditLogs.length);
  console.log("  UserProxyDeployed events:", proxyLogs.length);

  const users = new Set<string>();
  for (const l of creditLogs) users.add(iface.parseLog(l)!.args.user.toLowerCase());
  for (const l of proxyLogs) users.add(iface.parseLog(l)!.args.user.toLowerCase());
  console.log("  unique users seen:       ", users.size);

  const v2 = await ethers.getContractAt("LotPotCheckoutIntegratorV2", V2);
  const erc20 = new ethers.Contract(
    USDC,
    ["function balanceOf(address) view returns (uint256)"],
    p
  );

  let totalIssued = 0n;
  let totalStranded = 0n;
  const withLedger: [string, bigint][] = [];
  const withStranded: [string, bigint][] = [];

  for (const u of users) {
    const issued: bigint = await v2.issuedCredit(u);
    const proxy: string = await v2.proxyAddress(u);
    const bal: bigint = await erc20.balanceOf(proxy);
    if (issued > 0n) {
      totalIssued += issued;
      withLedger.push([u, issued]);
    }
    if (bal > 0n) {
      totalStranded += bal;
      withStranded.push([u, bal]);
    }
  }

  console.log("\n── OUTSTANDING V2 LIABILITY (does NOT migrate to V3) ──");
  console.log(
    "  unredeemed issuedCredit ledger:",
    ethers.formatUnits(totalIssued, 6),
    "USDC across",
    withLedger.length,
    "users"
  );
  console.log(
    "  stranded proxy USDC (V1-style): ",
    ethers.formatUnits(totalStranded, 6),
    "USDC across",
    withStranded.length,
    "proxies"
  );

  if (withLedger.length) {
    console.log("\n  users with ledger credit:");
    for (const [u, v] of withLedger.sort((a, b) => (b[1] > a[1] ? 1 : -1)))
      console.log("   ", u, ethers.formatUnits(v, 6), "USDC");
  }
  if (withStranded.length) {
    console.log("\n  proxies with stranded USDC:");
    for (const [u, v] of withStranded.sort((a, b) => (b[1] > a[1] ? 1 : -1)))
      console.log("   ", u, ethers.formatUnits(v, 6), "USDC");
  }

  // In-flight orders on the Diamond.
  const d = new ethers.Contract(
    DIAMOND,
    [
      "function getIntegratorConfig(address) view returns (tuple(bool isActive, bool usdcThroughIntegrator, uint256 activeOrderCount, address proxyImpl))",
    ],
    p
  );
  const cfg = await d.getIntegratorConfig(V2);
  console.log("\n  V2 in-flight orders (activeOrderCount):", cfg.activeOrderCount.toString());

  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
