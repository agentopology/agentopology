/**
 * The .at is the source of an agent's, skill's and rules file's body.
 *
 * Scaffold records, per agent, skill and rules file, the hash of the body it
 * last wrote. On a later run: a body that still hashes to the record is
 * unedited and is rewritten from the .at (counted as updated); one that
 * differs is the user's and is kept; a manifest with no record (a project
 * scaffolded by 0.13.0 or earlier) is read as the user's body, kept, and
 * recorded only when scaffold next writes that body. Frontmatter is
 * unchanged: the three-way patch.
 *
 * Each test runs the built CLI against temporary projects.
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

const file = (rel: string, root = project) => join(root, rel);
const read = (rel: string, root = project) => fs.readFileSync(file(rel, root), "utf-8");
const write = (rel: string, content: string) => fs.writeFileSync(file(rel), content);
const scaffold = (into = project, ...extra: string[]) =>
  cli(["scaffold", at, "--target", "claude-code", "--output", into, ...extra]);
const MANIFEST = ".claude/.scaffold-manifest.json";
const manifest = () => JSON.parse(read(MANIFEST)) as { files: Record<string, Record<string, unknown>> };

/** The topology: six agents, one agent that runs as a skill, and a description the rules file states. */
function topology(tag: string): string {
  const agent = (id: string) => `  agent ${id} {
    model: haiku
    description: "Agent ${id}"
    prompt {
      Prompt of ${id} ${tag}.
    }
  }
`;
  const ids = ["a1", "a2", "a3", "a4", "a5", "a6"];
  return `topology shop : [pipeline] {
  meta {
    version: "1.0.0"
    description: "Shop ${tag}"
  }
${ids.map(agent).join("")}  agent s1 {
    model: haiku
    description: "Skill"
    runs: inline
    prompt {
      Skill prompt ${tag}.
    }
  }
  flow {
    a1 -> a2
    a2 -> a3
    a3 -> a4
    a4 -> a5
    a5 -> a6
    a6 -> s1
  }
}
`;
}

const AGENTS = ["a1", "a2", "a3", "a4", "a5", "a6"].map((id) => `.claude/agents/${id}/AGENT.md`);
const SKILL = ".claude/skills/s1/SKILL.md";
const RULES = ".claude/rules/shop.md";
const BODY_FILES = [...AGENTS, SKILL, RULES];

/** The manifest without its timestamp: what a clean generation must equal. */
function stamped(root: string): string {
  const m = JSON.parse(read(MANIFEST, root)) as Record<string, unknown>;
  delete m.generatedAt;
  return JSON.stringify(m);
}

function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out[p.slice(root.length + 1)] = e.name === ".scaffold-manifest.json" ? stamped(root) : fs.readFileSync(p, "utf-8");
    }
  };
  walk(root);
  return out;
}

/** The file's manifest entry with its body record removed: what 0.13.0 wrote. */
function dropRecords(paths: string[]): void {
  const m = JSON.parse(read(MANIFEST)) as { files: Record<string, Record<string, unknown>> };
  for (const p of paths) delete m.files[p].body;
  write(MANIFEST, JSON.stringify(m, null, 2) + "\n");
}

