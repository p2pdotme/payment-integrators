// Configuration for solidity-coverage. Run via `npx hardhat coverage`.
//
// We emit `json-summary` so CI can read coverage/coverage-summary.json to
// enforce thresholds. The Istanbul defaults (html, lcov, text, json) don't
// produce a summary file by name — `json-summary` is the extra reporter.
//
// skipFiles paths are relative to `contracts/`. We exclude:
//   - test/      — mocks for upstream protocols, not shipped
//   - examples/  — reference business clients, not protocol surface
//   - templates/ — starter contracts that contributors fork; they have no
//                  meaningful logic until customised, so coverage on them
//                  is uninformative.

module.exports = {
  istanbulReporter: ["text", "lcov", "json-summary"],
  skipFiles: ["test/", "examples/", "templates/"],
};
