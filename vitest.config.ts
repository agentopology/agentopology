import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The CLI and e2e tests run the built CLI. Without this they ran whatever
    // stale dist/ was on disk, so a source change could pass on old output.
    globalSetup: ["./src/__tests__/global-setup.ts"],
  },
});
