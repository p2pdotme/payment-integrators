import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const STATUS = { PLACED: 0, ACCEPTED: 1, PAID: 2, COMPLETED: 3, CANCELLED: 4 };

describe("TradeStarsCheckoutIntegrator — offramp via RestrictedYieldVault", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let relayer: SignerWithAddress;
  let stranger: SignerWithAddress;
  let p2p: SignerWithAddress;

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
    [owner, user, relayer, stranger, p2p] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();
    aUsdc = await MockUSDC.deploy();

    const MockAavePool = await ethers.getContractFactory("MockAavePool");
    aave = await MockAavePool.deploy();
    await aave.configure(await usdc.getAddress(), await aUsdc.getAddress());

    const Vault = await ethers.getContractFactory("RestrictedYieldVault");
    // p2pBeneficiary deliberately set in tests so we can exercise the
    // withdraw path. Branch-coverage tests for the unset case live below.
    vault = await Vault.deploy(
      await usdc.getAddress(),
      await aUsdc.getAddress(),
      await aave.getAddress(),
      p2p.address
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
      // Owner pulls their full 40%. Vault balance now = 60, but the
      // operator's principal headroom (totalPrincipal - offrampWithdrawn)
      // still claims 100 of headroom.
      await vault.connect(owner).ownerWithdraw(USDC(40));
      expect(await aUsdc.balanceOf(await vault.getAddress())).to.equal(USDC(60));

      // Impersonate the integrator (operator) and ask for 80. Quota check
      // sees 100 of headroom and passes, but balance is 60 — should revert
      // with InsufficientFunds, not fall through to an Aave low-level error.
      const integratorAddr = await integrator.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [integratorAddr]);
      await ethers.provider.send("hardhat_setBalance", [integratorAddr, "0x1000000000000000000"]);
      const integratorSigner = await ethers.getSigner(integratorAddr);
      await expect(
        vault.connect(integratorSigner).releaseForOfframp(USDC(80))
      ).to.be.revertedWithCustomError(vault, "InsufficientFunds");

      // Asking exactly at the balance still works — proves the new bound
      // is min(quota, balance), not strictly < balance.
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

  describe("P2P entitlement (2.5% share within the 40% bucket)", function () {
    // 2.5% of 100 USDC = 2.5 USDC; 2.5% of 20 = 0.5 USDC
    const PCT = (n: bigint) => (n * 250n) / 10000n;

    it("deposit credits p2pEntitled by 2.5% of the amount", async function () {
      // Seeding in beforeEach already deposited 100 USDC; verify the credit landed.
      expect(await vault.p2pEntitled()).to.equal(PCT(USDC(100)));
      // Another 20 USDC deposit (simulate onramp completion).
      await usdc.mint(owner.address, USDC(20));
      await usdc.connect(owner).approve(await vault.getAddress(), USDC(20));
      await vault.connect(owner).deposit(USDC(20));
      expect(await vault.p2pEntitled()).to.equal(PCT(USDC(100)) + PCT(USDC(20)));
    });

    it("releaseForOfframp credits p2pEntitled by 2.5% of release", async function () {
      const before = await vault.p2pEntitled();
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
      expect(await vault.p2pEntitled()).to.equal(before + PCT(USDC(20)));
    });

    it("returnFromOfframp on cancel reverses the credit", async function () {
      // Place + cancel a 20-USDC offramp; entitlement should net out.
      const before = await vault.p2pEntitled();
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
      // After release: entitlement = before + 0.5
      expect(await vault.p2pEntitled()).to.equal(before + PCT(USDC(20)));
      // Cancel via Diamond, reconcile — refund path returns 20 USDC.
      await mockDiamond.cancelSellOrder(sellOrderId);
      await integrator.reconcile(sellOrderId);
      // After return: entitlement back to `before` (net for cancelled offramp = 0)
      expect(await vault.p2pEntitled()).to.equal(before);
    });

    it("p2pWithdraw transfers USDC and updates accounting", async function () {
      const entitled = await vault.p2pEntitled(); // PCT(USDC(100)) = 2.5
      const bal0 = await usdc.balanceOf(p2p.address);
      await vault.connect(p2p).p2pWithdraw(entitled);
      expect(await usdc.balanceOf(p2p.address)).to.equal(bal0 + entitled);
      expect(await vault.p2pWithdrawn()).to.equal(entitled);
      expect(await vault.p2pAvailable()).to.equal(0n);
    });

    it("p2pWithdraw reverts OnlyP2PBeneficiary for non-beneficiary callers", async function () {
      await expect(vault.connect(stranger).p2pWithdraw(USDC(1))).to.be.revertedWithCustomError(
        vault,
        "OnlyP2PBeneficiary"
      );
      await expect(vault.connect(owner).p2pWithdraw(USDC(1))).to.be.revertedWithCustomError(
        vault,
        "OnlyP2PBeneficiary"
      );
    });

    it("p2pWithdraw reverts ExceedsP2PEntitlement when above accrued share", async function () {
      const entitled = await vault.p2pEntitled();
      await expect(vault.connect(p2p).p2pWithdraw(entitled + 1n)).to.be.revertedWithCustomError(
        vault,
        "ExceedsP2PEntitlement"
      );
    });

    it("p2pWithdraw reverts InvalidAmount on zero", async function () {
      await expect(vault.connect(p2p).p2pWithdraw(0)).to.be.revertedWithCustomError(
        vault,
        "InvalidAmount"
      );
    });

    it("p2pWithdraw shares the 40% bucket with the owner", async function () {
      // Owner takes their full 40% first. Then P2P entitlement (2.5) is fully
      // accrued but the bucket has no room left — withdrawal reverts.
      await vault.connect(owner).ownerWithdraw(USDC(40));
      const entitled = await vault.p2pEntitled();
      expect(entitled).to.be.gt(0n);
      await expect(vault.connect(p2p).p2pWithdraw(entitled)).to.be.revertedWithCustomError(
        vault,
        "ExceedsOwnerQuota"
      );
    });

    it("p2pWithdraw consumes from the same bucket — owner's max shrinks", async function () {
      // Pre: ownerQuota = 40 (40% of 100). P2P has 2.5 entitled.
      expect(await vault.ownerQuota()).to.equal(USDC(40));
      await vault.connect(p2p).p2pWithdraw(USDC(2)); // partial draw within entitlement
      // Owner can now only pull 40 - 2 = 38 from principal (plus yield, which is 0).
      expect(await vault.ownerQuota()).to.equal(USDC(38));
      await expect(vault.connect(owner).ownerWithdraw(USDC(39))).to.be.revertedWithCustomError(
        vault,
        "ExceedsOwnerQuota"
      );
      await vault.connect(owner).ownerWithdraw(USDC(38));
    });

    it("the leading-indicator tradeoff: P2P withdraws after a release that later cancels", async function () {
      // Trade-off scenario described in the design discussion:
      //   1. Onramp + offramp release credit P2P generously
      //   2. P2P withdraws against the optimistic entitlement
      //   3. Offramp cancels — entitlement is reversed, but the withdrawal already happened
      //   4. P2P sees `available = 0` until new volume catches up to `p2pWithdrawn`
      const burnTx = "0x" + "11".repeat(32);
      const txPlace = await integrator
        .connect(relayer)
        .placeSellOrderForBurn(
          burnTx,
          "0x" + "22".repeat(32),
          USDC(20),
          INR,
          USDC(1600),
          1n,
          0n,
          ""
        );
      const orderId = (await txPlace.wait()).logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p: any) => p?.name === "OfframpInitiated").args.orderId as bigint;

      // P2P entitled = 2.5 (from deposit) + 0.5 (from release) = 3.0
      const entitledBefore = await vault.p2pEntitled();
      expect(entitledBefore).to.equal(PCT(USDC(100)) + PCT(USDC(20)));

      // P2P pulls all 3.0
      await vault.connect(p2p).p2pWithdraw(entitledBefore);
      expect(await vault.p2pAvailable()).to.equal(0n);

      // Cancel that offramp → entitled drops by 0.5, but p2pWithdrawn stays at 3.0.
      await mockDiamond.acceptSellOrder(orderId, "merchantPubKey");
      await integrator.connect(relayer).deliverOfframpUpi(orderId, "enc");
      await mockDiamond.cancelSellOrder(orderId);
      await integrator.reconcile(orderId);

      expect(await vault.p2pEntitled()).to.equal(entitledBefore - PCT(USDC(20)));
      expect(await vault.p2pWithdrawn()).to.equal(entitledBefore);
      // p2pAvailable clamps to 0 — P2P took 0.5 it now "owes back."
      expect(await vault.p2pAvailable()).to.equal(0n);

      // A fresh onramp of 20 USDC credits 0.5 — exactly enough to clear the
      // implicit debt; available is still 0, anything beyond requires more
      // volume.
      await usdc.mint(owner.address, USDC(20));
      await usdc.connect(owner).approve(await vault.getAddress(), USDC(20));
      await vault.connect(owner).deposit(USDC(20));
      expect(await vault.p2pAvailable()).to.equal(0n);

      // Another onramp of 20 puts P2P legitimately ahead by 0.5.
      await usdc.mint(owner.address, USDC(20));
      await usdc.connect(owner).approve(await vault.getAddress(), USDC(20));
      await vault.connect(owner).deposit(USDC(20));
      expect(await vault.p2pAvailable()).to.equal(PCT(USDC(20)));
    });

    it("setP2PBeneficiary one-shot setter — works when unset, reverts when already set", async function () {
      // Deploy a fresh vault with no beneficiary to exercise the setter.
      const Vault = await ethers.getContractFactory("RestrictedYieldVault");
      const v2 = await Vault.deploy(
        await usdc.getAddress(),
        await aUsdc.getAddress(),
        await aave.getAddress(),
        ethers.ZeroAddress
      );
      expect(await v2.p2pBeneficiary()).to.equal(ethers.ZeroAddress);

      // Non-owner can't set
      await expect(
        v2.connect(stranger).setP2PBeneficiary(stranger.address)
      ).to.be.revertedWithCustomError(v2, "OnlyOwner");

      // Owner can't set to address(0)
      await expect(
        v2.connect(owner).setP2PBeneficiary(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(v2, "InvalidAddress");

      // Owner sets once — succeeds
      await expect(v2.connect(owner).setP2PBeneficiary(p2p.address))
        .to.emit(v2, "P2PBeneficiarySet")
        .withArgs(p2p.address);
      expect(await v2.p2pBeneficiary()).to.equal(p2p.address);

      // Second attempt — reverts
      await expect(
        v2.connect(owner).setP2PBeneficiary(stranger.address)
      ).to.be.revertedWithCustomError(v2, "P2PBeneficiaryAlreadySet");
    });

    it("vault deployed with address(0) accrues entitlement but blocks p2pWithdraw", async function () {
      const Vault = await ethers.getContractFactory("RestrictedYieldVault");
      const v2 = await Vault.deploy(
        await usdc.getAddress(),
        await aUsdc.getAddress(),
        await aave.getAddress(),
        ethers.ZeroAddress
      );
      await usdc.mint(owner.address, USDC(100));
      await usdc.connect(owner).approve(await v2.getAddress(), USDC(100));
      await v2.connect(owner).deposit(USDC(100));
      // Accrued correctly
      expect(await v2.p2pEntitled()).to.equal(PCT(USDC(100)));
      // Nobody can withdraw — beneficiary is unset, msg.sender can't be address(0).
      await expect(v2.connect(p2p).p2pWithdraw(USDC(1))).to.be.revertedWithCustomError(
        v2,
        "OnlyP2PBeneficiary"
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
