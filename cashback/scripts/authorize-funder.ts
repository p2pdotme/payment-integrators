import { ethers } from "hardhat";

/**
 * Authorise (or revoke) a spender to attach YOUR wallet as a campaign's
 * funding wallet, for ONE reward token.
 *
 * Run this as the FUNDING WALLET. Only the wallet itself can grant this —
 * that is what makes it proof of control rather than an assertion.
 *
 * AUDIT N8. There was no script for this at all, so the third-party funding
 * flow (a treasury backing a partner's campaign) had no operator path and
 * had to be driven by hand.
 *
 * AUDIT F4. The grant is scoped to a single token. An earlier version was an
 * unscoped blanket grant, so a treasury that authorised a partner for a
 * points-token campaign had also authorised a USDC campaign from the same
 * wallet. Granting for one token says nothing about any other.
 *
 * Note this is only half of the setup. The registry pulls rewards with
 * `transferFrom`, so the wallet must ALSO hold an ERC-20 allowance for the
 * registry. The two are independent kill switches: revoking here stops this
 * spender's campaigns alone; revoking the ERC-20 approval stops every
 * campaign funded by this wallet.
 *
 * Required env:
 *   REGISTRY_ADDRESS   deployed CashbackRegistry
 *   SPENDER            address allowed to name your wallet as the funder
 *   TOKEN              reward token this grant covers — and only this one
 *
 * Optional env:
 *   ALLOWED            "true" to grant, "false" to revoke (default true)
 *
 * Example:
 *   REGISTRY_ADDRESS=0x… SPENDER=0x… TOKEN=0x… \
 *   npx hardhat run scripts/authorize-funder.ts --network baseSepolia
 */

const REGISTRY_ADDRESS = process.env.REGISTRY_ADDRESS || "";
const SPENDER = process.env.SPENDER || "";
const TOKEN = process.env.TOKEN || "";
const ALLOWED = (process.env.ALLOWED || "true").toLowerCase() !== "false";

async function main() {
  if (!REGISTRY_ADDRESS || !SPENDER || !TOKEN) {
    throw new Error("REGISTRY_ADDRESS, SPENDER and TOKEN env vars are required");
  }

  const [signer] = await ethers.getSigners();
  const registry = await ethers.getContractAt("CashbackRegistry", REGISTRY_ADDRESS, signer);

  console.log("─────────────────────────────────────────────────────────");
  console.log("Funding wallet:", signer.address, "(you)");
  console.log("Spender:       ", SPENDER);
  console.log("Token:         ", TOKEN);
  console.log("Action:        ", ALLOWED ? "AUTHORIZE" : "REVOKE");
  console.log("─────────────────────────────────────────────────────────");
  console.log("");

  const tx = await registry.authorizeCampaignFunder(SPENDER, TOKEN, ALLOWED);
  await tx.wait();

  console.log(ALLOWED ? "Authorized." : "Revoked.", "tx:", tx.hash);
  if (ALLOWED) {
    console.log("");
    console.log("Remember: also approve the registry on the ERC-20, or campaigns");
    console.log("funded by this wallet will resolve and then fail to transfer.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
