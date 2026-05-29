import { ethers } from "hardhat";

/**
 * Migrate a TradeStars integrator from one RestrictedYieldVault to another.
 *
 * Vaults are not upgradeable: any vault code change requires deploying a new
 * vault contract and moving funds across. This script automates that flow.
 *
 * The migration runs in 7 phases:
 *
 *   1. Pre-flight checks + disable offramp
 *      - signer owns the integrator
 *      - signer owns the old vault
 *      - disables offramp on the integrator (blocks NEW SELL orders); re-
 *        enabled in phase 7. The caller must still ensure in-flight orders
 *        have settled first, since the drain + rewire follow immediately.
 *
 *   2. Deploy new vault (same Aave + aUSDC + USDC addresses as old)
 *
 *   3. Drain owner's portion of the old vault
 *      - ownerWithdraw(ownerQuota) pulls yield + 40% principal headroom
 *
 *   4. Drain operator's portion of the old vault
 *      - SECURITY-SENSITIVE WINDOW: this requires temporarily re-routing the
 *        operator role away from the integrator to the signer. Between
 *        `setOfframpOperator(signer)` and the drain call, a compromised
 *        signer key has full operator authority. The script does both steps
 *        back-to-back; for higher-value vaults use a multisig batch (see
 *        --print-multisig-calldata).
 *
 *   5. Move drained USDC into the new vault
 *      - signer approves USDC to new vault
 *      - deposit() re-establishes principal up to the old totalPrincipal;
 *        any excess recovered (Aave yield + owner-funded liquidity) goes in
 *        via fund() so it stays fee-free and owner-recoverable rather than
 *        being re-billed as onramp volume
 *
 *   6. Rewire integrator
 *      - newVault.setOfframpOperator(integrator)
 *      - integrator.setYieldVault(newVault)
 *
 *   7. Re-enable offramp on the integrator
 *      - integrator.setOfframpEnabled(true)
 *
 * State that does NOT carry over:
 *   - totalPrincipal is re-established via deposit() up to the old value,
 *     capped at what was actually recovered; recovered excess beyond
 *     principal (yield + owner-funded liquidity) goes in fee-free via fund()
 *     and surfaces as yield, not principal.
 *   - ownerWithdrawnPrincipal resets to 0 — the owner's lifetime 40% cap
 *     restarts against the new vault. If the cumulative cap must persist
 *     across migrations, track it off-chain.
 *   - offrampWithdrawn resets to 0 (matters less under the 100% offramp
 *     model since the cap is liquid balance, not bookkeeping).
 *   - P2P fee ledgers (p2pOnrampAccrued / p2pOfframpAccrued) reset to 0.
 *     Pre-flight logs the old vault's ledgers as the final P2P liability:
 *     SNAPSHOT and bill those BEFORE the drain. Phase 4 drains via
 *     releaseForOfframp, which itself credits the old vault's offramp
 *     ledger (offramp rate × drained amount), so the post-drain value is
 *     inflated by the migration and is NOT the true liability. Re-depositing
 *     the migrated principal on the new vault re-accrues the onramp fee on
 *     the principal portion only (the fund() excess is fee-free), so the
 *     off-chain biller MUST treat each vault's ledgers as cumulative-from-
 *     zero and not double-bill carried-over principal.
 *   - P2P fee RATES (p2pOnrampBps / p2pOfframpBps) reset to the 2.5%
 *     defaults on a fresh vault; this script carries the old vault's rates
 *     over automatically when they differ from the defaults.
 *
 * Usage:
 *   INTEGRATOR_ADDRESS=0x...       # the deployed TradeStarsCheckoutIntegrator
 *   OLD_VAULT_ADDRESS=0x...        # the vault being retired
 *   USDC_ADDRESS=0x...
 *   AAVE_POOL_ADDRESS=0x...
 *   AUSDC_ADDRESS=0x...
 *   [EXECUTE=1]                    # actually send txs; default is dry-run
 *   [PRINT_CALLDATA=1]             # also log multisig-ready calldata for each tx
 *   npx hardhat run scripts/migrate-tradestars-vault.ts --network base
 *
 * Run with EXECUTE unset first to verify the plan, then re-run with EXECUTE=1.
 */

