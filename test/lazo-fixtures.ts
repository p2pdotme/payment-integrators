import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { impersonateAccount, setBalance } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Shared helpers for the Lazo suite. No tests here.
 */

export const USDC = (n: number | string) => ethers.parseUnits(n.toString(), 6);
export const ARS = ethers.encodeBytes32String("ARS");
export const CIRCLE_ID = 1;
export const PUBKEY = "0xdeadbeef";
export const DAY = 24 * 3600;

export const FEE_BPS = 500n; // 5%
// Most tests isolate the percentage with a zero fixed fee and zero floors; the
// "fixed fee" suite uses the production values.
export const FEE_FIXED = 0n;
export const RETENTION = 3600; // 1 hour — most tests need a lock to exercise StillLocked
export const PER_TX_LIMIT = USDC(10_000);
export const DAILY_LIMIT = 50;
export const VENDOR_DAILY_VOLUME = USDC(100_000);

export const CEILINGS = {
  minFeeBps: 0n,
  maxFeeBps: 1000n,
  minFeeFixed: 0n,
  maxFeeFixed: USDC(2),
  maxPerTxLimit: USDC(50_000),
  maxDailyTxCountLimit: 1000n,
  maxVendorDailyVolumeLimit: USDC(10_000_000),
};

export const feeOf = (amount: bigint, bps: bigint = FEE_BPS) => (amount * bps) / 10_000n;

export interface Actors {
  deployer: SignerWithAddress;
  owner: SignerWithAddress; // "the Safe"
  operator: SignerWithAddress;
  feeWallet: SignerWithAddress;
  v1: SignerWithAddress;
  v2: SignerWithAddress;
  buyer1: SignerWithAddress;
  buyer2: SignerWithAddress;
  stranger: SignerWithAddress;
  newcomer: SignerWithAddress; // candidate owner / fee wallet
  keeper: SignerWithAddress;
}

export async function actors(): Promise<Actors> {
  const s = await ethers.getSigners();
  return {
    deployer: s[0],
    owner: s[1],
    operator: s[2],
    feeWallet: s[3],
    v1: s[4],
    v2: s[5],
    buyer1: s[6],
    buyer2: s[7],
    stranger: s[8],
    newcomer: s[9],
    keeper: s[10],
  };
}

export interface ConfigOverrides {
  operator?: string;
  feeWallet?: string;
  feeBps?: bigint | number;
  feeFixed?: bigint | number;
  defaultRetention?: number;
  perTxLimit?: bigint;
  dailyTxCountLimit?: bigint | number;
  vendorDailyVolumeLimit?: bigint;
}

export async function deployIntegrator(
  diamondAddr: string,
  usdcAddr: string,
  ownerAddr: string,
  cfg: ConfigOverrides = {},
  ceilings: Partial<typeof CEILINGS> = {}
) {
  const a = await actors();
  const F = await ethers.getContractFactory("LazoCheckoutIntegrator", a.deployer);
  return F.deploy(
    diamondAddr,
    usdcAddr,
    ownerAddr,
    {
      operator: cfg.operator ?? a.operator.address,
      feeWallet: cfg.feeWallet ?? a.feeWallet.address,
      feeBps: cfg.feeBps ?? FEE_BPS,
      feeFixed: cfg.feeFixed ?? FEE_FIXED,
      defaultRetention: cfg.defaultRetention ?? RETENTION,
      perTxLimit: cfg.perTxLimit ?? PER_TX_LIMIT,
      dailyTxCountLimit: cfg.dailyTxCountLimit ?? DAILY_LIMIT,
      vendorDailyVolumeLimit: cfg.vendorDailyVolumeLimit ?? VENDOR_DAILY_VOLUME,
    },
    { ...CEILINGS, ...ceilings }
  );
}

/**
 * Full stack (USDC + Diamond + integrator). The integrator honours
 * `isBlacklisted` when the token has it, so the default token is the
 * blacklistable one (Circle's real USDC exposes it); `MockUSDC` stands in
 * for a token without a blacklist.
 */
