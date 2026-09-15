import { describe, it, expect } from "vitest";
import { decodeFunctionData } from "viem";
import { executeCall, successFromLogs } from "../src/aa";
import { SIMPLE_ACCOUNT_ABI, LINK_ROUTER_ABI, ENTRYPOINT_ABI, accountFactory } from "../src/config";
import {
  encodeFunctionData,
  encodeEventTopics,
  encodeAbiParameters,
  toFunctionSelector,
} from "viem";

/**
 * The user-operation client.
 *
 * WHAT IS WORTH TESTING HERE
 * Not the bundler — that is someone else's service, and the contract suite
 * already drives the whole flow through a real EntryPoint. What is worth
 * pinning is the two things this file gets to decide, both of which fail
 * quietly when wrong:
 *
 *   1. The call really is wrapped as the account's own `execute`, with ZERO
 *      value. The account holds nothing, so a non-zero value would revert at
 *      the worst possible moment — after the customer has sent their fiat.
 *
 *   2. `success` is read from UserOperationEvent, and a MISSING flag counts as
 *      failure. `handleOps` does not revert when the inner call fails: the
 *      EntryPoint catches it and records the outcome in that event, so a
 *      refused payment and a completed one are indistinguishable from the
 *      outside. This is the same shape as the Diamond swallowing a failed
 *      callback, which is how link orders came to be silently unpayable.
 */

const ROUTER = "0x1111111111111111111111111111111111111111" as const;
const LINK = ("0x" + "ab".repeat(32)) as `0x${string}`;

const routerPlace = () =>
  encodeFunctionData({
    abi: LINK_ROUTER_ABI,
    functionName: "place",
    args: [
      LINK,
      "0x2222222222222222222222222222222222222222",
      1n,
      1n,
      ("0x" + "00".repeat(32)) as `0x${string}`,
      0n,
      "pk",
      "0x3333333333333333333333333333333333333333",
    ],
  });

describe("wrapping a call as the account's own execute", () => {
  it("targets the Router and carries the Router call verbatim", () => {
    const inner = routerPlace();
    const outer = executeCall(ROUTER, inner);

    const decoded = decodeFunctionData({ abi: SIMPLE_ACCOUNT_ABI, data: outer });
    expect(decoded.functionName).toBe("execute");
    expect(decoded.args[0]).toBe(ROUTER);
    expect(decoded.args[2]).toBe(inner);
  });

  it("always sends zero value", () => {
    // The account holds nothing. A non-zero value here would revert only once a
    // real customer had already sent their bank transfer.
    const decoded = decodeFunctionData({
      abi: SIMPLE_ACCOUNT_ABI,
      data: executeCall(ROUTER, routerPlace()),
    });
    expect(decoded.args[1]).toBe(0n);
  });

  it("keeps the link id recoverable from the inner call", () => {
    // The sponsorship verifier decodes the link out of exactly this call data.
    // If wrapping mangled it, every operation would be refused as
    // unattributable rather than sponsored.
    const inner = routerPlace();
    const outer = executeCall(ROUTER, inner);
    const { args } = decodeFunctionData({ abi: SIMPLE_ACCOUNT_ABI, data: outer });
    const innerDecoded = decodeFunctionData({
      abi: LINK_ROUTER_ABI,
      data: args[2] as `0x${string}`,
    });
    expect(innerDecoded.args[0]).toBe(LINK);
  });
});

