/**
 * The import invariant (ruled, B): import → scaffold never replaces a command
 * that ran in the source harness with a stub, unless import reported an
 * error for that hook.
 *
 * Measured on rc4: four hand-built guards 0.11.2 could not import
 * (`python3 -u ...`, `bash -c ...`, `powershell -File ...`, `bun run ...`)
 * imported and scaffolded with exit 0, each compiled by 0.11.2's resolution
 * to a stub named after its interpreter, which exits 1 and does not block.
 *
 * For every source command (the rt corpus, every hook run of the 0.11.2 run
 * corpus, Fable's shapes): import a harness holding it; if import reported no
 * error, scaffold and check that the hook's command does not run a generated
 * stub (a file with the STUB marker that scaffold writes, not the user's own
 * file kept at its path).
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { importClaudeCodeWithReport } from "../../import/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { STUB_MARKER } from "../../bindings/lib/stub.js";
import type { PlatformFile } from "../../sync/index.js";
// @ts-expect-error plain JavaScript module
import { RT_COMMANDS } from "./differential/fable-sequences.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const runs = JSON.parse(fs.readFileSync(join(here, "differential/runs-0112.json"), "utf-8")) as { rows: Array<{ kind: string; run: string | null; source: string }> };

/** Fable's final-pass detector shapes (det0), as the harness wrote them. */
const DET0 = ["./bin/guard","bin/guard --x","./node_modules/.bin/tool --check","node_modules/.bin/tool","tools/guard.pl","./tools/guard.py","tools/guard.py --strict",".venv/bin/ruff check .","./vendor/bin/phpstan analyse","tools/guard.sh","./tools/guard.sh --a b","tools/guard.sh 2>/dev/null","tools/guard.sh || exit 2",".claude/hooks/guard.sh","sh tools/guard.sh","bash ./tools/guard.sh --a","python3 tools/guard.py","perl tools/guard.pl","node bin/guard-node","python3 tools/guard.py 2>/dev/null","/bin/sh tools/guard.sh","/usr/bin/python3 tools/guard.py","/usr/bin/env python3 tools/guard.py","/bin/false","/usr/bin/test -f nosuch","cat ./tools/data.json","touch ./marker-new","tools/guard.sh tools/data.json","nice tools/guard.sh","exec tools/guard.sh",". tools/exit2.sh","source tools/exit2.sh","grep -q x ./tools/data.json","wc ./tools/data.json","cp ./tools/data.json ./tools/copy.json","ls ./tools","exit 2","true","false","echo hi","test -f ./tools/guard.sh","[ -f tools/nosuch ]",": noop","printf x","prettier --write .","jq -r .x","npm run lint","npx eslint .","make lint","git diff --quiet","python3 -m json.tool tools/data.json","bash -c true","cd tools && ./guard.sh","env FOO=1 tools/guard.sh","timeout 5 tools/guard.sh","uv run tools/guard.py","bun run tools/x.ts","if true; then exit 2; fi","FOO=1 tools/guard.sh","guard","guard.sh","scripts/guard.sh","python3 scripts/guard.py"];

const CORPUS: string[] = [...new Set<string>([
  ...(RT_COMMANDS as string[]),
  ...DET0,
  ...runs.rows.filter((r) => r.kind === "hook" && typeof r.run === "string").map((r) => r.run as string),
])];

const harness = (command: string): PlatformFile[] => [
  { path: ".claude/agents/a.md", content: "---\nname: a\ndescription: An agent\n---\n\nBody.\n" } as PlatformFile,
  { path: ".claude/settings.json", content: JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] } }) } as PlatformFile,
];

