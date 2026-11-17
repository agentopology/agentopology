/**
 * When the writer cannot apply something safely, it says so.
 *
 * - A scaffolded agent file whose prompt markers the user removed or
 *   altered: the writer does not guess where the prompt is. The body is
 *   kept, the frontmatter is still patched, and the generated sections the
 *   .at changed are named (a CLI line and a drift row).
 * - A hook command in settings.json that the .at does not generate is never
 *   deleted, even when its hook group or the command names one of the
 *   topology's scripts; scaffold names each one it kept.
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

const file = (rel: string) => join(project, rel);
const read = (rel: string) => fs.readFileSync(file(rel), "utf-8");
const put = (rel: string, content: string) => {
  fs.mkdirSync(dirname(file(rel)), { recursive: true });
  fs.writeFileSync(file(rel), content);
};
const writeAt = (text: string) => fs.writeFileSync(at, text);
const scaffold = (...extra: string[]) => cli(["scaffold", at, "--target", "claude-code", "--output", project, ...extra]);
const inventory = () => cli(["validate", at, "--inventory", project]);
const inventoryJson = () => cli(["validate", at, "--inventory", project, "--json"]);
const linesAbout = (out: string, rel: string) => out.split("\n").filter((l) => l.includes(rel)).map((l) => l.trim());

beforeEach(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), "at-says-"));
  project = join(tmp, "project");
  fs.mkdirSync(project);
  at = join(tmp, "t.at");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const AT = (inner: string, extra = "") => `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "says it"
  }
${inner}
  agent beta {
    model: haiku
    prompt {
      Do beta.
    }
  }
${extra}
  flow {
    alpha -> beta
  }
}
`;

// ---------------------------------------------------------------------------
// Prompt markers removed or altered
// ---------------------------------------------------------------------------

describe("a scaffolded agent file whose prompt markers were removed or altered", () => {
  const A = ".claude/agents/alpha/AGENT.md";
  const START = "<!-- agentopology:prompt (edit between these markers; sync copies it into the .at) -->";
  const END = "<!-- /agentopology:prompt -->";
  const U = "USER-TEXT-7731";
  const agent = (extra: string, model = "sonnet") => `
  agent alpha {
    description: "Alpha desc"
    model: ${model}
${extra}
    prompt {
      Generated alpha prompt.
    }
  }
`;
  const V1 = '    reads: ["workspace/in.md"]\n    writes: ["workspace/out.md"]';
  const V2 = '    reads: ["workspace/in.md", "workspace/NEW-INPUT.md"]\n    writes: ["workspace/NEW-OUTPUT.md"]';

  const edits: Record<string, (g: string) => string> = {
    "both markers deleted": (g) => g.replace(START + "\n", "").replace(END + "\n", "").replace("Generated alpha prompt.", `${U} prompt`),
    "end marker deleted": (g) => g.replace(END + "\n", "").replace("Generated alpha prompt.", `${U} prompt`),
    "start marker deleted": (g) => g.replace(START + "\n", "").replace("Generated alpha prompt.", `${U} prompt`),
    "start marker text changed": (g) => g.replace(START, "<!-- agentopology:prompt -->").replace("Generated alpha prompt.", `${U} prompt`),
    "markers swapped": (g) =>
      g.replace(START, "@@S").replace(END, START).replace("@@S", END).replace("Generated alpha prompt.", `${U} prompt`),
  };

  for (const [name, edit] of Object.entries(edits)) {
    it(`${name}: the body is kept, the frontmatter patched, and the stale sections named on the CLI and as a drift row`, () => {
      writeAt(AT(agent(V1)));
      scaffold();
      const mine = edit(read(A));
      put(A, mine);
      writeAt(AT(agent(V2, "haiku")));
      const dry = scaffold("--dry-run");
      const { out } = scaffold();
      const after = read(A);
      expect(after).toContain(U);
      // The frontmatter is the .at's, markers or not.
      expect(after).toMatch(/^model: haiku$/m);
      // The body is never guessed at: the sections stay as the user left them.
      expect(after.slice(after.indexOf("\n---", 3))).toBe(mine.slice(mine.indexOf("\n---", 3)));
      const said = linesAbout(out, A).join("\n");
      expect(said).toContain(`! ${A}: generated sections not refreshed`);
      expect(said).toContain("prompt markers");
      expect(said).toContain("## Reads");
      expect(said).toContain("## Writes");
      // The dry run says the same.
      expect(linesAbout(dry.out, A).filter((l) => l.includes("not refreshed"))).toEqual(
        linesAbout(out, A).filter((l) => l.includes("not refreshed")),
      );
      // Said again on the next run, and listed as drift.
      expect(linesAbout(scaffold().out, A).join("\n")).toContain("not refreshed");
      const inv = inventory();
      expect(inv.code).toBe(3);
      expect(linesAbout(inv.out, A).join("\n")).toContain("not refreshed");
      const rows = JSON.parse(inventoryJson().out).drift as Array<{ path: string; detail?: string }>;
      expect(rows.some((r) => r.path === A && /not refreshed/.test(r.detail ?? ""))).toBe(true);
    });

    it(`${name}, and the .at changes no generated section: no line`, () => {
      writeAt(AT(agent(V1)));
      scaffold();
      put(A, edit(read(A)));
      writeAt(AT(agent(V1, "haiku")));
      const { out } = scaffold();
      expect(read(A)).toMatch(/^model: haiku$/m);
      expect(linesAbout(out, A).filter((l) => l.includes("not refreshed"))).toEqual([]);
      expect(linesAbout(inventory().out, A).filter((l) => l.includes("not refreshed"))).toEqual([]);
    });
  }

  it("a file from an older manifest edited outside the markers, with no section stale: no line on any run", () => {
    writeAt(AT(agent(V1)));
    scaffold();
    put(A, read(A) + `\n${U}\n`);
    // An older manifest: no region hashes.
    const M = ".claude/.scaffold-manifest.json";
    const man = JSON.parse(read(M));
    for (const e of Object.values(man.files) as Array<Record<string, unknown>>) {
      delete e.head;
      delete e.outside;
    }
    put(M, JSON.stringify(man, null, 2));
    for (let i = 0; i < 2; i++) {
      const { out } = scaffold();
      expect(linesAbout(out, A).filter((l) => l.includes("not refreshed"))).toEqual([]);
    }
    expect(read(A)).toContain(U);
  });
});

// ---------------------------------------------------------------------------
// settings.json: a hook command the .at does not generate is never deleted
// ---------------------------------------------------------------------------

describe("a hook command in settings.json the .at does not generate is kept and named", () => {
  const S = ".claude/settings.json";
  const hook = (run: string, matcher = "Bash") => `
  hooks {
    hook guard {
      on: PreToolUse
      matcher: "${matcher}"
      run: "${run}"
    }
  }
`;
  const ALPHA = `
  agent alpha {
    description: "Alpha"
    model: sonnet
    prompt {
      x
    }
  }
`;
  const G = 'bash "$CLAUDE_PROJECT_DIR/.claude/skills/t/scripts/guard.sh"';
  const GNEW = 'bash "$CLAUDE_PROJECT_DIR/.claude/skills/t/scripts/guard2.sh"';
  type Group = { matcher?: string; hooks: Array<{ type: string; command: string }> };
  const settings = () => JSON.parse(read(S)) as { hooks: Record<string, Group[]> };
  const commands = (event: string) => (settings().hooks[event] ?? []).flatMap((g) => g.hooks.map((h) => h.command));
  const keptLine = (event: string, cmd: string) => `! ${S} hooks.${event}: kept a command the .at does not generate: ${cmd}`;
  const J = (o: unknown) => JSON.stringify(o, null, 2) + "\n";

  it("a group the user wrote that also runs the topology's script: the user's command is kept and named", () => {
    writeAt(AT(ALPHA, hook("scripts/guard.sh")));
    put(S, J({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./my-guard.sh" }, { type: "command", command: G }] }] } }));
    const dry = scaffold("--dry-run");
    const { out } = scaffold();
    expect(commands("PreToolUse")).toContain("./my-guard.sh");
    expect(commands("PreToolUse").filter((c) => c === G)).toHaveLength(1);
    expect(out).toContain(keptLine("PreToolUse", "./my-guard.sh"));
    expect(dry.out).toContain(keptLine("PreToolUse", "./my-guard.sh"));
  });

  it("a command appended to a generated group survives a later .at change to that hook", () => {
    writeAt(AT(ALPHA, hook("scripts/guard.sh")));
    scaffold();
    const doc = settings();
    doc.hooks.PreToolUse[0].hooks.push({ type: "command", command: "./my-guard.sh" });
    put(S, J(doc));
    writeAt(AT(ALPHA, hook("scripts/guard2.sh")));
    const { out } = scaffold();
    const now = commands("PreToolUse");
    expect(now).toContain("./my-guard.sh");
    // The generated command that changed is updated.
    expect(now).toContain(GNEW);
    expect(now).not.toContain(G);
    expect(out).toContain(keptLine("PreToolUse", "./my-guard.sh"));
    expect(out).not.toContain(`generate: ${G}`);
  });

  it("a user command that names the topology's script as an argument is kept and named", () => {
    writeAt(AT(ALPHA, hook("scripts/guard.sh")));
    const mineCmd = "./my-lint.sh .claude/skills/t/scripts/guard.sh";
    put(S, J({ hooks: { Stop: [{ hooks: [{ type: "command", command: mineCmd }] }] } }));
    const { out } = scaffold();
    expect(commands("Stop")).toEqual([mineCmd]);
    expect(out).toContain(keptLine("Stop", mineCmd));
    scaffold("--prune");
    expect(commands("Stop")).toEqual([mineCmd]);
  });

  it("a generated hook the .at no longer states is removed without a kept line", () => {
    writeAt(AT(ALPHA, hook("scripts/guard.sh")));
    scaffold();
    writeAt(AT(ALPHA, hook("scripts/guard2.sh", "Write")));
    const { out } = scaffold();
    expect(commands("PreToolUse")).toEqual([GNEW]);
    expect(out).not.toContain("kept a command");
  });
});
