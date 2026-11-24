/**
 * A plugin's gate check learns the tool of the call it guards (EXPERIMENTAL):
 * the gate's wrapper exports AT_TOOL, the matcher of the hook that runs it.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import type { AtPlugin } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));
let acme: AtPlugin;
beforeAll(async () => {
  acme = (await import(pathToFileURL(join(here, "fixtures/acme.mjs")).href)).default as AtPlugin;
});

const gate = (id: string, after: string, before: string) =>
  [`    gate ${id} {`, `      after: ${after}`, `      before: ${before}`, "      extensions {", "        acme { }", "      }", "    }"].join("\n");

const SRC = [
  "topology w : [pipeline] {",
  "  meta {",
  '    version: "1.0.0"',
  '    description: "tools"',
  "  }",
  "  orchestrator {",
  "    model: sonnet",
  "    handles: [build]",
  "  }",
  "  agent a {",
  "    model: sonnet",
  "    prompt { Do a. }",
  "  }",
  "  agent b {",
  "    model: sonnet",
  "    prompt { Do b. }",
  "  }",
  "  action build {",
  "    kind: external",
  '    commands: ["./tool build"]',
  "  }",
  "  flow {",
  "    a -> build",
  "    build -> b",
  "  }",
  "  gates {",
  gate("on-stop", "a", "b"),
  gate("on-step", "a", "build"),
  gate("on-launch", "build", "b"),
  "  }",
  "}",
  "",
].join("\n");

const scaffold = (plugins: AtPlugin[]) => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return claudeCodeBinding.scaffold(parse(SRC, { plugins }));
  } finally {
    console.warn = warn;
  }
};
const wrapper = (files: ReturnType<typeof scaffold>, id: string) => files.find((f) => f.path === `.claude/skills/w/scripts/gate-${id}.sh`)?.content ?? "";

describe("AT_TOOL", () => {
  it("each plugin-checked gate's wrapper exports the matcher of the hook that runs it", () => {
    const files = scaffold([acme]);
    expect(wrapper(files, "on-step")).toContain("export AT_TOOL='Bash|Monitor|PowerShell'");
    expect(wrapper(files, "on-launch")).toContain("export AT_TOOL='Agent|Task'");
    // A SubagentStop hook guards a stop, not a tool call.
    expect(wrapper(files, "on-stop")).toContain("export AT_TOOL=''");
  });

  it("no wrapper exports it without a plugin", () => {
    for (const f of scaffold([])) expect(f.content, f.path).not.toContain("AT_TOOL");
  });

  it("the plugin's check reads it when the wrapper runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "at-tool-"));
    try {
      for (const f of scaffold([acme])) {
        mkdirSync(dirname(join(dir, f.path)), { recursive: true });
        writeFileSync(join(dir, f.path), f.content);
      }
      const r = spawnSync("bash", [join(dir, ".claude/skills/w/scripts/gate-on-step.sh")], { cwd: dir, input: "", encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
      expect(r.stderr).toContain("acme check tool=Bash|Monitor|PowerShell");
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
