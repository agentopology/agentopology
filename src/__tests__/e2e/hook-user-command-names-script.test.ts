/**
 * A user's own hook command that names one of the topology's scripts is the
 * user's, whatever its first word is: `bash ./wrap.sh <script>`,
 * `STRICT=1 ./env.sh <script>`, `node tools/audit.js <script>`,
 * `cat <script> | ./audit.sh`. Scaffold keeps it and says so on every run
 * (plain, again, --force, --force --prune), for both the Claude Code
 * settings file and the Codex hooks file, whether the .at stays the same or
 * changes its hooks.
 *
 * A command is the topology's only when it is the command the binding writes
 * for one of its scripts (an edited copy of it included, as in 0.11.x).
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
  tmp = fs.mkdtempSync(join(os.tmpdir(), "at-own-cmd-"));
  project = join(tmp, "project");
  fs.mkdirSync(project);
  at = join(tmp, "t.at");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const TARGETS = ["claude-code", "codex"] as const;
type Target = (typeof TARGETS)[number];
const hooksFile = (target: Target) => (target === "codex" ? ".codex/hooks.json" : ".claude/settings.json");

const AT = (target: Target, hooks: string) => {
  const model = (m: string) => (target === "codex" ? "gpt-5.2" : m);
  return `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "user hook commands"
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
${hooks}
  flow {
    alpha -> beta
  }
}
`;
};
const hook = (name: string, matcher: string, run: string) =>
  `    hook ${name} {\n      on: PreToolUse\n      matcher: "${matcher}"\n      run: "${run}"\n    }`;
const AT_CHANGES: Record<string, string> = {
  "the .at unchanged": `  hooks {\n${hook("guard", "Bash", "scripts/guard.sh")}\n  }`,
  // Another hook stays, so the hooks file is still generated and merged (a
  // .at with no hook left does not write the file at all).
  "the .at drops that hook": `  hooks {\n${hook("audit", "Bash", "scripts/audit.sh")}\n  }`,
  "the .at changes the hook's matcher": `  hooks {\n${hook("guard", "Write", "scripts/guard.sh")}\n  }`,
  "the .at adds a second hook": `  hooks {\n${hook("guard", "Bash", "scripts/guard.sh")}\n${hook("audit", "Bash", "scripts/audit.sh")}\n  }`,
  "the .at renames the hook's script": `  hooks {\n${hook("guard", "Bash", "scripts/guard2.sh")}\n  }`,
};

/** A user's own command, given the path of the topology's guard script. */
const USER_COMMANDS: Record<string, (script: string) => string> = {
  "an interpreter running the user's wrapper": (p) => `bash ./my-wrap.sh ${p}`,
  "an env assignment before the user's program": (p) => `STRICT=1 ./my-env.sh ${p}`,
  "an interpreter with the user's tool by a bare path": (p) => `node tools/my-audit.js ${p}`,
  "a pipeline reading the script": (p) => `cat ${p} | ./my-audit.sh`,
};

type Doc = { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command?: string }> }>> };

