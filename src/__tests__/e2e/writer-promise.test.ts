/**
 * The writer's promise: the .at owns structure (the frontmatter keys it
 * states), the file owns content. An update injects structure without
 * touching content; nothing the .at states is dropped silently; when the
 * writer cannot do something safely it says so (a line on the CLI, a drift
 * row) instead of skipping it or writing something broken.
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
const editAt = (from: string, to: string) => {
  const text = fs.readFileSync(at, "utf-8");
  if (!text.includes(from)) throw new Error(`not in the .at: ${from}`);
  fs.writeFileSync(at, text.replace(from, to));
};
/** The output lines that name a path. */
const linesAbout = (out: string, rel: string) => out.split("\n").filter((l) => l.includes(rel)).map((l) => l.trim());

beforeEach(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), "at-writer-"));
  project = join(tmp, "project");
  fs.mkdirSync(project);
  at = join(tmp, "t.at");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A small topology; `inner` goes before the second agent, `extra` after it. */
const AT = (inner: string, extra = "") => `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "writer base"
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
const ALPHA = (desc: string) => `
  agent alpha {
    description: "${desc}"
    model: sonnet
    prompt {
      Generated alpha prompt.
    }
  }
`;

// ---------------------------------------------------------------------------
// A file scaffold wrote and the user edited, with no frontmatter the .at owns
// ---------------------------------------------------------------------------

describe("a hand-edited file with no structure to patch is kept whole, with or without --force", () => {
  const MAIN = ".claude/skills/t/SKILL.md";
  const RULES = ".claude/rules/t.md";

  it("the topology's own SKILL.md: a plain scaffold after an .at change keeps the user's text and says so", () => {
    writeAt(AT(ALPHA("Alpha desc")));
    scaffold();
    const mine = read(MAIN) + "\n## My notes\n\nUSER TEXT AT END\n";
    put(MAIN, mine);
    editAt("Alpha desc", "Alpha desc changed");
    const { out } = scaffold();
    expect(read(MAIN)).toBe(mine);
    const said = linesAbout(out, MAIN);
    expect(said.join("\n")).toContain("user edited — kept");
    expect(said.join("\n")).not.toContain("prompt preserved");
  });

  it("the topology's own SKILL.md rewritten by hand survives --force", () => {
    writeAt(AT(ALPHA("Alpha desc")));
    scaffold();
    const mine = "---\nname: t\ndescription: mine\n---\n\nUSER REWROTE EVERYTHING\n";
    put(MAIN, mine);
    const { out } = scaffold("--force");
    expect(read(MAIN)).toBe(mine);
    expect(linesAbout(out, MAIN).join("\n")).toContain("user edited — kept");
  });

  it("the topology's rules file edited by hand survives --force", () => {
    writeAt(AT(ALPHA("Alpha desc")));
    scaffold();
    const mine = read(RULES) + "\nMY RULE: never deploy on Friday.\n";
    put(RULES, mine);
    editAt('description: "writer base"', 'description: "writer base v2"');
    const { out } = scaffold("--force");
    expect(read(RULES)).toBe(mine);
    expect(linesAbout(out, RULES).join("\n")).toContain("user edited — kept");
    expect(out).not.toContain("overwritten (--force)");
  });

  it("a file at a generated path that scaffold never wrote is kept with --force too", () => {
    writeAt(AT(ALPHA("Alpha desc")));
    put(RULES, "MY OWN RULES FILE\n");
    const { out } = scaffold("--force");
    expect(read(RULES)).toBe("MY OWN RULES FILE\n");
    expect(linesAbout(out, RULES).join("\n")).toContain("kept");
  });

  it("a group's SKILL.md and transcript.md keep text added to them", () => {
    const group = `
  group panel {
    members: [alpha, beta]
    speaker-selection: round-robin
    max-rounds: 3
    termination: "consensus reached"
    description: "Design panel"
  }
