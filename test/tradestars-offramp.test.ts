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
    it("releaseForOfframp allows up to 100% of principal", async function () {
      // total principal = 100 → offramp quota = 100
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

      // 70 USDC should now succeed (within 100% quota).
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

      // Remaining quota = 100 - 70 = 30. Pulling 40 should exceed it.
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
      ).to.be.revertedWithCustomError(vault, "ExceedsOfframpQuota");
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

    it("releaseForOfframp reverts ExceedsOfframpQuota when above 100% of principal", async function () {
      const integratorAddr = await integrator.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [integratorAddr]);
      await ethers.provider.send("hardhat_setBalance", [integratorAddr, "0x1000000000000000000"]);
      const integratorSigner = await ethers.getSigner(integratorAddr);
      // 100% of 100 USDC = 100; 101 USDC exceeds.
      await expect(
        vault.connect(integratorSigner).releaseForOfframp(USDC(101))
      ).to.be.revertedWithCustomError(vault, "ExceedsOfframpQuota");
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
});
