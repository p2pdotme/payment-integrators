import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * PayQRVault — the segregated custody contract. These tests focus on the
 * "airtight" integrator↔vault link Aash flagged: only the linked integrator can
 * pull, the link is a MUTUAL handshake (the vault refuses an integrator that
 * doesn't point back at it), the lock is a real kill-switch, migration repoints
 * cleanly, and the multi-owner governance behaves. Full lifecycle-through-the-
 * vault coverage lives in MerchantTerminalIntegrator.ts (which deploys the real
 * integrator over this vault).
 *
 * The "integrator" here is a MockVaultIntegrator — a tiny contract with a
 * `vault()` getter (so the handshake passes) and a `doPull` that forwards to the
 * vault, mirroring the real integrator's _vaultPull. An EOA can't be the
 * integrator anymore: setIntegrator calls `vault()` on the candidate.
 */
describe("PayQRVault — custody, airtight pull, lock, migration, multi-owner", function () {
  let owner: SignerWithAddress;
  let attacker: SignerWithAddress;
  let alice: SignerWithAddress;
  let stranger: SignerWithAddress;  // never an owner — for negative checks

  let usdc: any;
  let vault: any;
  let integrator: any;   // MockVaultIntegrator, wired to the vault (handshake ok)
  let integrator2: any;  // migration target, also wired to the vault

  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);

  // Deploy a MockVaultIntegrator already pointing at `vaultAddr` (handshake-ready).
  async function newIntegrator(vaultAddr: string) {
    const M = await ethers.getContractFactory("MockVaultIntegrator");
    const m = await M.deploy();
    await m.setVault(vaultAddr);
    return m;
  }

  beforeEach(async function () {
    [owner, attacker, alice, stranger] = await ethers.getSigners();
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();
    const Vault = await ethers.getContractFactory("PayQRVault");
    vault = await Vault.deploy(await usdc.getAddress(), []);
    const vaultAddr = await vault.getAddress();

    // Two handshake-ready integrators pointing back at the vault.
    integrator = await newIntegrator(vaultAddr);
    integrator2 = await newIntegrator(vaultAddr);

    // Authorise integrator #1 (handshake passes) and fund the vault.
    await vault.setIntegrator(await integrator.getAddress());
    await usdc.mint(vaultAddr, USDC(1000));
  });

  it("holds funds; balance() reflects the USDC held", async function () {
    expect(await vault.balance()).to.equal(USDC(1000));
    expect(await usdc.balanceOf(await vault.getAddress())).to.equal(USDC(1000));
  });

  it("AIRTIGHT: only the linked integrator can pull", async function () {
    // The linked integrator can pull (via its doPull → vault.pull).
    await expect(integrator.doPull(alice.address, USDC(100)))
      .to.emit(vault, "Pulled").withArgs(alice.address, USDC(100));
    expect(await usdc.balanceOf(alice.address)).to.equal(USDC(100));
    // NOBODY else can — not owner, not a random attacker (direct pull call).
    await expect(vault.connect(owner).pull(owner.address, USDC(1)))
      .to.be.revertedWithCustomError(vault, "NotIntegrator");
    await expect(vault.connect(attacker).pull(attacker.address, USDC(1)))
      .to.be.revertedWithCustomError(vault, "NotIntegrator");
    // The OTHER (unlinked) integrator can't pull either, even though it points
    // back at this vault — it isn't the authorised one.
    await expect(integrator2.doPull(alice.address, USDC(1)))
      .to.be.revertedWithCustomError(vault, "NotIntegrator");
  });

  it("AIRTIGHT HANDSHAKE: setIntegrator rejects an integrator that doesn't point back", async function () {
    // A contract whose vault() != this vault is refused (asymmetric link).
    const stray = await newIntegrator(attacker.address); // points elsewhere
    await expect(vault.connect(owner).setIntegrator(await stray.getAddress()))
      .to.be.revertedWithCustomError(vault, "LinkMismatch");
    // An EOA (no vault() getter) is refused too — the call reverts.
    await expect(vault.connect(owner).setIntegrator(attacker.address)).to.be.reverted;
    // The authorised integrator is unchanged after the failed attempts.
    expect(await vault.integrator()).to.equal(await integrator.getAddress());
  });

  it("pull rejects zero address / zero amount", async function () {
    await expect(integrator.doPull(ethers.ZeroAddress, USDC(1)))
      .to.be.revertedWithCustomError(vault, "BadPull");
    await expect(integrator.doPull(alice.address, 0))
      .to.be.revertedWithCustomError(vault, "BadPull");
  });

  it("KILL-SWITCH: lock() blocks ALL pulls until unlock()", async function () {
    await expect(vault.connect(owner).lock()).to.emit(vault, "Locked");
    expect(await vault.locked()).to.equal(true);
    // Even the legit integrator cannot pull while locked.
    await expect(integrator.doPull(alice.address, USDC(1)))
      .to.be.revertedWithCustomError(vault, "VaultLocked");
    // Unlock restores pulls.
    await expect(vault.connect(owner).unlock()).to.emit(vault, "Unlocked");
    await expect(integrator.doPull(alice.address, USDC(5))).to.emit(vault, "Pulled");
  });

  it("kill-switch lock/unlock is owner-gated; setIntegrator is super-admin-gated", async function () {
    // lock/unlock: any OWNER (broad break-glass), rejected for a non-owner.
    await expect(vault.connect(attacker).lock()).to.be.revertedWithCustomError(vault, "NotOwner");
    // setIntegrator: super-admin ONLY — even a non-super-admin owner can't repoint.
    await vault.connect(owner).addOwner(alice.address); // alice = owner, not super-admin
    await expect(vault.connect(alice).setIntegrator(await integrator2.getAddress()))
      .to.be.revertedWithCustomError(vault, "OnlySuperAdmin");
    await expect(vault.connect(attacker).setIntegrator(await integrator2.getAddress()))
      .to.be.revertedWithCustomError(vault, "OnlySuperAdmin");
    await vault.connect(owner).lock();
    await expect(vault.connect(attacker).unlock()).to.be.revertedWithCustomError(vault, "NotOwner");
    // ...but a plain owner CAN operate the kill-switch (that's the point).
    await vault.connect(alice).unlock();
    await vault.connect(alice).lock();
    await vault.connect(alice).unlock();
  });

  it("MIGRATION: setIntegrator repoints; old integrator can no longer pull, new one can — funds never move", async function () {
    const balBefore = await vault.balance();
    // Repoint to the second (handshake-ready) integrator.
    await expect(vault.connect(owner).setIntegrator(await integrator2.getAddress()))
      .to.emit(vault, "IntegratorSet")
      .withArgs(await integrator.getAddress(), await integrator2.getAddress());
    // No USDC moved during migration.
    expect(await vault.balance()).to.equal(balBefore);
    // Old integrator is now powerless; the new one can pull.
    await expect(integrator.doPull(alice.address, USDC(1)))
      .to.be.revertedWithCustomError(vault, "NotIntegrator");
    await expect(integrator2.doPull(alice.address, USDC(10))).to.emit(vault, "Pulled");
  });

  it("setIntegrator(0) disables pulls (belt-and-braces with lock), no handshake needed", async function () {
    await vault.connect(owner).setIntegrator(ethers.ZeroAddress);
    await expect(integrator.doPull(alice.address, USDC(1)))
      .to.be.revertedWithCustomError(vault, "NotIntegrator");
  });

  it("SUPER-ADMIN owner set: only super-admin adds/removes owners; owners get the kill-switch, not governance", async function () {
    expect(await vault.ownerCount()).to.equal(1);
    expect(await vault.superAdmin()).to.equal(owner.address);
    // Super-admin adds a second owner.
    await expect(vault.connect(owner).addOwner(alice.address)).to.emit(vault, "OwnerAdded").withArgs(alice.address);
    expect(await vault.isOwner(alice.address)).to.equal(true);
    // The second owner has the OPERATIONAL kill-switch...
    await vault.connect(alice).lock();
    await vault.connect(alice).unlock();
    // ...but CANNOT manage the owner set (governance = super-admin only).
    await expect(vault.connect(alice).addOwner(attacker.address))
      .to.be.revertedWithCustomError(vault, "OnlySuperAdmin");
    await expect(vault.connect(alice).removeOwner(owner.address))
      .to.be.revertedWithCustomError(vault, "OnlySuperAdmin");
    // A genuine non-owner can't either.
    await expect(vault.connect(stranger).removeOwner(owner.address))
      .to.be.revertedWithCustomError(vault, "OnlySuperAdmin");
    // The super-admin can never be removed as an owner (even by itself).
    await expect(vault.connect(owner).removeOwner(owner.address))
      .to.be.revertedWithCustomError(vault, "CannotRemoveSuperAdmin");
    // Super-admin adds a third then removes the non-super-admin owners down to itself.
    await vault.connect(owner).addOwner(attacker.address);
    expect(await vault.ownerCount()).to.equal(3);
    await vault.connect(owner).removeOwner(attacker.address);
    await vault.connect(owner).removeOwner(alice.address);
    expect(await vault.ownerCount()).to.equal(1);
    // Now only the super-admin remains; it still can't be removed.
    await expect(vault.connect(owner).removeOwner(owner.address))
      .to.be.revertedWithCustomError(vault, "CannotRemoveSuperAdmin");
  });

  it("SUPER-ADMIN handoff: TWO-STEP (propose + accept), super-admin only, keeps root an owner", async function () {
    expect(await vault.superAdmin()).to.equal(owner.address);
    // Rejections: non-super-admin proposing, and no-op self-handoff.
    await expect(vault.connect(attacker).transferSuperAdmin(attacker.address))
      .to.be.revertedWithCustomError(vault, "OnlySuperAdmin");
    await expect(vault.connect(owner).transferSuperAdmin(owner.address))
      .to.be.revertedWithCustomError(vault, "InvalidAddress");
    // AUDIT FIX B — propose alice; root does NOT move until alice accepts.
    await expect(vault.connect(owner).transferSuperAdmin(alice.address))
      .to.emit(vault, "SuperAdminTransferStarted").withArgs(owner.address, alice.address);
    expect(await vault.superAdmin()).to.equal(owner.address);           // unchanged
    expect(await vault.pendingSuperAdmin()).to.equal(alice.address);
    // A non-pending address cannot accept.
    await expect(vault.connect(attacker).acceptSuperAdmin())
      .to.be.revertedWithCustomError(vault, "OnlySuperAdmin");
    // Alice accepts → becomes super-admin AND an owner; prev stays an owner; pending clears.
    await expect(vault.connect(alice).acceptSuperAdmin())
      .to.emit(vault, "SuperAdminTransferred").withArgs(owner.address, alice.address);
    expect(await vault.superAdmin()).to.equal(alice.address);
    expect(await vault.pendingSuperAdmin()).to.equal(ethers.ZeroAddress);
    expect(await vault.isOwner(alice.address)).to.equal(true);
    expect(await vault.isOwner(owner.address)).to.equal(true);
    // Old super-admin can no longer manage owners / integrator.
    await expect(vault.connect(owner).addOwner(attacker.address))
      .to.be.revertedWithCustomError(vault, "OnlySuperAdmin");
    // New super-admin can, and can remove the old one as a plain owner.
    await vault.connect(alice).removeOwner(owner.address);
    expect(await vault.isOwner(owner.address)).to.equal(false);
  });

  it("constructor seeds superAdmin = deployer and emits SuperAdminTransferred(0, deployer)", async function () {
    const Vault = await ethers.getContractFactory("PayQRVault");
    const v2 = await Vault.deploy(await usdc.getAddress(), []);
    expect(await v2.superAdmin()).to.equal(owner.address);
    expect(await v2.isOwner(owner.address)).to.equal(true);
    const ev = v2.interface.getEvent("SuperAdminTransferred");
    const logs = await ethers.provider.getLogs({
      address: await v2.getAddress(), topics: [ev!.topicHash], fromBlock: 0, toBlock: "latest",
    });
    const parsed = logs.map((l) => v2.interface.parseLog(l)!);
    const seed = parsed.find((p) => p.args.previous === ethers.ZeroAddress);
    expect(seed, "constructor should emit SuperAdminTransferred(0, deployer)").to.not.equal(undefined);
    expect(seed!.args.next).to.equal(owner.address);
  });

  it("constructor seeds deployer + extra owners", async function () {
    const Vault = await ethers.getContractFactory("PayQRVault");
    const v2 = await Vault.deploy(await usdc.getAddress(), [alice.address, attacker.address]);
    expect(await v2.isOwner(owner.address)).to.equal(true);   // deployer
    expect(await v2.isOwner(alice.address)).to.equal(true);
    expect(await v2.isOwner(attacker.address)).to.equal(true);
    expect(await v2.ownerCount()).to.equal(3);
  });

  it("constructor rejects zero USDC", async function () {
    const Vault = await ethers.getContractFactory("PayQRVault");
    await expect(Vault.deploy(ethers.ZeroAddress, [])).to.be.revertedWithCustomError(vault, "InvalidAddress");
  });

  it("lock()/unlock() revert if already in that state (no-op guard)", async function () {
    await expect(vault.connect(owner).unlock()).to.be.revertedWithCustomError(vault, "AlreadySet"); // not locked
    await vault.connect(owner).lock();
    await expect(vault.connect(owner).lock()).to.be.revertedWithCustomError(vault, "AlreadySet"); // already locked
  });
});
