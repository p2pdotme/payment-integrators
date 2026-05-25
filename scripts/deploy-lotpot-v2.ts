import { ethers } from "hardhat";

/**
 * Deploy LotPotCheckoutIntegratorV2 for the buyer-cashback growth campaign.
 *
 * V2 differences vs V1:
 *  - On-chain `issuedCredit` ledger written by whitelisted issuers (the
 *    P2P Diamond on day one) — see `setCreditIssuer`.
 *  - `setVaults(grant, fallback_)` points the integrator at two GrantVault
 *    instances. Both are P2P-deployed and P2P-owned; Megapot funds the
 *    primary "grant" vault via plain `usdc.transfer`, P2P treasury funds
 *    the fallback. Each vault must call
 *    `vault.setApprovedSpender(thisIntegrator, true)` (one call per vault,
 *    by its owner).
 *  - `_route` pulls USDC from the vaults at ticket-purchase time when a
 *    user has issued credit; partial fulfillment if vaults are dry.
 *
 * Megapot Base mainnet:
 *   Jackpot:                  0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2
 *   BatchPurchaseFacilitator: 0x01774B531591b286b9f02C6Bc02ab3fD9526Aa76
 *   USDC:                     0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
 *   Ticket NFT:               0x48FfE35AbB9f4780a4f1775C2Ce1c46185b366e4
 *
 * Required:
 *   DIAMOND_ADDRESS, USDC_ADDRESS, MEGAPOT_ADDRESS,
 *   BATCH_FACILITATOR_ADDRESS, JACKPOT_NFT_ADDRESS
 *
 * Optional:
 *   BASE_TX_LIMIT=50000000        (6 decimals, default 50 USDC)
 *   DAILY_TX_COUNT_LIMIT=10
 *   SOURCE_TAG=lotpot-v2          (free-form telemetry, encoded as bytes32)
 *
 * After deployment, complete the wiring out of band:
 *   1. Deploy GrantVault x 2 (P2P treasury owner each). One = grant
 *      (Megapot funds via plain usdc.transfer), one = fallback
 *      (pre-seeded from P2P treasury).
 *   2. On this integrator: setCreditIssuer(diamondAddr, true) and
 *      setVaults(grantVaultAddr, fallbackVaultAddr).
 *   3. On each vault (by its P2P owner): setApprovedSpender(thisIntegrator, true).
 *   4. On the Diamond: setLotpotBuyerCashback(200, thisIntegrator) —
 *      use scripts/setLotpotBuyerCashback.ts in contracts-v4.
 *   5. Add this integrator to Megapot's batch facilitator allowlist (same
 *      as V1) before any >10-ticket order can fulfill.
 *   6. Share the grant vault address with Megapot so they can fund it.
 */

const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "";
const MEGAPOT_ADDRESS = process.env.MEGAPOT_ADDRESS || "";
const BATCH_FACILITATOR_ADDRESS = process.env.BATCH_FACILITATOR_ADDRESS || "";
const JACKPOT_NFT_ADDRESS = process.env.JACKPOT_NFT_ADDRESS || "";
const BASE_TX_LIMIT = process.env.BASE_TX_LIMIT || "50000000";
const DAILY_TX_COUNT_LIMIT = process.env.DAILY_TX_COUNT_LIMIT || "10";
const SOURCE_TAG = process.env.SOURCE_TAG || "lotpot-v2";

async function main() {
  if (
    !DIAMOND_ADDRESS ||
    !USDC_ADDRESS ||
    !MEGAPOT_ADDRESS ||
    !BATCH_FACILITATOR_ADDRESS ||
    !JACKPOT_NFT_ADDRESS
  ) {
    throw new Error(
      "DIAMOND_ADDRESS, USDC_ADDRESS, MEGAPOT_ADDRESS, BATCH_FACILITATOR_ADDRESS, and JACKPOT_NFT_ADDRESS env vars required"
    );
  }

  const [deployer] = await ethers.getSigners();
  const sourceBytes32 = ethers.encodeBytes32String(SOURCE_TAG);

  console.log("Deployer:", await deployer.getAddress());
  console.log("Diamond:", DIAMOND_ADDRESS);
  console.log("USDC:", USDC_ADDRESS);
  console.log("Megapot:", MEGAPOT_ADDRESS);
  console.log("BatchFacilitator:", BATCH_FACILITATOR_ADDRESS);
  console.log("JackpotNFT:", JACKPOT_NFT_ADDRESS);
  console.log("BaseTxLimit (raw 6-dec):", BASE_TX_LIMIT);
  console.log("DailyTxCountLimit:", DAILY_TX_COUNT_LIMIT);
  console.log("SourceTag:", SOURCE_TAG, "(bytes32:", sourceBytes32, ")");

  console.log("");
  console.log("Deploying LotPotCheckoutIntegratorV2 (constructor also deploys UserProxy impl)…");
  const Integrator = await ethers.getContractFactory("LotPotCheckoutIntegratorV2");
  const integrator = await Integrator.deploy(
    DIAMOND_ADDRESS,
    USDC_ADDRESS,
    MEGAPOT_ADDRESS,
    BATCH_FACILITATOR_ADDRESS,
    JACKPOT_NFT_ADDRESS,
    BASE_TX_LIMIT,
    DAILY_TX_COUNT_LIMIT,
    sourceBytes32
  );
  await integrator.waitForDeployment();

  const integratorAddr = await integrator.getAddress();
  const proxyImpl = await integrator.proxyImpl();

  console.log("");
  console.log("─── Deployed ────────────────────────────────────────────");
  console.log("LotPotCheckoutIntegratorV2:", integratorAddr);
  console.log("UserProxy impl:           ", proxyImpl);
  console.log("─────────────────────────────────────────────────────────");
  console.log("");
  console.log("Next steps:");
  console.log("  1. Deploy GrantVault x 2 (P2P treasury = owner) — grant + fallback.");
  console.log("  2. integrator.setCreditIssuer(<diamondAddr>, true)");
  console.log("  3. integrator.setVaults(<grantVaultAddr>, <fallbackVaultAddr>)");
  console.log(
    "  4. On each vault (its P2P owner): vault.setApprovedSpender(",
    integratorAddr,
    ", true)"
  );
  console.log("  5. Diamond super-admin: setLotpotBuyerCashback(200,", integratorAddr, ")");
  console.log("     (use contracts-v4 scripts/setLotpotBuyerCashback.ts)");
  console.log("  6. Coordinate with Megapot to add this integrator to BatchPurchaseFacilitator");
  console.log("     allowlist (required for >10-ticket orders), and share the grant vault");
  console.log("     address so they can fund it.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
