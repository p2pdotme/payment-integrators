import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

/** Deploys PaymentLinksLib and returns its address, for linking. */
async function deployPaymentLinksLib(): Promise<string> {
  const Lib = await ethers.getContractFactory("PaymentLinksLib");
  const lib = await Lib.deploy();
  await lib.waitForDeployment();
  return await lib.getAddress();
}

/**
 * The relayer-removal design, end to end, through a REAL ERC-4337 EntryPoint.
 *
 * WHY THIS SUITE EXISTS SEPARATELY FROM LinkRouter.ts
 * `LinkRouter.ts` proves the Router's own rules by calling it from ordinary
 * signers. That is the right shape for the access-control claims, but it
 * quietly assumes the part the whole design rests on: that a wallet holding
 * NOTHING can send a transaction at all, because a sponsor pays for it.
 *
 * Assuming that would repeat the mistake that let the original `paidBuyOrder`
 * bug through — a mock that encoded our belief about a protocol rather than the
 * protocol. So this suite deploys the reference EntryPoint, factory and
 * paymaster and drives real user operations through them.
 *
 * WHAT MAPS TO WHAT IN PRODUCTION
 *   EntryPoint            → the same singleton already deployed on Base
 *   SimpleAccountFactory  → the account factory. Like thirdweb's, it derives
 *                           addresses with CREATE2 from a salt, so an address
 *                           is known before deployment and the account is
 *                           created lazily by `initCode` on first use.
 *   VerifyingPaymaster    → sponsorship gated by an OFF-CHAIN signer, which is
 *                           exactly how the provider's server verifier works:
 *                           our endpoint decides per operation, and only an
 *                           approved one is paid for.
 *   handleOps             → the bundler
 *
 * THE THREE CLAIMS THIS PROVES
 *   1. The link's wallet completes a payment while holding zero balance, at
 *      every point, before and after.
 *   2. The sponsor pays. The link wallet's balance never moves; the paymaster's
 *      deposit falls.
 *   3. An operation the sponsor refuses simply does not happen — which is what
 *      makes the per-link ceiling a real bound rather than a hopeful one.
 */