/** Whether scaffolding this .at source runs a generated stub in place of a hook command; with what it found. */
export function stubbedHooks(source: string): string[] {
  const ast = parse(source);
  const files = claudeCodeBinding.scaffold(ast);
  const settings = files.find((f) => f.path === ".claude/settings.json");
  const commands: string[] = settings
    ? Object.values(JSON.parse(settings.content).hooks ?? {}).flat().flatMap((g: any) => (g.hooks ?? []).map((h: any) => String(h.command ?? "")))
    : [];
  const stubs = files.filter((f) => !f.createOnly && String(f.content).includes(STUB_MARKER)).map((f) => f.path.replace(/^\.\//, ""));
  const out: string[] = [];
  for (const c of commands) for (const s of stubs) if (c.includes(`$CLAUDE_PROJECT_DIR/${s}`) || c.split(/\s+/).includes(s)) out.push(`${c}  runs stub ${s}`);
  return out;
}

/** The hooks import reported an error for (FlowReport.errors). */
const errorsOf = (report: object): Array<{ hook: string; message: string }> => (report as { errors?: Array<{ hook: string; message: string }> }).errors ?? [];

/** Import one command; null when import reported an error for it, else what scaffold stubs. */
function importThenScaffold(command: string): { id: string; stubbed: string[] } | null {
  let r: ReturnType<typeof importClaudeCodeWithReport>;
  try {
    r = importClaudeCodeWithReport(harness(command), "t");
  } catch {
    return null;
  }
  if (errorsOf(r.report).length > 0) return null;
  let ast;
  try {
    ast = parse(r.source);
  } catch {
    return null; // import exits 2 on a .at that does not parse (S-68)
  }
  if (validate(ast).some((x) => x.level === "error")) return null; // import exits 2 (S-68)
  return { id: ast.hooks.map((h) => h.name).join(","), stubbed: stubbedHooks(r.source) };
}

describe("[I-0113] import → scaffold never stubs a command that ran, unless import reported an error", () => {
  it(`holds over ${CORPUS.length} source commands`, () => {
    const violations: string[] = [];
    for (const command of CORPUS) {
      const r = importThenScaffold(command);
      if (r && r.stubbed.length) violations.push(`${JSON.stringify(command)} -> hook ${r.id}: ${r.stubbed.join("; ")}`);
    }
    expect(violations, `${violations.length} commands import without an error and scaffold to a stub:\n${violations.slice(0, 40).join("\n")}`).toEqual([]);
  }, 300_000);

  it("names the ruled shapes with the ruled error text", () => {
    for (const command of [
      "python -c 'import sys'", "python3 -m mypkg.guard",
      "bash -c 'exit 2'", "sh -c 'exit 2'", "zsh -c 'exit 2'", "node -e '1'", "node -r ts-node/register x.ts",
      'bun run "$CLAUDE_PROJECT_DIR/x.ts"', "deno run x.ts", 'powershell -File "$CLAUDE_PROJECT_DIR/x.ps1"', "pwsh -Command Get-Date",
    ]) {
      const { report } = importClaudeCodeWithReport(harness(command), "t");
      expect(errorsOf(report), command).toHaveLength(1);
      expect(errorsOf(report)[0].message, command).toContain("this hook can't be compiled faithfully; keep it as a hand-written hook or rewrite it as a topology script");
    }
  });

  it("an interpreter's flags before a project script compile faithfully: no error, no stub", () => {
    // These were ruled shapes while a flag after the interpreter named a stub after the interpreter.
    for (const command of ['python3 -u "$CLAUDE_PROJECT_DIR/tools/guard.py"', "node --x tools/a.mjs"]) {
      const r = importThenScaffold(command);
      expect(r, command).not.toBeNull();
      expect(r!.stubbed, command).toEqual([]);
    }
  });

  it("[canary] the invariant catches a shape no detector lists: a .at written by hand, not imported", () => {
    // `ruby -e` is in no list; written straight into a .at (no import, so no detector), 0.11.2's resolution stubs `ruby`.
    const source = [
      "topology t : [pipeline] {", "  meta {", '    version: "1.0.0"', "  }",
      "  hooks {", "    hook g {", "      on: PreToolUse", '      matcher: "Bash"', `      run: ${JSON.stringify("ruby -e 'exit 2'")}`, "      type: command", "    }", "  }",
      "}",
    ].join("\n");
    expect(stubbedHooks(source)).toEqual([expect.stringContaining("runs stub .claude/skills/t/scripts/ruby")]);
    // ... and import reports it, so the invariant holds for it end to end.
    expect(importThenScaffold("ruby -e 'exit 2'")).toBeNull();
  });
});