describe("reading the outcome of an operation", () => {
  const userOpEventLog = (success: boolean) => ({
    topics: encodeEventTopics({
      abi: ENTRYPOINT_ABI,
      eventName: "UserOperationEvent",
      args: {
        userOpHash: ("0x" + "cd".repeat(32)) as `0x${string}`,
        sender: "0x4444444444444444444444444444444444444444",
        paymaster: "0x5555555555555555555555555555555555555555",
      },
    }) as `0x${string}`[],
    data: encodeAbiParameters(
      [
        { name: "nonce", type: "uint256" },
        { name: "success", type: "bool" },
        { name: "actualGasCost", type: "uint256" },
        { name: "actualGasUsed", type: "uint256" },
      ],
      [1n, success, 1000n, 2000n]
    ),
  });

  it("reports a completed operation", () => {
    expect(successFromLogs([userOpEventLog(true)])).toBe(true);
  });

  it("reports a REFUSED operation, which the transaction itself does not", () => {
    // The transaction that carried this succeeded. Only the flag says the
    // payment did not happen — reporting on the transaction alone would tell a
    // customer their payment went through when the Router rejected it.
    expect(successFromLogs([userOpEventLog(false)])).toBe(false);
  });

  it("returns null when there is no EntryPoint event at all", () => {
    // Never `true`. An outcome we cannot confirm must not be read as success;
    // callers treat null as "not confirmed" and refuse to settle on it.
    const unrelated = {
      topics: [("0x" + "99".repeat(32)) as `0x${string}`],
      data: "0x" as `0x${string}`,
    };
    expect(successFromLogs([unrelated])).toBeNull();
    expect(successFromLogs([])).toBeNull();
  });

  it("finds the event among unrelated logs", () => {
    // A real receipt carries the integrator's and Diamond's logs too.
    const noise = {
      topics: [("0x" + "77".repeat(32)) as `0x${string}`],
      data: "0x" as `0x${string}`,
    };
    expect(successFromLogs([noise, userOpEventLog(true), noise])).toBe(true);
  });
});

/**
 * The account factory has TWO shapes in the wild, and picking the wrong one is
 * silent.
 *
 * This suite exists because the wrong one shipped. The reference
 * `SimpleAccountFactory` takes `(address, uint256)`; thirdweb's
 * `BaseAccountFactory` takes `(address, bytes)`. Different types mean different
 * SELECTORS — so the wrong ABI does not throw a type error or fail to encode,
 * it calls a function the factory does not have.
 *
 * It passed every local test, because the local fixture IS the reference
 * factory. It would have failed only against production.
 */
describe("which account factory we are talking to", () => {
  const env = (kind?: string) => ({ ACCOUNT_FACTORY_KIND: kind }) as any;

  it("gives the two factories DIFFERENT selectors — this is the whole trap", () => {
    const simple = toFunctionSelector("getAddress(address,uint256)");
    const thirdweb = toFunctionSelector("getAddress(address,bytes)");
    expect(simple).not.toBe(thirdweb);
  });

  it("encodes createAccount for the reference factory as (address,uint256)", () => {
    const { abi, salt } = accountFactory(env("simple"));
    const data = encodeFunctionData({
      abi,
      functionName: "createAccount",
      args: ["0x1111111111111111111111111111111111111111", salt],
    } as never);
    expect(data.slice(0, 10)).toBe(toFunctionSelector("createAccount(address,uint256)"));
  });

  it("encodes createAccount for thirdweb's factory as (address,bytes)", () => {
    const { abi, salt } = accountFactory(env("thirdweb"));
    const data = encodeFunctionData({
      abi,
      functionName: "createAccount",
      args: ["0x1111111111111111111111111111111111111111", salt],
    } as never);
    expect(data.slice(0, 10)).toBe(toFunctionSelector("createAccount(address,bytes)"));
  });

  it("defaults to thirdweb, because that is what production runs", () => {
    const { abi } = accountFactory(env(undefined));
    const data = encodeFunctionData({
      abi,
      functionName: "getAddress",
      args: ["0x1111111111111111111111111111111111111111", "0x"],
    } as never);
    expect(data.slice(0, 10)).toBe(toFunctionSelector("getAddress(address,bytes)"));
  });

  it("refuses an unknown kind rather than guessing", () => {
    // A wrong guess here is invisible until production, so there is no default
    // worth falling back to.
    expect(() => accountFactory(env("nonsense"))).toThrow(/ACCOUNT_FACTORY_KIND/);
  });
});
