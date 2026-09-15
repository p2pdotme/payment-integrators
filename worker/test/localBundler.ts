import {
  createWalletClient,
  createPublicClient,
  http,
  encodeAbiParameters,
  concat,
  pad,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * A bundler and a paymaster, on localhost.
 *
 * WHY THIS EXISTS RATHER THAN A MOCK OF `aa.ts`
 * The worker's job on the payment path is now almost entirely serialisation:
 * packing a user operation the way the EntryPoint hashes it, folding the
 * factory and paymaster fields into `initCode` and `paymasterAndData`, and
 * reading the outcome back out. Every one of those is silent when wrong — a
 * mis-packed operation produces a signature the account rejects with no useful
 * error, and a mis-read receipt reports a refused payment as a completed one.
 *
 * Stubbing `sendUserOp` would test none of it. So this speaks the real
 * JSON-RPC methods against a real EntryPoint, and the worker runs UNCHANGED
 * between here and production — only `BUNDLER_URL` and `PAYMASTER_URL` differ.
 *
 * It stands in for the provider on two counts:
 *   • the bundler: `eth_sendUserOperation`, `eth_getUserOperationReceipt`
 *   • the paymaster service: `pm_getPaymasterData`, which signs an approval
 *     the on-chain VerifyingPaymaster then checks — the same shape as a hosted
 *     paymaster deciding per operation.
 */

export interface BundlerConfig {
  rpcUrl: string;
  chainId: number;
  entryPoint: Address;
  paymaster: Address;
  /** Signs sponsorship approvals. The on-chain paymaster is configured with
   *  this address as its verifying signer. */
  sponsorKey: Hex;
  /** Submits `handleOps`. A real bundler's own operational key; it is not part
   *  of the design under test and pays only the outer transaction. */
  bundlerKey: Hex;
  entryPointAbi: readonly unknown[];
}

const chainFor = (cfg: BundlerConfig) => ({
  id: cfg.chainId,
  name: "local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [cfg.rpcUrl] } },
});

/** v0.7 packs pairs of uint128 gas fields into one bytes32. */
const pack2 = (hi: bigint, lo: bigint): Hex =>
  concat([pad(toHex(hi), { size: 16 }), pad(toHex(lo), { size: 16 })]);

/** Bundler JSON uses the unpacked form; the EntryPoint hashes the packed one. */
function toPacked(op: Record<string, any>) {
  return {
    sender: op.sender as Address,
    nonce: BigInt(op.nonce),
    initCode: op.factory ? (concat([op.factory, op.factoryData]) as Hex) : ("0x" as Hex),
    callData: op.callData as Hex,
    accountGasLimits: pack2(BigInt(op.verificationGasLimit), BigInt(op.callGasLimit)),
    preVerificationGas: BigInt(op.preVerificationGas),
    gasFees: pack2(BigInt(op.maxPriorityFeePerGas), BigInt(op.maxFeePerGas)),
    paymasterAndData: op.paymaster
      ? (concat([
          op.paymaster,
          pad(toHex(BigInt(op.paymasterVerificationGasLimit ?? 0n)), { size: 16 }),
          pad(toHex(BigInt(op.paymasterPostOpGasLimit ?? 0n)), { size: 16 }),
          op.paymasterData ?? "0x",
        ]) as Hex)
      : ("0x" as Hex),
    signature: op.signature as Hex,
  };
}

/**
 * Builds a `fetch` that answers the bundler and paymaster RPC methods.
 *
 * Returned as a fetch handler rather than a listening server so the tests need
 * no ports and no teardown; the worker is pointed at it by URL.
 */
export function localBundler(cfg: BundlerConfig) {
  const chain = chainFor(cfg);
  const publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
  const sponsor = privateKeyToAccount(cfg.sponsorKey);
  const submitter = createWalletClient({
    account: privateKeyToAccount(cfg.bundlerKey),
    chain,
    transport: http(cfg.rpcUrl),
  });

  /** userOpHash -> the outcome, once mined. */
  const receipts = new Map<string, { success: boolean; transactionHash: Hex }>();

  /**
   * Submissions are serialised.
   *
   * A real bundler manages its own nonce and batches operations into one
   * transaction. This stand-in submits from a single wallet, so two concurrent
   * calls would collide on ITS nonce — a limitation of the substitute, not of
   * the design. Serialising keeps the concurrency tests measuring what they are
   * about: that two links no longer share a nonce sequence.
   */
  let queue: Promise<unknown> = Promise.resolve();
  const serialise = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  async function sponsorData(op: Record<string, any>) {
    // The approval covers the operation but NOT the paymaster signature itself,
    // so a stub is used for the fields the hash reads and replaced afterwards.
    const validUntil = 0;
    const validAfter = 0;
    const timestamps = encodeAbiParameters(
      [{ type: "uint48" }, { type: "uint48" }],
      [validUntil, validAfter]
    );
    const withStub = {
      ...op,
      paymaster: cfg.paymaster,
      paymasterVerificationGasLimit: toHex(300_000n),
      paymasterPostOpGasLimit: toHex(100_000n),
      paymasterData: concat([timestamps, ("0x" + "00".repeat(65)) as Hex]),
    };

    const hash = (await publicClient.readContract({
      address: cfg.paymaster,
      abi: [
        {
          type: "function",
          name: "getHash",
          stateMutability: "view",
          inputs: [
            {
              name: "userOp",
              type: "tuple",
              components: [
                { name: "sender", type: "address" },
                { name: "nonce", type: "uint256" },
                { name: "initCode", type: "bytes" },
                { name: "callData", type: "bytes" },
                { name: "accountGasLimits", type: "bytes32" },
                { name: "preVerificationGas", type: "uint256" },
                { name: "gasFees", type: "bytes32" },
                { name: "paymasterAndData", type: "bytes" },
                { name: "signature", type: "bytes" },
              ],
            },
            { name: "validUntil", type: "uint48" },
            { name: "validAfter", type: "uint48" },
          ],
          outputs: [{ type: "bytes32" }],
        },
      ] as const,
      functionName: "getHash",
      args: [toPacked(withStub) as any, validUntil, validAfter],
    })) as Hex;

    const sig = await sponsor.signMessage({ message: { raw: hash } });
    return {
      paymaster: cfg.paymaster,
      paymasterData: concat([timestamps, sig]),
      paymasterVerificationGasLimit: toHex(300_000n),
      paymasterPostOpGasLimit: toHex(100_000n),
    };
  }

  return async function fetchRpc(_url: string, init: RequestInit): Promise<Response> {
    const { method, params } = JSON.parse(init.body as string) as {
      method: string;
      params: any[];
    };
    const ok = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        headers: { "Content-Type": "application/json" },
      });
    const err = (message: string) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message } }), {
        headers: { "Content-Type": "application/json" },
      });

    if (method === "pm_getPaymasterData") {
      // A real policy refuses here — link past its allowance, contract not on
      // the allowlist. `refuseNext` lets a test exercise that path.
      if (fetchRpc.refuseNext) {
        fetchRpc.refuseNext = false;
        return err("sponsorship refused by policy");
      }
      return ok(await sponsorData(params[0]));
    }

    if (method === "eth_sendUserOperation") {
      const packed = toPacked(params[0]);
      const userOpHash = (await publicClient.readContract({
        address: cfg.entryPoint,
        abi: cfg.entryPointAbi as any,
        functionName: "getUserOpHash",
        args: [packed as any],
      })) as Hex;

      try {
        const txHash = await serialise(() =>
          submitter.writeContract({
            address: cfg.entryPoint,
            abi: cfg.entryPointAbi as any,
            functionName: "handleOps",
            args: [[packed], submitter.account!.address],
          })
        );
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

        // The whole point: handleOps SUCCEEDS even when the inner call fails.
        // The outcome lives in UserOperationEvent.success, and a real bundler
        // reports exactly this field.
        let success = false;
        for (const log of receipt.logs) {
          if (
            log.address.toLowerCase() === cfg.entryPoint.toLowerCase() &&
            log.topics[1]?.toLowerCase() === userOpHash.toLowerCase()
          ) {
            // data = nonce, success, actualGasCost, actualGasUsed
            const word = log.data.slice(2 + 64, 2 + 128);
            success = BigInt("0x" + word) === 1n;
          }
        }
        receipts.set(userOpHash.toLowerCase(), { success, transactionHash: txHash });
        return ok(userOpHash);
      } catch (e: any) {
        // Validation failures DO revert handleOps — a real bundler rejects the
        // operation at submission rather than returning a hash.
        return err(e?.shortMessage ?? e?.message ?? "operation rejected");
      }
    }

    if (method === "eth_getUserOperationReceipt") {
      const rec = receipts.get(String(params[0]).toLowerCase());
      if (!rec) return ok(null);
      return ok({ success: rec.success, receipt: { transactionHash: rec.transactionHash } });
    }

    return err(`unsupported method ${method}`);
  } as ((url: string, init: RequestInit) => Promise<Response>) & { refuseNext?: boolean };
}
