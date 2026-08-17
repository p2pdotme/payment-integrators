import { ethers } from "hardhat";

/**
 * Live smoke test for a deployed ShowdownCheckoutIntegrator.
 *
 * Proves, against the real Diamond:
 *   1. The EIP-712 attestation domain binds to this contract + chain — a
 *      locally-signed liveness/KYC attestation is accepted and moves the tier.
 *   2. The on-chain tier ceilings (liveness $20/$50, passport $100/$200 by
 *      India/Abroad) clamp an over-generous attested
 *      limit.
 *   3. The full onramp path — proxy CREATE2 deploy, B2B gateway proxy-auth,
 *      validateOrder, placeB2BOrder — succeeds, simulated via staticCall so no
 *      real order is placed (a live order would hold merchant capacity until it
 *      expired).
 *
 * The attestor key must be the one the integrator was deployed with.
 *
 * Note: the deployer is an EIP-7702 delegated account, and Base caps delegated
 * accounts at one in-flight transaction — so each tx is confirmed and its effect
 * polled for before the next is sent. Reading straight after `wait()` can also
 * hit a lagging RPC node and return pre-tx state, hence `pollUntil`.
 *
 * Usage:
 *   SHOWDOWN_ADDRESS=0x... npx hardhat run scripts/local/smoke-showdown.ts --network baseSepolia
 */

const SHOWDOWN_ADDRESS = process.env.SHOWDOWN_ADDRESS || "";
const f = (n: bigint) => ethers.formatUnits(n, 6);

// Track failures so a failing smoke run has a MEANINGFUL exit code. Previously
// every assertion was a bare console.log and main() ended with process.exit(0),
// so a script that "lies about passing" was worse than none (#47).
let failures = 0;
const ok = (b: boolean) => {
  if (!b) failures++;
  return b ? "✅" : "✗";
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `read` until it satisfies `done`, tolerating a lagging RPC node. */
async function pollUntil<T>(
  read: () => Promise<T>,
  done: (v: T) => boolean,
  tries = 15
): Promise<T> {
  let last = await read();
  for (let i = 0; i < tries && !done(last); i++) {
    await sleep(2000);
    last = await read();
  }
  return last;
}

/**
 * Name the custom error behind a revert. ethers only fills `e.revert` when it
 * decodes the error itself; for a staticCall the raw data can arrive nested
 * under `info.error` instead, so fall back to parsing it off the ABI.
 */
function decodeErr(iface: ethers.Interface, e: any): string {
  if (e?.revert?.name) return e.revert.name;
  const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
  if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
    try {
      const parsed = iface.parseError(data);
      if (parsed) return parsed.name;
    } catch {
      /* fall through to the raw selector */
    }
    return data.slice(0, 10);
  }
  return e?.shortMessage ?? "unknown";
}

