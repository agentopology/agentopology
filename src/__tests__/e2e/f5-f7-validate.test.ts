/**
 * F5: since S-13 only a top-level `env { }` is the topology env, so the keys of
 * an `env { }` inside `settings { }` are no longer written to settings.json.
 * Measured on 84bb938: they were dropped and validate said nothing.
 *
 * F7: a hook whose script path holds a space or a quote passed validate, and
 * scaffold then refused ("not safe file names"), after import had said the
 * .at passed. validate now names it, so import reports it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../../dist/cli/index.js");

const at = (extra: string) => [
  "topology t : [pipeline] {",
  "  meta {", '    version: "1.0.0"', '    description: "t"', "  }",
  "  orchestrator {", "    model: sonnet", "  }",
  "  agent a {", "    model: sonnet", '    description: "a"', "  }",
  "  agent b {", "    model: sonnet", '    description: "b"', "  }",
  "  flow { a -> b }",
  extra,
  "}",
].join("\n");
const hook = (run: string) => `  hooks {\n    hook h {\n      on: PreToolUse\n      matcher: "Bash"\n      run: ${JSON.stringify(run)}\n      type: command\n    }\n  }`;

describe("F5: an env block inside settings warns", () => {
  it("[F-5] names the keys that are not written to settings.json", () => {
    const r = validate(parse(at('  settings {\n    deny: ["Bash(rm -rf *)"]\n    env {\n      FOO: "bar"\n      BAZ: "q"\n    }\n  }')));
    const w = r.filter((x) => /settings/.test(x.message) && /env/.test(x.message));
    expect(w).toHaveLength(1);
    expect(w[0].level).toBe("warning");
    expect(w[0].message).toContain("FOO, BAZ");
  });

  it("[F-5] a top-level env, or none, does not warn", () => {
    expect(validate(parse(at('  env {\n    FOO: "bar"\n  }\n  settings {\n    deny: ["Bash(rm -rf *)"]\n  }'))).filter((x) => /env/.test(x.message))).toEqual([]);
  });
});

describe("F7: a hook script path with a space is named by validate, not refused later by scaffold", () => {
  it("[F-7] validate errors on it", () => {
    const r = validate(parse(at(hook('bash "$CLAUDE_PROJECT_DIR/.claude/hooks/my guard.sh" --flag "a b"'))));
    expect(r.some((x) => x.level === "error" && x.rule === "V96" && /safe|space/.test(x.message))).toBe(true);
  });

  it("[F-7] a path with no space still passes", () => {
    const r = validate(parse(at(hook("bash .claude/hooks/guard.sh --flag a"))));
    expect(r.filter((x) => x.level === "error")).toEqual([]);
  });

  it("[F-7] an agent hook bash \"$CLAUDE_PROJECT_DIR\"/x.sh validates and scaffolds as in 0.11.2", () => {
    const run = 'bash "$CLAUDE_PROJECT_DIR"/x.sh';
    const src = at(`  agent c {\n    model: sonnet\n    description: "c"\n    invocation: manual\n    hooks {\n      hook ah {\n        on: PreToolUse\n        matcher: "Bash"\n        run: ${JSON.stringify(run)}\n        type: command\n      }\n    }\n  }`);
    const ast = parse(src);
    expect(validate(ast).filter((x) => x.level === "error")).toEqual([]);
    const agent = claudeCodeBinding.scaffold(ast).find((f) => f.path === ".claude/agents/c/AGENT.md")!;
    // 0.11.2's output for this run (differential/runs-0112.json): the skill's own a-x.sh, by bash
    expect(agent.content).toContain('command: "bash \\"$CLAUDE_PROJECT_DIR/.claude/skills/t/scripts/c-x.sh\\""');
  });

  it("[P-2] a redirect right after the first word: V96 names the command, not the redirect", () => {
    const r = validate(parse(at(hook("lintme 2>/dev/null || true")))).filter((x) => x.rule === "V96");
    expect(r).toHaveLength(1);
    expect(r[0].message).toContain('"lintme"');
    expect(r[0].message).not.toMatch(/its script path "2>\/dev\/null"/);
  });

  describe("import reports it", () => {
    let root: string;
    beforeEach(() => {
      root = fs.mkdtempSync(join(os.tmpdir(), "at-f7-"));
      fs.mkdirSync(join(root, ".claude/agents"), { recursive: true });
      fs.mkdirSync(join(root, ".claude/hooks"), { recursive: true });
      fs.writeFileSync(join(root, ".claude/agents/a.md"), "---\nname: a\ndescription: An agent\n---\n\nBody.\n");
      fs.writeFileSync(join(root, ".claude/hooks/my guard.sh"), "#!/bin/bash\nexit 0\n");
      fs.writeFileSync(join(root, ".claude/settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/my guard.sh"' }] }] } }));
    });
    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    it("[F-7] import exits 2 and names the validation error", () => {
      const r = spawnSync(process.execPath, [CLI, "import", "--target", "claude-code", "--dir", ".", "--name", "t"], { cwd: root, encoding: "utf8" });
      expect(r.status).toBe(2);
      expect(`${r.stdout}${r.stderr}`).toContain("validation error(s)");
    });
  });
});
