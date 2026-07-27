/**
 * Rotate ShowdownCheckoutIntegrator's attestor signers to the live services.
 *
 * The attestor is the one piece of integrator config whose only source of truth
 * is the running service, so this script FETCHES it from `GET /v1/attestor`
 * rather than taking it as an argument. A relayed address is not authoritative
 * — a wrong value silently bricks the whole tier (every submit*Attestation
 * reverts InvalidSignature) and only surfaces when a user first tries to claim.
 *
 * Standalone (inline ABI, no artifacts) so it runs without compiling the repo.
 *
 *   SHOWDOWN_ADDRESS=0x... npx tsx scripts/local/set-showdown-attestors.ts
 *
 * Env:
 *   SHOWDOWN_ADDRESS    required — the integrator
 *   BASE_SEPOLIA_RPC    RPC (falls back to https://sepolia.base.org)
 *   MNEMONIC_KEY / DEPLOYER_PRIVATE_KEY   owner key
 *   LIVENESS_API        default https://liveness-api.p2p.cool
 *   KYC_API             optional — the passport/tier-2 backend. Omitted =>
 *                       kycAttestor is left alone.
 *   DRY_RUN=1           read + diff only, send nothing
 */
import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

const SHOWDOWN_ADDRESS = process.env.SHOWDOWN_ADDRESS || "";
const RPC = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";
const LIVENESS_API = process.env.LIVENESS_API || "https://liveness-api.p2p.cool";
const KYC_API = process.env.KYC_API || "";
const DRY_RUN = process.env.DRY_RUN === "1";

const ABI = [
  "function owner() view returns (address)",
  "function livenessAttestor() view returns (address)",
  "function kycAttestor() view returns (address)",
  "function tierCap(uint8,uint8) view returns (uint256)",
  "function maxTierCap(uint8,uint8) view returns (uint256)",
  "function dailyTxCountLimit() view returns (uint256)",
  "function setLivenessAttestor(address)",
  "function setKycAttestor(address)",
];

/** `GET <base>/v1/attestor` -> checksummed signer address. */
async function fetchAttestor(base: string): Promise<string> {
  const url = `${base.replace(/\/$/, "")}/v1/attestor`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const body = (await res.json()) as { address?: string };
  if (!body.address || !ethers.isAddress(body.address)) {
    throw new Error(`${url} -> no usable address in ${JSON.stringify(body)}`);
  }
  return ethers.getAddress(body.address);
}

function loadSigner(provider: ethers.Provider): ethers.Signer {
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (pk) return new ethers.Wallet(pk, provider);
  const mnemonic = process.env.MNEMONIC_KEY;
  if (!mnemonic) throw new Error("DEPLOYER_PRIVATE_KEY or MNEMONIC_KEY required");
  return ethers.Wallet.fromPhrase(mnemonic).connect(provider);
}

async function main() {
  if (!SHOWDOWN_ADDRESS) throw new Error("SHOWDOWN_ADDRESS required");

  const provider = new ethers.JsonRpcProvider(RPC);
  const signer = loadSigner(provider);
  const me = await signer.getAddress();
  const { chainId } = await provider.getNetwork();
  const integrator = new ethers.Contract(SHOWDOWN_ADDRESS, ABI, signer);

  const owner: string = await integrator.owner();
  console.log("integrator:", SHOWDOWN_ADDRESS);
  console.log("chainId:   ", chainId.toString());
  console.log("signer:    ", me);
  console.log("owner:     ", owner);
  if (owner.toLowerCase() !== me.toLowerCase()) {
    throw new Error("signer is not owner — setters are onlyOwner, tx would revert");
  }

  // The service signs EIP-712 over (domain, verifyingContract = integrator,
  // chainId). Right signer + wrong binding still reverts, so surface both.
  console.log("\nEIP-712 binding the services must sign with:");
  console.log(`  liveness: LivenessVerifier / 1 / chainId ${chainId} / ${SHOWDOWN_ADDRESS}`);
  console.log(`  kyc:      KycVerifier      / 1 / chainId ${chainId} / ${SHOWDOWN_ADDRESS}`);
  // tierCap[tier][region] — region 0 = India (INR), 1 = Abroad.
  const d = (n: bigint) => `$${Number(n) / 1e6}`;
  console.log(
    `tierCaps:   liveness ${d(await integrator.tierCap(1, 0))}/${d(await integrator.tierCap(1, 1))} ` +
      `kyc ${d(await integrator.tierCap(2, 0))}/${d(await integrator.tierCap(2, 1))} (India/Abroad)`
  );
  console.log(
    `ceilings:   liveness ${d(await integrator.maxTierCap(1, 0))}/${d(await integrator.maxTierCap(1, 1))} ` +
      `kyc ${d(await integrator.maxTierCap(2, 0))}/${d(await integrator.maxTierCap(2, 1))} (immutable)`
  );
  console.log(`dailyLimit: ${await integrator.dailyTxCountLimit()} per direction per UTC day`);

  const targets = [
    { tier: "liveness", api: LIVENESS_API, read: "livenessAttestor", set: "setLivenessAttestor" },
  ];
  if (KYC_API) {
    targets.push({ tier: "kyc", api: KYC_API, read: "kycAttestor", set: "setKycAttestor" });
  } else {
    console.log(`\n! KYC_API unset — leaving kycAttestor at ${await integrator.kycAttestor()}`);
  }

  for (const t of targets) {
    console.log(`\n── ${t.tier} ──────────────────────────────`);
    const live = await fetchAttestor(t.api);
    const current: string = await integrator[t.read]();
    console.log(`  live signer:      ${live}   (${t.api}/v1/attestor)`);
    console.log(`  on-chain current: ${current}`);

    if (current.toLowerCase() === live.toLowerCase()) {
      console.log("  ✓ already correct — no tx");
      continue;
    }
    if (DRY_RUN) {
      console.log(`  DRY_RUN — would call ${t.set}(${live})`);
      continue;
    }

    const tx = await integrator[t.set](live);
    console.log(`  ${t.set}(${live})`);
    console.log(`  tx: ${tx.hash}`);
    const rcpt = await tx.wait();
    console.log(`  mined in block ${rcpt?.blockNumber} (status ${rcpt?.status})`);

    // The deployer is EIP-7702 delegated and reads right after wait() can come
    // back stale on public RPC — poll until the slot reflects the set.
    let confirmed = "";
    for (let i = 0; i < 10; i++) {
      confirmed = await integrator[t.read]();
      if (confirmed.toLowerCase() === live.toLowerCase()) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (confirmed.toLowerCase() !== live.toLowerCase()) {
      throw new Error(`${t.read}() still ${confirmed} after ${t.set} — investigate`);
    }
    console.log(`  ✓ ${t.read}() == ${confirmed}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
