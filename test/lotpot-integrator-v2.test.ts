import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { runLotpotIntegratorSharedTests } from "./_lotpot-integrator-shared";

// V1-behavior parity: V2 inherits the entire V1 surface when vaults and
// credit issuers are unconfigured. Re-run the V1 suite against the V2
// factory to lock that in.
runLotpotIntegratorSharedTests(
  "LotPotCheckoutIntegratorV2 (V1-behavior parity) + Megapot",
  "LotPotCheckoutIntegratorV2"
);

describe("LotPotCheckoutIntegratorV2 — credit ledger + vault pull", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let stranger: SignerWithAddress;
  let issuerEoa: SignerWithAddress;
  let recipient: SignerWithAddress;
  let grantOwner: SignerWithAddress;
  let fallbackOwner: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let mockMegapot: any;
  let mockBatch: any;
  let mockNft: any;
  let integrator: any;
  let grantVault: any;
  let fallbackVault: any;

  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
  const TICKET_PRICE = USDC(1);
  const BASE_TX_LIMIT = USDC(50);
  const DAILY_COUNT_LIMIT = 10;
  const BALL_MAX = 30;
  const BONUSBALL_MAX = 15;
  const SOURCE = ethers.encodeBytes32String("lotpot-v2");
  const INR = ethers.encodeBytes32String("INR");

  beforeEach(async function () {
    [owner, user, stranger, issuerEoa, recipient, grantOwner, fallbackOwner] =
      await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUsdc = await MockUSDC.deploy();

    const MockDiamond = await ethers.getContractFactory("MockDiamond");
    mockDiamond = await MockDiamond.deploy(await mockUsdc.getAddress());

    const MockJackpotNFT = await ethers.getContractFactory("MockJackpotNFT");
    mockNft = await MockJackpotNFT.deploy();

    const MockMegapot = await ethers.getContractFactory("MockMegapot");
    mockMegapot = await MockMegapot.deploy(
      await mockUsdc.getAddress(),
      await mockNft.getAddress(),
      TICKET_PRICE,
      BALL_MAX,
      BONUSBALL_MAX
    );

    const MockBatch = await ethers.getContractFactory("MockBatchPurchaseFacilitator");
    mockBatch = await MockBatch.deploy(
      await mockUsdc.getAddress(),
      await mockNft.getAddress(),
      TICKET_PRICE,
      BALL_MAX,
      BONUSBALL_MAX,
      11
    );

    const Integrator = await ethers.getContractFactory("LotPotCheckoutIntegratorV2");
    integrator = await Integrator.connect(owner).deploy(
      await mockDiamond.getAddress(),
      await mockUsdc.getAddress(),
      await mockMegapot.getAddress(),
      await mockBatch.getAddress(),
      await mockNft.getAddress(),
      BASE_TX_LIMIT,
      DAILY_COUNT_LIMIT,
      SOURCE
    );

    await mockDiamond.registerIntegrator(
      await integrator.getAddress(),
      await integrator.proxyImpl()
    );
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(10000));
    await mockBatch.addAllowed(await integrator.getAddress());

    const Vault = await ethers.getContractFactory("GrantVault");
    grantVault = await Vault.deploy(await mockUsdc.getAddress(), grantOwner.address);
    fallbackVault = await Vault.deploy(await mockUsdc.getAddress(), fallbackOwner.address);
  });

  // ─── Admin: setCreditIssuer / setVaults ──────────────────────────────

  describe("setCreditIssuer", function () {
    it("owner can approve + revoke an issuer + emits event", async function () {
      await expect(integrator.connect(owner).setCreditIssuer(issuerEoa.address, true))
        .to.emit(integrator, "CreditIssuerSet")
        .withArgs(issuerEoa.address, true);
      expect(await integrator.creditIssuer(issuerEoa.address)).to.equal(true);

      await expect(integrator.connect(owner).setCreditIssuer(issuerEoa.address, false))
        .to.emit(integrator, "CreditIssuerSet")
        .withArgs(issuerEoa.address, false);
      expect(await integrator.creditIssuer(issuerEoa.address)).to.equal(false);
    });

    it("reverts OnlyOwner when called by non-owner", async function () {
      await expect(
        integrator.connect(stranger).setCreditIssuer(issuerEoa.address, true)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });

    it("reverts InvalidAddress on zero", async function () {
      await expect(
        integrator.connect(owner).setCreditIssuer(ethers.ZeroAddress, true)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    });
  });

  describe("setVaults", function () {
    it("owner can set both vaults + emits event", async function () {
      const g = await grantVault.getAddress();
      const f = await fallbackVault.getAddress();
      await expect(integrator.connect(owner).setVaults(g, f))
        .to.emit(integrator, "VaultsUpdated")
        .withArgs(g, f);
      expect(await integrator.grantVault()).to.equal(g);
      expect(await integrator.fallbackVault()).to.equal(f);
    });

    it("either side may be zero (disabled)", async function () {
      const g = await grantVault.getAddress();
      await integrator.connect(owner).setVaults(g, ethers.ZeroAddress);
      expect(await integrator.fallbackVault()).to.equal(ethers.ZeroAddress);

      await integrator.connect(owner).setVaults(ethers.ZeroAddress, ethers.ZeroAddress);
      expect(await integrator.grantVault()).to.equal(ethers.ZeroAddress);
    });

    it("reverts OnlyOwner when called by non-owner", async function () {
      await expect(
        integrator.connect(stranger).setVaults(ethers.ZeroAddress, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });
  });

  // ─── issueCredit ─────────────────────────────────────────────────────

  describe("issueCredit", function () {
    beforeEach(async function () {
      await integrator.connect(owner).setCreditIssuer(issuerEoa.address, true);
    });

    it("approved issuer can increment per-user accumulator + emits event", async function () {
      await expect(integrator.connect(issuerEoa).issueCredit(user.address, USDC(2)))
        .to.emit(integrator, "CreditIssued")
        .withArgs(issuerEoa.address, user.address, USDC(2));
      expect(await integrator.issuedCredit(user.address)).to.equal(USDC(2));
    });

    it("accumulates across multiple calls", async function () {
      await integrator.connect(issuerEoa).issueCredit(user.address, USDC(1));
      await integrator.connect(issuerEoa).issueCredit(user.address, USDC(3));
      expect(await integrator.issuedCredit(user.address)).to.equal(USDC(4));
    });

    it("reverts OnlyCreditIssuer when caller not whitelisted", async function () {
      await expect(
        integrator.connect(stranger).issueCredit(user.address, USDC(1))
      ).to.be.revertedWithCustomError(integrator, "OnlyCreditIssuer");
    });

    it("reverts InvalidAddress on zero user", async function () {
      await expect(
        integrator.connect(issuerEoa).issueCredit(ethers.ZeroAddress, USDC(1))
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    });

    it("reverts InvalidAmount on zero amount", async function () {
      await expect(
        integrator.connect(issuerEoa).issueCredit(user.address, 0)
      ).to.be.revertedWithCustomError(integrator, "InvalidAmount");
    });
  });

  // ─── previewAvailableCredit ──────────────────────────────────────────

  describe("previewAvailableCredit", function () {
    it("returns the four-tuple correctly", async function () {
      await integrator.connect(owner).setCreditIssuer(issuerEoa.address, true);
      await integrator.connect(issuerEoa).issueCredit(user.address, USDC(5));
      await mockUsdc.mint(await grantVault.getAddress(), USDC(100));
      await mockUsdc.mint(await fallbackVault.getAddress(), USDC(50));
      await integrator
        .connect(owner)
        .setVaults(await grantVault.getAddress(), await fallbackVault.getAddress());
      // Also mint some USDC directly to the (not-yet-deployed) proxy address.
      const proxyAddr = await integrator.proxyAddress(user.address);
      await mockUsdc.mint(proxyAddr, USDC(3));

      const [onProxy, issued, grantAvail, fallbackAvail] = await integrator.previewAvailableCredit(
        user.address
      );
      expect(onProxy).to.equal(USDC(3));
      expect(issued).to.equal(USDC(5));
      expect(grantAvail).to.equal(USDC(100));
      expect(fallbackAvail).to.equal(USDC(50));
    });

    it("returns 0 for unset vaults", async function () {
      const [, , grantAvail, fallbackAvail] = await integrator.previewAvailableCredit(user.address);
      expect(grantAvail).to.equal(0);
      expect(fallbackAvail).to.equal(0);
    });
  });

  // ─── _route extended logic ───────────────────────────────────────────

  describe("_route", function () {
    beforeEach(async function () {
      // Whitelist a credit issuer for these scenarios.
      await integrator.connect(owner).setCreditIssuer(issuerEoa.address, true);
      // Wire vaults (initially unfunded; individual tests fund as needed).
      await integrator
        .connect(owner)
        .setVaults(await grantVault.getAddress(), await fallbackVault.getAddress());
      // Approve integrator on each vault.
      await grantVault.connect(grantOwner).setApprovedSpender(await integrator.getAddress(), true);
      await fallbackVault
        .connect(fallbackOwner)
        .setApprovedSpender(await integrator.getAddress(), true);
    });

    it("user with proxy balance only behaves identically to V1 (skipped-fulfillment credit)", async function () {
      // Mint 3 USDC directly to the user's proxy address (mimics a previously
      // skipped Diamond fulfillment leaving USDC stranded on the proxy).
      const proxyAddr = await integrator.proxyAddress(user.address);
      await mockUsdc.mint(proxyAddr, USDC(3));

      // Place 5-ticket order at 1 USDC each — credit = 3, delta = 2 → Diamond order.
      const tx = await integrator.connect(user).userPlaceOrder(5n, INR, 1, "", 0, 0, [], []);
      await expect(tx)
        .to.emit(integrator, "LotPotOrderCreated")
        .withArgs(1, user.address, 5, true, USDC(5));
      // No issued-credit decrement should fire (no CreditConsumed event).
      await expect(tx).to.not.emit(integrator, "CreditConsumed");
    });

    it("issued credit + funded grant vault → vault pulled, credit decremented, redeemed without Diamond", async function () {
      // Fund grant vault.
      await mockUsdc.mint(await grantVault.getAddress(), USDC(100));
      // Issue 5 USDC of credit.
      await integrator.connect(issuerEoa).issueCredit(user.address, USDC(5));

      // Place 5-ticket order — fully covered by credit; should skip Diamond.
      const proxyAddr = await integrator.proxyAddress(user.address);
      const grantBefore = await mockUsdc.balanceOf(await grantVault.getAddress());

      const tx = await integrator.connect(user).userPlaceOrder(5n, INR, 1, "", 0, 0, [], []);

      // Credit-only redemption: LotPotCreditRedeemed, no LotPotOrderCreated.
      await expect(tx)
        .to.emit(integrator, "LotPotCreditRedeemed")
        .withArgs(user.address, 0, 5, USDC(5));
      await expect(tx).to.not.emit(integrator, "LotPotOrderCreated");

      // Credit fully consumed.
      expect(await integrator.issuedCredit(user.address)).to.equal(0);
      // Grant vault was drained by 5 USDC.
      const grantAfter = await mockUsdc.balanceOf(await grantVault.getAddress());
      expect(grantBefore - grantAfter).to.equal(USDC(5));
      // Tickets minted to user.
      expect(await mockNft.balanceOf(user.address)).to.equal(5);
      // Proxy ends empty.
      expect(await mockUsdc.balanceOf(proxyAddr)).to.equal(0);

      await expect(tx).to.emit(integrator, "CreditConsumed").withArgs(user.address, USDC(5), 0);
    });

    it("grant vault dry + funded fallback → fallback used, credit decremented", async function () {
      // Grant vault stays empty; fund only the fallback.
      await mockUsdc.mint(await fallbackVault.getAddress(), USDC(100));
      await integrator.connect(issuerEoa).issueCredit(user.address, USDC(5));

      const fallbackBefore = await mockUsdc.balanceOf(await fallbackVault.getAddress());
      const tx = await integrator.connect(user).userPlaceOrder(5n, INR, 1, "", 0, 0, [], []);

      await expect(tx).to.emit(integrator, "LotPotCreditRedeemed");
      expect(await integrator.issuedCredit(user.address)).to.equal(0);
      const fallbackAfter = await mockUsdc.balanceOf(await fallbackVault.getAddress());
      expect(fallbackBefore - fallbackAfter).to.equal(USDC(5));
      // Grant vault untouched (still 0).
      expect(await mockUsdc.balanceOf(await grantVault.getAddress())).to.equal(0);
    });

    it("partial vault liquidity: grant partial + fallback partial = full coverage", async function () {
      // Grant has 2 USDC, fallback has 5 USDC; user needs 5 USDC.
      // Logic should pull min(needed, grantBal) from grant = 2, then 3 from fallback.
      await mockUsdc.mint(await grantVault.getAddress(), USDC(2));
      await mockUsdc.mint(await fallbackVault.getAddress(), USDC(5));
      await integrator.connect(issuerEoa).issueCredit(user.address, USDC(5));

      const tx = await integrator.connect(user).userPlaceOrder(5n, INR, 1, "", 0, 0, [], []);

      await expect(tx).to.emit(integrator, "LotPotCreditRedeemed");
      expect(await integrator.issuedCredit(user.address)).to.equal(0);
      expect(await mockUsdc.balanceOf(await grantVault.getAddress())).to.equal(0);
      expect(await mockUsdc.balanceOf(await fallbackVault.getAddress())).to.equal(USDC(2));
    });

    it("BOTH vaults dry → partial fulfillment (Diamond order for the larger delta; credit unchanged)", async function () {
      // No vault funding. User has 5 USDC issued credit but vaults can't honor it.
      await integrator.connect(issuerEoa).issueCredit(user.address, USDC(5));

      const tx = await integrator.connect(user).userPlaceOrder(5n, INR, 1, "", 0, 0, [], []);
      // Diamond order placed for the full 5 USDC (no credit was pulled).
      await expect(tx)
        .to.emit(integrator, "LotPotOrderCreated")
        .withArgs(1, user.address, 5, true, USDC(5));
      // No CreditConsumed because nothing was actually pulled.
      await expect(tx).to.not.emit(integrator, "CreditConsumed");
      // Credit preserved for the next attempt.
      expect(await integrator.issuedCredit(user.address)).to.equal(USDC(5));
    });

    it("issued credit > total price → only the needed amount is pulled; remaining credit persists", async function () {
      await mockUsdc.mint(await grantVault.getAddress(), USDC(100));
      // Issue 20 USDC; user buys 5 tickets at 1 USDC each = 5 USDC.
      await integrator.connect(issuerEoa).issueCredit(user.address, USDC(20));

      const tx = await integrator.connect(user).userPlaceOrder(5n, INR, 1, "", 0, 0, [], []);
      await expect(tx).to.emit(integrator, "LotPotCreditRedeemed");
      // 5 USDC consumed; 15 remaining.
      expect(await integrator.issuedCredit(user.address)).to.equal(USDC(15));
      await expect(tx)
        .to.emit(integrator, "CreditConsumed")
        .withArgs(user.address, USDC(5), USDC(15));
    });

    it("mixed sources: proxy balance + issued credit + vault all combine correctly", async function () {
      // Proxy has 2 USDC pre-funded; user has 2 USDC issued credit; needs 5 USDC.
      // Should pull min(needed=3, issued=2) = 2 from grant vault. Then total
      // covered = 2 + 2 = 4, still 1 short → falls through to Diamond order
      // for 1 USDC delta.
      const proxyAddr = await integrator.proxyAddress(user.address);
      await mockUsdc.mint(proxyAddr, USDC(2));
      await mockUsdc.mint(await grantVault.getAddress(), USDC(10));
      await integrator.connect(issuerEoa).issueCredit(user.address, USDC(2));

      const tx = await integrator.connect(user).userPlaceOrder(5n, INR, 1, "", 0, 0, [], []);

      // Partial fulfillment branch fired (LotPotOrderCreated, not LotPotCreditRedeemed).
      await expect(tx).to.emit(integrator, "LotPotOrderCreated");
      // Credit fully consumed.
      expect(await integrator.issuedCredit(user.address)).to.equal(0);
      // 2 USDC pulled from grant.
      expect(await mockUsdc.balanceOf(await grantVault.getAddress())).to.equal(USDC(8));
    });

    it("vault revoked mid-flight → degrades to partial fulfillment, credit unchanged for failed pull amount", async function () {
      // Grant vault funded but spender revoked → release will revert.
      await mockUsdc.mint(await grantVault.getAddress(), USDC(100));
      await grantVault.connect(grantOwner).setApprovedSpender(await integrator.getAddress(), false);
      // Fallback vault also revoked.
      await mockUsdc.mint(await fallbackVault.getAddress(), USDC(100));
      await fallbackVault
        .connect(fallbackOwner)
        .setApprovedSpender(await integrator.getAddress(), false);

      await integrator.connect(issuerEoa).issueCredit(user.address, USDC(5));

      const tx = await integrator.connect(user).userPlaceOrder(5n, INR, 1, "", 0, 0, [], []);

      // Diamond order for full 5 USDC; no credit consumed.
      await expect(tx).to.emit(integrator, "LotPotOrderCreated");
      await expect(tx).to.not.emit(integrator, "CreditConsumed");
      expect(await integrator.issuedCredit(user.address)).to.equal(USDC(5));
      // Vaults still hold full amount.
      expect(await mockUsdc.balanceOf(await grantVault.getAddress())).to.equal(USDC(100));
      expect(await mockUsdc.balanceOf(await fallbackVault.getAddress())).to.equal(USDC(100));
    });

    it("E2E: issueCredit → buy tickets → tickets minted to user EOA", async function () {
      await mockUsdc.mint(await grantVault.getAddress(), USDC(100));
      await integrator.connect(issuerEoa).issueCredit(user.address, USDC(3));

      await integrator.connect(user).userPlaceOrder(3n, INR, 1, "", 0, 0, [], []);

      // Credit fully consumed; tickets minted.
      expect(await integrator.issuedCredit(user.address)).to.equal(0);
      expect(await mockNft.balanceOf(user.address)).to.equal(3);
    });
  });
});
