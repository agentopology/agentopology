import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The CLI and e2e tests run the built CLI. Without this they ran whatever
    // stale dist/ was on disk, so a source change could pass on old output.
    globalSetup: ["./src/__tests__/global-setup.ts"],
    // A macrotask before every test, so vitest's worker RPC replies are read
    // between synchronous tests (see the file for the measured cause).
    setupFiles: ["./src/__tests__/yield-setup.ts"],
    // The e2e tests start the CLI two or three times each; under a full
    // parallel run one occasionally passed the 5 s default and failed (G3, G2,
    // R3 seen) though nothing was wrong.
    testTimeout: 30_000,
    // and their afterEach removes a temp project, which a loaded machine can
    // slow past the 10 s default.
    hookTimeout: 30_000,
    // T1: the differential tests keep a worker busy for minutes; give a worker
    // that long to tear down before vitest gives up on it (default 10 s).
    teardownTimeout: 120_000,
  },
});
