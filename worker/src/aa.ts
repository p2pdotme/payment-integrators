/**
 * Sending a payment as a user operation.
 *
 * This is what replaces `wallet.writeContract` plus the nonce manager. The old
 * path signed a transaction from a funded key and had to track that key's nonce
 * globally, which is why one stuck payment blocked every later one. Here the
 * sender is the link's own account: it has its own nonce sequence, so nothing
 * queues behind anyone else's traffic, and it holds no balance because a
 * paymaster pays.
 *
 * THE TRAP THIS FILE EXISTS TO AVOID
 * `handleOps` does NOT revert when the inner call fails. The EntryPoint catches
 * it and reports the outcome in `UserOperationEvent.success`, so a rejected
 * operation and a successful one look identical from the outside — the bundler
 * returns a hash either way and the transaction succeeds.
 *
 * That is the same shape as the bug that made link orders unpayable: the
 * Diamond swallowed a failed callback, so a lost daily slot looked like a
 * normal completion. `waitForUserOp` below therefore treats a missing or false
 * success flag as a FAILURE, never as "probably fine". Anything else would let
 * a refused payment be reported to a customer as accepted.
 */

import {
  encodeFunctionData,
  decodeEventLog,
  concat,
  pad,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { publicClientFor } from "./chain";
import { ENTRYPOINT_ABI, SIMPLE_ACCOUNT_ABI, accountFactory, type Env } from "./config";

/** ERC-4337 v0.7 packed user operation, as the bundler expects it on the wire. */
export interface UserOp {
  sender: Address;
  nonce: Hex;
  factory?: Address;
  factoryData?: Hex;
  callData: Hex;
  callGasLimit: Hex;
  verificationGasLimit: Hex;
  preVerificationGas: Hex;
  maxFeePerGas: Hex;
  maxPriorityFeePerGas: Hex;
  paymaster?: Address;
  paymasterVerificationGasLimit?: Hex;
  paymasterPostOpGasLimit?: Hex;
  paymasterData?: Hex;
  signature: Hex;
}

export class UserOpError extends Error {
  constructor(
    message: string,
    readonly stage: "sponsor" | "send" | "receipt" | "execution",
    readonly detail?: unknown
  ) {
    super(message);
    this.name = "UserOpError";
  }
}

const hex = (n: bigint | number): Hex => `0x${BigInt(n).toString(16)}` as Hex;

async function rpc<T>(
  url: string,
  method: string,
  params: unknown[],
  headers: Record<string, string> = {}
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error)
    throw new UserOpError(body.error.message ?? method + " failed", "send", body.error);
  return body.result as T;
}

const bundlerHeaders = (env: Env): Record<string, string> =>
  env.BUNDLER_SECRET ? { Authorization: `Bearer ${env.BUNDLER_SECRET}` } : {};

/**
 * The account address for an owner, before it exists.
 *
 * Read from the factory rather than derived locally. Deriving it here would
 * mean embedding the proxy's creation bytecode in this worker and keeping it in
 * step with whatever the factory actually deploys — a mismatch would produce a
 * perfectly plausible address that nothing ever lands at, and the failure would
 * surface much later as "sender already constructed" or a silently dead link.
 * One view call is worth not having that class of bug.
 */
export async function predictAccount(env: Env, owner: Address): Promise<Address> {
  const { abi, salt } = accountFactory(env);
  return (await publicClientFor(env).readContract({
    address: env.ACCOUNT_FACTORY_ADDRESS as Address,
    abi,
    functionName: "getAddress",
    args: [owner, salt],
  } as never)) as Address;
}

/** Wraps a call to the Router as the account's own `execute`. Value is always
 *  zero: the account holds nothing, and nothing in this flow moves native coin. */
export function executeCall(target: Address, data: Hex): Hex {
  return encodeFunctionData({
    abi: SIMPLE_ACCOUNT_ABI,
    functionName: "execute",
    args: [target, 0n, data],
  });
}