async function main() {
  if (!SHOWDOWN_ADDRESS) throw new Error("SHOWDOWN_ADDRESS required");

  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const integrator = await ethers.getContractAt("ShowdownCheckoutIntegrator", SHOWDOWN_ADDRESS);

  const INR = ethers.encodeBytes32String("INR");
  // Any non-INR currency resolves to the Abroad column.
  const USD = ethers.encodeBytes32String("USD");

  console.log("signer:    ", me);
  console.log("integrator:", SHOWDOWN_ADDRESS);
  console.log("diamond:   ", await integrator.diamond());
  console.log("usdc:      ", await integrator.usdc());
  console.log("messenger: ", await integrator.tokenMessenger());
  console.log("solanaDom: ", await integrator.solanaDomain());
  // tierCap[tier][region] — region 0 = India (INR), 1 = Abroad.
  console.log(
    `tierCaps:   liveness $${f(await integrator.tierCap(1, 0))}/$${f(await integrator.tierCap(1, 1))} ` +
      `kyc $${f(await integrator.tierCap(2, 0))}/$${f(await integrator.tierCap(2, 1))} (India/Abroad)`
  );
  console.log(
    `ceilings:   liveness $${f(await integrator.maxTierCap(1, 0))}/$${f(await integrator.maxTierCap(1, 1))} ` +
      `kyc $${f(await integrator.maxTierCap(2, 0))}/$${f(await integrator.maxTierCap(2, 1))} ` +
      `| daily ${await integrator.MAX_DAILY_TX_COUNT_LIMIT()}/direction (immutable)`
  );
  console.log(`dailyLimit: ${await integrator.dailyTxCountLimit()} per direction per UTC day`);

  async function signAttestation(
    service: "kyc" | "liveness",
    nullifier: string,
    limit: bigint,
    expiry: bigint
  ) {
    const isKyc = service === "kyc";
    return signer.signTypedData(
      {
        name: isKyc ? "KycVerifier" : "LivenessVerifier",
        version: "1",
        chainId,
        verifyingContract: SHOWDOWN_ADDRESS,
      },
      {
        [isKyc ? "KycAttestation" : "LivenessAttestation"]: [
          { name: "wallet", type: "address" },
          { name: "nullifier", type: "bytes32" },
          { name: "limit", type: "uint256" },
          { name: "expiry", type: "uint256" },
        ],
      },
      { wallet: me, nullifier, limit, expiry }
    );
  }

  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  const expiry = now + 3600n;

  // 1. Liveness tier, attested at an absurd $1000 — the $20 ceiling must win.
  if ((await integrator.userTier(me)) < 1n) {
    const nullifier = ethers.keccak256(
      ethers.toUtf8Bytes(`smoke:liveness:${me}:${SHOWDOWN_ADDRESS}`)
    );
    const limit = ethers.parseUnits("1000", 6);
    const sig = await signAttestation("liveness", nullifier, limit, expiry);
    console.log("\nsubmitLivenessAttestation (attested $1000)…");
    await (await integrator.submitLivenessAttestation(nullifier, limit, expiry, sig)).wait(2);
    await pollUntil(
      () => integrator.userTier(me),
      (t: bigint) => t >= 1n
    );
  }
  const tierNow = await integrator.userTier(me);
  const livenessLimit = await integrator.effectiveLimit(me, INR);
  console.log(`  tier=${tierNow} granted=$${f(await integrator.grantedLimit(me, tierNow))}`);
  if (tierNow === 1n) {
    console.log(
      `  ${ok(livenessLimit === ethers.parseUnits("20", 6))} effectiveLimit (INR) clamped to $${f(livenessLimit)} (expect $20)`
    );
  } else {
    // Re-run against a signer already upgraded to KYC — the liveness ceiling
    // isn't the binding one any more, so the $50 assertion below covers it.
    console.log(`  – already tier ${tierNow}; liveness ceiling no longer binding`);
  }

  // 2. Upgrade to passport+liveness — ceiling rises to $50, not to the attested $1000.
  if ((await integrator.userTier(me)) < 2n) {
    const nullifier = ethers.keccak256(ethers.toUtf8Bytes(`smoke:kyc:${me}:${SHOWDOWN_ADDRESS}`));
    const limit = ethers.parseUnits("1000", 6);
    const sig = await signAttestation("kyc", nullifier, limit, expiry);
    console.log("\nsubmitKycAttestation (attested $1000)…");
    await (await integrator.submitKycAttestation(nullifier, limit, expiry, sig)).wait(2);
    await pollUntil(
      () => integrator.userTier(me),
      (t: bigint) => t >= 2n
    );
  }
  const kycLimit = await integrator.effectiveLimit(me, INR);
  const kycLimitAbroad = await integrator.effectiveLimit(me, USD);
  console.log(`  tier=${await integrator.userTier(me)}`);
  console.log(
    `  ${ok(kycLimit === ethers.parseUnits("100", 6))} effectiveLimit (INR) clamped to $${f(kycLimit)} (expect $100)`
  );
  console.log(
    `  ${ok(kycLimitAbroad === ethers.parseUnits("200", 6))} effectiveLimit (USD) clamped to $${f(kycLimitAbroad)} (expect $200)`
  );

  // 3. Views the widget depends on.
  const proxy = await integrator.proxyAddress(me);
  console.log(
    "\nproxy:              ",
    proxy,
    `(deployed=${(await ethers.provider.getCode(proxy)) !== "0x"})`
  );
  console.log("offrampMintRecipient:", await integrator.offrampMintRecipient(me));
  console.log("bridgedBalance:      ", f(await integrator.bridgedBalance(me)), "USDC");

  // 4. Simulate the full onramp path without placing a live order.
  const ata = "0x" + "a7".repeat(32);
  console.log("\nsimulating userBuyUsdcToSolana($1 -> Solana)…");
  try {
    const orderId = await integrator.userBuyUsdcToSolana.staticCall(
      ethers.parseUnits("1", 6),
      INR,
      ata,
      1,
      "",
      0,
      0
    );
    console.log(
      `  ✅ path clears (proxy auth + validateOrder + placeB2BOrder) -> orderId ${orderId}`
    );
  } catch (e: any) {
    // Must count as a failure, not just print one. This is the core onramp path:
    // if it reverts, the integrator does not work at all. Printing "✗" without
    // touching `failures` let the run exit 0 with the product broken — the exact
    // lying-green behaviour #47 was filed about, surviving in the one step where
    // it mattered most.
    ok(false);
    console.log(`  ✗ reverted: ${decodeErr(integrator.interface, e)}`);
  }

  // 5. Over-cap order must be refused by the contract's own ceiling — and for
  //    that reason specifically, not some unrelated revert. By this point the
  //    signer is tier-2 ($100 INR cap), so the probe must EXCEED $100, not the
  //    stale $51 that is under cap and always "failed" this check (#47).
  try {
    await integrator.userBuyUsdcToSolana.staticCall(
      ethers.parseUnits("101", 6),
      INR,
      ata,
      1,
      "",
      0,
      0
    );
    console.log(`  ${ok(false)} $101 INR order was NOT refused — the tier ceiling is not holding`);
  } catch (e: any) {
    const name = decodeErr(integrator.interface, e);
    console.log(`  ${ok(name === "KycLimitExceeded")} $101 INR order refused with ${name}`);
  }

  // 6. A zero Solana recipient must be refused — a burn to bytes32(0) would be
  //    unmintable on Solana.
  try {
    await integrator.userBuyUsdcToSolana.staticCall(
      ethers.parseUnits("1", 6),
      INR,
      ethers.ZeroHash,
      1,
      "",
      0,
      0
    );
    console.log(`  ${ok(false)} zero Solana recipient was NOT refused`);
  } catch (e: any) {
    const name = decodeErr(integrator.interface, e);
    console.log(
      `  ${ok(name === "InvalidSolanaRecipient")} zero Solana recipient refused with ${name}`
    );
  }

  // Meaningful exit code: fail the run if any assertion failed (#47).
  if (failures > 0) {
    throw new Error(`smoke: ${failures} assertion(s) failed — see the ✗ marks above`);
  }
  console.log(`\n✅ smoke passed — ${failures} failures`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
