/**
 * `validate` with no target sees a plugin's gate checks (EXPERIMENTAL): it
 * judges the default target, claude-code, as scaffold does, so V110 does not
 * warn that a gate acme checks has nothing to check.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import type { AtPlugin } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
let acme: AtPlugin;
beforeAll(async () => {
  acme = (await import(pathToFileURL(join(here, "fixtures/acme.mjs")).href)).default as AtPlugin;
});

const SRC = [
  "topology w : [pipeline] {",
  "  meta {",
  '    version: "1.0.0"',
  '    description: "a checked step"',
  "  }",
  "  orchestrator {",
  "    model: sonnet",
  "    handles: [build]",
  "  }",
  "  agent a {",
  "    model: sonnet",
  "    prompt { Do a. }",
  "  }",
  "  action build {",
  "    kind: external",
  '    commands: ["./tool build"]',
  "  }",
  "  flow {",
  "    a -> build",
  "  }",
  "  gates {",
  "    gate step-check {",
  "      after: a",
  "      before: build",
  "      extensions {",
  "        acme { }",
  "      }",
  "    }",
  "  }",
  "}",
  "",
].join("\n");

const v110 = (plugins: AtPlugin[], target?: string) =>
  validate(parse(SRC, { plugins }), target ? { target } : {}).filter((r) => r.rule === "V110");

describe("validate with no target and a plugin's gate check", () => {
  it("without the plugin, V110 warns: nothing checks the gate", () => {
    expect(v110([]).map((r) => r.node)).toEqual(["step-check"]);
  });

  it("with acme, no target: no V110 (judged for claude-code, where acme sets the check)", () => {
    expect(v110([acme])).toEqual([]);
  });

  it("with acme, --target claude-code: no V110; --target codex, where acme sets nothing: V110", () => {
    expect(v110([acme], "claude-code")).toEqual([]);
    expect(v110([acme], "codex").map((r) => r.node)).toEqual(["step-check"]);
  });

  it("the CLI's validate with --plugin and no target prints no V110", () => {
    const dir = mkdtempSync(join(tmpdir(), "at-v110-"));
    try {
      writeFileSync(join(dir, "w.at"), SRC);
      const r = spawnSync("node", [join(root, "dist/cli/index.js"), "validate", join(dir, "w.at"), "--plugin", join(here, "fixtures/acme.mjs")], { encoding: "utf8" });
      expect(r.stdout).not.toContain("V110");
      const plain = spawnSync("node", [join(root, "dist/cli/index.js"), "validate", join(dir, "w.at")], { encoding: "utf8" });
      expect(plain.stdout).toContain("V110");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
