import { ethers } from "hardhat";

/**
 * Issue a Base Sepolia liveness attestation for a wallet against the deployed
 * InvestablChallengeCheckoutIntegrator.
 *
 * On testnet the deployer key doubles as the simple-kyc liveness signer, so P2P
 * can mint attestations for Investabl's test wallets without shipping a signing
 * key. In production this is replaced by the real simple-kyc service.
 *
 * Prints the four arguments Investabl's frontend passes to
 * `submitLivenessAttestation(nullifier, limit, expiry, signature)`. The wallet
 * itself sends that transaction — the attestation is bound to WALLET, so it
 * cannot be redeemed by anyone else.
 *
 * Usage:
 *   INTEGRATOR=0x... WALLET=0x... \
 *     npx hardhat run scripts/local/attest-investabl.ts --network baseSepolia
 *
 * Optional:
 *   LIMIT=20000000     attested per-tx limit, 6dp (default 20 USDC)
 *   TTL=86400          seconds until the attestation can no longer be claimed
 *   SUBMIT=1           also send the tx, if the deployer IS the wallet
 */

const INTEGRATOR = process.env.INTEGRATOR || "";
const WALLET = process.env.WALLET || "";
const LIMIT = process.env.LIMIT || "20000000";
const TTL = BigInt(process.env.TTL || "86400");

async function main() {
  if (!INTEGRATOR || !WALLET) throw new Error("INTEGRATOR and WALLET are required");

  const [signer] = await ethers.getSigners();
  const integrator = await ethers.getContractAt(
    "InvestablChallengeCheckoutIntegrator",
    INTEGRATOR
  );

  const attestor: string = await integrator.livenessAttestor();
  const me = await signer.getAddress();
  if (attestor.toLowerCase() !== me.toLowerCase()) {
    throw new Error(
      `This key (${me}) is not the configured livenessAttestor (${attestor}) — ` +
        `the attestation would be rejected with InvalidSignature.`
    );
  }

  const chainId = (await ethers.provider.getNetwork()).chainId;
  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  const expiry = now + TTL;

  // Per-(tenant, human) and single-use on-chain. Derived from the wallet here
  // because testnet has no real identity behind it; the production service must
  // derive it from the verified human, not the wallet.
  const nullifier = ethers.keccak256(
    ethers.toUtf8Bytes(`investabl:liveness:${WALLET.toLowerCase()}:${INTEGRATOR.toLowerCase()}`)
  );

  const signature = await signer.signTypedData(
    { name: "LivenessVerifier", version: "1", chainId, verifyingContract: INTEGRATOR },
    {
      LivenessAttestation: [
        { name: "wallet", type: "address" },
        { name: "nullifier", type: "bytes32" },
        { name: "limit", type: "uint256" },
        { name: "expiry", type: "uint256" },
      ],
    },
    { wallet: WALLET, nullifier, limit: BigInt(LIMIT), expiry }
  );

  const spent = await integrator.livenessNullifierSpent(nullifier);

  console.log("\n=== liveness attestation ===");
  console.log(`integrator : ${INTEGRATOR}`);
  console.log(`wallet     : ${WALLET}`);
  console.log(`nullifier  : ${nullifier}`);
  console.log(`limit      : ${LIMIT}  (${ethers.formatUnits(LIMIT, 6)} USDC)`);
  console.log(`expiry     : ${expiry}  (${new Date(Number(expiry) * 1000).toISOString()})`);
  console.log(`signature  : ${signature}`);
  console.log(`\nalready claimed: ${spent}`);
  console.log(`\nThe wallet calls:`);
  console.log(
    `  submitLivenessAttestation(\n    "${nullifier}",\n    ${LIMIT},\n    ${expiry},\n    "${signature}"\n  )`
  );

  if (process.env.SUBMIT === "1") {
    if (WALLET.toLowerCase() !== me.toLowerCase()) {
      throw new Error("SUBMIT=1 only works when WALLET is the signer — the wallet must send it");
    }
    if (spent) {
      console.log("\nnullifier already spent — nothing to submit");
      return;
    }
    console.log("\nsubmitting…");
    await (
      await integrator.submitLivenessAttestation(nullifier, BigInt(LIMIT), expiry, signature)
    ).wait(2);
    console.log(`tier            : ${await integrator.userTier(WALLET)}`);
    console.log(
      `effectiveLimit  : ${ethers.formatUnits(await integrator.effectiveLimit(WALLET), 6)} USDC`
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
