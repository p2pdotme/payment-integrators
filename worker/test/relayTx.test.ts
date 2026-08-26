import { describe, it, expect } from "vitest";
import { RELAY_INTENTS, FORBIDDEN_SELECTORS, ORDER_ID_ABI } from "../src/config";
import { explainRevert } from "../src/pay";
import { linkBlockedReason, LINK_STATUS_ACTIVE, type Link } from "../src/chain";
import { encodeFunctionData, decodeFunctionData, toFunctionSelector } from "viem";

/**
 * The relay-tx allowlist is the one place where an attacker gets to hand us
 * calldata and ask us to sign it. These tests pin the exact shape we accept.
 */
describe("relay-tx allowlist", () => {
  it("recognises exactly the two calls the widget signs itself", () => {
    expect(Object.keys(RELAY_INTENTS).sort()).toEqual(["0x1e31508e", "0x514fcac7"]);
  });

  it("maps each selector to the integrator function that can actually perform it", () => {
    // Neither selector is forwarded to the Diamond any more, and neither ever
    // worked: the Diamond authorises both against `order.user`, which for a
    // link order is the merchant's proxy, never the relayer. We translate the
    // intent onto our own integrator instead, which reaches the Diamond
    // through that proxy.
    expect(RELAY_INTENTS[toFunctionSelector("paidBuyOrder(uint256)")]).toBe("markPaid");
    expect(RELAY_INTENTS[toFunctionSelector("cancelOrder(uint256)")]).toBe("cancel");
  });

  it("the allowlisted selectors really are cancelOrder and paidBuyOrder", () => {
    // Guards against a hand-typed selector drifting from the real signature.
    expect(toFunctionSelector("cancelOrder(uint256)")).toBe("0x514fcac7");
    expect(toFunctionSelector("paidBuyOrder(uint256)")).toBe("0x1e31508e");
  });

  it("does NOT allowlist submitLivenessAttestation — it targets our own integrator", () => {
    // The widget's THIRD signer call. It only fires when the host passes a
    // `liveness` config, which the pay page does not — but it must stay off
    // the allowlist regardless, because `to` would not be the Diamond.
    const sel = toFunctionSelector("submitLivenessAttestation(bytes32,uint256,uint256,bytes)");
    expect(RELAY_INTENTS[sel]).toBeUndefined();
    expect(FORBIDDEN_SELECTORS[sel]).toBeDefined();
  });

  it("does NOT allowlist anything on our own integrator", () => {
    for (const sig of [
      "relayerPlaceOrder(bytes32,address,uint256,uint256,bytes32,uint256,string)",
      "withdrawUSDC(uint256)",
      "withdrawFiat(uint256,uint256,string,string)",
      "updateProfile(bytes,string)",
      "revokeLink(bytes32)",
      "createLink(bytes32,uint96,bytes32,uint64,bool,bytes)",
    ]) {
      expect(RELAY_INTENTS[toFunctionSelector(sig)]).toBeUndefined();
    }
  });

  it("accepts calldata of exactly selector + one uint256", () => {
    const data = encodeFunctionData({
      abi: ORDER_ID_ABI,
      functionName: "cancelOrder",
      args: [8821n],
    });
    expect(data.length).toBe(2 + 8 + 64);
    expect(RELAY_INTENTS[data.slice(0, 10)]).toBeDefined();

    const decoded = decodeFunctionData({ abi: ORDER_ID_ABI, data });
    expect(decoded.args[0]).toBe(8821n);
  });

  it("rejects calldata with a trailing argument smuggled on", () => {
    const good = encodeFunctionData({
      abi: ORDER_ID_ABI,
      functionName: "cancelOrder",
      args: [1n],
    });
    const padded = (good + "0".repeat(64)) as `0x${string}`;
    // The length check is what stops this — the selector alone would pass.
    expect(RELAY_INTENTS[padded.slice(0, 10)]).toBeDefined();
    expect(padded.length).not.toBe(2 + 8 + 64);
  });
});