/**
 * Asks the sponsor to cover this operation.
 *
 * PROVIDER SEAM. The ERC-7677 method names below are the standard ones and are
 * what most providers expose, but the exact shape is the one part of this file
 * that is provider-specific. If a provider disagrees, this function is the only
 * thing that changes — everything else speaks plain ERC-4337.
 *
 * Note what is NOT here: any decision about whether the payment is allowed.
 * Sponsorship answers "will we pay the fee", never "is this permitted". The
 * Router and the integrator decide that, on-chain.
 */
async function sponsor(env: Env, op: UserOp): Promise<UserOp> {
  if (!env.PAYMASTER_URL) return op; // unsponsored: only for local development
  try {
    const data = await rpc<{
      paymaster: Address;
      paymasterData: Hex;
      paymasterVerificationGasLimit?: Hex;
      paymasterPostOpGasLimit?: Hex;
    }>(
      env.PAYMASTER_URL,
      "pm_getPaymasterData",
      [
        op,
        env.ENTRYPOINT_ADDRESS,
        hex(Number(env.CHAIN_ID)),
        { policyId: env.PAYMASTER_POLICY_ID },
      ],
      bundlerHeaders(env)
    );
    return {
      ...op,
      paymaster: data.paymaster,
      paymasterData: data.paymasterData,
      paymasterVerificationGasLimit: data.paymasterVerificationGasLimit ?? hex(300_000),
      paymasterPostOpGasLimit: data.paymasterPostOpGasLimit ?? hex(100_000),
    };
  } catch (e) {
    // A refusal is a normal outcome — a link past its allowance, a policy that
    // does not cover this contract. It must not read as an outage.
    throw new UserOpError("Sponsorship refused for this operation.", "sponsor", e);
  }
}

/**
 * Waits for the operation and reports whether the INNER call actually ran.
 *
 * See the header: a bundler hash means the operation was accepted for
 * inclusion, not that it did anything. `success` is the only thing that says
 * the payment happened.
 */
export async function waitForUserOp(
  env: Env,
  userOpHash: Hex,
  timeoutMs = 45_000
): Promise<{ success: boolean; txHash: Hex; reason?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await rpc<{
      success: boolean;
      reason?: string;
      receipt: { transactionHash: Hex };
    } | null>(env.BUNDLER_URL, "eth_getUserOperationReceipt", [userOpHash], bundlerHeaders(env));

    if (receipt) {
      return {
        // Absent flag is treated as failure, never as success. An operation we
        // cannot confirm ran must not be reported to a customer as paid.
        success: receipt.success === true,
        txHash: receipt.receipt?.transactionHash,
        reason: receipt.reason,
      };
    }
    await new Promise((r) => setTimeout(r, 1_500));
  }
  throw new UserOpError("Timed out waiting for the payment to confirm.", "receipt");
}

/**
 * Builds, sponsors, signs and sends one operation.
 *
 * @param signer The link's own account, from `linkSigner`. It holds nothing;
 *        its only power is producing this signature.
 * @param deploy Present on the FIRST operation for a link, absent afterwards.
 *        The account is created lazily by the EntryPoint, so a link nobody ever
 *        pays deploys nothing at all.
 */
