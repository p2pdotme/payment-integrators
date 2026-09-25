/**
 * Copy admin roles and owners from previous integrators to a new one.
 *
 * WHY
 * An upgrade deploys a fresh integrator whose only owner is the deployer. Every
 * admin — VIEWER, SUPPORT, MANAGER, FINANCE — and every extra owner would have to
 * be re-granted by hand, and anyone missed silently loses access. This does it
 * automatically, once, at deployment.
 *
 * WHY A ONE-TIME COPY (not a live lookup in the contract)
 * The copy is explicit and auditable (one setRole / addOwner transaction per
 * address), and afterwards the new integrator manages its own roles: revoking
 * someone there is final. A live lookup would let whoever controls an OLD
 * integrator grant roles on the new one forever.
 *
 * HOW
 *   1. Find each previous integrator's deployment block (first block with code).
 *   2. Scan its role/owner events to learn every address that ever held a role.
 *   3. Read each address's CURRENT state from that contract (events only name
 *      candidates; the contract is the source of truth — a revoked admin is
 *      not copied).
 *   4. Newest previous integrator wins if they disagree.
 *   5. On the new integrator: addOwner for owners, setRole for admins. The
 *      super-admin is skipped (it is already root there).
 */
import { ethers } from "ethers";

const EVENTS = [
  "event AdminRoleSet(address indexed admin, uint8 role)",
  "event AdminAdded(address indexed admin)",
  "event AdminRemoved(address indexed admin)",
  "event OwnerAdded(address indexed owner)",
  "event OwnerRemoved(address indexed owner)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
  "event SuperAdminTransferred(address indexed previous, address indexed next)",
];

/**
 * Where to read logs from. Free-tier RPCs cap eth_getLogs hard (Alchemy free:
 * 10 blocks), so logs come from LOGS_RPC, else the chain's public endpoint.
 * (A fork's past logs are identical to the chain's: pass LOGS_RPC for one.)
 */
export function logsProviderFor(chainId: bigint, fallback: ethers.Provider): ethers.Provider {
  const url =
    process.env.LOGS_RPC ||
    (chainId === 84532n
      ? "https://sepolia.base.org"
      : chainId === 8453n
        ? "https://mainnet.base.org"
        : "");
  return url ? new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true }) : fallback;
}

/** getLogs over [from,to]; on a range/size error, split the range and retry. */
async function getLogsAdaptive(
  provider: ethers.Provider,
  filter: { address: string; topics: (string | string[])[] },
  from: number,
  to: number
): Promise<ethers.Log[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await provider.getLogs({ ...filter, fromBlock: from, toBlock: to });
    } catch (e) {
      if (to > from) {
        const mid = Math.floor((from + to) / 2);
        return [
          ...(await getLogsAdaptive(provider, filter, from, mid)),
          ...(await getLogsAdaptive(provider, filter, mid + 1, to)),
        ];
      }
      if (attempt >= 4) throw e; // a single block still failing: a real error
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1))); // rate limit
    }
  }
}
const READS = [
  "function isOwner(address) view returns (bool)",
  "function roleOf(address) view returns (uint8)",
  "function admins(address) view returns (bool)",
  "function superAdmin() view returns (address)",
];

export type RolePlan = { address: string; owner: boolean; role: number; from: string };

async function deploymentBlock(
  provider: ethers.Provider,
  addr: string,
  latest: number
): Promise<number> {
  let lo = 0;
  let hi = latest;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const code = await provider.getCode(addr, mid);
    if (code && code !== "0x") hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Every address that ever appeared in a role/owner event of `addr`. */
async function candidates(
  provider: ethers.Provider,
  addr: string,
  fromBlock: number,
  toBlock: number,
  chunk: number
): Promise<Set<string>> {
  const iface = new ethers.Interface(EVENTS);
  const topics = EVENTS.map((e) => iface.getEvent(e.split(" ")[1].split("(")[0])!.topicHash);
  const out = new Set<string>();
  const ranges: [number, number][] = [];
  for (let from = fromBlock; from <= toBlock; from += chunk)
    ranges.push([from, Math.min(from + chunk - 1, toBlock)]);
  // A few requests in flight at once: public RPCs cap the block range per call.
  const CONCURRENCY = 8;
  for (let i = 0; i < ranges.length; i += CONCURRENCY) {
    const batch = ranges.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(([f, t]) => getLogsAdaptive(provider, { address: addr, topics: [topics] }, f, t))
    );
    // Every indexed address in these events is a candidate (both sides of a
    // transfer); the current on-chain state below decides who is kept.
    for (const logs of results)
      for (const l of logs)
        for (const t of l.topics.slice(1)) {
          const a = ethers.getAddress("0x" + t.slice(26));
          if (a !== ethers.ZeroAddress) out.add(a);
        }
  }
  return out;
}

/** Current role (0-4) and owner flag of `who` on `addr`, tolerant of older ABIs. */
async function stateOf(provider: ethers.Provider, addr: string, who: string) {
  const c = new ethers.Contract(addr, READS, provider);
  const owner: boolean = await c.isOwner(who).catch(() => false);
  let role = 0;
  try {
    role = Number(await c.roleOf(who));
  } catch {
    // Oldest builds had only a flat `admins` bool, which meant full access.
    role = (await c.admins(who).catch(() => false)) ? 4 : 0;
  }
  return { owner, role };
}

/**
 * Work out what to copy. `previous` is newest first. `chunk` is the widest block
 * range the RPC accepts per getLogs call.
 */
export async function planRoles(
  provider: ethers.Provider,
  previous: string[],
  newSuperAdmin: string,
  chunk = 1000,
  log: (m: string) => void = () => {},
  logsProvider: ethers.Provider = provider
): Promise<RolePlan[]> {
  const latest = await provider.getBlockNumber();
  const plan = new Map<string, RolePlan>();
  for (const prev of previous) {
    const start = await deploymentBlock(provider, prev, latest);
    log(`  ${prev}: deployed at block ${start}, scanning ${latest - start + 1} blocks…`);
    const who = await candidates(logsProvider, prev, start, latest, chunk);
    // The old super-admin is also an owner there — include it as an owner candidate.
    const oldSuper = await new ethers.Contract(prev, READS, provider)
      .superAdmin()
      .catch(() => null);
    if (oldSuper) who.add(ethers.getAddress(oldSuper));
    for (const a of who) {
      if (plan.has(a)) continue; // a newer integrator already decided this address
      const { owner, role } = await stateOf(provider, prev, a);
      if (owner || role > 0) plan.set(a, { address: a, owner, role, from: prev });
    }
  }
  // The new super-admin is already root on the new integrator.
  plan.delete(ethers.getAddress(newSuperAdmin));
  return [...plan.values()];
}

/** Apply a plan to `integrator` (signer must be its super-admin). Idempotent. */
export async function applyRoles(
  integrator: ethers.Contract,
  plan: RolePlan[],
  log: (m: string) => void = () => {}
) {
  for (const p of plan) {
    if (p.owner) {
      if (!(await integrator.isOwner(p.address))) {
        await (await integrator.addOwner(p.address)).wait();
        log(`  addOwner(${p.address})   ← owner on ${p.from}`);
      }
      continue; // an owner already holds the top (FINANCE) tier
    }
    if (Number(await integrator.roleOf(p.address)) !== p.role) {
      await (await integrator.setRole(p.address, p.role)).wait();
      log(`  setRole(${p.address}, ${p.role})   ← from ${p.from}`);
    }
  }
}
