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

  // Instrumentation adds a counter to every branch and statement, which inflates
  // both deployment size and execution gas well past what the default limits
  // allow. The merchant-terminal suites ran out of gas at DEPLOY, so the gate
  // scored contracts it never managed to exercise at near zero — reporting a
  // coverage problem where there was only a gas problem.
  //
  // `networks.hardhat` in hardhat.config.ts does not reach here: solidity-coverage
  // starts its own provider and takes these from `providerOptions` instead.
  providerOptions: {
    gasLimit: 0xfffffffffff,
    allowUnlimitedContractSize: true,
  },

  // DO NOT set `configureYulOptimizer` here. The plugin is imported from
  // hardhat.config.ts, so that option is applied to EVERY compile, not just the
  // coverage run — it injects `optimizer.details.yulDetails` into the normal
  // build and inflated MerchantTerminalIntegrator from 24,504 to 88,034, which
  // would have shipped a contract that cannot deploy. It also did not fix the
  // coverage OOG it was added for.
};
