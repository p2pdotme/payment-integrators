import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { requireFixture } from "./fixture";
import { webcrypto } from "node:crypto";
import {
  createPublicClient,
  defineChain,
  encodeFunctionData,
  http,
  toHex,
  parseUnits,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { handlePay } from "../src/pay";
import { createLinkWallet, linkSigner } from "../src/linkWallet";
import { handleProvisionWallet } from "../src/provision";
import { predictAccount, sendUserOp, waitForUserOp, executeCall } from "../src/aa";
import { makeTestEnv, useLocalBundler, CUSTOMER_PUBKEY, type Addresses } from "./harness";
import { LINK_ROUTER_ABI, ACCOUNT_FACTORY_ABI, type Env } from "../src/config";

/**
 * The merchant as a SMART ACCOUNT, which is what production actually has.
 *
 * WHY THIS SUITE EXISTS
 * Every other fixture in this repo creates links by signing straight from a
 * plain EOA, because that is the shortest way to get a link on-chain. In
 * production the merchant signs in with a social login and gets a smart
 * account, so every merchant action is a user operation — a different code path
 * with different failure modes, none of which the EOA fixtures touch.
 *
 * That gap is not hypothetical. The account-factory ABI shipped wrong for
 * exactly this reason: the local fixture was the reference factory, so the
 * wrong shape passed every test and would have failed on the first real
 * payment. Fixtures agreeing with themselves is the failure mode; this suite
 * exists to stop the merchant side doing the same.
 *
 * THE ONE THAT MATTERS MOST
 * Production batches `createLink` and `registerAgent` into a SINGLE operation,
 * so the merchant taps once. If batching does not work, a link is created
 * without its agent — and a link without an agent looks completely correct in
 * the merchant's list, in the contract, and to the customer opening it, right
 * up until payment, which can never happen. That case is asserted below.
 *
 * Requires `npx hardhat node` and `scripts/e2e-setup.js`.
 */

if (!(globalThis as any).crypto) (globalThis as any).crypto = webcrypto;

// The URL object is passed straight to existsSync/readFileSync, which both
// accept one. Converting to a string with `.pathname` and stripping the
// leading slash is a Windows drive-letter fix that BREAKS POSIX: it leaves
// "/D:/..." absolute but turns "/home/..." into a relative path resolved
// against cwd. The result was always false on Linux, so these suites ran on
// a developer machine and silently skipped in CI.
const ADDR = new URL("./e2e-addresses.json", import.meta.url);
const HAVE = requireFixture(ADDR, "e2e-merchant-account");
const A: Addresses = HAVE ? JSON.parse(readFileSync(ADDR, "utf8")) : ({} as Addresses);

const USDC = (n: number) => parseUnits(String(n), 6);
const INR = toHex("INR", { size: 32 });
const AMOUNT = USDC(1);

const MERCHANT_ABI = [
  {
    type: "function",
    name: "registerMerchant",
    stateMutability: "nonpayable",
    inputs: [
      { name: "encPayoutId", type: "bytes" },
      { name: "shopName", type: "string" },
      { name: "currencyCode", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "createLink",
    stateMutability: "nonpayable",
    inputs: [
      { name: "linkId", type: "bytes32" },
      { name: "amount", type: "uint96" },
      { name: "currency", type: "bytes32" },
      { name: "expiresAt", type: "uint64" },
      { name: "maxUses", type: "uint32" },
      { name: "encryptedConfig", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getLink",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [
      { name: "owner", type: "address" },
      { name: "amount", type: "uint96" },
      { name: "currency", type: "bytes32" },
      { name: "expiresAt", type: "uint64" },
      { name: "maxUses", type: "uint32" },
      { name: "status", type: "uint8" },
      { name: "uses", type: "uint32" },
      { name: "strikes", type: "uint16" },
    ],
  },
] as const;

const BATCH_ABI = [
  {
    type: "function",
    name: "executeBatch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "dest", type: "address[]" },
      { name: "value", type: "uint256[]" },
      { name: "func", type: "bytes[]" },
    ],
    outputs: [],
  },
] as const;

describe.skipIf(!HAVE)("the merchant as a smart account, as in production", () => {
  let env: Env;
  let pub: any;
  let chain: any;
  let bundlerHandle: ReturnType<typeof useLocalBundler>;

  /** The merchant's OWNER key — what a social login controls. */
  let merchantKey: ReturnType<typeof privateKeyToAccount>;
  /** Their smart account. This is the address that registers and owns links. */
  let merchantAccount: Address;

  const RUN = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let seq = 0;

  const linkId = () => keccak256(toHex(`${RUN}:sa:${seq++}`)) as Hex;

  beforeAll(async () => {
    chain = defineChain({
      id: A.chainId,
      name: "local",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [A.rpcUrl] } },
    });
    pub = createPublicClient({ chain, transport: http(A.rpcUrl) });

    // The merchant account must be able to SIGN, not only send — see
    // Account1271.sol. Everything else about the fixture is unchanged, and the
    // factory shape is identical, so nothing in src/ special-cases this.
    env = { ...makeTestEnv(A), ACCOUNT_FACTORY_ADDRESS: A.account1271Factory } as Env;
    bundlerHandle = useLocalBundler(A);

    // A fresh owner key, so this merchant is nobody the other suites touched.
    merchantKey = privateKeyToAccount(keccak256(toHex(`${RUN}:merchant-owner`)) as Hex);
    merchantAccount = await predictAccount(env, merchantKey.address);

    // Register as a merchant FROM THE SMART ACCOUNT, which also deploys it.
    // Sponsored: the merchant holds no native coin, exactly as in production.
    await runOp(
      executeCall(
        A.integrator as Address,
        encodeFunctionData({
          abi: MERCHANT_ABI,
          functionName: "registerMerchant",
          args: [keccak256(toHex("enc:sa-merchant")), "Smart Account Shop", "INR"],
        })
      ),
      true
    );
  }, 180_000);

  afterAll(() => bundlerHandle?.restore());

  /** Sends one operation as the merchant's account, and waits for the outcome. */
  async function runOp(callData: Hex, deploy = false) {
    const { userOpHash } = await sendUserOp(env, {
      signer: merchantKey as any,
      sender: merchantAccount,
      callData,
      deploy: deploy
        ? {
            factory: A.account1271Factory as Address,
            factoryData: encodeFunctionData({
              abi: ACCOUNT_FACTORY_ABI,
              functionName: "createAccount",
              args: [merchantKey.address, 0n],
            }),
          }
        : undefined,
    });
    const outcome = await waitForUserOp(env, userOpHash);
    return outcome;
  }

  /** `createLink` and `registerAgent` in ONE operation — the production shape. */
  async function createLinkBatched(id: Hex, maxUses = 3) {
    const account = await createLinkWallet(env, id, 3600, (owner) => predictAccount(env, owner));

    const outcome = await runOp(
      encodeFunctionData({
        abi: BATCH_ABI,
        functionName: "executeBatch",
        args: [
          [A.integrator as Address, A.router as Address],
          [0n, 0n],
          [
            encodeFunctionData({
              abi: MERCHANT_ABI,
              functionName: "createLink",
              args: [id, AMOUNT, INR, 0n, maxUses, "0x"],
            }),
            encodeFunctionData({
              abi: LINK_ROUTER_ABI,
              functionName: "registerAgent",
              args: [id, account],
            }),
          ],
        ],
      })
    );
    return { outcome, account };
  }

  const payReq = (ip: string) =>
    new Request("https://worker/api/pay/x", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ pubKey: CUSTOMER_PUBKEY, circleId: 1 }),
    });

  // ─── The merchant exists as a contract ────────────────────────────

  it("registers as a merchant from a smart account, holding no native coin", async () => {
    // The whole premise: the merchant never funds anything. If registration
    // needed gas from them, social-login onboarding would not work at all.
    expect(await pub.getCode({ address: merchantAccount })).not.toBeUndefined();
    expect(await pub.getBalance({ address: merchantAccount })).toBe(0n);
  }, 180_000);

  // ─── The batch that production depends on ─────────────────────────

  it("creates a link AND registers its agent in one operation", async () => {
    const id = linkId();
    const { outcome, account } = await createLinkBatched(id);
    expect(outcome.success).toBe(true);

    // Both halves landed.
    const link = (await pub.readContract({
      address: A.integrator as Address,
      abi: MERCHANT_ABI,
      functionName: "getLink",
      args: [id],
    })) as any[];
    expect(link[0]).toBe(merchantAccount); // owner is the SMART ACCOUNT

    const agent = (await pub.readContract({
      address: A.router as Address,
      abi: LINK_ROUTER_ABI,
      functionName: "linkAgent",
      args: [id],
    })) as Address;
    expect(agent).toBe(account);
  }, 180_000);

  it("a customer then pays that link", async () => {
    // The end of the chain: a link created entirely through account
    // abstraction, by a merchant who owns no coin, paid by a customer who owns
    // no wallet.
    const id = linkId();
    const { outcome } = await createLinkBatched(id);
    expect(outcome.success).toBe(true);

    const res = await handlePay(payReq("198.21.0.1"), env, id);
    const body = (await res.json()) as any;
    expect(res.status, `pay failed: ${body.error}`).toBe(200);
    expect(body.orderId).toBeTruthy();
  }, 180_000);

  // ─── The failure this suite is really guarding ────────────────────

  it("a link created WITHOUT its agent is unpayable — the batch must not half-land", async () => {
    // Deliberately skipping registerAgent, to show what a broken batch produces.
    // The link is valid in every visible way: on-chain, owned by the merchant,
    // active, correct amount. It simply cannot be paid, and nothing before the
    // payment attempt would tell anyone.
    const id = linkId();
    await runOp(
      executeCall(
        A.integrator as Address,
        encodeFunctionData({
          abi: MERCHANT_ABI,
          functionName: "createLink",
          args: [id, AMOUNT, INR, 0n, 3, "0x"],
        })
      )
    );

    const link = (await pub.readContract({
      address: A.integrator as Address,
      abi: MERCHANT_ABI,
      functionName: "getLink",
      args: [id],
    })) as any[];
    expect(link[0]).toBe(merchantAccount); // looks perfectly fine

    const agent = (await pub.readContract({
      address: A.router as Address,
      abi: LINK_ROUTER_ABI,
      functionName: "linkAgent",
      args: [id],
    })) as Address;
    expect(agent).toBe("0x0000000000000000000000000000000000000000");

    // And the payment fails, rather than half-succeeding.
    const res = await handlePay(payReq("198.21.0.2"), env, id);
    expect(res.status).toBeGreaterThanOrEqual(400);
  }, 180_000);

  // ─── Ownership follows the account, not the key ───────────────────

  it("only the smart account can register an agent for its own link", async () => {
    // `registerAgent` checks the link's owner, which is the ACCOUNT. The owner
    // KEY is not the owner — a distinction that only appears once the merchant
    // is a contract, and one an EOA fixture can never surface.
    const id = linkId();
    await runOp(
      executeCall(
        A.integrator as Address,
        encodeFunctionData({
          abi: MERCHANT_ABI,
          functionName: "createLink",
          args: [id, AMOUNT, INR, 0n, 1, "0x"],
        })
      )
    );

    // The owner key, acting for itself rather than through the account, is a
    // stranger to this link.
    const strangerAccount = await predictAccount(env, merchantKey.address);
    expect(strangerAccount).toBe(merchantAccount); // sanity: same derivation

    const { outcome } = await (async () => {
      const account = await createLinkWallet(env, id, 3600, (o) => predictAccount(env, o));
      // Registering from the merchant's account SUCCEEDS.
      const ok = await runOp(
        executeCall(
          A.router as Address,
          encodeFunctionData({
            abi: LINK_ROUTER_ABI,
            functionName: "registerAgent",
            args: [id, account],
          })
        )
      );
      return { outcome: ok };
    })();
    expect(outcome.success).toBe(true);
  }, 180_000);

  // ─── B1: the production path, with nothing stubbed ────────────────

  describe("provisioning through the real endpoint", () => {
    /**
     * This is the case round-3 B1 was about, driven the way production will.
     *
     * Every other test in this file mints the wallet by calling
     * `createLinkWallet` directly — which is exactly how the missing endpoint
     * went unnoticed: the tests supplied the one thing production never did. So
     * nothing is stubbed here. The merchant signs, the HTTP handler runs, and
     * the address it returns is the one batched on-chain.
     */
    /**
     * @param who the key that signs
     * @param as  the address the signature is checked AGAINST — the merchant's
     *            ACCOUNT, which is what is registered on-chain. Passing the
     *            owner key here instead is the bug this suite exists to catch.
     */
    async function provision(
      linkId: Hex,
      who = merchantKey,
      expiry?: number,
      as: Address = merchantAccount
    ) {
      const exp = expiry ?? Math.floor(Date.now() / 1000) + 120;
      const signature = await who.signTypedData({
        domain: {
          name: "P2P Merchant Terminal Admin",
          version: "1",
          chainId: A.chainId,
          verifyingContract: A.integrator as Address,
        },
        types: {
          LinkWallet: [
            { name: "linkId", type: "bytes32" },
            { name: "expiry", type: "uint256" },
          ],
        },
        primaryType: "LinkWallet",
        message: { linkId, expiry: BigInt(exp) },
      });

      return handleProvisionWallet(
        new Request(`https://w/api/links/${linkId}/wallet`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // `signer` is the ACCOUNT. The endpoint asks it, via ERC-1271,
          // whether this signature is its own.
          body: JSON.stringify({ signer: as, signature, expiry: exp }),
        }),
        env,
        linkId
      );
    }

    it("mints, batches and pays — with the endpoint doing the minting", async () => {
      const id = linkId();

      // 1. The merchant asks for a wallet. The link does not exist yet, which
      //    is the normal case: the address is needed to build the batch.
      const res = await provision(id);
      const body = (await res.json()) as any;
      expect(res.status, `provision failed: ${body.error}`).toBe(200);
      const account = body.account as Address;

      // The key the payment path will unwrap is now really there.
      expect(await linkSigner(env, id)).not.toBeNull();

      // 2. createLink BEFORE registerAgent, in one operation.
      const outcome = await runOp(
        encodeFunctionData({
          abi: BATCH_ABI,
          functionName: "executeBatch",
          args: [
            [A.integrator as Address, A.router as Address],
            [0n, 0n],
            [
              encodeFunctionData({
                abi: MERCHANT_ABI,
                functionName: "createLink",
                args: [id, AMOUNT, INR, 0n, 3, "0x"],
              }),
              encodeFunctionData({
                abi: LINK_ROUTER_ABI,
                functionName: "registerAgent",
                args: [id, account],
              }),
            ],
          ],
        })
      );
      expect(outcome.success).toBe(true);

      // The Router holds the address the ENDPOINT returned, not one a test
      // invented.
      expect(
        await pub.readContract({
          address: A.router as Address,
          abi: LINK_ROUTER_ABI,
          functionName: "linkAgent",
          args: [id],
        })
      ).toBe(account);

      // 3. A customer pays it.
      const pay = await handlePay(payReq("198.22.0.1"), env, id);
      const paid = (await pay.json()) as any;
      expect(pay.status, `pay failed: ${paid.error}`).toBe(200);
      expect(paid.orderId).toBeTruthy();
    }, 180_000);

    it("a retry returns the SAME address, so the batch stays valid", async () => {
      // registerAgent is write-once. A retry after a dropped response that
      // handed back a fresh address would strand the link permanently.
      const id = linkId();
      const first = (await (await provision(id)).json()) as any;
      const second = (await (await provision(id)).json()) as any;

      expect(second.account).toBe(first.account);
      expect(second.existing).toBe(true);
    }, 180_000);

    it("refuses a wallet that is not a registered merchant", async () => {
      const id = linkId();
      const strangerKey = privateKeyToAccount(keccak256(toHex(`${RUN}:stranger`)) as Hex);
      const strangerAccount = await predictAccount(env, strangerKey.address);
      expect((await provision(id, strangerKey, undefined, strangerAccount)).status).toBe(403);
      expect(await linkSigner(env, id)).toBeNull();
    }, 180_000);

    it("without provisioning, the link is unpayable — B1, reproduced", async () => {
      // The state a real deployment was in: a link created correctly, with no
      // wallet behind it, because nothing ever minted one.
      const id = linkId();
      await runOp(
        executeCall(
          A.integrator as Address,
          encodeFunctionData({
            abi: MERCHANT_ABI,
            functionName: "createLink",
            args: [id, AMOUNT, INR, 0n, 3, "0x"],
          })
        )
      );

      const res = await handlePay(payReq("198.22.0.2"), env, id);
      expect(res.status).toBeGreaterThanOrEqual(400);
      const body = (await res.json()) as any;
      expect(String(body.error)).toMatch(/no longer active|could not/i);
    }, 180_000);
  });
});
