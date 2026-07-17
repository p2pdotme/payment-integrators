import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("MerchantTerminalIntegrator — registration, limits, settlement, withdrawals, security", function () {
  let owner: SignerWithAddress;
  let merchant1: SignerWithAddress;
  let merchant2: SignerWithAddress;
  let attacker: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let integrator: any;
  let erc721Client: any;

  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
  const UNIT_PRICE = USDC(10);
  const PRODUCT_ID = 1;
  const INR_CODE = "INR"; // human-readable code
  const INR = ethers.encodeBytes32String("INR"); // packed bytes32 (events)
  const DAY = 86400;
  // Read from the deployed contract in beforeEach so the suite matches whatever
  // SETTLEMENT_PERIOD is compiled in (30 days in prod, 10 min for the withdraw test build).
  let SETTLEMENT = 30 * DAY;
  // The payout handle is stored as an OPAQUE ENCRYPTED blob (bytes) now — the raw
  // UPI/PIX handle is never on-chain in plaintext. In tests we STAND IN for real
  // client-side encryption with a keccak256 transform: deterministic (so a value
  // round-trips and two calls with the same label match), and crucially the
  // plaintext bytes never appear inside the blob (mirroring real ciphertext). The
  // contract treats it as an opaque non-empty blob it never decodes.
  const enc = (label: string) => ethers.keccak256(ethers.toUtf8Bytes("enc-payout:" + label));
  const UPI_1 = enc("shop1@upi");
  const UPI_2 = enc("shop2@upi");
  // A valid-shape relay pubkey (65-byte uncompressed: 0x04 || 64 bytes) for the
  // SELL/withdraw path. The contract only checks it's non-empty; the LP parses it
  // as secp256k1 off-chain. The payout/UPI is delivered separately (deliverFiatPayout).
  const PK = "04" + "ab".repeat(64);

  beforeEach(async function () {
    [owner, merchant1, merchant2, attacker] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUsdc = await MockUSDC.deploy();

    const MockDiamond = await ethers.getContractFactory("MockDiamond");
    mockDiamond = await MockDiamond.deploy(await mockUsdc.getAddress());

    // Internal custody: the integrator holds all merchant USDC itself — no vault.
    const Integrator = await ethers.getContractFactory("MerchantTerminalIntegrator");
    integrator = await Integrator.deploy(
      await mockDiamond.getAddress(),
      await mockUsdc.getAddress(),
      [] // extra owners (deployer is always the first owner)
    );
    SETTLEMENT = Number(await integrator.SETTLEMENT_PERIOD());

    const Client = await ethers.getContractFactory("SimpleERC721Client");
    erc721Client = await Client.deploy(
      await integrator.getAddress(),
      await mockUsdc.getAddress(),
      "Digital Item",
      "ITEM"
    );

    await mockDiamond.registerIntegrator(
      await integrator.getAddress(),
      await integrator.proxyImpl()
    );
    await erc721Client.setProductPrice(PRODUCT_ID, UNIT_PRICE);
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(100000));
  });

  // ─── Helpers ──────────────────────────────────────────────────────

  async function diamondSigner(): Promise<SignerWithAddress> {
    const diamondAddr = await mockDiamond.getAddress();
    await ethers.provider.send("hardhat_impersonateAccount", [diamondAddr]);
    await ethers.provider.send("hardhat_setBalance", [diamondAddr, "0x1000000000000000000"]);
    return ethers.getSigner(diamondAddr);
  }

  async function placeOrder(merchant: SignerWithAddress, quantity = 1): Promise<bigint> {
    const tx = await integrator
      .connect(merchant)
      .userPlaceOrder(await erc721Client.getAddress(), PRODUCT_ID, quantity, INR, 1, "");
    await tx.wait();
    const events = await integrator.queryFilter(integrator.filters.OrderPlaced());
    return events[events.length - 1].args.orderId;
  }

  async function increaseTime(seconds: number) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  async function depositFor(
    merchant: SignerWithAddress,
    upi: string,
    quantity = 2
  ): Promise<bigint> {
    await integrator.connect(merchant).registerMerchant(upi, "Shop", INR_CODE);
    const orderId = await placeOrder(merchant, quantity);
    await mockDiamond.simulateOrderComplete(orderId);
    return orderId;
  }

  // ─── 1 + 2: Registration ──────────────────────────────────────────

  it("1. registerMerchant succeeds and emits MerchantRegistered", async function () {
    await expect(integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", INR_CODE))
      .to.emit(integrator, "MerchantRegistered")
      .withArgs(merchant1.address, "Shop One", INR); // payout handle NOT in the event (PII)
    expect(await integrator.registered(merchant1.address)).to.equal(true);
  });

  it("2. registerMerchant reverts when called twice", async function () {
    await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", INR_CODE);
    await expect(
      integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", INR_CODE)
    ).to.be.revertedWithCustomError(integrator, "AlreadyRegistered");
  });

  it("2f. updateProfile edits (encrypted) payout + shop name (currency stays locked)", async function () {
    const newEnc = enc("new@upi");
    await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", INR_CODE);
    await expect(integrator.connect(merchant1).updateProfile(newEnc, "New Shop"))
      .to.emit(integrator, "MerchantProfileUpdated")
      .withArgs(merchant1.address, "New Shop"); // handle NOT in event
    const [payout, shop, currency] = await integrator.getMerchantInfo(merchant1.address);
    expect(payout).to.equal(newEnc); // opaque ciphertext round-trips
    expect(shop).to.equal("New Shop");
    expect(currency).to.equal(INR); // currency unchanged
    // guards: unregistered can't update, empty payout reverts, frozen can't edit
    await expect(
      integrator.connect(merchant2).updateProfile(enc("x@upi"), "X")
    ).to.be.revertedWithCustomError(integrator, "NotRegistered");
    await expect(
      integrator.connect(merchant1).updateProfile("0x", "X")
    ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    await integrator.connect(owner).freezeMerchant(merchant1.address);
    await expect(
      integrator.connect(merchant1).updateProfile(enc("y@upi"), "Y")
    ).to.be.revertedWithCustomError(integrator, "MerchantIsFrozen");
  });

  // ─── multi-country: currency naming + per-country registration ─────

  it("2a. toCurrency / fromCurrency round-trip for any country code", async function () {
    for (const code of ["INR", "BRL", "ARS", "MXN", "NGN", "COP"]) {
      const packed = await integrator.toCurrency(code);
      expect(packed).to.equal(ethers.encodeBytes32String(code));
      expect(await integrator.fromCurrency(packed)).to.equal(code);
    }
  });

  it("2b. registerMerchant rejects an empty currency code", async function () {
    await expect(
      integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", "")
    ).to.be.revertedWithCustomError(integrator, "InvalidCurrency");
  });

  it("2c. a Brazil merchant registers with BRL + (encrypted) PIX and reads it back", async function () {
    const pixKey = enc("joao@email.com");
    await integrator.connect(merchant1).registerMerchant(pixKey, "Café Rio", "BRL");
    const [payoutId, shopName, currency, isReg] = await integrator.getMerchantInfo(
      merchant1.address
    );
    expect(payoutId).to.equal(pixKey); // opaque ciphertext round-trips
    expect(shopName).to.equal("Café Rio");
    expect(currency).to.equal(ethers.encodeBytes32String("BRL"));
    expect(isReg).to.equal(true);
    expect(await integrator.getMerchantCurrency(merchant1.address)).to.equal("BRL");
  });

  it("2d. an Argentina merchant registers with ARS + (encrypted) CBU/alias", async function () {
    await integrator.connect(merchant2).registerMerchant(enc("miguel.mp"), "Café del Sur", "ARS");
    expect(await integrator.getMerchantCurrency(merchant2.address)).to.equal("ARS");
  });

  it("2e. registerMerchantRaw accepts a pre-packed bytes32 currency", async function () {
    await integrator.connect(merchant1).registerMerchantRaw(UPI_1, "Shop One", INR);
    expect(await integrator.getMerchantCurrency(merchant1.address)).to.equal("INR");
  });

  it("2g. registration rejects an empty payout blob (both entry points)", async function () {
    await expect(
      integrator.connect(merchant1).registerMerchant("0x", "Shop", INR_CODE)
    ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
    await expect(
      integrator.connect(merchant1).registerMerchantRaw("0x", "Shop", INR)
    ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
  });

  it("AUDIT-FIX (privacy): the raw payout handle never appears on-chain — only the opaque blob, and NOT in any event", async function () {
    // The app encrypts the real handle client-side; on-chain we only ever see the
    // ciphertext. This test proves (a) the handle round-trips as opaque bytes and
    // (b) the plaintext is not recoverable from the registration event.
    const secret = "alice@okaxis"; // the real-world UPI id — must NEVER leak
    const blob = enc(secret); // what the app would actually send (ciphertext)
    const tx = await integrator.connect(merchant1).registerMerchant(blob, "Alice Shop", INR_CODE);
    const receipt = await tx.wait();

    // (a) getMerchantInfo returns the opaque blob, and the plaintext secret is not in it.
    const [payout] = await integrator.getMerchantInfo(merchant1.address);
    expect(payout).to.equal(blob);
    const plaintextHex = ethers.hexlify(ethers.toUtf8Bytes(secret));
    expect(payout.toLowerCase()).to.not.contain(plaintextHex.slice(2).toLowerCase());

    // (b) the MerchantRegistered event carries NO payout field at all — scan every
    // log's data for the plaintext bytes; it must be absent.
    for (const log of receipt.logs) {
      expect(log.data.toLowerCase()).to.not.contain(plaintextHex.slice(2).toLowerCase());
    }
    // And the event's decoded args are exactly (merchant, shopName, currency) — no handle.
    const ev = receipt.logs
      .map((l: any) => {
        try {
          return integrator.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((l: any) => l?.name === "MerchantRegistered");
    expect(ev.args.length).to.equal(3); // merchant, shopName, currency — no payout
  });

  it("2h. AUDIT: registerMerchantRaw rejects a non-canonical currency (interior NUL) — closes the cap bypass", async function () {
    // Bytes: 49='I' 4e='N' 52='R' 00=NUL 58='X', then 27 zero-pad bytes = 32 total.
    // This displays as "INR" via fromCurrency (truncates at NUL) but is != the
    // canonical bytes32("INR"), which would have self-granted the 100 USDC default
    // cap instead of INR's 50. The guard in _register must reject it.
    const bad = "0x494e520058" + "00".repeat(27);
    await expect(
      integrator.connect(merchant1).registerMerchantRaw(UPI_1, "Shop", bad as any)
    ).to.be.revertedWithCustomError(integrator, "InvalidCurrency");
    // The canonical form still works.
    await integrator.connect(merchant1).registerMerchantRaw(UPI_1, "Shop", INR);
    expect(await integrator.getMerchantCurrency(merchant1.address)).to.equal("INR");
  });

  // ─── 3 + 4 + 5: validateOrder limits ──────────────────────────────

  it("3. per-tx cap keys off the REGISTERED currency (no bypass via order currency)", async function () {
    const BRL = ethers.encodeBytes32String("BRL");
    // INR merchant → 50 cap on EVERY order, regardless of the order currency.
    await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", INR_CODE);
    const diamond = await diamondSigner();
    expect(await integrator.perTxCap(INR)).to.equal(USDC(50));
    await expect(integrator.connect(diamond).validateOrder(merchant1.address, USDC(50), INR)).to.not
      .be.reverted;
    await expect(
      integrator.connect(diamond).validateOrder(merchant1.address, USDC(51), INR)
    ).to.be.revertedWithCustomError(integrator, "ExceedsPerTxCap");
    // BYPASS CLOSED: passing BRL as the order currency does NOT lift an INR
    // merchant to the 100 cap — 51 still reverts because m.currency is INR.
    await expect(
      integrator.connect(diamond).validateOrder(merchant1.address, USDC(51), BRL)
    ).to.be.revertedWithCustomError(integrator, "ExceedsPerTxCap");

    // A BRL-registered merchant → 100 cap.
    await integrator.connect(merchant2).registerMerchant(enc("joao@pix"), "Café", "BRL");
    expect(await integrator.perTxCap(BRL)).to.equal(USDC(100));
    await expect(integrator.connect(diamond).validateOrder(merchant2.address, USDC(100), BRL)).to
      .not.be.reverted;
    await expect(
      integrator.connect(diamond).validateOrder(merchant2.address, USDC(101), BRL)
    ).to.be.revertedWithCustomError(integrator, "ExceedsPerTxCap");
    // And a BRL merchant can't be forced under the INR cap by passing INR either
    // (still uses their registered 100). 51 ok.
    await expect(integrator.connect(diamond).validateOrder(merchant2.address, USDC(51), INR)).to.not
      .be.reverted;
  });

  it("3c. admin can change the daily limit on-chain (no redeploy)", async function () {
    await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop", INR_CODE);
    const diamond = await diamondSigner();
    expect((await integrator.getDailyTxInfo(merchant1.address))[1]).to.equal(25n);
    // admin lowers to 2
    await expect(integrator.connect(owner).setDailyLimit(2))
      .to.emit(integrator, "DailyLimitSet")
      .withArgs(2);
    expect((await integrator.getDailyTxInfo(merchant1.address))[1]).to.equal(2n);
    await integrator.connect(diamond).validateOrder(merchant1.address, UNIT_PRICE, INR);
    await integrator.connect(diamond).validateOrder(merchant1.address, UNIT_PRICE, INR);
    await expect(
      integrator.connect(diamond).validateOrder(merchant1.address, UNIT_PRICE, INR)
    ).to.be.revertedWithCustomError(integrator, "DailyLimitReached"); // 3rd blocked at limit 2
    // admin raises to 50
    await integrator.connect(owner).setDailyLimit(50);
    expect((await integrator.getDailyTxInfo(merchant1.address))[1]).to.equal(50n);
    // guards: zero rejected, non-admin rejected
    await expect(integrator.connect(owner).setDailyLimit(0)).to.be.revertedWithCustomError(
      integrator,
      "InvalidQuantity"
    );
    await expect(integrator.connect(attacker).setDailyLimit(10)).to.be.revertedWithCustomError(
      integrator,
      "NotAuthorized"
    );
  });

  it("4. validateOrder reverts on the 26th transaction in the same day (25/day limit)", async function () {
    await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", INR_CODE);
    const diamond = await diamondSigner();
    // Drive 25 validated orders via the Diamond (cheaper than 25 full placeOrders).
    for (let i = 0; i < 25; i++) {
      await integrator.connect(diamond).validateOrder(merchant1.address, UNIT_PRICE, INR);
    }
    expect((await integrator.getDailyTxInfo(merchant1.address))[0]).to.equal(25);
    // 26th reverts
    await expect(
      integrator.connect(diamond).validateOrder(merchant1.address, UNIT_PRICE, INR)
    ).to.be.revertedWithCustomError(integrator, "DailyLimitReached");
  });

  it("3b. owner can set a per-currency cap for a NEW country (no redeploy needed)", async function () {
    // Register the merchant IN the new currency so the override applies to them
    // (the cap keys off the merchant's registered currency).
    await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", "MXN");
    const diamond = await diamondSigner();
    const MXN = ethers.encodeBytes32String("MXN");
    // Default: a new currency gets 100 USDC with NO contract change.
    expect(await integrator.perTxCap(MXN)).to.equal(USDC(100));
    // Owner tunes MXN to 75 USDC on-chain (admin dashboard).
    await expect(integrator.connect(owner).setPerTxCap(MXN, USDC(75)))
      .to.emit(integrator, "PerTxCapSet")
      .withArgs(MXN, USDC(75));
    expect(await integrator.perTxCap(MXN)).to.equal(USDC(75));
    // The new cap is enforced for the MXN merchant: 76 reverts, 75 ok.
    await expect(
      integrator.connect(diamond).validateOrder(merchant1.address, USDC(76), MXN)
    ).to.be.revertedWithCustomError(integrator, "ExceedsPerTxCap");
    await expect(integrator.connect(diamond).validateOrder(merchant1.address, USDC(75), MXN)).to.not
      .be.reverted;
    // Clearing (cap=0) falls back to the default 100.
    await integrator.connect(owner).setPerTxCap(MXN, 0);
    expect(await integrator.perTxCap(MXN)).to.equal(USDC(100));
    // Non-manager cannot set caps.
    await expect(
      integrator.connect(attacker).setPerTxCap(MXN, USDC(1))
    ).to.be.revertedWithCustomError(integrator, "NotAuthorized");
  });

  it("5. daily count resets after one day", async function () {
    await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", INR_CODE);
    for (let i = 0; i < 4; i++) await placeOrder(merchant1);
    await increaseTime(DAY + 10);
    expect((await integrator.getDailyTxInfo(merchant1.address))[0]).to.equal(0);
    await placeOrder(merchant1);
    expect((await integrator.getDailyTxInfo(merchant1.address))[0]).to.equal(1);
  });

  // ─── 6 + 7: Completion and balances ────────────────────────────────

  it("6. onOrderComplete creates the correct bucket with unlock = completion + SETTLEMENT_PERIOD", async function () {
    await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", INR_CODE);
    const orderId = await placeOrder(merchant1, 2);
    const tx = await mockDiamond.simulateOrderComplete(orderId);
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt.blockNumber);
    const expectedUnlock = BigInt(block!.timestamp) + BigInt(SETTLEMENT);

    await expect(tx)
      .to.emit(integrator, "OrderCompleted")
      .withArgs(orderId, merchant1.address, USDC(20), expectedUnlock);

    const buckets = await integrator.getMerchantBuckets(merchant1.address);
    expect(buckets.length).to.equal(1);
    expect(buckets[0].amount).to.equal(USDC(20));
    expect(buckets[0].unlockTimestamp).to.equal(expectedUnlock);
    expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(USDC(20));
    expect(await mockUsdc.balanceOf(await integrator.proxyAddress(merchant1.address))).to.equal(0);
  });

  it("6a. LOCK CONFIG: super-admin tunes the settlement hold per-currency and globally, no redeploy", async function () {
    const BRL = ethers.encodeBytes32String("BRL");
    // defaults: global == SETTLEMENT_PERIOD (10 min build), no per-currency override
    expect(await integrator.settlementPeriod()).to.equal(SETTLEMENT);
    expect(await integrator.lockPeriod(INR)).to.equal(SETTLEMENT);
    expect(await integrator.lockPeriodOverride(BRL)).to.equal(0);
    expect(await integrator.lockPeriod(BRL)).to.equal(SETTLEMENT); // falls back to global

    // ── access control: only the super-admin may change locks ──
    await expect(
      integrator.connect(attacker).setSettlementPeriod(3600)
    ).to.be.revertedWithCustomError(integrator, "OnlySuperAdmin");
    await expect(
      integrator.connect(merchant1).setLockPeriod(BRL, 3600)
    ).to.be.revertedWithCustomError(integrator, "OnlySuperAdmin");

    // ── bounds: reject out-of-range values on both setters ──
    const MIN = Number(await integrator.MIN_SETTLEMENT_PERIOD());
    const MAX = Number(await integrator.MAX_SETTLEMENT_PERIOD());
    await expect(integrator.setSettlementPeriod(MIN - 1)).to.be.revertedWithCustomError(
      integrator,
      "InvalidLockPeriod"
    );
    await expect(integrator.setSettlementPeriod(MAX + 1)).to.be.revertedWithCustomError(
      integrator,
      "InvalidLockPeriod"
    );
    await expect(integrator.setLockPeriod(BRL, MIN - 1)).to.be.revertedWithCustomError(
      integrator,
      "InvalidLockPeriod"
    );
    await expect(integrator.setLockPeriod(ethers.ZeroHash, 3600)).to.be.revertedWithCustomError(
      integrator,
      "InvalidCurrency"
    );

    // ── set a new global default (20 min) ──
    await expect(integrator.setSettlementPeriod(1200))
      .to.emit(integrator, "SettlementPeriodSet")
      .withArgs(1200);
    expect(await integrator.lockPeriod(INR)).to.equal(1200); // INR now follows global
    expect(await integrator.lockPeriod(BRL)).to.equal(1200);

    // ── set a per-currency override for BRL (30 min) — INR stays on global ──
    await expect(integrator.setLockPeriod(BRL, 1800))
      .to.emit(integrator, "LockPeriodSet")
      .withArgs(BRL, 1800);
    expect(await integrator.lockPeriod(BRL)).to.equal(1800); // override wins
    expect(await integrator.lockPeriod(INR)).to.equal(1200); // still global

    // ── a real deposit for a BRL merchant uses the BRL hold (1800s), not global ──
    await integrator.connect(merchant2).registerMerchant(enc("joao@pix"), "Café", "BRL");
    const brlOrder = await placeOrder(merchant2, 2); // completed order → a bucket
    const tx = await mockDiamond.simulateOrderComplete(brlOrder);
    const receipt = await tx.wait();
    const blk = await ethers.provider.getBlock(receipt!.blockNumber);
    const buckets = await integrator.getMerchantBuckets(merchant2.address);
    expect(buckets[buckets.length - 1].unlockTimestamp).to.equal(BigInt(blk!.timestamp) + 1800n); // BRL override, not the 1200 global

    // ── clear the BRL override (period 0) → falls back to global again ──
    await expect(integrator.setLockPeriod(BRL, 0))
      .to.emit(integrator, "LockPeriodSet")
      .withArgs(BRL, 0);
    expect(await integrator.lockPeriod(BRL)).to.equal(1200);
  });

  it("6b. PAUSE break-glass: halts NEW activity but NOT recovery; owner-only; no-op guarded", async function () {
    // depositFor registers merchant1 and funds an unlocked balance to withdraw
    await depositFor(merchant1, UPI_1, 3); // 30
    await increaseTime(SETTLEMENT + 100);

    expect(await integrator.paused()).to.equal(false);
    // access control: only an owner can pause; a plain merchant / non-owner cannot
    await expect(integrator.connect(merchant1).pause()).to.be.revertedWithCustomError(
      integrator,
      "OnlyOwner"
    );
    await expect(integrator.connect(attacker).pause()).to.be.revertedWithCustomError(
      integrator,
      "OnlyOwner"
    );
    // unpause when not paused is a no-op guard
    await expect(integrator.unpause()).to.be.revertedWithCustomError(integrator, "PauseUnchanged");

    // pause (any owner) — emits with the caller
    await expect(integrator.pause()).to.emit(integrator, "PausedSet").withArgs(owner.address);
    expect(await integrator.paused()).to.equal(true);
    // double-pause is a no-op guard
    await expect(integrator.pause()).to.be.revertedWithCustomError(integrator, "PauseUnchanged");

    // NEW activity is halted: place order + both fiat withdrawals + USDC withdrawal
    await expect(
      integrator
        .connect(merchant1)
        .userPlaceOrder(await erc721Client.getAddress(), PRODUCT_ID, 1, INR, 1, "")
    ).to.be.revertedWithCustomError(integrator, "Paused");
    await expect(
      integrator.connect(merchant1).withdrawFiat(USDC(5), 1, PK, "")
    ).to.be.revertedWithCustomError(integrator, "Paused");
    await expect(
      integrator.connect(merchant1).withdrawFiatIn(USDC(5), 1, INR, PK)
    ).to.be.revertedWithCustomError(integrator, "Paused");
    await expect(integrator.connect(merchant1).withdrawUSDC(USDC(5))).to.be.revertedWithCustomError(
      integrator,
      "Paused"
    );

    // RECOVERY / admin paths still work while paused — freeze is a safety action
    // and config is unaffected, so an incident can be wound down while paused.
    await expect(integrator.freezeMerchant(merchant1.address)).to.emit(
      integrator,
      "MerchantFrozen"
    );
    await expect(integrator.unfreezeMerchant(merchant1.address)).to.emit(
      integrator,
      "MerchantUnfrozen"
    );
    await expect(integrator.setDailyLimit(30)).to.emit(integrator, "DailyLimitSet");

    // unpause resumes activity
    await expect(integrator.unpause()).to.emit(integrator, "UnpausedSet").withArgs(owner.address);
    expect(await integrator.paused()).to.equal(false);
    await expect(integrator.connect(merchant1).withdrawUSDC(USDC(5))).to.emit(
      integrator,
      "WithdrawalUSDC"
    );
  });

  it("7. getMerchantBalance is correct after a deposit", async function () {
    await depositFor(merchant1, UPI_1, 2);
    const [pending, available, totalDeposited, isFrozen] = await integrator.getMerchantBalance(
      merchant1.address
    );
    expect(pending).to.equal(USDC(20));
    expect(available).to.equal(0);
    expect(totalDeposited).to.equal(USDC(20));
    expect(isFrozen).to.equal(false);
  });

  // ─── 8–11: Withdrawal gating ───────────────────────────────────────

  it("8. withdrawINR reverts before the 30-day settlement", async function () {
    await depositFor(merchant1, UPI_1, 2);
    await expect(
      integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "")
    ).to.be.revertedWithCustomError(integrator, "InsufficientAvailableBalance");
  });

  it("9. withdrawINR succeeds after 30 days (funds the merchant proxy, places SELL order)", async function () {
    await depositFor(merchant1, UPI_1, 2);
    await increaseTime(SETTLEMENT + 3600);

    // SELL is placed through the MERCHANT'S OWN proxy now (per-merchant isolation)
    const merchantProxy = await integrator.proxyAddress(merchant1.address);
    await expect(integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "")).to.emit(
      integrator,
      "WithdrawalFiat"
    );
    expect(await mockUsdc.balanceOf(merchantProxy)).to.equal(USDC(20));
    expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(0);

    const [pending, available] = await integrator.getMerchantBalance(merchant1.address);
    expect(pending).to.equal(0);
    expect(available).to.equal(0);

    const sellOrder = await mockDiamond.getSellOrder(2);
    expect(sellOrder.user).to.equal(merchantProxy);
    expect(sellOrder.amount).to.equal(USDC(20));
    // currency on the SELL order = the merchant's registered currency (INR here)
    expect(sellOrder.currency).to.equal(INR);
  });

  it("9-multi. a BRL merchant's withdrawFiat places the SELL order in BRL (not hardcoded INR)", async function () {
    // Register as Brazil/BRL, deposit, settle, withdraw — the SELL order must
    // carry BRL, proving the currency comes from the merchant's profile.
    const BRL = ethers.encodeBytes32String("BRL");
    await integrator.connect(merchant2).registerMerchant(enc("joao@pix"), "Café Rio", "BRL");
    const orderId = await placeOrder(merchant2, 2);
    await mockDiamond.simulateOrderComplete(orderId);
    await increaseTime(SETTLEMENT + 3600);

    const tx = await integrator.connect(merchant2).withdrawFiat(USDC(20), 1, PK, "");
    const rcpt = await tx.wait();
    const sellId = rcpt.logs
      .map((l: any) => {
        try {
          return integrator.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((l: any) => l?.name === "WithdrawalFiat").args.orderId;

    const sellOrder = await mockDiamond.getSellOrder(sellId);
    expect(sellOrder.currency).to.equal(BRL); // ← BRL, not INR
  });

  it("9-cross. an INR-registered merchant can withdraw IN BRL via withdrawFiatIn (cross-currency)", async function () {
    // The merchant registered India/INR but accepted funds they now want to
    // cash out as BRL to a PIX key. withdrawFiatIn places the SELL in BRL with
    // the chosen payout — proving currency + payout are caller-supplied.
    const BRL = ethers.encodeBytes32String("BRL");
    await depositFor(merchant1, UPI_1, 2); // registered INR
    await increaseTime(SETTLEMENT + 3600);

    const tx = await integrator.connect(merchant1).withdrawFiatIn(USDC(20), 2, BRL, PK);
    const rcpt = await tx.wait();
    const ev = rcpt.logs
      .map((l: any) => {
        try {
          return integrator.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((l: any) => l?.name === "WithdrawalFiat");
    expect(ev.args.currency).to.equal(BRL); // event carries BRL, not INR

    const sell = await mockDiamond.getSellOrder(ev.args.orderId);
    expect(sell.currency).to.equal(BRL); // SELL placed in BRL
    // merchant's registered currency is UNCHANGED (still INR)
    const [, , savedCurrency] = await integrator.getMerchantInfo(merchant1.address);
    expect(savedCurrency).to.equal(ethers.encodeBytes32String("INR"));
  });

  it("9-cross. withdrawFiatIn rejects empty currency or empty pubkey", async function () {
    await depositFor(merchant1, UPI_1, 2);
    await increaseTime(SETTLEMENT + 3600);
    const BRL = ethers.encodeBytes32String("BRL");
    await expect(
      integrator.connect(merchant1).withdrawFiatIn(USDC(5), 2, ethers.ZeroHash, PK)
    ).to.be.revertedWithCustomError(integrator, "InvalidCurrency");
    await expect(
      integrator.connect(merchant1).withdrawFiatIn(USDC(5), 2, BRL, "")
    ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
  });

  it("9-cross. withdrawFiatIn still caps by the merchant's OWN balance (no cross-merchant drain)", async function () {
    // m1 has 20; even choosing any currency, they can't withdraw more than theirs.
    await depositFor(merchant1, UPI_1, 2); // 20
    await increaseTime(SETTLEMENT + 3600);
    const BRL = ethers.encodeBytes32String("BRL");
    await expect(
      integrator.connect(merchant1).withdrawFiatIn(USDC(50), 2, BRL, PK)
    ).to.be.revertedWithCustomError(integrator, "InsufficientAvailableBalance");
  });

  it("9a. withdrawFiat places the SELL with the relay pubkey; saved profile unchanged", async function () {
    await depositFor(merchant1, UPI_1, 2);
    await increaseTime(SETTLEMENT + 3600);

    // The SELL carries the relay pubKey (not the payout); the UPI is delivered
    // later via deliverFiatPayout. Placement should succeed and emit WithdrawalFiat.
    await expect(integrator.connect(merchant1).withdrawFiat(USDC(10), 1, PK, "")).to.emit(
      integrator,
      "WithdrawalFiat"
    );
    // saved profile (payout/shop) is untouched by a withdrawal
    const [savedUpi] = await integrator.getMerchantInfo(merchant1.address);
    expect(savedUpi).to.equal(UPI_1);
  });

  it("9b. INR withdrawal settles through PLACED→PAID→COMPLETED WITH a fee (fee charged to merchant)", async function () {
    // Regression for the SELL fee/allowance bug AND for HIGH-1: the Diamond
    // pulls principal + fee during setSellOrderUpi. The fee top-up is now
    // CHARGED TO THE WITHDRAWING MERCHANT (debited from their own unlocked
    // buckets), never the shared pool — so the merchant needs headroom for it.
    await depositFor(merchant1, UPI_1, 3); // 30 USDC settled
    await increaseTime(SETTLEMENT + 3600);

    const FEE = USDC(1);
    await mockDiamond.setSellFee(FEE);

    // The integrator needs USDC on hand to physically forward the fee. A fresh
    // BUY deposit leaves USDC on the integrator (pulled at onOrderComplete).
    await depositFor(merchant2, UPI_2, 2);

    const merchantProxy = await integrator.proxyAddress(merchant1.address);

    // available before: 30 USDC
    const beforeAvail = (await integrator.getMerchantBalance(merchant1.address))[1];
    expect(beforeAvail).to.equal(USDC(30));

    // 1) place the SELL for 20 — proxy funded with principal only (20)
    const tx = await integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "");
    const rcpt = await tx.wait();
    const ev = rcpt.logs
      .map((l: any) => {
        try {
          return integrator.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((l: any) => l?.name === "WithdrawalFiat");
    const orderId = ev.args.orderId;
    expect(await mockUsdc.balanceOf(merchantProxy)).to.equal(USDC(20)); // principal only

    // after placing: 30 - 20 principal = 10 available (fee not yet charged)
    expect((await integrator.getMerchantBalance(merchant1.address))[1]).to.equal(USDC(10));

    // 2) LP accepts
    await mockDiamond.acceptSellOrder(orderId, "lpPubkey");

    // AUDIT-MED: a stranger CANNOT deliver the payout (would let them front-run
    // with an attacker payload + brick the channel). Only merchant/owner/relayer.
    await expect(
      integrator.connect(attacker).deliverFiatPayout(orderId, "evil")
    ).to.be.revertedWithCustomError(integrator, "OnlyOwner");

    // 3) deliver: tops up the FEE (charged to merchant's own balance) + allowance
    await expect(integrator.connect(merchant1).deliverFiatPayout(orderId, "encUpi"))
      .to.emit(integrator, "WithdrawalUpiDelivered")
      .withArgs(orderId, USDC(21)); // principal 20 + fee 1

    // HIGH-1: the fee was debited from the MERCHANT, not the pool → 10 - 1 = 9
    expect((await integrator.getMerchantBalance(merchant1.address))[1]).to.equal(USDC(9));

    // Diamond pulled principal+fee from the proxy → proxy drained
    expect(await mockUsdc.balanceOf(merchantProxy)).to.equal(0);

    // 4) complete; finalizeWithdrawal flips the tracking slot
    await mockDiamond.completeSellOrder(orderId);
    await integrator.finalizeWithdrawal(orderId);
  });

  it("9c. deliverInrUpi reverts OfframpFeeNotReady until the Diamond computes the fee", async function () {
    await depositFor(merchant1, UPI_1, 2);
    await increaseTime(SETTLEMENT + 3600);
    await mockDiamond.setSellFee(USDC(1));
    await depositFor(merchant2, UPI_2, 2); // fund integrator pool

    const tx = await integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "");
    const rcpt = await tx.wait();
    const orderId = rcpt.logs
      .map((l: any) => {
        try {
          return integrator.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((l: any) => l?.name === "WithdrawalFiat").args.orderId;
    await mockDiamond.acceptSellOrder(orderId, "lp");

    // Diamond hasn't populated actualUsdtAmount yet → must revert, not fall back
    await mockDiamond.setAdditionalOrderDetailsFeeUnready(true);
    await expect(
      integrator.connect(merchant1).deliverFiatPayout(orderId, "encUpi")
    ).to.be.revertedWithCustomError(integrator, "OfframpFeeNotReady");
  });

  it("10. withdrawUSDC reverts before the 30-day settlement", async function () {
    await depositFor(merchant1, UPI_1, 2);
    await expect(
      integrator.connect(merchant1).withdrawUSDC(USDC(20))
    ).to.be.revertedWithCustomError(integrator, "InsufficientAvailableBalance");
  });

  it("11. withdrawUSDC succeeds after 30 days (USDC to the merchant wallet)", async function () {
    await depositFor(merchant1, UPI_1, 2);
    await increaseTime(SETTLEMENT + 3600);

    const before = await mockUsdc.balanceOf(merchant1.address);
    await expect(integrator.connect(merchant1).withdrawUSDC(USDC(20)))
      .to.emit(integrator, "WithdrawalUSDC")
      .withArgs(merchant1.address, USDC(20));
    const after = await mockUsdc.balanceOf(merchant1.address);

    expect(after - before).to.equal(USDC(20));
    expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(0);
    const [pending, available] = await integrator.getMerchantBalance(merchant1.address);
    expect(pending).to.equal(0);
    expect(available).to.equal(0);
  });

  it("11a. NO ROUNDING/DRIFT: totalOwed == Σ buckets == custody, exactly, across deposit→withdraw→fee→recredit (odd amounts)", async function () {
    // The accounting has NO division in any value path (only add/subtract/min), so
    // there is no place a rounding residue can appear. This test PROVES it: at every
    // step, totalOwed must equal the exact sum of every merchant's bucket amounts,
    // AND the physical custody (the integrator's own USDC balance) must cover it to
    // the wei. We use ODD amounts and an ODD fee so any rounding would show up as a
    // 1-wei divergence.
    const custody = async () => await mockUsdc.balanceOf(await integrator.getAddress());
    const sumBuckets = async (m: string) => {
      const bs = await integrator.getMerchantBuckets(m);
      return bs.reduce((acc: bigint, b: any) => acc + b.amount, 0n);
    };
    // invariant check: totalOwed == Σ(all merchants' buckets) AND custody >= totalOwed
    const checkInvariant = async () => {
      const owed = await integrator.totalOwed();
      const bucketSum =
        (await sumBuckets(merchant1.address)) + (await sumBuckets(merchant2.address));
      expect(bucketSum, "totalOwed must equal the exact sum of all buckets (no drift)").to.equal(
        owed
      );
      expect(await custody(), "custody must cover totalOwed to the wei").to.be.gte(owed);
    };

    // Two merchants deposit round 10-USDC multiples (the test client's unit price).
    await depositFor(merchant1, UPI_1, 3); // 30
    await depositFor(merchant2, UPI_2, 2); // 20 (funds the fee pool too)
    await checkInvariant();
    expect(await integrator.totalOwed()).to.equal(USDC(50));

    await increaseTime(SETTLEMENT + 3600);

    // Merchant1 withdraws an ODD principal as USDC — subtraction only, no residue.
    await integrator.connect(merchant1).withdrawUSDC(USDC(7)); // 30 → 23
    await checkInvariant();

    // A fiat withdrawal with an ODD fee (1.234567 USDC) — the fee is debited from the
    // merchant's own buckets (subtract) and advanced from the pool; totalOwed drops by
    // exactly principal+fee, custody drops by the same. No rounding anywhere.
    const ODD_FEE = ethers.parseUnits("1.234567", 6);
    await mockDiamond.setSellFee(ODD_FEE);
    const tx = await integrator
      .connect(merchant1)
      .withdrawFiat(ethers.parseUnits("3.5", 6), 1, PK, "");
    const rcpt = await tx.wait();
    const orderId = rcpt.logs
      .map((l: any) => {
        try {
          return integrator.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((l: any) => l?.name === "WithdrawalFiat").args.orderId;
    await checkInvariant(); // principal escrowed off buckets; still exact

    await mockDiamond.acceptSellOrder(orderId, "lp");
    await integrator.connect(merchant1).deliverFiatPayout(orderId, "enc"); // fee debited (odd)
    await checkInvariant(); // totalOwed dropped by principal+odd-fee, still exact

    // Cancel → refund principal+fee to the proxy → reconcile re-credits EXACTLY the
    // physical refund (min(owedBack, proxyBal)); no over/under-credit, no residue.
    await mockDiamond.cancelSellOrder(orderId);
    await integrator.reconcileWithdrawal(orderId);
    await checkInvariant();

    // Final: drain merchant2 entirely and confirm the invariant holds at zero.
    await integrator.connect(merchant2).withdrawUSDC(USDC(20));
    await checkInvariant();
  });

  // ─── 12: Freeze ────────────────────────────────────────────────────

  it("12. a frozen merchant cannot withdraw even after 30 days", async function () {
    await depositFor(merchant1, UPI_1, 2);
    await increaseTime(SETTLEMENT + 3600);

    await expect(integrator.freezeMerchant(merchant1.address))
      .to.emit(integrator, "MerchantFrozen")
      .withArgs(merchant1.address);

    await expect(
      integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "")
    ).to.be.revertedWithCustomError(integrator, "MerchantIsFrozen");
    await expect(
      integrator.connect(merchant1).withdrawUSDC(USDC(20))
    ).to.be.revertedWithCustomError(integrator, "MerchantIsFrozen");

    await expect(integrator.unfreezeMerchant(merchant1.address))
      .to.emit(integrator, "MerchantUnfrozen")
      .withArgs(merchant1.address);
    await integrator.connect(merchant1).withdrawUSDC(USDC(20));
  });

  it("12a. ESCHEAT: a 90-day continuously-frozen merchant's funds are super-admin-recoverable (never permanently lost)", async function () {
    const ESCHEAT = 90 * DAY;
    await depositFor(merchant1, UPI_1, 3); // 30 (some locked, some soon-unlocked)
    await depositFor(merchant2, UPI_2, 2); // 20 — a bystander who must NOT be touched
    const treasury = attacker; // any address the super-admin chooses as destination

    // Not frozen → not escheatable (clock not running).
    expect(await integrator.escheatableAt(merchant1.address)).to.equal(0);
    await expect(
      integrator.adminEscheat(merchant1.address, treasury.address)
    ).to.be.revertedWithCustomError(integrator, "NotEscheatable");

    // Freeze → clock starts; escheatableAt = frozenAt + 90d.
    const fzTx = await integrator.freezeMerchant(merchant1.address);
    const fzBlk = await ethers.provider.getBlock((await fzTx.wait()).blockNumber);
    expect(await integrator.escheatableAt(merchant1.address)).to.equal(
      BigInt(fzBlk!.timestamp) + BigInt(ESCHEAT)
    );

    // Before 90 days → still not escheatable.
    await increaseTime(ESCHEAT - 3600);
    await expect(
      integrator.adminEscheat(merchant1.address, treasury.address)
    ).to.be.revertedWithCustomError(integrator, "NotEscheatable");

    // UNFREEZE RESETS the clock: even long after, a fresh freeze restarts 90 days.
    await integrator.unfreezeMerchant(merchant1.address);
    expect(await integrator.escheatableAt(merchant1.address)).to.equal(0);
    await integrator.freezeMerchant(merchant1.address); // clock restarts here
    await increaseTime(ESCHEAT - 100); // just shy of the new window
    await expect(
      integrator.adminEscheat(merchant1.address, treasury.address)
    ).to.be.revertedWithCustomError(integrator, "NotEscheatable"); // reset worked

    // Cross the full continuous 90 days from the LAST freeze.
    await increaseTime(200);

    // Access control: only the super-admin (not a mere FINANCE admin) can escheat.
    await integrator.connect(owner).setRole(merchant2.address, 4); // FINANCE
    await expect(
      integrator.connect(merchant2).adminEscheat(merchant1.address, treasury.address)
    ).to.be.revertedWithCustomError(integrator, "OnlySuperAdmin");
    await integrator.connect(owner).setRole(merchant2.address, 0);

    // Snapshot solvency before: totalOwed == custody balance; capture merchant1's full balance.
    const owedBefore = await integrator.totalOwed();
    const custodyBefore = await mockUsdc.balanceOf(await integrator.getAddress());
    const [pending1, avail1] = await integrator.getMerchantBalance(merchant1.address);
    const m1Full = pending1 + avail1; // ENTIRE balance (locked + unlocked)
    expect(m1Full).to.equal(USDC(30));
    const treasuryBefore = await mockUsdc.balanceOf(treasury.address);

    // ESCHEAT: super-admin recovers merchant1's entire balance to the treasury.
    await expect(integrator.adminEscheat(merchant1.address, treasury.address))
      .to.emit(integrator, "MerchantEscheated")
      .withArgs(merchant1.address, treasury.address, USDC(30));

    // Funds moved out to the chosen destination, exactly.
    expect((await mockUsdc.balanceOf(treasury.address)) - treasuryBefore).to.equal(USDC(30));
    // Merchant1 is zeroed.
    const [p2, a2] = await integrator.getMerchantBalance(merchant1.address);
    expect(p2 + a2).to.equal(0);
    expect((await integrator.getMerchantBuckets(merchant1.address)).length).to.equal(0);
    // totalOwed dropped by EXACTLY merchant1's balance; solvency still holds.
    expect(await integrator.totalOwed()).to.equal(owedBefore - USDC(30));
    expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(
      custodyBefore - USDC(30)
    );
    expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.be.gte(
      await integrator.totalOwed()
    );
    // Bystander merchant2 is completely untouched.
    const [pB, aB] = await integrator.getMerchantBalance(merchant2.address);
    expect(pB + aB).to.equal(USDC(20));

    // Cannot double-escheat (balance is now 0).
    await expect(
      integrator.adminEscheat(merchant1.address, treasury.address)
    ).to.be.revertedWithCustomError(integrator, "NothingToEscheat");
    // Reverts on zero destination.
    await expect(
      integrator.adminEscheat(merchant2.address, ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
  });

  // ─── 13: Isolation ─────────────────────────────────────────────────

  it("13. two merchants' balances never cross-contaminate", async function () {
    await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", INR_CODE);
    await integrator.connect(merchant2).registerMerchant(UPI_2, "Shop Two", INR_CODE);

    const order1 = await placeOrder(merchant1, 2);
    const order2 = await placeOrder(merchant2, 3);
    await mockDiamond.simulateOrderComplete(order1);
    await mockDiamond.simulateOrderComplete(order2);

    expect((await integrator.getMerchantBalance(merchant1.address))[0]).to.equal(USDC(20));
    expect((await integrator.getMerchantBalance(merchant2.address))[0]).to.equal(USDC(30));

    await increaseTime(SETTLEMENT + 3600);
    await integrator.connect(merchant2).withdrawUSDC(USDC(30));

    expect((await integrator.getMerchantBalance(merchant1.address))[1]).to.equal(USDC(20));
    expect((await integrator.getMerchantBalance(merchant2.address))[1]).to.equal(0);
    expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(USDC(20));
    await integrator.connect(merchant1).withdrawUSDC(USDC(20));
    await expect(integrator.connect(merchant1).withdrawUSDC(USDC(1))).to.be.revertedWithCustomError(
      integrator,
      "InsufficientAvailableBalance"
    );
  });

  // ─── 14: Cancellation ──────────────────────────────────────────────

  it("14. onOrderCancel decrements the daily tx count (and never double-decrements)", async function () {
    await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", INR_CODE);
    const order1 = await placeOrder(merchant1);
    await placeOrder(merchant1);
    expect((await integrator.getDailyTxInfo(merchant1.address))[0]).to.equal(2);

    await expect(mockDiamond.simulateOrderCancelled(order1))
      .to.emit(integrator, "OrderCancelled")
      .withArgs(order1, merchant1.address);
    expect((await integrator.getDailyTxInfo(merchant1.address))[0]).to.equal(1);

    const diamond = await diamondSigner();
    await integrator.connect(diamond).onOrderCancel(order1);
    expect((await integrator.getDailyTxInfo(merchant1.address))[0]).to.equal(1);
    await integrator.connect(diamond).onOrderCancel(999);
  });

  // ─── SECURITY / HARDENING TESTS ─────────────────────────────────────

  describe("access control", function () {
    it("validateOrder rejects non-Diamond callers", async function () {
      await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", INR_CODE);
      await expect(
        integrator.connect(attacker).validateOrder(merchant1.address, UNIT_PRICE, INR)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
    });

    it("onOrderComplete rejects non-Diamond callers", async function () {
      await expect(
        integrator
          .connect(attacker)
          .onOrderComplete(1, merchant1.address, USDC(10), merchant1.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
    });

    it("onOrderCancel rejects non-Diamond callers", async function () {
      await expect(integrator.connect(attacker).onOrderCancel(1)).to.be.revertedWithCustomError(
        integrator,
        "OnlyDiamond"
      );
    });

    it("freeze/unfreeze reject non-admin callers (need SUPPORT+)", async function () {
      await expect(
        integrator.connect(attacker).freezeMerchant(merchant1.address)
      ).to.be.revertedWithCustomError(integrator, "NotAuthorized");
      await expect(
        integrator.connect(attacker).unfreezeMerchant(merchant1.address)
      ).to.be.revertedWithCustomError(integrator, "NotAuthorized");
    });

    it("multi-admin: owner adds an admin who can freeze; non-admin cannot; owner-only mgmt", async function () {
      await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop", INR_CODE);
      // Initially merchant2 is not an admin → cannot freeze.
      await expect(
        integrator.connect(merchant2).freezeMerchant(merchant1.address)
      ).to.be.revertedWithCustomError(integrator, "NotAuthorized");
      expect(await integrator.isAdmin(merchant2.address)).to.equal(false);

      // Owner adds merchant2 as an admin.
      await expect(integrator.connect(owner).addAdmin(merchant2.address))
        .to.emit(integrator, "AdminAdded")
        .withArgs(merchant2.address);
      expect(await integrator.isAdmin(merchant2.address)).to.equal(true);

      // Now merchant2 (admin) CAN freeze/unfreeze.
      await expect(integrator.connect(merchant2).freezeMerchant(merchant1.address)).to.emit(
        integrator,
        "MerchantFrozen"
      );
      await integrator.connect(merchant2).unfreezeMerchant(merchant1.address);

      // But an admin CANNOT add/remove admins or transfer ownership (super-admin only).
      await expect(
        integrator.connect(merchant2).addAdmin(attacker.address)
      ).to.be.revertedWithCustomError(integrator, "OnlySuperAdmin");
      await expect(
        integrator.connect(merchant2).transferOwnership(attacker.address)
      ).to.be.revertedWithCustomError(integrator, "OnlySuperAdmin");

      // Owner removes the admin → can no longer freeze.
      await integrator.connect(owner).removeAdmin(merchant2.address);
      expect(await integrator.isAdmin(merchant2.address)).to.equal(false);
      await expect(
        integrator.connect(merchant2).freezeMerchant(merchant1.address)
      ).to.be.revertedWithCustomError(integrator, "NotAuthorized");
    });

    it("5-tier RBAC: VIEWER < SUPPORT < MANAGER < FINANCE, hierarchical, owner=FINANCE", async function () {
      await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop", INR_CODE);
      const MXN = ethers.encodeBytes32String("MXN");
      const admin = merchant2;

      // ── VIEWER (1): read-only. No write action. ──
      await expect(integrator.connect(owner).setRole(admin.address, 1))
        .to.emit(integrator, "AdminRoleSet")
        .withArgs(admin.address, 1);
      expect(await integrator.isAdmin(admin.address)).to.equal(true);
      expect(await integrator.isManager(admin.address)).to.equal(false);
      expect(await integrator.isFinance(admin.address)).to.equal(false);
      expect(await integrator.roleOf(admin.address)).to.equal(1);
      // VIEWER cannot even freeze (needs SUPPORT).
      await expect(
        integrator.connect(admin).freezeMerchant(merchant1.address)
      ).to.be.revertedWithCustomError(integrator, "NotAuthorized");
      await expect(
        integrator.connect(admin).setPerTxCap(MXN, USDC(75))
      ).to.be.revertedWithCustomError(integrator, "NotAuthorized");

      // ── SUPPORT (2): + freeze/unfreeze, still no money/config. ──
      await integrator.connect(owner).setRole(admin.address, 2);
      expect(await integrator.roleOf(admin.address)).to.equal(2);
      await expect(integrator.connect(admin).freezeMerchant(merchant1.address)).to.emit(
        integrator,
        "MerchantFrozen"
      );
      await integrator.connect(admin).unfreezeMerchant(merchant1.address);
      await expect(
        integrator.connect(admin).setPerTxCap(MXN, USDC(75))
      ).to.be.revertedWithCustomError(integrator, "NotAuthorized");
      await expect(integrator.connect(admin).adminAbortWithdrawal(1)).to.be.revertedWithCustomError(
        integrator,
        "NotAuthorized"
      );

      // ── MANAGER (3): + caps/limit/relayer AND still freeze (hierarchical). ──
      await integrator.connect(owner).setRole(admin.address, 3);
      expect(await integrator.isManager(admin.address)).to.equal(true);
      expect(await integrator.roleOf(admin.address)).to.equal(3);
      await expect(integrator.connect(admin).setPerTxCap(MXN, USDC(75))).to.emit(
        integrator,
        "PerTxCapSet"
      );
      await integrator.connect(admin).setDailyLimit(10);
      await integrator.connect(admin).freezeMerchant(merchant1.address); // still can (lower tier)
      await integrator.connect(admin).unfreezeMerchant(merchant1.address);
      // But NOT money-recovery (needs FINANCE).
      await expect(integrator.connect(admin).adminAbortWithdrawal(1)).to.be.revertedWithCustomError(
        integrator,
        "NotAuthorized"
      );
      await expect(integrator.connect(admin).adminForceSettle(1)).to.be.revertedWithCustomError(
        integrator,
        "NotAuthorized"
      );

      // ── FINANCE (4): + money recovery. (abort reverts on unknown id, but with
      //    a DIFFERENT error than NotAuthorized — proving the gate now passes.) ──
      await integrator.connect(owner).setRole(admin.address, 4);
      expect(await integrator.isFinance(admin.address)).to.equal(true);
      expect(await integrator.roleOf(admin.address)).to.equal(4);
      await expect(
        integrator.connect(admin).adminAbortWithdrawal(999999)
      ).to.be.revertedWithCustomError(integrator, "UnknownWithdrawal");

      // No tier can manage roles / ownership (super-admin only).
      await expect(
        integrator.connect(admin).setRole(attacker.address, 2)
      ).to.be.revertedWithCustomError(integrator, "OnlySuperAdmin");
      await expect(
        integrator.connect(admin).transferOwnership(attacker.address)
      ).to.be.revertedWithCustomError(integrator, "OnlySuperAdmin");

      // ── Revoke (0). ──
      await integrator.connect(owner).setRole(admin.address, 0);
      expect(await integrator.isAdmin(admin.address)).to.equal(false);
      expect(await integrator.roleOf(admin.address)).to.equal(0);
      await expect(
        integrator.connect(admin).freezeMerchant(merchant1.address)
      ).to.be.revertedWithCustomError(integrator, "NotAuthorized");

      // Owner reads as FINANCE (4, top tier) and satisfies every check.
      expect(await integrator.roleOf(owner.address)).to.equal(4);
      expect(await integrator.isManager(owner.address)).to.equal(true);
      expect(await integrator.isFinance(owner.address)).to.equal(true);

      // Back-compat: addAdmin grants the full (FINANCE) tier.
      await integrator.connect(owner).addAdmin(attacker.address);
      expect(await integrator.roleOf(attacker.address)).to.equal(4);
      await integrator.connect(owner).removeAdmin(attacker.address);
      expect(await integrator.roleOf(attacker.address)).to.equal(0);
    });

    it("transferOwnership adds new owner but NEVER drops the super-admin caller", async function () {
      // Only the super-admin (deployer) may call; a non-super-admin owner cannot.
      await integrator.connect(owner).addOwner(merchant2.address);
      await expect(
        integrator.connect(merchant2).transferOwnership(attacker.address)
      ).to.be.revertedWithCustomError(integrator, "OnlySuperAdmin");
      await expect(
        integrator.connect(attacker).transferOwnership(attacker.address)
      ).to.be.revertedWithCustomError(integrator, "OnlySuperAdmin");
      await expect(
        integrator.connect(owner).transferOwnership(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      // Super-admin "hands off" to merchant1 — merchant1 becomes an owner, but the
      // super-admin is NOT dropped (root control must stay with the super-admin).
      await integrator.connect(owner).transferOwnership(merchant1.address);
      expect(await integrator.isOwner(merchant1.address)).to.equal(true);
      expect(await integrator.isOwner(owner.address)).to.equal(true); // super-admin retained
      expect(await integrator.superAdmin()).to.equal(owner.address);
      // The new owner still cannot manage admins — that's super-admin only.
      await expect(
        integrator.connect(merchant1).addAdmin(attacker.address)
      ).to.be.revertedWithCustomError(integrator, "OnlySuperAdmin");
    });

    it("MULTI-OWNER: only super-admin manages the owner set; owners get FINANCE but not governance", async function () {
      // Deployer is the sole owner AND the super-admin initially.
      expect(await integrator.isOwner(owner.address)).to.equal(true);
      expect(await integrator.superAdmin()).to.equal(owner.address);
      expect(await integrator.ownerCount()).to.equal(1);
      // Super-admin adds a second owner → it gets full FINANCE-tier access...
      await expect(integrator.connect(owner).addOwner(merchant2.address))
        .to.emit(integrator, "OwnerAdded")
        .withArgs(merchant2.address);
      expect(await integrator.isOwner(merchant2.address)).to.equal(true);
      expect(await integrator.roleOf(merchant2.address)).to.equal(4); // FINANCE (top)
      // ...but a NON-super-admin owner canNOT manage roles or owners.
      await expect(
        integrator.connect(merchant2).setRole(merchant1.address, 2)
      ).to.be.revertedWithCustomError(integrator, "OnlySuperAdmin");
      await expect(
        integrator.connect(merchant2).addOwner(attacker.address)
      ).to.be.revertedWithCustomError(integrator, "OnlySuperAdmin");
      await expect(
        integrator.connect(merchant2).removeOwner(owner.address)
      ).to.be.revertedWithCustomError(integrator, "OnlySuperAdmin");
      await expect(
        integrator.connect(merchant2).addAdmin(attacker.address)
      ).to.be.revertedWithCustomError(integrator, "OnlySuperAdmin");
      await expect(
        integrator.connect(merchant2).removeAdmin(attacker.address)
      ).to.be.revertedWithCustomError(integrator, "OnlySuperAdmin");
      // ...BUT a non-super-admin owner DOES keep every FINANCE-tier OPERATIONAL
      // power (the re-gating lifted only GOVERNANCE to the super-admin — it must
      // NOT have stripped owners of their day-to-day admin actions). Prove it:
      await expect(integrator.connect(merchant2).freezeMerchant(merchant1.address))
        .to.emit(integrator, "MerchantFrozen")
        .withArgs(merchant1.address);
      await expect(integrator.connect(merchant2).unfreezeMerchant(merchant1.address))
        .to.emit(integrator, "MerchantUnfrozen")
        .withArgs(merchant1.address);
      await expect(integrator.connect(merchant2).setDailyLimit(30))
        .to.emit(integrator, "DailyLimitSet")
        .withArgs(30);
      // ...and canNOT manage the owner set (governance: super-admin only).
      await expect(
        integrator.connect(merchant2).addOwner(attacker.address)
      ).to.be.revertedWithCustomError(integrator, "OnlySuperAdmin");
      // A non-owner likewise cannot.
      await expect(
        integrator.connect(merchant1).addOwner(merchant1.address)
      ).to.be.revertedWithCustomError(integrator, "OnlySuperAdmin");
      // Super-admin adds a third owner then removes down.
      await integrator.connect(owner).addOwner(attacker.address);
      expect(await integrator.ownerCount()).to.equal(3);
      await integrator.connect(owner).removeOwner(attacker.address);
      await integrator.connect(owner).removeOwner(merchant2.address);
      expect(await integrator.ownerCount()).to.equal(1);
      // The super-admin can never be removed as an owner (even by itself).
      await expect(
        integrator.connect(owner).removeOwner(owner.address)
      ).to.be.revertedWithCustomError(integrator, "CannotRemoveSuperAdmin");
    });

    it("SUPER-ADMIN: unremovable + undemotable; handoff via transferSuperAdmin only", async function () {
      // The super-admin is the deployer and is also an owner.
      expect(await integrator.superAdmin()).to.equal(owner.address);
      expect(await integrator.isOwner(owner.address)).to.equal(true);
      // Cannot demote the super-admin via setRole.
      await expect(
        integrator.connect(owner).setRole(owner.address, 0)
      ).to.be.revertedWithCustomError(integrator, "CannotRemoveSuperAdmin");
      // Only the super-admin can PROPOSE a handoff; others cannot.
      await expect(
        integrator.connect(attacker).transferSuperAdmin(attacker.address)
      ).to.be.revertedWithCustomError(integrator, "OnlySuperAdmin");
      await expect(
        integrator.connect(owner).transferSuperAdmin(owner.address)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress"); // no-op handoff
      // AUDIT FIX B — TWO-STEP handoff. Proposing does NOT move root yet.
      await expect(integrator.connect(owner).transferSuperAdmin(merchant2.address))
        .to.emit(integrator, "SuperAdminTransferStarted")
        .withArgs(owner.address, merchant2.address);
      expect(await integrator.superAdmin()).to.equal(owner.address); // unchanged until accept
      expect(await integrator.pendingSuperAdmin()).to.equal(merchant2.address);
      // A non-pending address cannot accept.
      await expect(integrator.connect(attacker).acceptSuperAdmin()).to.be.revertedWithCustomError(
        integrator,
        "OnlySuperAdmin"
      );
      // The pending address accepts → it becomes super-admin AND an owner; the
      // previous super-admin stays an owner (not auto-evicted); pending clears.
      await expect(integrator.connect(merchant2).acceptSuperAdmin())
        .to.emit(integrator, "SuperAdminTransferred")
        .withArgs(owner.address, merchant2.address);
      expect(await integrator.superAdmin()).to.equal(merchant2.address);
      expect(await integrator.pendingSuperAdmin()).to.equal(ethers.ZeroAddress);
      expect(await integrator.isOwner(merchant2.address)).to.equal(true);
      expect(await integrator.isOwner(owner.address)).to.equal(true); // previous retained as owner
      // The OLD super-admin can no longer manage roles/owners.
      await expect(
        integrator.connect(owner).setRole(merchant1.address, 2)
      ).to.be.revertedWithCustomError(integrator, "OnlySuperAdmin");
      // The NEW super-admin can, and can now remove the old one as a plain owner.
      await integrator.connect(merchant2).setRole(merchant1.address, 2);
      expect(await integrator.roleOf(merchant1.address)).to.equal(2);
      await integrator.connect(merchant2).removeOwner(owner.address);
      expect(await integrator.isOwner(owner.address)).to.equal(false);
    });

    it("constructor rejects zero diamond/usdc; seeds extra owners", async function () {
      const Integrator = await ethers.getContractFactory("MerchantTerminalIntegrator");
      await expect(
        Integrator.deploy(ethers.ZeroAddress, await mockUsdc.getAddress(), [])
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      await expect(
        Integrator.deploy(await mockDiamond.getAddress(), ethers.ZeroAddress, [])
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      // Seed extra owners at construction.
      const ig2 = await Integrator.deploy(
        await mockDiamond.getAddress(),
        await mockUsdc.getAddress(),
        [merchant1.address, merchant2.address]
      );
      expect(await ig2.isOwner(owner.address)).to.equal(true); // deployer
      expect(await ig2.isOwner(merchant1.address)).to.equal(true);
      expect(await ig2.isOwner(merchant2.address)).to.equal(true);
      expect(await ig2.ownerCount()).to.equal(3);
    });

    it("AUDIT-FIX: transferOwnership(self) is rejected, not a silent self-eviction", async function () {
      // Two owners so the drop-caller branch is live.
      await integrator.connect(owner).addOwner(merchant2.address);
      expect(await integrator.ownerCount()).to.equal(2);
      // Owner hands off "to self" — must revert, NOT strip the caller.
      await expect(
        integrator.connect(owner).transferOwnership(owner.address)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");
      // Caller is still an owner; set is unchanged.
      expect(await integrator.isOwner(owner.address)).to.equal(true);
      expect(await integrator.ownerCount()).to.equal(2);
    });
  });

  describe("H-1: INTERNAL CUSTODY + drain-based upgrade (no external vault, no fund migration)", function () {
    it("CUSTODY: a BUY completion holds the merchant's USDC on the integrator itself (solvency: balanceOf(this) == totalOwed)", async function () {
      // A completed BUY sweeps the merchant proxy's USDC into the integrator's own
      // balance — funds and accounting live in ONE contract. No vault, no forward.
      await depositFor(merchant1, UPI_1, 2); // 20 USDC → totalOwed = 20

      expect(await integrator.totalOwed()).to.equal(USDC(20));
      const [pending, available] = await integrator.getMerchantBalance(merchant1.address);
      expect(pending + available).to.equal(USDC(20));
      // The USDC is custodied ON THE INTEGRATOR (not on a vault, not on the proxy).
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(USDC(20));
      const proxy = await integrator.proxyAddress(merchant1.address);
      expect(await mockUsdc.balanceOf(proxy)).to.equal(0);
      // Hard solvency invariant: physical custody >= what merchants are owed.
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.be.gte(
        await integrator.totalOwed()
      );
    });

    it("CUSTODY: withdrawUSDC pays straight from the integrator's own balance and preserves solvency", async function () {
      await depositFor(merchant1, UPI_1, 2); // 20 USDC
      await increaseTime(SETTLEMENT + 100);

      await integrator.connect(merchant1).withdrawUSDC(USDC(20));
      expect(await mockUsdc.balanceOf(merchant1.address)).to.equal(USDC(20));
      // Contract drained exactly what it owed; invariant still holds (0 >= 0).
      expect(await integrator.totalOwed()).to.equal(0);
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(0);
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.be.gte(
        await integrator.totalOwed()
      );
    });

    it("UPGRADE (drain-in-place): the OLD integrator keeps its funds + records and merchants withdraw from it AFTER a new integrator is deployed — no cross-contract migration", async function () {
      // Old integrator (from beforeEach) accrues a balance for two merchants.
      await depositFor(merchant1, UPI_1, 2); // 20 USDC
      await depositFor(merchant2, UPI_2, 3); // 30 USDC
      expect(await integrator.totalOwed()).to.equal(USDC(50));
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(USDC(50));

      // Deploy a brand-new integrator (the "upgrade"). It is EMPTY — no funds and
      // no records copied over. Nothing is migrated; nothing needs to be.
      const Integrator = await ethers.getContractFactory("MerchantTerminalIntegrator");
      const next = await Integrator.deploy(
        await mockDiamond.getAddress(),
        await mockUsdc.getAddress(),
        []
      );
      expect(await next.totalOwed()).to.equal(0);
      expect(await mockUsdc.balanceOf(await next.getAddress())).to.equal(0);

      // The OLD integrator is untouched by the new deployment — it still holds its
      // own USDC and its own per-merchant records, so both merchants drain it
      // normally. THIS is why internal custody can't strand funds on upgrade.
      await increaseTime(SETTLEMENT + 100);
      await integrator.connect(merchant1).withdrawUSDC(USDC(20));
      await integrator.connect(merchant2).withdrawUSDC(USDC(30));
      expect(await mockUsdc.balanceOf(merchant1.address)).to.equal(USDC(20));
      expect(await mockUsdc.balanceOf(merchant2.address)).to.equal(USDC(30));
      // Old integrator fully drained; new one handles all new business.
      expect(await integrator.totalOwed()).to.equal(0);
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(0);
    });

    it("UPGRADE (dormant leftover): a merchant who never withdraws is recovered from the OLD integrator via adminEscheat after the 90-day freeze — nothing stuck forever", async function () {
      // Merchant accrues a balance and then never withdraws (abandoned).
      await depositFor(merchant1, UPI_1, 2); // 20 USDC
      expect(await integrator.totalOwed()).to.equal(USDC(20));

      // Freeze and wait out the full continuous 90-day dormancy window.
      await integrator.connect(owner).freezeMerchant(merchant1.address);
      await increaseTime(90 * 24 * 60 * 60 + 100);

      // Super-admin sweeps the abandoned balance to a recovery destination, out of
      // the old integrator's own custody. Solvency preserved throughout.
      await expect(integrator.connect(owner).adminEscheat(merchant1.address, owner.address))
        .to.emit(integrator, "MerchantEscheated")
        .withArgs(merchant1.address, owner.address, USDC(20));
      expect(await mockUsdc.balanceOf(owner.address)).to.equal(USDC(20));
      // Old integrator now empty and fully retireable.
      expect(await integrator.totalOwed()).to.equal(0);
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(0);
    });

    it("NO custody-migration primitives exist (setVault / flushToVault / migrateState were removed)", async function () {
      // These functions are intentionally gone — with internal custody there is no
      // external vault to point at and no cross-contract fund migration to get wrong.
      expect((integrator as any).setVault).to.equal(undefined);
      expect((integrator as any).flushToVault).to.equal(undefined);
      expect((integrator as any).migrateState).to.equal(undefined);
      expect((integrator as any).vault).to.equal(undefined);
    });

    it("constructor seeds superAdmin = deployer and emits SuperAdminTransferred(0, deployer)", async function () {
      const Integrator = await ethers.getContractFactory("MerchantTerminalIntegrator");
      const fresh = await Integrator.deploy(
        await mockDiamond.getAddress(),
        await mockUsdc.getAddress(),
        []
      );
      // superAdmin is the deployer (the connected signer), who is also an owner.
      expect(await fresh.superAdmin()).to.equal(owner.address);
      expect(await fresh.isOwner(owner.address)).to.equal(true);
      // The construction tx logs the initial handoff from address(0).
      const ev = fresh.interface.getEvent("SuperAdminTransferred");
      const logs = await ethers.provider.getLogs({
        address: await fresh.getAddress(),
        topics: [ev!.topicHash],
        fromBlock: 0,
        toBlock: "latest",
      });
      const parsed = logs.map((l) => fresh.interface.parseLog(l)!);
      const seed = parsed.find((p) => p.args.previous === ethers.ZeroAddress);
      expect(seed, "constructor should emit SuperAdminTransferred(0, deployer)").to.not.equal(
        undefined
      );
      expect(seed!.args.next).to.equal(owner.address);
    });

    it("super-admin cannot be re-roled to ANY tier (not just demoted to NONE)", async function () {
      // The role-0 (demote) case is covered elsewhere; also block promoting/setting
      // any non-zero tier on the super-admin (its access never comes from adminRole).
      await expect(
        integrator.connect(owner).setRole(owner.address, 4)
      ).to.be.revertedWithCustomError(integrator, "CannotRemoveSuperAdmin");
      await expect(
        integrator.connect(owner).setRole(owner.address, 2)
      ).to.be.revertedWithCustomError(integrator, "CannotRemoveSuperAdmin");
    });
  });

  describe("Finding 1+2: stranded-BUY recovery + onOrderComplete idempotency", function () {
    // Helper: register a merchant and place a BUY, but DO NOT complete it — returns
    // the orderId so a test can complete it with or without the callback.
    async function placeBuyOnly(
      merchant: SignerWithAddress,
      upi: string,
      quantity = 2
    ): Promise<bigint> {
      await integrator.connect(merchant).registerMerchant(upi, "Shop", INR_CODE);
      return placeOrder(merchant, quantity);
    }

    it("Finding 2: a duplicate onOrderComplete for the same id reverts (no double-credit)", async function () {
      const orderId = await depositFor(merchant1, UPI_1, 2); // completes once → 20 USDC
      expect(await integrator.totalOwed()).to.equal(USDC(20));
      expect(await integrator.orderCompleted(orderId)).to.equal(true);

      // A second completion for the SAME id must not credit again. Drive the
      // callback directly as the Diamond so we exercise the integrator guard (the
      // mock's own simulateOrderComplete would revert earlier on "Already completed").
      const proxy = await integrator.proxyAddress(merchant1.address);
      const ds = await diamondSigner();
      await expect(
        integrator.connect(ds).onOrderComplete(orderId, merchant1.address, USDC(20), proxy)
      ).to.be.revertedWithCustomError(integrator, "WithdrawalAlreadySettled");
      // totalOwed unchanged — no phantom second credit.
      expect(await integrator.totalOwed()).to.equal(USDC(20));
    });

    it("Finding 1: recovers a BUY whose completion callback reverted — funds swept off the proxy and credited to the merchant", async function () {
      const orderId = await placeBuyOnly(merchant1, UPI_1, 2); // 20 USDC BUY, not completed
      const proxy = await integrator.proxyAddress(merchant1.address);

      // Reproduce the swallowed-revert end state: USDC routed to the proxy, order
      // COMPLETED protocol-side, but the integrator never credited it.
      await mockDiamond.simulateOrderCompleteNoCallback(orderId);
      expect(await mockUsdc.balanceOf(proxy)).to.equal(USDC(20)); // stranded on proxy
      expect(await integrator.totalOwed()).to.equal(0); // merchant NOT yet credited
      expect(await integrator.orderCompleted(orderId)).to.equal(false); // never processed

      // Recover. Anyone in {merchant, owner, relayer} can call — use the merchant.
      await expect(integrator.connect(merchant1).sweepStrandedBuy(orderId))
        .to.emit(integrator, "StrandedBuyRecovered")
        .withArgs(orderId, merchant1.address, USDC(20));

      // Funds are now in custody and credited to the merchant; proxy emptied.
      expect(await mockUsdc.balanceOf(proxy)).to.equal(0);
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(USDC(20));
      expect(await integrator.totalOwed()).to.equal(USDC(20));
      expect(await integrator.orderCompleted(orderId)).to.equal(true);
      // Solvency invariant holds.
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.be.gte(
        await integrator.totalOwed()
      );

      // Credited under a fresh settlement lock (like a normal deposit): not
      // withdrawable until it matures, then it is.
      await expect(
        integrator.connect(merchant1).withdrawUSDC(USDC(20))
      ).to.be.revertedWithCustomError(integrator, "InsufficientAvailableBalance");
      await increaseTime(SETTLEMENT + 100);
      await integrator.connect(merchant1).withdrawUSDC(USDC(20));
      expect(await mockUsdc.balanceOf(merchant1.address)).to.equal(USDC(20));
    });

    it("Finding 1: recovery is idempotent — a second sweep reverts, no double-credit", async function () {
      const orderId = await placeBuyOnly(merchant1, UPI_1, 2);
      await mockDiamond.simulateOrderCompleteNoCallback(orderId);
      await integrator.connect(merchant1).sweepStrandedBuy(orderId);
      expect(await integrator.totalOwed()).to.equal(USDC(20));
      // Second call: the successful sweep cleared orderToMerchant (and set
      // orderCompleted), so a repeat reverts UnknownWithdrawal — no double-credit
      // either way. (orderCompleted is the backstop if orderToMerchant were kept.)
      await expect(
        integrator.connect(merchant1).sweepStrandedBuy(orderId)
      ).to.be.revertedWithCustomError(integrator, "UnknownWithdrawal");
      expect(await integrator.totalOwed()).to.equal(USDC(20));
    });

    it("Finding 1: a cleanly-completed BUY cannot be swept (orderCompleted already true)", async function () {
      const orderId = await depositFor(merchant1, UPI_1, 2); // normal completion
      // orderToMerchant was deleted on clean completion → UnknownWithdrawal.
      await expect(
        integrator.connect(merchant1).sweepStrandedBuy(orderId)
      ).to.be.revertedWithCustomError(integrator, "UnknownWithdrawal");
      expect(await integrator.totalOwed()).to.equal(USDC(20)); // unchanged
    });

    it("Finding 1: sweep refuses an order the Diamond has NOT marked COMPLETED", async function () {
      const orderId = await placeBuyOnly(merchant1, UPI_1, 2); // placed, not completed
      // Order status is PLACED (0), not COMPLETED (3) → WithdrawalNotCancellable.
      await expect(
        integrator.connect(merchant1).sweepStrandedBuy(orderId)
      ).to.be.revertedWithCustomError(integrator, "WithdrawalNotCancellable");
    });

    it("Finding 1: only merchant / owner / relayer may sweep (a stranger cannot)", async function () {
      const orderId = await placeBuyOnly(merchant1, UPI_1, 2);
      await mockDiamond.simulateOrderCompleteNoCallback(orderId);
      await expect(
        integrator.connect(attacker).sweepStrandedBuy(orderId)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
      // Owner can.
      await expect(integrator.connect(owner).sweepStrandedBuy(orderId)).to.emit(
        integrator,
        "StrandedBuyRecovered"
      );
    });

    it("Finding 1: pre-seeding the proxy cannot inflate the credit beyond the order amount (structural cap)", async function () {
      const orderId = await placeBuyOnly(merchant1, UPI_1, 2); // 20 USDC order
      const proxy = await integrator.proxyAddress(merchant1.address);
      // Attacker/merchant pre-injects extra USDC onto the deterministic proxy, then
      // the completion strands the real 20. Proxy now holds 25.
      await mockUsdc.mint(proxy, USDC(5));
      await mockDiamond.simulateOrderCompleteNoCallback(orderId);
      expect(await mockUsdc.balanceOf(proxy)).to.equal(USDC(25));

      // Credit is capped at the ORDER amount (20), not the inflated proxy balance.
      await expect(integrator.connect(merchant1).sweepStrandedBuy(orderId))
        .to.emit(integrator, "StrandedBuyRecovered")
        .withArgs(orderId, merchant1.address, USDC(20));
      expect(await integrator.totalOwed()).to.equal(USDC(20)); // NOT 25
      // M-1: the sweep now takes ONLY the capped amount (20), leaving the extra 5
      // on the proxy — it is no longer pulled into custody at all. (Previously the
      // whole 25 was swept and the 5 became skimmable excess; capping the sweep to
      // what we credit is exactly what stops cross-order absorption.)
      expect(await mockUsdc.balanceOf(proxy)).to.equal(USDC(5)); // remainder stays put
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(USDC(20));
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.be.gte(
        await integrator.totalOwed()
      );
      // Nothing to skim — custody exactly equals totalOwed now.
      await expect(
        integrator.connect(owner).skimExcess(owner.address)
      ).to.be.revertedWithCustomError(integrator, "NothingToSkim");
    });
  });

  describe("M-1: cross-order fund absorption on the shared merchant proxy", function () {
    // Grab a WithdrawalFiat orderId from a withdrawFiat tx receipt.
    async function fiatOrderId(tx: any): Promise<bigint> {
      const r = await tx.wait();
      const ev = r.logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((l: any) => l?.name === "WithdrawalFiat");
      return ev.args.orderId;
    }

    // The exact PoC the reviewer described (amounts scaled to the 10-USDC unit
    // price): deposit 40, withdraw 40 (principal A parked on the proxy), a customer
    // BUY of 20 strands (payout B on the SAME proxy), then sweepStrandedBuy runs.
    // BEFORE the fix: the sweep took A+B=60 but credited only 20 → 40 lost to
    // surplus, merchant owed 20 instead of 60.
    // AFTER: sweepStrandedBuy is gated on inFlightWithdrawals==0, so it can't even
    // run while the withdrawal is live; and every path caps its sweep. We assert
    // the merchant ends up whole (60) with ZERO surplus created.
    it("BUY strands while a SELL withdrawal is in flight — no absorption, merchant owed the full amount", async function () {
      // Deposit 40 (quantity 4 @ 10 USDC), matured.
      await depositFor(merchant1, UPI_1, 4); // 40 USDC
      await increaseTime(SETTLEMENT + 3600);
      expect(await integrator.totalOwed()).to.equal(USDC(40));

      // Start a fiat withdrawal of the full 40 → principal A parks on the proxy,
      // inFlightWithdrawals == 1, totalOwed drops while it's escrowed.
      const proxy = await integrator.proxyAddress(merchant1.address);
      const wId = await fiatOrderId(
        await integrator.connect(merchant1).withdrawFiat(USDC(40), 1, PK, "")
      );
      expect(await mockUsdc.balanceOf(proxy)).to.equal(USDC(40)); // A on proxy

      // A customer BUY of 20 to THIS merchant strands on the same proxy (its
      // completion callback reverted). Proxy now holds A+B = 60.
      // (simulateOrderCompleteNoCallback routes order.amount to recipientAddr = proxy.)
      const buyId = await placeOrder(merchant1, 2); // 20 USDC BUY
      await mockDiamond.simulateOrderCompleteNoCallback(buyId);
      expect(await mockUsdc.balanceOf(proxy)).to.equal(USDC(60)); // A + B co-resident

      // M-1 GUARD: sweepStrandedBuy must REFUSE while the withdrawal is in flight —
      // this is what prevents the absorption at the source.
      await expect(
        integrator.connect(merchant1).sweepStrandedBuy(buyId)
      ).to.be.revertedWithCustomError(integrator, "WithdrawalInFlight");

      // Resolve the withdrawal the normal way: the SELL is cancelled, reconcile
      // sweeps ONLY this order's own 40 back and re-credits it — leaving B (20)
      // untouched on the proxy for its own recovery path.
      await mockDiamond.cancelSellOrder(wId);
      await integrator.reconcileWithdrawal(wId);
      expect(await mockUsdc.balanceOf(proxy)).to.equal(USDC(20)); // B still there
      expect(await integrator.totalOwed()).to.equal(USDC(40)); // A restored, B not yet

      // Now no withdrawal is in flight → sweepStrandedBuy runs and credits B.
      await expect(integrator.connect(merchant1).sweepStrandedBuy(buyId))
        .to.emit(integrator, "StrandedBuyRecovered")
        .withArgs(buyId, merchant1.address, USDC(20));

      // Merchant is owed the FULL 60 (40 + 20), NOT 20. Zero surplus: custody
      // exactly equals totalOwed, so there is nothing skimmable.
      expect(await integrator.totalOwed()).to.equal(USDC(60));
      const bal = await mockUsdc.balanceOf(await integrator.getAddress());
      expect(bal).to.equal(USDC(60));
      expect(bal).to.equal(await integrator.totalOwed()); // surplus == 0
      await expect(
        integrator.connect(owner).skimExcess(owner.address)
      ).to.be.revertedWithCustomError(integrator, "NothingToSkim");
    });

    // Mirror ordering: stranded-BUY funds already sit on the proxy, THEN a SELL
    // withdrawal starts. The withdrawal's own recovery (reconcile) must sweep only
    // its own principal and never absorb the pre-existing stranded-BUY funds.
    it("SELL withdrawal starts while stranded-BUY funds sit on the proxy — reconcile takes only its own principal", async function () {
      await depositFor(merchant1, UPI_1, 4); // 40 USDC
      await increaseTime(SETTLEMENT + 3600);
      const proxy = await integrator.proxyAddress(merchant1.address);

      // A stranded BUY of 20 lands on the proxy FIRST (callback reverted).
      const buyId = await placeOrder(merchant1, 2); // 20 USDC BUY
      await mockDiamond.simulateOrderCompleteNoCallback(buyId);
      const strandedAmt = (await mockDiamond.getOrdersById(buyId)).amount; // 20 USDC
      expect(await mockUsdc.balanceOf(proxy)).to.equal(strandedAmt); // B on proxy

      // Now a fiat withdrawal of 40 starts → its principal A is added to the proxy.
      const wId = await fiatOrderId(
        await integrator.connect(merchant1).withdrawFiat(USDC(40), 1, PK, "")
      );
      expect(await mockUsdc.balanceOf(proxy)).to.equal(strandedAmt + USDC(40)); // A + B

      // The SELL is cancelled; reconcile sweeps ONLY its own 40 (capped), leaving
      // the stranded-BUY funds B on the proxy.
      await mockDiamond.cancelSellOrder(wId);
      await expect(integrator.reconcileWithdrawal(wId))
        .to.emit(integrator, "WithdrawalReconciled")
        .withArgs(merchant1.address, wId, USDC(40));
      expect(await mockUsdc.balanceOf(proxy)).to.equal(strandedAmt); // B untouched

      // B is then recovered on its own path; merchant ends up whole, no surplus.
      await integrator.connect(merchant1).sweepStrandedBuy(buyId);
      const owed = await integrator.totalOwed();
      expect(owed).to.equal(USDC(40) + strandedAmt);
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(owed);
    });

    // #2/#3: the live Diamond's setSellOrderUpi auto-cancels + returns success on a
    // failed pull instead of reverting. deliverFiatPayout must NOT report a delivery
    // for an order that actually cancelled: it reads the status back and only latches
    // upiDelivered / emits WithdrawalUpiDelivered when the order reached PAID.
    it("#2: deliverFiatPayout does NOT latch/emit for an order the Diamond auto-cancelled", async function () {
      await depositFor(merchant1, UPI_1, 2); // 20 USDC
      await increaseTime(SETTLEMENT + 3600);
      const wId = await fiatOrderId(
        await integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "")
      );
      await mockDiamond.acceptSellOrder(wId, "lp");

      // Force the Diamond's auto-cancel-and-return-success branch (mirrors a failed
      // USDC pull in production). execute() returns normally, but the order is now
      // CANCELLED — deliverFiatPayout must detect that and NOT emit a delivery.
      await mockDiamond.setForceSellUpiAutoCancel(true);
      await expect(integrator.connect(merchant1).deliverFiatPayout(wId, "encUpi")).to.not.emit(
        integrator,
        "WithdrawalUpiDelivered"
      );

      // upiDelivered was rolled back (not latched to a dead order), and the order
      // is CANCELLED — so the standard reconcile path can make the merchant whole.
      const w = await integrator.withdrawals(wId);
      expect(w.upiDelivered).to.equal(false);
      expect((await mockDiamond.getOrdersById(wId)).status).to.equal(4); // CANCELLED

      // Retry guard: the rolled-back latch re-opens deliverFiatPayout for this
      // orderId, but the order is CANCELLED on the Diamond — a redundant retry
      // must revert at OUR boundary (not rely on the facet rejecting the stale
      // setSellOrderUpi), otherwise the fee would be debited a second time with
      // feeAdvanced overwritten (only one of the two ever re-creditable).
      await mockDiamond.setForceSellUpiAutoCancel(false);
      const availBeforeRetry = (await integrator.getMerchantBalance(merchant1.address))[1];
      await expect(
        integrator.connect(merchant1).deliverFiatPayout(wId, "encUpi")
      ).to.be.revertedWithCustomError(integrator, "WithdrawalNotDeliverable");
      // no second debit happened
      expect((await integrator.getMerchantBalance(merchant1.address))[1]).to.equal(
        availBeforeRetry
      );

      // Recover: reconcile sweeps the principal back off the proxy and re-credits.
      await integrator.reconcileWithdrawal(wId);
      expect((await integrator.getMerchantBalance(merchant1.address))[1]).to.equal(USDC(20));
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.be.gte(
        await integrator.totalOwed()
      );
    });

    // #2 with a NON-ZERO fee: the auto-cancel lands AFTER deliverFiatPayout has
    // already debited the merchant's fee and pushed it to the proxy (feeAdvanced
    // recorded). The Diamond pulled nothing, so the proxy holds principal + fee
    // and reconcile must make the merchant FULLY whole — including the fee —
    // instantly spendable (the order never reached PAID, no fiat can have moved)
    // and with zero surplus absorbed into custody.
    it("#2 + fee: auto-cancel after the fee top-up — reconcile re-credits principal AND fee", async function () {
      await mockDiamond.setSellFee(USDC(1)); // offramp fee = 1 USDC
      await depositFor(merchant1, UPI_1, 3); // 30 USDC
      await increaseTime(SETTLEMENT + 3600);
      const wId = await fiatOrderId(
        await integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "")
      );
      await mockDiamond.acceptSellOrder(wId, "lp");

      await mockDiamond.setForceSellUpiAutoCancel(true);
      await expect(integrator.connect(merchant1).deliverFiatPayout(wId, "encUpi")).to.not.emit(
        integrator,
        "WithdrawalUpiDelivered"
      );

      // Fee was debited (30 - 20 principal - 1 fee = 9 available) and sits on
      // the proxy together with the principal.
      expect((await integrator.getMerchantBalance(merchant1.address))[1]).to.equal(USDC(9));
      const proxy = await integrator.proxyAddress(merchant1.address);
      expect(await mockUsdc.balanceOf(proxy)).to.equal(USDC(21));

      // Reconcile: owedBack = principal 20 + feeAdvanced 1 = 21, all on the proxy.
      await expect(integrator.reconcileWithdrawal(wId))
        .to.emit(integrator, "WithdrawalReconciled")
        .withArgs(merchant1.address, wId, USDC(21));
      expect((await integrator.getMerchantBalance(merchant1.address))[1]).to.equal(USDC(30));
      expect(await mockUsdc.balanceOf(proxy)).to.equal(0);
      // Exact solvency — nothing leaked into unattributed surplus.
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(
        await integrator.totalOwed()
      );
    });

    // Reviewer follow-up (Medium — fund loss): the capped-sweep fix originally
    // landed only in reconcile/finalize/sweepStrandedBuy; the FOUR admin recovery
    // paths (adminAbortWithdrawal / adminForceSettle / adminForceUnwedge /
    // adminForceAbandonWedge) still swept the WHOLE proxy and credited only their
    // own cap — so M-1 still bit through them. These are incident tools, so a
    // stranded BUY (itself an incident artifact) is MORE likely to be co-resident
    // exactly when they run. All seven now route through _sweepCapped.
    //
    // Exact repro from the review: SELL principal 40 + stranded BUY 25 on the
    // proxy → freeze + adminAbortWithdrawal. Before: swept 65, re-credited 40, the
    // 25 went to surplus and the now-empty proxy made sweepStrandedBuy revert
    // NothingToWithdraw (merchant's 25 unrecoverable). After: abort takes only 40,
    // leaves 25 for sweepStrandedBuy, merchant ends up whole with zero surplus.
    it("admin recovery paths also cap the sweep — adminAbortWithdrawal leaves a co-resident stranded BUY recoverable", async function () {
      // Deposit 40, mature, start a fiat withdrawal of 40 (principal A on proxy).
      await depositFor(merchant1, UPI_1, 4); // 40 USDC
      await increaseTime(SETTLEMENT + 3600);
      const proxy = await integrator.proxyAddress(merchant1.address);
      const wId = await fiatOrderId(
        await integrator.connect(merchant1).withdrawFiat(USDC(40), 1, PK, "")
      );

      // A stranded BUY of 25 lands on the SAME proxy (callback reverted). Use a
      // fresh deposit-sized order: qty is ×10 USDC, so a 25 stranded amount isn't a
      // clean multiple — place a 30 BUY (qty 3) to mirror "a second incident pot"
      // co-resident with the in-flight withdrawal. Proxy now holds 40 + 30 = 70.
      const buyId = await placeOrder(merchant1, 3); // 30 USDC BUY
      await mockDiamond.simulateOrderCompleteNoCallback(buyId);
      const strandedAmt = (await mockDiamond.getOrdersById(buyId)).amount; // 30 USDC
      expect(await mockUsdc.balanceOf(proxy)).to.equal(USDC(40) + strandedAmt); // A + B

      // Incident: freeze the merchant, then admin-abort the (never-delivered)
      // in-flight withdrawal. It must sweep ONLY its own 40, NOT the whole 70.
      await integrator.connect(owner).freezeMerchant(merchant1.address);
      await expect(integrator.connect(owner).adminAbortWithdrawal(wId))
        .to.emit(integrator, "WithdrawalReconciled")
        .withArgs(merchant1.address, wId, USDC(40)); // re-credit == 40, not 70

      // The stranded BUY's 30 is STILL on the proxy — not absorbed into surplus.
      expect(await mockUsdc.balanceOf(proxy)).to.equal(strandedAmt);

      // With the withdrawal settled, sweepStrandedBuy recovers B on its own path
      // (unfreeze first so the account can operate its normal recovery).
      await integrator.connect(owner).unfreezeMerchant(merchant1.address);
      await expect(integrator.connect(merchant1).sweepStrandedBuy(buyId))
        .to.emit(integrator, "StrandedBuyRecovered")
        .withArgs(buyId, merchant1.address, strandedAmt);

      // Merchant owed the FULL 70 (40 + 30); custody exactly equals totalOwed, so
      // nothing leaked into skimmable surplus — the loss the reviewer found is gone.
      const owed = await integrator.totalOwed();
      expect(owed).to.equal(USDC(40) + strandedAmt);
      const bal = await mockUsdc.balanceOf(await integrator.getAddress());
      expect(bal).to.equal(owed);
      await expect(
        integrator.connect(owner).skimExcess(owner.address)
      ).to.be.revertedWithCustomError(integrator, "NothingToSkim");
    });
  });

  describe("trusted relayer (keeper) authorization", function () {
    const fiatOrderId = async (txPromise: any) => {
      const r = await (await txPromise).wait();
      return r.logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((l: any) => l?.name === "WithdrawalFiat").args.orderId;
    };

    it("MANAGER-gated set; appointed relayer can deliver; clearing re-blocks it", async function () {
      // A no-role caller cannot appoint a relayer (MANAGER tier required).
      await expect(
        integrator.connect(attacker).setTrustedRelayer(attacker.address)
      ).to.be.revertedWithCustomError(integrator, "NotAuthorized");

      // Owner (implicit FINANCE ≥ MANAGER) appoints merchant2 as the keeper.
      await expect(integrator.setTrustedRelayer(merchant2.address))
        .to.emit(integrator, "TrustedRelayerSet")
        .withArgs(merchant2.address);

      // An ACCEPTED SELL for merchant1…
      await depositFor(merchant1, UPI_1, 2); // 20 USDC
      await increaseTime(SETTLEMENT + 3600);
      const wId = await fiatOrderId(
        integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "")
      );
      await mockDiamond.acceptSellOrder(wId, "lp");

      // …delivered by the relayer — who is NOT the merchant and NOT an owner.
      await expect(integrator.connect(merchant2).deliverFiatPayout(wId, "encUpi")).to.emit(
        integrator,
        "WithdrawalUpiDelivered"
      );

      // Close it out, set up a second withdrawal, then CLEAR the relayer:
      // the ex-keeper must be refused on the fresh order (auth arm, not the
      // upiDelivered replay latch).
      await mockDiamond.completeSellOrder(wId);
      await integrator.finalizeWithdrawal(wId);
      const o2 = await placeOrder(merchant1, 1); // +10 USDC
      await mockDiamond.simulateOrderComplete(o2);
      await increaseTime(SETTLEMENT + 3600);
      const wId2 = await fiatOrderId(
        integrator.connect(merchant1).withdrawFiat(USDC(10), 1, PK, "")
      );
      await mockDiamond.acceptSellOrder(wId2, "lp");

      await expect(integrator.setTrustedRelayer(ethers.ZeroAddress))
        .to.emit(integrator, "TrustedRelayerSet")
        .withArgs(ethers.ZeroAddress);
      await expect(
        integrator.connect(merchant2).deliverFiatPayout(wId2, "encUpi")
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");

      // The merchant themself is of course still allowed.
      await expect(integrator.connect(merchant1).deliverFiatPayout(wId2, "encUpi")).to.emit(
        integrator,
        "WithdrawalUpiDelivered"
      );
    });
  });

  describe("withdrawal guards", function () {
    it("unregistered merchant cannot withdraw", async function () {
      await expect(
        integrator.connect(attacker).withdrawUSDC(USDC(1))
      ).to.be.revertedWithCustomError(integrator, "NotRegistered");
      await expect(
        integrator.connect(attacker).withdrawFiat(USDC(1), 1, PK, "")
      ).to.be.revertedWithCustomError(integrator, "NotRegistered");
    });

    it("zero-amount withdrawal reverts NothingToWithdraw", async function () {
      await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", INR_CODE);
      await expect(integrator.connect(merchant1).withdrawUSDC(0)).to.be.revertedWithCustomError(
        integrator,
        "NothingToWithdraw"
      );
    });

    it("cannot withdraw locked funds (partial unlock respected)", async function () {
      await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", INR_CODE);
      // deposit 1 (will unlock), then deposit 2 (still locked)
      let o = await placeOrder(merchant1, 2);
      await mockDiamond.simulateOrderComplete(o);
      await increaseTime(SETTLEMENT + 100);
      o = await placeOrder(merchant1, 1);
      await mockDiamond.simulateOrderComplete(o);

      // 20 unlocked, 10 locked -> withdrawing 25 must fail, 20 ok
      await expect(
        integrator.connect(merchant1).withdrawUSDC(USDC(25))
      ).to.be.revertedWithCustomError(integrator, "InsufficientAvailableBalance");
      await integrator.connect(merchant1).withdrawUSDC(USDC(20));
      const [pending, available] = await integrator.getMerchantBalance(merchant1.address);
      expect(pending).to.equal(USDC(10));
      expect(available).to.equal(0);
    });

    it("oldest-first deduction across multiple unlocked buckets", async function () {
      await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", INR_CODE);
      for (let i = 0; i < 3; i++) {
        const o = await placeOrder(merchant1, 1); // 10 each
        await mockDiamond.simulateOrderComplete(o);
      }
      await increaseTime(SETTLEMENT + 100);
      // 30 unlocked across 3 buckets; withdraw 15 -> first bucket gone, second half
      await integrator.connect(merchant1).withdrawUSDC(USDC(15));
      const [, available] = await integrator.getMerchantBalance(merchant1.address);
      expect(available).to.equal(USDC(15));
      const buckets = await integrator.getMerchantBuckets(merchant1.address);
      // first bucket fully spent (0 or compacted away), remainder = 15
      const liveTotal = buckets.reduce((s: bigint, b: any) => s + b.amount, 0n);
      expect(liveTotal).to.equal(USDC(15));
    });
  });

  describe("INR withdrawal reconciliation (cancelled SELL order recovery)", function () {
    it("reconcileWithdrawal recovers funds when the SELL order is cancelled", async function () {
      await depositFor(merchant1, UPI_1, 2); // 20 USDC
      await increaseTime(SETTLEMENT + 3600);

      const tx = await integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "");
      const receipt = await tx.wait();
      const ev = receipt.logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((l: any) => l?.name === "WithdrawalFiat");
      const orderId = ev.args.orderId;

      // merchant balance is zero, funds parked on the MERCHANT'S OWN proxy
      expect((await integrator.getMerchantBalance(merchant1.address))[1]).to.equal(0);
      const merchantProxy = await integrator.proxyAddress(merchant1.address);
      expect(await mockUsdc.balanceOf(merchantProxy)).to.equal(USDC(20));

      // Diamond cancels the sell order (PLACED -> CANCELLED). Our integrator
      // funded the merchant proxy at placement, so the USDC sits there and
      // reconcileWithdrawal sweeps it back.
      await mockDiamond.cancelSellOrder(orderId);
      expect((await mockDiamond.getOrdersById(orderId)).status).to.equal(4); // CANCELLED

      // reconcile: sweeps proxy USDC back, re-credits merchant
      await expect(integrator.reconcileWithdrawal(orderId))
        .to.emit(integrator, "WithdrawalReconciled")
        .withArgs(merchant1.address, orderId, USDC(20));

      const [, available] = await integrator.getMerchantBalance(merchant1.address);
      expect(available).to.equal(USDC(20)); // fully recovered, immediately unlocked
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(USDC(20));
    });

    it("AUDIT: reconcileWithdrawal RE-LOCKS a FROZEN merchant's recovery (no instantly-spendable funds)", async function () {
      await depositFor(merchant1, UPI_1, 2); // 20 USDC
      await increaseTime(SETTLEMENT + 3600);
      const tx = await integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "");
      const receipt = await tx.wait();
      const ev = receipt.logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((l: any) => l?.name === "WithdrawalFiat");
      const orderId = ev.args.orderId;

      // Admin freezes the merchant, THEN the SELL is cancelled and anyone reconciles.
      await integrator.connect(owner).freezeMerchant(merchant1.address);
      await mockDiamond.cancelSellOrder(orderId);
      await integrator.reconcileWithdrawal(orderId);

      // Because the merchant is frozen, the re-credit is LOCKED under a fresh
      // settlement window — NOT immediately available (mirrors adminAbortWithdrawal).
      const [pending, available] = await integrator.getMerchantBalance(merchant1.address);
      expect(available).to.equal(0); // nothing instantly spendable
      expect(pending).to.equal(USDC(20)); // held until the window elapses

      // After the window passes AND unfreeze, it becomes available normally.
      await increaseTime(SETTLEMENT + 10);
      await integrator.connect(owner).unfreezeMerchant(merchant1.address);
      expect((await integrator.getMerchantBalance(merchant1.address))[1]).to.equal(USDC(20));
    });

    it("two in-flight INR withdrawals are physically isolated on per-merchant proxies (no cross-steal)", async function () {
      // m1 and m2 each withdraw INR; each funds their OWN proxy. Cancelling
      // m1's order recovers only m1's funds; m2's are on a different proxy and
      // cannot be touched — isolation is now structural, not amount-capped.
      await depositFor(merchant1, UPI_1, 2); // m1: 20
      await integrator.connect(merchant2).registerMerchant(UPI_2, "Shop Two", INR_CODE);
      const o2 = await placeOrder(merchant2, 3); // m2: 30
      await mockDiamond.simulateOrderComplete(o2);
      await increaseTime(SETTLEMENT + 3600);

      const grab = async (tx: any, name: string) => {
        const r = await tx.wait();
        return r.logs
          .map((l: any) => {
            try {
              return integrator.interface.parseLog(l);
            } catch {
              return null;
            }
          })
          .find((l: any) => l?.name === name).args.orderId;
      };
      const id1 = await grab(
        await integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, ""),
        "WithdrawalFiat"
      );
      await grab(
        await integrator.connect(merchant2).withdrawFiat(USDC(30), 1, PK, ""),
        "WithdrawalFiat"
      );

      const proxy1 = await integrator.proxyAddress(merchant1.address);
      const proxy2 = await integrator.proxyAddress(merchant2.address);
      // funds are on SEPARATE proxies — never commingled
      expect(await mockUsdc.balanceOf(proxy1)).to.equal(USDC(20));
      expect(await mockUsdc.balanceOf(proxy2)).to.equal(USDC(30));

      // cancel + reconcile only m1's
      await mockDiamond.cancelSellOrder(id1);
      await expect(integrator.reconcileWithdrawal(id1))
        .to.emit(integrator, "WithdrawalReconciled")
        .withArgs(merchant1.address, id1, USDC(20));

      // m1 got exactly 20 back from m1's proxy; m2's proxy is completely untouched
      expect((await integrator.getMerchantBalance(merchant1.address))[1]).to.equal(USDC(20));
      expect((await integrator.getMerchantBalance(merchant2.address))[1]).to.equal(0);
      expect(await mockUsdc.balanceOf(proxy1)).to.equal(0); // swept back
      expect(await mockUsdc.balanceOf(proxy2)).to.equal(USDC(30)); // m2's untouched
    });

    it("reconcileWithdrawal reverts for a non-cancelled order", async function () {
      await depositFor(merchant1, UPI_1, 2);
      await increaseTime(SETTLEMENT + 3600);
      const tx = await integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "");
      const receipt = await tx.wait();
      const ev = receipt.logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((l: any) => l?.name === "WithdrawalFiat");
      await expect(integrator.reconcileWithdrawal(ev.args.orderId)).to.be.revertedWithCustomError(
        integrator,
        "WithdrawalNotCancellable"
      );
    });

    it("reconcileWithdrawal reverts for unknown orderId", async function () {
      await expect(integrator.reconcileWithdrawal(424242)).to.be.revertedWithCustomError(
        integrator,
        "UnknownWithdrawal"
      );
    });

    it("reconcileWithdrawal cannot be replayed", async function () {
      await depositFor(merchant1, UPI_1, 2);
      await increaseTime(SETTLEMENT + 3600);
      const tx = await integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "");
      const receipt = await tx.wait();
      const ev = receipt.logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((l: any) => l?.name === "WithdrawalFiat");
      const orderId = ev.args.orderId;
      await mockDiamond.cancelSellOrder(orderId);
      await integrator.reconcileWithdrawal(orderId);
      await expect(integrator.reconcileWithdrawal(orderId)).to.be.revertedWithCustomError(
        integrator,
        "WithdrawalAlreadySettled"
      );
    });
  });

  describe("bucket bound (no unbounded-array DoS)", function () {
    it("spent buckets are compacted so the array stays bounded", async function () {
      await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", INR_CODE);
      // 5 deposits, unlock, withdraw all -> then deposit again; array must not
      // grow without bound (compaction removes spent buckets at the head)
      for (let i = 0; i < 4; i++) {
        const o = await placeOrder(merchant1, 1);
        await mockDiamond.simulateOrderComplete(o);
      }
      // advance at least a full day so funds unlock AND the daily-tx window
      // resets (settlement can be shorter than a day in the withdraw-test build)
      await increaseTime(Math.max(SETTLEMENT, DAY) + 100);
      await integrator.connect(merchant1).withdrawUSDC(USDC(40)); // empties all 4
      // next deposit triggers compaction -> array length should drop back to 1
      const o = await placeOrder(merchant1, 1);
      await mockDiamond.simulateOrderComplete(o);
      const buckets = await integrator.getMerchantBuckets(merchant1.address);
      expect(buckets.length).to.equal(1);
      expect(buckets[0].amount).to.equal(USDC(10));
    });

    it("compaction reclaims a spent bucket sitting BEHIND a still-locked bucket", async function () {
      await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", INR_CODE);
      // bucket A (will unlock), then bucket B (stays locked, sits in front of A
      // chronologically? no — A is older). Build: old unlocked A + newer locked B,
      // spend A fully, then deposit C. Interior zero (A) must be reclaimed even
      // though it is followed by locked B.
      let o = await placeOrder(merchant1, 1); // A = 10
      await mockDiamond.simulateOrderComplete(o);
      await increaseTime(SETTLEMENT + 100); // A now unlocked
      o = await placeOrder(merchant1, 2); // B = 20, locked (fresh 30-day)
      await mockDiamond.simulateOrderComplete(o);

      // spend A fully (10 unlocked available) -> A becomes a zero bucket at index 0,
      // B (locked) at index 1
      await integrator.connect(merchant1).withdrawUSDC(USDC(10));

      // deposit C -> _creditBucket compacts; A's zero must be removed
      o = await placeOrder(merchant1, 1); // C = 10
      await mockDiamond.simulateOrderComplete(o);

      const buckets = await integrator.getMerchantBuckets(merchant1.address);
      // should be exactly [B=20 locked, C=10 locked] — A reclaimed, no zeros
      expect(buckets.length).to.equal(2);
      for (const b of buckets) expect(b.amount).to.not.equal(0n);
      const total = buckets.reduce((s: bigint, b: any) => s + b.amount, 0n);
      expect(total).to.equal(USDC(30));
    });
  });

  describe("reentrancy", function () {
    it("withdrawUSDC has a nonReentrant guard (storage flag resets)", async function () {
      // two sequential withdrawals in separate txs both succeed (guard resets)
      await depositFor(merchant1, UPI_1, 4); // 40
      await increaseTime(SETTLEMENT + 100);
      await integrator.connect(merchant1).withdrawUSDC(USDC(20));
      await integrator.connect(merchant1).withdrawUSDC(USDC(20));
      expect((await integrator.getMerchantBalance(merchant1.address))[1]).to.equal(0);
    });
  });

  // ─── Audit-fix regression tests ────────────────────────────────────
  describe("audit fixes", function () {
    const grabFiat = async (txPromise: any) => {
      const tx = await txPromise;
      const r = await tx.wait();
      return r.logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((l: any) => l?.name === "WithdrawalFiat").args.orderId;
    };

    it("HIGH-1: SELL fee is charged to the merchant, NOT the shared pool (other merchant stays solvent)", async function () {
      // m1 deposits 30, m2 deposits 20. m1 off-ramps 20 with a 1 USDC fee.
      // The fee must come out of m1's own balance — m2's 20 must remain fully
      // withdrawable (the old bug drained the pool and bricked m2).
      await depositFor(merchant1, UPI_1, 3); // 30
      await integrator.connect(merchant2).registerMerchant(UPI_2, "Shop Two", INR_CODE);
      const o2 = await placeOrder(merchant2, 2); // 20
      await mockDiamond.simulateOrderComplete(o2);
      await increaseTime(SETTLEMENT + 3600);

      await mockDiamond.setSellFee(USDC(1));
      const orderId = await grabFiat(
        integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "")
      );
      await mockDiamond.acceptSellOrder(orderId, "lp");
      await integrator.connect(merchant1).deliverFiatPayout(orderId, "enc");

      // m1 charged principal 20 + fee 1 = 21, leaving 9 of their 30
      expect((await integrator.getMerchantBalance(merchant1.address))[1]).to.equal(USDC(9));
      // m2 fully intact and actually withdrawable — pool is still solvent
      expect((await integrator.getMerchantBalance(merchant2.address))[1]).to.equal(USDC(20));
      await expect(integrator.connect(merchant2).withdrawUSDC(USDC(20))).to.emit(
        integrator,
        "WithdrawalUSDC"
      );
      // solvency invariant holds
      const owed = await integrator.totalOwed();
      const bal = await mockUsdc.balanceOf(await integrator.getAddress());
      expect(bal >= owed).to.equal(true);
    });

    it("HIGH-1: a merchant with no headroom for the fee cannot drain the pool (reverts)", async function () {
      // m1 deposits exactly 20 and off-ramps all 20 — nothing left to pay the
      // fee, so delivery reverts instead of dipping into the pool.
      await depositFor(merchant1, UPI_1, 2); // 20
      await depositFor(merchant2, UPI_2, 2); // pool has USDC to forward
      await increaseTime(SETTLEMENT + 3600);
      await mockDiamond.setSellFee(USDC(1));
      const orderId = await grabFiat(
        integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "")
      );
      await mockDiamond.acceptSellOrder(orderId, "lp");
      await expect(
        integrator.connect(merchant1).deliverFiatPayout(orderId, "enc")
      ).to.be.revertedWithCustomError(integrator, "InsufficientAvailableBalance");
    });

    it("HIGH-2: a frozen merchant's in-flight withdrawal cannot be delivered", async function () {
      await depositFor(merchant1, UPI_1, 3); // 30
      await depositFor(merchant2, UPI_2, 2);
      await increaseTime(SETTLEMENT + 3600);
      await mockDiamond.setSellFee(USDC(1));
      const orderId = await grabFiat(
        integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "")
      );
      await mockDiamond.acceptSellOrder(orderId, "lp");
      // owner freezes BETWEEN placement and delivery
      await integrator.freezeMerchant(merchant1.address);
      await expect(
        integrator.connect(merchant1).deliverFiatPayout(orderId, "enc")
      ).to.be.revertedWithCustomError(integrator, "MerchantIsFrozen");
    });

    it("HIGH-2: owner can adminAbortWithdrawal to claw a frozen in-flight withdrawal back", async function () {
      await depositFor(merchant1, UPI_1, 2); // 20
      await increaseTime(SETTLEMENT + 3600);
      const orderId = await grabFiat(
        integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "")
      );
      await integrator.freezeMerchant(merchant1.address);
      await expect(integrator.adminAbortWithdrawal(orderId)).to.emit(
        integrator,
        "WithdrawalReconciled"
      );
      // funds back on the integrator, re-credited but LOCKED again (frozen)
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(USDC(20));
      const [pending, available] = await integrator.getMerchantBalance(merchant1.address);
      expect(available).to.equal(0); // re-locked under a fresh settlement window
      expect(pending).to.equal(USDC(20));
    });

    it("HIGH-2: adminAbortWithdrawal only works on a FROZEN merchant and only for the owner", async function () {
      await depositFor(merchant1, UPI_1, 2);
      await increaseTime(SETTLEMENT + 3600);
      const orderId = await grabFiat(
        integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "")
      );
      // not frozen → reverts
      await expect(integrator.adminAbortWithdrawal(orderId)).to.be.revertedWithCustomError(
        integrator,
        "MerchantNotFrozen"
      );
      await integrator.freezeMerchant(merchant1.address);
      // non-manager → reverts (money-recovery action is MANAGER-tier)
      await expect(
        integrator.connect(attacker).adminAbortWithdrawal(orderId)
      ).to.be.revertedWithCustomError(integrator, "NotAuthorized");
    });

    it("MED-1: a second concurrent fiat withdrawal is rejected until the first settles", async function () {
      await depositFor(merchant1, UPI_1, 4); // 40
      await increaseTime(SETTLEMENT + 3600);
      await integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "");
      await expect(
        integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "")
      ).to.be.revertedWithCustomError(integrator, "WithdrawalInFlight");
    });

    it("MED-1: after the first withdrawal reconciles, a new one is allowed again", async function () {
      await depositFor(merchant1, UPI_1, 4); // 40
      await increaseTime(SETTLEMENT + 3600);
      const orderId = await grabFiat(
        integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "")
      );
      await mockDiamond.cancelSellOrder(orderId);
      await integrator.reconcileWithdrawal(orderId); // settles + frees the slot
      await expect(integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "")).to.emit(
        integrator,
        "WithdrawalFiat"
      );
    });

    it("MED-2 + NEW-1: a COMPLETED (fiat-delivered) order can never re-credit USDC (double-spend blocked)", async function () {
      // Genuine double-spend case: fiat was delivered AND the order COMPLETED.
      // reconcile only acts on CANCELLED, so a completed order is never
      // re-creditable — the merchant keeps the fiat, no USDC clawback.
      await depositFor(merchant1, UPI_1, 3); // 30 (headroom for fee)
      await depositFor(merchant2, UPI_2, 2);
      await increaseTime(SETTLEMENT + 3600);
      await mockDiamond.setSellFee(USDC(1));
      const orderId = await grabFiat(
        integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "")
      );
      await mockDiamond.acceptSellOrder(orderId, "lp");
      await integrator.connect(merchant1).deliverFiatPayout(orderId, "enc"); // fiat PAID
      await mockDiamond.completeSellOrder(orderId); // fiat DELIVERED
      // completed → reconcile refuses (status != CANCELLED)
      await expect(integrator.reconcileWithdrawal(orderId)).to.be.revertedWithCustomError(
        integrator,
        "WithdrawalNotCancellable"
      );
      // finalize settles it and frees the slot (the happy path)
      await integrator.finalizeWithdrawal(orderId);
      await expect(integrator.connect(merchant1).withdrawFiat(USDC(5), 1, PK, "")).to.emit(
        integrator,
        "WithdrawalFiat"
      ); // channel not bricked
    });

    it("NEW-1: a PAID-then-CANCELLED SELL is fully recoverable (refund re-credited, slot freed, no DoS)", async function () {
      // The Diamond clawed the fiat back (refunds principal+fee to the proxy),
      // so the merchant must be made whole and able to withdraw again.
      await depositFor(merchant1, UPI_1, 3); // 30 (headroom for fee)
      await depositFor(merchant2, UPI_2, 2);
      await increaseTime(SETTLEMENT + 3600);
      await mockDiamond.setSellFee(USDC(1));
      const orderId = await grabFiat(
        integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "")
      );
      await mockDiamond.acceptSellOrder(orderId, "lp");
      await integrator.connect(merchant1).deliverFiatPayout(orderId, "enc"); // PAID, merchant charged 21
      // after deliver: merchant available = 30 - 20 principal - 1 fee = 9
      expect((await integrator.getMerchantBalance(merchant1.address))[1]).to.equal(USDC(9));

      // LP times out / admin cancels the PAID SELL → Diamond refunds 21 to proxy
      await mockDiamond.cancelSellOrder(orderId);

      // recovery succeeds (was permanently bricked before the NEW-1 fix)
      await expect(integrator.reconcileWithdrawal(orderId)).to.emit(
        integrator,
        "WithdrawalReconciled"
      );

      // principal + fee (21) re-credited, re-locked under a fresh settlement
      // window because the order had reached PAID. Merchant is fully whole.
      const [pending, available] = await integrator.getMerchantBalance(merchant1.address);
      expect(available).to.equal(USDC(9)); // unchanged: re-credit is locked
      expect(pending).to.equal(USDC(21)); // principal 20 + fee 1 back, settling
      // proxy emptied, funds back on the integrator
      const proxy = await integrator.proxyAddress(merchant1.address);
      expect(await mockUsdc.balanceOf(proxy)).to.equal(0);

      // and the in-flight slot is freed → the merchant can withdraw again
      await increaseTime(SETTLEMENT + 100);
      await expect(integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "")).to.emit(
        integrator,
        "WithdrawalFiat"
      );
    });

    it("FINAL: a PAID→DISPUTED→CANCELLED order is recoverable via adminForceSettle (no channel-brick)", async function () {
      // The disputed-clawback trap the final audit caught: reconcile refuses
      // disputed, finalize needs COMPLETED, adminAbort refuses upiDelivered — so
      // without adminForceSettle the slot stays stuck forever. Verify recovery.
      await depositFor(merchant1, UPI_1, 3); // 30 (fee headroom)
      await depositFor(merchant2, UPI_2, 2);
      await increaseTime(SETTLEMENT + 3600);
      await mockDiamond.setSellFee(USDC(1));
      const orderId = await grabFiat(
        integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "")
      );
      await mockDiamond.acceptSellOrder(orderId, "lp");
      await integrator.connect(merchant1).deliverFiatPayout(orderId, "enc"); // PAID, charged 21

      // dispute is raised, then the order is cancelled WITH a dispute recorded
      await mockDiamond.setSellDispute(orderId, 1, 1); // raisedBy=1, status=1
      await mockDiamond.cancelSellOrder(orderId); // refunds 21 to proxy

      // every normal settle path refuses this state
      await expect(integrator.reconcileWithdrawal(orderId)).to.be.revertedWithCustomError(
        integrator,
        "WithdrawalNotCancellable"
      ); // dispute guard
      await expect(integrator.finalizeWithdrawal(orderId)).to.be.revertedWithCustomError(
        integrator,
        "WithdrawalNotCancellable"
      ); // not COMPLETED

      // owner force-settles: sweeps the 21 refund, re-credits principal+fee (20+1)
      // re-locked, frees the slot.
      await expect(integrator.adminForceSettle(orderId)).to.emit(
        integrator,
        "WithdrawalReconciled"
      );
      const proxy = await integrator.proxyAddress(merchant1.address);
      expect(await mockUsdc.balanceOf(proxy)).to.equal(0); // refund recovered

      // merchant made whole: 9 still-available + 21 re-locked = 30 pending+available
      const [pending, available] = await integrator.getMerchantBalance(merchant1.address);
      expect(available).to.equal(USDC(9));
      expect(pending).to.equal(USDC(21)); // principal 20 + fee 1 refunded, settling

      // channel no longer bricked
      await increaseTime(SETTLEMENT + 100);
      await expect(integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "")).to.emit(
        integrator,
        "WithdrawalFiat"
      );
    });

    it("FINAL: adminForceSettle is owner-only and refuses a non-CANCELLED order", async function () {
      await depositFor(merchant1, UPI_1, 2);
      await increaseTime(SETTLEMENT + 3600);
      const orderId = await grabFiat(
        integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "")
      );
      // not cancelled yet → reverts
      await expect(integrator.adminForceSettle(orderId)).to.be.revertedWithCustomError(
        integrator,
        "WithdrawalNotCancellable"
      );
      // non-manager → reverts (money-recovery action is MANAGER-tier)
      await mockDiamond.cancelSellOrder(orderId);
      await expect(
        integrator.connect(attacker).adminForceSettle(orderId)
      ).to.be.revertedWithCustomError(integrator, "NotAuthorized");
    });

    it("FIX #9: a PAID-but-never-terminalised SELL wedges the slot; adminForceUnwedge frees it (frozen-gated, double-spend-safe)", async function () {
      await depositFor(merchant1, UPI_1, 3); // 30 (fee headroom)
      await depositFor(merchant2, UPI_2, 2);
      await increaseTime(SETTLEMENT + 3600);
      await mockDiamond.setSellFee(USDC(1));
      const orderId = await grabFiat(
        integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "")
      );
      await mockDiamond.acceptSellOrder(orderId, "lp");
      await integrator.connect(merchant1).deliverFiatPayout(orderId, "enc"); // PAID — Diamond pulled principal+fee

      // The Diamond NEVER terminalises it (no complete, no cancel) → the order is
      // stuck PAID. Every normal path refuses this state, wedging the in-flight slot.
      await expect(integrator.finalizeWithdrawal(orderId)).to.be.revertedWithCustomError(
        integrator,
        "WithdrawalNotCancellable"
      ); // not COMPLETED
      await expect(integrator.reconcileWithdrawal(orderId)).to.be.revertedWithCustomError(
        integrator,
        "WithdrawalNotCancellable"
      ); // not CANCELLED
      await expect(integrator.adminAbortWithdrawal(orderId)).to.be.revertedWithCustomError(
        integrator,
        "FiatAlreadyDelivered"
      ); // upiDelivered
      // channel is bricked: a new withdrawal reverts WithdrawalInFlight
      await expect(
        integrator.connect(merchant1).withdrawFiat(USDC(5), 1, PK, "")
      ).to.be.revertedWithCustomError(integrator, "WithdrawalInFlight");

      // adminForceUnwedge is FROZEN-gated (incident tool) — refuses an unfrozen merchant.
      await expect(integrator.adminForceUnwedge(orderId)).to.be.revertedWithCustomError(
        integrator,
        "MerchantNotFrozen"
      );
      // and non-FINANCE cannot call it
      await integrator.freezeMerchant(merchant1.address);
      await expect(
        integrator.connect(attacker).adminForceUnwedge(orderId)
      ).to.be.revertedWithCustomError(integrator, "NotAuthorized");

      // Owner (FINANCE) unwedges: the slot is freed. Proxy was drained by the
      // Diamond (fiat likely delivered) → proxyBal ≈ 0 → recredit ≈ 0 (structural
      // double-spend guard: the merchant does NOT reclaim USDC they may have
      // already converted to fiat).
      const proxy = await integrator.proxyAddress(merchant1.address);
      expect(await mockUsdc.balanceOf(proxy)).to.equal(0);
      await expect(integrator.adminForceUnwedge(orderId))
        .to.emit(integrator, "WithdrawalReconciled")
        .withArgs(merchant1.address, orderId, 0);
      // FIX #10: because NO refund had landed (proxyBal==0), the unwedge credited
      // nothing and did NOT settle or free the slot — the channel stays serialized
      // on this one order so a late refund is recoverable AND cannot be mixed with a
      // new order's principal on the shared proxy (see the dedicated FIX #10 test).
      const wu = await integrator.withdrawals(orderId);
      expect(wu.settled).to.equal(false);
      expect(wu.slotFreed).to.equal(false);
      // unwedge credited nothing (fiat likely delivered; proxy was empty)
      expect((await integrator.getMerchantBalance(merchant1.address))[1]).to.equal(USDC(9));
      // Still wedged after unwedge (correct — no refund to recover): the channel
      // remains serialized so a late refund can't be mis-attributed. Unfreeze first
      // so the block is the IN-FLIGHT slot (the brick), not the freeze.
      await integrator.unfreezeMerchant(merchant1.address);
      await increaseTime(SETTLEMENT + 100);
      await expect(
        integrator.connect(merchant1).withdrawFiat(USDC(5), 1, PK, "")
      ).to.be.revertedWithCustomError(integrator, "WithdrawalInFlight");

      // FIX #11: the operator has confirmed the Diamond will never refund this dead
      // order. adminForceAbandonWedge UNCONDITIONALLY frees the channel and closes
      // the order — this is the guaranteed un-brick that adminForceUnwedge (which
      // won't free without a refund) can't provide. Frozen + FINANCE gated.
      await expect(integrator.adminForceAbandonWedge(orderId)).to.be.revertedWithCustomError(
        integrator,
        "MerchantNotFrozen"
      ); // frozen-gated (not frozen now)
      await integrator.freezeMerchant(merchant1.address);
      await expect(
        integrator.connect(attacker).adminForceAbandonWedge(orderId)
      ).to.be.revertedWithCustomError(integrator, "NotAuthorized"); // FINANCE-gated
      await expect(integrator.adminForceAbandonWedge(orderId))
        .to.emit(integrator, "WithdrawalReconciled")
        .withArgs(merchant1.address, orderId, 0);
      const wa = await integrator.withdrawals(orderId);
      expect(wa.settled).to.equal(true); // order closed
      expect(wa.slotFreed).to.equal(true); // slot freed
      // channel is UN-BRICKED: after unfreeze the merchant can withdraw fiat again
      await integrator.unfreezeMerchant(merchant1.address);
      await increaseTime(SETTLEMENT + 100);
      await expect(integrator.connect(merchant1).withdrawFiat(USDC(5), 1, PK, "")).to.emit(
        integrator,
        "WithdrawalFiat"
      );
      // and abandon cannot be replayed (order already settled)
      await integrator.freezeMerchant(merchant1.address);
      await expect(integrator.adminForceAbandonWedge(orderId)).to.be.revertedWithCustomError(
        integrator,
        "WithdrawalAlreadySettled"
      );
    });

    it("FIX #10: a late PAID→CANCELLED refund is recoverable AFTER adminForceUnwedge freed the slot (no permanent stranding)", async function () {
      // Reproduces the audit finding: unwedge a stuck PAID order whose refund has
      // not landed, then the Diamond finally CANCELs and refunds the proxy. The
      // refunded principal+fee must still be recoverable (previously it was sealed
      // by settled=true and stranded forever).
      await depositFor(merchant1, UPI_1, 3); // 30 (fee headroom)
      await increaseTime(SETTLEMENT + 3600);
      await mockDiamond.setSellFee(USDC(1));
      const orderId = await grabFiat(
        integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "")
      );
      await mockDiamond.acceptSellOrder(orderId, "lp");
      await integrator.connect(merchant1).deliverFiatPayout(orderId, "enc"); // PAID: Diamond pulled principal+fee, proxyBal==0

      const proxy = await integrator.proxyAddress(merchant1.address);
      expect(await mockUsdc.balanceOf(proxy)).to.equal(0);

      // Support freezes and FINANCE force-unwedges while the order is still escrowed
      // (no refund yet). recredit 0 < owedBack → NOT settled and slot NOT freed, so
      // the eventual refund stays recoverable and the channel stays serialized.
      await integrator.freezeMerchant(merchant1.address);
      await expect(integrator.adminForceUnwedge(orderId))
        .to.emit(integrator, "WithdrawalReconciled")
        .withArgs(merchant1.address, orderId, 0);
      const wAfterUnwedge = await integrator.withdrawals(orderId);
      expect(wAfterUnwedge.settled).to.equal(false); // <-- the fix: not sealed
      expect(wAfterUnwedge.slotFreed).to.equal(false);

      // Later the Diamond CANCELs the PAID order → refunds principal+fee (21) to the proxy.
      await mockDiamond.cancelSellOrder(orderId);
      expect(await mockUsdc.balanceOf(proxy)).to.equal(USDC(21));

      // The merchant is still frozen, so unlock the recovery via the CANCELLED-gated
      // path. adminForceSettle sweeps the proxy and re-credits principal+fee (21),
      // capped by the physical refund — the funds are NOT stranded.
      await expect(integrator.adminForceSettle(orderId))
        .to.emit(integrator, "WithdrawalReconciled")
        .withArgs(merchant1.address, orderId, USDC(21));
      expect(await mockUsdc.balanceOf(proxy)).to.equal(0); // swept to vault
      const wFinal = await integrator.withdrawals(orderId);
      expect(wFinal.settled).to.equal(true); // now terminal

      // The re-credit landed (locked under a fresh window). After it unlocks the
      // merchant can spend it — proving no permanent loss.
      await increaseTime(SETTLEMENT + 100);
      const avail = (await integrator.getMerchantBalance(merchant1.address))[1];
      // started 30, withdrew 20 principal + 1 fee = 9 left, then +21 re-credited = 30
      expect(avail).to.equal(USDC(30));

      // Idempotency: the slot was freed exactly once (not double-decremented). The
      // channel is usable after unfreeze.
      await integrator.unfreezeMerchant(merchant1.address);
      await expect(integrator.connect(merchant1).withdrawFiat(USDC(5), 1, PK, "")).to.emit(
        integrator,
        "WithdrawalFiat"
      );
    });

    it("FIX #4: a duplicate/out-of-order cancel AFTER completion does not decrement the daily-tx count", async function () {
      await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop", INR_CODE);
      // Place 2 orders today (daily count = 2). Complete the first.
      const o1 = await placeOrder(merchant1, 1);
      await placeOrder(merchant1, 1);
      await mockDiamond.simulateOrderComplete(o1); // o1 terminal → cancel bookkeeping cleared
      // A stray/duplicate cancel for the COMPLETED order must be a no-op — it must
      // NOT wrongly release a daily-count slot (orderToMerchant[o1] was cleared).
      const before = (await integrator.getDailyTxInfo(merchant1.address))[0];
      const ds = await diamondSigner();
      await integrator.connect(ds).onOrderCancel(o1); // stray cancel after completion
      const after = (await integrator.getDailyTxInfo(merchant1.address))[0];
      expect(after).to.equal(before); // unchanged — no spurious decrement
    });

    it("MED-4: a stale cross-day cancellation does not decrement the new day's tx count", async function () {
      await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop", INR_CODE);
      // Day N: place 4 (hit the daily limit). Keep the first order id.
      const firstOrder = await placeOrder(merchant1, 1);
      for (let i = 0; i < 3; i++) await placeOrder(merchant1, 1);
      expect((await integrator.getDailyTxInfo(merchant1.address))[0]).to.equal(4n);

      // Roll to day N+1 and place 4 more (counter resets, hits limit again).
      await increaseTime(DAY);
      for (let i = 0; i < 4; i++) await placeOrder(merchant1, 1);
      expect((await integrator.getDailyTxInfo(merchant1.address))[0]).to.equal(4n);

      // A DAY-N order cancels on day N+1 — must NOT decrement today's counter.
      const ds = await diamondSigner();
      await integrator.connect(ds).onOrderCancel(firstOrder);
      expect((await integrator.getDailyTxInfo(merchant1.address))[0]).to.equal(4n);
    });

    it("MED-4: a SAME-day cancellation still correctly releases a slot", async function () {
      await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop", INR_CODE);
      const o = await placeOrder(merchant1, 1);
      await placeOrder(merchant1, 1);
      expect((await integrator.getDailyTxInfo(merchant1.address))[0]).to.equal(2n);
      const ds = await diamondSigner();
      await integrator.connect(ds).onOrderCancel(o); // same day → decrements
      expect((await integrator.getDailyTxInfo(merchant1.address))[0]).to.equal(1n);
    });

    it("MED-5: deposits sharing an unlock window coalesce, so the bucket count stays bounded", async function () {
      // Two deposits credited at the SAME unlock timestamp fold into ONE bucket.
      // _creditBucket folds only on an EXACT timestamp match, so both credits
      // must land in the SAME block — auto-mined blocks get different timestamps
      // and never coalesce (which made the old version of this test vacuous:
      // it only summed amounts and passed with or without coalescing).
      await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop", INR_CODE);
      const o1 = await placeOrder(merchant1, 1); // 10
      const o2 = await placeOrder(merchant1, 1); // 10
      await ethers.provider.send("evm_setAutomine", [false]);
      const t1 = await mockDiamond.simulateOrderComplete(o1);
      const t2 = await mockDiamond.simulateOrderComplete(o2);
      await ethers.provider.send("evm_mine", []);
      await ethers.provider.send("evm_setAutomine", [true]);
      await t1.wait();
      await t2.wait();

      const buckets = await integrator.getMerchantBuckets(merchant1.address);
      expect(buckets.length).to.equal(1); // folded — NOT two buckets
      expect(buckets[0].amount).to.equal(USDC(20)); // both credited, nothing stranded
    });

    it("INFO-2: a currency code with an interior NUL byte is rejected", async function () {
      const withNul = "IN" + String.fromCharCode(0) + "R";
      await expect(integrator.toCurrency(withNul)).to.be.revertedWithCustomError(
        integrator,
        "InvalidCurrency"
      );
    });

    it("NEW-2: a reconcile re-credit (past-dated) never unlocks a merchant's other STILL-LOCKED funds", async function () {
      // Deposit 40 (locked), withdraw 20 fiat (from unlocked? no — locked, so
      // first settle 40, then take 20). Set up: 40 available, withdraw 20 fiat,
      // cancel→reconcile re-credits past-dated. The remaining bucket must stay
      // correct; a fresh locked deposit must remain locked afterward.
      await depositFor(merchant1, UPI_1, 4); // 40
      await increaseTime(SETTLEMENT + 100); // 40 unlocked
      const orderId = await grabFiat(
        integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "")
      ); // 20 left unlocked
      // add a FRESH locked deposit (still within settlement)
      const o = await placeOrder(merchant1, 2); // +20, locked
      await mockDiamond.simulateOrderComplete(o);
      // now: 20 unlocked (old) + 20 locked (fresh)
      expect((await integrator.getMerchantBalance(merchant1.address))[0]).to.equal(USDC(20)); // pending(locked)
      expect((await integrator.getMerchantBalance(merchant1.address))[1]).to.equal(USDC(20)); // available

      // cancel + reconcile the fiat withdrawal: re-credits 20 past-dated (unlocked).
      await mockDiamond.cancelSellOrder(orderId);
      await integrator.reconcileWithdrawal(orderId);

      // the FRESH 20 must remain LOCKED — the past-dated re-credit must not have
      // bled into it. available = 20(old) + 20(reconciled) = 40; pending = 20.
      expect((await integrator.getMerchantBalance(merchant1.address))[0]).to.equal(USDC(20)); // still locked
      expect((await integrator.getMerchantBalance(merchant1.address))[1]).to.equal(USDC(40));
    });

    // ─── AUDIT ROUND 2 (this session's audit) ──────────────────────────

    it("FIX B: super-admin handoff is TWO-STEP — pending, not-yet-root, cancellable, accept-gated", async function () {
      expect(await integrator.superAdmin()).to.equal(owner.address);
      // Propose merchant2 — root does NOT move; it's only pending.
      await expect(integrator.connect(owner).transferSuperAdmin(merchant2.address))
        .to.emit(integrator, "SuperAdminTransferStarted")
        .withArgs(owner.address, merchant2.address);
      expect(await integrator.superAdmin()).to.equal(owner.address);
      expect(await integrator.pendingSuperAdmin()).to.equal(merchant2.address);
      // The current super-admin can CANCEL a pending handoff (address(0)).
      await integrator.connect(owner).transferSuperAdmin(ethers.ZeroAddress);
      expect(await integrator.pendingSuperAdmin()).to.equal(ethers.ZeroAddress);
      // A now-stale pending address cannot accept.
      await expect(integrator.connect(merchant2).acceptSuperAdmin()).to.be.revertedWithCustomError(
        integrator,
        "OnlySuperAdmin"
      );
      // Re-propose and complete: only the pending address moves root.
      await integrator.connect(owner).transferSuperAdmin(merchant2.address);
      await integrator.connect(merchant2).acceptSuperAdmin();
      expect(await integrator.superAdmin()).to.equal(merchant2.address);
      expect(await integrator.isOwner(merchant2.address)).to.equal(true);
      // A fat-fingered target that can't call accept never becomes root — the
      // old super-admin (now merchant2) can simply re-point the pending target.
      await integrator.connect(merchant2).transferSuperAdmin(attacker.address); // a "wrong" address
      await integrator.connect(merchant2).transferSuperAdmin(merchant1.address); // corrected before accept
      expect(await integrator.pendingSuperAdmin()).to.equal(merchant1.address);
      await expect(integrator.connect(attacker).acceptSuperAdmin()).to.be.revertedWithCustomError(
        integrator,
        "OnlySuperAdmin"
      ); // the wrong target can't take root
    });

    it("FIX C: the offramp fee is charged from the merchant's buckets even when their proxy is pre-seeded with stray USDC", async function () {
      // Give the merchant 30 available and set a 1 USDC small-order fee.
      await depositFor(merchant1, UPI_1, 3); // 30
      await increaseTime(SETTLEMENT + 3600);
      await mockDiamond.setSellFee(USDC(1));

      // Pre-seed the merchant's own proxy with stray USDC BEFORE the withdrawal —
      // enough that live balanceOf(proxy) would exceed principal+fee. Under the
      // old (balanceOf-keyed) top-up this stray balance would silently cover the
      // fee, leaving feeAdvanced=0 and the merchant's buckets undebited.
      const proxy = await integrator.proxyAddress(merchant1.address);
      await mockUsdc.mint(proxy, USDC(50)); // stray, merchant's own funds

      const orderId = await grabFiat(
        integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "")
      );
      await mockDiamond.acceptSellOrder(orderId, "lp");
      await integrator.connect(merchant1).deliverFiatPayout(orderId, "enc");

      // FIX C: the fee MUST still be debited from the merchant's own unlocked
      // buckets (available drops by principal 20 + fee 1 = 21 → 9), regardless of
      // the stray proxy balance. Before the fix, available would have been 10
      // (only the principal debited, the fee absorbed by the stray USDC).
      expect((await integrator.getMerchantBalance(merchant1.address))[1]).to.equal(USDC(9));
      // And feeAdvanced is recorded as the real fee (1), not 0, so a later
      // cancel/reconcile attributes it exactly.
      const w = await integrator.withdrawals(orderId);
      expect(w.feeAdvanced).to.equal(USDC(1));
    });
  });

  // ─── FINAL pre-whitelisting pass ──────────────────────────────────
  // Locks the exact external surface the frontend depends on, and proves the
  // three withdrawal types end-to-end. If any of these break, the frontend
  // breaks — so they guard against a post-whitelist "you have to change this".
  describe("pre-whitelisting: ABI surface + full lifecycles", function () {
    // Pull the WithdrawalFiat orderId out of a withdraw tx.
    const fiatOrderId = async (txPromise: any) => {
      const r = await (await txPromise).wait();
      return r.logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((l: any) => l?.name === "WithdrawalFiat").args.orderId;
    };

    it("ABI: every function the frontend calls exists with the expected signature", async function () {
      // These are the EXACT signatures in frontend/lib/contract.ts. If a name or
      // arg list drifts, getFunction throws — catching the mismatch here.
      const sigs = [
        // payout handle is now an ENCRYPTED bytes blob, not a plaintext string —
        // the frontend must encrypt client-side and pass bytes here.
        "registerMerchant(bytes,string,string)",
        "updateProfile(bytes,string)",
        "registerMerchantRaw(bytes,string,bytes32)",
        "userPlaceOrder(address,uint256,uint256,bytes32,uint256,string)",
        "withdrawFiat(uint256,uint256,string,string)",
        "withdrawFiatIn(uint256,uint256,bytes32,string)",
        "withdrawUSDC(uint256)",
        "deliverFiatPayout(uint256,string)",
        "getMerchantBalance(address)",
        "getMerchantInfo(address)",
        "getMerchantBuckets(address)",
        "getDailyTxInfo(address)",
        "getMerchantCurrency(address)",
        "proxyAddress(address)",
        "registered(address)",
        // governance + recovery surface (admin panel / ops)
        "transferSuperAdmin(address)",
        "acceptSuperAdmin()", // round-1 fix B: two-step handoff completion
        "pendingSuperAdmin()",
        "adminForceUnwedge(uint256)", // round-2 fix #9: recover a wedged in-flight slot (refund landed)
        "adminForceAbandonWedge(uint256)", // fix #11: guaranteed channel un-brick (never-refund case)
        "setSettlementPeriod(uint256)", // configurable global settlement lock
        "setLockPeriod(bytes32,uint256)", // per-currency settlement lock override
        "lockPeriod(bytes32)",
        "pause()", // break-glass: halt new activity
        "unpause()",
        "adminEscheat(address,address)", // 90-day dormant-freeze fund recovery (super-admin)
        "escheatableAt(address)",
        "paused()",
      ];
      for (const s of sigs) {
        expect(integrator.interface.getFunction(s), s).to.not.equal(null);
      }
      // getMerchantInfo returns 5 values; [0] is now the ENCRYPTED payout blob (bytes).
      const out = integrator.interface
        .getFunction("getMerchantInfo")!
        .outputs.map((o: any) => o.type);
      expect(out).to.deep.equal(["bytes", "string", "bytes32", "bool", "bool"]);
    });

    it("registration REQUIRES a currency (3-arg) — a 2-arg call cannot encode", async function () {
      // registerMerchant takes exactly 3 inputs now (payoutId, shopName,
      // currencyCode). A frontend that passes only 2 fails to encode the call,
      // so the old INR-only assumption can't slip through.
      const fn = integrator.interface.getFunction("registerMerchant")!;
      expect(fn.inputs.length).to.equal(3);
      expect(fn.inputs.map((i: any) => i.type)).to.deep.equal(["bytes", "string", "string"]);
      // Encoding with only 2 args throws (wrong argument count).
      expect(() =>
        integrator.interface.encodeFunctionData("registerMerchant", [UPI_1, "Shop One"])
      ).to.throw();
      // The 3-arg form works + locks the currency.
      await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop One", "INR");
      expect(await integrator.getMerchantCurrency(merchant1.address)).to.equal("INR");
    });

    it("LIFECYCLE A: accept → settle → withdraw USDC to wallet (full happy path)", async function () {
      await depositFor(merchant1, UPI_1, 2); // accept 20, locked
      await increaseTime(SETTLEMENT + 60); // settle
      const before = await mockUsdc.balanceOf(merchant1.address);
      await expect(integrator.connect(merchant1).withdrawUSDC(USDC(20))).to.emit(
        integrator,
        "WithdrawalUSDC"
      );
      const after = await mockUsdc.balanceOf(merchant1.address);
      expect(after - before).to.equal(USDC(20)); // exact USDC landed
      expect((await integrator.getMerchantBalance(merchant1.address))[1]).to.equal(0); // drained
    });

    it("LIFECYCLE B: accept → settle → withdraw HOME fiat → LP pays → COMPLETED (slot freed)", async function () {
      await depositFor(merchant1, UPI_1, 2);
      await increaseTime(SETTLEMENT + 60);
      const orderId = await fiatOrderId(
        integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "")
      );
      await mockDiamond.acceptSellOrder(orderId, "lp"); // no fee set → actual = principal
      await integrator.deliverFiatPayout(orderId, "encPayout");
      await mockDiamond.completeSellOrder(orderId);
      await integrator.finalizeWithdrawal(orderId);
      // slot freed → a brand-new fiat withdrawal is allowed again (no brick).
      // merchant1 is already registered; just accept + settle more funds.
      const o2 = await placeOrder(merchant1, 1);
      await mockDiamond.simulateOrderComplete(o2);
      await increaseTime(SETTLEMENT + 60);
      await expect(integrator.connect(merchant1).withdrawFiat(USDC(10), 1, PK, "")).to.emit(
        integrator,
        "WithdrawalFiat"
      );
    });

    it("LIFECYCLE C: a non-INR (BRL) merchant withdraws in their OWN currency via withdrawFiat", async function () {
      // Proves the home path is currency-generic on the new contract (audit BUG-B
      // fix on-chain): the SELL is placed in BRL, not hardcoded INR.
      await integrator.connect(merchant1).registerMerchant(enc("joao@pix"), "Café", "BRL");
      const o = await placeOrder(merchant1, 2);
      await mockDiamond.simulateOrderComplete(o);
      await increaseTime(SETTLEMENT + 60);
      const orderId = await fiatOrderId(
        integrator.connect(merchant1).withdrawFiat(USDC(20), 2, PK, "")
      );
      // The WithdrawalFiat event carries the merchant's registered currency = BRL.
      const r = await integrator.queryFilter(integrator.filters.WithdrawalFiat());
      const ev = r.find((e: any) => e.args.orderId === orderId);
      expect(ev!.args.currency).to.equal(ethers.encodeBytes32String("BRL"));
    });
  });

  describe("round-3 audit fixes: skimExcess, finalize sweep, handoff TTL, freeze idempotence", function () {
    const fiatOrderId = async (txPromise: any) => {
      const r = await (await txPromise).wait();
      return r.logs
        .map((l: any) => {
          try {
            return integrator.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((l: any) => l?.name === "WithdrawalFiat").args.orderId;
    };

    it("LOW-1: skimExcess recovers ONLY the surplus above totalOwed (super-admin only)", async function () {
      await depositFor(merchant1, UPI_1, 2); // totalOwed = 20, balance = 20
      // Surplus arrives outside any merchant's accounting (donation / over-refund).
      await mockUsdc.mint(await integrator.getAddress(), USDC(7));
      expect(await integrator.totalOwed()).to.equal(USDC(20));
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(USDC(27));

      // Only the super-admin; destination must be non-zero.
      await expect(
        integrator.connect(attacker).skimExcess(attacker.address)
      ).to.be.revertedWithCustomError(integrator, "OnlySuperAdmin");
      await expect(
        integrator.connect(owner).skimExcess(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(integrator, "InvalidAddress");

      // Skims exactly balance - totalOwed; merchant backing is untouched.
      await expect(integrator.connect(owner).skimExcess(merchant2.address))
        .to.emit(integrator, "ExcessSkimmed")
        .withArgs(merchant2.address, USDC(7));
      expect(await mockUsdc.balanceOf(merchant2.address)).to.equal(USDC(7));
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(USDC(20));
      expect(await integrator.totalOwed()).to.equal(USDC(20));

      // Nothing left above totalOwed → reverts (can never dip into merchant funds).
      await expect(
        integrator.connect(owner).skimExcess(merchant2.address)
      ).to.be.revertedWithCustomError(integrator, "NothingToSkim");

      // The merchant can still withdraw their full balance afterwards.
      await increaseTime(SETTLEMENT + 60);
      await integrator.connect(merchant1).withdrawUSDC(USDC(20));
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(0);
    });

    it("LOW-2: finalizeWithdrawal sweeps a proxy leftover and re-credits it (capped, re-locked)", async function () {
      await depositFor(merchant1, UPI_1, 2); // 20
      await increaseTime(SETTLEMENT + 60);
      const orderId = await fiatOrderId(
        integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "")
      );
      await mockDiamond.acceptSellOrder(orderId, "lp");
      await integrator.deliverFiatPayout(orderId, "encPayout");
      await mockDiamond.completeSellOrder(orderId);

      // Simulate the Diamond leaving USDC behind on the proxy (under-pull /
      // stray transfer). Without the fix this would strand forever: the merchant
      // can't sweep USDC and no path targets a COMPLETED order.
      const proxy = await integrator.proxyAddress(merchant1.address);
      await mockUsdc.mint(proxy, USDC(5));

      const owedBefore = await integrator.totalOwed();
      await expect(integrator.finalizeWithdrawal(orderId))
        .to.emit(integrator, "WithdrawalFinalized")
        .withArgs(merchant1.address, orderId, USDC(5)); // leftover < owedBack → full re-credit
      // Swept into custody and credited to the merchant — RE-LOCKED (fiat was
      // delivered, mirror the reconcile rule), so pending not available.
      const [pending, available] = await integrator.getMerchantBalance(merchant1.address);
      expect(pending).to.equal(USDC(5));
      expect(available).to.equal(0);
      expect(await mockUsdc.balanceOf(proxy)).to.equal(0);
      expect(await integrator.totalOwed()).to.equal(owedBefore + USDC(5));
      // Solvency: contract holds what it owes.
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.be.gte(
        await integrator.totalOwed()
      );

      // Slot freed → the fiat channel is open again.
      const w = await integrator.withdrawals(orderId);
      expect(w.settled).to.equal(true);
      expect(w.slotFreed).to.equal(true);
    });

    it("LOW-2 / #4: a clean COMPLETED finalize (empty proxy) credits nothing but STILL emits WithdrawalFinalized(0)", async function () {
      await depositFor(merchant1, UPI_1, 2);
      await increaseTime(SETTLEMENT + 60);
      const orderId = await fiatOrderId(
        integrator.connect(merchant1).withdrawFiat(USDC(20), 1, PK, "")
      );
      await mockDiamond.acceptSellOrder(orderId, "lp");
      await integrator.deliverFiatPayout(orderId, "encPayout");
      await mockDiamond.completeSellOrder(orderId);
      const owedBefore = await integrator.totalOwed();
      // #4: the clean path frees the in-flight slot — a state change the backend
      // must observe — so it now emits WithdrawalFinalized unconditionally (recredit 0).
      await expect(integrator.finalizeWithdrawal(orderId))
        .to.emit(integrator, "WithdrawalFinalized")
        .withArgs(merchant1.address, orderId, 0);
      expect(await integrator.totalOwed()).to.equal(owedBefore); // no credit on the clean path
      // Slot freed even on the clean path.
      const w = await integrator.withdrawals(orderId);
      expect(w.settled).to.equal(true);
      expect(w.slotFreed).to.equal(true);
    });

    it("LOW-2 + M-1: leftover ABOVE owedBack is capped — remainder LEFT ON THE PROXY, not swept into surplus", async function () {
      await depositFor(merchant1, UPI_1, 2); // 20
      await increaseTime(SETTLEMENT + 60);
      const orderId = await fiatOrderId(
        integrator.connect(merchant1).withdrawFiat(USDC(10), 1, PK, "")
      );
      await mockDiamond.acceptSellOrder(orderId, "lp");
      await integrator.deliverFiatPayout(orderId, "encPayout");
      await mockDiamond.completeSellOrder(orderId);

      // Leftover (25) exceeds this order's owedBack (10). M-1: finalize now sweeps
      // ONLY its own capped amount (10) and credits 10 — it does NOT vacuum the
      // whole proxy. The extra 15 STAYS ON THE PROXY (it may belong to another
      // order), rather than being pulled into unattributed surplus.
      const proxy = await integrator.proxyAddress(merchant1.address);
      await mockUsdc.mint(proxy, USDC(25));
      const owedBefore = await integrator.totalOwed();
      await expect(integrator.finalizeWithdrawal(orderId))
        .to.emit(integrator, "WithdrawalFinalized")
        .withArgs(merchant1.address, orderId, USDC(10)); // capped at owedBack
      // Exactly 10 swept + credited; 15 remains on the proxy, untouched.
      expect(await mockUsdc.balanceOf(proxy)).to.equal(USDC(15));
      expect(await integrator.totalOwed()).to.equal(owedBefore + USDC(10));
      // No surplus was created in custody, so there is nothing to skim.
      expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(
        await integrator.totalOwed()
      );
      await expect(
        integrator.connect(owner).skimExcess(owner.address)
      ).to.be.revertedWithCustomError(integrator, "NothingToSkim");
    });

    it("handoff TTL: an expired super-admin proposal cannot be accepted; a fresh one can", async function () {
      const TTL = Number(await integrator.SUPER_ADMIN_HANDOFF_TTL());
      await integrator.connect(owner).transferSuperAdmin(merchant2.address);
      expect(await integrator.pendingSuperAdminExpiry()).to.be.gt(0);

      // Past the TTL the stale proposal is dead — a long-forgotten (possibly
      // compromised) pending key can no longer seize root.
      await increaseTime(TTL + 60);
      await expect(integrator.connect(merchant2).acceptSuperAdmin()).to.be.revertedWithCustomError(
        integrator,
        "HandoffExpired"
      );
      expect(await integrator.superAdmin()).to.equal(owner.address);

      // Re-proposing restarts the window; accepting inside it moves root and
      // clears both pending fields.
      await integrator.connect(owner).transferSuperAdmin(merchant2.address);
      await integrator.connect(merchant2).acceptSuperAdmin();
      expect(await integrator.superAdmin()).to.equal(merchant2.address);
      expect(await integrator.pendingSuperAdmin()).to.equal(ethers.ZeroAddress);
      expect(await integrator.pendingSuperAdminExpiry()).to.equal(0);

      // Cancelling zeroes the expiry too.
      await integrator.connect(merchant2).transferSuperAdmin(merchant1.address);
      await integrator.connect(merchant2).transferSuperAdmin(ethers.ZeroAddress);
      expect(await integrator.pendingSuperAdminExpiry()).to.equal(0);
    });

    it("freeze/unfreeze are idempotent: no duplicate events, dormancy clock never restarted", async function () {
      await integrator.connect(merchant1).registerMerchant(UPI_1, "Shop", INR_CODE);
      // Unfreezing a never-frozen merchant is a silent no-op.
      await expect(integrator.unfreezeMerchant(merchant1.address)).to.not.emit(
        integrator,
        "MerchantUnfrozen"
      );
      await expect(integrator.freezeMerchant(merchant1.address)).to.emit(
        integrator,
        "MerchantFrozen"
      );
      const at = await integrator.escheatableAt(merchant1.address);
      expect(at).to.be.gt(0);
      // Re-freezing later: no event, and the escheat countdown is NOT extended.
      await increaseTime(30 * DAY);
      await expect(integrator.freezeMerchant(merchant1.address)).to.not.emit(
        integrator,
        "MerchantFrozen"
      );
      expect(await integrator.escheatableAt(merchant1.address)).to.equal(at);
    });
  });
});
