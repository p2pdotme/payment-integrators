import { ethers } from "hardhat";

/**
 * E2E for the MERGED (voucher-attested, single-tx) offramp on Base Sepolia.
 *
 *  - acct0 (deployer) = vault owner = offrampRelayer → only SIGNS the voucher
 *  - acct1 = the USER → sends the ONE on-chain tx: userRedeemAndStartOfframp
 *    (vault release + SELL placement atomic), then deliver + sync.
 *
 * Requires the demo-merchant-bot running (auto-accepts + completes INR SELLs
 * in circle 1).
 *
 *   INTEGRATOR_ADDRESS=0x... VAULT_ADDRESS=0x... \
 *   npx hardhat run scripts/local/e2e-offramp-v3-sepolia.ts --network baseSepolia
 */

const DIAMOND = process.env.DIAMOND_ADDRESS || "0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9";
const USDC = process.env.USDC_ADDRESS || "0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d";
const INTEGRATOR = process.env.INTEGRATOR_ADDRESS!;
const VAULT = process.env.VAULT_ADDRESS!;
const VOUCHER_USDC = BigInt(process.env.VOUCHER_USDC || "10000000"); // 10 USDC

const STATUS = ["PLACED", "ACCEPTED", "PAID", "COMPLETED", "CANCELLED"];

const DIAMOND_ABI = [
  "function getOrdersById(uint256) view returns (tuple(uint256 amount, uint256 fiatAmount, uint256 placedTimestamp, uint256 completedTimestamp, uint256 userCompletedTimestamp, address acceptedMerchant, address user, address recipientAddr, string pubkey, string encUpi, bool userCompleted, uint8 status, uint8 orderType, tuple(uint8 raisedBy, uint8 status, uint256 redactTransId, uint256 accountNumber) disputeInfo, uint256 id, string userPubKey, string encMerchantUpi, uint256 acceptedAccountNo))",
  "function getSmallOrderThreshold(bytes32) view returns (uint256)",
  "function getSmallOrderFixedFeeSell(bytes32) view returns (uint256)",
];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

