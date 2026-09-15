import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * Run test FILES one at a time.
     *
     * The e2e suites share two things that cannot be shared concurrently: one
     * chain, and one relayer EOA. Each file builds its own in-memory
     * NonceManager, so running two files in parallel puts two independent nonce
     * sequencers on the same account — which is precisely the collision the real
     * NonceManager exists to prevent, reintroduced by the test runner. The
     * symptom is a transaction silently dropped and a suite that passes alone
     * and fails in company.
     *
     * Unit files (limits, relayTx, claims) touch no chain and would be safe in
     * parallel, but splitting the runner's behaviour by file type buys little
     * and hides the constraint. The whole suite is a few seconds either way.
     */
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