beforeEach(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), "at-body-"));
  project = join(tmp, "project");
  at = join(tmp, "shop.at");
  fs.writeFileSync(at, topology("OLD"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("(a) an unedited body follows the .at", () => {
  it("a prompt-only change reaches all six AGENT.md, and a clean generation equals the re-scaffold", () => {
    scaffold();
    fs.writeFileSync(at, topology("NEW"));
    const { out, code } = scaffold();
    expect(code).toBe(0);
    for (const p of AGENTS) {
      expect(read(p)).toContain("NEW.");
      expect(read(p)).not.toContain("OLD.");
    }
    expect(out).toMatch(/\b9 updated/); // 6 agents, 2 skills, the rules file
    const clean = join(tmp, "clean");
    scaffold(clean);
    expect(tree(project)).toEqual(tree(clean));
  });

  it("the manifest records a body hash for each agent, skill and rules file", () => {
    scaffold();
    const files = manifest().files;
    for (const p of BODY_FILES) expect(typeof files[p].body, p).toBe("string");
  });

  it("a SKILL.md and a rules file follow the .at", () => {
    scaffold();
    fs.writeFileSync(at, topology("NEW"));
    scaffold();
    expect(read(SKILL)).toContain("Skill prompt NEW.");
    expect(read(RULES)).toContain("Shop NEW");
  });

  it("an agent file whose frontmatter the user changed still takes the new body", () => {
    scaffold();
    write(AGENTS[0], read(AGENTS[0]).replace("model: haiku", "model: sonnet"));
    fs.writeFileSync(at, topology("NEW"));
    const { out } = scaffold();
    expect(read(AGENTS[0])).toContain("model: sonnet");
    expect(read(AGENTS[0])).toContain("Prompt of a1 NEW.");
    expect(out).toContain(AGENTS[0]);
  });

  it("a skill file whose frontmatter the user changed still takes the new body", () => {
    scaffold();
    write(SKILL, read(SKILL).replace("model: haiku", "model: sonnet"));
    fs.writeFileSync(at, topology("NEW"));
    scaffold();
    expect(read(SKILL)).toContain("model: sonnet");
    expect(read(SKILL)).toContain("Skill prompt NEW.");
  });

  it("a body hand-edited back to exactly the generated text counts as unedited", () => {
    scaffold();
    const generated = read(AGENTS[0]);
    write(AGENTS[0], generated.replace("Prompt of a1 OLD.", "Prompt of a1 EDITED."));
    write(AGENTS[0], generated);
    write(RULES, read(RULES) + "extra\n");
    write(RULES, read(RULES).replace("extra\n", ""));
    fs.writeFileSync(at, topology("NEW"));
    scaffold();
    expect(read(AGENTS[0])).toContain("Prompt of a1 NEW.");
    expect(read(RULES)).toContain("Shop NEW");
  });
});

describe("(b) an edited body is kept", () => {
  it("an agent's edited prompt is kept, the others follow the .at", () => {
    scaffold();
    write(AGENTS[0], read(AGENTS[0]).replace("Prompt of a1 OLD.", "My own prompt."));
    fs.writeFileSync(at, topology("NEW"));
    scaffold();
    expect(read(AGENTS[0])).toContain("My own prompt.");
    expect(read(AGENTS[0])).not.toContain("NEW.");
    expect(read(AGENTS[1])).toContain("Prompt of a2 NEW.");
  });

  it("an agent's body edited outside the prompt markers is kept", () => {
    scaffold();
    const edited = read(AGENTS[2]) + "\nMY NOTE.\n";
    write(AGENTS[2], edited);
    fs.writeFileSync(at, topology("NEW"));
    scaffold();
    expect(read(AGENTS[2])).toBe(edited);
  });

  it("an edited SKILL.md body is kept", () => {
    scaffold();
    const edited = read(SKILL).replace("Skill prompt OLD.", "My skill text.");
    write(SKILL, edited);
    fs.writeFileSync(at, topology("NEW"));
    scaffold();
    expect(read(SKILL)).toBe(edited);
  });

  it("an edited rules file is kept, with the existing message", () => {
    scaffold();
    const edited = read(RULES) + "\nMy rule.\n";
    write(RULES, edited);
    fs.writeFileSync(at, topology("NEW"));
    const { out } = scaffold();
    expect(read(RULES)).toBe(edited);
    expect(out).toContain(`${RULES} (user edited — kept)`);
  });
});

describe("(c) a manifest without body records keeps the bodies", () => {
  it("an upgrade from 0.13.0 keeps every body and records nothing", () => {
    scaffold();
    dropRecords(BODY_FILES);
    const before = Object.fromEntries(BODY_FILES.map((p) => [p, read(p)]));
    fs.writeFileSync(at, topology("NEW"));
    scaffold();
    for (const p of BODY_FILES) {
      // A skill's text around its instructions is regenerated, as before: its instructions are kept.
      if (p === SKILL) {
        expect(read(p)).toContain("Skill prompt OLD.");
        expect(read(p)).not.toContain("NEW");
      } else {
        expect(read(p), p).toBe(before[p]);
      }
      expect(manifest().files[p].body, p).toBeUndefined();
    }
  });

  it("deleting a kept body has scaffold write it fresh and record it; the next change reaches it", () => {
    scaffold();
    dropRecords(BODY_FILES);
    fs.writeFileSync(at, topology("NEW"));
    scaffold();
    fs.unlinkSync(file(AGENTS[0]));
    fs.unlinkSync(file(SKILL));
    fs.unlinkSync(file(RULES));
    scaffold();
    expect(read(AGENTS[0])).toContain("Prompt of a1 NEW.");
    for (const p of [AGENTS[0], SKILL, RULES]) expect(typeof manifest().files[p].body, p).toBe("string");
    fs.writeFileSync(at, topology("NEWER"));
    scaffold();
    expect(read(AGENTS[0])).toContain("Prompt of a1 NEWER.");
    expect(read(SKILL)).toContain("Skill prompt NEWER.");
    expect(read(RULES)).toContain("Shop NEWER");
    // the files that stayed old are still the user's
    expect(read(AGENTS[1])).toContain("Prompt of a2 OLD.");
  });
});
