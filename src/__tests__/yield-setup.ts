// Runs before every test in every file (vitest.config.ts setupFiles).
//
// Vitest's worker sends its progress to the main process ("onTaskUpdate") and
// waits 60 s for the reply, a limit no config option changes in vitest 3.2.
// The reply can only be read when the worker's event loop turns. Between two
// synchronous tests the runner awaits only promises, so a file of synchronous
// tests that each start the CLI with execFileSync never turns the loop: one
// such file was measured holding it for 131 s under load. The reply then sits
// unread, the 60 s timer fires first, and the run exits 1 with
// `Timeout calling "onTaskUpdate"` although every test passed.
//
// One macrotask before each test lets the loop turn, so the longest stretch
// without a turn is one test and its hooks (each bounded by testTimeout and
// hookTimeout, 30 s), well under the 60 s limit.
import { beforeEach } from "vitest";

beforeEach(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
});
