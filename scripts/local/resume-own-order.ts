import { ethers } from "hardhat";

/**
 * Drive an already-placed Own onramp order through the merchant leg and assert
 * the settlement invariant. Split out from the E2E so a run interrupted after
 * placement can be resumed without burning another daily slot.
 *
 *   ORDER_ID=586 npx hardhat run scripts/local/_finish-585.ts --network baseSepolia
 */
const S = ["PLACED", "ACCEPTED", "PAID", "COMPLETED", "CANCELLED"];
const D = "0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9";
const I = "0x6e2Feec8434de08732D7ed5A0cDDd748dEFbB032";
const T = "0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d";
const ID = BigInt(process.env.ORDER_ID || "586");
const AMT = BigInt(process.env.AMOUNT || "2000000");
const f = (n: bigint) => ethers.formatUnits(n, 6);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const s = await ethers.getSigners();
  const user = s[1] ?? s[0];
  const d = new ethers.Contract(
    D,
    [
      "function getOrdersById(uint256) view returns (tuple(uint256 amount, uint256 fiatAmount, uint256 placedTimestamp, uint256 completedTimestamp, uint256 userCompletedTimestamp, address acceptedMerchant, address user, address recipientAddr, string pubkey, string encUpi, bool userCompleted, uint8 status, uint8 orderType, tuple(uint8 raisedBy, uint8 status, uint256 redactTransId, uint256 accountNumber) disputeInfo, uint256 id, string userPubKey, string encMerchantUpi, uint256 acceptedAccountNo))",
      "function paidBuyOrder(uint256)",
    ],
    user
  );
  const ig = new ethers.Contract(
    I,
    [
      "function proxyAddress(address) view returns (address)",
      "function getSession(uint256) view returns (tuple(address user, bool settled, bool cancelled, uint32 placementDay, uint256 amount, bytes32 currency))",
    ],
    user
  );
  const tk = new ethers.Contract(
    T,
    ["function balanceOf(address) view returns (uint256)"],
    ethers.provider
  );

  const proxy: string = await ig.proxyAddress(user.address);
  const before: bigint = await tk.balanceOf(user.address);
  console.log("order:", ID.toString(), "user:", user.address, "bal:", f(before));

  // The order record lags the receipt on this RPC — poll until it materialises.
  let o: any = null;
  for (let i = 0; i < 30; i++) {
    o = await d.getOrdersById(ID);
    if (o.user !== ethers.ZeroAddress) break;
    await sleep(2000);
  }
  if (!o || o.user === ethers.ZeroAddress) throw new Error("order never materialised");
  console.log("user:", o.user, "recipient:", o.recipientAddr);
  if (o.recipientAddr.toLowerCase() !== user.address.toLowerCase()) {
    throw new Error(`recipientAddr ${o.recipientAddr} is not the buyer`);
  }
  console.log("✅ recipientAddr is the buyer's own wallet");

  // Wait for a merchant, then mark paid IMMEDIATELY — the TTL is short and an
  // expired ACCEPTED order reverts paidBuyOrder with OrderExpired().
  let last = -1;
  let paid = false;
  for (let i = 0; i < 150; i++) {
    const st = Number((await d.getOrdersById(ID)).status);
    if (st !== last) {
      console.log("  [poll]", S[st]);
      last = st;
    }
    if (st === 4) throw new Error("order CANCELLED / expired");
    if (st === 3) break;
    if (st === 1 && !paid) {
      console.log("  marking paid…");
      try {
        await (await d.paidBuyOrder(ID)).wait(1);
        paid = true;
        console.log("  ✅ paidBuyOrder sent");
      } catch (e) {
        console.log("  paidBuyOrder failed:", (e as Error).message.slice(0, 120));
        throw e;
      }
    }
    await sleep(2000);
  }

  let after: bigint = await tk.balanceOf(user.address);
  for (let i = 0; i < 25 && after === before; i++) {
    await sleep(3000);
    after = await tk.balanceOf(user.address);
  }
  const ib: bigint = await tk.balanceOf(I);
  const pb: bigint = await tk.balanceOf(proxy);
  const sess = await ig.getSession(ID);

  console.log("\n── settlement ──");
  console.log(`user      : ${f(before)} → ${f(after)}  (+${f(after - before)})`);
  console.log(`integrator: ${f(ib)}`);
  console.log(`proxy     : ${f(pb)}`);
  console.log(`session.settled: ${sess.settled}`);

  const ok = after - before === AMT && ib === 0n && pb === 0n && sess.settled;
  console.log(
    ok ? "\n✅ E2E PASSED — funds landed directly in the buyer's wallet" : "\n❌ see above"
  );
  if (!ok) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