// ─── Config ──────────────────────────────────────────────────────────

const INTEGRATOR_ADDRESS = process.env.INTEGRATOR_ADDRESS || "";
const OLD_VAULT_ADDRESS = process.env.OLD_VAULT_ADDRESS || "";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "";
const AAVE_POOL_ADDRESS = process.env.AAVE_POOL_ADDRESS || "";
const AUSDC_ADDRESS = process.env.AUSDC_ADDRESS || "";

const EXECUTE = process.env.EXECUTE === "1";
const PRINT_CALLDATA = process.env.PRINT_CALLDATA === "1";

const fmt = (n: bigint) => `${ethers.formatUnits(n, 6)} USDC`;

// Minimal ABIs — avoids requiring artifacts to be present for whichever
// vault version is on-chain (old vault may have been compiled from a
// different commit). All functions referenced are stable across versions.
const VAULT_ABI = [
  "function owner() view returns (address)",
  "function offrampOperator() view returns (address)",
  "function totalPrincipal() view returns (uint256)",
  "function ownerWithdrawnPrincipal() view returns (uint256)",
  "function offrampWithdrawn() view returns (uint256)",
  "function getYield() view returns (uint256)",
  "function ownerQuota() view returns (uint256)",
  "function offrampQuota() view returns (uint256)",
  "function ownerWithdraw(uint256)",
  "function releaseForOfframp(uint256)",
  "function returnFromOfframp(uint256)",
  "function setOfframpOperator(address)",
  "function deposit(uint256)",
  "function fund(uint256)",
  // P2P fee ledger (accrual-only vault version). Read defensively via
  // tryRead — a vault deployed before the P2P fee won't expose these.
  "function p2pOnrampBps() view returns (uint256)",
  "function p2pOfframpBps() view returns (uint256)",
  "function p2pOnrampAccrued() view returns (uint256)",
  "function p2pOfframpAccrued() view returns (uint256)",
  "function setP2PFeeBps(uint256,uint256)",
];

const INTEGRATOR_ABI = [
  "function owner() view returns (address)",
  "function yieldVault() view returns (address)",
  "function offrampEnabled() view returns (bool)",
  "function setYieldVault(address)",
  "function setOfframpEnabled(bool)",
];

const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
];

const AUSDC_ABI = ["function balanceOf(address) view returns (uint256)"];

// ─── Helpers ─────────────────────────────────────────────────────────

function need(name: string, value: string) {
  if (!value) throw new Error(`Missing required env var: ${name}`);
}

// Read a uint256 view that may not exist on the on-chain vault version
// (e.g. a vault deployed before the P2P fee ledger). Returns null instead
// of throwing so pre-flight degrades gracefully across vault versions.
async function tryRead(contract: any, method: string): Promise<bigint | null> {
  try {
    return (await contract[method]()) as bigint;
  } catch {
    return null;
  }
}