export async function deployStack(
  opts: { token?: string; cfg?: ConfigOverrides; ceilings?: Partial<typeof CEILINGS> } = {}
) {
  const a = await actors();
  const u: any = await (
    await ethers.getContractFactory(opts.token ?? "MockUSDCBlacklistable")
  ).deploy();
  const d: any = await (
    await ethers.getContractFactory("MockDiamond")
  ).deploy(await u.getAddress());
  const i: any = await deployIntegrator(
    await d.getAddress(),
    await u.getAddress(),
    a.owner.address,
    opts.cfg,
    opts.ceilings
  );
  await d.registerIntegrator(await i.getAddress(), await i.proxyImpl());
  // usdcThroughIntegrator stays false: the Diamond pays recipientAddr, which
  // is the vendor's escrow.
  await u.mint(await d.getAddress(), USDC(100_000_000));
  return { u, d, i };
}

export async function escrowOf(integratorC: any, vendor: string): Promise<any> {
  return ethers.getContractAt("VendorEscrow", await integratorC.escrowAddress(vendor));
}

export async function placeOrder(
  integratorC: any,
  buyer: SignerWithAddress,
  vendor: string,
  amount: bigint,
  pcid: bigint | number = 0,
  fiatLimit: bigint | number = 0
): Promise<bigint> {
  const c = integratorC.connect(buyer);
  const orderId: bigint = await c.userPlaceOrder.staticCall(
    vendor,
    amount,
    ARS,
    CIRCLE_ID,
    PUBKEY,
    pcid,
    fiatLimit
  );
  await c.userPlaceOrder(vendor, amount, ARS, CIRCLE_ID, PUBKEY, pcid, fiatLimit);
  return orderId;
}

export async function placeAndComplete(
  diamondC: any,
  integratorC: any,
  buyer: SignerWithAddress,
  vendor: string,
  amount: bigint
): Promise<bigint> {
  const orderId = await placeOrder(integratorC, buyer, vendor, amount);
  await diamondC.simulateOrderComplete(orderId);
  return orderId;
}

/** Per-escrow invariant + the integrator never holds USDC. */
export async function invariant(integratorC: any, usdcC: any, vendors: string[]) {
  expect(await usdcC.balanceOf(await integratorC.getAddress())).to.equal(0n);
  for (const v of vendors) {
    const esc = await escrowOf(integratorC, v);
    if ((await ethers.provider.getCode(await esc.getAddress())) === "0x") continue;
    const bal = await usdcC.balanceOf(await esc.getAddress());
    const pending = await esc.pendingGross();
    expect(
      bal >= pending,
      `invariant broken on ${v}'s escrow: bal=${bal} pending=${pending}`
    ).to.equal(true);
  }
}

export async function asDiamond(diamondC: any): Promise<SignerWithAddress> {
  const addr = await diamondC.getAddress();
  await impersonateAccount(addr);
  await setBalance(addr, ethers.parseEther("1"));
  return ethers.getSigner(addr) as any;
}

/** The token's Transfer events in a receipt. */
export function transfersIn(receipt: any, token: any): any[] {
  return receipt!.logs
    .map((l: any) => {
      try {
        return token.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .filter((p: any) => p?.name === "Transfer");
}

/** A Diamond revert arrives wrapped in UserProxy.CallFailed(bytes). */
export async function expectCallFailedWith(tx: Promise<any>, expectedReason: string) {
  let err: any;
  try {
    await tx; // first: attaching the handler late triggers PromiseRejectionHandledWarning
  } catch (e) {
    err = e;
  }
  const iface = (await ethers.getContractFactory("UserProxy")).interface;
  expect(err, "expected a revert").to.not.equal(undefined);
  const data = err.data ?? err.error?.data ?? err.info?.error?.data;
  const parsed = iface.parseError(data);
  expect(parsed?.name).to.equal("CallFailed");
  const inner = parsed!.args[0] as string;
  const [reason] = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + inner.slice(10));
  expect(reason).to.equal(expectedReason);
}

/** Sorted names of a contract's non-view, non-pure functions. */
export async function mutableFunctions(name: string): Promise<string[]> {
  const F = await ethers.getContractFactory(name);
  return F.interface.fragments
    .filter(
      (f: any) =>
        f.type === "function" && f.stateMutability !== "view" && f.stateMutability !== "pure"
    )
    .map((f: any) => f.name)
    .sort();
}
