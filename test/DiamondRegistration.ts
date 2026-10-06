import { expect } from "chai";
import { ethers } from "ethers";
import {
  detectRegisterForm,
  planRegistration,
  REGISTER_LEGACY,
  REGISTER_WITH_CALLBACK,
  SET_CANCEL_CALLBACK,
  type IntegratorConfig,
} from "../scripts/lib/diamond";

/**
 * scripts/lib/diamond.ts registration helpers. contracts-v4 #492 swaps the
 * 3-arg registerIntegrator for a 4-arg one carrying cancelCallbackEnabled, and
 * #493 removes setIntegratorCancelCallback, so a Diamond routes exactly one of
 * two surfaces depending on whether it has taken that cut.
 */
const INTEGRATOR = "0x6daE4C184a32782A72bd99875379fc1E7383213B";
const PROXY_IMPL = "0x17810751fF773EC464aBb2b6eDAC40C8cf2a543D";
const DIAMOND = "0x4cad6eC90e65baBec9335cAd728DDC610c316368";
const req = { integrator: INTEGRATOR, usdcThroughIntegrator: false, proxyImpl: PROXY_IMPL };
const live = (cancelCallbackEnabled: boolean): IntegratorConfig => ({
  isActive: true,
  usdcThroughIntegrator: false,
  cancelCallbackEnabled,
  activeOrderCount: 0n,
  proxyImpl: PROXY_IMPL,
});

describe("planRegistration", () => {
  describe('"with-callback" (post-#492 Diamond)', () => {
    it("is one 4-arg call carrying the flag, for a new integrator", () => {
      expect(planRegistration("with-callback", { ...req, cancelCallback: true }, null)).to.deep.equal([
        { signature: REGISTER_WITH_CALLBACK, args: [INTEGRATOR, false, PROXY_IMPL, true] },
      ]);
    });

    // The 4-arg form rewrites the flag on every call, so the caller's value is
    // what lands — there is no "leave it alone" on this surface.
    it("is still one call when only the flag changes, and carries every field", () => {
      expect(planRegistration("with-callback", { ...req, cancelCallback: false }, live(true))).to.deep.equal([
        { signature: REGISTER_WITH_CALLBACK, args: [INTEGRATOR, false, PROXY_IMPL, false] },
      ]);
    });
  });

  describe('"legacy" (pre-#492 Diamond)', () => {
    it("registers, then sets the flag, in that order (the setter reverts on an unregistered address)", () => {
      expect(planRegistration("legacy", { ...req, cancelCallback: true }, null)).to.deep.equal([
        { signature: REGISTER_LEGACY, args: [INTEGRATOR, false, PROXY_IMPL] },
        { signature: SET_CANCEL_CALLBACK, args: [INTEGRATOR, true] },
      ]);
    });

    it("skips the setter when the flag already matches (a new entry starts false)", () => {
      expect(planRegistration("legacy", { ...req, cancelCallback: false }, null)).to.deep.equal([
        { signature: REGISTER_LEGACY, args: [INTEGRATOR, false, PROXY_IMPL] },
      ]);
      expect(planRegistration("legacy", { ...req, cancelCallback: true }, live(true))).to.have.length(1);
    });

    it("adds the setter to turn a live flag off", () => {
      const calls = planRegistration("legacy", { ...req, cancelCallback: false }, live(true));
      expect(calls.map((c) => c.signature)).to.deep.equal([REGISTER_LEGACY, SET_CANCEL_CALLBACK]);
      expect(calls[1].args).to.deep.equal([INTEGRATOR, false]);
    });
  });
});

describe("detectRegisterForm", () => {
  const loupe = new ethers.Interface(["function facetAddress(bytes4) view returns (address)"]);
  const sel = (sig: string) => ethers.id(sig).slice(0, 10);
  const FACET = "0x00000000000000000000000000000000000000fa";

  /** A provider whose loupe routes exactly `routed`. */
  const providerRouting = (routed: string[]) =>
    ({
      call: async ({ data }: { data: string }) => {
        const [selector] = loupe.decodeFunctionData("facetAddress", data);
        const hit = routed.map(sel).includes(String(selector).toLowerCase());
        return loupe.encodeFunctionResult("facetAddress", [hit ? FACET : ethers.ZeroAddress]);
      },
    }) as unknown as ethers.Provider;

  it('picks "with-callback" whenever the 4-arg form is routed', async () => {
    expect(await detectRegisterForm(providerRouting([REGISTER_WITH_CALLBACK]), DIAMOND)).to.equal("with-callback");
    expect(
      await detectRegisterForm(providerRouting([REGISTER_WITH_CALLBACK, SET_CANCEL_CALLBACK]), DIAMOND)
    ).to.equal("with-callback");
  });

  it('picks "legacy" only when BOTH the 3-arg register and the setter are routed', async () => {
    expect(
      await detectRegisterForm(providerRouting([REGISTER_LEGACY, SET_CANCEL_CALLBACK]), DIAMOND)
    ).to.equal("legacy");
  });

  it("refuses a Diamond routing an incomplete surface rather than guessing", async () => {
    for (const routed of [[], [REGISTER_LEGACY], [SET_CANCEL_CALLBACK]]) {
      let threw = false;
      try {
        await detectRegisterForm(providerRouting(routed), DIAMOND);
      } catch (e) {
        threw = true;
        expect(String(e)).to.contain("routes neither");
      }
      expect(threw, `routed=${JSON.stringify(routed)}`).to.equal(true);
    }
  });
});
