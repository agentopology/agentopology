/**
 * Scaffold owns exactly the hook entries it wrote, by record.
 *
 * The manifest records every hook entry scaffold writes to the hooks file
 * (.claude/settings.json, .codex/hooks.json) as { event, matcher, command }.
 * On the next run a recorded entry the .at still generates stays, one it no
 * longer generates is removed with a line, and any entry not in the record
 * is the user's: never removed or changed, whatever it runs.
 *
 * Rows, for Claude Code and Codex (one merge serves both):
 *   (a) a hook dropped from the .at: its old entry is removed, with the line;
 *   (b) a hook moved to another matcher with its command edited: the old
 *       entry is removed and the new one written;
 *   (c) a user hook running a createOnly script the .at names: kept, and
 *       said when it equals a generated entry;
 *   (d) a user hook with a generated command under another matcher: kept;
 *   (e) a generated entry the user edited: kept as the user's.
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

beforeEach(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), "at-hook-record-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const TARGETS = ["claude-code", "codex"] as const;
type Target = (typeof TARGETS)[number];
const hooksFile = (target: Target) => (target === "codex" ? ".codex/hooks.json" : ".claude/settings.json");

interface H { id: string; matcher: string; run: string }
const hookText = (h: H) =>
  `    hook ${h.id} {\n      on: PreToolUse\n      matcher: "${h.matcher}"\n      run: ${JSON.stringify(h.run)}\n      type: command\n    }`;

const AT = (target: Target, hooks: H[]) => {
  const model = (m: string) => (target === "codex" ? "gpt-5.2" : m);
  return `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "hook ownership by record"
  }
  agent alpha {
    description: "Alpha"
    model: ${model("sonnet")}
    prompt {
      x
    }
  }
  agent beta {
    model: ${model("haiku")}
    prompt {
      y
    }
  }
${hooks.length ? `  hooks {\n${hooks.map(hookText).join("\n")}\n  }\n` : ""}  flow {
    alpha -> beta
  }
}
`;
};

type Doc = { hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ type?: string; command?: string }> }>> };
interface Row { event: string; matcher: string | null; command: string }

const SCRIPT = "#!/bin/bash\nexit 0\n";
const LINT: H = { id: "lint", matcher: "Bash", run: "bash tools/lint.sh" };
const AUDIT: H = { id: "audit", matcher: "Bash", run: "bash tools/audit.sh" };
/** A hook on a script the .at names as the user's own file (created only when missing). */
const OWN: H = { id: "own", matcher: "Bash", run: "bash .claude/hooks/x.sh" };

/** A project with the user's scripts, and helpers to scaffold it and read its hooks file. */
function project(target: Target, name = "project") {
  const dir = join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const rel of ["tools/lint.sh", "tools/audit.sh", ".claude/hooks/x.sh"]) {
    fs.mkdirSync(dirname(join(dir, rel)), { recursive: true });
    fs.writeFileSync(join(dir, rel), SCRIPT);
  }
  const at = join(tmp, `${name}.at`);
  const HF = join(dir, hooksFile(target));
  const scaffold = (hooks: H[], ...extra: string[]) => {
    fs.writeFileSync(at, AT(target, hooks));
    const r = cli(["scaffold", at, "--target", target, "--output", dir, ...extra]);
    expect(r.code, r.out).toBe(0);
    return r.out;
  };
  const doc = (): Doc => (fs.existsSync(HF) ? (JSON.parse(fs.readFileSync(HF, "utf-8")) as Doc) : {});
  const rows = (): Row[] =>
    Object.entries(doc().hooks ?? {}).flatMap(([event, groups]) =>
      groups.flatMap((g) => g.hooks.map((h) => ({ event, matcher: g.matcher ?? null, command: h.command ?? "" }))),
    );
  const edit = (fn: (d: Doc) => void) => {
    const d = doc();
    fn(d);
    fs.mkdirSync(dirname(HF), { recursive: true });
    fs.writeFileSync(HF, JSON.stringify(d, null, 2) + "\n");
  };
  const addUser = (row: Row) =>
    edit((d) => {
      d.hooks ??= {};
      (d.hooks[row.event] ??= []).push({ ...(row.matcher === null ? {} : { matcher: row.matcher }), hooks: [{ type: "command", command: row.command }] });
    });
  return { dir, scaffold, rows, edit, addUser };
}

