import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("UserProxy", function () {
  let deployer: SignerWithAddress;
  let user: SignerWithAddress;
  let stranger: SignerWithAddress;

  let mockUsdc: any;
  let otherErc20: any; // a non-USDC ERC20 for sweep tests
  let mockNft: any;
  let mockErc1155: any;
  let shim: any;
  let reentrantTarget: any;

  let proxy: any;
  let proxyAddr: string;

  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);

  beforeEach(async function () {
    [deployer, user, stranger] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUsdc = await MockUSDC.deploy();
    otherErc20 = await MockUSDC.deploy(); // a different ERC20 — not the integrator's USDC

    const MockNFT = await ethers.getContractFactory("MockJackpotNFT");
    mockNft = await MockNFT.deploy();

    const MockERC1155 = await ethers.getContractFactory("MockERC1155");
    mockErc1155 = await MockERC1155.deploy();

    const Shim = await ethers.getContractFactory("TestIntegratorShim");
    shim = await Shim.deploy(await mockUsdc.getAddress());

    const ReentrantTarget = await ethers.getContractFactory("ReentrantTarget");
    reentrantTarget = await ReentrantTarget.deploy();

    await shim.deployProxy(await user.getAddress());
    proxyAddr = await shim.proxyAddress(await user.getAddress());
    proxy = await ethers.getContractAt("UserProxy", proxyAddr);
  });

  describe("immutable args", function () {
    it("owner() returns the user EOA", async function () {
      expect(await proxy.owner()).to.equal(await user.getAddress());
    });

    it("integrator() returns the deployer-shim address", async function () {
      expect(await proxy.integrator()).to.equal(await shim.getAddress());
    });
  });

  describe("execute", function () {
    it("reverts OnlyIntegrator when called by a non-integrator", async function () {
      const data = mockUsdc.interface.encodeFunctionData("transfer", [
        await stranger.getAddress(),
        USDC(1),
      ]);
      await expect(
        proxy
          .connect(user)
          .execute(await mockUsdc.getAddress(), data, await mockUsdc.getAddress(), 0)
      ).to.be.revertedWithCustomError(proxy, "OnlyIntegrator");
    });

    it("reverts TargetNotAllowed when target == proxy", async function () {
      await expect(
        shim.callExecute(proxyAddr, proxyAddr, "0x", await mockUsdc.getAddress(), 0)
      ).to.be.revertedWithCustomError(proxy, "TargetNotAllowed");
    });

    it("reverts TargetNotAllowed when target == integrator", async function () {
      await expect(
        shim.callExecute(proxyAddr, await shim.getAddress(), "0x", await mockUsdc.getAddress(), 0)
      ).to.be.revertedWithCustomError(proxy, "TargetNotAllowed");
    });

    it("with no allowance: target is called, no approve traffic occurs", async function () {
      // Call a view function on mockUsdc — succeeds without any approve.
      const data = mockUsdc.interface.encodeFunctionData("balanceOf", [proxyAddr]);
      await expect(
        shim.callExecute(
          proxyAddr,
          await mockUsdc.getAddress(),
          data,
          await mockUsdc.getAddress(),
          0
        )
      ).to.emit(proxy, "Executed");
      // Allowance to target was never set.
      expect(await mockUsdc.allowance(proxyAddr, await mockUsdc.getAddress())).to.equal(0);
    });

    it("with allowance: approves USDC up to allowance, transferFrom works, allowance reset to 0", async function () {
      // Fund the proxy with USDC, then route a transferFrom(proxy → stranger) via a
      // Puller target. forceApprove sets allowance[proxy][puller] = X; puller pulls;
      // execute resets allowance to 0 on the way out.
      const Puller = await ethers.getContractFactory("Puller");
      const puller = await Puller.deploy();
      await mockUsdc.mint(proxyAddr, USDC(10));
      const data = puller.interface.encodeFunctionData("pull", [
        await mockUsdc.getAddress(),
        proxyAddr,
        await stranger.getAddress(),
        USDC(3),
      ]);
      await shim.callExecute(
        proxyAddr,
        await puller.getAddress(),
        data,
        await mockUsdc.getAddress(),
        USDC(3)
      );
      expect(await mockUsdc.balanceOf(await stranger.getAddress())).to.equal(USDC(3));
      expect(await mockUsdc.balanceOf(proxyAddr)).to.equal(USDC(7));
      // Allowance reset after the call.
      expect(await mockUsdc.allowance(proxyAddr, await puller.getAddress())).to.equal(0);
    });

    it("reverts CallFailed when target reverts", async function () {
      // mockUsdc.transfer to address(0) reverts (OZ ERC20)
      const data = mockUsdc.interface.encodeFunctionData("transfer", [ethers.ZeroAddress, USDC(1)]);
      await expect(
        shim.callExecute(
          proxyAddr,
          await mockUsdc.getAddress(),
          data,
          await mockUsdc.getAddress(),
          0
        )
      ).to.be.revertedWithCustomError(proxy, "CallFailed");
    });

    it("nonReentrant: re-entry into execute is rejected (propagated as CallFailed)", async function () {
      await reentrantTarget.arm(await shim.getAddress(), proxyAddr, await mockUsdc.getAddress());
      const data = reentrantTarget.interface.encodeFunctionData("reenter");
      // Outer execute → reentrantTarget.reenter() → shim.callExecute → proxy.execute (2nd) → Reentrancy
      // The inner Reentrancy propagates up as CallFailed at the outer frame.
      await expect(
        shim.callExecute(
          proxyAddr,
          await reentrantTarget.getAddress(),
          data,
          await mockUsdc.getAddress(),
          0
        )
      ).to.be.revertedWithCustomError(proxy, "CallFailed");
    });
  });

  describe("sweepERC20", function () {
    beforeEach(async function () {
      await otherErc20.mint(proxyAddr, USDC(5));
    });

    it("reverts OnlyOwner when called by a non-owner", async function () {
      await expect(
        proxy.connect(stranger).sweepERC20(await otherErc20.getAddress())
      ).to.be.revertedWithCustomError(proxy, "OnlyOwner");
    });

    it("reverts USDCSweepBlocked when token == integrator's USDC", async function () {
      await mockUsdc.mint(proxyAddr, USDC(1));
      await expect(
        proxy.connect(user).sweepERC20(await mockUsdc.getAddress())
      ).to.be.revertedWithCustomError(proxy, "USDCSweepBlocked");
    });

    it("no-op when balance is zero (no SweptERC20 event)", async function () {
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const fresh = await MockUSDC.deploy(); // never funded
      await expect(proxy.connect(user).sweepERC20(await fresh.getAddress())).to.not.emit(
        proxy,
        "SweptERC20"
      );
    });

    it("transfers full balance to msg.sender (= owner) and emits SweptERC20", async function () {
      const before = await otherErc20.balanceOf(await user.getAddress());
      await expect(proxy.connect(user).sweepERC20(await otherErc20.getAddress()))
        .to.emit(proxy, "SweptERC20")
        .withArgs(await otherErc20.getAddress(), await user.getAddress(), USDC(5));
      const after = await otherErc20.balanceOf(await user.getAddress());
      expect(after - before).to.equal(USDC(5));
      expect(await otherErc20.balanceOf(proxyAddr)).to.equal(0);
    });
  });

  describe("sweepERC721", function () {
    let tokenId: bigint;

    beforeEach(async function () {
      tokenId = await mockNft.nextTokenId.staticCall();
      await mockNft.safeMintNext(proxyAddr); // exercises onERC721Received hook on the proxy
    });

    it("reverts OnlyOwner when called by a non-owner", async function () {
      await expect(
        proxy.connect(stranger).sweepERC721(await mockNft.getAddress(), tokenId)
      ).to.be.revertedWithCustomError(proxy, "OnlyOwner");
    });

    it("transfers the token to msg.sender and emits SweptERC721", async function () {
      await expect(proxy.connect(user).sweepERC721(await mockNft.getAddress(), tokenId))
        .to.emit(proxy, "SweptERC721")
        .withArgs(await mockNft.getAddress(), await user.getAddress(), tokenId);
      expect(await mockNft.ownerOf(tokenId)).to.equal(await user.getAddress());
    });
  });

  describe("sweepERC1155", function () {
    const tokenId = 42n;
    const amount = 7n;

    beforeEach(async function () {
      // Triggers onERC1155Received on the proxy via OZ _doSafeTransferAcceptanceCheck.
      await mockErc1155.mint(proxyAddr, tokenId, amount);
    });

    it("reverts OnlyOwner when called by a non-owner", async function () {
      await expect(
        proxy.connect(stranger).sweepERC1155(await mockErc1155.getAddress(), tokenId)
      ).to.be.revertedWithCustomError(proxy, "OnlyOwner");
    });

    it("no-op when balance is zero (no SweptERC1155 event)", async function () {
      await expect(
        proxy.connect(user).sweepERC1155(await mockErc1155.getAddress(), 999)
      ).to.not.emit(proxy, "SweptERC1155");
    });

    it("transfers full balance to msg.sender and emits SweptERC1155", async function () {
      await expect(proxy.connect(user).sweepERC1155(await mockErc1155.getAddress(), tokenId))
        .to.emit(proxy, "SweptERC1155")
        .withArgs(await mockErc1155.getAddress(), await user.getAddress(), tokenId, amount);
      expect(await mockErc1155.balanceOf(await user.getAddress(), tokenId)).to.equal(amount);
      expect(await mockErc1155.balanceOf(proxyAddr, tokenId)).to.equal(0);
    });
  });

  describe("transferERC20ToIntegrator", function () {
    beforeEach(async function () {
      await otherErc20.mint(proxyAddr, USDC(10));
    });

    it("reverts OnlyIntegrator when called by a non-integrator", async function () {
      await expect(
        proxy.connect(stranger).transferERC20ToIntegrator(await otherErc20.getAddress(), USDC(1))
      ).to.be.revertedWithCustomError(proxy, "OnlyIntegrator");
    });

    it("transfers tokens to the integrator (destination is hard-coded)", async function () {
      await shim.callTransferERC20ToIntegrator(proxyAddr, await otherErc20.getAddress(), USDC(4));
      expect(await otherErc20.balanceOf(await shim.getAddress())).to.equal(USDC(4));
      expect(await otherErc20.balanceOf(proxyAddr)).to.equal(USDC(6));
    });
  });

  describe("receiver hooks", function () {
    it("onERC721Received returns the IERC721Receiver selector", async function () {
      const selector = await proxy.onERC721Received.staticCall(
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        0,
        "0x"
      );
      const expected = ethers.id("onERC721Received(address,address,uint256,bytes)").slice(0, 10);
      expect(selector).to.equal(expected);
    });

    it("onERC1155Received returns the IERC1155Receiver single-receive selector", async function () {
      const selector = await proxy.onERC1155Received.staticCall(
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        0,
        0,
        "0x"
      );
      const expected = ethers
        .id("onERC1155Received(address,address,uint256,uint256,bytes)")
        .slice(0, 10);
      expect(selector).to.equal(expected);
    });

    it("onERC1155BatchReceived returns the IERC1155Receiver batch selector", async function () {
      const selector = await proxy.onERC1155BatchReceived.staticCall(
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        [],
        [],
        "0x"
      );
      const expected = ethers
        .id("onERC1155BatchReceived(address,address,uint256[],uint256[],bytes)")
        .slice(0, 10);
      expect(selector).to.equal(expected);
    });
  });

  describe("supportsInterface", function () {
    const IERC165 = "0x01ffc9a7";
    const IERC721_RECEIVER = "0x150b7a02";
    const IERC1155_RECEIVER = "0x4e2312e0";

    it("returns true for IERC165", async function () {
      expect(await proxy.supportsInterface(IERC165)).to.equal(true);
    });

    it("returns true for IERC721Receiver", async function () {
      expect(await proxy.supportsInterface(IERC721_RECEIVER)).to.equal(true);
    });

    it("returns true for IERC1155Receiver", async function () {
      expect(await proxy.supportsInterface(IERC1155_RECEIVER)).to.equal(true);
    });

    it("returns false for arbitrary interface ids", async function () {
      expect(await proxy.supportsInterface("0xdeadbeef")).to.equal(false);
    });
  });
});
