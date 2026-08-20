/**
 * Single source of truth for reading the Diamond's B2B integrator registry.
 *
 * WHY THIS EXISTS (#60). `getIntegratorConfig` returns a struct whose shape has
 * changed once already and will change again: contracts-v4 #362 inserted
 * `cancelCallbackEnabled` as the THIRD field (deployed to Base mainnet
 * 2026-08-05, Base Sepolia around 2026-08-12). Networks upgrade at different
 * times, so during a rollout window **no single hardcoded ABI literal is
 * correct everywhere** — mainnet returned 5 fields while Sepolia still returned
 * 4, and either literal was wrong on one of them.
 *
 * Worse, both failure modes are quiet. A 4-field literal against a 5-field
 * Diamond does not revert: ethers reads `proxyImpl` off the `activeOrderCount`
 * slot, so it decodes as address(0) when the count is 0, and as a fabricated
 * address when it is not. A 5-field literal against a 4-field Diamond throws
 * `BAD_DATA` — which is at least loud, but strands scripts mid-run.
 *
 * A selector check cannot catch any of this: `getIntegratorConfig(address)`
 * hashes to the same 4 bytes regardless of what it returns. Return types are
 * not part of the selector.
 *
 * So: decode by SHAPE, not by assumption. Every field in this struct is
 * fixed-size, so the returned word count identifies the layout exactly.
 */
import { ethers } from "ethers";

export interface IntegratorConfig {
  isActive: boolean;
  usdcThroughIntegrator: boolean;
  /** Added by contracts-v4 #362. Reported as `false` on a pre-#362 Diamond. */
  cancelCallbackEnabled: boolean;
  activeOrderCount: bigint;
  proxyImpl: string;
}

const SELECTOR = ethers.id("getIntegratorConfig(address)").slice(0, 10);

/** Word count -> field types, newest layout first. */
const LAYOUTS: Record<number, readonly string[]> = {
  5: ["bool", "bool", "bool", "uint256", "address"], // post-#362
  4: ["bool", "bool", "uint256", "address"], // pre-#362
};

/**
 * Read one integrator's registration, correct on any Diamond whose layout we
 * know. Throws with an actionable message rather than mis-decoding if the
 * struct grows again.
 */
export async function getIntegratorConfig(
  provider: ethers.Provider,
  diamond: string,
  integrator: string
): Promise<IntegratorConfig> {
  const raw = await provider.call({
    to: diamond,
    data: SELECTOR + ethers.zeroPadValue(integrator, 32).slice(2),
  });

  const words = (raw.length - 2) / 64;
  const layout = LAYOUTS[words];
  if (!layout) {
    throw new Error(
      `getIntegratorConfig(${integrator}) on Diamond ${diamond} returned ${words} words; ` +
        `expected 5 (post-#362) or 4 (pre-#362). The IntegratorConfig struct changed again — ` +
        `add the new layout to scripts/lib/diamond.ts rather than guessing.`
    );
  }

  const v = ethers.AbiCoder.defaultAbiCoder()
    .decode([`tuple(${layout.join(",")})`], raw)[0]
    .toArray();

  return words === 5
    ? {
        isActive: v[0] as boolean,
        usdcThroughIntegrator: v[1] as boolean,
        cancelCallbackEnabled: v[2] as boolean,
        activeOrderCount: v[3] as bigint,
        proxyImpl: v[4] as string,
      }
    : {
        isActive: v[0] as boolean,
        usdcThroughIntegrator: v[1] as boolean,
        cancelCallbackEnabled: false,
        activeOrderCount: v[2] as bigint,
        proxyImpl: v[3] as string,
      };
}