describe("a user's own hook command that names a topology script is kept and said, whatever its first word", () => {
  for (const target of TARGETS) {
    const HF = hooksFile(target);
    const scaffold = (...extra: string[]) => cli(["scaffold", at, "--target", target, "--output", project, ...extra]);
    const read = () => fs.readFileSync(join(project, HF), "utf-8");
    const commands = () => Object.values((JSON.parse(read()) as Doc).hooks ?? {}).flat().flatMap((g) => g.hooks.map((h) => h.command));
    const keptLine = (cmd: string) => `! ${HF} hooks.Stop: kept a command the .at does not generate: ${cmd}`;

    for (const [what, make] of Object.entries(USER_COMMANDS)) {
      for (const [change, hooks] of Object.entries(AT_CHANGES)) {
        it(`${target}: ${what}, ${change}`, () => {
          fs.writeFileSync(at, AT(target, AT_CHANGES["the .at unchanged"]));
          expect(scaffold().code).toBe(0);
          const doc = JSON.parse(read()) as Doc;
          const generated = JSON.stringify(doc.hooks);
          const script = (/(\.(?:codex|claude)\/[^\s"'\\]*guard\.sh)/.exec(generated) ?? [])[1];
          expect(script, generated).toBeTruthy();
          const mine = make(script!);
          doc.hooks.Stop = [{ hooks: [{ type: "command", command: mine } as { command: string }] }];
          fs.writeFileSync(join(project, HF), JSON.stringify(doc, null, 2) + "\n");
          fs.writeFileSync(at, AT(target, hooks));

          const dry = scaffold("--dry-run");
          const plain = scaffold();
          expect(plain.code, plain.out).toBe(0);
          expect(commands(), "plain run").toContain(mine);
          expect(plain.out).toContain(keptLine(mine));
          expect(dry.out).toContain(keptLine(mine));

          scaffold();
          expect(commands(), "second plain run").toContain(mine);
          scaffold("--force");
          expect(commands(), "--force").toContain(mine);
          scaffold("--force", "--prune");
          expect(commands(), "--force --prune").toContain(mine);
        });
      }
    }
  }
});

describe("a command that starts with a program of the user's own, written ./name, stays the user's (as in 0.12.0)", () => {
  for (const target of TARGETS) {
    const HF = hooksFile(target);
    const scaffold = (...extra: string[]) => cli(["scaffold", at, "--target", target, "--output", project, ...extra]);
    const read = () => fs.readFileSync(join(project, HF), "utf-8");
    const commands = () => Object.values((JSON.parse(read()) as Doc).hooks ?? {}).flat().flatMap((g) => g.hooks.map((h) => h.command));
    const keptLine = (cmd: string) => `! ${HF} hooks.Stop: kept a command the .at does not generate: ${cmd}`;

    for (const [what, make] of Object.entries({
      "./name and then the generated command": (g: string) => `./my-pre.sh && ${g}`,
      "./name; the generated command": (g: string) => `./my-pre.sh; ${g}`,
      "./name with arguments, then the generated command": (g: string) => `./my-pre.sh --arg x && ${g}`,
      "$CLAUDE_PROJECT_DIR/name, then the generated command": (g: string) => `$CLAUDE_PROJECT_DIR/my-pre.sh && ${g}`,
      "./name running an interpreter on the script": (_g: string, p: string) => `./my-time.sh bash ${p}`,
    } as Record<string, (g: string, p: string) => string>)) {
      it(`${target}: ${what}`, () => {
        fs.writeFileSync(at, AT(target, AT_CHANGES["the .at unchanged"]));
        expect(scaffold().code).toBe(0);
        const doc = JSON.parse(read()) as Doc;
        const entry = Object.values(doc.hooks).flat().flatMap((g) => g.hooks).find((h) => /guard\.sh/.test(h.command ?? ""))!;
        const script = (/(\.(?:codex|claude)\/[^\s"'\\]*guard\.sh)/.exec(entry.command!) ?? [])[1]!;
        const mine = make(entry.command!, script);
        doc.hooks.Stop = [{ hooks: [{ type: "command", command: mine } as { command: string }] }];
        fs.writeFileSync(join(project, HF), JSON.stringify(doc, null, 2) + "\n");

        const plain = scaffold();
        expect(plain.code, plain.out).toBe(0);
        expect(commands(), "plain run").toContain(mine);
        expect(plain.out).toContain(keptLine(mine));
        scaffold("--force", "--prune");
        expect(commands(), "--force --prune").toContain(mine);
      });
    }
  }
});

describe("an edited copy of the generated command is still the topology's, as in 0.11.x", () => {
  for (const target of TARGETS) {
    const HF = hooksFile(target);
    const scaffold = (...extra: string[]) => cli(["scaffold", at, "--target", target, "--output", project, ...extra]);
    const read = () => fs.readFileSync(join(project, HF), "utf-8");
    const commands = () => Object.values((JSON.parse(read()) as Doc).hooks ?? {}).flat().flatMap((g) => g.hooks.map((h) => h.command));

    for (const [what, edit] of Object.entries({
      "an argument appended": (g: string) => `${g} --extra`,
      "a command chained after it": (g: string) => `${g} && ./my-extra.sh`,
    })) {
      // Changed for hook ownership by record (approved ruling): an edited copy
      // is the user's. Before: replaced by the new command on the rename.
      it(`${target}: ${what}: the edited copy is the user's, kept; the original is not written again beside it`, () => {
        fs.writeFileSync(at, AT(target, AT_CHANGES["the .at unchanged"]));
        expect(scaffold().code).toBe(0);
        const doc = JSON.parse(read()) as Doc;
        const group = Object.values(doc.hooks).flat().find((g) => g.hooks.some((h) => /guard\.sh/.test(h.command ?? "")))!;
        const entry = group.hooks.find((h) => /guard\.sh/.test(h.command ?? ""))!;
        const original = entry.command!;
        const edited = edit(original);
        entry.command = edited;
        fs.writeFileSync(join(project, HF), JSON.stringify(doc, null, 2) + "\n");

        const same = scaffold();
        expect(same.code, same.out).toBe(0);
        expect(commands()).toContain(edited);
        expect(commands()).not.toContain(original);
        expect(same.out).toContain("kept your edited copy of PreToolUse Bash; the generated hook is not added again; delete your copy to get it back");

        // The .at renames the script: the copy stays the user's; guard2.sh is another hook, written.
        fs.writeFileSync(at, AT(target, AT_CHANGES["the .at renames the hook's script"]));
        const { out, code } = scaffold();
        expect(code, out).toBe(0);
        const now = commands();
        expect(now).toContain(edited);
        expect(now).not.toContain(original);
        expect(now.some((c) => /guard2\.sh/.test(c ?? ""))).toBe(true);
        expect(out).toContain("you edited the entry scaffold wrote");
      });
    }
  }
});