/** The entry the .at generates for `h`, as scaffold writes it (scaffolded into a project of its own). */
function generatedRow(target: Target, h: H): Row {
  const p = project(target, `probe-${h.id}-${h.matcher}`);
  p.scaffold([h]);
  const word = h.run.split(" ").pop()!.replace(/^.*\//, "");
  const row = p.rows().find((r) => r.command.includes(word));
  expect(row, JSON.stringify(p.rows())).toBeTruthy();
  return row!;
}

const removedLine = (r: Row) => `- removed generated hook ${r.event} ${r.matcher ?? "(no matcher)"} ${r.command}`;
const has = (rows: Row[], r: Row) => rows.some((x) => x.event === r.event && x.matcher === r.matcher && x.command === r.command);

describe("scaffold owns exactly the hook entries it recorded", () => {
  for (const target of TARGETS) {
    it(`${target} (a): a hook dropped from the .at is removed, with a line naming it`, () => {
      const lint = generatedRow(target, LINT);
      const audit = generatedRow(target, AUDIT);
      const p = project(target);
      p.scaffold([LINT, AUDIT]);
      expect(has(p.rows(), lint)).toBe(true);
      const out = p.scaffold([AUDIT]);
      expect(has(p.rows(), lint), JSON.stringify(p.rows())).toBe(false);
      expect(has(p.rows(), audit)).toBe(true);
      expect(out).toContain(removedLine(lint));
      // A rerun has nothing left to remove.
      expect(p.scaffold([AUDIT])).not.toContain("removed generated hook");
    });

    it(`${target} (a): the .at's last hook dropped is removed too, with a line`, () => {
      const lint = generatedRow(target, LINT);
      const p = project(target);
      p.scaffold([LINT]);
      // A key of the user's keeps the file from being scaffold's whole.
      p.edit((d) => Object.assign(d, { mine: true }));
      const out = p.scaffold([]);
      expect(has(p.rows(), lint), JSON.stringify(p.rows())).toBe(false);
      expect(out).toContain(removedLine(lint));
    });

    it(`${target} (b): a hook moved to another matcher with its command edited: old entry removed, new one written`, () => {
      const moved: H = { id: "lint", matcher: "Edit", run: "bash tools/lint.sh --strict" };
      const before = generatedRow(target, LINT);
      const after = generatedRow(target, moved);
      const p = project(target);
      p.scaffold([LINT, AUDIT]);
      const out = p.scaffold([moved, AUDIT]);
      expect(has(p.rows(), before), JSON.stringify(p.rows())).toBe(false);
      expect(has(p.rows(), after), JSON.stringify(p.rows())).toBe(true);
      expect(p.rows().filter((r) => r.command.includes("lint.sh"))).toHaveLength(1);
      expect(out).toContain(removedLine(before));
    });

    it(`${target} (c): a user hook running a createOnly script the .at names is kept, also when the .at drops its hook`, () => {
      const own = generatedRow(target, OWN);
      const p = project(target);
      p.scaffold([OWN, AUDIT]);
      const mine: Row = { event: "PreToolUse", matcher: "Write", command: own.command };
      const mineToo: Row = { event: "PreToolUse", matcher: "Bash", command: "bash .claude/hooks/x.sh --mine" };
      p.addUser(mine);
      p.addUser(mineToo);
      p.scaffold([OWN, AUDIT]);
      expect(has(p.rows(), mine)).toBe(true);
      expect(has(p.rows(), mineToo)).toBe(true);
      const out = p.scaffold([AUDIT]);
      expect(has(p.rows(), mine), JSON.stringify(p.rows())).toBe(true);
      expect(has(p.rows(), mineToo), JSON.stringify(p.rows())).toBe(true);
      expect(has(p.rows(), own)).toBe(false);
      expect(out).toContain(removedLine(own));
      expect(out).not.toContain(removedLine(mine));
      expect(out).not.toContain(removedLine(mineToo));
    });

    it(`${target} (c): a user hook equal to the generated one, added after the first scaffold, is kept, said, and never removed`, () => {
      const own = generatedRow(target, OWN);
      const p = project(target);
      p.scaffold([AUDIT]);
      p.addUser(own);
      const first = p.scaffold([OWN, AUDIT]);
      expect(p.rows().filter((r) => r.command === own.command)).toHaveLength(1);
      expect(first).toContain(`kept your hook ${own.matcher} ${own.command}: scaffold did not write it`);
      const second = p.scaffold([OWN, AUDIT]);
      expect(second).toContain(`kept your hook ${own.matcher} ${own.command}: scaffold did not write it`);
      const dropped = p.scaffold([AUDIT]);
      expect(has(p.rows(), own), JSON.stringify(p.rows())).toBe(true);
      expect(dropped).not.toContain("removed generated hook");
    });

    it(`${target} (d): a user hook with a generated command under another matcher is kept`, () => {
      const lint = generatedRow(target, LINT);
      const p = project(target);
      const mine: Row = { event: "PreToolUse", matcher: "Edit", command: lint.command };
      p.scaffold([AUDIT]);
      p.addUser(mine);
      p.scaffold([LINT, AUDIT]);
      expect(has(p.rows(), mine), JSON.stringify(p.rows())).toBe(true);
      expect(has(p.rows(), lint)).toBe(true);
      p.scaffold([LINT, AUDIT]);
      expect(has(p.rows(), mine)).toBe(true);
      const out = p.scaffold([AUDIT]);
      expect(has(p.rows(), mine), JSON.stringify(p.rows())).toBe(true);
      expect(has(p.rows(), lint)).toBe(false);
      expect(out).toContain(removedLine(lint));
    });

    it(`${target} (e): a generated entry the user edited is the user's: kept, and said`, () => {
      const lint = generatedRow(target, LINT);
      const p = project(target);
      p.scaffold([LINT, AUDIT]);
      const edited: Row = { ...lint, command: `${lint.command} --mine` };
      p.edit((d) => {
        for (const g of d.hooks!.PreToolUse) for (const h of g.hooks) if (h.command === lint.command) h.command = edited.command;
      });
      const same = p.scaffold([LINT, AUDIT]);
      expect(has(p.rows(), edited), JSON.stringify(p.rows())).toBe(true);
      // The .at's original is not written again beside the user's copy (ruled P).
      expect(has(p.rows(), lint), JSON.stringify(p.rows())).toBe(false);
      const keptLine = `kept your edited copy of ${lint.event} ${lint.matcher}; the generated hook is not added again; delete your copy to get it back`;
      expect(same).toContain(keptLine);
      expect(same).not.toContain("removed generated hook");
      // And not on a later run either.
      expect(p.scaffold([LINT, AUDIT])).toContain(keptLine);
      expect(has(p.rows(), lint), JSON.stringify(p.rows())).toBe(false);
      if (target === "claude-code") {
        // guard --check reads the hook on the user's edited copy (by its
        // script), so the copy is the declared hook's entry, not an untied one.
        const at = join(tmp, "project.at");
        const check = cli(["guard", at, "--check", "--dir", p.dir]);
        expect(check.code, check.out).toBe(0);
        expect(check.out).not.toContain("not tied to any step");
      }
      // Deleting the copy brings the generated hook back.
      p.edit((d) => {
        for (const g of d.hooks!.PreToolUse) g.hooks = g.hooks.filter((h) => h.command !== edited.command);
        d.hooks!.PreToolUse = d.hooks!.PreToolUse.filter((g) => g.hooks.length > 0);
      });
      p.scaffold([LINT, AUDIT]);
      expect(has(p.rows(), lint), JSON.stringify(p.rows())).toBe(true);
      p.edit((d) => {
        for (const g of d.hooks!.PreToolUse) for (const h of g.hooks) if (h.command === lint.command) h.command = edited.command;
      });
      p.scaffold([LINT, AUDIT]);
      const dropped = p.scaffold([AUDIT]);
      expect(has(p.rows(), edited), JSON.stringify(p.rows())).toBe(true);
      expect(dropped).not.toContain(removedLine(edited));
    });
  }
});

describe("a run with no hook record merges as 0.12.6 did, then records what it wrote", () => {
  for (const target of TARGETS) {
    it(`${target}: a hand-built hook in another spelling, no manifest: one entry (0.12.6's), then the topology's`, () => {
      const lint = generatedRow(target, LINT);
      const p = project(target);
      const handBuilt: Row = { event: "PreToolUse", matcher: "Bash", command: "./tools/lint.sh" };
      p.addUser(handBuilt);
      const first = p.scaffold([{ ...LINT, run: "tools/lint.sh" }, AUDIT]);
      expect(first).not.toContain("kept your hook");
      const lints = () => p.rows().filter((r) => r.command.includes("lint.sh"));
      expect(lints(), JSON.stringify(p.rows())).toHaveLength(1);
      // From then on the entry is the topology's: dropping the hook removes it, with the line.
      const dropped = p.scaffold([AUDIT]);
      expect(lints(), JSON.stringify(p.rows())).toHaveLength(0);
      expect(dropped).toContain("- removed generated hook PreToolUse Bash");
      void lint;
    });
  }

  it("claude-code: two .at hooks on one script with different if: merged as 0.12.6 merged them, and the record holds what was written", () => {
    const p = project("claude-code");
    const two = [
      { id: "g1", matcher: "Bash", run: "bash tools/lint.sh" },
      { id: "g2", matcher: "Bash", run: "bash tools/lint.sh" },
    ];
    const withIf = (hs: H[]) => hs.map((h, i) => ({ ...h, run: h.run, _if: i === 0 ? "Bash(rm *)" : "Bash(git push *)" }));
    const at = join(tmp, "project.at");
    const src = AT("claude-code", []).replace(
      "  flow {",
      `  hooks {\n${withIf(two)
        .map((h) => hookText(h).replace("      type: command\n", `      type: command\n      if: ${JSON.stringify(h._if)}\n`))
        .join("\n")}\n  }\n  flow {`,
    );
    const run = () => {
      fs.writeFileSync(at, src);
      const r = cli(["scaffold", at, "--target", "claude-code", "--output", p.dir]);
      expect(r.code, r.out).toBe(0);
      return r.out;
    };
    run();
    const second = run();
    // 0.12.6: the second run keeps one entry for the two hooks (one matcher, one command).
    expect(p.rows().filter((r) => r.command.includes("lint.sh")), JSON.stringify(p.rows())).toHaveLength(1);
    expect(second).not.toContain("removed generated hook");
    const manifest = JSON.parse(fs.readFileSync(join(p.dir, ".claude/.scaffold-manifest.json"), "utf-8")) as { hooks?: Record<string, Row[]> };
    expect((manifest.hooks?.[".claude/settings.json"] ?? []).filter((r) => r.command.includes("lint.sh"))).toHaveLength(1);
    // A third run changes nothing.
    const before = JSON.stringify(p.rows());
    run();
    expect(JSON.stringify(p.rows())).toBe(before);
  });
});