export async function sendUserOp(
  env: Env,
  args: {
    signer: { address: Address; signMessage: (a: { message: { raw: Hex } }) => Promise<Hex> };
    sender: Address;
    callData: Hex;
    deploy?: { factory: Address; factoryData: Hex };
  }
): Promise<{ userOpHash: Hex }> {
  const client = publicClientFor(env);

  const nonce = (await client.readContract({
    address: env.ENTRYPOINT_ADDRESS as Address,
    abi: ENTRYPOINT_ABI,
    functionName: "getNonce",
    args: [args.sender, 0n],
  })) as bigint;

  const fees = await client.estimateFeesPerGas();

  let op: UserOp = {
    sender: args.sender,
    nonce: hex(nonce),
    ...(args.deploy ? { factory: args.deploy.factory, factoryData: args.deploy.factoryData } : {}),
    callData: args.callData,
    callGasLimit: hex(900_000),
    verificationGasLimit: hex(args.deploy ? 1_500_000 : 500_000),
    preVerificationGas: hex(200_000),
    maxFeePerGas: hex(fees.maxFeePerGas ?? 2_000_000_000n),
    maxPriorityFeePerGas: hex(fees.maxPriorityFeePerGas ?? 2_000_000_000n),
    signature: ("0x" + "00".repeat(65)) as Hex,
  };

  op = await sponsor(env, op);

  // The account validates this against its own owner. Nothing else about the
  // operation is ours to authorise — the Router checks who may act on the link,
  // and the customer's signature (inside callData) checks who may settle.
  const userOpHash = (await client.readContract({
    address: env.ENTRYPOINT_ADDRESS as Address,
    abi: ENTRYPOINT_ABI,
    functionName: "getUserOpHash",
    args: [toPacked(op, env)],
  })) as Hex;

  op.signature = await args.signer.signMessage({ message: { raw: userOpHash } });

  const sent = await rpc<Hex>(
    env.BUNDLER_URL,
    "eth_sendUserOperation",
    [op, env.ENTRYPOINT_ADDRESS],
    bundlerHeaders(env)
  );
  return { userOpHash: sent };
}

/**
 * The on-the-wire form the EntryPoint hashes.
 *
 * v0.7 packs pairs of uint128 gas fields into single bytes32 words, and folds
 * factory/paymaster fields into `initCode` and `paymasterAndData`. Bundler JSON
 * uses the unpacked form, so the two representations must be kept in step —
 * hashing the wrong one produces a signature the account rejects with no useful
 * error.
 */
export function toPacked(op: UserOp, _env?: Env) {
  // `pad` THROWS when a value does not fit; hand-rolling this with
  // `padStart(32, "0")` does not — an oversized value silently produces a
  // longer string, the fields shift, and the account rejects the signature with
  // no indication of why. A loud failure is worth more than a clever one here.
  const pack = (hi: Hex, lo: Hex): Hex =>
    concat([pad(toHex(BigInt(hi)), { size: 16 }), pad(toHex(BigInt(lo)), { size: 16 })]);

  return {
    sender: op.sender,
    nonce: BigInt(op.nonce),
    initCode: op.factory ? ((op.factory + op.factoryData!.slice(2)) as Hex) : ("0x" as Hex),
    callData: op.callData,
    accountGasLimits: pack(op.verificationGasLimit, op.callGasLimit),
    preVerificationGas: BigInt(op.preVerificationGas),
    gasFees: pack(op.maxPriorityFeePerGas, op.maxFeePerGas),
    paymasterAndData: op.paymaster
      ? concat([
          op.paymaster,
          pad(toHex(BigInt(op.paymasterVerificationGasLimit ?? "0x0")), { size: 16 }),
          pad(toHex(BigInt(op.paymasterPostOpGasLimit ?? "0x0")), { size: 16 }),
          (op.paymasterData ?? "0x") as Hex,
        ])
      : ("0x" as Hex),
    signature: op.signature,
  };
}

/** Reads the success flag out of a mined EntryPoint log, for callers that have
 *  a transaction receipt rather than a bundler receipt. */
export function successFromLogs(logs: { topics: readonly Hex[]; data: Hex }[]): boolean | null {
  for (const log of logs) {
    try {
      const parsed = decodeEventLog({
        abi: ENTRYPOINT_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (parsed.eventName === "UserOperationEvent") {
        return (parsed.args as unknown as { success: boolean }).success;
      }
    } catch {
      /* not an EntryPoint log */
    }
  }
  return null;
}
