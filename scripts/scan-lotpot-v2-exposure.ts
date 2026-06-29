import { ethers } from "hardhat";
import * as fs from "fs";

// Measure outstanding liabilities on the deployed V2 that would NOT migrate
// to a fresh V3: (a) unredeemed issuedCredit ledger, (b) stranded proxy USDC.
//
// Reads are batched through Multicall3 (one eth_call per ~500 reads) to stay
// well under public-RPC rate limits. Event enumeration is cached to disk so
// re-runs skip the multi-minute log sweep.
const V2 = "0xE0799E201f9Ab48C35123839ec2b4Acfb1da4d48";
const DIAMOND = "0x4cad6eC90e65baBec9335cAd728DDC610c316368";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const CACHE =
  "/tmp/claude-0/-home-user-payment-integrators/07c0bb47-ca4f-5b3c-9e6b-2ece063a4be4/scratchpad/v2-events.json";

async function findDeployBlock(addr: string, latest: number): Promise<number> {
  const p = ethers.provider;
  let lo = 0;
  let hi = latest;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const code = await p.getCode(addr, mid);
    if (code === "0x") lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

async function getLogsChunked(addr: string, topic: string, from: number, to: number, label = "") {
  const p = ethers.provider;
  const out: any[] = [];
  let step = 9000;
  let start = from;
  const total = to - from + 1;
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
      if (((end - from) / total) * 100 >= (out.length ? 0 : 0)) {
        const pct = Math.floor(((end - from) / total) * 100);
        if (pct % 10 === 0) console.log(`  [${label}] ${pct}% (${out.length} logs)`);
      }
      start = end + 1;
    } catch (e: any) {
      if (step > 500) {
        step = Math.floor(step / 2);
        continue;
      }
      throw e;
    }
  }
  return out;
}

// Multicall3 aggregate3 — batch eth_call. Returns decoded uint256 per call.
async function multicallUint(target: string, fnFrag: string, args: string[]): Promise<bigint[]> {
  const mc = new ethers.Contract(
    MULTICALL3,
    [
      "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])",
    ],
    ethers.provider
  );
  const iface = new ethers.Interface([`function ${fnFrag}`]);
  const fnName = fnFrag.slice(0, fnFrag.indexOf("("));
  const results: bigint[] = [];
  const BATCH = 500;
  for (let i = 0; i < args.length; i += BATCH) {
    const slice = args.slice(i, i + BATCH);
    const calls = slice.map((a) => ({
      target,
      allowFailure: true,
      callData: iface.encodeFunctionData(fnName, [a]),
    }));
    const res = await mc.aggregate3(calls);
    for (const r of res) {
      results.push(
        r.success ? (iface.decodeFunctionResult(fnName, r.returnData)[0] as bigint) : 0n
      );
    }
    console.log(`    multicall ${Math.min(i + BATCH, args.length)}/${args.length}`);
  }
  return results;
}

async function main() {
  const p = ethers.provider;
  const latest = await p.getBlockNumber();

  let users: string[];
  let proxies: string[];

  if (fs.existsSync(CACHE)) {
    const c = JSON.parse(fs.readFileSync(CACHE, "utf8"));
    users = c.users;
    proxies = c.proxies;
    console.log(`loaded cache: ${users.length} users, ${proxies.length} proxies`);
  } else {
    const deployBlock = await findDeployBlock(V2, latest);
    console.log("V2 deploy block:", deployBlock);
    const iface = new ethers.Interface([
      "event CreditIssued(address indexed issuer, address indexed user, uint256 amount)",
      "event UserProxyDeployed(address indexed user, address proxy)",
    ]);
    const [creditLogs, proxyLogs] = await Promise.all([
      getLogsChunked(
        V2,
        iface.getEvent("CreditIssued")!.topicHash,
        deployBlock,
        latest,
        "CreditIssued"
      ),
      getLogsChunked(
        V2,
        iface.getEvent("UserProxyDeployed")!.topicHash,
        deployBlock,
        latest,
        "UserProxyDeployed"
      ),
    ]);
    const uset = new Set<string>();
    for (const l of creditLogs) uset.add(iface.parseLog(l)!.args.user.toLowerCase());
    for (const l of proxyLogs) uset.add(iface.parseLog(l)!.args.user.toLowerCase());
    users = [...uset];
    proxies = proxyLogs.map((l) => iface.parseLog(l)!.args.proxy.toLowerCase());
    fs.writeFileSync(CACHE, JSON.stringify({ users, proxies }));
    console.log(`scanned: ${users.length} users, ${proxies.length} proxies (cached)`);
  }

  console.log("\nreading issuedCredit ledger for all users via Multicall3…");
  const issued = await multicallUint(V2, "issuedCredit(address) view returns (uint256)", users);

  console.log("\nreading USDC balance for all deployed proxies via Multicall3…");
  const bals = await multicallUint(USDC, "balanceOf(address) view returns (uint256)", proxies);

  let totalIssued = 0n;
  const ledgerHolders: [string, bigint][] = [];
  for (let i = 0; i < users.length; i++) {
    if (issued[i] > 0n) {
      totalIssued += issued[i];
      ledgerHolders.push([users[i], issued[i]]);
    }
  }
  let totalStranded = 0n;
  const strandedProxies: [string, bigint][] = [];
  for (let i = 0; i < proxies.length; i++) {
    if (bals[i] > 0n) {
      totalStranded += bals[i];
      strandedProxies.push([proxies[i], bals[i]]);
    }
  }

  console.log("\n── OUTSTANDING V2 LIABILITY (does NOT migrate to V3) ──");
  console.log(
    "  unredeemed issuedCredit ledger:",
    ethers.formatUnits(totalIssued, 6),
    "USDC across",
    ledgerHolders.length,
    "users"
  );
  console.log(
    "  stranded proxy USDC (V1-style): ",
    ethers.formatUnits(totalStranded, 6),
    "USDC across",
    strandedProxies.length,
    "proxies"
  );

  ledgerHolders.sort((a, b) => (b[1] > a[1] ? 1 : -1));
  console.log("\n  top 15 ledger-credit holders:");
  for (const [u, v] of ledgerHolders.slice(0, 15))
    console.log("   ", u, ethers.formatUnits(v, 6), "USDC");

  if (strandedProxies.length) {
    strandedProxies.sort((a, b) => (b[1] > a[1] ? 1 : -1));
    console.log("\n  proxies with stranded USDC:");
    for (const [u, v] of strandedProxies.slice(0, 15))
      console.log("   ", u, ethers.formatUnits(v, 6), "USDC");
  }

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
  console.error("Error:", e);
  process.exitCode = 1;
});
