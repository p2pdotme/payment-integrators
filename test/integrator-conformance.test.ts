import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

/**
 * Cross-integrator conformance suite (#77).
 *
 * WHY THIS EXISTS. Every integrator here was copied from an earlier one, each
 * was audited separately, and no fix has ever travelled backwards. Showdown is
 * the best-hardened of the eight and almost none of its hardening exists in the
 * contracts it came from — two of which are queued for whitelisting. Nothing in
 * the process makes one contract's fix visible to its siblings; this file is
 * that mechanism.
 *
 * HOW IT WORKS. Each CHECK below is a property we want every integrator to hold.
 * Every contract is measured against every check, and the result is compared to
 * KNOWN — the record of where we already diverge.
 *
 *   fails, and is in KNOWN      -> reported, not fatal (a tracked divergence)
 *   fails, and is NOT in KNOWN  -> the build goes red (new drift)
 *   passes, but is in KNOWN     -> the build goes red (stale entry, delete it)
 *
 * That last rule is what makes this a ratchet rather than a suppression list:
 * KNOWN can only shrink without someone deliberately editing it in a diff, which
 * is exactly the review signal missing today.
 *
 * WHAT THIS IS NOT. These are structural checks over source and ABI, not
 * behavioural ones — proving "the owner sweep cannot touch reserved funds" needs
 * a deployed fixture per contract, which is worth doing but is not what stops
 * drift. Structure is where the copies diverge.
 */

const INTEGRATOR_DIR = path.join(__dirname, "..", "contracts", "integrators");

interface Contract {
  name: string;
  file: string;
  src: string;
}

/** Every contract implementing IP2PIntegrator, discovered rather than listed —
 *  a new integrator is covered the day it is added, without editing this file. */
function discover(): Contract[] {
  const out: Contract[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".sol")) {
        const src = fs.readFileSync(p, "utf8");
        if (/\bis\s+IP2PIntegrator\b|,\s*IP2PIntegrator\b/.test(src)) {
          out.push({ name: entry.name.replace(/\.sol$/, ""), file: p, src });
        }
      }
    }
  };
  walk(INTEGRATOR_DIR);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Body of a named external function, by brace matching (comments included). */
