/**
 * Two .at files scaffolded into one folder: whose hooks are whose.
 *
 * Each .at has its own manifest, and scaffold changes only the hook entries
 * its own manifest records, so another .at's hooks stay (two topologies
 * coexist; scaffold's output is as before). `validate --dir` and
 * `guard --check` say so: one line per other .at whose manifest records
 * entries the hooks file holds. `validate --dir` also warns when two .at
 * files the folder's manifests name declare one topology.
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
    const out = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status ?? 1 };
  }
}

let tmp: string;
let project: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), "at-other-records-"));
  project = join(tmp, "project");
  fs.mkdirSync(join(project, "tools"), { recursive: true });
  for (const s of ["lint.sh", "audit.sh"]) fs.writeFileSync(join(project, "tools", s), "#!/bin/bash\nexit 0\n");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const hook = (id: string, script: string) =>
  `    hook ${id} {\n      on: PreToolUse\n      matcher: "Bash"\n      run: "bash tools/${script}"\n      type: command\n    }`;
const AT = (name: string, hooks: string[]) => `topology ${name} : [pipeline] {
  meta {
    version: "1.0.0"
    description: "two in one folder"
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
${hooks.join("\n")}
  }
  flow {
    alpha -> beta
  }
}
`;

const LINT = hook("lint", "lint.sh");
const AUDIT = hook("audit", "audit.sh");
const LINT_CMD = 'bash "$CLAUDE_PROJECT_DIR/tools/lint.sh"';
const KEPT_A = "kept: 1 hook(s) in settings.json are recorded by a.at's manifest; scaffold that .at to change them";

function write(file: string, text: string): string {
  const p = join(tmp, file);
  fs.writeFileSync(p, text);
  return p;
}
function scaffold(at: string): string {
  const r = cli(["scaffold", at, "--target", "claude-code", "--output", project]);
  expect(r.code, r.out).toBe(0);
  return r.out;
}
const commands = () =>
  Object.values((JSON.parse(fs.readFileSync(join(project, ".claude/settings.json"), "utf-8")) as { hooks?: Record<string, Array<{ hooks: Array<{ command?: string }> }>> }).hooks ?? {})
    .flat()
    .flatMap((g) => g.hooks.map((h) => h.command));

describe("another .at's recorded hooks are kept, and validate --dir and guard --check name them", () => {
  it("a.at then b.at: b.at's scaffold keeps a.at's hook and prints nothing new; validate --dir and guard --check name a.at", () => {
    const a = write("a.at", AT("ta", [LINT]));
    const b = write("b.at", AT("tb", [AUDIT]));
    scaffold(a);
    const out = scaffold(b);
    expect(commands()).toContain(LINT_CMD);
    // Scaffold's output is as before.
    expect(out).not.toContain("kept:");
    expect(out).not.toContain("recorded by");

    const v = cli(["validate", b, "--dir", project]);
    expect(v.out).toContain(KEPT_A);
    const g = cli(["guard", b, "--check", "--dir", project]);
    expect(g.out).toContain(KEPT_A);
    // From a.at, its own record is not another's; b.at's is.
    const fromA = cli(["validate", a, "--dir", project]).out;
    expect(fromA).not.toContain("recorded by a.at");
    expect(fromA).toContain("kept: 1 hook(s) in settings.json are recorded by b.at's manifest; scaffold that .at to change them");
  });

  it("an entry two manifests record stays when one .at drops its hook, with a line naming the other .at", () => {
    const a = write("a.at", AT("ta", [LINT]));
    scaffold(a);
    const b = write("b.at", AT("tb", [AUDIT]));
    scaffold(b);
    // b.at's manifest as 0.12.x left it (no hook record): its next run merges
    // as 0.12.6 did and records the lint entry a.at wrote as its own too.
    const bm = join(project, ".claude/.scaffold-manifest.b.at.json");
    const m = JSON.parse(fs.readFileSync(bm, "utf-8")) as Record<string, unknown>;
    delete m.hooks;
    fs.writeFileSync(bm, JSON.stringify(m, null, 2) + "\n");
    write("b.at", AT("tb", [LINT, AUDIT]));
    scaffold(b);
    const recorded = (p: string) =>
      ((JSON.parse(fs.readFileSync(p, "utf-8")) as { hooks?: Record<string, Array<{ command: string }>> }).hooks?.[".claude/settings.json"] ?? []).map((r) => r.command);
    expect(recorded(bm)).toContain(LINT_CMD);
    expect(recorded(join(project, ".claude/.scaffold-manifest.json"))).toContain(LINT_CMD);
    // b.at drops lint: a.at still records the entry, so it stays.
    write("b.at", AT("tb", [AUDIT]));
    const out = scaffold(b);
    expect(commands(), out).toContain(LINT_CMD);
    expect(out).not.toContain("removed generated hook");
    expect(out).toContain(`kept generated hook PreToolUse Bash ${LINT_CMD} for a.at: its manifest still records it`);
    // No longer b.at's; still a.at's.
    expect(recorded(bm)).not.toContain(LINT_CMD);
    expect(recorded(join(project, ".claude/.scaffold-manifest.json"))).toContain(LINT_CMD);
    // a.at dropping it then removes it.
    write("a.at", AT("ta", [AUDIT]));
    const fromA = scaffold(a);
    expect(commands()).not.toContain(LINT_CMD);
    expect(fromA).toContain(`- removed generated hook PreToolUse Bash ${LINT_CMD}`);
  });

  it("nothing is said when the other .at's hooks are no longer in the file", () => {
    const a = write("a.at", AT("ta", [LINT]));
    const b = write("b.at", AT("tb", [AUDIT]));
    scaffold(a);
    scaffold(b);
    const doc = JSON.parse(fs.readFileSync(join(project, ".claude/settings.json"), "utf-8")) as { hooks: Record<string, Array<{ hooks: Array<{ command?: string }> }>> };
    doc.hooks.PreToolUse = doc.hooks.PreToolUse.filter((grp) => !grp.hooks.some((h) => h.command === LINT_CMD));
    fs.writeFileSync(join(project, ".claude/settings.json"), JSON.stringify(doc, null, 2) + "\n");
    expect(cli(["validate", b, "--dir", project]).out).not.toContain("kept:");
  });
});

describe("two .at files that declare one topology", () => {
  it("validate --dir warns, naming both; scaffold's output is as before", () => {
    const a = write("a.at", AT("t", [LINT, AUDIT]));
    scaffold(a);
    const b = write("b.at", AT("t", [AUDIT]));
    const out = scaffold(b);
    expect(out).not.toContain("two .at files");
    const warning = "two .at files declare topology t: a.at, b.at";
    expect(cli(["validate", b, "--dir", project]).out).toContain(warning);
    expect(cli(["validate", a, "--dir", project]).out).toContain(warning);
    // Not without a copy: a.at's topology renamed.
    write("a.at", AT("other", [LINT, AUDIT]));
    expect(cli(["validate", b, "--dir", project]).out).not.toContain("two .at files");
  });
});
