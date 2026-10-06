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

/*
 * ─── Registration ──────────────────────────────────────────────────────────
 *
 * Same rollout problem as the struct above, on the write side. contracts-v4
 * #492 gives registerIntegrator a 4th argument (cancelCallbackEnabled) and
 * REMOVES the 3-arg form; #493 removes setIntegratorCancelCallback. Until a
 * network takes that cut it routes only the legacy pair, afterwards only the
 * 4-arg form, so a hardcoded call is wrong on one of them — and the failure is
 * an opaque "Diamond: Function does not exist" mid-script. Pick by routing.
 */

/** registerIntegrator with the callback flag (contracts-v4 #492). */
export const REGISTER_WITH_CALLBACK = "registerIntegrator(address,bool,address,bool)";
/** registerIntegrator before #492 — the flag needs the separate setter. */
export const REGISTER_LEGACY = "registerIntegrator(address,bool,address)";
/** The separate setter, removed by contracts-v4 #493. */
export const SET_CANCEL_CALLBACK = "setIntegratorCancelCallback(address,bool)";

export type RegisterForm = "with-callback" | "legacy";

export interface RegistrationRequest {
  integrator: string;
  usdcThroughIntegrator: boolean;
  proxyImpl: string;
  /**
   * The onOrderCancel opt-in. Enable only after the review checklist on
   * contracts-v4 B2BGatewayFacet.registerIntegrator (onOrderComplete must not
   * refuse an order it has seen cancelled). There is deliberately no default:
   * the 4-arg form rewrites the flag on every call.
   */
  cancelCallback: boolean;
}

export interface RegistrationCall {
  signature: string;
  args: (string | boolean)[];
}

const LOUPE = new ethers.Interface(["function facetAddress(bytes4) view returns (address)"]);
const REGISTRATION = new ethers.Interface([
  `function ${REGISTER_WITH_CALLBACK}`,
  `function ${REGISTER_LEGACY}`,
  `function ${SET_CANCEL_CALLBACK}`,
]);

/** Which registration surface the Diamond routes; throws if neither is complete. */
export async function detectRegisterForm(
  provider: ethers.Provider,
  diamond: string
): Promise<RegisterForm> {
  const routed = async (sig: string) => {
    const raw = await provider.call({
      to: diamond,
      data: LOUPE.encodeFunctionData("facetAddress", [REGISTRATION.getFunction(sig)!.selector]),
    });
    return LOUPE.decodeFunctionResult("facetAddress", raw)[0] !== ethers.ZeroAddress;
  };
  if (await routed(REGISTER_WITH_CALLBACK)) return "with-callback";
  // The legacy surface counts only whole: a 3-arg register without the setter
  // would "succeed" while silently unable to set the flag that was asked for.
  if ((await routed(REGISTER_LEGACY)) && (await routed(SET_CANCEL_CALLBACK))) return "legacy";
  throw new Error(
    `Diamond ${diamond} routes neither ${REGISTER_WITH_CALLBACK} nor the legacy pair ` +
      `${REGISTER_LEGACY} + ${SET_CANCEL_CALLBACK}.`
  );
}

/**
 * The calls that converge an integrator onto `req`. Pure, so it is unit-tested
 * without a chain. `live` is the current config, or null if never registered.
 *
 * "with-callback": one call, always, carrying every field.
 * "legacy": the 3-arg register (which never touches the flag; a new entry
 * starts false), then the setter only if the flag must move — in that order,
 * because the setter reverts on an unregistered address.
 */
export function planRegistration(
  form: RegisterForm,
  req: RegistrationRequest,
  live: IntegratorConfig | null
): RegistrationCall[] {
  if (form === "with-callback") {
    return [
      {
        signature: REGISTER_WITH_CALLBACK,
        args: [req.integrator, req.usdcThroughIntegrator, req.proxyImpl, req.cancelCallback],
      },
    ];
  }
  const calls: RegistrationCall[] = [
    {
      signature: REGISTER_LEGACY,
      args: [req.integrator, req.usdcThroughIntegrator, req.proxyImpl],
    },
  ];
  if (req.cancelCallback !== (live?.cancelCallbackEnabled ?? false)) {
    calls.push({ signature: SET_CANCEL_CALLBACK, args: [req.integrator, req.cancelCallback] });
  }
  return calls;
}

/**
 * Register (or re-assert) an integrator on whichever surface the Diamond
 * routes, waiting for each transaction. The signer must be a Diamond super
 * admin. Returns the transaction hashes in order.
 */
export async function registerIntegrator(
  signer: ethers.Signer,
  diamond: string,
  req: RegistrationRequest
): Promise<string[]> {
  const provider = signer.provider;
  if (!provider) throw new Error("registerIntegrator: signer has no provider");
  const form = await detectRegisterForm(provider, diamond);
  const live = await getIntegratorConfig(provider, diamond, req.integrator);
  const calls = planRegistration(form, req, live.proxyImpl === ethers.ZeroAddress ? null : live);
  const contract = new ethers.Contract(diamond, REGISTRATION, signer);
  const hashes: string[] = [];
  for (const call of calls) {
    const tx = await contract[call.signature](...call.args);
    await tx.wait(1);
    hashes.push(tx.hash);
  }
  return hashes;
}
