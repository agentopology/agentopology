/**
 * Loading plugins from the CLI (EXPERIMENTAL): only `--plugin <module>` and
 * the project's package.json `agentopology.plugins` load code, every load is
 * printed, and an .at never loads anything. Runs the built CLI.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const CLI = resolve(root, "dist/cli/index.js");
const ACME = join(here, "fixtures/acme.mjs");
const ACME_REL = "./src/plugins/__tests__/fixtures/acme.mjs";

function run(args: string[], cwd = root): { out: string; err: string; code: number } {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd });
  return { out: r.stdout ?? "", err: r.stderr ?? "", code: r.status ?? 1 };
}

const AT = `topology w : [pipeline] {
  meta {
    version: "1.0.0"
    description: "widgets"
  }
  orchestrator {
    model: sonnet
  }
  agent a {
    model: sonnet
    prompt { Do a. }
  }
  agent b {
    model: sonnet
    prompt { Do b. }
  }
  flow {
    a -> b
  }
  gates {
    gate g {
      after: a
      before: b
      extensions {
        acme { }
      }
    }
  }
  widget w1 {
    a: "one"
  }
}
`;

const dirs: string[] = [];
const project = (files: Record<string, string> = {}): string => {
  const d = mkdtempSync(join(tmpdir(), "at-plugin-"));
  dirs.push(d);
  writeFileSync(join(d, "w.at"), AT);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(d, p)), { recursive: true });
    writeFileSync(join(d, p), c);
  }
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("plugin loading (CLI)", () => {
  it("without a plugin, the widget block is V102 and nothing is loaded", () => {
    const d = project();
    const r = run(["validate", join(d, "w.at")]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("ERROR [V102] the topology has a `widget w1 { }` block, which is not a topology section, so it is ignored");
    expect(`${r.out}${r.err}`).not.toContain("loaded plugin");
  });

  it("a single-file plugin loads by a relative path, and the load is printed", () => {
    const d = project();
    const r = run(["validate", join(d, "w.at"), "--plugin", ACME_REL]);
    expect(r.err).toContain(`loaded plugin acme@1.0.0 from ${ACME}`);
    expect(r.out).not.toContain("V102");
    expect(r.code).toBe(0);
  });

  it("a single-file plugin loads by an absolute path outside the project", () => {
    const d = project();
    const r = run(["validate", join(d, "w.at"), "--plugin", ACME], d);
    expect(r.err).toContain(`loaded plugin acme@1.0.0 from ${ACME}`);
    expect(r.code).toBe(0);
  });

  it("a plugin with no version field prints unversioned", () => {
    const d = project({ "p/plain.mjs": readFileSync(ACME, "utf8").replace('version:"1.0.0",', "") });
    const r = run(["validate", join(d, "w.at"), "--plugin", "./p/plain.mjs"], d);
    expect(r.err).toContain(`loaded plugin acme@unversioned from `);
  });

  it("package.json agentopology.plugins loads from the project folder", () => {
    const d = project({ "package.json": JSON.stringify({ name: "p", agentopology: { plugins: ["./plugins/acme.mjs"] } }) });
    mkdirSync(join(d, "plugins"));
    copyFileSync(ACME, join(d, "plugins/acme.mjs"));
    const r = run(["validate", join(d, "w.at")]);
    expect(r.err).toMatch(/loaded plugin acme@1\.0\.0 from .*plugins\/acme\.mjs/);
    expect(r.code).toBe(0);
  });

  it("a bare name resolving outside node_modules and the project is refused", () => {
    const outside = project();
    copyFileSync(ACME, join(outside, "index.mjs"));
    writeFileSync(join(outside, "package.json"), JSON.stringify({ name: "acme-linked", type: "module", main: "index.mjs" }));
    const d = project();
    mkdirSync(join(d, "node_modules"));
    symlinkSync(outside, join(d, "node_modules/acme-linked"));
    const r = run(["validate", join(d, "w.at"), "--plugin", "acme-linked"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/plugin acme-linked \(--plugin\) resolves to .*, outside node_modules and the project .*; refused/);
    expect(r.err).not.toContain("loaded plugin");
  });

  it("an apiVersion other than 1 is a clear error", () => {
    const d = project({ "p/v2.mjs": readFileSync(ACME, "utf8").replace("apiVersion:1", "apiVersion:2") });
    const r = run(["validate", join(d, "w.at"), "--plugin", "./p/v2.mjs"], d);
    expect(r.code).toBe(1);
    expect(r.err).toContain("plugin acme is written for plugin API version 2; this agentopology supports apiVersion 1 only.");
  });

  it("an .at cannot trigger a load", () => {
    const marker = join(tmpdir(), `at-plugin-marker-${process.pid}-${Date.now()}`);
    const evil = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "loaded");\nexport default { id: "evil", apiVersion: 1, blocks: {} };\n`;
    const d = project({ "evil.mjs": evil });
    writeFileSync(join(d, "w.at"), AT.replace("topology w : [pipeline] {", 'import x from "./evil.mjs"\ntopology w : [pipeline] {\n  uses-plugins: [./evil.mjs, evil]'));
    const r = run(["validate", join(d, "w.at")], d);
    expect(existsSync(marker)).toBe(false);
    expect(`${r.out}${r.err}`).not.toContain("loaded plugin");
    expect(r.out).toContain("ERROR [V158] block widget needs plugin ./evil.mjs or evil; run with --plugin ./evil.mjs or --plugin evil");
  });

  it("scaffold writes the plugin's file and hook, and guard --check sees the gate's plugin check", () => {
    const d = project();
    const s = run(["scaffold", join(d, "w.at"), "--target", "claude-code", "--dir", d, "--plugin", ACME]);
    expect(s.code).toBe(0);
    expect(JSON.parse(readFileSync(join(d, ".claude/acme/widget.json"), "utf8"))).toEqual([{ id: "w1", a: "one" }]);
    const settings = JSON.parse(readFileSync(join(d, ".claude/settings.json"), "utf8"));
    expect(settings.hooks.PreToolUse).toContainEqual({ matcher: "Bash", hooks: [{ type: "command", command: 'bash "$CLAUDE_PROJECT_DIR/.claude/acme/hook.sh"' }] });
    expect(settings.hooks.SubagentStop).toEqual([{ matcher: "a", hooks: [{ type: "command", command: 'bash "$CLAUDE_PROJECT_DIR/.claude/skills/w/scripts/gate-g.sh"' }] }]);
    const withPlugin = run(["guard", join(d, "w.at"), "--check", "--dir", d, "--plugin", ACME]);
    const gateLine = withPlugin.out.split("\n").find((l) => /^\s+gate g\s/.test(l));
    expect(gateLine, withPlugin.out).toMatch(/SubagentStop/);
  });
});