`;
    writeAt(AT(ALPHA("Alpha desc"), group).replace("alpha -> beta", "alpha -> beta\n    beta -> panel"));
    const first = scaffold();
    expect(first.code).toBe(0);
    const paths = [".claude/skills/panel/SKILL.md", ".claude/groups/panel/transcript.md"];
    for (const p of paths) put(p, read(p) + "\nUSER OR RUNTIME TEXT (a round of the conversation)\n");
    const before = Object.fromEntries(paths.map((p) => [p, read(p)]));
    editAt('description: "Design panel"', 'description: "Design panel v2"');
    for (const flags of [[], ["--force"]]) {
      const { out } = scaffold(...flags);
      for (const p of paths) {
        expect(read(p)).toBe(before[p]);
        expect(linesAbout(out, p).join("\n")).toContain("user edited — kept");
        expect(linesAbout(out, p).join("\n")).not.toContain("prompt preserved");
      }
    }
  });

  it("a file still exactly as scaffold wrote it is regenerated as before", () => {
    writeAt(AT(ALPHA("Alpha desc")));
    scaffold();
    editAt('description: "writer base"', 'description: "writer base v2"');
    scaffold();
    expect(read(RULES)).toContain("writer base v2");
  });
});

// ---------------------------------------------------------------------------
// A scaffolded agent file the user edited: generated body sections and
// claude-code extension keys still reach it
// ---------------------------------------------------------------------------

describe("after a hand edit of a scaffolded agent file, .at changes still reach it", () => {
  const A = ".claude/agents/alpha/AGENT.md";
  const agent = (extra: string, ext = "project") => `
  agent alpha {
    description: "Alpha desc"
    model: sonnet
${extra}
    extensions {
      claude-code {
        memory: ${ext}
      }
    }
    prompt {
      Generated alpha prompt.
    }
  }
`;
  const V1 = '    reads: ["workspace/in.md"]\n    writes: ["workspace/out.md"]\n    outputs: {\n      verdict: pass | fail\n    }';
  const V2 =
    '    reads: ["workspace/in.md", "workspace/NEW-INPUT.md"]\n    writes: ["workspace/NEW-OUTPUT.md"]\n    outputs: {\n      verdict: pass | fail | NEWVALUE\n    }\n' +
    '    hooks {\n      hook guard {\n        on: PreToolUse\n        matcher: "Bash"\n        run: "scripts/guard.sh"\n      }\n    }';

  it("an edit between the prompt markers only: reads, writes, outputs and hooks are regenerated, the prompt kept", () => {
    writeAt(AT(agent(V1)));
    scaffold();
    put(A, read(A).replace("Generated alpha prompt.", "MY BETTER PROMPT."));
    writeAt(AT(agent(V2)));
    const { out } = scaffold();
    const after = read(A);
    for (const s of ["NEW-INPUT", "NEW-OUTPUT", "NEWVALUE", "MY BETTER PROMPT."]) expect(after).toContain(s);
    expect(after).not.toContain("Generated alpha prompt.");
    expect(after.split("\n---\n")[0]).toMatch(/^hooks:/m);
    expect(linesAbout(out, A).join("\n")).toContain("prompt kept");
    // A second run with nothing changed writes nothing.
    const again = scaffold();
    expect(read(A)).toBe(after);
    expect(linesAbout(again.out, A)).toEqual([]);
  });

  it("an edit outside the prompt markers: the frontmatter is patched, the body kept, and the sections not refreshed are named", () => {
    writeAt(AT(agent(V1)));
    scaffold();
    const mine = read(A) + "\nMY NOTE\n";
    put(A, mine);
    writeAt(AT(agent(V2)));
    const { out } = scaffold();
    const after = read(A);
    expect(after).toContain("MY NOTE");
    expect(after.split("\n---\n")[0]).toMatch(/^hooks:/m);
    expect(after).not.toContain("NEW-INPUT");
    const said = linesAbout(out, A).join("\n");
    expect(said).toContain("not refreshed");
    expect(said).toContain("## Reads");
    expect(said).toContain("## Writes");
    expect(said).toContain("## Outputs");
    // Said again on the next run: the sections are still stale.
    expect(linesAbout(scaffold().out, A).join("\n")).toContain("not refreshed");
  });

  it("an edit outside the prompt markers with no body change in the .at: no line", () => {
    writeAt(AT(agent(V1)));
    scaffold();
    put(A, read(A) + "\nMY NOTE\n");
    editAt("model: sonnet", "model: opus");
    const { out } = scaffold();
    expect(read(A)).toMatch(/^model: opus$/m);
    expect(linesAbout(out, A).filter((l) => l.includes("not refreshed"))).toEqual([]);
  });

  it("a claude-code extension key the schema knows reaches an edited file", () => {
    writeAt(AT(agent(V1)));
    scaffold();
    put(A, read(A) + "\nMY NOTE\n");
    writeAt(AT(agent(V1, "user")));
    const { out } = scaffold();
    expect(read(A)).toMatch(/^memory: user$/m);
    expect(read(A)).toContain("MY NOTE");
    expect(out).toContain(`~ ${A}: memory project → user`);
  });
});

// ---------------------------------------------------------------------------
// List items YAML reads specially, and every refusal said
// ---------------------------------------------------------------------------

describe("a list item YAML reads specially never makes the writer skip a file silently", () => {
  const SKILL = ".claude/skills/helper/SKILL.md";
  const at = AT(
    `
  agent alpha {
    description: "Alpha"
    model: sonnet
    prompt {
      x
    }
  }
