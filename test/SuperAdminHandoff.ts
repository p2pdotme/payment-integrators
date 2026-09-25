import { expect } from "chai";
import { ethers } from "hardhat";
import { checkMultisig, handoffStatus, proposeHandoff, safeBatch } from "../scripts/lib/superAdmin";

/**
 * PR #108 review: "The super-admin needs to be a multisig before mainnet. It now
 * sets trustedRelayer, which is a root-of-trust power, and the deploy script
 * leaves the deployer EOA as super-admin."
 *
 * The deploy tooling now refuses anything but a real (≥2-of-N) multisig on
 * mainnet, proposes the handoff after setup, and prints the Safe batch that
 * accepts it and drops the deployer's leftover owner access.
 */
describe("super-admin → multisig handoff (deploy tooling)", function () {
  async function setup() {
    const [deployer, s1, s2, s3, outsider] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const diamond = await (
      await ethers.getContractFactory("MockDiamond")
    ).deploy(await usdc.getAddress());
    const libs: Record<string, string> = {};
    for (const n of [
      "PaymentLinksLib",
      "MerchantRegistryLib",
      "SettlementLib",
      "MerchantImportLib",
    ]) {
      const c = await (await ethers.getContractFactory(n)).deploy();
      libs[n] = await c.getAddress();
    }
    const integrator: any = await (
      await ethers.getContractFactory("MerchantTerminalIntegrator", { libraries: libs })
    ).deploy(await diamond.getAddress(), await usdc.getAddress(), []);
    const Safe = await ethers.getContractFactory("MockSafe");
    const safe: any = await Safe.deploy([s1.address, s2.address, s3.address], 2);
    const oneOfN: any = await Safe.deploy([s1.address, s2.address], 1);
    return { deployer, s1, s2, s3, outsider, integrator, safe, oneOfN };
  }

  /** Run a call on `to` through the 2-of-3 MockSafe (two owners approve). */
  async function viaSafe(safe: any, signers: any[], to: string, data: string, nonce: number) {
    for (const s of signers) await safe.connect(s).exec(to, data, nonce);
  }

  it("refuses an EOA, a non-Safe contract and a 1-of-N Safe; accepts a 2-of-3", async function () {
    const { deployer, integrator, safe, oneOfN } = await setup();
    const p = ethers.provider;
    const MAIN = { chainId: 8453n };
    await expect(checkMultisig(p, deployer.address, MAIN)).to.be.rejectedWith(/no code/);
    await expect(checkMultisig(p, await integrator.getAddress(), MAIN)).to.be.rejectedWith(
      /not a Safe/
    );
    await expect(checkMultisig(p, await oneOfN.getAddress(), MAIN)).to.be.rejectedWith(/1-of-2/);
    // A 1-of-N rehearsal is allowed on a testnet only, and only when asked for.
    await expect(
      checkMultisig(p, await oneOfN.getAddress(), { chainId: 84532n })
    ).to.be.rejectedWith(/1-of-2/);
    await checkMultisig(p, await oneOfN.getAddress(), { chainId: 84532n, allowSingleSigner: true });
    await expect(
      checkMultisig(p, await oneOfN.getAddress(), { ...MAIN, allowSingleSigner: true })
    ).to.be.rejectedWith(/1-of-2/);
    const ok = await checkMultisig(p, await safe.getAddress(), MAIN);
    expect(ok.threshold).to.equal(2);
    expect(ok.owners.length).to.equal(3);
  });

  it("full handoff: propose → Safe accepts + removes deployer → deployer key holds nothing", async function () {
    const { deployer, s1, s2, outsider, integrator, safe } = await setup();
    const I = await integrator.getAddress();
    const S = await safe.getAddress();

    // Before: single-key root. Status says not done.
    expect((await handoffStatus(integrator, ethers.provider, S, deployer.address)).done).to.equal(
      false
    );

    await proposeHandoff(integrator, S, () => {});
    expect(await integrator.pendingSuperAdmin()).to.equal(S);
    expect(await integrator.superAdmin()).to.equal(deployer.address); // proposal alone moves nothing
    await proposeHandoff(integrator, S, () => {}); // idempotent: no second tx needed

    // One Safe owner alone cannot complete it.
    const [accept, drop] = safeBatch(I, deployer.address);
    await safe.connect(s1).exec(accept.to, accept.data, 1);
    expect(await integrator.superAdmin()).to.equal(deployer.address);
    // The second approval executes it.
    await safe.connect(s2).exec(accept.to, accept.data, 1);
    expect(await integrator.superAdmin()).to.equal(S);
    await viaSafe(safe, [s1, s2], drop.to, drop.data, 2);

    const st = await handoffStatus(integrator, ethers.provider, S, deployer.address);
    expect(st.done).to.equal(true);
    expect(st.deployerStillOwner).to.equal(false);

    // The deployer key can no longer touch any root power…
    await expect(
      integrator.connect(deployer).setTrustedRelayer(outsider.address)
    ).to.be.revertedWithCustomError(integrator, "OnlySuperAdmin");
    await expect(
      integrator.connect(deployer).addOwner(outsider.address)
    ).to.be.revertedWithCustomError(integrator, "OnlySuperAdmin");
    await expect(integrator.connect(deployer).setDailyLimit(1000)).to.be.reverted;
    // …and the multisig can.
    const iface = integrator.interface;
    await viaSafe(
      safe,
      [s1, s2],
      I,
      iface.encodeFunctionData("setTrustedRelayer", [outsider.address]),
      3
    );
    expect(await integrator.trustedRelayer()).to.equal(outsider.address);
  });

  it("a mistyped / uncontrolled target can never take root, and the deployer can re-propose", async function () {
    const { deployer, outsider, integrator, safe } = await setup();
    await proposeHandoff(integrator, outsider.address, () => {}); // wrong address proposed
    // Only the proposed address can accept; the real Safe cannot, and root stays put.
    await expect(integrator.connect(deployer).acceptSuperAdmin()).to.be.reverted;
    await proposeHandoff(integrator, await safe.getAddress(), () => {}); // corrected
    expect(await integrator.pendingSuperAdmin()).to.equal(await safe.getAddress());
    await expect(integrator.connect(outsider).acceptSuperAdmin()).to.be.reverted;
  });
});
