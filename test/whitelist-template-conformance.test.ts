import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

/**
 * Whitelist request template conformance (#67).
 *
 * WHY THIS EXISTS. `docs/WHITELISTING.md` names the fields a whitelist request
 * must carry, and `.github/ISSUE_TEMPLATE/whitelist-request.md` is what actually
 * gets filled in. Nothing connected the two: the doc gained
 * `usdcThroughIntegrator` and the template never did, so for every request since,
 * the superAdmin has had to infer the third argument of
 * `registerIntegrator(integrator, usdcThroughIntegrator, proxyImpl)` from PR
 * prose. That argument decides whether BUY proceeds land on the integrator or on
 * the order's `recipientAddr` — a wrong bool is a silent misrouting of
 * settlement, not a failed transaction, and it is pinned at registration.
 *
 * HOW IT WORKS. The doc is the source of truth. Its required-field list is
 * parsed at run time, and each field must be solicited by the template. The two
 * files do not share a vocabulary — the doc says "Integrator address" where the
 * template says "Deployed address" — so SOLICITS records how each required field
 * is spelled on the template side, with the drift written down rather than
 * silently tolerated.
 *
 * The map is checked in both directions:
 *
 *   doc field with no SOLICITS entry  -> red (a new requirement nobody wired up)
 *   SOLICITS entry with no doc field  -> red (stale entry, delete it)
 *   doc field the template never asks -> red (this is #67)
 *
 * So the only way to add a required field to WHITELISTING.md without also
 * putting it on the template is to edit this file in the same diff, in view of a
 * reviewer. That is the review signal that was missing.
 *
 * WHAT THIS IS NOT. A check that the field is filled in correctly — that is the
 * reviewer's job, and the pre-flight checkbox is there to make them do it. This
 * only guarantees the question gets asked.
 */

const ROOT = path.join(__dirname, "..");
const DOC = path.join(ROOT, "docs", "WHITELISTING.md");
const TEMPLATE = path.join(ROOT, ".github", "ISSUE_TEMPLATE", "whitelist-request.md");

