import { existsSync } from "node:fs";

/**
 * Whether the on-chain fixture is present, and whether its absence is allowed.
 *
 * WHY THIS IS NOT JUST `existsSync`
 * Three suites resolved the path with `.pathname.replace(/^\//, "")`, a Windows
 * drive-letter fix that breaks POSIX: it leaves "/D:/..." absolute but turns
 * "/home/..." into a relative path resolved against cwd. So the check was always
 * false on Linux, `describe.skipIf` skipped the suite, and vitest reported
 * green. They ran on a developer machine and had never once run in CI.
 *
 * The path bug is fixed. This exists so the NEXT one cannot hide the same way:
 * under CI a missing fixture is a FAILURE, not a skip. A suite that verifies the
 * headline claims of a change must not be able to opt itself out silently.
 *
 * Locally it still skips, because running the chain is a deliberate extra step
 * and a developer running `vitest` should not be forced into it.
 */
export function requireFixture(url: URL, suite: string): boolean {
  const present = existsSync(url);
  if (present) return true;

  // `CI` is set by GitHub Actions and effectively every other runner.
  if (process.env.CI) {
    throw new Error(
      `${suite}: e2e fixture missing at ${url.pathname}. ` +
        `Under CI this is a failure, not a skip — a suite that verifies the ` +
        `headline claims must not silently opt out. Run a hardhat node and ` +
        `scripts/e2e-setup.js before the worker tests.`
    );
  }
  return false;
}
