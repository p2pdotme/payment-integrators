/**
 * Make the NEW integrator follow V2's live settings (mainnet checklist, Part B).
 *
 * It reads V2's settings, compares them with the new contract, and lists the calls
 * that make them equal, in a safe order (widen the limit range BEFORE raising caps).
 * Then, only with APPLY=1, it sends them and reads everything back: every setting
 * must equal V2's, or it exits non-zero.
 *
 *   NEW_INTEGRATOR=0x… npx hardhat run scripts/configure-from-v2.ts --network base             # dry run: prints the plan only
 *   NEW_INTEGRATOR=0x… APPLY=1 npx hardhat run scripts/configure-from-v2.ts --network base     # sends (signer = the new contract's super admin)
 *   NEW_INTEGRATOR=0x… SAFE_JSON=plan.json npx hardhat run …                                    # writes the calls as a Safe batch instead
 *
 * Optional: V2_INTEGRATOR (default V2 on Base), MERCHANT_CEILING (V2 has no per-merchant
 * ceiling; default: leave the new contract's own value).
 *
 * Settings copied: limit range, global hold, per-currency hold (17 currencies), per-sale
 * cap (17 currencies), daily limit, link orders on/off. NOT copied: admin roles (set them
 * by hand, Part B #9) and previous integrators (set at deploy).
 *
 * Runs on Base mainnet (8453) or on a local copy of it. Nothing else.
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";

export const CURRENCIES = ["ARS", "BOB", "BRL", "COP", "CUP", "ECU", "EGP", "EUR", "IDR", "INR", "KES", "MEX", "NGN", "PEN", "PHP", "USD", "VEN"];
const V2_DEFAULT = "0xA012B6D5D6d74224C3B046780965D5EC7AAB20a5";
const b32 = (c: string) => ethers.encodeBytes32String(c);
const V2_ABI = [
  "function settlementPeriod() view returns (uint256)",
  "function dailyLimit() view returns (uint256)",
  "function limitBounds() view returns (uint256 minDaily, uint256 maxDaily, uint256 minCap, uint256 maxCap)",
  "function linkOrdersEnabled() view returns (bool)",
  "function perTxCap(bytes32) view returns (uint256)",
  "function lockPeriod(bytes32) view returns (uint256)",
];

type Settings = {
  bounds: bigint[];
  settlementPeriod: bigint;
  dailyLimit: bigint;
  linkOrdersEnabled: boolean;
  caps: Record<string, bigint>;
  locks: Record<string, bigint>;
};

async function read(c: any): Promise<Settings> {
  const lb = await c.limitBounds();
  const caps: Record<string, bigint> = {};
  const locks: Record<string, bigint> = {};
  for (const cur of CURRENCIES) {
    caps[cur] = await c.perTxCap(b32(cur));
    locks[cur] = await c.lockPeriod(b32(cur));
  }
  return {
    bounds: [lb[0], lb[1], lb[2], lb[3]].map((x: any) => BigInt(x)),
    settlementPeriod: BigInt(await c.settlementPeriod()),
    dailyLimit: BigInt(await c.dailyLimit()),
    linkOrdersEnabled: Boolean(await c.linkOrdersEnabled()),
    caps,
    locks,
  };
}

const usdc = (v: bigint) => `${Number(v) / 1e6} USDC`;
const hours = (v: bigint) => (Number(v) % 86400 === 0 && Number(v) >= 86400 ? `${Number(v) / 86400} days` : Number(v) >= 3600 ? `${Number(v) / 3600} h` : `${Number(v) / 60} min`);

/** The calls, in order, that turn `cur` into `v2` (only what differs). */
function plan(I: any, cur: Settings, v2: Settings, ceiling?: bigint, curCeiling?: bigint) {
  const calls: { label: string; fn: string; args: any[] }[] = [];
  // 1. The range first: caps above the current max would be refused otherwise.
  if (cur.bounds.some((x, i) => x !== v2.bounds[i])) {
    calls.push({ label: `limit range → ${v2.bounds[0]}–${v2.bounds[1]} orders/day, ${usdc(v2.bounds[2])}–${usdc(v2.bounds[3])} a sale`, fn: "setLimitBounds", args: v2.bounds });
  }
  // 2. Global hold, then per-currency holds relative to it (0 = follow the global).
  if (cur.settlementPeriod !== v2.settlementPeriod) {
    calls.push({ label: `global hold → ${hours(v2.settlementPeriod)}`, fn: "setSettlementPeriod", args: [v2.settlementPeriod] });
  }
  for (const c of CURRENCIES) {
    const overriddenNow = cur.locks[c] !== cur.settlementPeriod; // the new contract has its own value for c
    const after = overriddenNow ? cur.locks[c] : v2.settlementPeriod;
    if (after !== v2.locks[c]) {
      const override = v2.locks[c] === v2.settlementPeriod ? 0n : v2.locks[c];
      calls.push({ label: `${c} hold → ${hours(v2.locks[c])}${override === 0n ? " (follow the global)" : ""}`, fn: "setLockPeriod", args: [b32(c), override] });
    }
  }
  // 3. Caps (inside the range set in step 1).
  for (const c of CURRENCIES) {
    if (cur.caps[c] !== v2.caps[c]) calls.push({ label: `${c} per-sale cap → ${usdc(v2.caps[c])}`, fn: "setPerTxCap", args: [b32(c), v2.caps[c]] });
  }
  // 4. Daily limit and the link-payments switch.
  if (cur.dailyLimit !== v2.dailyLimit) calls.push({ label: `daily limit → ${v2.dailyLimit}`, fn: "setDailyLimit", args: [v2.dailyLimit] });
  if (cur.linkOrdersEnabled !== v2.linkOrdersEnabled) calls.push({ label: `link payments → ${v2.linkOrdersEnabled ? "on" : "off"}`, fn: "setLinkOrdersEnabled", args: [v2.linkOrdersEnabled] });
  // 5. Optional: the per-merchant ceiling (V2 has none).
  if (ceiling !== undefined && curCeiling !== ceiling) calls.push({ label: `per-merchant ceiling → ${ceiling}`, fn: "setMerchantDailyCeiling", args: [ceiling] });
  return calls.map((x) => ({ ...x, data: I.interface.encodeFunctionData(x.fn, x.args) }));
}

