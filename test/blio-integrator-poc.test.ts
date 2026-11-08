import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import type { Wallet } from "ethers";

/**
 * PoC del revisor para BlioCheckoutIntegrator.
 *
 * Estos tres escenarios son reproducciones aisladas de los hallazgos de la
 * revisión. Viven en su propio archivo para que se puedan ejecutar solos:
 *
 *   node ./node_modules/hardhat/internal/cli/cli.js test test/blio-integrator-poc.test.ts
 */
describe("BlioCheckoutIntegrator — PoC del revisor", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let treasury: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let integrator: any;

  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
  const DAILY_COUNT_LIMIT = 5;
  const PRODUCT_ID = 1;
  const PRODUCT_PRICE = USDC(10);
  const INR = ethers.encodeBytes32String("INR");
  const BRL = ethers.encodeBytes32String("BRL");
  const TIER_LIVENESS = 1n;

  const livenessSigner = new ethers.Wallet(
    ethers.keccak256(ethers.toUtf8Bytes("blio-poc-liveness-v1"))
  );
  const kycSigner = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes("blio-poc-kyc-v1")));

  const LIVENESS_TYPES = {
    LivenessAttestation: [
      { name: "wallet", type: "address" },
      { name: "nullifier", type: "bytes32" },
      { name: "limit", type: "uint256" },
      { name: "expiry", type: "uint256" },
    ],
  };

  async function now(): Promise<bigint> {
    return BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  }

  async function attest(who: SignerWithAddress, limit = 0n) {
    const nullifier = ethers.keccak256(
      ethers.toUtf8Bytes(`poc:${who.address}:${Date.now()}:${Math.random()}`)
    );
    const expiry = (await now()) + 600n;
    const value = { wallet: who.address, nullifier, limit, expiry };
    const domain = {
      name: "LivenessVerifier",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await integrator.getAddress(),
    };
    const digest = ethers.TypedDataEncoder.hash(domain, LIVENESS_TYPES, value);
    const signature = ethers.Signature.from(livenessSigner.signingKey.sign(digest)).serialized;
    await integrator.connect(who).submitLivenessAttestation(nullifier, limit, expiry, signature);
  }

  async function place(signer: SignerWithAddress = user, quantity = 1, currency = INR) {
    return integrator.connect(signer).userPlaceOrder(PRODUCT_ID, quantity, currency, 1, "", 0, 0);
  }

  beforeEach(async function () {
    [owner, user, , treasury] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUsdc = await MockUSDC.deploy();

    const MockDiamond = await ethers.getContractFactory("MockDiamond");
    mockDiamond = await MockDiamond.deploy(await mockUsdc.getAddress());

    const Integrator = await ethers.getContractFactory("BlioCheckoutIntegrator");
    integrator = await Integrator.deploy(
      await mockDiamond.getAddress(),
      await mockUsdc.getAddress(),
      treasury.address,
      owner.address,
      DAILY_COUNT_LIMIT,
      livenessSigner.address,
      kycSigner.address
    );

    await mockDiamond.registerIntegrator(
      await integrator.getAddress(),
      await integrator.proxyImpl()
    );
    await integrator.setProductPrice(PRODUCT_ID, PRODUCT_PRICE);
    await integrator.setProductActive(PRODUCT_ID, true);
    await integrator.setCurrencyAllowed(BRL, true);
    await mockUsdc.mint(await mockDiamond.getAddress(), USDC(10000));
    await attest(user);
  });

  it("PoC 1: cancelar, reabrir y completar paga al Safe, emite el evento y NO libera el contador", async function () {
    await place(user, 2);
    const before = await mockUsdc.balanceOf(treasury.address);

    // Cancelación con callback (comportamiento del gateway cuando el hook está
    // habilitado). El cupo diario ya quedó consumido al colocar.
    await mockDiamond.simulateOrderCancelled(1);
    expect((await integrator.getSession(1)).cancelled).to.equal(true);
    expect(await integrator.getTodayCount(user.address)).to.equal(1);

    // Un BUY cancelado NO es terminal: el protocolo lo reabre y lo completa.
    await expect(mockDiamond.simulateOrderComplete(1))
      .to.emit(integrator, "BlioOrderCompleted")
      .withArgs(1, user.address, PRODUCT_ID, 2, USDC(20));

    expect(await mockUsdc.balanceOf(treasury.address)).to.equal(before + USDC(20));

    const session = await integrator.getSession(1);
    expect(session.fulfilled).to.equal(true);
    expect(session.cancelled).to.equal(true);

    // El contador mide COLOCACIONES, no liquidaciones: sigue en 1.
    expect(await integrator.getTodayCount(user.address)).to.equal(1);
  });

  it("PoC 2: 25 ciclos place/cancel en un día; la 6.ª colocación revierte DailyCountExceeded", async function () {
    let placed = 0;

    for (let i = 0; i < 25; i++) {
      if (placed < DAILY_COUNT_LIMIT) {
        await expect(place(user, 1)).to.not.be.reverted;
        placed++;
        await mockDiamond.simulateOrderCancelled(placed);
      } else {
        await expect(place(user, 1)).to.be.revertedWithCustomError(
          integrator,
          "DailyCountExceeded"
        );
      }
    }

    // Solo se crearon los 5 primeros pedidos; el resto nunca llegó al Diamond.
    expect(await mockDiamond.nextOrderId()).to.equal(DAILY_COUNT_LIMIT + 1);
    expect(await integrator.getTodayCount(user.address)).to.equal(DAILY_COUNT_LIMIT);
    expect(await integrator.getRemainingDailyCount(user.address)).to.equal(0n);
  });

  it("PoC 3: los setters de límites revierten CapExceedsCeiling por encima del MAX_", async function () {
    // Los máximos exactos sí se aceptan.
    await expect(integrator.setTxLimit(INR, TIER_LIVENESS, USDC(20))).to.not.be.reverted;
    await expect(integrator.setTxLimit(INR, 2n, USDC(100))).to.not.be.reverted;
    await expect(integrator.setTxLimit(BRL, TIER_LIVENESS, USDC(50))).to.not.be.reverted;
    await expect(integrator.setTxLimit(BRL, 2n, USDC(200))).to.not.be.reverted;
    await expect(integrator.setDailyTxCountLimit(DAILY_COUNT_LIMIT)).to.not.be.reverted;

    // Un wei por encima de cada techo, no.
    await expect(
      integrator.setTxLimit(INR, TIER_LIVENESS, USDC(20) + 1n)
    ).to.be.revertedWithCustomError(integrator, "CapExceedsCeiling");
    await expect(integrator.setTxLimit(INR, 2n, USDC(100) + 1n)).to.be.revertedWithCustomError(
      integrator,
      "CapExceedsCeiling"
    );
    await expect(
      integrator.setTxLimit(BRL, TIER_LIVENESS, USDC(50) + 1n)
    ).to.be.revertedWithCustomError(integrator, "CapExceedsCeiling");
    await expect(integrator.setTxLimit(BRL, 2n, USDC(200) + 1n)).to.be.revertedWithCustomError(
      integrator,
      "CapExceedsCeiling"
    );
    await expect(
      integrator.setDailyTxCountLimit(DAILY_COUNT_LIMIT + 1)
    ).to.be.revertedWithCustomError(integrator, "CapExceedsCeiling");
  });
});
