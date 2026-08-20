import { ethers } from "hardhat";

/**
 * Measure the Base Sepolia Diamond's BUY-order TTL precisely.
 *
 * Places one order, then probes `paidBuyOrder` with eth_call (free, no state
 * change) every few seconds until it starts reverting OrderExpired(). The last
 * successful probe bounds the window a real buyer has to pay their fiat and
 * confirm.
 *
 * This is the number that decides whether a real fiat leg is possible at all:
 * a human opening a UPI app and paying cannot beat a sub-minute window.
 */
const DIAMOND = "0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9";
const INTEGRATOR = process.env.INTEGRATOR_ADDRESS || "0x6e2Feec8434de08732D7ed5A0cDDd748dEFbB032";
const AMOUNT = BigInt(process.env.AMOUNT || "1000000");
const CURRENCY = ethers.encodeBytes32String("INR");
const CIRCLE_ID = BigInt(1);
const EXPIRED = "0xc56873ba"; // OrderExpired()

const S = ["PLACED", "ACCEPTED", "PAID", "COMPLETED", "CANCELLED"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const signers = await ethers.getSigners();
  const user = signers[1] ?? signers[0];
  const provider = ethers.provider;

  const integ = new ethers.Contract(
    INTEGRATOR,
    [
      "function buyUsdc(uint256,bytes32,uint256,string,uint256,uint256) returns (uint256)",
      "event OnrampOrderCreated(uint256 indexed orderId, address indexed user, uint256 amount, bytes32 currency)",
    ],
    user
  );
  const diamond = new ethers.Contract(
    DIAMOND,
    [
      "function getOrdersById(uint256) view returns (tuple(uint256 amount, uint256 fiatAmount, uint256 placedTimestamp, uint256 completedTimestamp, uint256 userCompletedTimestamp, address acceptedMerchant, address user, address recipientAddr, string pubkey, string encUpi, bool userCompleted, uint8 status, uint8 orderType, tuple(uint8 raisedBy, uint8 status, uint256 redactTransId, uint256 accountNumber) disputeInfo, uint256 id, string userPubKey, string encMerchantUpi, uint256 acceptedAccountNo))",
    ],
    provider
  );

  const pubKey = ethers.Wallet.createRandom().signingKey.publicKey.slice(4);
  const rc = await (await integ.buyUsdc(AMOUNT, CURRENCY, CIRCLE_ID, pubKey, 0n, 0n)).wait(1);

  let orderId = 0n;
  for (const log of rc!.logs) {
    try {
      const p = integ.interface.parseLog(log as any);
      if (p?.name === "OnrampOrderCreated") orderId = p.args.orderId;
    } catch {
      /* not ours */
    }
  }
  const t0 = Math.floor(Date.now() / 1000);
  console.log(`order ${orderId} placed at t0`);

  const data =
    ethers.id("paidBuyOrder(uint256)").slice(0, 10) +
    ethers.zeroPadValue(ethers.toBeHex(orderId), 32).slice(2);

  let lastOk = -1;
  let firstExpired = -1;
  for (let i = 0; i < 90; i++) {
    const dt = Math.floor(Date.now() / 1000) - t0;
    let status = "?";
    try {
      status = S[Number((await diamond.getOrdersById(orderId)).status)] ?? "?";
    } catch {
      /* lagging read */
    }

    let verdict: string;
    try {
      await provider.call({ to: DIAMOND, data, from: user.address });
      verdict = "OK";
      lastOk = dt;
    } catch (e: any) {
      const d = e?.data || e?.info?.error?.data;
      verdict = d === EXPIRED ? "EXPIRED" : `revert ${String(d).slice(0, 10)}`;
      if (d === EXPIRED && firstExpired < 0 && status === "ACCEPTED") firstExpired = dt;
    }
    console.log(`  t+${String(dt).padStart(3)}s  ${status.padEnd(9)} paidBuyOrder → ${verdict}`);

    if (firstExpired >= 0) break;
    if (status === "CANCELLED") break;
    await sleep(5000);
  }

  console.log(`\nlast accepted at t+${lastOk}s; first OrderExpired at t+${firstExpired}s`);
  console.log("→ a real buyer has at most this long to pay fiat AND confirm on-chain.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
