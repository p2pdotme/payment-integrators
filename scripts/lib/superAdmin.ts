/**
 * Hand the integrator's super-admin to a multisig.
 *
 * WHY
 * The super-admin is the root of trust. It alone can set `trustedRelayer` (the
 * contract allowed to mark link orders paid), set the previous-integrator list,
 * add or remove owners and roles, and escheat dormant balances. Left on the
 * deployer's single key, one leaked key is a full compromise. Before mainnet it
 * must be a multisig.
 *
 * HOW (the contract's two-step handoff)
 *   1. deployer: transferSuperAdmin(multisig)  — only PROPOSES; valid 7 days.
 *   2. multisig: acceptSuperAdmin()            — root moves only now, which proves
 *      the multisig can actually sign (a mistyped address can never take root).
 *   3. multisig: removeOwner(deployer)         — the old super-admin stays an
 *      OWNER after the handoff (full FINANCE access), so drop the single key.
 * Steps 2 and 3 are one Safe batch; `safeBatch` prints exactly what to submit.
 */
import { ethers } from "ethers";

/** Chains where a single-key super-admin is refused outright. */
export const MAINNET_CHAIN_IDS = new Set([8453n /* Base */, 1n /* Ethereum */]);

const SAFE_ABI = [
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
];

export type MultisigInfo = { address: string; threshold: number; owners: string[] };

/**
 * Refuses anything that is not a working multisig: no code (an EOA or a typo),
 * not Safe-shaped, or a 1-of-N (a multisig in name only). A 1-of-N is allowed
 * only off-mainnet and only with `allowSingleSigner`.
 */
export async function checkMultisig(
  provider: ethers.Provider,
  addr: string,
  opts: { chainId: bigint; allowSingleSigner?: boolean; deployer?: string }
): Promise<MultisigInfo> {
  if (!ethers.isAddress(addr)) throw new Error(`SUPER_ADMIN_MULTISIG is not an address: "${addr}"`);
  const address = ethers.getAddress(addr);
  if ((await provider.getCode(address)) === "0x") {
    throw new Error(
      `SUPER_ADMIN_MULTISIG ${address} has no code on this chain — it is an EOA or a wrong ` +
        `address/network. The super-admin must be a deployed multisig (e.g. a Safe).`
    );
  }
  const safe = new ethers.Contract(address, SAFE_ABI, provider);
  let threshold: number;
  let owners: string[];
  try {
    threshold = Number(await safe.getThreshold());
    owners = (await safe.getOwners()).map((o: string) => ethers.getAddress(o));
  } catch {
    throw new Error(
      `SUPER_ADMIN_MULTISIG ${address} does not answer getThreshold()/getOwners() — not a Safe.`
    );
  }
  const mainnet = MAINNET_CHAIN_IDS.has(opts.chainId);
  if (threshold < 2 && (mainnet || !opts.allowSingleSigner)) {
    throw new Error(
      `Multisig ${address} is ${threshold}-of-${owners.length}: one key can act alone, which ` +
        `defeats the point. Use a threshold of at least 2` +
        (mainnet ? "." : " (or ALLOW_SINGLE_SIGNER=1 for a testnet rehearsal).")
    );
  }
  if (opts.deployer && threshold <= 1 && owners.includes(ethers.getAddress(opts.deployer))) {
    throw new Error(`The deployer alone controls multisig ${address}; that is still a single key.`);
  }
  return { address, threshold, owners };
}

/** Step 1: propose. Idempotent — skips if already proposed and unexpired. */
export async function proposeHandoff(
  integrator: ethers.Contract,
  multisig: string,
  log: (m: string) => void = console.log
) {
  const current = ethers.getAddress(await integrator.superAdmin());
  if (current === ethers.getAddress(multisig)) {
    log(`Super-admin is already ${multisig}.`);
    return;
  }
  const pending = await integrator.pendingSuperAdmin();
  const expiry = Number(await integrator.pendingSuperAdminExpiry());
  const now = Math.floor(Date.now() / 1000);
  if (pending.toLowerCase() === multisig.toLowerCase() && expiry > now + 3600) {
    log(
      `Handoff to ${multisig} already proposed (expires ${new Date(expiry * 1000).toISOString()}).`
    );
    return;
  }
  await (await integrator.transferSuperAdmin(multisig)).wait();
  const got = await integrator.pendingSuperAdmin();
  if (got.toLowerCase() !== multisig.toLowerCase()) {
    throw new Error(`transferSuperAdmin did not take: pendingSuperAdmin = ${got}`);
  }
  log(`Proposed super-admin handoff → ${multisig} (the multisig must accept within 7 days).`);
}

/** Steps 2 + 3 as the Safe batch to submit (Transaction Builder: to / value / data). */
export function safeBatch(integrator: string, deployer: string) {
  const iface = new ethers.Interface([
    "function acceptSuperAdmin()",
    "function removeOwner(address)",
  ]);
  return [
    {
      to: integrator,
      value: "0",
      data: iface.encodeFunctionData("acceptSuperAdmin"),
      what: "acceptSuperAdmin()",
    },
    {
      to: integrator,
      value: "0",
      data: iface.encodeFunctionData("removeOwner", [deployer]),
      what: `removeOwner(${deployer})  — drop the deployer key's owner access`,
    },
  ];
}

export function printSafeBatch(integrator: string, deployer: string, multisig: string) {
  console.log("");
  console.log(
    `Now, FROM THE MULTISIG ${multisig}, submit this batch (Safe → Transaction Builder):`
  );
  for (const [i, t] of safeBatch(integrator, deployer).entries()) {
    console.log(`  ${i + 1}. ${t.what}`);
    console.log(`     to:    ${t.to}`);
    console.log(`     value: ${t.value}`);
    console.log(`     data:  ${t.data}`);
  }
  console.log(
    "Then confirm with: ACTION=status npx hardhat run scripts/handoff-super-admin.ts --network <net>"
  );
}

export type HandoffStatus = {
  superAdmin: string;
  pending: string;
  pendingExpiry: number;
  superAdminIsContract: boolean;
  deployerStillOwner: boolean;
  done: boolean;
};

/** Is the handoff finished — multisig is root and the deployer key holds nothing? */
export async function handoffStatus(
  integrator: ethers.Contract,
  provider: ethers.Provider,
  multisig: string,
  deployer: string
): Promise<HandoffStatus> {
  const superAdmin = ethers.getAddress(await integrator.superAdmin());
  const pending = await integrator.pendingSuperAdmin();
  const pendingExpiry = Number(await integrator.pendingSuperAdminExpiry());
  const superAdminIsContract = (await provider.getCode(superAdmin)) !== "0x";
  const deployerStillOwner: boolean = await integrator.isOwner(deployer);
  const deployerRole = Number(await integrator.roleOf(deployer));
  return {
    superAdmin,
    pending,
    pendingExpiry,
    superAdminIsContract,
    deployerStillOwner,
    done:
      superAdmin === ethers.getAddress(multisig) &&
      superAdminIsContract &&
      !deployerStillOwner &&
      deployerRole === 0,
  };
}
