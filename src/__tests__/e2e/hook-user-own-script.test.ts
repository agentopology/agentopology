/**
 * A hook's `run:` that names a project path (`bash .claude/hooks/x.sh`)
 * scaffolds that file only when it is missing (createOnly): the file is the
 * user's. A hook the user adds by hand that runs the same file is the user's
 * too, in every project-dir spelling: scaffold keeps it and says so. It used
 * to remove it with only "(config merged)", because the path sat with the
 * files the topology writes.
 *
 * A stale entry for a script the topology really writes (the skill's
 * scripts/ folder) is still removed when the .at stops generating it.
 *
 * Each test runs the built CLI against a temporary project.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../../dist/cli/index.js");

function cli(args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status ?? 1 };
  }
}

let tmp: string;
let project: string;
let at: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), "at-user-own-"));
  project = join(tmp, "project");
  fs.mkdirSync(project);
  at = join(tmp, "t.at");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const AT = (hooks: string) => `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "user-own hook scripts"
  }
  agent alpha {
    description: "Alpha"
    model: sonnet
    prompt {
      x
    }
  }
  agent beta {
    model: haiku
    prompt {
      y
    }
  }
  hooks {
${hooks}
  }
  flow {
    alpha -> beta
  }
}
`;
const hook = (name: string, run: string, on = "PreToolUse", matcher: string | null = "Bash") =>
  `    hook ${name} {\n      on: ${on}\n${matcher ? `      matcher: "${matcher}"\n` : ""}      run: "${run}"\n    }`;

const S = ".claude/settings.json";
type Doc = { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type?: string; command?: string }> }>> };
const read = (): Doc => JSON.parse(fs.readFileSync(join(project, S), "utf-8")) as Doc;
const commands = () => Object.values(read().hooks ?? {}).flat().flatMap((g) => g.hooks.map((h) => h.command));
const scaffold = (...extra: string[]) => cli(["scaffold", at, "--target", "claude-code", "--output", project, ...extra]);
const keptLine = (cmd: string) => `! ${S} hooks.Stop: kept a command the .at does not generate: ${cmd}`;
const addStop = (command: string) => {
  const doc = read();
  doc.hooks.Stop = [{ hooks: [{ type: "command", command }] }];
  fs.writeFileSync(join(project, S), JSON.stringify(doc, null, 2) + "\n");
};

describe("a hand-added hook running the user's own file a run: names is kept and said, in every spelling", () => {
  it.each([
    'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh" --canonical',
    'bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/x.sh --report',
  ])("%s", (mine) => {
    fs.writeFileSync(at, AT(hook("guard", "bash .claude/hooks/x.sh --gen")));
    expect(scaffold().code).toBe(0);
    addStop(mine);

    const dry = scaffold("--dry-run");
    const plain = scaffold();
    expect(plain.code, plain.out).toBe(0);
    expect(commands(), "plain run").toContain(mine);
    expect(plain.out).toContain(keptLine(mine));
    expect(dry.out).toContain(keptLine(mine));
    scaffold("--force", "--prune");
    expect(commands(), "--force --prune").toContain(mine);
  });
});

describe("a .at that moves a project-path hook leaves no old entry running", () => {
  it.each([
    ["to another event", "Stop", null],
    ["to another matcher", "PreToolUse", "Write"],
  ] as Array<[string, string, string | null]>)("%s", (_what, on, matcher) => {
    fs.writeFileSync(at, AT(hook("guard", "bash .claude/hooks/x.sh --gen")));
    expect(scaffold().code).toBe(0);
    const generated = commands().find((c) => /x\.sh/.test(c ?? ""))!;
    expect(generated).toBeTruthy();

    fs.writeFileSync(at, AT(hook("guard", "bash .claude/hooks/x.sh --gen", on, matcher)));
    const plain = scaffold();
    expect(plain.code, plain.out).toBe(0);
    const doc = read();
    const places = Object.entries(doc.hooks).flatMap(([event, groups]) =>
      groups.flatMap((g) => g.hooks.filter((h) => /x\.sh/.test(h.command ?? "")).map(() => `${event}/${g.matcher ?? ""}`)),
    );
    expect(places, plain.out).toEqual([`${on}/${matcher ?? ""}`]);
  });
});

describe("a stale entry for a script the topology writes is still removed", () => {
  it.each([
    (g: string) => g,
    (g: string) => g.replace('"$CLAUDE_PROJECT_DIR/', '"$CLAUDE_PROJECT_DIR"/').replace(/\.sh"/, ".sh"),
  ])("spelling %#", (spell) => {
    fs.writeFileSync(at, AT(`${hook("guard", "scripts/guard.sh")}\n${hook("audit", "scripts/audit.sh")}`));
    expect(scaffold().code).toBe(0);
    const generated = commands().find((c) => /guard\.sh/.test(c ?? ""))!;
    expect(generated).toMatch(/\.claude\/skills\/t\/scripts\/guard\.sh/);
    const stale = spell(generated);
    const doc = read();
    for (const g of doc.hooks.PreToolUse) for (const h of g.hooks) if (h.command === generated) h.command = stale;
    fs.writeFileSync(join(project, S), JSON.stringify(doc, null, 2) + "\n");

    fs.writeFileSync(at, AT(hook("audit", "scripts/audit.sh")));
    const plain = scaffold();
    expect(plain.code, plain.out).toBe(0);
    expect(commands().filter((c) => /guard\.sh/.test(c ?? "")), plain.out).toEqual([]);
    expect(plain.out).not.toContain("kept a command");
  });
});
