/**
 * [CX-1] The version line and the installed mark come from a per-target seam.
 * A fake `codex` on PATH stands in for the binary; no model, no login.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { platformConformance } from "../../conformance/index.js";
import { verifiedOnLine as claudeLine } from "../../conformance/claude-code.js";
import { verifiedOnLine as codexLine } from "../../conformance/codex.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../../dist/cli/index.js");
const FIXTURE = resolve(here, "fixtures/compile.at");
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

let bin: string;
beforeAll(() => {
  bin = fs.mkdtempSync(join(os.tmpdir(), "at-fakecodex-"));
  const f = join(bin, "codex");
  fs.writeFileSync(f, "#!/bin/sh\necho 'codex-cli 0.999.0'\n");
  fs.chmodSync(f, 0o755);
});

const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENTOPOLOGY_CLAUDE_VERSION: "2.1.323", ...extra };
  delete env.AGENTOPOLOGY_CODEX_VERSION;
  env.PATH = `${bin}:${process.env.PATH}`;
  return spawnSync("node", [CLI, ...args], { encoding: "utf8", env });
};

describe("[CX-1] platform seam", () => {
  it("[CX-1] the seam answers per target", () => {
    expect(platformConformance("claude-code")!.verifiedOnLine()).toBe(claudeLine());
    expect(platformConformance("codex")!.verifiedOnLine()).toBe(codexLine());
    expect(platformConformance("nope")).toBeNull();
  });

  it("[CX-1] targets prints the Codex line and the installed mark", () => {
    const l = plain(run(["targets"]).stdout).split("\n").find((x) => x.includes("codex"))!;
    expect(l).toContain(codexLine());
    expect(l).toContain("installed 0.999.0: unverified");
  });

  it("[CX-1] scaffold --target codex prints the installed mark", () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), "at-cx1-"));
    const out = plain(run(["scaffold", FIXTURE, "--target", "codex", "--dry-run", "--output", dir]).stdout);
    expect(out).toContain("installed 0.999.0: unverified");
    expect(out).toContain(codexLine());
  });

  it("[CX-1] claude-code output carries no Codex line", () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), "at-cx1-"));
    const out = plain(run(["scaffold", FIXTURE, "--target", "claude-code", "--dry-run", "--output", dir]).stdout);
    expect(out).toContain(claudeLine());
    expect(out).not.toContain("0.999.0");
  });
});
