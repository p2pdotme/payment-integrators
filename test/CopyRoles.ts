import { expect } from "chai";
import { ethers } from "hardhat";
import { planRoles, applyRoles } from "../scripts/lib/copyRoles";

/**
 * Admin roles and owners are carried to a new integrator at deployment
 * (scripts/lib/copyRoles.ts) — nobody has to be re-granted by hand, and nobody
 * whose access was REVOKED on the old contract gets it back.
 */
async function deployIntegrator(diamond: string, usdc: string) {
  const libs: Record<string, string> = {};
  for (const n of [
    "PaymentLinksLib",
    "MerchantRegistryLib",
    "SettlementLib",
    "MerchantImportLib",
  ]) {
    const c = await (await ethers.getContractFactory(n)).deploy();
    await c.waitForDeployment();
    libs[n] = await c.getAddress();
  }
  const F = await ethers.getContractFactory("MerchantTerminalIntegrator", { libraries: libs });
  const i: any = await F.deploy(diamond, usdc, []);
  await i.waitForDeployment();
  return i;
}

describe("copyRoles — admins and owners follow an upgrade", function () {
  it("copies every current role and owner, newest integrator wins, revoked stay revoked", async function () {
    const [superAdmin, viewer, support, manager, finance, revoked, extraOwner, changed] =
      await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const diamond = await (
      await ethers.getContractFactory("MockDiamond")
    ).deploy(await usdc.getAddress());
    const D = await diamond.getAddress();
    const U = await usdc.getAddress();

    // Oldest integrator.
    const old1 = await deployIntegrator(D, U);
    await old1.setRole(viewer.address, 1);
    await old1.setRole(changed.address, 1); // VIEWER here…
    await old1.setRole(revoked.address, 3);
    await old1.setRole(revoked.address, 0); // …revoked: must NOT be copied
    await old1.addOwner(extraOwner.address);

    // Newer integrator.
    const old2 = await deployIntegrator(D, U);
    await old2.setRole(support.address, 2);
    await old2.setRole(manager.address, 3);
    await old2.setRole(finance.address, 4);
    await old2.setRole(changed.address, 3); // …but MANAGER on the newer one: newest wins

    // The new integrator starts with nobody but the super-admin.
    const fresh = await deployIntegrator(D, U);
    expect(await fresh.roleOf(manager.address)).to.equal(0);

    const plan = await planRoles(
      ethers.provider as any,
      [await old2.getAddress(), await old1.getAddress()],
      superAdmin.address,
      10_000
    );
    await applyRoles(fresh, plan);

    expect(await fresh.roleOf(viewer.address)).to.equal(1);
    expect(await fresh.roleOf(support.address)).to.equal(2);
    expect(await fresh.roleOf(manager.address)).to.equal(3);
    expect(await fresh.roleOf(finance.address)).to.equal(4);
    expect(await fresh.roleOf(changed.address)).to.equal(3); // newest integrator won
    expect(await fresh.roleOf(revoked.address)).to.equal(0); // revoked stays revoked
    expect(await fresh.isOwner(extraOwner.address)).to.equal(true);
    expect(await fresh.superAdmin()).to.equal(superAdmin.address);

    // Idempotent: running it again changes nothing and does not revert.
    await applyRoles(fresh, plan);
    expect(await fresh.ownerCount()).to.equal(2n);
  });
});
