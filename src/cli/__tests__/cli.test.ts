/**
 * CLI smoke tests.
 *
 * `src/cli/index.ts` is 1059 lines with no tests at all — every command's
 * argument guards, exit codes, and output shape were unverified. These run the
 * built CLI as a real subprocess, which is the only way to check the thing
 * users actually invoke (exit codes, stdout/stderr split, arg parsing).
 *
 * Requires `npx tsc` to have run. `pretest` builds, so `npm test` is safe.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI = resolve(root, "dist/cli/index.js");

/** Run the CLI. Returns stdout+stderr and the exit code, never throws. */
function run(args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync("node", [CLI, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      cwd: root,
    });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status ?? 1 };
  }
}

const ex = (name: string) => resolve(root, "examples", name);

describe("agentopology CLI", () => {
  beforeAll(() => {
    if (!existsSync(CLI)) {
      throw new Error(`CLI not built at ${CLI} — run \`npx tsc\` first.`);
    }
  });

  describe("validate", () => {
    it("exits 0 and says so on a clean topology", () => {
      const { out, code } = run(["validate", ex("simple-pipeline.at")]);
      expect(code).toBe(0);
      expect(out).toContain("All validation rules passed");
    });

    it("exits 1 and names the rule on an invalid topology", () => {
      const dir = mkdtempSync(join(tmpdir(), "at-cli-"));
      const f = join(dir, "bad.at");
      // V89: `prompt` as a KV pair on an agent.
      writeFileSync(
        f,
        [
          "topology bad : [pipeline] {",
          '  meta { version: "1.0.0" description: "x" }',
          "  agent a {",
          "    model: sonnet",
          '    description: "a"',
          '    prompt: "prompts/a.md"',
          "  }",
          "  action intake {",
          "    kind: inline",
          '    description: "in"',
          "  }",
          "  flow { intake -> a }",
          "}",
        ].join("\n")
      );
      const { out, code } = run(["validate", f]);
      rmSync(dir, { recursive: true, force: true });
      expect(code).toBe(1);
      expect(out).toContain("[V89]");
    });

    it("exits 1 on a missing file rather than crashing", () => {
      const { code } = run(["validate", "does/not/exist.at"]);
      expect(code).toBe(1);
    });
  });

  describe("plan", () => {
    it("renders the flow with gates in execution position", () => {
      const { out, code } = run(["plan", ex("code-review.at")]);
      expect(code).toBe(0);
      // The gate must appear AFTER the agent it gates, not first.
      expect(out.indexOf("human-approval")).toBeGreaterThan(out.indexOf("reviewer"));
    });

    it("names roles whose tool restrictions cannot be enforced", () => {
      const { out } = run(["plan", ex("code-review.at")]);
      expect(out).toContain("cannot be set inline");
      expect(out).toContain("analyzer");
    });

    it("names the persistent features that need scaffold", () => {
      const { out } = run(["plan", ex("code-review.at")]);
      expect(out).toContain("agentopology scaffold");
    });

    it("--brief emits only the brief, no terminal render", () => {
      const { out, code } = run(["plan", ex("code-review.at"), "--brief"]);
      expect(code).toBe(0);
      expect(out.trimStart().startsWith("---")).toBe(true);
      expect(out).toContain("§0 — Enactment loop");
      expect(out).not.toContain("Roles\n");
    });

    it("carries the autonomy notch into the brief", () => {
      const { out } = run(["plan", ex("code-review.at"), "--brief", "--mode", "auto"]);
      expect(out).toContain("autonomy: auto");
    });

    it("rejects an unknown --mode", () => {
      const { out, code } = run(["plan", ex("code-review.at"), "--mode", "yolo"]);
      expect(code).toBe(1);
      expect(out).toContain("Unknown --mode");
    });

    it("exits 1 with no file argument", () => {
      const { out, code } = run(["plan"]);
      expect(code).toBe(1);
      expect(out).toContain("requires a file");
    });
  });

  describe("export", () => {
    it("lists available formats when given an unknown one", () => {
      const { out, code } = run(["export", ex("code-review.at"), "--format", "nope"]);
      expect(code).toBe(1);
      expect(out).toContain("Available formats");
      // Registry-driven, so new exporters appear without a CLI edit.
      expect(out).toContain("ascii");
      expect(out).toContain("brief");
    });

    it("writes a file for a registered format", () => {
      const dir = mkdtempSync(join(tmpdir(), "at-exp-"));
      const { code } = run(["export", ex("simple-pipeline.at"), "--format", "ascii", "-o", dir]);
      const files = readdirSync(dir);
      rmSync(dir, { recursive: true, force: true });
      expect(code).toBe(0);
      expect(files.some((f) => f.endsWith(".txt"))).toBe(true);
    });
  });

  describe("scaffold", () => {
    it("--dry-run writes nothing", () => {
      const dir = mkdtempSync(join(tmpdir(), "at-dry-"));
      const { out, code } = run([
        "scaffold",
        ex("simple-pipeline.at"),
        "--target",
        "claude-code",
        "--output",
        dir,
        "--dry-run",
      ]);
      const files = readdirSync(dir);
      rmSync(dir, { recursive: true, force: true });
      expect(code).toBe(0);
      expect(files).toHaveLength(0);
      expect(out).toMatch(/would be generated/i);
    });

    it("exits 1 without --target", () => {
      const { code } = run(["scaffold", ex("simple-pipeline.at")]);
      expect(code).toBe(1);
    });
  });

  describe("general", () => {
    it("targets lists the bindings", () => {
      const { out, code } = run(["targets"]);
      expect(code).toBe(0);
      expect(out).toContain("claude-code");
    });

    it("--help shows usage including plan", () => {
      const { out } = run(["--help"]);
      expect(out).toContain("agentopology plan");
    });

    it("exits non-zero on an unknown command", () => {
      const { code } = run(["definitely-not-a-command"]);
      expect(code).not.toBe(0);
    });
  });
});