describe("LinkRouter — sponsored end to end, real EntryPoint", function () {
  let owner: SignerWithAddress;
  let merchant: SignerWithAddress;
  let bundler: SignerWithAddress;
  let sponsorSigner: SignerWithAddress; // stands in for our verifier endpoint
  let customer: SignerWithAddress;
  let attacker: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let integrator: any;
  let router: any;
  let erc721Client: any;

  let entryPoint: any;
  let factory: any;
  let paymaster: any;

  /** The link's signing key. Generated per link; holds nothing, ever. */
  let linkKey: any;
  let linkWallet: string; // its smart-account address

  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
  const UNIT_PRICE = USDC(10);
  const PRODUCT_ID = 1;
  const INR = ethers.encodeBytes32String("INR");
  const enc = (l: string) => ethers.keccak256(ethers.toUtf8Bytes("enc-payout:" + l));
  const PK = "04" + "ab".repeat(64);
  const CONFIG = ethers.hexlify(ethers.toUtf8Bytes("cfg"));

  let LINK: string;

  // ─── ERC-4337 plumbing ────────────────────────────────────────────

  /** v0.7 packs two uint128 gas fields into one bytes32. */
  const pack2 = (hi: bigint, lo: bigint) =>
    ethers.concat([
      ethers.zeroPadValue(ethers.toBeHex(hi), 16),
      ethers.zeroPadValue(ethers.toBeHex(lo), 16),
    ]);

  /**
   * Assembles, sponsors and sends one user operation — the bundler client, in
   * miniature.
   *
   * @param sponsor Whether our verifier approves. `false` signs with the wrong
   *        key, which is precisely what a refusal looks like on-chain.
   */
  async function sendUserOp(opts: {
    sender: string;
    callData: string;
    signer: any;
    initCode?: string;
    sponsor?: boolean;
  }) {
    const { sender, callData, signer } = opts;
    const initCode = opts.initCode ?? "0x";
    const sponsor = opts.sponsor ?? true;

    const nonce = await entryPoint.getNonce(sender, 0);
    const paymasterAddr = await paymaster.getAddress();

    const validUntil = 0; // no expiry, for the test
    const validAfter = 0;
    const timestamps = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint48", "uint48"],
      [validUntil, validAfter]
    );

    // paymasterAndData = paymaster | verificationGas | postOpGas | timestamps | sig
    const paymasterStub = ethers.concat([
      paymasterAddr,
      ethers.zeroPadValue(ethers.toBeHex(300_000n), 16),
      ethers.zeroPadValue(ethers.toBeHex(100_000n), 16),
      timestamps,
      "0x" + "00".repeat(65), // placeholder; not covered by getHash
    ]);

    const op = {
      sender,
      nonce,
      initCode,
      callData,
      accountGasLimits: pack2(900_000n, 900_000n),
      preVerificationGas: 200_000n,
      gasFees: pack2(2_000_000_000n, 2_000_000_000n),
      paymasterAndData: paymasterStub,
      signature: "0x" + "00".repeat(65),
    };

    // 1. Our verifier decides. Asking the paymaster for the hash rather than
    //    re-deriving it is what the real off-chain service does.
    const sponsorHash = await paymaster.getHash(op, validUntil, validAfter);
    const sponsorSig = await (sponsor ? sponsorSigner : attacker).signMessage(
      ethers.getBytes(sponsorHash)
    );
    op.paymasterAndData = ethers.concat([
      paymasterAddr,
      ethers.zeroPadValue(ethers.toBeHex(300_000n), 16),
      ethers.zeroPadValue(ethers.toBeHex(100_000n), 16),
      timestamps,
      sponsorSig,
    ]);

    // 2. The link's own key signs the operation.
    const userOpHash = await entryPoint.getUserOpHash(op);
    op.signature = await signer.signMessage(ethers.getBytes(userOpHash));

    const tx = await entryPoint.connect(bundler).handleOps([op], bundler.address);
    const receipt = await tx.wait();

    // CRITICAL, and easy to get wrong: handleOps does NOT revert when the
    // inner call fails. The EntryPoint catches it and reports the outcome in
    // UserOperationEvent.success, so the outer transaction succeeds either
    // way. Asserting `to.be.reverted` here would pass for a rejected
    // operation AND for one that never ran — the same shape of mistake as the
    // Diamond swallowing a failed callback.
    //
    // Production consequence: the backend must read this flag. A 200 from
    // the bundler does not mean the payment happened.
    let success: boolean | null = null;
    for (const log of receipt!.logs) {
      try {
        const parsed = entryPoint.interface.parseLog(log as any);
        if (parsed?.name === "UserOperationEvent") success = parsed.args.success;
      } catch {
        /* not an EntryPoint log */
      }
    }
    return { tx, receipt, success };
  }

  /** Sends an operation and asserts the inner call actually ran. */
  async function sendOk(opts: Parameters<typeof sendUserOp>[0]) {
    const r = await sendUserOp(opts);
    expect(r.success, "user operation was rejected on-chain").to.equal(true);
    return r;
  }

  /** Sends an operation and asserts the Router (or integrator) refused it. */
  async function sendRejected(opts: Parameters<typeof sendUserOp>[0]) {
    const r = await sendUserOp(opts);
    expect(r.success, "expected the operation to be refused").to.equal(false);
    return r;
  }

  const routerCall = (fn: string, args: any[]) => router.interface.encodeFunctionData(fn, args);

  /** SimpleAccount.execute(dest, value, func) — value is always zero here. */
  const execute = (target: string, data: string) =>
    new ethers.Interface([
      "function execute(address dest, uint256 value, bytes func)",
    ]).encodeFunctionData("execute", [target, 0, data]);

  async function sign712(
    action: "MarkPaid" | "Cancel",
    linkId: string,
    orderId: bigint,
    who: SignerWithAddress
  ) {
    return who.signTypedData(
      {
        name: "P2P LinkRouter",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await router.getAddress(),
      },
      {
        [action]: [
          { name: "linkId", type: "bytes32" },
          { name: "orderId", type: "uint256" },
        ],
      },
      { linkId, orderId }
    );
  }

  // ─── Setup ────────────────────────────────────────────────────────

  beforeEach(async function () {
    [owner, merchant, bundler, sponsorSigner, customer, attacker] = await ethers.getSigners();

    mockUsdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    mockDiamond = await (
      await ethers.getContractFactory("MockDiamond")
    ).deploy(await mockUsdc.getAddress());

    const Integrator = await ethers.getContractFactory("MerchantTerminalIntegrator", {
      libraries: { PaymentLinksLib: await deployPaymentLinksLib() },
    });
    integrator = await Integrator.deploy(
      await mockDiamond.getAddress(),
      await mockUsdc.getAddress(),
      []
    );

    erc721Client = await (
      await ethers.getContractFactory("SimpleERC721Client")
    ).deploy(await integrator.getAddress(), await mockUsdc.getAddress(), "Item", "ITEM");

    await mockDiamond.registerIntegrator(
      await integrator.getAddress(),
      await integrator.proxyImpl()
    );
    await erc721Client.setProductPrice(PRODUCT_ID, UNIT_PRICE);
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(100000));
    await integrator.connect(merchant).registerMerchant(enc("m"), "Ramesh Sarees", "INR");

    router = await (
      await ethers.getContractFactory("LinkRouter")
    ).deploy(await integrator.getAddress());
    await integrator.setTrustedRelayer(await router.getAddress());

    // ─── Account abstraction, the real thing ───
    entryPoint = await (await ethers.getContractFactory("EntryPoint")).deploy();
    factory = await (
      await ethers.getContractFactory("SimpleAccountFactory")
    ).deploy(await entryPoint.getAddress());
    paymaster = await (
      await ethers.getContractFactory("VerifyingPaymaster")
    ).deploy(await entryPoint.getAddress(), sponsorSigner.address);

    // The sponsor funds and stakes ITS OWN deposit. This is the money that pays
    // for every payment — note that none of it ever touches a link wallet.
    await paymaster.connect(owner).deposit({ value: ethers.parseEther("10") });
    await paymaster.connect(owner).addStake(1, { value: ethers.parseEther("1") });

    const lib = await ethers.getContractAt("PaymentLinksLib", await deployPaymentLinksLib());
    LINK = await lib.computeLinkId(merchant.address, ethers.id("salt-" + Date.now()));

    // A fresh key for this link, exactly as `createLinkWallet` does. Its
    // smart-account address is CALCULATED here — nothing is deployed yet.
    linkKey = ethers.Wallet.createRandom().connect(ethers.provider);
    linkWallet = await predictWallet(linkKey.address);
  });

  /**
   * The account address for an owner, before it exists.
   *
   * The explicit signature matters. Ethers gives every contract object its own
   * `getAddress()`, which silently shadows the Solidity
   * `getAddress(address,uint256)` and returns the FACTORY's address instead of
   * the account's. That reads as a perfectly plausible address and only fails
   * much later, as "sender already constructed".
   */
  const predictWallet = (owner: string, salt = 0n): Promise<string> =>
    factory["getAddress(address,uint256)"](owner, salt);

  const mkLink = (maxUses = 3) =>
    integrator.connect(merchant).createLink(LINK, UNIT_PRICE, INR, 0, maxUses, CONFIG);

  const registerAgent = () => router.connect(merchant).registerAgent(LINK, linkWallet);

  const initCodeForWallet = () =>
    ethers.concat([
      factory.target as string,
      factory.interface.encodeFunctionData("createAccount", [linkKey.address, 0n]),
    ]);

  const placeCall = () =>
    routerCall("place", [LINK, erc721Client.target, PRODUCT_ID, 1, INR, 0, PK, customer.address]);

  async function lastOrderId(): Promise<bigint> {
    const evs = await router.queryFilter(router.filters.OrderPlaced());
    return evs[evs.length - 1].args[1];
  }

  // ─── The whole thing ──────────────────────────────────────────────

  describe("a real sponsored payment", function () {
    it("completes with the link wallet holding nothing, at any point", async function () {
      await mkLink();
      await registerAgent();

      // Not deployed yet — the address was only computed.
      expect(await ethers.provider.getCode(linkWallet)).to.equal("0x");
      expect(await ethers.provider.getBalance(linkWallet)).to.equal(0);

      const sponsorBefore = await entryPoint.balanceOf(await paymaster.getAddress());

      // Rahul taps Proceed. The wallet is created and the order placed in one
      // operation, paid for by the sponsor.
      await sendOk({
        sender: linkWallet,
        initCode: initCodeForWallet(),
        callData: execute(await router.getAddress(), placeCall()),
        signer: linkKey,
      });

      expect(await ethers.provider.getCode(linkWallet)).to.not.equal("0x");
      // The claim the whole design rests on.
      expect(await ethers.provider.getBalance(linkWallet)).to.equal(0);
      expect(await entryPoint.balanceOf(linkWallet)).to.equal(0);
      // The sponsor paid, not the sender.
      expect(await entryPoint.balanceOf(await paymaster.getAddress())).to.be.lessThan(
        sponsorBefore
      );

      const orderId = await lastOrderId();
      await mockDiamond.simulateOrderAccepted(orderId);

      // Rahul taps "I have paid". His signature travels inside the call data;
      // the wallet's key alone could not do this.
      await sendOk({
        sender: linkWallet,
        callData: execute(
          await router.getAddress(),
          routerCall("markPaid", [
            LINK,
            orderId,
            await sign712("MarkPaid", LINK, orderId, customer),
          ])
        ),
        signer: linkKey,
      });
      expect((await mockDiamond.orders(orderId)).paid).to.equal(true);

      // The LP confirms real fiat and the Diamond completes.
      await mockDiamond.simulateOrderComplete(orderId);

      const m = await integrator.getMerchantBalance(merchant.address);
      expect(m.totalDeposited).to.equal(UNIT_PRICE);

      // Still holding nothing, after the whole payment.
      expect(await ethers.provider.getBalance(linkWallet)).to.equal(0);
      expect(await mockUsdc.balanceOf(linkWallet)).to.equal(0);
    });

    it("places the order as the MERCHANT, though the caller is an empty wallet", async function () {
      await mkLink();
      await registerAgent();
      await sendOk({
        sender: linkWallet,
        initCode: initCodeForWallet(),
        callData: execute(await router.getAddress(), placeCall()),
        signer: linkKey,
      });

      const stored = await mockDiamond.orders(await lastOrderId());
      expect(stored.user).to.equal(await integrator.proxyAddress(merchant.address));
      expect(stored.user).to.not.equal(linkWallet);
    });

    it("runs several payments on one link without a shared nonce anywhere", async function () {
      await mkLink(3);
      await registerAgent();

      await sendOk({
        sender: linkWallet,
        initCode: initCodeForWallet(),
        callData: execute(await router.getAddress(), placeCall()),
        signer: linkKey,
      });
      const first = await lastOrderId();
      await mockDiamond.simulateOrderAccepted(first);
      await sendOk({
        sender: linkWallet,
        callData: execute(
          await router.getAddress(),
          routerCall("markPaid", [LINK, first, await sign712("MarkPaid", LINK, first, customer)])
        ),
        signer: linkKey,
      });
      await mockDiamond.simulateOrderComplete(first);

      await sendOk({
        sender: linkWallet,
        callData: execute(await router.getAddress(), placeCall()),
        signer: linkKey,
      });
      const second = await lastOrderId();
      expect(second).to.not.equal(first);

      // Each link's wallet has its own 4337 nonce sequence, so nothing queues
      // behind another merchant's traffic — the head-of-line problem the single
      // relayer EOA had.
      expect(await entryPoint.getNonce(linkWallet, 0)).to.equal(3n);
    });
  });

  // ─── The sponsor is a real gate ───────────────────────────────────

  describe("sponsorship is what makes it possible, and what bounds it", function () {
    it("an operation our verifier refuses does not happen at all", async function () {
      await mkLink();
      await registerAgent();

      // A refusal, exactly as the on-chain paymaster sees one: the approval is
      // not signed by our verifier. This is what a per-link allowance running
      // out looks like.
      await expect(
        sendUserOp({
          sender: linkWallet,
          initCode: initCodeForWallet(),
          callData: execute(await router.getAddress(), placeCall()),
          signer: linkKey,
          sponsor: false,
        })
      ).to.be.reverted;

      // No order, and the link's use was not consumed.
      expect((await integrator.getLink(LINK)).uses).to.equal(0);
    });

    it("the link wallet cannot fall back to paying for itself — it has nothing", async function () {
      await mkLink();
      await registerAgent();
      // No deposit, no balance. Without a sponsor there is no other way for the
      // operation to be paid for, which is exactly why the wallet is safe to
      // leave empty and safe to lose.
      expect(await entryPoint.balanceOf(linkWallet)).to.equal(0);
      expect(await ethers.provider.getBalance(linkWallet)).to.equal(0);
    });
  });

  // ─── Compromise, through the real stack ───────────────────────────

  describe("a compromised backend, driving real operations", function () {
    it("can place, but cannot mark paid or cancel", async function () {
      await mkLink();
      await registerAgent();

      await sendOk({
        sender: linkWallet,
        initCode: initCodeForWallet(),
        callData: execute(await router.getAddress(), placeCall()),
        signer: linkKey,
      });
      const orderId = await lastOrderId();
      await mockDiamond.simulateOrderAccepted(orderId);

      // The attacker holds the link wallet key — everything our backend has.
      // What they do not have is the customer's browser key.
      await sendRejected({
        sender: linkWallet,
        callData: execute(
          await router.getAddress(),
          routerCall("markPaid", [
            LINK,
            orderId,
            await sign712("MarkPaid", LINK, orderId, attacker),
          ])
        ),
        signer: linkKey,
      });

      await sendRejected({
        sender: linkWallet,
        callData: execute(
          await router.getAddress(),
          routerCall("cancel", [LINK, orderId, await sign712("Cancel", LINK, orderId, attacker)])
        ),
        signer: linkKey,
      });

      expect((await mockDiamond.orders(orderId)).paid).to.equal(false);
      const m = await integrator.getMerchantBalance(merchant.address);
      expect(m.totalDeposited).to.equal(0);
    });

    it("cannot reach the merchant's money through the wallet's own execute", async function () {
      await mkLink();
      await registerAgent();
      await sendOk({
        sender: linkWallet,
        initCode: initCodeForWallet(),
        callData: execute(await router.getAddress(), placeCall()),
        signer: linkKey,
      });

      // A SimpleAccount can call anything its owner tells it to — so the safety
      // here is NOT that the wallet is restricted. It is that the wallet owns
      // nothing and is nobody: withdrawing needs the caller to BE the merchant.
      await sendRejected({
        sender: linkWallet,
        callData: execute(
          await integrator.getAddress(),
          integrator.interface.encodeFunctionData("withdrawUSDC", [USDC(1)])
        ),
        signer: linkKey,
      });

      // Nor can it redirect the merchant's payout details.
      await sendRejected({
        sender: linkWallet,
        callData: execute(
          await integrator.getAddress(),
          integrator.interface.encodeFunctionData("updateProfile", [
            enc("attacker-bank"),
            "hijacked",
          ])
        ),
        signer: linkKey,
      });

      const [encPayout] = await integrator.getMerchantInfo(merchant.address);
      expect(encPayout).to.equal(enc("m"));
    });

    it("a stolen wallet key is the wrong address for any other link", async function () {
      await mkLink();
      await registerAgent();

      // A second link, with its own wallet.
      const lib = await ethers.getContractAt("PaymentLinksLib", await deployPaymentLinksLib());
      const LINK2 = await lib.computeLinkId(merchant.address, ethers.id("salt2-" + Date.now()));
      const key2 = ethers.Wallet.createRandom();
      const wallet2 = await predictWallet(key2.address);
      await integrator.connect(merchant).createLink(LINK2, UNIT_PRICE, INR, 0, 1, CONFIG);
      await router.connect(merchant).registerAgent(LINK2, wallet2);

      // link 1's wallet, driving link 2. Rejected on the address, not on a list.
      await sendRejected({
        sender: linkWallet,
        initCode: initCodeForWallet(),
        callData: execute(
          await router.getAddress(),
          routerCall("place", [
            LINK2,
            erc721Client.target,
            PRODUCT_ID,
            1,
            INR,
            0,
            PK,
            customer.address,
          ])
        ),
        signer: linkKey,
      });

      expect((await integrator.getLink(LINK2)).uses).to.equal(0);
    });
  });

  // ─── The address is known before it exists ────────────────────────

  describe("addresses are deterministic, so nothing is deployed speculatively", function () {
    it("the merchant registers an address that does not exist yet", async function () {
      await mkLink();
      // registerAgent succeeds against an address with no code — which is what
      // lets a link nobody ever pays deploy nothing at all.
      expect(await ethers.provider.getCode(linkWallet)).to.equal("0x");
      await expect(registerAgent()).to.not.be.reverted;
      expect(await router.linkAgent(LINK)).to.equal(linkWallet);
      expect(await ethers.provider.getCode(linkWallet)).to.equal("0x");
    });

    it("the computed address is where the wallet actually lands", async function () {
      await mkLink();
      await registerAgent();
      await sendOk({
        sender: linkWallet,
        initCode: initCodeForWallet(),
        callData: execute(await router.getAddress(), placeCall()),
        signer: linkKey,
      });
      // If derivation and deployment disagreed, the Router's whole scoping
      // check would be pointing at the wrong address.
      expect(await ethers.provider.getCode(linkWallet)).to.not.equal("0x");
      const acct = await ethers.getContractAt("SimpleAccount", linkWallet);
      expect(await acct.owner()).to.equal(linkKey.address);
    });
  });
});
