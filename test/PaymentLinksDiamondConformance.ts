/**
 * Conformance: does MockDiamond's authorisation gate match the REAL Diamond's?
 *
 * WHY THIS EXISTS
 * The B1 blocker was not a logic error. It was a factual error about a contract
 * we do not own: link orders recorded the merchant as `order.user`, and the
 * Diamond gates `paidBuyOrder` and `cancelOrder` on exactly that field — so the
 * only key permitted to advance a link order belonged to the one party who is
 * absent by construction. No unit test could have caught it, because
 * MockDiamond implemented neither function, and both "settlement" tests jumped
 * straight to `simulateOrderComplete`.
 *
 * MockDiamond has since grown both functions behind the real gate, and
 * `PaymentLinksMarkPaid.ts` tests the contract against it. But a mock is only
 * evidence for as long as it agrees with the thing it stands for, and nothing
 * was checking that half. This closes the loop from the other side: it asserts
 * the live Diamond still gates on `order.user`, which is the premise the mock
 * encodes and the entire proxy-as-user fix rests on.
 *
 * If this ever fails, the mock is lying and the fix needs revisiting — which
 * is exactly the signal that was missing when B1 shipped.
 *
 * RUNNING IT
 *   LIVE_DIAMOND=1 npx hardhat test test/PaymentLinksDiamondConformance.ts
 *
 * Skipped by default: it needs a live RPC, and a suite that silently depends on
 * the internet is a suite that goes red for reasons nobody can act on. It is
 * read-only — `eth_call` throughout, no keys, no funds, no state change — so it
 * is safe to point at mainnet by setting DIAMOND_ADDRESS and LIVE_RPC.
 */

import { expect } from "chai";
import { ethers } from "hardhat";

const LIVE = process.env.LIVE_DIAMOND === "1";
const RPC = process.env.LIVE_RPC || "https://sepolia.base.org";
const DIAMOND = process.env.DIAMOND_ADDRESS || "0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9";

/** A caller that is certainly not any order's user. */
const STRANGER = "0x000000000000000000000000000000000000dEaD";

const SELECTORS: Record<string, string> = {
  "0xea8e4eb5": "NotAuthorized",
  "0x181b1b2e": "OrderStatusInvalid",
  "0xc56873ba": "OrderExpired",
};

const DIAMOND_ABI = [
  "function getOrdersById(uint256) view returns (tuple(uint256 amount,uint256 fiatAmount,uint256 placedTimestamp,uint256 completedTimestamp,uint256 userCompletedTimestamp,address acceptedMerchant,address user,address recipientAddr,string pubkey,string encUpi,bool userCompleted,uint8 status,uint8 orderType,tuple(uint8 raisedBy,uint8 status,uint256 redactTransId,uint256 accountNumber) disputeInfo,uint256 id,string userPubKey,string encMerchantUpi,uint256 acceptedAccountNo,uint256[] assignedAccountNos,bytes32 currency,uint256 preferredPaymentChannelConfigId,uint256 circleId))",
  "function getNextOrderId() view returns (uint256)",
  "function paidBuyOrder(uint256)",
  "function cancelOrder(uint256)",
];

const PLACED = 0;
const ACCEPTED = 1;

/** Names the custom error a call reverted with, or "" if it did not revert. */
function revertName(err: unknown): string {
  const e = err as { data?: unknown; info?: { error?: { data?: unknown } } };
  const raw = (e?.data ?? e?.info?.error?.data ?? "") as string;
  const sel = typeof raw === "string" ? raw.slice(0, 10) : "";
  return SELECTORS[sel] ?? sel;
}

(LIVE ? describe : describe.skip)("Diamond conformance — the real order.user gate", function () {
  this.timeout(120_000);

  let provider: ethers.JsonRpcProvider;
  let diamond: ethers.Contract;
  let sample: { id: bigint; user: string; status: number } | null = null;

  before(async function () {
    provider = new ethers.JsonRpcProvider(RPC);
    diamond = new ethers.Contract(DIAMOND, DIAMOND_ABI, provider);

    // Find any order still in a state where the two calls are meaningful.
    // Pinning specific ids would rot: an order in PLACED today is CANCELLED
    // next week, and the suite would start failing for no reason worth acting
    // on.
    const next = await diamond.getNextOrderId();
    for (let id = next - 1n; id > next - 400n && id > 0n; id--) {
      try {
        const o = await diamond.getOrdersById(id);
        const status = Number(o.status);
        if (status === PLACED || status === ACCEPTED) {
          sample = { id, user: o.user as string, status };
          break;
        }
      } catch {
        /* unreadable id — keep looking */
      }
    }
    if (!sample) this.skip();
  });

  it("refuses BOTH advancing calls from anyone who is not order.user", async function () {
    // This single fact is what made the original design unable to complete a
    // payment. If it ever stops holding, the proxy-as-user fix is unnecessary
    // and this test should be the thing that says so.
    for (const fn of ["paidBuyOrder", "cancelOrder"]) {
      const data = diamond.interface.encodeFunctionData(fn, [sample!.id]);
      let name = "";
      try {
        await provider.call({ to: DIAMOND, data, from: STRANGER });
      } catch (err) {
        name = revertName(err);
      }
      expect(name, `${fn} from a stranger`).to.equal("NotAuthorized");
    }
  });

  it("admits order.user through the authorisation gate", async function () {
    // `paidBuyOrder` may still fail on state or expiry — what matters is that
    // it fails for a reason OTHER than authorisation.
    for (const fn of ["paidBuyOrder", "cancelOrder"]) {
      const data = diamond.interface.encodeFunctionData(fn, [sample!.id]);
      let name = "";
      try {
        await provider.call({ to: DIAMOND, data, from: sample!.user });
      } catch (err) {
        name = revertName(err);
      }
      expect(name, `${fn} from order.user`).to.not.equal("NotAuthorized");
    }
  });

  it("reports the sampled order, so a failure above is diagnosable", async function () {
    // A conformance failure is a statement about a chain, not about this
    // repository, and the first question will be "against what?". Print it.
    console.log(
      `      diamond ${DIAMOND} · order ${sample!.id} · status ${sample!.status} · user ${sample!.user}`
    );
    expect(sample!.user).to.properAddress;
  });
});