const fmt = (n: bigint) => `${ethers.formatUnits(n, 6)} USDC`;
const heading = (s: string) => console.log(`\n${"─".repeat(66)}\n  ${s}\n${"─".repeat(66)}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pollStatus(diamond: any, id: bigint, target: number, label: string) {
  let last = -1;
  for (let i = 0; i < 60; i++) {
    const s = Number((await diamond.getOrdersById(id)).status);
    if (s !== last) {
      console.log(`  [poll] order ${id} → ${STATUS[s]}`);
      last = s;
    }
    if (s === target) return;
    if (s === 4 && target !== 4) throw new Error(`order ${id} CANCELLED waiting for ${label}`);
    await sleep(5000);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function main() {
  if (!INTEGRATOR || !VAULT) throw new Error("INTEGRATOR_ADDRESS and VAULT_ADDRESS required");

  const signers = await ethers.getSigners();
  const attester = signers[0]; // offrampRelayer key — signs only
  const user = signers[1]; // the end user — sends the single tx
  if (!user) throw new Error("Need a mnemonic so acct1 exists as the user");

  const integrator = (
    await ethers.getContractAt("TradeStarsCheckoutIntegratorV2", INTEGRATOR)
  ).connect(user) as any;
  const vault = await ethers.getContractAt("RestrictedYieldVault", VAULT);
  const diamond = new ethers.Contract(DIAMOND, DIAMOND_ABI, user);
  const usdc = new ethers.Contract(USDC, ERC20_ABI, user);

  heading("Pre-flight");
  const net = await ethers.provider.getNetwork();
  console.log(`chainId:          ${net.chainId}`);
  console.log(`attester (signs): ${attester.address}`);
  console.log(`user (sends tx):  ${user.address}`);
  console.log(`offrampRelayer:   ${await integrator.offrampRelayer()}`);
  console.log(`offrampEnabled:   ${await integrator.offrampEnabled()}`);
  console.log(`vault quota:      ${fmt(await vault.offrampQuota())}`);
  const proxy = await integrator.proxyAddress(user.address);
  console.log(`user proxy:       ${proxy}`);
  console.log(`proxy balance:    ${fmt(await usdc.balanceOf(proxy))}`);

  // Gas for the user (prod is paymaster-sponsored; E2E needs real ETH).
  const userEth = await ethers.provider.getBalance(user.address);
  if (userEth < ethers.parseEther("0.002")) {
    console.log("Funding user with 0.005 ETH for gas…");
    await (
      await attester.sendTransaction({ to: user.address, value: ethers.parseEther("0.005") })
    ).wait();
  }

  // ─── The attester signs the voucher OFF-CHAIN (no relayer tx, ever) ──

  heading("Step 1 — attester signs OfframpVoucher (off-chain)");
  const INR = ethers.encodeBytes32String("INR");
  const burnTx = ethers.id(`solana-burn-${Date.now()}`);
  const solPubkey = "0x" + "22".repeat(32);
  const latest = await ethers.provider.getBlock("latest");
  const voucher = {
    solanaBurnTx: burnTx,
    solanaUserPubkey: solPubkey,
    user: user.address,
    amount: VOUCHER_USDC,
    deadline: BigInt(latest!.timestamp + 3600),
  };
  const domain = {
    name: "TradeStarsOfframp",
    version: "1",
    chainId: net.chainId,
    verifyingContract: INTEGRATOR,
  };
  const types = {
    OfframpVoucher: [
      { name: "solanaBurnTx", type: "bytes32" },
      { name: "solanaUserPubkey", type: "bytes32" },
      { name: "user", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
  const sig = await attester.signTypedData(domain, types, voucher);
  console.log(`burn tx:   ${burnTx}`);
  console.log(`voucher:   ${fmt(voucher.amount)} for ${voucher.user}`);
  const onchainDigest = await integrator.hashOfframpVoucher(voucher);
  const localDigest = ethers.TypedDataEncoder.hash(domain, types, voucher);
  if (onchainDigest !== localDigest) throw new Error("digest mismatch — domain wrong?");
  console.log(`digest ok: ${onchainDigest}`);

  // ─── ONE Base tx: redeem voucher + place the SELL ────────────────────

  heading("Step 2 — userRedeemAndStartOfframp (the single tx)");
  // Fee-aware max draw: principal + fee must fit the voucher amount
  // (same arithmetic the widget does).
  const threshold = await diamond.getSmallOrderThreshold(INR);
  const fee = VOUCHER_USDC <= threshold ? await diamond.getSmallOrderFixedFeeSell(INR) : 0n;
  const principal = VOUCHER_USDC - fee;
  console.log(`threshold ${fmt(threshold)} | fee ${fmt(fee)} | principal ${fmt(principal)}`);

  const userPubKey = ethers.Wallet.createRandom().signingKey.publicKey.slice(4);
  const offrampWithdrawnBefore = await vault.offrampWithdrawn();

  const tx = await integrator.userRedeemAndStartOfframp(
    voucher,
    sig,
    principal,
    INR,
    0n, // fiatAmount floor: none
    1n, // circleId
    0n, // no preferred channel
    userPubKey
  );
  const rcpt = await tx.wait();
  console.log(`tx: ${rcpt!.hash} (gas ${rcpt!.gasUsed})`);

  const evs = rcpt!.logs
    .map((l: any) => {
      try {
        return integrator.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const alloc = evs.find((p: any) => p.name === "OfframpAllocated");
  const placed = evs.find((p: any) => p.name === "OfframpOrderPlaced");
  if (!alloc || !placed) throw new Error("expected OfframpAllocated + OfframpOrderPlaced");
  const orderId = placed.args.orderId as bigint;
  console.log(`allocationId ${alloc.args.allocationId} + orderId ${orderId} — SAME tx ✓`);
  console.log(
    `vault.offrampWithdrawn Δ: +${fmt((await vault.offrampWithdrawn()) - offrampWithdrawnBefore)}`
  );
  console.log(`proxy balance: ${fmt(await usdc.balanceOf(proxy))}`);

  const order = await diamond.getOrdersById(orderId);
  console.log(
    `order.user = ${order.user} ${order.user === proxy ? "(user's proxy ✓ history attribution)" : "(UNEXPECTED)"}`
  );

  // ─── merchant bot accepts → deliver → PAID → COMPLETED ───────────────

  heading("Step 3 — wait for merchant accept (demo-merchant-bot)");
  await pollStatus(diamond, orderId, 1, "ACCEPTED");

  heading("Step 4 — userDeliverOfframpUpi");
  const dtx = await integrator.userDeliverOfframpUpi(orderId, `0xmock_enc_upi_${Date.now()}`);
  await dtx.wait();
  console.log(`deliver tx: ${dtx.hash}`);
  await pollStatus(diamond, orderId, 2, "PAID");
  console.log(`proxy balance after Diamond pull: ${fmt(await usdc.balanceOf(proxy))}`);

  heading("Step 5 — wait for merchant complete");
  await pollStatus(diamond, orderId, 3, "COMPLETED");

  heading("Step 6 — syncOfframp");
  await (await integrator.syncOfframp(orderId)).wait();
  console.log(
    `userActiveOrder cleared: ${(await integrator.userActiveOrder(user.address)) === 0n}`
  );
  console.log(`availableOfframp: ${fmt(await integrator.availableOfframp(user.address))}`);

  heading("Done — merged offramp E2E passed");
  console.log(`✓ attester signed off-chain only (no relayer tx)`);
  console.log(`✓ ONE user tx redeemed ${fmt(VOUCHER_USDC)} + placed SELL ${fmt(principal)}`);
  console.log(`✓ order.user = user's own proxy (history)`);
  console.log(`✓ PAID → COMPLETED → synced`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