/** Bold labels carry inline code and stray spacing; compare on a flat form. */
function normalise(label: string): string {
  return label.replace(/`/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The bullet list under "Required fields:" in the "Open a Whitelist request"
 * step. Parsed rather than hardcoded so that the doc stays the one place a
 * requirement is declared.
 */
function requiredFields(doc: string): { label: string; key: string }[] {
  const start = doc.indexOf("Required fields:");
  expect(start, "WHITELISTING.md no longer contains a 'Required fields:' list").to.be.greaterThan(
    -1
  );

  // Stop at the next section heading so a later list cannot leak in.
  const rest = doc.slice(start);
  const end = rest.search(/\n#{2,3}\s/);
  const block = end === -1 ? rest : rest.slice(0, end);

  const out: { label: string; key: string }[] = [];
  for (const line of block.split("\n")) {
    const m = /^-\s+\*\*(.+?)\*\*/.exec(line);
    if (m) out.push({ label: m[1], key: normalise(m[1]) });
  }
  return out;
}

interface Solicit {
  /** What the template must contain for this field to count as asked for. */
  pattern: RegExp;
  /** Recorded when the template spells the field differently to the doc. */
  drift?: string;
}

const SOLICITS: Record<string, Solicit> = {
  network: { pattern: /^-\s+\*\*Network\*\*/m },
  "integrator address": {
    pattern: /^-\s+\*\*Deployed address\*\*/m,
    drift: 'template says "Deployed address"',
  },
  "pinned proxyimpl": { pattern: /^-\s+\*\*Pinned `?proxyImpl`?\*\*/m },
  usdcthroughintegrator: { pattern: /^-\s+\*\*`?usdcThroughIntegrator`?\*\*/m },
  "deployer address": { pattern: /^-\s+\*\*Deployer address\*\*/m },
  "merged commit hash": {
    pattern: /^-\s+\*\*Merged commit (?:hash|SHA)\*\*/m,
    drift: 'template says "Merged commit SHA"',
  },
  "bytecode hash": {
    pattern: /^-\s+\*\*(?:Runtime )?Bytecode hash\*\*/im,
    drift: 'template says "Runtime bytecode hash"',
  },
  "etherscan verification link": {
    pattern: /^-\s+\*\*Etherscan[^*]*\*\*/m,
    drift: 'template says "Etherscan / Basescan link"',
  },
  "expected circleid(s)": { pattern: /^-\s+\*\*Expected `circleId`\(s\)\*\*/m },
  "operational contact": {
    pattern: /^-\s+\*\*(?:Maintainer|Operational) contact\*\*/m,
    drift: 'template says "Maintainer contact"',
  },
};

describe("Whitelist request template conformance (#67)", function () {
  const doc = fs.readFileSync(DOC, "utf8");
  const template = fs.readFileSync(TEMPLATE, "utf8");
  const fields = requiredFields(doc);

  it("parses the required-field list out of WHITELISTING.md", function () {
    // Guards against the parser silently matching nothing after a doc refactor,
    // which would turn every check below into a vacuous pass.
    expect(fields.length).to.be.greaterThan(0);
    expect(fields.map((f) => f.key)).to.include("usdcthroughintegrator");
  });

  it("knows how every required field is spelled on the template", function () {
    const unmapped = fields.filter((f) => SOLICITS[f.key] === undefined).map((f) => f.label);
    expect(
      unmapped,
      `WHITELISTING.md requires ${unmapped.join(", ")}, but this test does not know what that ` +
        `looks like on the template. Add the field to the template and an entry to SOLICITS.`
    ).to.deep.equal([]);
  });

  it("has no stale SOLICITS entries", function () {
    const keys = new Set(fields.map((f) => f.key));
    const stale = Object.keys(SOLICITS).filter((k) => !keys.has(k));
    expect(
      stale,
      `SOLICITS lists ${stale.join(", ")}, which WHITELISTING.md no longer requires. ` +
        `Delete the entries — a stale map is worse than none.`
    ).to.deep.equal([]);
  });

  describe("every required field is solicited by the template", function () {
    for (const field of fields) {
      const solicit = SOLICITS[field.key];
      const title = solicit?.drift ? `${field.label} (${solicit.drift})` : `${field.label}`;

      it(title, function () {
        if (solicit === undefined) {
          this.skip(); // reported by the mapping test above
          return;
        }
        expect(
          solicit.pattern.test(template),
          `WHITELISTING.md lists "${field.label}" as required, but ` +
            `.github/ISSUE_TEMPLATE/whitelist-request.md never asks for it. A requester cannot ` +
            `supply what they are not asked for, so the superAdmin ends up inferring it.`
        ).to.equal(true);
      });
    }
  });

  describe("usdcThroughIntegrator, specifically (#67)", function () {
    it("is asked for as an explicit true/false, not free text", function () {
      const line = /^-\s+\*\*`?usdcThroughIntegrator`?\*\*:(.*)$/m.exec(template);
      expect(line, "the field is missing from the template entirely").to.not.equal(null);
      expect(
        /`true`|`false`/.test(line![1]),
        "the field must offer true/false, so the answer is a value the superAdmin can pass " +
          "straight to registerIntegrator rather than prose they have to interpret"
      ).to.equal(true);
    });

    it("sits with proxyImpl, the other value pinned at registration", function () {
      const proxy = template.search(/^-\s+\*\*Pinned `?proxyImpl`?\*\*/m);
      const flag = template.search(/^-\s+\*\*`?usdcThroughIntegrator`?\*\*/m);
      expect(proxy).to.be.greaterThan(-1);
      expect(flag).to.be.greaterThan(-1);
      const between = template.slice(Math.min(proxy, flag), Math.max(proxy, flag));
      expect(
        /^#{2,3}\s/m.test(between),
        "both are set-once by registerIntegrator and are reviewed together; a heading between " +
          "them splits the pair across sections"
      ).to.equal(false);
    });

    it("is verified in the pre-flight, not merely stated", function () {
      expect(
        /^-\s+\[ \].*`?usdcThroughIntegrator`?.*$/m.test(template),
        "a stated bool nobody checks is how a wrong one gets registered; the pre-flight is " +
          "where the reviewer confirms it against onOrderComplete"
      ).to.equal(true);
    });
  });
});
