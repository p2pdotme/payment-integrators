// Configuration for solidity-coverage. Run via `npx hardhat coverage`.
//
// Mirrors the root project's .solcover.js, which this nested project did not
// have. Two consequences of its absence, both found by running the CI job
// locally rather than reading it:
//
//   1. Without the `json-summary` reporter, coverage/coverage-summary.json is
//      never written — and the threshold gate in .github/workflows/cashback.yml
//      reads exactly that file, so the job would have failed on a missing
//      module rather than on coverage.
//   2. Without skipFiles, the mock tokens in contracts/test/ counted towards
//      the gate. They are deliberately pathological — a token whose balanceOf
//      never returns has unreachable branches by design — so they dragged
//      total branch coverage to 80.19% against an 80% threshold. The gate was
//      passing by 0.19 points for a reason that had nothing to do with the
//      contract being shipped.
//
// skipFiles paths are relative to `contracts/`.

module.exports = {
  istanbulReporter: ["text", "lcov", "json-summary"],
  skipFiles: ["test/"],
};