/** Rows of "setting | V2 | new | same?" and whether every row matches. */
function compare(v2: Settings, now: Settings) {
  const rows: [string, string, string, boolean][] = [];
  const add = (k: string, a: string, b: string) => rows.push([k, a, b, a === b]);
  add("limit range (orders/day)", `${v2.bounds[0]}–${v2.bounds[1]}`, `${now.bounds[0]}–${now.bounds[1]}`);
  add("limit range (a sale)", `${usdc(v2.bounds[2])}–${usdc(v2.bounds[3])}`, `${usdc(now.bounds[2])}–${usdc(now.bounds[3])}`);
  add("global hold", hours(v2.settlementPeriod), hours(now.settlementPeriod));
  add("daily limit", `${v2.dailyLimit}`, `${now.dailyLimit}`);
  add("link payments", `${v2.linkOrdersEnabled}`, `${now.linkOrdersEnabled}`);
  for (const c of CURRENCIES) add(`${c} hold`, hours(v2.locks[c]), hours(now.locks[c]));
  for (const c of CURRENCIES) add(`${c} per-sale cap`, usdc(v2.caps[c]), usdc(now.caps[c]));
  return { rows, ok: rows.every((r) => r[3]) };
}

export async function configureFromV2(opts: { newIntegrator: string; v2Integrator?: string; apply: boolean; safeJson?: string; ceiling?: bigint; signer?: any }) {
  const v2Addr = opts.v2Integrator ?? V2_DEFAULT;
  if (opts.newIntegrator.toLowerCase() === v2Addr.toLowerCase()) throw new Error("NEW_INTEGRATOR is V2 itself");
  const V2 = new ethers.Contract(v2Addr, V2_ABI, ethers.provider);
  const I: any = await ethers.getContractAt("MerchantTerminalIntegrator", opts.newIntegrator, opts.signer);

  console.log(`\nV2 (source): ${v2Addr}\nNew (target): ${opts.newIntegrator}`);
  const v2 = await read(V2);
  const cur = await read(I);
  const curCeiling = BigInt(await I.merchantDailyCeiling());
  const calls = plan(I, cur, v2, opts.ceiling, curCeiling);

  console.log(`\nPlan: ${calls.length} call(s) on the new contract, in this order:`);
  calls.forEach((c, i) => console.log(`  ${String(i + 1).padStart(2)}. ${c.fn}(${c.args.map((a) => (typeof a === "string" && a.startsWith("0x") && a.length === 66 ? `"${ethers.decodeBytes32String(a)}"` : String(a))).join(", ")})   # ${c.label}`));
  console.log(`  per-merchant ceiling: ${curCeiling}${opts.ceiling !== undefined ? ` → ${opts.ceiling}` : " (kept; V2 has none)"}`);

  if (opts.safeJson) {
    const batch = { version: "1.0", chainId: String((await ethers.provider.getNetwork()).chainId), meta: { name: "PayQR: new integrator follows V2" }, transactions: calls.map((c) => ({ to: opts.newIntegrator, value: "0", data: c.data })) };
    fs.writeFileSync(opts.safeJson, JSON.stringify(batch, null, 2));
    console.log(`\nSafe batch written to ${opts.safeJson} (${calls.length} transactions). Nothing was sent.`);
  }
  if (!opts.apply) {
    const pre = compare(v2, cur);
    console.log(`\nDry run: nothing sent. ${pre.rows.filter((r) => !r[3]).length} setting(s) differ from V2 today. Run with APPLY=1 to send.`);
    return { ok: pre.ok, rows: pre.rows };
  }

  const signer = opts.signer ?? (await ethers.getSigners())[0];
  const su = String(await I.superAdmin()).toLowerCase();
  if (su !== String(await signer.getAddress()).toLowerCase()) throw new Error(`the signer is not the new contract's super admin (${su}); use SAFE_JSON instead`);
  let gas = 0n;
  for (const c of calls) {
    const tx = await signer.sendTransaction({ to: opts.newIntegrator, data: c.data });
    const r = await tx.wait();
    gas += BigInt(r.gasUsed);
    console.log(`  sent ${c.fn}: ${r.hash} (${r.status === 1 ? "ok" : "FAILED"}, gas ${r.gasUsed})`);
    if (r.status !== 1) throw new Error(`${c.fn} failed`);
  }
  console.log(`  total gas for the ${calls.length} calls: ${gas}`);
  const after = await read(I);
  const res = compare(v2, after);
  console.log(`\nRead-back, new contract vs V2:`);
  for (const [k, a, b, same] of res.rows) console.log(`  ${same ? "✔" : "✘"} ${k.padEnd(26)} V2 ${a.padEnd(12)} new ${b}`);
  console.log(res.ok ? `\nAll ${res.rows.length} settings match V2.` : `\nMISMATCH: ${res.rows.filter((r) => !r[3]).length} setting(s) differ.`);
  return res;
}

async function main() {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const meta: any = await network.provider.send("hardhat_metadata", []).catch(() => null);
  const copyOfMainnet = Number(meta?.forkedNetwork?.chainId) === 8453;
  if (chainId !== 8453n && !copyOfMainnet) throw new Error(`Base mainnet or a local copy of it only (chain ${chainId})`);
  const newIntegrator = process.env.NEW_INTEGRATOR;
  if (!newIntegrator) throw new Error("NEW_INTEGRATOR not set");
  const res = await configureFromV2({
    newIntegrator,
    v2Integrator: process.env.V2_INTEGRATOR,
    apply: process.env.APPLY === "1",
    safeJson: process.env.SAFE_JSON,
    ceiling: process.env.MERCHANT_CEILING ? BigInt(process.env.MERCHANT_CEILING) : undefined,
  });
  if (process.env.APPLY === "1" && !res.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e?.shortMessage ?? e?.message ?? e);
    process.exit(1);
  });
}