function functionBody(src: string, signatureRe: RegExp): string | null {
  const m = signatureRe.exec(src);
  if (!m) return null;
  const open = src.indexOf("{", m.index);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

/** Strip comments so a property is not "satisfied" by prose about it. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Match a closing delimiter from an opening one, respecting nesting. */
function matchFrom(src: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface FnDecl {
  name: string;
  visibility: string;
  modifiers: string;
  body: string;
}

/**
 * Parse function declarations properly rather than by one regex. A naive
 * `function\s+\w+\s*\(([\s\S]*?)\)\s*(external|public)` spans past the real
 * closing paren on a multi-line signature and picks up the visibility of a LATER
 * function — which reported internal helpers as ungoverned external entrypoints.
 * A false positive here is worse than no check: it would put a fictional entry in
 * KNOWN, and the ratchet is only worth anything if KNOWN is true.
 */
function parseFunctions(code: string): FnDecl[] {
  const out: FnDecl[] = [];
  const re = /function\s+([A-Za-z0-9_]+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const parenOpen = code.indexOf("(", m.index + m[0].length - 1);
    const parenClose = matchFrom(code, parenOpen, "(", ")");
    if (parenClose === -1) continue;
    const braceOpen = code.indexOf("{", parenClose);
    const semi = code.indexOf(";", parenClose);
    // Interface / abstract declaration, no body.
    if (braceOpen === -1 || (semi !== -1 && semi < braceOpen)) continue;
    const header = code.slice(parenClose + 1, braceOpen);
    const vis = /\b(external|public|internal|private)\b/.exec(header)?.[1] ?? "internal";
    const braceClose = matchFrom(code, braceOpen, "{", "}");
    if (braceClose === -1) continue;
    out.push({
      name: m[1],
      visibility: vis,
      modifiers: header,
      body: code.slice(braceOpen, braceClose + 1),
    });
  }
  return out;
}

interface Check {
  id: string;
  title: string;
  /** null = not applicable to this contract (no such surface to get wrong). */
  run: (c: Contract) => boolean | null;
}

const CHECKS: Check[] = [
  {
    id: "no-offramp-relayer",
    title: "no owner-settable relayer can choose someone else's payout destination",
    run: (c) => {
      const code = stripComments(c.src);
      if (!/function\s+deliver[A-Za-z]*\s*\(/.test(code)) return null; // no delivery path
      return !/\bofframpRelayer\b/.test(code);
    },
  },
  {
    id: "reconcile-reads-status",
    title: "reconcile reads status from the Diamond rather than taking it from the caller",
    run: (c) => {
      const sig = /function\s+reconcile\s*\(([^)]*)\)/.exec(stripComments(c.src));
      if (!sig) return null; // no reconcile surface
      return !/\buint8\b|\bstatus\b/i.test(sig[1]);
    },
  },
  {
    id: "attestor-setters-reject-zero",
    title: "attestor setters reject the zero address (a zero attestor bricks the tier)",
    run: (c) => {
      const code = stripComments(c.src);
      const names = [...code.matchAll(/function\s+(set[A-Za-z]*Attestor)\s*\(/g)].map((m) => m[1]);
      if (names.length === 0) return null; // no attestation surface
      return names.every((n) => {
        const body = functionBody(code, new RegExp(`function\\s+${n}\\s*\\(`));
        return body !== null && /==\s*address\(0\)|InvalidAddress|ZeroAddress/.test(body);
      });
    },
  },
  {
    id: "owner-limits-have-ceilings",
    title: "every owner-settable limit is bounded by an immutable MAX_ ceiling",
    run: (c) => {
      const code = stripComments(c.src);
      const setters = [...code.matchAll(/function\s+(set[A-Za-z]*(?:Limit|Cap|Bps))\s*\(/g)].map(
        (m) => m[1]
      );
      if (setters.length === 0) return null; // no tunable limits
      return /\bMAX_[A-Z0-9_]+\b/.test(code);
    },
  },
  {
    id: "value-movers-are-nonreentrant",
    title: "external entrypoints that move value (directly or via helpers) carry nonReentrant",
    run: (c) => {
      const fns = parseFunctions(stripComments(c.src));
      const movesDirectly = (body: string) =>
        /safeTransferFrom\s*\(|safeTransfer\s*\(|transferERC20ToIntegrator\s*\(|\.execute\s*\(|depositForBurn\s*\(/.test(
          body
        );
      // Transitive closure (#95): a first version scanned only external bodies,
      // so a contract whose transfers sit one `_helper` down reported "no value
      // moved here at all" — exactly the contracts with zero guards. Iterate
      // until fixpoint so `external f() { _place(); }` over `_place() {
      // safeTransferFrom(...) }` is a value mover.
      const moving = new Set(fns.filter((f) => movesDirectly(f.body)).map((f) => f.name));
      let grew = true;
      while (grew) {
        grew = false;
        for (const f of fns) {
          if (moving.has(f.name)) continue;
          for (const callee of moving) {
            if (new RegExp(`\\b${callee}\\s*\\(`).test(f.body)) {
              moving.add(f.name);
              grew = true;
              break;
            }
          }
        }
      }
      const movers = fns.filter((f) => {
        const isEntry = f.visibility === "external" || f.visibility === "public";
        const exempt =
          /\bview\b|\bpure\b/.test(f.modifiers) ||
          /^(validateOrder|onOrderComplete|onOrderCancel|selfBridge)$/.test(f.name);
        return isEntry && moving.has(f.name) && !exempt;
      });
      if (movers.length === 0) return null;
      return movers.every((f) => /\bnonReentrant\b/.test(f.modifiers));
    },
  },
  {
    id: "tolerates-repeat-cancel",
    title: "onOrderCancel tolerates a repeat call (IP2PIntegrator asks for this explicitly)",
    run: (c) => {
      const code = stripComments(c.src);
      const body = functionBody(code, /function\s+onOrderCancel\s*\(/);
      if (body === null) return null;
      // The property is specifically: an already-cancelled session must not
      // revert. A bare `return` anywhere is not evidence of that — every one of
      // these contracts returns early on an unknown order.
      return !/if\s*\([^)]*cancelled[^)]*\)\s*revert/i.test(body);
    },
  },
];

/**
 * Divergences we already have. Every entry is a real gap, not a waiver — this is
 * the backlog, in one place, instead of being rediscovered one audit at a time.
 *
 * To remove an entry: fix the contract. The suite fails if an entry is stale, so
 * they cannot rot silently. To add one: it has to survive review as a diff.
 */
const KNOWN: Record<string, Record<string, string>> = {
  // Measured 2026-08-17, not assumed. Every entry below was produced by running
  // the suite with KNOWN empty and recording what actually failed.
  MarketplaceCheckoutIntegrator: {
    "no-offramp-relayer":
      "Removed from Showdown as #53.2 — `encUpi` IS the payout target, so a set relayer can redirect any seller's fiat. Still live here (3 refs).",
    "reconcile-reads-status": "#46 — `reconcile(uint256,uint8)` trusts a caller-supplied status.",
    "owner-limits-have-ceilings":
      "Audit F1. An integrator bypasses the protocol's own volume limits once whitelisted, so unbounded owner limits are a protocol risk, not a partner config choice.",
    "value-movers-are-nonreentrant": "No reentrancy guards anywhere in this contract.",
    "tolerates-repeat-cancel": "Reverts `OrderAlreadyCancelled` on a repeat.",
  },
  OwnCheckoutIntegrator: {
    "attestor-setters-reject-zero":
      "`setAttestor` takes any address including zero, which bricks the tier. Same gap as UsdcDirect and Investabl. Merged to main in #64; tracked as #92.",
  },
  UsdcDirectCheckoutIntegrator: {
    "value-movers-are-nonreentrant":
      "Value moves inside `_placeOrder`, reached from unguarded external entrypoints; zero nonReentrant in the file. Surfaced by the transitive tracing (#95) — the flat scan reported this as not-applicable.",
    "attestor-setters-reject-zero":
      "A zero attestor bricks the tier (every submit*Attestation reverts) and cannot be undone if the owner key is lost. Showdown rejects it.",
    "owner-limits-have-ceilings": "Audit F1 — as above. Queued for whitelisting.",
    "tolerates-repeat-cancel": "Reverts `OrderAlreadyCancelled` on a repeat.",
  },
  InvestablChallengeCheckoutIntegrator: {
    "attestor-setters-reject-zero": "As above. Deployed on Base mainnet.",
    "tolerates-repeat-cancel": "Reverts `OrderAlreadyCancelled` on a repeat.",
  },
  LotPotCheckoutIntegrator: {
    "value-movers-are-nonreentrant":
      "Value moves inside `_placeOrder`; zero guards. DEPLOYED AND IMMUTABLE — record only. Surfaced by the transitive tracing (#95).",
    "tolerates-repeat-cancel":
      "Latches `cancelled` then reverts. DEPLOYED AND IMMUTABLE — record only. This is why contracts-v4 #362's cancel callback must stay OFF for LotPot: enabling it would revert the completion of a dispute the user won.",
  },
  LotPotCheckoutIntegratorV2: {
    "value-movers-are-nonreentrant":
      "Same shape as V1; zero guards. DEPLOYED AND IMMUTABLE — record only. Surfaced by the transitive tracing (#95).",
    "tolerates-repeat-cancel":
      "Latches `cancelled` then reverts. DEPLOYED AND IMMUTABLE — record only. 3468 of 4066 mainnet B2B placements; see #362.",
  },
  ExampleIntegrator: {
    "owner-limits-have-ceilings": "Reference contract for contributors to fork, never deployed.",
    "value-movers-are-nonreentrant": "Reference contract, never deployed.",
    "tolerates-repeat-cancel":
      "Reference contract — but it is the file people COPY, so fixing this one is the cheapest way to stop new integrators inheriting the divergence.",
  },
};

describe("IP2PIntegrator conformance (#77)", function () {
  const contracts = discover();

  it("discovers every integrator, so a new one is covered the day it lands", function () {
    expect(contracts.length).to.be.greaterThan(0);
    // Guards against the regex silently matching nothing after a refactor.
    expect(contracts.map((c) => c.name)).to.include("ShowdownCheckoutIntegrator");
  });

  for (const check of CHECKS) {
    describe(check.id, function () {
      for (const c of contracts) {
        const known = KNOWN[c.name]?.[check.id];

        // #93: the title itself distinguishes a tracked divergence from a
        // not-applicable skip, so the report reads as a divergence register —
        // the KNOWN reason is the line you most want to see, not blank noise.
        const title = known
          ? `${c.name}: TRACKED DIVERGENCE — ${known}`
          : `${c.name}: ${check.title}`;
        it(title, function () {
          const result = check.run(c);

          if (result === null) {
            if (known) {
              throw new Error(
                `KNOWN lists ${c.name} / ${check.id}, but the check does not apply to this ` +
                  `contract at all. Remove the entry — a stale allowlist is worse than none.`
              );
            }
            this.skip();
            return;
          }

          if (result) {
            expect(
              known,
              `${c.name} now PASSES ${check.id}. Delete its KNOWN entry so the ratchet holds ` +
                `and this contract cannot silently regress.`
            ).to.equal(undefined);
            return;
          }

          expect(
            known,
            `${c.name} fails ${check.id} and is not a recorded divergence.\n` +
              `    ${check.title}\n` +
              `    Either fix the contract, or add it to KNOWN with a reason — as a visible diff.`
          ).to.not.equal(undefined);
          this.skip(); // tracked divergence: reported, not fatal
        });
      }
    });
  }
});
