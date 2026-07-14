/**
 * Enumerate all admins/owners on the v12 Base Sepolia integrator.
 *
 * The contract stores roles in a mapping (no enumeration getter), so we:
 *   1. scan access-control events for every address ever touched,
 *   2. read each address's LIVE roleOf() + isOwner() so the output reflects
 *      current state, not event history.
 *
 * Read-only — no signer needed. Uses the PUBLIC Base Sepolia RPC directly
 * (the .env RPC is a free-tier plan capped at 10-block eth_getLogs ranges);
 * finds the deployment block via getCode binary search, then scans logs in
 * adaptive chunks.
 *
 *   npx hardhat run scripts/list-admins.ts
 */
import { ethers } from "hardhat";

const INTEGRATOR = "0xC78222FFead42c8fc05A128966eb29590aD384d3";
const PUBLIC_RPC = "https://sepolia.base.org";
const ROLE_NAMES = ["NONE", "VIEWER", "SUPPORT", "MANAGER", "FINANCE"];

const ABI = [
  "event AdminAdded(address indexed admin)",
  "event AdminRemoved(address indexed admin)",
  "event AdminRoleSet(address indexed admin, uint8 role)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
  "event OwnerAdded(address indexed owner)",
  "event OwnerRemoved(address indexed owner)",
  "event SuperAdminTransferred(address indexed previous, address indexed next)",
  "function superAdmin() view returns (address)",
  "function ownerCount() view returns (uint256)",
  "function roleOf(address) view returns (uint8)",
  "function isOwner(address) view returns (bool)",
];

/** Lowest block where the contract has code (its deployment block). */
async function findDeployBlock(provider: InstanceType<typeof ethers.JsonRpcProvider>, latest: number): Promise<number> {
  let lo = 0, hi = latest;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const code = await provider.getCode(INTEGRATOR, mid);
    if (code === "0x") lo = mid + 1; else hi = mid;
  }
  return lo;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(PUBLIC_RPC);
  const net = await provider.getNetwork();
  if (net.chainId !== 84532n) throw new Error(`Wrong network: ${net.chainId}, expected 84532 (Base Sepolia)`);
  const c = new ethers.Contract(INTEGRATOR, ABI, provider);
  const iface = c.interface;

  const latest = await provider.getBlockNumber();
  const deployBlock = await findDeployBlock(provider, latest);
  console.log(`Deployed at block ${deployBlock}; scanning ${latest - deployBlock + 1} blocks to ${latest}...`);

  // Scan ALL logs from the contract (address-only filter), decode, keep the
  // access-control events. Adaptive chunk: halve on range errors.
  const candidates = new Set<string>();
  const wanted = new Set(["AdminAdded", "AdminRemoved", "AdminRoleSet",
    "OwnershipTransferred", "OwnerAdded", "OwnerRemoved", "SuperAdminTransferred"]);
  let from = deployBlock, chunk = 10_000;
  while (from <= latest) {
    const to = Math.min(from + chunk - 1, latest);
    try {
      const logs = await provider.getLogs({ address: INTEGRATOR, fromBlock: from, toBlock: to });
      for (const log of logs) {
        let parsed; try { parsed = iface.parseLog(log); } catch { continue; }
        if (!parsed || !wanted.has(parsed.name)) continue;
        for (const arg of parsed.args) {
          if (typeof arg === "string" && ethers.isAddress(arg) && arg !== ethers.ZeroAddress) {
            candidates.add(ethers.getAddress(arg));
          }
        }
      }
      from = to + 1;
      if (chunk < 10_000) chunk *= 2; // recover after a shrink
    } catch (e: any) {
      if (chunk <= 10) throw e; // not a range problem — surface it
      chunk = Math.floor(chunk / 2);
    }
  }

  // Live state for each candidate.
  const superAdmin: string = await c.superAdmin();
  const ownerCount: bigint = await c.ownerCount();
  candidates.add(ethers.getAddress(superAdmin));

  type Row = { addr: string; role: number; isOwner: boolean; isSuper: boolean };
  const rows: Row[] = [];
  for (const addr of candidates) {
    const [role, own] = await Promise.all([c.roleOf(addr), c.isOwner(addr)]);
    rows.push({ addr, role: Number(role), isOwner: Boolean(own),
      isSuper: addr.toLowerCase() === superAdmin.toLowerCase() });
  }

  const active = rows.filter((r) => r.role > 0).sort((a, b) => b.role - a.role);
  const former = rows.filter((r) => r.role === 0);

  console.log("");
  console.log("Integrator :", INTEGRATOR, "(Base Sepolia)");
  console.log("superAdmin :", superAdmin);
  console.log("ownerCount :", ownerCount.toString());
  console.log(`\n── Active admins/owners: ${active.length} ──`);
  for (const r of active) {
    const tags = [ROLE_NAMES[r.role] ?? String(r.role),
      r.isOwner ? "OWNER" : null, r.isSuper ? "SUPER-ADMIN" : null].filter(Boolean).join(" · ");
    console.log(`  ${r.addr}  ${tags}`);
  }
  if (former.length) {
    console.log(`\n── Formerly involved, now no role: ${former.length} ──`);
    for (const r of former) console.log(`  ${r.addr}`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
