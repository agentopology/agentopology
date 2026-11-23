/**
 * `include "./f.at"` keeps what the fragment declares.
 *
 * Measured on 0.12.6: a topology that includes a fragment holding a hook
 * validates clean and `scaffold --target claude-code` writes no
 * .claude/settings.json at all. The include line was parsed and never read,
 * so every section of the fragment was dropped in silence. The fixture is the
 * planted case (p26-block-include.at + blocks/brain.at), copied as written.
 *
 * Now each section a fragment holds is either merged into the topology the
 * bindings see (validate, scaffold, guard --check and plan all read it) or
 * refused by V8 naming the section and the fragment file. Nothing is dropped.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../../dist/cli/index.js");
const FIXTURE = resolve(here, "fixtures/include-fragment");

describe("include: a fragment's declarations reach the topology", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(join(os.tmpdir(), "at-include-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const cli = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", timeout: 60_000 });
  const out = (r: ReturnType<typeof cli>) => `${r.stdout}${r.stderr}`;

  /** `export --format json` into a temp folder; the AST it wrote. */
  const exported = (at: string): Record<string, any> => {
    const dir = fs.mkdtempSync(join(root, "export-"));
    const e = cli(["export", at, "--format", "json", "--output", dir]);
    expect(e.status, out(e)).toBe(0);
    const [file] = fs.readdirSync(dir);
    return JSON.parse(fs.readFileSync(join(dir, file), "utf8"));
  };

  /** Write a project: main.at plus files under it. */
  const project = (files: Record<string, string>): string => {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(dirname(join(root, rel)), { recursive: true });
      fs.writeFileSync(join(root, rel), text);
    }
    return join(root, "main.at");
  };

  const main = (body: string, name = "main") => `topology ${name} : [pipeline] {
  meta {
    version: "0.1.0"
    description: "includes a fragment"
  }
  include "./frag.at"
${body}
  agent builder {
    model: sonnet
    description: "Builds"
    invocation: manual
  }
}
`;
  const frag = (body: string) => `fragment {\n${body}\n}\n`;

  const HOOK = `  hooks {
    hook header-gate {
      on: PreToolUse
      matcher: "Edit|Write"
      run: "bash tools/knowledge/header-gate.sh"
      type: command
      strength: refuse
    }
  }`;

  it("the planted case: scaffold writes the fragment's PreToolUse hook with its matcher and onFailure block", () => {
    const proj = join(root, "proj");
    const r = cli(["scaffold", join(FIXTURE, "p26-block-include.at"), "--target", "claude-code", "--output", proj]);
    expect(r.status, out(r)).toBe(0);
    const settingsPath = join(proj, ".claude/settings.json");
    expect(fs.existsSync(settingsPath), out(r)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(settings.hooks.PreToolUse).toEqual([
      {
        hooks: [{ type: "command", command: 'bash "$CLAUDE_PROJECT_DIR/tools/knowledge/header-gate.sh"', onFailure: "block" }],
        matcher: "Edit|Write",
      },
    ]);
    // The script path stays as the fragment wrote it, relative to the project.
    expect(fs.existsSync(join(proj, "tools/knowledge/header-gate.sh"))).toBe(true);
  });

  it("the planted case: validate passes and the fragment parses on its own (`fragment {` with no name)", () => {
    const v = cli(["validate", join(FIXTURE, "p26-block-include.at")]);
    expect(v.status, out(v)).toBe(0);
    const f = cli(["validate", join(FIXTURE, "blocks/brain.at")]);
    expect(out(f)).not.toContain("Parse error");
  });

  it("guard --check grades a gate a fragment declares, as it grades the same gate written inline", () => {
    const GATE = `  gates {
    gate copy-check {
      after: builder
      run: "scripts/copy-check.sh"
      on-fail: halt
    }
  }`;
    const grade = (at: string, proj: string) => {
      const s = cli(["scaffold", at, "--target", "claude-code", "--output", proj]);
      expect(s.status, out(s)).toBe(0);
      const g = cli(["guard", at, "--check", "--target", "claude-code", "--dir", proj]);
      return out(g).split("\n").filter((l) => /copy-check|enforcement:/.test(l));
    };
    const included = grade(project({ "main.at": main(""), "frag.at": frag(GATE) }), join(root, "proj-a"));
    fs.writeFileSync(join(root, "inline.at"), main(GATE, "main").replace('  include "./frag.at"\n', ""));
    const inline = grade(join(root, "inline.at"), join(root, "proj-b"));
    // The scaffolded script is still a stub, so the grade is none, by: hook
    // (a gate missing from the AST would not be listed at all).
    expect(included.join("\n")).toMatch(/gate copy-check\s+none\s+by: hook/);
    expect(included).toEqual(inline);
  });

  it("the planted case: plan sees the fragment's hook", () => {
    const p = cli(["plan", join(FIXTURE, "p26-block-include.at")]);
    expect(p.status, out(p)).toBe(0);
    expect(out(p)).toContain("1 hooks declared");
  });

  it("the planted case: export --format json carries the fragment's hook", () => {
    expect(exported(join(FIXTURE, "p26-block-include.at")).hooks.map((h: { name: string }) => h.name)).toEqual(["header-gate"]);
  });

  it("two hooks with the same name in the topology and the fragment: an error naming both files", () => {
    const at = project({ "main.at": main(HOOK), "frag.at": frag(HOOK) });
    const v = cli(["validate", at]);
    expect(v.status).toBe(1);
    expect(out(v)).toMatch(/V8.*hook "header-gate".*main\.at.*frag\.at/);
    const s = cli(["scaffold", at, "--target", "claude-code", "--output", join(root, "proj")]);
    expect(s.status).not.toBe(0);
  });

  it("a missing fragment file is an error, not a clean validate", () => {
    const at = project({ "main.at": main("") });
    const v = cli(["validate", at]);
    expect(v.status).toBe(1);
    expect(out(v)).toMatch(/V8.*include "\.\/frag\.at".*not found/);
  });

  it("an include cycle is an error", () => {
    const at = project({ "main.at": main(""), "frag.at": frag('  include "./frag.at"') });
    const v = cli(["validate", at]);
    expect(v.status).toBe(1);
    expect(out(v)).toMatch(/V8.*include cycle/);
  });

  it("a nested include is read relative to the fragment that writes it", () => {
    const at = project({
      "main.at": main(""),
      "frag.at": frag('  include "./blocks/inner.at"'),
      "blocks/inner.at": frag(HOOK),
    });
    expect(exported(at).hooks.map((h: { name: string }) => h.name)).toEqual(["header-gate"]);
  });

  // Every section a fragment can hold: merged (seen in export --format json)
  // or refused by V8 naming the section and the fragment file. Never dropped.
  const MERGED: Array<[string, string, (ast: Record<string, any>) => unknown, unknown]> = [
    ["hooks", HOOK, (a) => a.hooks.map((h: any) => h.name), ["header-gate"]],
    ["agent", "  agent reviewer {\n    model: opus\n    description: \"Reviews\"\n    invocation: manual\n  }", (a) => a.nodes.map((n: any) => n.id).sort(), ["builder", "reviewer"]],
    ["skills", "  skill lint {\n    description: \"Lints\"\n  }", (a) => a.skills.map((s: any) => s.id), ["lint"]],
    ["env", "  env {\n    LOG_LEVEL: \"debug\"\n  }", (a) => a.env.LOG_LEVEL, "debug"],
    ["mcp-servers", "  mcp-servers {\n    docs {\n      command: \"npx\"\n      args: [\"docs-server\"]\n    }\n  }", (a) => Object.keys(a.mcpServers), ["docs"]],
  ];
  for (const [section, body, pick, want] of MERGED) {
    it(`merged: a fragment's ${section} reaches the topology`, () => {
      const at = project({ "main.at": main(""), "frag.at": frag(body) });
      expect(pick(exported(at))).toEqual(want);
      const v = cli(["validate", at]);
      expect(out(v)).not.toMatch(/V8/);
    });
  }

  const REFUSED: Array<[string, string]> = [
    ["settings", "  settings {\n    allow: [\"Read\"]\n  }"],
    ["depth", "  depth {\n    factors: [scope]\n  }"],
    ["defaults", "  defaults {\n    temperature: 0.2\n  }"],
  ];
  for (const [section, body] of REFUSED) {
    it(`refused: a fragment's ${section} is a V8 error naming the section and the file`, () => {
      const at = project({ "main.at": main(""), "frag.at": frag(body) });
      const v = cli(["validate", at]);
      expect(v.status, out(v)).toBe(1);
      expect(out(v)).toMatch(new RegExp(`V8.*include "\\./frag\\.at".*\`${section}\``));
    });
  }
});
