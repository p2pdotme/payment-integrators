import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const STATUS = { PLACED: 0, ACCEPTED: 1, PAID: 2, COMPLETED: 3, CANCELLED: 4 };

describe("TradeStarsCheckoutIntegrator — offramp via RestrictedYieldVault", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let relayer: SignerWithAddress;
  let stranger: SignerWithAddress;

  let usdc: any;
  let aUsdc: any;
  let aave: any;
  let vault: any;
  let mockDiamond: any;
  let integrator: any;

  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
  const BASE_TX_LIMIT = USDC(50);
  const DAILY_COUNT_LIMIT = 10;
  const INR = ethers.encodeBytes32String("INR");

  beforeEach(async function () {
    [owner, user, relayer, stranger] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();
    aUsdc = await MockUSDC.deploy();

    const MockAavePool = await ethers.getContractFactory("MockAavePool");
    aave = await MockAavePool.deploy();
    await aave.configure(await usdc.getAddress(), await aUsdc.getAddress());

    const Vault = await ethers.getContractFactory("RestrictedYieldVault");
    vault = await Vault.deploy(
      await usdc.getAddress(),
      await aUsdc.getAddress(),
      await aave.getAddress()
    );

    const MockDiamond = await ethers.getContractFactory("MockDiamond");
    mockDiamond = await MockDiamond.deploy(await usdc.getAddress());

    const Integrator = await ethers.getContractFactory("TradeStarsCheckoutIntegrator");
    integrator = await Integrator.deploy(
      await mockDiamond.getAddress(),
      await usdc.getAddress(),
      BASE_TX_LIMIT,
      DAILY_COUNT_LIMIT
    );

    await mockDiamond.registerIntegrator(
      await integrator.getAddress(),
      await integrator.proxyImpl()
    );

    // Wire vault → integrator + integrator → vault.
    await integrator.setYieldVault(await vault.getAddress());
    await vault.setOfframpOperator(await integrator.getAddress());
    await integrator.setOfframpEnabled(true);
    await integrator.setOfframpRelayer(relayer.address);
    await integrator.setMaxUsdcPerOfframp(USDC(50));

    // Seed the vault: 100 USDC of principal (100% available for offramp).
    await usdc.mint(owner.address, USDC(100));
    await usdc.connect(owner).approve(await vault.getAddress(), USDC(100));
    await vault.connect(owner).deposit(USDC(100));

    // Fund MockDiamond so it can pay refunds on cancel.
    await usdc.mint(await mockDiamond.getAddress(), USDC(1000));
  });

  describe("Buy completion deposits USDC into the vault", function () {
    it("on completion the integrator routes USDC to vault and increments principal", async function () {
      // User places a buy via the existing tradestars integrator path.
      const solanaPubkey = "0x" + "11".repeat(32);
      await integrator
        .connect(user)
        .userPlaceOrder(solanaPubkey, USDC(20), INR, 1, "userPubKey", 0, 0);
      const principalBefore = await vault.totalPrincipal();
      await mockDiamond.simulateOrderComplete(1n);
      const principalAfter = await vault.totalPrincipal();
      expect(principalAfter - principalBefore).to.equal(USDC(20));
    });
  });

  describe("Solana-burn → SELL placement (relayer-driven)", function () {
    it("places a sell order, pulls USDC from vault, dedupes the burn tx", async function () {
      const burnTx = "0x" + "ab".repeat(32);
      const solanaPubkey = "0x" + "cd".repeat(32);

      const integratorBalBefore = await usdc.balanceOf(await integrator.getAddress());
      const offrampWithdrawnBefore = await vault.offrampWithdrawn();

      const tx = await integrator
        .connect(relayer)
        .placeSellOrderForBurn(
          burnTx,
          solanaPubkey,
          USDC(20),
          INR,
          USDC(1600),
          1n,
          0n,
          "userPubKey"
        );
      const rcpt = await tx.wait();
      const initEv = rcpt.logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p: any) => p?.name === "OfframpInitiated");
      const sellOrderId = initEv.args.orderId as bigint;

      // Vault accounting
      expect(await vault.offrampWithdrawn()).to.equal(offrampWithdrawnBefore + USDC(20));
      // Integrator now holds the USDC pulled from vault (the system proxy gets
      // funded just-in-time at deliverOfframpUpi).
      expect(await usdc.balanceOf(await integrator.getAddress())).to.equal(
        integratorBalBefore + USDC(20)
      );
      // Diamond sees the integrator's system proxy as order.user (Solana users
      // have no Base identity; the system proxy stands in for the integrator).
      const so = await mockDiamond.getSellOrder(sellOrderId);
      expect(so.user).to.equal(await integrator.systemProxy());
      expect(so.amount).to.equal(USDC(20));
      expect(so.status).to.equal(STATUS.PLACED);
      // Dedupe map populated
      expect(await integrator.solanaBurnToOrderId(burnTx)).to.equal(sellOrderId);

      // Re-attempting with same burnTx is rejected
      await expect(
        integrator
          .connect(relayer)
          .placeSellOrderForBurn(
            burnTx,
            solanaPubkey,
            USDC(20),
            INR,
            USDC(1600),
            1n,
            0n,
            "userPubKey"
          )
      ).to.be.revertedWithCustomError(integrator, "BurnAlreadyProcessed");
    });

    it("relayer drives accept → deliverOfframpUpi → complete; USDC ends up at Diamond", async function () {
      const burnTx = "0x" + "ab".repeat(32);
      const solanaPubkey = "0x" + "cd".repeat(32);

      const tx = await integrator
        .connect(relayer)
        .placeSellOrderForBurn(
          burnTx,
          solanaPubkey,
          USDC(20),
          INR,
          USDC(1600),
          1n,
          0n,
          "userPubKey"
        );
      const sellOrderId = (await tx.wait()).logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p: any) => p?.name === "OfframpInitiated").args.orderId as bigint;

      await mockDiamond.acceptSellOrder(sellOrderId, "merchantPubKey");
      const integratorBalBefore = await usdc.balanceOf(await integrator.getAddress());

      await integrator.connect(relayer).deliverOfframpUpi(sellOrderId, "encUpiCiphertext");

      const integratorBalAfter = await usdc.balanceOf(await integrator.getAddress());
      // Diamond pulled the 20 USDC from integrator
      expect(integratorBalBefore - integratorBalAfter).to.equal(USDC(20));
      const so = await mockDiamond.getSellOrder(sellOrderId);
      expect(so.status).to.equal(STATUS.PAID);

      await mockDiamond.completeSellOrder(sellOrderId);
      await integrator.reconcile(sellOrderId);
      const r = await integrator.offramps(sellOrderId);
      expect(r.lastStatus).to.equal(STATUS.COMPLETED);
    });

    it("on cancel-while-PAID, USDC is returned to the vault", async function () {
      const burnTx = "0x" + "ab".repeat(32);

      const tx = await integrator
        .connect(relayer)
        .placeSellOrderForBurn(
          burnTx,
          "0x" + "cd".repeat(32),
          USDC(20),
          INR,
          USDC(1600),
          1n,
          0n,
          "userPubKey"
        );
      const sellOrderId = (await tx.wait()).logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p: any) => p?.name === "OfframpInitiated").args.orderId as bigint;

      await mockDiamond.acceptSellOrder(sellOrderId, "mp");
      await integrator.connect(relayer).deliverOfframpUpi(sellOrderId, "encUpi");

      const offrampBefore = await vault.offrampWithdrawn();
      // Diamond cancels (timeout / dispute) and refunds USDC to integrator.
      await mockDiamond.cancelSellOrder(sellOrderId);
      // Reconcile pushes the refunded USDC back into the vault.
      const reconcileTx = await integrator.reconcile(sellOrderId);
      const recEv = (await reconcileTx.wait()).logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p: any) => p?.name === "OfframpReconciled");
      expect(recEv.args.usdcReturnedToVault).to.equal(USDC(20));

      // offrampWithdrawn decremented; integrator's USDC balance back to its prior float
      expect(await vault.offrampWithdrawn()).to.equal(offrampBefore - USDC(20));
    });
  });

  describe("Vault quotas", function () {
    it("releaseForOfframp is bounded by live balance, not cumulative onramp", async function () {
      // total principal = 100, balance = 100.
      // Try to pull 70 with 50 max per tx — should revert on per-tx cap.
      await expect(
        integrator
          .connect(relayer)
          .placeSellOrderForBurn(
            "0x" + "11".repeat(32),
            "0x" + "22".repeat(32),
            USDC(70),
            INR,
            USDC(5600),
            1n,
            0n,
            ""
          )
      ).to.be.revertedWithCustomError(integrator, "OfframpAmountTooLarge");

      // Bump per-tx cap so we can test the vault's quota.
      await integrator.setMaxUsdcPerOfframp(USDC(1000));

      // 70 USDC succeeds (balance 100 → 30).
      await integrator
        .connect(relayer)
        .placeSellOrderForBurn(
          "0x" + "11".repeat(32),
          "0x" + "22".repeat(32),
          USDC(70),
          INR,
          USDC(5600),
          1n,
          0n,
          ""
        );

      // Only 30 USDC left in the vault; pulling 40 reverts InsufficientFunds
      // — the bound is live balance, not a totalPrincipal quota.
      await expect(
        integrator
          .connect(relayer)
          .placeSellOrderForBurn(
            "0x" + "33".repeat(32),
            "0x" + "44".repeat(32),
            USDC(40),
            INR,
            USDC(3200),
            1n,
            0n,
            ""
          )
      ).to.be.revertedWithCustomError(vault, "InsufficientFunds");
    });

    it("ownerWithdraw can pull 40% of principal + accrued yield", async function () {
      // Simulate yield by minting extra aUSDC + funding the pool's USDC.
      await usdc.mint(await aave.getAddress(), USDC(5));
      await aave.accrueYield(
        await aUsdc.getAddress(),
        await vault.getAddress(),
        USDC(5),
        await usdc.getAddress()
      );

      const ownerBalBefore = await usdc.balanceOf(owner.address);
      // Quota = 40% × 100 + 5 = 45 USDC. Pull all of it.
      await vault.connect(owner).ownerWithdraw(USDC(45));
      const ownerBalAfter = await usdc.balanceOf(owner.address);
      expect(ownerBalAfter - ownerBalBefore).to.equal(USDC(45));

      // Beyond quota reverts
      await expect(vault.connect(owner).ownerWithdraw(USDC(1))).to.be.revertedWithCustomError(
        vault,
        "ExceedsOwnerQuota"
      );
    });

    it("ownerWithdraw reverts InsufficientFunds when the operator has drained the pool", async function () {
      // Drain the vault via offramp. Bump per-tx cap so two relayer calls
      // can pull the full 100 USDC of principal.
      await integrator.setMaxUsdcPerOfframp(USDC(1000));
      await integrator
        .connect(relayer)
        .placeSellOrderForBurn(
          "0x" + "aa".repeat(32),
          "0x" + "bb".repeat(32),
          USDC(100),
          INR,
          USDC(8000),
          1n,
          0n,
          ""
        );

      // Sanity: pool drained.
      expect(await aUsdc.balanceOf(await vault.getAddress())).to.equal(0n);

      // Owner's theoretical quota is still 40% of totalPrincipal=100 = 40,
      // but the actual balance is 0. Pre-fix this hit Aave with an opaque
      // low-level revert; post-fix it surfaces InsufficientFunds.
      await expect(vault.connect(owner).ownerWithdraw(USDC(1))).to.be.revertedWithCustomError(
        vault,
        "InsufficientFunds"
      );

      // Above-quota amounts still revert ExceedsOwnerQuota first — the
      // quota check runs before the balance check.
      await expect(vault.connect(owner).ownerWithdraw(USDC(41))).to.be.revertedWithCustomError(
        vault,
        "ExceedsOwnerQuota"
      );
    });

    it("releaseForOfframp reverts InsufficientFunds when owner has drained their share", async function () {
      // Owner pulls their full 40%. Vault balance now = 60.
      await vault.connect(owner).ownerWithdraw(USDC(40));
      expect(await aUsdc.balanceOf(await vault.getAddress())).to.equal(USDC(60));

      // Impersonate the integrator (operator) and ask for 80 — exceeds the
      // live balance of 60, so it should revert InsufficientFunds rather
      // than fall through to an Aave low-level error.
      const integratorAddr = await integrator.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [integratorAddr]);
      await ethers.provider.send("hardhat_setBalance", [integratorAddr, "0x1000000000000000000"]);
      const integratorSigner = await ethers.getSigner(integratorAddr);
      await expect(
        vault.connect(integratorSigner).releaseForOfframp(USDC(80))
      ).to.be.revertedWithCustomError(vault, "InsufficientFunds");

      // Asking exactly at the balance still works — the bound is the live
      // balance, and the check is `amount > balance` (not strictly <).
      await vault.connect(integratorSigner).releaseForOfframp(USDC(60));
      expect(await aUsdc.balanceOf(await vault.getAddress())).to.equal(0n);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [integratorAddr]);
    });

    it("offrampQuota and ownerQuota views reflect actual balance, not just bookkeeping", async function () {
      // Pre-drain sanity.
      expect(await vault.offrampQuota()).to.equal(USDC(100));
      expect(await vault.ownerQuota()).to.equal(USDC(40));

      // Owner pulls 40. Operator's view should drop to balance (60), not
      // stay at totalPrincipal - offrampWithdrawn = 100. Owner's view
      // should drop to 0 (cap consumed).
      await vault.connect(owner).ownerWithdraw(USDC(40));
      expect(await vault.offrampQuota()).to.equal(USDC(60));
      expect(await vault.ownerQuota()).to.equal(0n);
    });
  });

  describe("P2P fee accrual (configurable per-leg rates, accounting only)", function () {
    // default 2.5% on each leg. 2.5% of 100 = 2.5; of 20 = 0.5
    const PCT = (n: bigint, bps: bigint = 250n) => (n * bps) / 10000n;

    it("default rates are 2.5% on each leg", async function () {
      expect(await vault.p2pOnrampBps()).to.equal(250n);
      expect(await vault.p2pOfframpBps()).to.equal(250n);
    });

    it("deposit credits the onramp ledger by p2pOnrampBps of the amount", async function () {
      // beforeEach already deposited 100 USDC → 2.5 onramp fee.
      expect(await vault.p2pOnrampAccrued()).to.equal(PCT(USDC(100)));
      expect(await vault.p2pOfframpAccrued()).to.equal(0n);
      await usdc.mint(owner.address, USDC(20));
      await usdc.connect(owner).approve(await vault.getAddress(), USDC(20));
      await vault.connect(owner).deposit(USDC(20));
      expect(await vault.p2pOnrampAccrued()).to.equal(PCT(USDC(100)) + PCT(USDC(20)));
    });

    it("deposit emits P2PFeeAccrued(volume, fee, isCredit=true, isOfframp=false)", async function () {
      await usdc.mint(owner.address, USDC(20));
      await usdc.connect(owner).approve(await vault.getAddress(), USDC(20));
      await expect(vault.connect(owner).deposit(USDC(20)))
        .to.emit(vault, "P2PFeeAccrued")
        .withArgs(USDC(20), PCT(USDC(20)), true, false);
    });

    it("releaseForOfframp credits the offramp ledger by p2pOfframpBps of release", async function () {
      const before = await vault.p2pOfframpAccrued();
      await integrator
        .connect(relayer)
        .placeSellOrderForBurn(
          "0x" + "ab".repeat(32),
          "0x" + "cd".repeat(32),
          USDC(20),
          INR,
          USDC(1600),
          1n,
          0n,
          ""
        );
      expect(await vault.p2pOfframpAccrued()).to.equal(before + PCT(USDC(20)));
      // onramp ledger untouched by an offramp.
      expect(await vault.p2pOnrampAccrued()).to.equal(PCT(USDC(100)));
    });

    it("p2pAccrued() returns the sum of both ledgers", async function () {
      await integrator
        .connect(relayer)
        .placeSellOrderForBurn(
          "0x" + "ab".repeat(32),
          "0x" + "cd".repeat(32),
          USDC(20),
          INR,
          USDC(1600),
          1n,
          0n,
          ""
        );
      expect(await vault.p2pAccrued()).to.equal(
        (await vault.p2pOnrampAccrued()) + (await vault.p2pOfframpAccrued())
      );
      expect(await vault.p2pAccrued()).to.equal(PCT(USDC(100)) + PCT(USDC(20)));
    });

    it("returnFromOfframp on cancel reverses only the offramp ledger (net of cancels)", async function () {
      const onrampBefore = await vault.p2pOnrampAccrued();
      const offrampBefore = await vault.p2pOfframpAccrued();
      const burnTx = "0x" + "ab".repeat(32);
      const txPlace = await integrator
        .connect(relayer)
        .placeSellOrderForBurn(
          burnTx,
          "0x" + "cd".repeat(32),
          USDC(20),
          INR,
          USDC(1600),
          1n,
          0n,
          ""
        );
      const sellOrderId = (await txPlace.wait()).logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p: any) => p?.name === "OfframpInitiated").args.orderId as bigint;
      await mockDiamond.acceptSellOrder(sellOrderId, "merchantPubKey");
      await integrator.connect(relayer).deliverOfframpUpi(sellOrderId, "enc");
      expect(await vault.p2pOfframpAccrued()).to.equal(offrampBefore + PCT(USDC(20)));
      // Cancel + reconcile → 20 USDC returns, offramp fee reversed.
      await mockDiamond.cancelSellOrder(sellOrderId);
      await expect(integrator.reconcile(sellOrderId))
        .to.emit(vault, "P2PFeeAccrued")
        .withArgs(USDC(20), PCT(USDC(20)), false, true);
      expect(await vault.p2pOfframpAccrued()).to.equal(offrampBefore);
      // onramp ledger never moved.
      expect(await vault.p2pOnrampAccrued()).to.equal(onrampBefore);
    });

    it("owner can set independent onramp/offramp rates", async function () {
      await expect(vault.connect(owner).setP2PFeeBps(100, 500)) // 1% onramp, 5% offramp
        .to.emit(vault, "P2PFeeBpsUpdated")
        .withArgs(100n, 500n);
      expect(await vault.p2pOnrampBps()).to.equal(100n);
      expect(await vault.p2pOfframpBps()).to.equal(500n);

      // New deposit accrues at 1%.
      await usdc.mint(owner.address, USDC(100));
      await usdc.connect(owner).approve(await vault.getAddress(), USDC(100));
      const onrampBefore = await vault.p2pOnrampAccrued();
      await vault.connect(owner).deposit(USDC(100));
      expect(await vault.p2pOnrampAccrued()).to.equal(onrampBefore + PCT(USDC(100), 100n));

      // New release accrues at 5%.
      const offrampBefore = await vault.p2pOfframpAccrued();
      await integrator
        .connect(relayer)
        .placeSellOrderForBurn(
          "0x" + "ef".repeat(32),
          "0x" + "cd".repeat(32),
          USDC(40),
          INR,
          USDC(3200),
          1n,
          0n,
          ""
        );
      expect(await vault.p2pOfframpAccrued()).to.equal(offrampBefore + PCT(USDC(40), 500n));
    });

    it("setP2PFeeBps is owner-only", async function () {
      await expect(vault.connect(stranger).setP2PFeeBps(100, 100)).to.be.revertedWithCustomError(
        vault,
        "OnlyOwner"
      );
    });

    it("setP2PFeeBps reverts InvalidFeeBps above MAX_P2P_BPS", async function () {
      const max = await vault.MAX_P2P_BPS();
      await expect(vault.connect(owner).setP2PFeeBps(max + 1n, 0)).to.be.revertedWithCustomError(
        vault,
        "InvalidFeeBps"
      );
      await expect(vault.connect(owner).setP2PFeeBps(0, max + 1n)).to.be.revertedWithCustomError(
        vault,
        "InvalidFeeBps"
      );
      // Exactly at the cap is allowed.
      await vault.connect(owner).setP2PFeeBps(max, max);
      expect(await vault.p2pOfframpBps()).to.equal(max);
    });

    it("rate of 0 accrues nothing (ledger unchanged)", async function () {
      await vault.connect(owner).setP2PFeeBps(0, 0);
      const onrampBefore = await vault.p2pOnrampAccrued();
      await usdc.mint(owner.address, USDC(50));
      await usdc.connect(owner).approve(await vault.getAddress(), USDC(50));
      await vault.connect(owner).deposit(USDC(50));
      expect(await vault.p2pOnrampAccrued()).to.equal(onrampBefore);
    });

    it("the fee ledgers do NOT reduce the owner's 40% bucket", async function () {
      // 100 USDC principal → owner quota = 40, independent of the accrued fee.
      expect(await vault.p2pAccrued()).to.equal(PCT(USDC(100)));
      expect(await vault.ownerQuota()).to.equal(USDC(40));
      await vault.connect(owner).ownerWithdraw(USDC(40));
      expect(await vault.ownerQuota()).to.equal(0n);
      // Owner withdrawal left the fee ledgers untouched.
      expect(await vault.p2pAccrued()).to.equal(PCT(USDC(100)));
    });

    it("exposes no on-chain payout path for the P2P fee (accounting only)", async function () {
      const hasFn = (name: string) =>
        vault.interface.fragments.some((f: any) => f.type === "function" && f.name === name);
      expect(hasFn("p2pWithdraw")).to.equal(false);
      expect(hasFn("p2pAvailable")).to.equal(false);
      expect(hasFn("p2pBeneficiary")).to.equal(false);
      expect(hasFn("setP2PBeneficiary")).to.equal(false);
      expect(hasFn("p2pWithdrawn")).to.equal(false);
      // Ledger getters + rate setter present.
      expect(hasFn("p2pAccrued")).to.equal(true);
      expect(hasFn("p2pOnrampAccrued")).to.equal(true);
      expect(hasFn("p2pOfframpAccrued")).to.equal(true);
      expect(hasFn("setP2PFeeBps")).to.equal(true);
    });
  });

  describe("Access control", function () {
    it("only relayer can placeSellOrderForBurn / deliverOfframpUpi", async function () {
      await expect(
        integrator
          .connect(stranger)
          .placeSellOrderForBurn(
            "0x" + "11".repeat(32),
            "0x" + "22".repeat(32),
            USDC(10),
            INR,
            USDC(800),
            1n,
            0n,
            ""
          )
      ).to.be.revertedWithCustomError(integrator, "OnlyOfframpRelayer");

      await expect(
        integrator.connect(stranger).deliverOfframpUpi(1n, "x")
      ).to.be.revertedWithCustomError(integrator, "OnlyOfframpRelayer");
    });

    it("offrampDisabled blocks placeSellOrderForBurn", async function () {
      await integrator.setOfframpEnabled(false);
      await expect(
        integrator
          .connect(relayer)
          .placeSellOrderForBurn(
            "0x" + "11".repeat(32),
            "0x" + "22".repeat(32),
            USDC(10),
            INR,
            USDC(800),
            1n,
            0n,
            ""
          )
      ).to.be.revertedWithCustomError(integrator, "OfframpDisabled");
    });

    it("only operator can release / return on the vault", async function () {
      await expect(
        vault.connect(stranger).releaseForOfframp(USDC(1))
      ).to.be.revertedWithCustomError(vault, "OnlyOperator");
      await expect(
        vault.connect(stranger).returnFromOfframp(USDC(1))
      ).to.be.revertedWithCustomError(vault, "OnlyOperator");
    });
  });

  describe("Branch coverage — RestrictedYieldVault zero-amount + quota + admin reverts", function () {
    it("deposit reverts InvalidAmount on zero", async function () {
      await expect(vault.connect(owner).deposit(0)).to.be.revertedWithCustomError(
        vault,
        "InvalidAmount"
      );
    });

    it("ownerWithdraw reverts InvalidAmount on zero", async function () {
      await expect(vault.connect(owner).ownerWithdraw(0)).to.be.revertedWithCustomError(
        vault,
        "InvalidAmount"
      );
    });

    it("ownerWithdraw reverts ExceedsOwnerQuota when amount > 40% of principal", async function () {
      // principal seeded to 100 USDC; 40% cap = 40 USDC; 41 USDC exceeds.
      await expect(vault.connect(owner).ownerWithdraw(USDC(41))).to.be.revertedWithCustomError(
        vault,
        "ExceedsOwnerQuota"
      );
    });

    it("releaseForOfframp reverts InvalidAmount on zero", async function () {
      // Impersonate the integrator (operator) for a direct call.
      const integratorAddr = await integrator.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [integratorAddr]);
      await ethers.provider.send("hardhat_setBalance", [integratorAddr, "0x1000000000000000000"]);
      const integratorSigner = await ethers.getSigner(integratorAddr);
      await expect(
        vault.connect(integratorSigner).releaseForOfframp(0)
      ).to.be.revertedWithCustomError(vault, "InvalidAmount");
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [integratorAddr]);
    });

    it("releaseForOfframp reverts InsufficientFunds when above the live balance", async function () {
      const integratorAddr = await integrator.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [integratorAddr]);
      await ethers.provider.send("hardhat_setBalance", [integratorAddr, "0x1000000000000000000"]);
      const integratorSigner = await ethers.getSigner(integratorAddr);
      // balance = 100 USDC; 101 exceeds it (no cumulative cap any more).
      await expect(
        vault.connect(integratorSigner).releaseForOfframp(USDC(101))
      ).to.be.revertedWithCustomError(vault, "InsufficientFunds");
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [integratorAddr]);
    });

    it("returnFromOfframp reverts InvalidAmount on zero", async function () {
      const integratorAddr = await integrator.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [integratorAddr]);
      await ethers.provider.send("hardhat_setBalance", [integratorAddr, "0x1000000000000000000"]);
      const integratorSigner = await ethers.getSigner(integratorAddr);
      await expect(
        vault.connect(integratorSigner).returnFromOfframp(0)
      ).to.be.revertedWithCustomError(vault, "InvalidAmount");
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [integratorAddr]);
    });

    it("setOfframpOperator non-owner reverts", async function () {
      await expect(
        vault.connect(stranger).setOfframpOperator(stranger.address)
      ).to.be.revertedWithCustomError(vault, "OnlyOwner");
    });

    it("setOfframpOperator reverts InvalidAddress on zero", async function () {
      await expect(
        vault.connect(owner).setOfframpOperator(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(vault, "InvalidAddress");
    });

    it("transferOwnership reverts InvalidAddress on zero", async function () {
      await expect(
        vault.connect(owner).transferOwnership(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(vault, "InvalidAddress");
    });

    it("ownerWithdraw non-owner reverts", async function () {
      await expect(vault.connect(stranger).ownerWithdraw(USDC(1))).to.be.revertedWithCustomError(
        vault,
        "OnlyOwner"
      );
    });

    it("getYield returns 0 when aUSDC balance == principal", async function () {
      expect(await vault.getYield()).to.equal(0);
    });

    it("ownerQuota tracks ownerWithdrawnPrincipal", async function () {
      expect(await vault.ownerQuota()).to.equal(USDC(40));
      await vault.connect(owner).ownerWithdraw(USDC(10));
      expect(await vault.ownerQuota()).to.equal(USDC(30));
    });

    it("transferOwnership is 2-step: propose then accept", async function () {
      // Step 1: current owner nominates — owner unchanged, pending set
      await vault.connect(owner).transferOwnership(stranger.address);
      expect(await vault.owner()).to.equal(owner.address);
      expect(await vault.pendingOwner()).to.equal(stranger.address);

      // Step 2: only the nominee can complete the transfer
      await expect(vault.connect(owner).acceptOwnership()).to.be.revertedWithCustomError(
        vault,
        "OnlyPendingOwner"
      );

      // Step 3: nominee accepts → owner rotates, pending clears
      await vault.connect(stranger).acceptOwnership();
      expect(await vault.owner()).to.equal(stranger.address);
      expect(await vault.pendingOwner()).to.equal(ethers.ZeroAddress);

      // Old owner has lost control
      await expect(
        vault.connect(owner).setOfframpOperator(owner.address)
      ).to.be.revertedWithCustomError(vault, "OnlyOwner");
    });
  });

  describe("Branch coverage — TradeStars reconcile error paths", function () {
    it("reconcile reverts OfframpRecordNotFound for unknown orderId", async function () {
      await expect(integrator.reconcile(999n)).to.be.revertedWithCustomError(
        integrator,
        "OfframpRecordNotFound"
      );
    });

    it("reconcile reverts OfframpAlreadyReconciled on second call after COMPLETED", async function () {
      const burnTx = "0x" + "ee".repeat(32);
      const tx = await integrator
        .connect(relayer)
        .placeSellOrderForBurn(
          burnTx,
          "0x" + "cd".repeat(32),
          USDC(20),
          INR,
          USDC(1600),
          1n,
          0n,
          "userPubKey"
        );
      const sellOrderId = (await tx.wait()).logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p: any) => p?.name === "OfframpInitiated").args.orderId as bigint;
      await mockDiamond.acceptSellOrder(sellOrderId, "merchantPubKey");
      await integrator.connect(relayer).deliverOfframpUpi(sellOrderId, "encUpi");
      await mockDiamond.completeSellOrder(sellOrderId);
      await integrator.reconcile(sellOrderId);
      await expect(integrator.reconcile(sellOrderId)).to.be.revertedWithCustomError(
        integrator,
        "OfframpAlreadyReconciled"
      );
    });
  });

  // ─── Post-audit hardening guards ────────────────────────────────────
  //
  // Each test below pins one of the security fixes from the prod-readiness
  // audit so a future regression surfaces immediately rather than re-opening
  // the original attack vector. The labels (B1..B4 / S1..S3) match the
  // audit report headers.

  describe("Audit fix B1 — reconcile reads authoritative status from Diamond", function () {
    async function placeAndAcceptSell(burnTxHex: string) {
      const tx = await integrator
        .connect(relayer)
        .placeSellOrderForBurn(
          burnTxHex,
          "0x" + "cd".repeat(32),
          USDC(20),
          INR,
          USDC(1600),
          1n,
          0n,
          "userPubKey"
        );
      const sellOrderId = (await tx.wait()).logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p: any) => p?.name === "OfframpInitiated").args.orderId as bigint;
      await mockDiamond.acceptSellOrder(sellOrderId, "mp");
      return sellOrderId;
    }

    it("reverts StatusNotTerminal when Diamond order is still ACCEPTED (griefer attack)", async function () {
      // Pre-fix: a stranger could call reconcile(id, CANCELLED) right after
      // placement and force the vault accounting + offramp record into a
      // terminal state, locking the legitimate completion path. Post-fix:
      // reconcile reads Diamond's status and rejects non-terminal.
      const sellOrderId = await placeAndAcceptSell("0x" + "aa".repeat(32));
      await expect(
        integrator.connect(stranger).reconcile(sellOrderId)
      ).to.be.revertedWithCustomError(integrator, "StatusNotTerminal");
    });

    it("reverts StatusNotTerminal when Diamond order is PAID (mid-flight)", async function () {
      const sellOrderId = await placeAndAcceptSell("0x" + "bb".repeat(32));
      await integrator.connect(relayer).deliverOfframpUpi(sellOrderId, "encUpi");
      // Mock now in PAID, integrator hasn't been notified of completion yet
      await expect(integrator.reconcile(sellOrderId)).to.be.revertedWithCustomError(
        integrator,
        "StatusNotTerminal"
      );
    });

    it("anyone can poke once Diamond is terminal — recorded status comes from Diamond, not caller", async function () {
      // Permissionless reconcile is preserved post-fix; security comes from
      // reading Diamond instead of trusting an argument. Stranger pokes
      // after legitimate cancellation — succeeds and records CANCELLED.
      const sellOrderId = await placeAndAcceptSell("0x" + "cc".repeat(32));
      await integrator.connect(relayer).deliverOfframpUpi(sellOrderId, "encUpi");
      await mockDiamond.cancelSellOrder(sellOrderId);
      await integrator.connect(stranger).reconcile(sellOrderId);
      const r = await integrator.offramps(sellOrderId);
      expect(r.lastStatus).to.equal(STATUS.CANCELLED);
    });
  });

  describe("Audit fix B2 — deliverOfframpUpi rejects unready fee", function () {
    it("reverts OfframpFeeNotReady when Diamond returns 0 for actualUsdtAmount", async function () {
      // Pre-fix: silent fallback to principal-only funded the proxy short
      // of fee → Diamond's transferFrom underflowed → Diamond auto-cancelled
      // (the 2026-05-07 fee bug). Post-fix: explicit revert forces the
      // relayer to retry once Diamond has computed actualUsdtAmount.
      const tx = await integrator
        .connect(relayer)
        .placeSellOrderForBurn(
          "0x" + "ff".repeat(32),
          "0x" + "cd".repeat(32),
          USDC(20),
          INR,
          USDC(1600),
          1n,
          0n,
          "userPubKey"
        );
      const sellOrderId = (await tx.wait()).logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p: any) => p?.name === "OfframpInitiated").args.orderId as bigint;
      await mockDiamond.acceptSellOrder(sellOrderId, "mp");

      // Toggle the mock so getAdditionalOrderDetails returns 0
      await mockDiamond.setAdditionalOrderDetailsFeeUnready(true);
      await expect(
        integrator.connect(relayer).deliverOfframpUpi(sellOrderId, "encUpi")
      ).to.be.revertedWithCustomError(integrator, "OfframpFeeNotReady");

      // Replay guard didn't trip (we reverted before the success path)
      const r = await integrator.offramps(sellOrderId);
      expect(r.delivered).to.equal(false);

      // Once Diamond is ready, the legitimate retry succeeds
      await mockDiamond.setAdditionalOrderDetailsFeeUnready(false);
      await integrator.connect(relayer).deliverOfframpUpi(sellOrderId, "encUpi");
      const r2 = await integrator.offramps(sellOrderId);
      expect(r2.delivered).to.equal(true);
    });
  });

  describe("Audit fix B4 — deliverOfframpUpi replay guard", function () {
    it("reverts OfframpAlreadyDelivered on a second call for the same orderId", async function () {
      const tx = await integrator
        .connect(relayer)
        .placeSellOrderForBurn(
          "0x" + "d1".repeat(32),
          "0x" + "cd".repeat(32),
          USDC(20),
          INR,
          USDC(1600),
          1n,
          0n,
          "userPubKey"
        );
      const sellOrderId = (await tx.wait()).logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p: any) => p?.name === "OfframpInitiated").args.orderId as bigint;
      await mockDiamond.acceptSellOrder(sellOrderId, "mp");
      await integrator.connect(relayer).deliverOfframpUpi(sellOrderId, "encUpi");
      await expect(
        integrator.connect(relayer).deliverOfframpUpi(sellOrderId, "encUpi")
      ).to.be.revertedWithCustomError(integrator, "OfframpAlreadyDelivered");
    });
  });

  describe("Audit fix S3 — vault allowance reset after deposit", function () {
    it("integrator's allowance to the vault is 0 after a buy completion", async function () {
      // Defense-in-depth: even though deposit pulls the exact approved
      // amount via safeTransferFrom (landing the allowance at 0 anyway),
      // pin the invariant so a future vault that doesn't can't leave a
      // dangling allowance the next placement could abuse.
      const solanaPubkey = "0x" + "11".repeat(32);
      await integrator
        .connect(user)
        .userPlaceOrder(solanaPubkey, USDC(10), INR, 1n, "pubkey", 0n, 0n);
      const orderId = 1n; // first order
      await usdc.mint(await mockDiamond.getAddress(), USDC(10));
      await mockDiamond.simulateOrderComplete(orderId);

      const allowance = await usdc.allowance(
        await integrator.getAddress(),
        await vault.getAddress()
      );
      expect(allowance).to.equal(0n);
    });
  });

  describe("Offramp beyond onramp (yield + owner fund())", function () {
    async function releaseAs(amount: bigint) {
      const integratorAddr = await integrator.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [integratorAddr]);
      await ethers.provider.send("hardhat_setBalance", [integratorAddr, "0x1000000000000000000"]);
      const s = await ethers.getSigner(integratorAddr);
      await vault.connect(s).releaseForOfframp(amount);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [integratorAddr]);
    }

    async function accrueYield(amount: bigint) {
      await usdc.mint(await aave.getAddress(), amount);
      await aave.accrueYield(
        await aUsdc.getAddress(),
        await vault.getAddress(),
        amount,
        await usdc.getAddress()
      );
    }

    it("offrampQuota() reflects the full live balance (incl. yield)", async function () {
      expect(await vault.offrampQuota()).to.equal(USDC(100));
      await accrueYield(USDC(5));
      expect(await vault.offrampQuota()).to.equal(USDC(105));
    });

    it("offramp can draw Aave yield beyond cumulative onramp", async function () {
      await accrueYield(USDC(5)); // principal 100, balance 105
      await releaseAs(USDC(105)); // more than totalPrincipal — allowed (balance-bound)
      expect(await aUsdc.balanceOf(await vault.getAddress())).to.equal(0n);
      expect(await vault.offrampWithdrawn()).to.equal(USDC(105)); // exceeds totalPrincipal
    });

    it("owner fund() adds offramp liquidity without onramp fee", async function () {
      const onrampAccruedBefore = await vault.p2pOnrampAccrued();
      await usdc.mint(owner.address, USDC(50));
      await usdc.connect(owner).approve(await vault.getAddress(), USDC(50));
      await expect(vault.connect(owner).fund(USDC(50)))
        .to.emit(vault, "Funded")
        .withArgs(owner.address, USDC(50));

      // No onramp fee, totalPrincipal unchanged, funded amount shows as yield.
      expect(await vault.p2pOnrampAccrued()).to.equal(onrampAccruedBefore);
      expect(await vault.totalPrincipal()).to.equal(USDC(100));
      expect(await vault.getYield()).to.equal(USDC(50));
      expect(await vault.offrampQuota()).to.equal(USDC(150));

      // Funded liquidity lets offramp volume exceed onramp.
      await releaseAs(USDC(150));
      expect(await vault.offrampWithdrawn()).to.equal(USDC(150));
    });

    it("owner can reclaim unused fund() as yield via ownerWithdraw", async function () {
      await usdc.mint(owner.address, USDC(50));
      await usdc.connect(owner).approve(await vault.getAddress(), USDC(50));
      await vault.connect(owner).fund(USDC(50));
      // ownerQuota = 40% principal (40) + yield (50) = 90, balance-bounded to 150.
      expect(await vault.ownerQuota()).to.equal(USDC(90));
      const bal0 = await usdc.balanceOf(owner.address);
      await vault.connect(owner).ownerWithdraw(USDC(50)); // yield-first → reclaims the funded 50
      expect(await usdc.balanceOf(owner.address)).to.equal(bal0 + USDC(50));
    });

    it("fund() is owner-only and rejects zero", async function () {
      await expect(vault.connect(stranger).fund(USDC(1))).to.be.revertedWithCustomError(
        vault,
        "OnlyOwner"
      );
      await expect(vault.connect(owner).fund(0)).to.be.revertedWithCustomError(
        vault,
        "InvalidAmount"
      );
    });
  });

  describe("Vault migration sequence (P2P carry-over)", function () {
    // Mirrors the on-chain steps in scripts/migrate-tradestars-vault.ts and
    // asserts funds + P2P fee state migrate correctly under the accrual model.
    const PCT = (n: bigint, bps: bigint) => (n * bps) / 10000n;

    it("migrates funds, carries over custom rates, resets + re-accrues ledgers", async function () {
      // Old vault: seeded with 100 USDC at default 2.5% in beforeEach, so the
      // onramp fee already accrued at 2.5%. Now switch to custom rates.
      await vault.connect(owner).setP2PFeeBps(100, 500); // 1% onramp, 5% offramp
      const oldOnrampBps = await vault.p2pOnrampBps();
      const oldOfframpBps = await vault.p2pOfframpBps();
      expect(await vault.p2pOnrampAccrued()).to.equal(PCT(USDC(100), 250n)); // 2.5 (seeded @2.5%)
      expect(await vault.p2pOfframpAccrued()).to.equal(0n);

      // ── Drain old vault to the owner (mirrors phases 3-4) ──
      await integrator.setOfframpEnabled(false);
      const ownerUsdcStart = await usdc.balanceOf(owner.address);
      await vault.connect(owner).ownerWithdraw(await vault.ownerQuota()); // 40
      await vault.connect(owner).setOfframpOperator(owner.address); // operator handoff
      const remaining = await aUsdc.balanceOf(await vault.getAddress()); // 60
      await vault.connect(owner).releaseForOfframp(remaining);

      expect(await aUsdc.balanceOf(await vault.getAddress())).to.equal(0n);
      // The drain INFLATED the old offramp ledger (documented caveat — the
      // biller must snapshot accrued BEFORE the drain): +5% of 60 = 3.0.
      expect(await vault.p2pOfframpAccrued()).to.equal(PCT(remaining, 500n));

      const drained = (await usdc.balanceOf(owner.address)) - ownerUsdcStart;
      expect(drained).to.equal(USDC(100)); // 40 (owner) + 60 (operator)

      // ── Deploy new vault + carry rates over (mirrors phase 2) ──
      const Vault = await ethers.getContractFactory("RestrictedYieldVault");
      const newVault = await Vault.connect(owner).deploy(
        await usdc.getAddress(),
        await aUsdc.getAddress(),
        await aave.getAddress()
      );
      expect(await newVault.p2pOnrampBps()).to.equal(250n); // fresh defaults
      await newVault.connect(owner).setP2PFeeBps(oldOnrampBps, oldOfframpBps);

      // ── Deposit drained USDC into the new vault (mirrors phase 5) ──
      await usdc.connect(owner).approve(await newVault.getAddress(), drained);
      await newVault.connect(owner).deposit(drained);

      // ── Rewire integrator (mirrors phase 6) ──
      await newVault.connect(owner).setOfframpOperator(await integrator.getAddress());
      await integrator.setYieldVault(await newVault.getAddress());
      await integrator.setOfframpEnabled(true);

      // ── Correct migration ──
      // Funds conserved: the full 100 is now in the new vault, none in the old.
      expect(await newVault.totalPrincipal()).to.equal(USDC(100));
      expect(await aUsdc.balanceOf(await newVault.getAddress())).to.equal(USDC(100));
      // Custom rates carried over.
      expect(await newVault.p2pOnrampBps()).to.equal(100n);
      expect(await newVault.p2pOfframpBps()).to.equal(500n);
      // Ledgers reset, then re-accrued on the migrated deposit at the carried
      // onramp rate (1% of 100 = 1.0); the offramp ledger starts clean.
      expect(await newVault.p2pOnrampAccrued()).to.equal(PCT(USDC(100), 100n));
      expect(await newVault.p2pOfframpAccrued()).to.equal(0n);
      // Wiring complete.
      expect(await integrator.yieldVault()).to.equal(await newVault.getAddress());
      expect(await newVault.offrampOperator()).to.equal(await integrator.getAddress());
    });

    it("offramp works end-to-end on the migrated vault", async function () {
      await integrator.setOfframpEnabled(false);
      await vault.connect(owner).ownerWithdraw(await vault.ownerQuota());
      await vault.connect(owner).setOfframpOperator(owner.address);
      const remaining = await aUsdc.balanceOf(await vault.getAddress());
      if (remaining > 0n) await vault.connect(owner).releaseForOfframp(remaining);
      const drained = await usdc.balanceOf(owner.address);

      const Vault = await ethers.getContractFactory("RestrictedYieldVault");
      const newVault = await Vault.connect(owner).deploy(
        await usdc.getAddress(),
        await aUsdc.getAddress(),
        await aave.getAddress()
      );
      await usdc.connect(owner).approve(await newVault.getAddress(), drained);
      await newVault.connect(owner).deposit(drained);
      await newVault.connect(owner).setOfframpOperator(await integrator.getAddress());
      await integrator.setYieldVault(await newVault.getAddress());
      await integrator.setOfframpEnabled(true);

      // A sell order now pulls from the NEW vault and accrues its offramp fee.
      await integrator
        .connect(relayer)
        .placeSellOrderForBurn(
          "0x" + "a1".repeat(32),
          "0x" + "b2".repeat(32),
          USDC(20),
          INR,
          USDC(1600),
          1n,
          0n,
          ""
        );
      expect(await newVault.offrampWithdrawn()).to.equal(USDC(20));
      expect(await newVault.p2pOfframpAccrued()).to.equal(PCT(USDC(20), 250n)); // default 2.5%
    });

    it("routes yield/owner-funded excess via fund(), not deposit() (no onramp re-bill)", async function () {
      // Old vault: 100 principal (seeded) + 20 owner-funded liquidity (fee-free).
      await usdc.mint(owner.address, USDC(20));
      await usdc.connect(owner).approve(await vault.getAddress(), USDC(20));
      await vault.connect(owner).fund(USDC(20)); // surfaces as yield; balance = 120
      const oldTotalPrincipal = await vault.totalPrincipal(); // 100

      // Drain everything to the owner.
      await integrator.setOfframpEnabled(false);
      await vault.connect(owner).ownerWithdraw(await vault.ownerQuota()); // 40 principal + 20 yield
      await vault.connect(owner).setOfframpOperator(owner.address);
      const remaining = await aUsdc.balanceOf(await vault.getAddress());
      if (remaining > 0n) await vault.connect(owner).releaseForOfframp(remaining);
      const drained = await usdc.balanceOf(owner.address); // 120

      // New vault: split principal (deposit) vs excess (fund), as the script does.
      const Vault = await ethers.getContractFactory("RestrictedYieldVault");
      const newVault = await Vault.connect(owner).deploy(
        await usdc.getAddress(),
        await aUsdc.getAddress(),
        await aave.getAddress()
      );
      const principalPortion = drained < oldTotalPrincipal ? drained : oldTotalPrincipal; // 100
      const excess = drained - principalPortion; // 20
      await usdc.connect(owner).approve(await newVault.getAddress(), drained);
      if (principalPortion > 0n) await newVault.connect(owner).deposit(principalPortion);
      if (excess > 0n) await newVault.connect(owner).fund(excess);

      // Principal re-established at 100; the 20 excess went in fee-free as yield.
      expect(await newVault.totalPrincipal()).to.equal(USDC(100));
      expect(await newVault.getYield()).to.equal(USDC(20));
      expect(await aUsdc.balanceOf(await newVault.getAddress())).to.equal(USDC(120));
      // Onramp fee re-accrued on the 100 principal only — NOT the 20 excess.
      expect(await newVault.p2pOnrampAccrued()).to.equal(PCT(USDC(100), 250n));
    });
  });
});