describe("link payability", () => {
  const base: Link = {
    owner: "0x1111111111111111111111111111111111111111",
    amount: 3_000_000n,
    currency: "0x494e520000000000000000000000000000000000000000000000000000000000",
    expiresAt: 0n,
    maxUses: 1,
    status: LINK_STATUS_ACTIVE,
    uses: 0,
  };
  const now = 1_800_000_000;

  it("allows a fresh, active, unexpired link", () => {
    expect(linkBlockedReason(base, now)).toBeNull();
  });

  it("blocks a revoked link", () => {
    expect(linkBlockedReason({ ...base, status: 1 }, now)).toMatch(/cancelled/i);
  });

  it("blocks an expired link", () => {
    expect(linkBlockedReason({ ...base, expiresAt: BigInt(now - 1) }, now)).toMatch(/expired/i);
  });

  it("treats expiresAt 0 as never expiring", () => {
    expect(linkBlockedReason({ ...base, expiresAt: 0n }, now + 10_000_000)).toBeNull();
  });

  it("blocks a consumed single-use link but not a reusable one", () => {
    expect(linkBlockedReason({ ...base, uses: 1 }, now)).toMatch(/already been used/i);
    expect(linkBlockedReason({ ...base, maxUses: 0, uses: 9 }, now)).toBeNull();
  });
});

describe("customer-facing error messages", () => {
  it("translates every link revert into something a person can act on", () => {
    // Keyed on SELECTORS, because that is all a public RPC returns. The old
    // version fed error NAMES in the message, which only ever worked because a
    // hardhat node decodes them from its own artifacts and prints them — so
    // the test passed locally while every branch was dead in production.
    const cases: [string, RegExp][] = [
      ["0x81a36e7f", /expired/i], // LinkExpired
      ["0x8f4f4b10", /already been used/i], // LinkAlreadyUsed
      ["0x185214e4", /cancelled/i], // LinkNotActive
      ["0x3b82cbf1", /not found/i], // LinkNotFound
      ["0x5723c737", /reload/i], // LinkAmountMismatch
      ["0x410bccb3", /temporarily unavailable/i], // LinkOrdersDisabled
      ["0xe2df7fb3", /cannot accept payments/i], // MerchantIsFrozen
      ["0xf402e5b1", /today's payment limit/i], // DailyLimitReached
      ["0x49aeece1", /above the limit/i], // ExceedsPerTxCap
    ];
    for (const [selector, expected] of cases) {
      // Shaped like a viem revert: the payload hangs off the cause chain,
      // and the message says nothing useful — exactly as a Base RPC returns it.
      const err = Object.assign(new Error("execution reverted"), {
        cause: { data: selector },
      });
      expect(explainRevert(err)).toMatch(expected);
    }
  });

  it("still falls back gracefully when there is no revert data at all", () => {
    expect(explainRevert(new Error("network unreachable"))).toMatch(/could not be started/i);
    expect(explainRevert(new Error("insufficient funds for gas"))).toMatch(
      /temporarily unavailable/i
    );
  });

  it("decodes reverts that arrive WRAPPED from inside the Diamond call", () => {
    // validateOrder's guards surface as CallFailed(bytes) with only the inner
    // selector — the error name never appears. Matching on the name alone left
    // a customer who hit a real daily limit with "could not be started".
    const wrapped: [string, RegExp][] = [
      ["0xe2df7fb3", /cannot accept payments/i], // MerchantIsFrozen
      ["0x49aeece1", /above the limit/i], // ExceedsPerTxCap
      ["0xf402e5b1", /today's payment limit/i], // DailyLimitReached
      ["0xaba47339", /not set up to accept/i], // NotRegistered
    ];
    for (const [selector, expected] of wrapped) {
      const err = new Error(`reverted with custom error 'CallFailed("${selector}")'`);
      expect(explainRevert(err)).toMatch(expected);
    }
  });

  it("never leaks a raw revert string to the customer", () => {
    const msg = explainRevert(new Error("execution reverted 0xdeadbeef opcode INVALID"));
    expect(msg).not.toMatch(/0x|revert|opcode/i);
    expect(msg.length).toBeLessThan(120);
  });

  it("does not blame the customer when the relayer is out of gas", () => {
    const msg = explainRevert(new Error("insufficient funds for gas * price + value"));
    expect(msg).toMatch(/temporarily unavailable/i);
    expect(msg).not.toMatch(/your|you/i);
  });
});