async function sendOrLog(description: string, contract: any, method: string, args: any[]) {
  console.log(`\n→ ${description}`);
  const calldata = contract.interface.encodeFunctionData(method, args);
  console.log(`    target:   ${await contract.getAddress()}`);
  console.log(`    call:     ${method}(${args.map((a: any) => `${a}`).join(", ")})`);
  if (PRINT_CALLDATA) {
    console.log(`    calldata: ${calldata}`);
  }
  if (!EXECUTE) {
    console.log("    [dry-run] skipped");
    return;
  }
  const tx = await contract[method](...args);
  const rcpt = await tx.wait();
  console.log(`    sent:     ${rcpt?.hash}  block ${rcpt?.blockNumber}`);
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  need("INTEGRATOR_ADDRESS", INTEGRATOR_ADDRESS);
  need("OLD_VAULT_ADDRESS", OLD_VAULT_ADDRESS);
  need("USDC_ADDRESS", USDC_ADDRESS);
  need("AAVE_POOL_ADDRESS", AAVE_POOL_ADDRESS);
  need("AUSDC_ADDRESS", AUSDC_ADDRESS);

  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();

  console.log("╔════════════════════════════════════════════════════════════════╗");
  console.log("║  TradeStars vault migration                                    ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  console.log(`Mode:        ${EXECUTE ? "EXECUTE (txs will be sent)" : "DRY-RUN"}`);
  console.log(`Signer:      ${me}`);
  console.log(`Integrator:  ${INTEGRATOR_ADDRESS}`);
  console.log(`Old vault:   ${OLD_VAULT_ADDRESS}`);
  console.log(`USDC:        ${USDC_ADDRESS}`);
  console.log(`Aave pool:   ${AAVE_POOL_ADDRESS}`);
  console.log(`aUSDC:       ${AUSDC_ADDRESS}`);

  const integrator = new ethers.Contract(INTEGRATOR_ADDRESS, INTEGRATOR_ABI, signer);
  const oldVault = new ethers.Contract(OLD_VAULT_ADDRESS, VAULT_ABI, signer);
  const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, signer);
  const aUsdc = new ethers.Contract(AUSDC_ADDRESS, AUSDC_ABI, signer);

  // ─── Phase 1: Pre-flight ─────────────────────────────────────────
  console.log("\n[1/7] Pre-flight checks + disable offramp");

  const integratorOwner = await integrator.owner();
  const oldVaultOwner = await oldVault.owner();
  const wiredVault = await integrator.yieldVault();
  const offrampEnabled = await integrator.offrampEnabled();
  const oldOperator = await oldVault.offrampOperator();

  console.log(`    integrator.owner():       ${integratorOwner}`);
  console.log(`    oldVault.owner():         ${oldVaultOwner}`);
  console.log(`    integrator.yieldVault():  ${wiredVault}`);
  console.log(`    integrator.offrampEnabled: ${offrampEnabled}`);
  console.log(`    oldVault.offrampOperator: ${oldOperator}`);

  if (integratorOwner.toLowerCase() !== me.toLowerCase())
    throw new Error(`Signer is not integrator owner (expected ${integratorOwner})`);
  if (oldVaultOwner.toLowerCase() !== me.toLowerCase())
    throw new Error(`Signer is not old vault owner (expected ${oldVaultOwner})`);
  if (wiredVault.toLowerCase() !== OLD_VAULT_ADDRESS.toLowerCase())
    throw new Error(`Integrator is wired to ${wiredVault}, not OLD_VAULT_ADDRESS`);
  if (oldOperator.toLowerCase() !== INTEGRATOR_ADDRESS.toLowerCase())
    throw new Error(
      `Old vault operator (${oldOperator}) is not the integrator — unexpected wiring`
    );

  const oldVaultBalance: bigint = await aUsdc.balanceOf(OLD_VAULT_ADDRESS);
  const totalPrincipal: bigint = await oldVault.totalPrincipal();
  const ownerQuota: bigint = await oldVault.ownerQuota();
  const offrampQuota: bigint = await oldVault.offrampQuota();
  console.log(`    old vault aUSDC balance:  ${fmt(oldVaultBalance)}`);
  console.log(`    totalPrincipal:           ${fmt(totalPrincipal)}`);
  console.log(`    ownerQuota:               ${fmt(ownerQuota)}`);
  console.log(`    offrampQuota:             ${fmt(offrampQuota)}`);

  // P2P fee ledger snapshot — read defensively (older vaults won't have it).
  const oldOnrampBps = await tryRead(oldVault, "p2pOnrampBps");
  const oldOfframpBps = await tryRead(oldVault, "p2pOfframpBps");
  const oldOnrampAccrued = await tryRead(oldVault, "p2pOnrampAccrued");
  const oldOfframpAccrued = await tryRead(oldVault, "p2pOfframpAccrued");
  const hasP2PLedger =
    oldOnrampBps !== null &&
    oldOfframpBps !== null &&
    oldOnrampAccrued !== null &&
    oldOfframpAccrued !== null;

  console.log("    ── P2P fee ledger (old vault) ──");
  if (hasP2PLedger) {
    console.log(`    p2pOnrampBps:             ${oldOnrampBps} (${Number(oldOnrampBps) / 100}%)`);
    console.log(`    p2pOfframpBps:            ${oldOfframpBps} (${Number(oldOfframpBps) / 100}%)`);
    console.log(`    p2pOnrampAccrued:         ${fmt(oldOnrampAccrued!)}`);
    console.log(`    p2pOfframpAccrued:        ${fmt(oldOfframpAccrued!)}`);
    console.log(`    P2P total owed (pre-drain): ${fmt(oldOnrampAccrued! + oldOfframpAccrued!)}`);
    console.log("    ⚠  Snapshot the values above NOW and bill the off-chain P2P invoice");
    console.log("       against them. Phase 4 drains via releaseForOfframp on the OLD vault,");
    console.log("       inflating its p2pOfframpAccrued by (offramp rate × drained amount) —");
    console.log("       the post-migration value is NOT the true liability.");
  } else {
    console.log("    (old vault predates the P2P fee ledger — nothing to snapshot)");
  }

  if (oldVaultBalance === 0n) {
    console.log("\nOld vault is already empty — only need to rewire the integrator.");
  }

  // ─── Disable offramp (stop new SELL orders before the drain) ─────
  if (offrampEnabled) {
    console.log("\nDisabling offramp on the integrator (blocks NEW SELL orders)…");
    console.log(
      "    ⚠  This does NOT settle in-flight offramps. Ensure any released-but-\n" +
        "       unreconciled SELL orders have settled before the drain — the migration\n" +
        "       moves the vault's liquidity and rewires the integrator to the new vault."
    );
    await sendOrLog("integrator.setOfframpEnabled(false)", integrator, "setOfframpEnabled", [
      false,
    ]);
  } else {
    console.log("\nOfframp already disabled on the integrator — skipping disable step.");
  }

  // ─── Phase 2: Deploy new vault ───────────────────────────────────
  console.log("\n[2/7] Deploy new vault");
  let newVaultAddress: string;
  if (EXECUTE) {
    const Vault = await ethers.getContractFactory("RestrictedYieldVault");
    const newVault = await Vault.deploy(USDC_ADDRESS, AUSDC_ADDRESS, AAVE_POOL_ADDRESS);
    await newVault.deploymentTransaction()?.wait(3);
    newVaultAddress = await newVault.getAddress();
    console.log(`    deployed:                 ${newVaultAddress}`);
  } else {
    newVaultAddress = "0x<NEW_VAULT_ADDRESS_TBD>";
    console.log(`    [dry-run] would deploy RestrictedYieldVault(usdc, aUsdc, aave)`);
  }

  const newVault = EXECUTE ? new ethers.Contract(newVaultAddress, VAULT_ABI, signer) : null;

  // Carry over non-default P2P fee rates. A fresh vault deploys at
  // 2.5%/2.5%; replicate the old vault's rates so migration is rate-
  // preserving. Skipped if the old vault predates the fee ledger or
  // already used the defaults.
  const DEFAULT_BPS = 250n;
  const carryRates =
    oldOnrampBps !== null &&
    oldOfframpBps !== null &&
    (oldOnrampBps !== DEFAULT_BPS || oldOfframpBps !== DEFAULT_BPS);
  if (carryRates) {
    if (EXECUTE && newVault) {
      await sendOrLog(
        `newVault.setP2PFeeBps(${oldOnrampBps}, ${oldOfframpBps})  — carry over old rates`,
        newVault,
        "setP2PFeeBps",
        [oldOnrampBps, oldOfframpBps]
      );
    } else {
      console.log(
        `\n→ newVault.setP2PFeeBps(${oldOnrampBps}, ${oldOfframpBps})  — carry over old rates`
      );
      console.log(`    target:   ${newVaultAddress}`);
      console.log("    [dry-run] skipped");
    }
  } else {
    console.log(
      "    P2P fee rates: new vault keeps the 2.5%/2.5% defaults (old vault used defaults or predates the ledger)."
    );
  }

  // Baseline the signer's USDC so phase 5 deposits only what the drain
  // actually pulled from the vault — not any unrelated USDC the signer held.
  const signerUsdcBefore: bigint = EXECUTE ? await usdc.balanceOf(me) : 0n;

  // ─── Phase 3: Drain owner's portion ──────────────────────────────
  console.log("\n[3/7] Drain owner's portion of old vault");
  if (ownerQuota > 0n) {
    await sendOrLog(`ownerWithdraw(${fmt(ownerQuota)})`, oldVault, "ownerWithdraw", [ownerQuota]);
  } else {
    console.log("    skip: ownerQuota = 0");
  }

  // ─── Phase 4: Drain operator's portion ───────────────────────────
  console.log("\n[4/7] Drain operator's portion (security-sensitive)");
  const remainingAfterOwner: bigint = EXECUTE
    ? await aUsdc.balanceOf(OLD_VAULT_ADDRESS)
    : oldVaultBalance - (ownerQuota > oldVaultBalance ? oldVaultBalance : ownerQuota);
  console.log(`    aUSDC remaining after owner draw: ~${fmt(remainingAfterOwner)}`);

  if (remainingAfterOwner > 0n) {
    console.log(
      "    WARNING: between these two calls, the signer key has full operator authority on the"
    );
    console.log("    old vault. For high-value migrations, batch these in a single multisig tx.");
    await sendOrLog(
      `oldVault.setOfframpOperator(${me})  — temp operator handoff`,
      oldVault,
      "setOfframpOperator",
      [me]
    );
    await sendOrLog(
      `oldVault.releaseForOfframp(${fmt(remainingAfterOwner)})`,
      oldVault,
      "releaseForOfframp",
      [remainingAfterOwner]
    );
  } else {
    console.log("    skip: nothing remaining to drain");
  }

  // ─── Phase 5: Move USDC into new vault ───────────────────────────
  // Re-establish principal up to the old vault's onramp total via deposit()
  // (so the P2P onramp fee re-accrues only on actual onramp principal), and
  // route any recovered excess — Aave yield + owner-funded liquidity that
  // exceeded principal — through fund() so it stays fee-free and surfaces as
  // yield (owner-recoverable) rather than being re-billed as onramp volume.
  console.log("\n[5/7] Move USDC into new vault");
  const signerUsdc: bigint = EXECUTE
    ? (await usdc.balanceOf(me)) - signerUsdcBefore // only what the drain pulled in
    : oldVaultBalance; // dry-run estimate
  const principalPortion = signerUsdc < totalPrincipal ? signerUsdc : totalPrincipal;
  const excessPortion = signerUsdc - principalPortion;
  console.log(`    recovered:              ${fmt(signerUsdc)}`);
  console.log(`      → principal (deposit): ${fmt(principalPortion)}`);
  console.log(
    `      → excess (fund):       ${fmt(excessPortion)}  [yield + owner-funded liquidity]`
  );

  if (signerUsdc > 0n) {
    // One approval covers both pulls (deposit + fund consume it in turn).
    await sendOrLog(`usdc.approve(newVault, ${fmt(signerUsdc)})`, usdc, "approve", [
      newVaultAddress,
      signerUsdc,
    ]);
    if (principalPortion > 0n) {
      if (EXECUTE && newVault) {
        await sendOrLog(`newVault.deposit(${fmt(principalPortion)})`, newVault, "deposit", [
          principalPortion,
        ]);
      } else {
        console.log(`\n→ newVault.deposit(${fmt(principalPortion)})`);
        console.log(`    target:   ${newVaultAddress}`);
        console.log("    [dry-run] skipped");
      }
    }
    if (excessPortion > 0n) {
      if (EXECUTE && newVault) {
        await sendOrLog(`newVault.fund(${fmt(excessPortion)})`, newVault, "fund", [excessPortion]);
      } else {
        console.log(`\n→ newVault.fund(${fmt(excessPortion)})`);
        console.log(`    target:   ${newVaultAddress}`);
        console.log("    [dry-run] skipped");
      }
    }
  } else {
    console.log("    skip: nothing to move");
  }

  // ─── Phase 6: Rewire integrator ──────────────────────────────────
  console.log("\n[6/7] Rewire integrator to new vault");
  if (EXECUTE && newVault) {
    await sendOrLog(
      `newVault.setOfframpOperator(${INTEGRATOR_ADDRESS})`,
      newVault,
      "setOfframpOperator",
      [INTEGRATOR_ADDRESS]
    );
  } else {
    console.log(`\n→ newVault.setOfframpOperator(${INTEGRATOR_ADDRESS})`);
    console.log(`    target:   ${newVaultAddress}`);
    console.log(`    [dry-run] skipped`);
  }
  await sendOrLog(`integrator.setYieldVault(${newVaultAddress})`, integrator, "setYieldVault", [
    newVaultAddress,
  ]);

  // ─── Phase 7: Re-enable offramp ──────────────────────────────────
  console.log("\n[7/7] Re-enable offramp on integrator");
  await sendOrLog(`integrator.setOfframpEnabled(true)`, integrator, "setOfframpEnabled", [true]);

  // ─── Summary ─────────────────────────────────────────────────────
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║  Migration summary                                             ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  console.log(`New vault:                ${newVaultAddress}`);
  console.log(`Integrator rewired:       ${INTEGRATOR_ADDRESS} → ${newVaultAddress}`);
  console.log(`Old vault (retired):      ${OLD_VAULT_ADDRESS}`);
  console.log("");
  console.log("Post-migration checklist:");
  console.log("  1. Sanity-check on-chain state:");
  console.log(`       newVault.totalPrincipal()  ≈ migrated amount`);
  console.log(`       newVault.offrampOperator() == ${INTEGRATOR_ADDRESS}`);
  console.log(`       integrator.yieldVault()    == ${newVaultAddress}`);
  console.log(`       integrator.offrampEnabled() == true`);
  console.log(`       newVault.p2pOnrampBps()/p2pOfframpBps() == intended rates`);
  console.log("  2. Verify new vault on Basescan / Sourcify.");
  console.log("  3. Off-chain P2P biller: bill the OLD vault's PRE-DRAIN accrued snapshot");
  console.log("     (logged in pre-flight), then point the biller at the new vault — its");
  console.log("     ledgers restart at 0 and re-accrue on the migrated deposit. Treat each");
  console.log("     vault's ledgers as cumulative-from-zero; don't double-bill carried principal.");
  console.log("  4. Optionally update the off-chain relayer's vault-address config if it");
  console.log("     pins one explicitly (it should read it from integrator.yieldVault()).");
  console.log("  5. Old vault still has no on-chain authority over integrator funds, but the");
  console.log("     signer is now its operator. Optionally restore the operator to the old");
  console.log("     integrator address or zero it out to remove ambient authority.");
  if (!EXECUTE) {
    console.log("\nDry-run complete. Re-run with EXECUTE=1 to send the transactions.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nMigration failed:");
    console.error(err);
    process.exit(1);
  });