`,
    `
  skills {
    skill helper {
      description: "Helps with TypeScript"
      paths: ["*.ts"]
      allowed-tools: [Read]
    }
  }
`,
  );

  it("a fresh project gets the glob quoted", () => {
    writeAt(at);
    expect(scaffold().code).toBe(0);
    expect(read(SKILL)).toMatch(/^paths:\n {2}- "\*\.ts"$/m);
  });

  it("an existing hand-written skill gets description, paths and allowed-tools; the body stays", () => {
    writeAt(at);
    const mine = "---\nname: helper\ndescription: my old description\n---\n\nMY SKILL BODY\n";
    put(SKILL, mine);
    const { out } = scaffold();
    let after = read(SKILL);
    expect(after).toMatch(/^description: Helps with TypeScript$/m);
    expect(after).toMatch(/^paths:\n {2}- "\*\.ts"$/m);
    // allowed-tools approves tools the file approved none of: kept and said on a plain run.
    expect(after).not.toMatch(/^allowed-tools:/m);
    expect(out).toContain(`! ${SKILL}: allowed-tools kept as written: the .at would widen them (+Read); --force applies the .at's`);
    expect(after.endsWith("\n---\n\nMY SKILL BODY\n")).toBe(true);
    expect(out).toContain(`~ ${SKILL}: paths (absent) → [*.ts]`);
    scaffold("--force");
    after = read(SKILL);
    expect(after).toMatch(/^allowed-tools: Read$/m);
    expect(after.endsWith("\n---\n\nMY SKILL BODY\n")).toBe(true);
  });

  it("a key the patcher refuses to read is named with the file and the reason, and is a drift row", () => {
    writeAt(at);
    put(SKILL, "---\nname: helper\ndescription: &d my old description\n---\n\nMY SKILL BODY\n");
    for (const flags of [[], ["--force"]]) {
      const { out } = scaffold(...flags);
      const said = linesAbout(out, SKILL).join("\n");
      expect(said).toContain('"description"');
      expect(said).toContain("anchor or alias");
    }
    const inv = inventory();
    const row = linesAbout(inv.out, SKILL).join("\n");
    expect(row).toContain("blocked");
    expect(row).toContain("description");
    expect(inv.code).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// settings.json values the .at states that the file already holds otherwise
// ---------------------------------------------------------------------------

describe("a settings value the .at states but the file holds otherwise is kept and said", () => {
  const SETTINGS = ".claude/settings.json";
  const at = AT(
    `
  agent alpha {
    description: "Alpha"
    model: sonnet
    prompt {
      x
    }
  }
`,
    `
  settings {
    deny: ["Bash(rm:*)"]
    sandbox: true
    fallback-chain: [opus, sonnet]
  }
  extensions {
    claude-code {
      defaultMode: plan
      sandbox.autoAllowBashIfSandboxed: false
    }
  }
`,
  );
  const user = { permissions: { defaultMode: "bypassPermissions" }, sandbox: { enabled: false }, fallbackModel: "haiku" };
  const EXPECTED = [
    'settings.json permissions.defaultMode: file has "bypassPermissions", the .at states "plan" — not changed',
    "settings.json sandbox.enabled: file has false, the .at states true — not changed",
    'settings.json sandbox.autoAllowBashIfSandboxed: file has no value (its "sandbox" object is kept as it is), the .at states false — not changed',
    'settings.json fallbackModel: file has "haiku", the .at states ["opus","sonnet"] — not changed',
  ];

  beforeEach(() => {
    writeAt(at);
    put(SETTINGS, JSON.stringify(user, null, 2) + "\n");
  });

  it("--dry-run says each key", () => {
    const { out } = scaffold("--dry-run");
    for (const line of EXPECTED) expect(out).toContain(line);
  });

  it("a plain scaffold keeps the file's values and says each key", () => {
    const { out } = scaffold();
    const after = JSON.parse(read(SETTINGS));
    expect(after.permissions.defaultMode).toBe("bypassPermissions");
    expect(after.sandbox).toEqual({ enabled: false });
    expect(after.fallbackModel).toBe("haiku");
    expect(after.permissions.deny).toContain("Bash(rm:*)");
    for (const line of EXPECTED) expect(out).toContain(line);
  });

  it("validate --inventory lists them as drift", () => {
    scaffold();
    const { out, code } = inventory();
    const rows = linesAbout(out, SETTINGS).join("\n");
    for (const key of ["permissions.defaultMode", "sandbox.enabled", "sandbox.autoAllowBashIfSandboxed", "fallbackModel"]) {
      expect(rows).toContain(key);
    }
    expect(code).toBe(3);
  });

  it("a file that already agrees with the .at gets no line", () => {
    put(SETTINGS, JSON.stringify({ permissions: { defaultMode: "plan" } }, null, 2) + "\n");
    const { out } = scaffold();
    expect(out).not.toContain("not changed");
  });
});

// ---------------------------------------------------------------------------
// A value import misread is never written back into the user's file
// ---------------------------------------------------------------------------

describe("a key import read unfaithfully is never written from that reading", () => {
  const REL = ".claude/agents/a1.md";
  const BODY = "\n# Title\n\nHand-written body.\n";
  const CASES: Array<[string, string]> = [
    ["a multi-line flow list", "---\nname: a1\ndescription: Multi-line flow\ntools: [\n  Read,\n  Grep,\n  ]\n---\n"],
    ["a block list with a quoted item", "---\nname: a1\ndescription: Quoted list\ntools:\n  - Read\n  - \"Bash(git log:*)\"\n---\n"],
    ["a list with a trailing comment", "---\nname: a1\ndescription: Has comment\nmodel: opus # pinned for cost\ntools: Read, Grep # read only\n---\n"],
  ];
  const importAt = () => {
    const r = cli(["import", "--target", "claude-code", "--dir", project, "--name", "t", "--output", tmp]);
    if (!fs.existsSync(at)) throw new Error(`import wrote no .at: ${r.out}`);
  };
  const addWrite = () => {
    const text = fs.readFileSync(at, "utf-8");
    const next = text.replace(/tools: \[(.*)\]/, "tools: [$1, Write]");
    if (next === text) throw new Error(`no tools line in the .at:\n${text}`);
    fs.writeFileSync(at, next);
  };

  for (const [name, fm] of CASES) {
    for (const flow of ["edit right after import", "scaffold, then edit"]) {
      it(`${name} (${flow}): the file keeps its tools, and the run names the file, the key and why`, () => {
        put(REL, fm + BODY);
        importAt();
        if (flow === "scaffold, then edit") scaffold();
        expect(read(REL)).toBe(fm + BODY);
        addWrite();
        for (const flags of [[], ["--force"]]) {
          const { out } = scaffold(...flags);
          expect(read(REL)).toBe(fm + BODY);
          const said = linesAbout(out, REL).join("\n");
          expect(said).toContain("tools not written");
        }
        const inv = inventory();
        const rows = linesAbout(inv.out, REL).join("\n");
        expect(rows).toContain("tools");
        expect(rows).toContain("blocked");
      });
    }
  }
});
