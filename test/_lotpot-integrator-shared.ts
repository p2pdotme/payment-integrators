import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * Shared behavior suite for LotPot integrator V1 and V2. V2 is a strict
 * superset of V1 (additive credit-ledger + vault-pull paths that stay
 * dormant when issuers/vaults are unconfigured) so the same expectations
 * hold against both factories. The caller picks the contract name + suite
 * label.
 */
export function runLotpotIntegratorSharedTests(
  describeLabel: string,
  integratorFactoryName: string
) {
  describe(describeLabel, function () {
    let owner: SignerWithAddress;
    let user: SignerWithAddress;
    let user2: SignerWithAddress;
    let stranger: SignerWithAddress;

    let mockUsdc: any;
    let mockDiamond: any;
    let mockMegapot: any;
    let mockBatch: any;
    let mockNft: any;
    let integrator: any;

    const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
    const TICKET_PRICE = USDC(1);
    const BASE_TX_LIMIT = USDC(50);
    const DAILY_COUNT_LIMIT = 10;
    const BALL_MAX = 30;
    const BONUSBALL_MAX = 15;
    const SOURCE = ethers.encodeBytes32String("lotpot");
    const INR = ethers.encodeBytes32String("INR");

    beforeEach(async function () {
      [owner, user, user2, stranger] = await ethers.getSigners();

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
        11 // minimumTicketCount — matches Base mainnet at probe time
      );

      const Integrator = await ethers.getContractFactory(integratorFactoryName);
      integrator = await Integrator.deploy(
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

      // Allowlist the integrator on the batch facilitator — mirrors what
      // Megapot's owner needs to do on mainnet before the batch path works.
      await mockBatch.addAllowed(await integrator.getAddress());
    });

    describe("Tickets minted directly to user EOA", function () {
      it("calls Megapot with _recipient = user EOA — no proxy hop", async function () {
        const proxyAddr = await integrator.proxyAddress(user.address);

        await integrator.connect(user).userPlaceOrder(3, INR, 1, "", 0, 0, [], []);

        // Caller is the proxy (it holds USDC and calls buyTickets), but the
        // recipient parameter is the user EOA so NFTs land there in one step.
        await expect(mockDiamond.simulateOrderComplete(1))
          .to.emit(mockMegapot, "BuyTicketsCalled")
          .withArgs(proxyAddr, user.address, 3, SOURCE);

        expect(await mockMegapot.lastRecipient()).to.equal(user.address);

        // NFTs went straight to the user; proxy was never holding them.
        expect(await mockNft.balanceOf(user.address)).to.equal(3);
        expect(await mockNft.balanceOf(proxyAddr)).to.equal(0);
        expect(await mockNft.ownerOf(1)).to.equal(user.address);
        expect(await mockNft.ownerOf(2)).to.equal(user.address);
        expect(await mockNft.ownerOf(3)).to.equal(user.address);
      });

      it("works regardless of whether NFT contract uses _mint or _safeMint to an EOA", async function () {
        // _mint path (no receiver hook fires)
        await mockMegapot.setUseSafeMint(false);
        await integrator.connect(user).userPlaceOrder(2, INR, 1, "", 0, 0, [], []);
        await mockDiamond.simulateOrderComplete(1);
        expect(await mockNft.balanceOf(user.address)).to.equal(2);

        // _safeMint to an EOA: OZ ERC721 skips the receiver-hook check when
        // the destination has no code, so plain EOAs always work.
        await mockMegapot.setUseSafeMint(true);
        await integrator.connect(user2).userPlaceOrder(2, INR, 1, "", 0, 0, [], []);
        await mockDiamond.simulateOrderComplete(2);
        expect(await mockNft.balanceOf(user2.address)).to.equal(2);
        expect(await mockNft.balanceOf(await integrator.proxyAddress(user2.address))).to.equal(0);
      });

      it("USDC ends up with Megapot, not the proxy or integrator", async function () {
        await integrator.connect(user).userPlaceOrder(2, INR, 1, "", 0, 0, [], []);
        await mockDiamond.simulateOrderComplete(1);

        expect(await mockUsdc.balanceOf(await mockMegapot.getAddress())).to.equal(USDC(2));
        expect(await mockUsdc.balanceOf(await integrator.proxyAddress(user.address))).to.equal(0);
        expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(0);
      });
    });

    describe("Auto-random ticket numbers (option a)", function () {
      it("generates valid sorted unique normals and a valid bonusball", async function () {
        await integrator.connect(user).userPlaceOrder(3, INR, 1, "", 0, 0, [], []);
        await mockDiamond.simulateOrderComplete(1);

        const tickets = await mockMegapot.getLastTickets();
        expect(tickets.length).to.equal(3);
        for (const t of tickets) {
          expect(t.normals.length).to.equal(5);
          let prev = 0;
          const seen = new Set<number>();
          for (const n of t.normals) {
            const num = Number(n);
            expect(num).to.be.greaterThanOrEqual(1);
            expect(num).to.be.lessThanOrEqual(BALL_MAX);
            expect(num).to.be.greaterThan(prev);
            expect(seen.has(num)).to.equal(false);
            seen.add(num);
            prev = num;
          }
          const bb = Number(t.bonusball);
          expect(bb).to.be.greaterThanOrEqual(1);
          expect(bb).to.be.lessThanOrEqual(BONUSBALL_MAX);
        }
      });

      it("rejects quantity = 0; the de-facto ticket cap is the per-tx USDC limit", async function () {
        await expect(
          integrator.connect(user).userPlaceOrder(0, INR, 1, "", 0, 0, [], [])
        ).to.be.revertedWithCustomError(integrator, "InvalidQuantity");

        // No hardcoded ticket count cap — quantity is bounded by
        // getUserTxLimit / ticketPrice (enforced by validateOrder). With
        // baseTxLimit=50 USDC and ticketPrice=1 USDC, a 0-RP user maxes at
        // 50 tickets. 51 reverts via the gateway's
        // B2BIntegratorRejectedOrder, not a hardcoded check.
        await expect(integrator.connect(user).userPlaceOrder(51, INR, 1, "", 0, 0, [], [])).to.be
          .reverted;
      });

      it("type-level safety net: quantity > uint64 max reverts with TooManyTickets", async function () {
        // The batch path narrows quantity to uint64 for createBatchOrder.
        // Without this guard a uint256 quantity above uint64 max would
        // silently truncate to garbage.
        const overUint64 = 1n << 64n;
        await expect(
          integrator.connect(user).userPlaceOrder(overUint64, INR, 1, "", 0, 0, [], [])
        ).to.be.revertedWithCustomError(integrator, "TooManyTickets");
      });
    });

    describe("User-picked tickets (option b)", function () {
      const goodPicks = [
        { normals: [3, 7, 12, 19, 25], bonusball: 8 },
        { normals: [1, 2, 3, 4, 5], bonusball: 1 },
      ];

      it("places, fulfills, NFTs land on user with the user's exact ticket data", async function () {
        await integrator.connect(user).userPlaceOrderWithPicks(goodPicks, INR, 1, "", 0, 0, [], []);
        await mockDiamond.simulateOrderComplete(1);

        const tickets = await mockMegapot.getLastTickets();
        expect(tickets[0].normals.map((n: any) => Number(n))).to.deep.equal([3, 7, 12, 19, 25]);
        expect(Number(tickets[0].bonusball)).to.equal(8);
        expect(await mockNft.balanceOf(user.address)).to.equal(2);
      });

      it("rejects picks with wrong normals length", async function () {
        const bad = [{ normals: [1, 2, 3, 4], bonusball: 5 }];
        await expect(
          integrator.connect(user).userPlaceOrderWithPicks(bad, INR, 1, "", 0, 0, [], [])
        ).to.be.revertedWithCustomError(integrator, "InvalidTicketNumbers");
      });

      it("rejects unsorted normals", async function () {
        const bad = [{ normals: [5, 3, 7, 12, 19], bonusball: 8 }];
        await expect(
          integrator.connect(user).userPlaceOrderWithPicks(bad, INR, 1, "", 0, 0, [], [])
        ).to.be.revertedWithCustomError(integrator, "InvalidTicketNumbers");
      });

      it("rejects duplicate normals", async function () {
        const bad = [{ normals: [3, 3, 7, 12, 19], bonusball: 8 }];
        await expect(
          integrator.connect(user).userPlaceOrderWithPicks(bad, INR, 1, "", 0, 0, [], [])
        ).to.be.revertedWithCustomError(integrator, "InvalidTicketNumbers");
      });

      it("rejects out-of-range normals", async function () {
        const bad = [{ normals: [3, 7, 12, 19, 31], bonusball: 8 }];
        await expect(
          integrator.connect(user).userPlaceOrderWithPicks(bad, INR, 1, "", 0, 0, [], [])
        ).to.be.revertedWithCustomError(integrator, "InvalidTicketNumbers");
      });

      it("rejects out-of-range bonusball", async function () {
        const bad = [{ normals: [3, 7, 12, 19, 25], bonusball: 16 }];
        await expect(
          integrator.connect(user).userPlaceOrderWithPicks(bad, INR, 1, "", 0, 0, [], [])
        ).to.be.revertedWithCustomError(integrator, "InvalidTicketNumbers");
      });

      it("rejects empty picks; the de-facto cap is the per-tx USDC limit (not 10)", async function () {
        await expect(
          integrator.connect(user).userPlaceOrderWithPicks([], INR, 1, "", 0, 0, [], [])
        ).to.be.revertedWithCustomError(integrator, "InvalidQuantity");

        // 11+ picks no longer hard-revert in the integrator — they're routed
        // to BatchPurchaseFacilitator with all picks as `_userStaticTickets`.
        // The actual ceiling is the per-tx USDC limit (validateOrder).
        // The 11-pick attempt below would succeed if the user had enough
        // RP/limit; with the test's 50 USDC base limit and 1 USDC ticket
        // price it fits under the cap (11 * 1 = 11 USDC < 50 USDC).
        const elevenPicks = Array(11).fill({ normals: [1, 2, 3, 4, 5], bonusball: 1 });
        await expect(
          integrator.connect(user).userPlaceOrderWithPicks(elevenPicks, INR, 1, "", 0, 0, [], [])
        ).to.not.be.reverted;
      });
    });

    describe("Proxy lifecycle", function () {
      it("deploys proxy lazily on first order placement", async function () {
        // Proxy now needs to exist BEFORE the placeB2BOrder call (it's the actor),
        // so the integrator deploys it during userPlaceOrder rather than during
        // onOrderComplete.
        const proxyAddr = await integrator.proxyAddress(user.address);
        expect(await ethers.provider.getCode(proxyAddr)).to.equal("0x");

        await expect(integrator.connect(user).userPlaceOrder(1, INR, 1, "", 0, 0, [], []))
          .to.emit(integrator, "UserProxyDeployed")
          .withArgs(user.address, proxyAddr);

        expect(await ethers.provider.getCode(proxyAddr)).to.not.equal("0x");
      });

      it("reuses the same proxy across orders", async function () {
        await integrator.connect(user).userPlaceOrder(1, INR, 1, "", 0, 0, [], []);
        await mockDiamond.simulateOrderComplete(1);

        // Second placement should NOT redeploy the proxy.
        const tx = await integrator.connect(user).userPlaceOrder(1, INR, 1, "", 0, 0, [], []);
        const receipt = await tx.wait();
        const deployedTopic = integrator.interface.getEvent("UserProxyDeployed").topicHash;
        expect(receipt.logs.some((l: any) => l.topics[0] === deployedTopic)).to.equal(false);

        await mockDiamond.simulateOrderComplete(2);

        // Both orders' tickets land on user
        expect(await mockNft.balanceOf(user.address)).to.equal(2);
      });

      it("USDC remainder stays on the proxy as credit when Megapot pulls less than approved", async function () {
        // Megapot drops its price between placement (1 USDC) and fulfillment
        // (0.9 USDC). proxy.execute approves the full 2 USDC; Megapot pulls
        // only 1.8 USDC; the remaining 0.2 USDC now lives on the proxy as
        // future credit (not auto-pushed to the user EOA — that would be
        // the fraud-bypass exit we deliberately closed).
        const proxyAddr = await integrator.proxyAddress(user.address);
        await integrator.connect(user).userPlaceOrder(2, INR, 1, "", 0, 0, [], []);
        await mockMegapot.setTicketPrice(USDC(1) - 100000n);
        await mockDiamond.simulateOrderComplete(1);

        expect(await mockNft.balanceOf(user.address)).to.equal(2);
        expect(await mockUsdc.balanceOf(proxyAddr)).to.equal(200000n);
        expect(await integrator.availableCredit(user.address)).to.equal(200000n);
      });

      it("emits LotPotFulfillmentSkipped(UpstreamReverted) when buyTickets reverts at fulfillment", async function () {
        // Force Megapot.buyTickets to revert unconditionally (simulating
        // paused / mid-flight upgrade / etc.). The integrator's try/catch
        // around proxy.execute converts that to a skip event; USDC stays
        // on the proxy (inner approval + transferFrom roll back together).
        const SKIP_UPSTREAM_REVERTED = 2;
        await integrator.connect(user).userPlaceOrder(2, INR, 1, "", 0, 0, [], []);
        const proxyAddr = await integrator.proxyAddress(user.address);
        await mockMegapot.setRevertOnBuyTickets(true);

        await expect(mockDiamond.simulateOrderComplete(1))
          .to.emit(integrator, "LotPotFulfillmentSkipped")
          .withArgs(1, user.address, proxyAddr, USDC(2), SKIP_UPSTREAM_REVERTED);

        const session = await integrator.getSession(1);
        expect(session.fulfilled).to.equal(true);
        expect(await mockNft.balanceOf(user.address)).to.equal(0);
        expect(await mockUsdc.balanceOf(proxyAddr)).to.equal(USDC(2));

        // Direct USDC sweep is disabled — the integrator's credit path is
        // the only way USDC leaves the proxy (it can only become tickets).
        const proxy = await ethers.getContractAt("UserProxy", proxyAddr);
        await expect(
          proxy.connect(user).sweepERC20(await mockUsdc.getAddress())
        ).to.be.revertedWithCustomError(proxy, "USDCSweepBlocked");

        // Restore Megapot; the user's next checkout call auto-applies the
        // 2 USDC credit. Since credit covers the new order's full price,
        // Diamond is skipped entirely.
        await mockMegapot.setRevertOnBuyTickets(false);
        await integrator.connect(user).userPlaceOrder(2, INR, 1, "", 0, 0, [], []);
        expect(await mockNft.balanceOf(user.address)).to.equal(2);
        expect(await mockUsdc.balanceOf(proxyAddr)).to.equal(0);
      });

      it("UserProxy.sweepERC20 is blocked for USDC on LotPot proxies", async function () {
        await integrator.connect(user).userPlaceOrder(1, INR, 1, "", 0, 0, [], []);
        const proxyAddr = await integrator.proxyAddress(user.address);
        const proxy = await ethers.getContractAt("UserProxy", proxyAddr);
        await expect(
          proxy.connect(user).sweepERC20(await mockUsdc.getAddress())
        ).to.be.revertedWithCustomError(proxy, "USDCSweepBlocked");
      });
    });

    describe("Admin & access control", function () {
      it("only owner can set source", async function () {
        await expect(
          integrator.connect(stranger).setSource(ethers.encodeBytes32String("evil"))
        ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
      });

      it("rejects placement when Megapot returns ticketPrice = 0", async function () {
        await mockMegapot.setTicketPrice(0);
        await expect(
          integrator.connect(user).userPlaceOrder(1, INR, 1, "", 0, 0, [], [])
        ).to.be.revertedWithCustomError(integrator, "InvalidTicketPrice");
      });

      it("rejects placement when Megapot returns ballMax < NORMALS_PER_TICKET", async function () {
        // Defensive: a buggy/upgraded Megapot returning <5 would make
        // _pickUniqueNormals impossible to satisfy. Surface a clear error
        // at placement instead.
        await mockMegapot.setBallMaxForTest(4);
        await expect(
          integrator.connect(user).userPlaceOrder(1, INR, 1, "", 0, 0, [], [])
        ).to.be.revertedWithCustomError(integrator, "InvalidBallRange");
      });

      it("rejects placement when Megapot returns bonusballMax = 0", async function () {
        await mockMegapot.setBonusballMaxForTest(0);
        await expect(
          integrator.connect(user).userPlaceOrder(1, INR, 1, "", 0, 0, [], [])
        ).to.be.revertedWithCustomError(integrator, "InvalidBallRange");
      });
    });

    describe("Limits", function () {
      it("per-tx limit blocks oversized orders", async function () {
        await mockMegapot.setTicketPrice(USDC(20));
        await expect(integrator.connect(user).userPlaceOrder(3, INR, 1, "", 0, 0, [], [])).to.be
          .reverted;
      });

      it("daily count limit blocks the Nth+1 order", async function () {
        await integrator.setDailyTxCountLimit(2);
        await integrator.connect(user).userPlaceOrder(1, INR, 1, "", 0, 0, [], []);
        await integrator.connect(user).userPlaceOrder(1, INR, 1, "", 0, 0, [], []);
        await expect(integrator.connect(user).userPlaceOrder(1, INR, 1, "", 0, 0, [], [])).to.be
          .reverted;
      });

      it("RP unlocks tx amounts above baseTxLimit", async function () {
        // Base limit is USDC(50); set a higher ticket price so a 5-ticket order
        // would overflow base. Granting enough RP × rate must lift the cap.
        await mockMegapot.setTicketPrice(USDC(20));
        await expect(integrator.connect(user).userPlaceOrder(5, INR, 1, "", 0, 0, [], [])).to.be
          .reverted;

        await integrator.setRpToUsdc(INR, USDC(1));
        await integrator.setUserRP(user.address, 200); // → 200 USDC limit
        expect(await integrator.getUserTxLimit(user.address, INR)).to.equal(USDC(200));

        await expect(integrator.connect(user).userPlaceOrder(5, INR, 1, "", 0, 0, [], [])).to.not.be
          .reverted;
      });
    });

    describe("IP2PIntegrator callbacks: onlyDiamond", function () {
      it("validateOrder reverts when called by non-Diamond", async function () {
        await expect(
          integrator.connect(stranger).validateOrder(user.address, USDC(1), INR)
        ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
        await expect(
          integrator.connect(user).validateOrder(user.address, USDC(1), INR)
        ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
      });

      it("onOrderComplete reverts when called by non-Diamond", async function () {
        const proxyAddr = await integrator.proxyAddress(user.address);
        await expect(
          integrator.connect(stranger).onOrderComplete(1, user.address, USDC(1), proxyAddr)
        ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
      });

      it("onOrderComplete is idempotent (OrderAlreadyFulfilled on re-entry)", async function () {
        // First completion succeeds and marks the session fulfilled. The Diamond
        // itself only calls onOrderComplete once per order, but the integrator's
        // session.fulfilled flag is defense-in-depth — verify directly by
        // impersonating the Diamond and re-calling.
        await integrator.connect(user).userPlaceOrder(1, INR, 1, "", 0, 0, [], []);
        await mockDiamond.simulateOrderComplete(1);

        const diamondAddr = await mockDiamond.getAddress();
        // MockDiamond has no receive(), so fund the impersonated signer via
        // hardhat_setBalance rather than a value transfer.
        await ethers.provider.send("hardhat_setBalance", [
          diamondAddr,
          "0x" + ethers.parseEther("1").toString(16),
        ]);
        const diamondSigner = await ethers.getImpersonatedSigner(diamondAddr);

        const proxyAddr = await integrator.proxyAddress(user.address);
        await expect(
          integrator.connect(diamondSigner).onOrderComplete(1, user.address, USDC(1), proxyAddr)
        ).to.be.revertedWithCustomError(integrator, "OrderAlreadyFulfilled");
      });
    });

    describe("Views", function () {
      it("getSession reflects placement state and flips fulfilled on completion", async function () {
        const picks = [
          { normals: [3, 7, 12, 19, 25], bonusball: 8 },
          { normals: [1, 2, 3, 4, 5], bonusball: 1 },
        ];
        await integrator.connect(user).userPlaceOrderWithPicks(picks, INR, 1, "", 0, 0, [], []);

        let s = await integrator.getSession(1);
        expect(s.user).to.equal(user.address);
        expect(s.quantity).to.equal(2);
        expect(s.usdcAmount).to.equal(USDC(2));
        expect(s.autoRandom).to.equal(false);
        expect(s.fulfilled).to.equal(false);
        expect(s.tickets.length).to.equal(2);
        expect(s.tickets[0].normals.map((n: any) => Number(n))).to.deep.equal([3, 7, 12, 19, 25]);
        expect(Number(s.tickets[0].bonusball)).to.equal(8);

        await mockDiamond.simulateOrderComplete(1);
        s = await integrator.getSession(1);
        expect(s.fulfilled).to.equal(true);
      });

      it("getSession marks autoRandom orders with empty stored tickets", async function () {
        await integrator.connect(user).userPlaceOrder(3, INR, 1, "", 0, 0, [], []);
        const s = await integrator.getSession(1);
        expect(s.autoRandom).to.equal(true);
        expect(s.tickets.length).to.equal(0);
      });
    });

    describe("Batch path (>10 tickets via BatchPurchaseFacilitator)", function () {
      beforeEach(async function () {
        // The base test block uses 50 USDC base limit / 1 USDC per ticket;
        // a 15-ticket order needs more headroom. Bump RP+rate for `user` so
        // a 50-ticket order would still validate.
        await integrator.setRpToUsdc(INR, USDC(1));
        await integrator.setUserRP(user.address, 60);
        await integrator.setDailyTxCountLimit(50);
      });

      it("routes >10-ticket orders through createBatchOrder, payer = integrator, recipient = user EOA", async function () {
        const integratorAddr = await integrator.getAddress();
        const proxyAddr = await integrator.proxyAddress(user.address);

        await integrator.connect(user).userPlaceOrder(15, INR, 1, "", 0, 0, [], []);

        // simulateOrderComplete invokes onOrderComplete which dispatches to
        // _fulfillBatch. The mock facilitator immediately mints to the
        // declared recipient (user EOA, in the new design) and emits
        // BatchOrderCreated. Real keeper does the mint asynchronously,
        // also to the user EOA — no intermediate proxy hop.
        await expect(mockDiamond.simulateOrderComplete(1))
          .to.emit(mockBatch, "BatchOrderCreated")
          .withArgs(integratorAddr, user.address, USDC(15), 15, 0)
          .and.to.emit(integrator, "LotPotBatchFulfilled")
          .withArgs(1, user.address, proxyAddr, 15, 0);

        // No buyTickets call on the synchronous Megapot path.
        expect(await mockMegapot.lastQuantity()).to.equal(0);
        // Mock pulled USDC from the integrator (which had pulled it from the proxy).
        expect(await mockUsdc.balanceOf(await mockBatch.getAddress())).to.equal(USDC(15));
        // NFTs land on the user EOA directly — proxy never holds them.
        expect(await mockNft.balanceOf(user.address)).to.equal(15);
        expect(await mockNft.balanceOf(proxyAddr)).to.equal(0);
      });

      it("emits LotPotFulfillmentSkipped(UpstreamReverted) when the facilitator rejects (e.g. not allowlisted), and returns USDC to the proxy", async function () {
        // Remove the integrator from the allowlist — createBatchOrder will
        // revert. The integrator's try/catch converts that to a skip event,
        // returns the USDC it pulled back to the proxy, and marks the order
        // fulfilled so the Diamond's settlement state closes.
        const SKIP_UPSTREAM_REVERTED = 2;
        await mockBatch.removeAllowed(await integrator.getAddress());
        await integrator.connect(user).userPlaceOrder(15, INR, 1, "", 0, 0, [], []);
        const proxyAddr = await integrator.proxyAddress(user.address);
        const integratorAddr = await integrator.getAddress();

        await expect(mockDiamond.simulateOrderComplete(1))
          .to.emit(integrator, "LotPotFulfillmentSkipped")
          .withArgs(1, user.address, proxyAddr, USDC(15), SKIP_UPSTREAM_REVERTED);

        // No Diamond-side callback-failed — the integrator absorbed the revert.
        const session = await integrator.getSession(1);
        expect(session.fulfilled).to.equal(true);
        expect(await mockUsdc.balanceOf(proxyAddr)).to.equal(USDC(15));
        expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(0);
        expect(await mockUsdc.allowance(integratorAddr, await mockBatch.getAddress())).to.equal(0);
      });

      it("scales up to whatever the per-tx USDC limit allows", async function () {
        // RP=60 + rate=1 USDC = 60 USDC tx-limit; ticketPrice=1 USDC ⇒
        // up to 60 tickets per order with no integrator-side cap.
        await integrator.connect(user).userPlaceOrder(60, INR, 1, "", 0, 0, [], []);
        await mockDiamond.simulateOrderComplete(1);
        expect(await mockNft.balanceOf(user.address)).to.equal(60);
        expect(await mockBatch.lastDynamicCount()).to.equal(60);
        expect(await mockBatch.lastStaticCount()).to.equal(0);
      });

      it("validateOrder is the actual cap — 1 ticket above tx-limit reverts at placement", async function () {
        // 60 USDC tx-limit (set in beforeEach), ticketPrice 1 USDC ⇒ 61 fails.
        await expect(integrator.connect(user).userPlaceOrder(61, INR, 1, "", 0, 0, [], [])).to.be
          .reverted;
      });

      it("integrator never holds USDC after a batch fulfillment", async function () {
        await integrator.connect(user).userPlaceOrder(15, INR, 1, "", 0, 0, [], []);
        await mockDiamond.simulateOrderComplete(1);
        // Pulled in JIT then approved → spent → reset.
        expect(await mockUsdc.balanceOf(await integrator.getAddress())).to.equal(0);
        expect(
          await mockUsdc.allowance(await integrator.getAddress(), await mockBatch.getAddress())
        ).to.equal(0);
      });

      it("user-picked batch order forwards picks as _userStaticTickets, not random", async function () {
        // Build 12 distinct picks so we can verify each one round-trips.
        const picks = Array.from({ length: 12 }, (_, i) => ({
          normals: [1, 2, 3, 4, 5 + i].slice(0, 5).map((n, j) => (j === 4 ? 5 + i : n)),
          bonusball: (i % BONUSBALL_MAX) + 1,
        })).map((_, i) => ({
          // Each ticket: [1, 2, 3, 4, 5+i] — sorted ascending, unique.
          normals: [1, 2, 3, 4, 5 + i],
          bonusball: (i % BONUSBALL_MAX) + 1,
        }));

        await integrator.connect(user).userPlaceOrderWithPicks(picks, INR, 1, "", 0, 0, [], []);
        await mockDiamond.simulateOrderComplete(1);

        // Mock recorded a static-only batch — dynamic = 0, static = 12.
        expect(await mockBatch.lastDynamicCount()).to.equal(0);
        expect(await mockBatch.lastStaticCount()).to.equal(12);

        // The integrator emits LotPotBatchFulfilled with the static count
        // populated and dynamic=0 for picks orders.
        const proxyAddr = await integrator.proxyAddress(user.address);
        const filter = integrator.filters.LotPotBatchFulfilled(1n);
        const events = await integrator.queryFilter(filter);
        expect(events.length).to.equal(1);
        expect(events[0].args.dynamicTicketCount).to.equal(0);
        expect(events[0].args.staticTicketCount).to.equal(12);
        expect(events[0].args.proxy).to.equal(proxyAddr);

        // Tickets minted to the user EOA with the user's exact picks
        // (mock validates shape; the count + lastStaticCount confirm picks
        // made it through end-to-end).
        expect(await mockNft.balanceOf(user.address)).to.equal(12);
        expect(await mockNft.balanceOf(proxyAddr)).to.equal(0);
      });

      it("rejects user-picked batch orders that exceed the per-tx USDC limit", async function () {
        // 61 picks at 1 USDC = 61 USDC > 60 USDC tx-limit (set in beforeEach).
        const tooMany = Array.from({ length: 61 }, () => ({
          normals: [1, 2, 3, 4, 5],
          bonusball: 1,
        }));
        await expect(
          integrator.connect(user).userPlaceOrderWithPicks(tooMany, INR, 1, "", 0, 0, [], [])
        ).to.be.reverted;
      });

      it("getSession exposes ballMax / bonusballMax / ticketPrice / placementDay snapshots", async function () {
        await integrator.connect(user).userPlaceOrder(2, INR, 1, "", 0, 0, [], []);
        const s = await integrator.getSession(1);
        expect(s.ballMax_).to.equal(BALL_MAX);
        expect(s.bonusballMax_).to.equal(BONUSBALL_MAX);
        expect(s.ticketPrice_).to.equal(TICKET_PRICE);
        const block = await ethers.provider.getBlock("latest");
        expect(Number(s.placementDay)).to.equal(Math.floor(block!.timestamp / 86400));
        expect(s.cancelled).to.equal(false);
      });
    });

    describe("Mid-flight Megapot changes (placement-time snapshots)", function () {
      it("auto-random regenerates against the *active* drawing's ranges, not the placement snapshot", async function () {
        // Auto-random orders don't lock the user to a specific number set —
        // they just want `quantity` valid tickets. Generating against the
        // current drawing's ranges guarantees Megapot's validator accepts the
        // tickets even after a rollover or owner-driven range change.
        await integrator.connect(user).userPlaceOrder(3, INR, 1, "", 0, 0, [], []);

        // Move the active drawing to a *narrower* range. If the integrator
        // were still using the placement snapshot (BALL_MAX=30), Megapot's
        // validator would reject any normal > 15 and the order would fail.
        const newBallMax = 15;
        const newBonusMax = 5;
        await mockMegapot.setBallMaxForTest(newBallMax);
        await mockMegapot.setBonusballMaxForTest(newBonusMax);

        // The session snapshot is informational only (records what was valid
        // at placement) and stays at the placement-time range.
        const s = await integrator.getSession(1);
        expect(s.ballMax_).to.equal(BALL_MAX);
        expect(s.bonusballMax_).to.equal(BONUSBALL_MAX);

        await mockDiamond.simulateOrderComplete(1);
        const tickets = await mockMegapot.getLastTickets();
        for (const t of tickets) {
          for (const n of t.normals) {
            expect(Number(n)).to.be.lessThanOrEqual(newBallMax);
          }
          expect(Number(t.bonusball)).to.be.lessThanOrEqual(newBonusMax);
        }
        expect(await mockNft.balanceOf(user.address)).to.equal(3);
      });

      it("Megapot ticketPrice change after placement doesn't mutate the in-flight order's amount; new placements use the new price", async function () {
        await integrator.connect(user).userPlaceOrder(2, INR, 1, "", 0, 0, [], []);
        const sBefore = await integrator.getSession(1);
        expect(sBefore.usdcAmount).to.equal(TICKET_PRICE * 2n);
        expect(sBefore.ticketPrice_).to.equal(TICKET_PRICE);

        // Megapot's owner halves its price after the first placement.
        const halvedPrice = TICKET_PRICE / 2n;
        await mockMegapot.setTicketPrice(halvedPrice);

        // The in-flight order keeps its placement-time price.
        const sAfter = await integrator.getSession(1);
        expect(sAfter.usdcAmount).to.equal(TICKET_PRICE * 2n);
        expect(sAfter.ticketPrice_).to.equal(TICKET_PRICE);

        // A new placement reads Megapot's *current* price, so quoting the
        // user against the new value with no admin action on the integrator.
        await integrator.connect(user2).userPlaceOrder(2, INR, 1, "", 0, 0, [], []);
        const sNew = await integrator.getSession(2);
        expect(sNew.usdcAmount).to.equal(halvedPrice * 2n);
        expect(sNew.ticketPrice_).to.equal(halvedPrice);
      });
    });

    describe("Drawing rollover skip-fulfillment branch", function () {
      // Skip reasons (must match SkipReason enum order in the contract).
      const SKIP_PRICE_EXCEEDS_COMMITMENT = 0;
      const SKIP_PICKS_OUT_OF_RANGE = 1;

      it("skips fulfillment and leaves USDC on the proxy when a rollover raises ticketPrice", async function () {
        await integrator.connect(user).userPlaceOrder(2, INR, 1, "", 0, 0, [], []);
        const proxyAddr = await integrator.proxyAddress(user.address);

        // Drawing rolls; new drawing has a higher ticketPrice. Megapot would
        // otherwise revert at fulfillment because the proxy doesn't have
        // enough USDC to satisfy the new price × quantity.
        await mockMegapot.rolloverDrawing(USDC(2), BALL_MAX, BONUSBALL_MAX);

        const userBefore = await mockUsdc.balanceOf(user.address);
        await expect(mockDiamond.simulateOrderComplete(1))
          .to.emit(integrator, "LotPotFulfillmentSkipped")
          .withArgs(1, user.address, proxyAddr, USDC(2), SKIP_PRICE_EXCEEDS_COMMITMENT);

        // No tickets minted; USDC stays on the proxy (NOT auto-pushed to user)
        // so that a B2B-mediated USDC exit can't bypass consumer fraud checks.
        expect(await mockMegapot.lastQuantity()).to.equal(0);
        expect(await mockNft.balanceOf(user.address)).to.equal(0);
        expect(await mockUsdc.balanceOf(proxyAddr)).to.equal(USDC(2));
        expect(await mockUsdc.balanceOf(user.address)).to.equal(userBefore);

        // Order is recorded as fulfilled (Diamond's settlement path closes;
        // idempotency guards still fire on a re-call). USDC can only exit
        // as tickets via a subsequent credit-aware purchase.
        const s = await integrator.getSession(1);
        expect(s.fulfilled).to.equal(true);

        // Drop the price back so the next order's full total = 2 USDC,
        // which the 2 USDC of credit can fully cover (credit-only path).
        await mockMegapot.setTicketPrice(USDC(1));
        await integrator.connect(user).userPlaceOrder(2, INR, 1, "", 0, 0, [], []);
        expect(await mockNft.balanceOf(user.address)).to.equal(2);
        expect(await mockUsdc.balanceOf(proxyAddr)).to.equal(0);
      });

      it("skips fulfillment when a rollover narrows ranges and invalidates user picks", async function () {
        // User picks bonusball=14, valid for the placement-time drawing
        // (bonusballMax=15). Drawing rolls to a narrower range
        // (bonusballMax=10) before fulfillment — the user's pick no longer fits.
        const picks = [{ normals: [3, 7, 12, 19, 25], bonusball: 14 }];
        await integrator.connect(user).userPlaceOrderWithPicks(picks, INR, 1, "", 0, 0, [], []);
        const proxyAddr = await integrator.proxyAddress(user.address);

        await mockMegapot.rolloverDrawing(TICKET_PRICE, BALL_MAX, 10);

        await expect(mockDiamond.simulateOrderComplete(1))
          .to.emit(integrator, "LotPotFulfillmentSkipped")
          .withArgs(1, user.address, proxyAddr, USDC(1), SKIP_PICKS_OUT_OF_RANGE);

        expect(await mockMegapot.lastQuantity()).to.equal(0);
        expect(await mockNft.balanceOf(user.address)).to.equal(0);
        // USDC stuck on proxy, user-recoverable only.
        expect(await mockUsdc.balanceOf(proxyAddr)).to.equal(USDC(1));
      });

      it("picks that *still* fit after a rollover are fulfilled normally (no refund)", async function () {
        const picks = [{ normals: [1, 2, 3, 4, 5], bonusball: 3 }];
        await integrator.connect(user).userPlaceOrderWithPicks(picks, INR, 1, "", 0, 0, [], []);

        // Rollover to a narrower bonusball range that still admits 3.
        await mockMegapot.rolloverDrawing(TICKET_PRICE, BALL_MAX, 5);

        await mockDiamond.simulateOrderComplete(1);
        expect(await mockNft.balanceOf(user.address)).to.equal(1);
        const tickets = await mockMegapot.getLastTickets();
        expect(Number(tickets[0].bonusball)).to.equal(3);
      });

      it("auto-random orders survive a rollover by regenerating against the new drawing", async function () {
        await integrator.connect(user).userPlaceOrder(2, INR, 1, "", 0, 0, [], []);

        // Rollover to a much narrower range. Auto-random regeneration must
        // pick from [1, newBallMax] / [1, newBonusMax] and pass validation.
        const newBallMax = 10;
        const newBonusMax = 4;
        await mockMegapot.rolloverDrawing(TICKET_PRICE, newBallMax, newBonusMax);

        await mockDiamond.simulateOrderComplete(1);
        expect(await mockNft.balanceOf(user.address)).to.equal(2);
        const tickets = await mockMegapot.getLastTickets();
        for (const t of tickets) {
          for (const n of t.normals) {
            expect(Number(n)).to.be.lessThanOrEqual(newBallMax);
          }
          expect(Number(t.bonusball)).to.be.lessThanOrEqual(newBonusMax);
        }
      });

      it("batch path also skips on price-rollover before handing USDC to the facilitator", async function () {
        // Fund the user enough to place a 15-ticket order.
        await integrator.setRpToUsdc(INR, USDC(1));
        await integrator.setUserRP(user.address, 60);
        await integrator.setDailyTxCountLimit(50);

        await integrator.connect(user).userPlaceOrder(15, INR, 1, "", 0, 0, [], []);
        const proxyAddr = await integrator.proxyAddress(user.address);
        const integratorAddr = await integrator.getAddress();
        const batchAddr = await mockBatch.getAddress();

        // Drawing rolls; price doubled. Skip must short-circuit before
        // any USDC reaches the facilitator.
        await mockMegapot.rolloverDrawing(USDC(2), BALL_MAX, BONUSBALL_MAX);

        await expect(mockDiamond.simulateOrderComplete(1))
          .to.emit(integrator, "LotPotFulfillmentSkipped")
          .withArgs(1, user.address, proxyAddr, USDC(15), SKIP_PRICE_EXCEEDS_COMMITMENT);

        // No tickets, no USDC at the facilitator or integrator. USDC sits on
        // the proxy until the user sweeps it themselves.
        expect(await mockNft.balanceOf(proxyAddr)).to.equal(0);
        expect(await mockUsdc.balanceOf(batchAddr)).to.equal(0);
        expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(0);
        expect(await mockUsdc.balanceOf(proxyAddr)).to.equal(USDC(15));
      });
    });

    describe("Credit redemption (stranded proxy USDC → tickets)", function () {
      // Helper: create stuck credit by forcing a fulfillment skip. For
      // direct path (≤10) we toggle Megapot.buyTickets to revert; for batch
      // path (>10) we de-allowlist the integrator from the facilitator so
      // createBatchOrder reverts. Both produce the same end state: USDC on
      // proxy, no tickets, session.fulfilled = true.
      async function seedCredit(seedQty: number): Promise<string> {
        const proxyAddr = await integrator.proxyAddress(user.address);
        const integratorAddr = await integrator.getAddress();
        await integrator.connect(user).userPlaceOrder(seedQty, INR, 1, "", 0, 0, [], []);
        if (seedQty > 10) {
          await mockBatch.removeAllowed(integratorAddr);
        } else {
          await mockMegapot.setRevertOnBuyTickets(true);
        }
        await mockDiamond.simulateOrderComplete(1);
        if (seedQty > 10) {
          await mockBatch.addAllowed(integratorAddr);
        } else {
          await mockMegapot.setRevertOnBuyTickets(false);
        }
        expect(await mockUsdc.balanceOf(proxyAddr)).to.equal(USDC(seedQty));
        return proxyAddr;
      }

      it("availableCredit returns the proxy's USDC balance", async function () {
        expect(await integrator.availableCredit(user.address)).to.equal(0);
        const proxyAddr = await seedCredit(3);
        expect(await integrator.availableCredit(user.address)).to.equal(USDC(3));
        // Sanity: matches direct proxy balance.
        expect(await integrator.availableCredit(user.address)).to.equal(
          await mockUsdc.balanceOf(proxyAddr)
        );
      });

      it("credit-only path: when credit >= total, Diamond is skipped entirely", async function () {
        const proxyAddr = await seedCredit(5);

        // Retry with quantity that fits within credit. Should NOT touch the
        // Diamond at all (no LotPotOrderCreated, only LotPotCreditRedeemed).
        await expect(integrator.connect(user).userPlaceOrder(3, INR, 1, "", 0, 0, [], []))
          .to.emit(integrator, "LotPotCreditRedeemed")
          .withArgs(user.address, 0, 3, USDC(3))
          .and.not.to.emit(integrator, "LotPotOrderCreated");

        // 3 tickets minted to user EOA; remaining 2 USDC stays as credit.
        expect(await mockNft.balanceOf(user.address)).to.equal(3);
        expect(await integrator.availableCredit(user.address)).to.equal(USDC(2));
      });

      it("credit-only path returns 0 orderId (sentinel — no Diamond involvement)", async function () {
        await seedCredit(2);
        const tx = await integrator
          .connect(user)
          .userPlaceOrder.staticCall(1, INR, 1, "", 0, 0, [], []);
        expect(tx).to.equal(0n);
      });

      it("delta path: when credit < total, Diamond order is placed for the delta only", async function () {
        const proxyAddr = await seedCredit(2); // 2 USDC credit
        const userBefore = await mockUsdc.balanceOf(user.address);

        // Want 5 tickets = 5 USDC. Credit = 2. Delta = 3.
        await expect(integrator.connect(user).userPlaceOrder(5, INR, 1, "", 0, 0, [], []))
          .to.emit(integrator, "LotPotOrderCreated")
          .withArgs(2, user.address, 5, true, USDC(5));

        // The Diamond's MockDiamond.placeB2BOrder records the delta amount;
        // verify it matches by examining the next order's session.usdcAmount.
        const s = await integrator.getSession(2);
        expect(s.usdcAmount).to.equal(USDC(3)); // delta, NOT total

        // Simulate Diamond completion with the delta amount.
        await mockDiamond.simulateOrderComplete(2);

        // All 5 NFTs minted to user. Megapot pulled the full 5 USDC.
        expect(await mockNft.balanceOf(user.address)).to.equal(5);
        // Credit consumed; proxy is empty.
        expect(await integrator.availableCredit(user.address)).to.equal(0);
        // LotPotCreditRedeemed emitted at fulfillment for the credit-applied delta.
        const filter = integrator.filters.LotPotCreditRedeemed(user.address, 2n);
        const events = await integrator.queryFilter(filter);
        expect(events.length).to.equal(1);
        expect(events[0].args.creditUsed).to.equal(USDC(2));
      });

      it("delta path with picks: validates picks, snapshots them, fulfills with credit netted", async function () {
        const proxyAddr = await seedCredit(2);
        const picks = [
          { normals: [1, 2, 3, 4, 5], bonusball: 1 },
          { normals: [6, 7, 8, 9, 10], bonusball: 2 },
          { normals: [11, 12, 13, 14, 15], bonusball: 3 },
        ];
        // 3 tickets × 1 USDC = 3 USDC total. Credit = 2 USDC. Delta = 1.
        await integrator.connect(user).userPlaceOrderWithPicks(picks, INR, 1, "", 0, 0, [], []);
        const s = await integrator.getSession(2);
        expect(s.usdcAmount).to.equal(USDC(1));
        expect(s.autoRandom).to.equal(false);

        await mockDiamond.simulateOrderComplete(2);
        expect(await mockNft.balanceOf(user.address)).to.equal(3);
        expect(await integrator.availableCredit(user.address)).to.equal(0);
      });

      it("credit-only path with picks: validates picks, no Diamond order, mints directly", async function () {
        await seedCredit(5);
        const picks = [
          { normals: [1, 2, 3, 4, 5], bonusball: 1 },
          { normals: [6, 7, 8, 9, 10], bonusball: 2 },
        ];
        await expect(
          integrator.connect(user).userPlaceOrderWithPicks(picks, INR, 1, "", 0, 0, [], [])
        ).to.emit(integrator, "LotPotCreditRedeemed");
        expect(await mockNft.balanceOf(user.address)).to.equal(2);
        // 5 - 2 = 3 USDC credit remaining.
        expect(await integrator.availableCredit(user.address)).to.equal(USDC(3));
      });

      it("credit-only batch (>10): routes through facilitator, recipient = user", async function () {
        await integrator.setRpToUsdc(INR, USDC(1));
        await integrator.setUserRP(user.address, 60);
        await integrator.setDailyTxCountLimit(50);
        const proxyAddr = await seedCredit(15);

        // 15 tickets covered fully by credit → Diamond bypassed.
        await expect(integrator.connect(user).userPlaceOrder(15, INR, 1, "", 0, 0, [], []))
          .to.emit(mockBatch, "BatchOrderCreated")
          .withArgs(await integrator.getAddress(), user.address, USDC(15), 15, 0)
          .and.to.emit(integrator, "LotPotCreditRedeemed")
          .withArgs(user.address, 0, 15, USDC(15));

        expect(await mockNft.balanceOf(user.address)).to.equal(15);
        expect(await integrator.availableCredit(user.address)).to.equal(0);
      });

      it("residue: a smaller retry leaves remainder as fresh credit", async function () {
        await seedCredit(11);
        await integrator.connect(user).userPlaceOrder(3, INR, 1, "", 0, 0, [], []);
        expect(await mockNft.balanceOf(user.address)).to.equal(3);
        expect(await integrator.availableCredit(user.address)).to.equal(USDC(8));
      });

      it("credit-only retry reverts (and credit is preserved) if Megapot reverts", async function () {
        const proxyAddr = await seedCredit(2);
        await mockMegapot.setRevertOnBuyTickets(true);
        await expect(integrator.connect(user).userPlaceOrder(2, INR, 1, "", 0, 0, [], [])).to.be
          .reverted;
        // Credit untouched.
        expect(await integrator.availableCredit(user.address)).to.equal(USDC(2));
        expect(await mockNft.balanceOf(user.address)).to.equal(0);
      });
    });

    describe("Defense-in-depth checks", function () {
      it("onOrderComplete reverts MegapotReturnMismatch if Megapot returns wrong-size ticketIds", async function () {
        await integrator.connect(user).userPlaceOrder(3, INR, 1, "", 0, 0, [], []);
        // Megapot returns only 2 IDs for a 3-ticket order — the integrator
        // must refuse to forward a partial set.
        await mockMegapot.setReturnLengthOverride(2);
        await expect(mockDiamond.simulateOrderComplete(1)).to.emit(
          mockDiamond,
          "MockIntegratorCallbackFailed"
        );
        const s = await integrator.getSession(1);
        expect(s.fulfilled).to.equal(false);
      });

      it("onOrderComplete reverts AmountMismatch on diamond/integrator divergence", async function () {
        // Diamond delivering an amount that doesn't match the placement-time
        // snapshot is a state-divergence signal — fail loudly rather than
        // approve a wrong allowance to Megapot.
        await integrator.connect(user).userPlaceOrder(2, INR, 1, "", 0, 0, [], []);

        const diamondAddr = await mockDiamond.getAddress();
        await ethers.provider.send("hardhat_setBalance", [
          diamondAddr,
          "0x" + ethers.parseEther("1").toString(16),
        ]);
        const diamondSigner = await ethers.getImpersonatedSigner(diamondAddr);
        const proxyAddr = await integrator.proxyAddress(user.address);
        await expect(
          integrator.connect(diamondSigner).onOrderComplete(1, user.address, USDC(99), proxyAddr)
        ).to.be.revertedWithCustomError(integrator, "AmountMismatch");
      });

      it("onOrderComplete reverts UnknownOrder on unseen orderId", async function () {
        const diamondAddr = await mockDiamond.getAddress();
        await ethers.provider.send("hardhat_setBalance", [
          diamondAddr,
          "0x" + ethers.parseEther("1").toString(16),
        ]);
        const diamondSigner = await ethers.getImpersonatedSigner(diamondAddr);
        await expect(
          integrator
            .connect(diamondSigner)
            .onOrderComplete(9999, user.address, USDC(1), ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(integrator, "UnknownOrder");
      });
    });

    describe("Referrer support", function () {
      it("defaultReferrer is the deployer", async function () {
        expect(await integrator.defaultReferrer()).to.equal(owner.address);
      });

      const FULL = ethers.parseEther("1");
      const expectDefault = async () => {
        expect(await mockMegapot.getLastReferrers()).to.deep.equal([owner.address]);
        expect(await mockMegapot.getLastReferralSplit()).to.deep.equal([FULL]);
      };

      it("passes a valid multi-referrer set through to Megapot (direct path)", async function () {
        const refs = [user2.address, stranger.address];
        const split = [ethers.parseEther("0.7"), ethers.parseEther("0.3")];
        await integrator.connect(user).userPlaceOrder(3, INR, 1, "", 0, 0, refs, split);
        await mockDiamond.simulateOrderComplete(1);
        expect(await mockMegapot.getLastReferrers()).to.deep.equal(refs);
        expect(await mockMegapot.getLastReferralSplit()).to.deep.equal(split);
      });

      it("empty set → defaultReferrer", async function () {
        await integrator.connect(user).userPlaceOrder(2, INR, 1, "", 0, 0, [], []);
        await mockDiamond.simulateOrderComplete(1);
        await expectDefault();
      });

      it("length mismatch → defaultReferrer", async function () {
        await integrator.connect(user).userPlaceOrder(2, INR, 1, "", 0, 0, [user2.address], []);
        await mockDiamond.simulateOrderComplete(1);
        await expectDefault();
      });

      it("split not totalling 1e18 → defaultReferrer", async function () {
        await integrator
          .connect(user)
          .userPlaceOrder(2, INR, 1, "", 0, 0, [user2.address], [ethers.parseEther("0.9")]);
        await mockDiamond.simulateOrderComplete(1);
        await expectDefault();
      });

      it("zero address in set → defaultReferrer", async function () {
        await integrator
          .connect(user)
          .userPlaceOrder(2, INR, 1, "", 0, 0, [ethers.ZeroAddress], [FULL]);
        await mockDiamond.simulateOrderComplete(1);
        await expectDefault();
      });

      it("referrer == recipient → defaultReferrer", async function () {
        await integrator.connect(user).userPlaceOrder(2, INR, 1, "", 0, 0, [user.address], [FULL]);
        await mockDiamond.simulateOrderComplete(1);
        await expectDefault();
      });

      it("referrer == proxy → defaultReferrer", async function () {
        const proxyAddr = await integrator.proxyAddress(user.address);
        await integrator.connect(user).userPlaceOrder(2, INR, 1, "", 0, 0, [proxyAddr], [FULL]);
        await mockDiamond.simulateOrderComplete(1);
        await expectDefault();
      });

      it("more than MAX_REFERRERS → defaultReferrer", async function () {
        const refs = Array(11).fill(stranger.address);
        const split = Array(11).fill(ethers.parseEther("1") / 11n);
        await integrator.connect(user).userPlaceOrder(2, INR, 1, "", 0, 0, refs, split);
        await mockDiamond.simulateOrderComplete(1);
        await expectDefault();
      });

      it("passes referrers through on the batch path (qty > 10)", async function () {
        const refs = [user2.address, stranger.address];
        const split = [ethers.parseEther("0.5"), ethers.parseEther("0.5")];
        await integrator.connect(user).userPlaceOrder(11, INR, 1, "", 0, 0, refs, split);
        await mockDiamond.simulateOrderComplete(1);
        expect(await mockBatch.getLastReferrers()).to.deep.equal(refs);
        expect(await mockBatch.getLastReferralSplit()).to.deep.equal(split);
      });

      it("credit-only redemption uses the most-recent skipped order's referral", async function () {
        // Order 1 (qty 5) skips → 5 USDC credit, snapshot [user2].
        await integrator.connect(user).userPlaceOrder(5, INR, 1, "", 0, 0, [user2.address], [FULL]);
        await mockMegapot.setRevertOnBuyTickets(true);
        await mockDiamond.simulateOrderComplete(1);
        // Order 2 (qty 10): credit 5 < total 10 → Diamond delta order, which also
        // skips → proxy now holds 10 USDC, snapshot overwritten [stranger].
        await integrator
          .connect(user)
          .userPlaceOrder(10, INR, 1, "", 0, 0, [stranger.address], [FULL]);
        await mockDiamond.simulateOrderComplete(2);
        // Order 3 (qty 10): credit 10 ≥ total 10 → credit-only redemption.
        await mockMegapot.setRevertOnBuyTickets(false);
        await integrator
          .connect(user)
          .userPlaceOrder(10, INR, 1, "", 0, 0, [user2.address], [FULL]);
        // Must use the LAST skip's snapshot (stranger), not the new call's arg (user2).
        expect(await mockMegapot.getLastReferrers()).to.deep.equal([stranger.address]);
        expect(await mockMegapot.getLastReferralSplit()).to.deep.equal([FULL]);
      });

      it("credit-only redemption clears the snapshot (next redemption → default)", async function () {
        await integrator
          .connect(user)
          .userPlaceOrder(5, INR, 1, "", 0, 0, [stranger.address], [FULL]);
        await mockMegapot.setRevertOnBuyTickets(true);
        await mockDiamond.simulateOrderComplete(1); // skip → 5 USDC credit, snapshot [stranger]
        await mockMegapot.setRevertOnBuyTickets(false);
        await integrator.connect(user).userPlaceOrder(5, INR, 1, "", 0, 0, [], []); // redeems 5 USDC
        expect(await mockMegapot.getLastReferrers()).to.deep.equal([stranger.address]);

        await mockMegapot.setRevertOnBuyTickets(true);
        await integrator.connect(user).userPlaceOrder(5, INR, 1, "", 0, 0, [], []);
        await mockDiamond.simulateOrderComplete(2); // skip → snapshot = [] (empty)
        await mockMegapot.setRevertOnBuyTickets(false);
        await integrator.connect(user).userPlaceOrder(5, INR, 1, "", 0, 0, [], []); // redeem
        expect(await mockMegapot.getLastReferrers()).to.deep.equal([owner.address]); // empty → default
      });

      it("delta-netted order uses the NEW session referral, not the credit snapshot", async function () {
        await integrator.connect(user).userPlaceOrder(5, INR, 1, "", 0, 0, [user2.address], [FULL]);
        await mockMegapot.setRevertOnBuyTickets(true);
        await mockDiamond.simulateOrderComplete(1); // skip → 5 USDC credit, snapshot [user2]
        await mockMegapot.setRevertOnBuyTickets(false);
        await integrator
          .connect(user)
          .userPlaceOrder(10, INR, 1, "", 0, 0, [stranger.address], [FULL]);
        await mockDiamond.simulateOrderComplete(2); // credit(5)<total(10) → delta path
        expect(await mockMegapot.getLastReferrers()).to.deep.equal([stranger.address]);
      });

      it("getSession returns the stored referrers and split", async function () {
        const refs = [user2.address, stranger.address];
        const split = [ethers.parseEther("0.6"), ethers.parseEther("0.4")];
        await integrator.connect(user).userPlaceOrder(10, INR, 1, "", 0, 0, refs, split);
        const s = await integrator.getSession(1);
        expect(s.referrers).to.deep.equal(refs);
        expect(s.referralSplit).to.deep.equal(split);
      });
    });

    describe("onOrderCancel: userDailyCount release", function () {
      it("decrements userDailyCount on cancellation, restoring quota", async function () {
        await integrator.setDailyTxCountLimit(2);
        await integrator.connect(user).userPlaceOrder(1, INR, 1, "", 0, 0, [], []);
        await integrator.connect(user).userPlaceOrder(1, INR, 1, "", 0, 0, [], []);
        expect(await integrator.getTodayCount(user.address)).to.equal(2);
        await expect(integrator.connect(user).userPlaceOrder(1, INR, 1, "", 0, 0, [], [])).to.be
          .reverted;

        await mockDiamond.simulateOrderCancelled(1);
        expect(await integrator.getTodayCount(user.address)).to.equal(1);

        // Quota is now available again — user can place another order.
        await expect(integrator.connect(user).userPlaceOrder(1, INR, 1, "", 0, 0, [], [])).to.not.be
          .reverted;
      });

      it("decrements the placement-day bucket even after a UTC boundary crossing", async function () {
        await integrator.setDailyTxCountLimit(5);
        await integrator.connect(user).userPlaceOrder(1, INR, 1, "", 0, 0, [], []);
        const placementDay = (await integrator.getSession(1)).placementDay;

        // Jump forward 2 days and cancel — the decrement must land in
        // placementDay's bucket, not today's.
        await ethers.provider.send("evm_increaseTime", [2 * 86400]);
        await ethers.provider.send("evm_mine", []);

        await mockDiamond.simulateOrderCancelled(1);

        // Today's bucket is untouched.
        expect(await integrator.getTodayCount(user.address)).to.equal(0);
        // The placement-day bucket dropped from 1 to 0.
        expect(await integrator.userDailyCount(user.address, placementDay)).to.equal(0);
      });

      it("onOrderCancel reverts when called by non-Diamond", async function () {
        await integrator.connect(user).userPlaceOrder(1, INR, 1, "", 0, 0, [], []);
        await expect(integrator.connect(stranger).onOrderCancel(1)).to.be.revertedWithCustomError(
          integrator,
          "OnlyDiamond"
        );
      });

      it("onOrderCancel is idempotent (OrderAlreadyCancelled on re-entry)", async function () {
        await integrator.connect(user).userPlaceOrder(1, INR, 1, "", 0, 0, [], []);
        await mockDiamond.simulateOrderCancelled(1);

        // Re-entry via impersonated diamond signer (MockDiamond's own
        // "Already cancelled" guard otherwise fires first).
        const diamondAddr = await mockDiamond.getAddress();
        await ethers.provider.send("hardhat_setBalance", [
          diamondAddr,
          "0x" + ethers.parseEther("1").toString(16),
        ]);
        const diamondSigner = await ethers.getImpersonatedSigner(diamondAddr);
        await expect(
          integrator.connect(diamondSigner).onOrderCancel(1)
        ).to.be.revertedWithCustomError(integrator, "OrderAlreadyCancelled");
      });

      it("onOrderCancel after fulfillment reverts with OrderAlreadyFulfilled", async function () {
        // The real gateway's _cancelOrder won't fire for a completed order
        // (and MockDiamond mirrors that with an "Already completed" guard).
        // But the integrator's onOrderCancel hook itself must defensively
        // reject — verified by impersonating the diamond and calling directly.
        await integrator.connect(user).userPlaceOrder(1, INR, 1, "", 0, 0, [], []);
        await mockDiamond.simulateOrderComplete(1);

        const diamondAddr = await mockDiamond.getAddress();
        await ethers.provider.send("hardhat_setBalance", [
          diamondAddr,
          "0x" + ethers.parseEther("1").toString(16),
        ]);
        const diamondSigner = await ethers.getImpersonatedSigner(diamondAddr);
        await expect(
          integrator.connect(diamondSigner).onOrderCancel(1)
        ).to.be.revertedWithCustomError(integrator, "OrderAlreadyFulfilled");
      });

      it("onOrderComplete after cancellation reverts with OrderAlreadyCancelled", async function () {
        await integrator.connect(user).userPlaceOrder(1, INR, 1, "", 0, 0, [], []);
        await mockDiamond.simulateOrderCancelled(1);

        const diamondAddr = await mockDiamond.getAddress();
        await ethers.provider.send("hardhat_setBalance", [
          diamondAddr,
          "0x" + ethers.parseEther("1").toString(16),
        ]);
        const diamondSigner = await ethers.getImpersonatedSigner(diamondAddr);
        const proxyAddr = await integrator.proxyAddress(user.address);
        await expect(
          integrator.connect(diamondSigner).onOrderComplete(1, user.address, USDC(1), proxyAddr)
        ).to.be.revertedWithCustomError(integrator, "OrderAlreadyCancelled");
      });
    });
  });
}
