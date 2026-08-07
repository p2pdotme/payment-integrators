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
 *   BASE_RPC            RPC (preferred); BASE_SEPOLIA_RPC / default sepolia only
 *                       as a testnet fallback — a mainnet run MUST pass BASE_RPC
 *                       + EXPECTED_CHAIN_ID or it silently hits Base Sepolia.
 *   EXPECTED_CHAIN_ID   optional but STRONGLY advised — asserts the network so a
 *                       rotation can't land on the wrong chain (8453 = mainnet).
 *   MNEMONIC_KEY / DEPLOYER_PRIVATE_KEY   owner key
 *   LIVENESS_API        default https://liveness-api.p2p.cool
 *   KYC_API             the passport/tier-2 backend. If omitted, kycAttestor is
 *                       left as-is AND the final safety check FAILS (a tier-2
 *                       lane self-attestable by the deploy key is not shippable).
 *   DRY_RUN=1           read + diff only, send nothing (safety check warns only)
 */
import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

const SHOWDOWN_ADDRESS = process.env.SHOWDOWN_ADDRESS || "";
const RPC = process.env.BASE_RPC || process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";
const EXPECTED_CHAIN_ID = process.env.EXPECTED_CHAIN_ID || "";
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
  // Refuse to rotate on the wrong network: the RPC default is Base Sepolia, so a
  // mainnet rotation without EXPECTED_CHAIN_ID could silently hit testnet. (#52)
  if (EXPECTED_CHAIN_ID && chainId.toString() !== EXPECTED_CHAIN_ID) {
    throw new Error(
      `chainId ${chainId} != EXPECTED_CHAIN_ID ${EXPECTED_CHAIN_ID} — refusing to rotate on the wrong network`
    );
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

  // Final safety gate (#52): NEITHER lane may be unset (fails closed) or still
  // the deploy key (self-attestable). This is what makes leaving KYC_API unset —
  // the default — a hard error instead of a green run that ships a tier-2 lane
  // the deployer can forge $100/$200 attestations into.
  console.log("\n── attestor safety check ─────────────────");
  const finalLiveness: string = await integrator.livenessAttestor();
  const finalKyc: string = await integrator.kycAttestor();
  for (const [name, addr, api] of [
    ["livenessAttestor", finalLiveness, "LIVENESS_API"],
    ["kycAttestor", finalKyc, "KYC_API"],
  ] as const) {
    const reason =
      addr === ethers.ZeroAddress
        ? "unset (0) — that tier fails closed"
        : addr.toLowerCase() === me.toLowerCase()
          ? `still the deploy key ${me} — that tier is SELF-ATTESTABLE`
          : "";
    if (reason) {
      const msg = `${name} ${reason}; set ${api} and re-run`;
      if (DRY_RUN) console.log(`  ! ${msg}`);
      else throw new Error(msg);
    } else {
      console.log(`  ✓ ${name} = ${addr} (non-deployer service signer)`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
