import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time, impersonateAccount, setBalance } from "@nomicfoundation/hardhat-network-helpers";

const SOLANA_DOMAIN = 5;
const FINALITY_FAST = 1000;
const FINALITY_STANDARD = 2000;

/**
 * StocksIntegrator — stocks.me. Buy tokenized US equities (xStocks on Solana)
 * with local fiat. The Diamond settles USDC here; this contract burns it via
 * CCTP V2 to a FIXED treasury USDC account on Solana. An off-chain worker then
 * swaps that USDC into the chosen xStock and delivers it to the user's wallet.
 *
 * The two properties worth the most test ink:
 *
 *   1. `StockDeliveryRequested` carries everything the worker needs and is
 *      emitted even when the bridge leg fails — because on Base Sepolia it
 *      ALWAYS fails (the Diamond settles in a mock token Circle won't burn).
 *   2. The pooled reserve accounting holds: `balanceOf(this) >= unbridgedTotal`
 *      at all times, so one buyer's burn can never spend another's USDC and the
 *      owner sweep can never touch reserved funds.
 */
describe("StocksIntegrator", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let user2: SignerWithAddress;
  let stranger: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let tokenMessenger: any;
  let integrator: any;
  let integratorAddr: string;
  let usdcAddr: string;

  const USDC = (n: number | string) => ethers.parseUnits(n.toString(), 6);
  const INR = ethers.encodeBytes32String("INR");

  const TX_LIMIT = USDC(50);
  const DAILY_COUNT = 5;

  const AAPL = 1;
  const TSLA = 2;

  /** Our Solana treasury's USDC associated token account (32 raw bytes). */
  const TREASURY_ATA = "0x" + "7c".repeat(32);
  /** A user's Solana WALLET — the stock delivery target, not a token account. */
  const USER_WALLET = "0x" + "a7".repeat(32);
  const REF = ethers.keccak256(ethers.toUtf8Bytes("order-ref-1"));

  /** Place a buy; returns the Diamond order id. */
  async function buy(
    who: SignerWithAddress,
    amount: bigint,
    stockId = AAPL,
    ref = REF,
    wallet = USER_WALLET
  ) {
    const orderId = await mockDiamond.nextOrderId();
    await integrator.connect(who).userBuyStock(amount, stockId, INR, wallet, ref, 1, "", 0, 0);
    return orderId;
  }

  async function buyAndComplete(who: SignerWithAddress, amount: bigint, stockId = AAPL) {
    const orderId = await buy(who, amount, stockId);
    await mockDiamond.simulateOrderComplete(orderId);
    return orderId;
  }

  /**
   * A signer that IS the Diamond, for calling the IP2PIntegrator callbacks
   * directly. MockDiamond guards its own order state machine ("Already
   * cancelled", unknown order), so driving it cannot reach our contract with
   * the repeated / unknown calls the interface explicitly asks us to tolerate.
   * Those are OUR properties, so test them against OUR entrypoints.
   */
  async function asDiamond() {
    const addr = await mockDiamond.getAddress();
    await impersonateAccount(addr);
    await setBalance(addr, ethers.parseEther("1"));
    return await ethers.getSigner(addr);
  }

  async function deploy(reserveToken?: string) {
    const c = await (
      await ethers.getContractFactory("StocksIntegrator")
    ).deploy(
      await mockDiamond.getAddress(),
      usdcAddr,
      await tokenMessenger.getAddress(),
      reserveToken ?? usdcAddr,
      TREASURY_ATA,
      SOLANA_DOMAIN,
      TX_LIMIT,
      DAILY_COUNT
    );
    await mockDiamond.registerIntegrator(await c.getAddress(), await c.proxyImpl());
    await c.setStockEnabled(AAPL, true);
    await c.setStockEnabled(TSLA, true);
    return c;
  }

  beforeEach(async function () {
    [owner, user, user2, stranger] = await ethers.getSigners();

    mockUsdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    usdcAddr = await mockUsdc.getAddress();

    mockDiamond = await (await ethers.getContractFactory("MockDiamond")).deploy(usdcAddr);
    tokenMessenger = await (await ethers.getContractFactory("MockTokenMessengerV2")).deploy();

    integrator = await deploy();
    integratorAddr = await integrator.getAddress();

    // The Diamond needs USDC on hand to settle completed buys.
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(1_000_000));
    // Circle's TokenMinter registers USDC as burnable, with a per-tx limit.
    await tokenMessenger.setBurnLimitPerMessage(usdcAddr, USDC(1_000_000));
  });

  // ─── Configuration ──────────────────────────────────────────────────

  describe("configuration", function () {
    it("defaults to Fast Transfer with a fee budget, so Fast actually engages", async function () {
      // Both values are needed for Fast. Setting only the fee silently leaves
      // every burn on Standard — the footgun this default exists to remove.
      expect(await integrator.bridgeMinFinalityThreshold()).to.equal(FINALITY_FAST);
      expect(await integrator.bridgeMaxFeeBps()).to.be.greaterThan(0);
    });

    it("pins the treasury ATA as immutable", async function () {
      expect(await integrator.treasuryUsdcAta()).to.equal(TREASURY_ATA);
    });

    it("rejects a zero treasury ATA at deploy — an unmintable burn is permanent loss", async function () {
      await expect(
        (await ethers.getContractFactory("StocksIntegrator")).deploy(
          await mockDiamond.getAddress(),
          usdcAddr,
          await tokenMessenger.getAddress(),
          usdcAddr,
          ethers.ZeroHash,
          SOLANA_DOMAIN,
          TX_LIMIT,
          DAILY_COUNT
        )
      ).to.be.revertedWithCustomError(integrator, "InvalidSolanaRecipient");
    });

    it("holds owner limits under their immutable ceilings", async function () {
      await expect(integrator.setTxLimit(USDC(51))).to.be.revertedWithCustomError(
        integrator,
        "AboveCeiling"
      );
      await expect(integrator.setDailyTxCountLimit(11)).to.be.revertedWithCustomError(
        integrator,
        "AboveCeiling"
      );
      await expect(integrator.setBridgeMaxFeeBps(11)).to.be.revertedWithCustomError(
        integrator,
        "AboveCeiling"
      );
    });

    it("accepts only the two finality values CCTP defines", async function () {
      await integrator.setBridgeMinFinalityThreshold(FINALITY_STANDARD);
      expect(await integrator.bridgeMinFinalityThreshold()).to.equal(FINALITY_STANDARD);
      await expect(integrator.setBridgeMinFinalityThreshold(1500)).to.be.revertedWithCustomError(
        integrator,
        "InvalidFinalityThreshold"
      );
    });

    it("gates config on the owner", async function () {
      await expect(integrator.connect(stranger).setTxLimit(USDC(10))).to.be.revertedWithCustomError(
        integrator,
        "OnlyOwner"
      );
      await expect(
        integrator.connect(stranger).setStockEnabled(AAPL, false)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });
  });

  // ─── Placement ──────────────────────────────────────────────────────

  describe("placement", function () {
    it("pins the delivery instruction for the life of the order", async function () {
      const orderId = await buy(user, USDC(20), TSLA);
      const s = await integrator.getSession(orderId);
      expect(s.user).to.equal(user.address);
      expect(s.stockId).to.equal(TSLA);
      expect(s.amount).to.equal(USDC(20));
      expect(s.solanaWallet).to.equal(USER_WALLET);
      expect(s.ref).to.equal(REF);
      expect(s.fulfilled).to.equal(false);
    });

    it("rejects a stock that is not enabled", async function () {
      await expect(
        integrator.connect(user).userBuyStock(USDC(10), 99, INR, USER_WALLET, REF, 1, "", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "StockNotEnabled");
    });

    it("rejects a zero Solana wallet and a zero ref", async function () {
      await expect(
        integrator
          .connect(user)
          .userBuyStock(USDC(10), AAPL, INR, ethers.ZeroHash, REF, 1, "", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "InvalidSolanaRecipient");
      await expect(
        integrator
          .connect(user)
          .userBuyStock(USDC(10), AAPL, INR, USER_WALLET, ethers.ZeroHash, 1, "", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "InvalidRef");
    });

    it("enforces the per-tx limit", async function () {
      await expect(
        integrator.connect(user).userBuyStock(USDC(51), AAPL, INR, USER_WALLET, REF, 1, "", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "TxLimitExceeded");
    });

    it("enforces the daily count and reports what is left", async function () {
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(DAILY_COUNT);
      for (let i = 0; i < DAILY_COUNT; i++) {
        await buy(user, USDC(1), AAPL, ethers.keccak256(ethers.toUtf8Bytes(`ref-${i}`)));
      }
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(0);
      await expect(
        integrator.connect(user).userBuyStock(USDC(1), AAPL, INR, USER_WALLET, REF, 1, "", 0, 0)
      ).to.be.revertedWithCustomError(integrator, "DailyLimitExceeded");
    });
  });

  // ─── Completion + bridge ────────────────────────────────────────────

  describe("completion", function () {
    it("emits the delivery instruction and burns to the treasury ATA", async function () {
      const orderId = await buy(user, USDC(25));

      await expect(mockDiamond.simulateOrderComplete(orderId))
        .to.emit(integrator, "StockDeliveryRequested")
        .withArgs(orderId, REF, user.address, USER_WALLET, AAPL, USDC(25))
        .and.to.emit(tokenMessenger, "DepositForBurn");

      const s = await integrator.getSession(orderId);
      expect(s.fulfilled).to.equal(true);
      expect(s.bridged).to.equal(true);
      // Reservation released once burned; no USDC left stranded here.
      expect(await integrator.unbridgedTotal()).to.equal(0);
      expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(0);
    });

    it("burns to the FIXED treasury ATA, never the user's wallet", async function () {
      // A per-user ATA that may not exist is permanent loss on the Solana side.
      // The mintRecipient must always be the treasury account.
      const orderId = await buy(user, USDC(25));
      const tx = await mockDiamond.simulateOrderComplete(orderId);
      const receipt = await tx.wait();
      const burn = receipt.logs
        .map((l: any) => {
          try {
            return tokenMessenger.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((l: any) => l?.name === "DepositForBurn");

      expect(burn.args.mintRecipient).to.equal(TREASURY_ATA);
      expect(burn.args.mintRecipient).to.not.equal(USER_WALLET);
      expect(burn.args.destinationDomain).to.equal(SOLANA_DOMAIN);
      // bytes32(0) destinationCaller keeps receiveMessage permissionless, so
      // our worker (or anyone) can deliver the message on Solana.
      expect(burn.args.destinationCaller).to.equal(ethers.ZeroHash);
      expect(burn.args.minFinalityThreshold).to.equal(FINALITY_FAST);
    });

    it("is a no-op for an order it does not know", async function () {
      const diamond = await asDiamond();
      await expect(
        integrator.connect(diamond).onOrderComplete(999, user.address, USDC(10), integratorAddr)
      ).to.not.be.reverted;
      expect((await integrator.getSession(999)).user).to.equal(ethers.ZeroAddress);
      expect(await integrator.unbridgedTotal()).to.equal(0);
    });

    it("refuses to record a completion whose USDC went elsewhere", async function () {
      // recipientAddr is pinned at placement, so a mismatch means the money is
      // NOT here. Recording it would reserve funds that never arrived, letting
      // this order's burn spend another buyer's USDC.
      const orderId = await buy(user, USDC(10));
      const diamond = await asDiamond();
      await expect(
        integrator
          .connect(diamond)
          .onOrderComplete(orderId, user.address, USDC(10), stranger.address)
      ).to.be.revertedWithCustomError(integrator, "UnexpectedRecipient");
    });

    it("refuses to settle the same order twice", async function () {
      const orderId = await buyAndComplete(user, USDC(10));
      const diamond = await asDiamond();
      await expect(
        integrator.connect(diamond).onOrderComplete(orderId, user.address, USDC(10), integratorAddr)
      ).to.be.revertedWithCustomError(integrator, "OrderAlreadyFulfilled");
    });

    it("accepts the protocol callbacks only from the Diamond", async function () {
      const orderId = await buy(user, USDC(10));
      await expect(
        integrator
          .connect(stranger)
          .onOrderComplete(orderId, user.address, USDC(10), integratorAddr)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
      await expect(
        integrator.connect(stranger).onOrderCancel(orderId)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
      await expect(
        integrator.connect(stranger).validateOrder(user.address, USDC(10), INR)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
      // selfBridge is reachable only from the contract itself.
      await expect(integrator.connect(stranger).selfBridge(orderId)).to.be.revertedWithCustomError(
        integrator,
        "OnlySelf"
      );
    });
  });

  // ─── The Base Sepolia shape ─────────────────────────────────────────

  describe("bridge failure (the Base Sepolia case)", function () {
    beforeEach(async function () {
      // Circle's TokenMinter refuses the Base Sepolia settlement token:
      // burnLimitsPerMessage == 0 -> "Burn token not supported".
      await tokenMessenger.setBurnLimitPerMessage(usdcAddr, 0);
    });

    it("fails closed: the order still completes and the worker still gets its instruction", async function () {
      const orderId = await buy(user, USDC(30));

      await expect(mockDiamond.simulateOrderComplete(orderId))
        .to.emit(integrator, "StockDeliveryRequested")
        .and.to.emit(integrator, "BridgeFailed");

      const s = await integrator.getSession(orderId);
      expect(s.fulfilled).to.equal(true);
      expect(s.bridged).to.equal(false);
      // USDC is here and reserved, not stranded.
      expect(await integrator.unbridgedTotal()).to.equal(USDC(30));
      expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(USDC(30));
    });

    it("recovers via a permissionless retryBridge once the token is burnable", async function () {
      const orderId = await buy(user, USDC(30));
      await mockDiamond.simulateOrderComplete(orderId);

      await tokenMessenger.setBurnLimitPerMessage(usdcAddr, USDC(1_000_000));
      // Anyone may retry — it only moves the order forward along its pinned path.
      await expect(integrator.connect(stranger).retryBridge(orderId)).to.emit(
        tokenMessenger,
        "DepositForBurn"
      );

      expect((await integrator.getSession(orderId)).bridged).to.equal(true);
      expect(await integrator.unbridgedTotal()).to.equal(0);
    });

    it("refuses to bridge the same order twice", async function () {
      const orderId = await buy(user, USDC(30));
      await mockDiamond.simulateOrderComplete(orderId);
      await tokenMessenger.setBurnLimitPerMessage(usdcAddr, USDC(1_000_000));
      await integrator.retryBridge(orderId);

      await expect(integrator.retryBridge(orderId)).to.be.revertedWithCustomError(
        integrator,
        "AlreadyBridged"
      );
    });

    it("lets the buyer — and only the buyer — reclaim on Base after the delay", async function () {
      const orderId = await buy(user, USDC(30));
      await mockDiamond.simulateOrderComplete(orderId);

      await expect(
        integrator.connect(user).userRescueStuckBridge(orderId)
      ).to.be.revertedWithCustomError(integrator, "RescueTooEarly");

      await time.increase(7 * 24 * 3600 + 1);

      await expect(
        integrator.connect(stranger).userRescueStuckBridge(orderId)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");

      await expect(integrator.connect(user).userRescueStuckBridge(orderId)).to.changeTokenBalance(
        mockUsdc,
        user,
        USDC(30)
      );
      expect(await integrator.unbridgedTotal()).to.equal(0);
    });
  });

  // ─── Pooled-reserve accounting ──────────────────────────────────────

  describe("reserve accounting", function () {
    it("keeps the owner sweep off funds reserved for unbridged orders", async function () {
      await tokenMessenger.setBurnLimitPerMessage(usdcAddr, 0);
      await buyAndComplete(user, USDC(30));

      expect(await integrator.unbridgedTotal()).to.equal(USDC(30));
      await expect(integrator.withdrawUsdc(owner.address, USDC(1))).to.be.revertedWithCustomError(
        integrator,
        "InsufficientUnreserved"
      );

      // Surplus above the reservation is sweepable.
      await mockUsdc.mint(integratorAddr, USDC(5));
      await expect(integrator.withdrawUsdc(owner.address, USDC(5))).to.changeTokenBalance(
        mockUsdc,
        owner,
        USDC(5)
      );
    });

    it("never lets one buyer's burn spend another's reservation", async function () {
      await tokenMessenger.setBurnLimitPerMessage(usdcAddr, 0);
      await buyAndComplete(user, USDC(30));
      await buyAndComplete(user2, USDC(20));

      expect(await integrator.unbridgedTotal()).to.equal(USDC(50));
      expect(await mockUsdc.balanceOf(integratorAddr)).to.be.gte(await integrator.unbridgedTotal());
    });
  });

  // ─── Cancellation ───────────────────────────────────────────────────

  describe("cancellation", function () {
    it("releases the daily slot and tolerates a repeat call", async function () {
      const orderId = await buy(user, USDC(10));
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(DAILY_COUNT - 1);

      await mockDiamond.simulateOrderCancelled(orderId);
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(DAILY_COUNT);

      // IP2PIntegrator asks for this explicitly — must not revert, and must not
      // refund the slot a second time.
      const diamond = await asDiamond();
      await expect(integrator.connect(diamond).onOrderCancel(orderId)).to.not.be.reverted;
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(DAILY_COUNT);
    });

    it("tolerates a cancel for an order it does not know", async function () {
      const diamond = await asDiamond();
      await expect(integrator.connect(diamond).onOrderCancel(4242)).to.not.be.reverted;
    });

    it("does not refund the slot for an order that already settled", async function () {
      const orderId = await buyAndComplete(user, USDC(10));
      const before = await integrator.getRemainingDailyCount(user.address);
      const diamond = await asDiamond();
      await expect(integrator.connect(diamond).onOrderCancel(orderId)).to.not.be.reverted;
      expect(await integrator.getRemainingDailyCount(user.address)).to.equal(before);
    });

    it("still settles a cancel-then-complete rather than stranding the USDC", async function () {
      const orderId = await buy(user, USDC(10));
      await mockDiamond.simulateOrderCancelled(orderId);
      await mockDiamond.simulateOrderComplete(orderId);

      const s = await integrator.getSession(orderId);
      expect(s.fulfilled).to.equal(true);
      expect(s.cancelled).to.equal(true);
    });
  });

  // ─── Receipt mode (how testnet exercises the REAL CCTP path) ────────

  describe("receipt mode", function () {
    it("burns the pre-funded reserve when settlement and burn tokens differ", async function () {
      // On Base Sepolia the Diamond settles in a mock token Circle will not
      // burn. We hold real Circle testnet USDC as a reserve and burn that
      // instead, which makes the real CCTP path exercisable on testnet.
      const reserve = await (await ethers.getContractFactory("MockUSDC")).deploy();
      const reserveAddr = await reserve.getAddress();

      const c = await deploy(reserveAddr);
      expect(await c.receiptMode()).to.equal(true);

      await tokenMessenger.setBurnLimitPerMessage(reserveAddr, USDC(1_000_000));
      await reserve.mint(await c.getAddress(), USDC(100)); // pre-funded reserve

      const orderId = await mockDiamond.nextOrderId();
      await c.connect(user).userBuyStock(USDC(25), AAPL, INR, USER_WALLET, REF, 1, "", 0, 0);
      await mockDiamond.simulateOrderComplete(orderId);

      expect((await c.getSession(orderId)).bridged).to.equal(true);
      // The RESERVE was burned, not the settlement token.
      expect(await reserve.balanceOf(await c.getAddress())).to.equal(USDC(75));
    });

    it("reports receiptMode false when the tokens match", async function () {
      expect(await integrator.receiptMode()).to.equal(false);
    });
  });
});
