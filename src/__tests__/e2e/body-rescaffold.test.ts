/**
 * The .at is the source of an agent's, skill's and rules file's body.
 *
 * Scaffold records, per agent, skill and rules file, the hash of the body it
 * last wrote. On a later run: a body that still hashes to the record is
 * unedited and is rewritten from the .at (counted as updated); one that
 * differs is the user's and is kept; a manifest with no record (a project
 * scaffolded by 0.13.0 or earlier) takes the same rule from the whole-file
 * hash: a file still matching it is unedited and follows the .at (its body
 * hash is recorded from then on); one that differs takes 0.13.0's path (an
 * edit only between the prompt markers has the sections outside them
 * regenerated around the prompt; any other edit keeps the body, said as
 * written before bodies were recorded); one with no manifest entry is the
 * user's and is kept. Frontmatter is unchanged: the three-way patch.
 *
 * Each test runs the built CLI against temporary projects.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BODY_UNRECORDED_KEPT } from "../../scaffold/incremental.js";

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
/** The text between an agent file's prompt markers. */
const promptOf = (text: string) => text.split("<!-- agentopology:prompt")[1]?.split("<!-- /agentopology:prompt -->")[0];
const manifest = () => JSON.parse(read(MANIFEST)) as { files: Record<string, Record<string, unknown>> };

/** The topology: six agents, one agent that runs as a skill, and a description the rules file states. */
function topology(tag: string, a2Reads = false): string {
  const agent = (id: string) => `  agent ${id} {
    model: haiku
    description: "Agent ${id}"
${a2Reads && id === "a2" ? `    reads: ["docs/notes.md"]\n` : ""}    prompt {
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

describe("(c') a 0.13.0 manifest (whole-file hashes, no body hash)", () => {
  it("an unedited agent and an unedited skill get the new prompt, and the manifest records their body hash", () => {
    scaffold();
    dropRecords(BODY_FILES);
    fs.writeFileSync(at, topology("NEW"));
    scaffold();
    for (const p of [...AGENTS, SKILL]) {
      expect(read(p), p).toContain("NEW.");
      expect(read(p), p).not.toContain("OLD.");
      expect(typeof manifest().files[p].body, p).toBe("string");
    }
  });

  it("regression: an unedited rules file follows the .at again", () => {
    scaffold();
    dropRecords(BODY_FILES);
    fs.writeFileSync(at, topology("NEW"));
    scaffold();
    expect(read(RULES)).toContain("Shop NEW");
    expect(typeof manifest().files[RULES].body).toBe("string");
  });

  it("an edited file (whole-file hash differs) is kept byte for byte, with the user-owned message", () => {
    scaffold();
    dropRecords(BODY_FILES);
    const edited: Record<string, string> = {};
    for (const p of [AGENTS[0], SKILL, RULES]) {
      edited[p] = read(p) + "\nMine.\n";
      write(p, edited[p]);
    }
    // an agent whose prompt alone was edited is the user's too
    const promptEdit = read(AGENTS[1]).replace("Prompt of a2 OLD.", "My prompt.");
    write(AGENTS[1], promptEdit);
    fs.writeFileSync(at, topology("NEW"));
    const { out } = scaffold();
    for (const p of [AGENTS[0], SKILL, RULES]) {
      expect(read(p), p).toBe(edited[p]);
      expect(manifest().files[p].body, p).toBeUndefined();
    }
    // the rules file has no frontmatter to patch, so it is the one said as kept, for its reason
    expect(out).toContain(`${RULES} (${BODY_UNRECORDED_KEPT})`);
    // an agent whose prompt alone was edited keeps its prompt, as 0.13.0 did
    expect(read(AGENTS[1])).toBe(promptEdit);
  });

  it("an agent whose prompt alone was edited gets the new generated sections and keeps its prompt, as 0.13.0 did", () => {
    scaffold();
    dropRecords(BODY_FILES);
    const promptEdit = read(AGENTS[1]).replace("Prompt of a2 OLD.", "My prompt.");
    write(AGENTS[1], promptEdit);
    fs.writeFileSync(at, topology("OLD", true));
    const { out } = scaffold();
    const after = read(AGENTS[1]);
    expect(after).toContain("## Reads");
    expect(after).toContain("- docs/notes.md");
    expect(promptOf(after)).toBe(promptOf(promptEdit));
    expect(promptOf(after)).toContain("My prompt.");
    expect(out).toContain(`${AGENTS[1]}: sections outside the prompt markers regenerated, prompt kept`);
    expect(out).not.toMatch(/\b0 updated/);
  });

  it("a file with no manifest entry is kept byte for byte", () => {
    scaffold();
    const m = manifest();
    const mine: Record<string, string> = {};
    for (const p of [AGENTS[0], SKILL, RULES]) {
      delete m.files[p];
      mine[p] = read(p);
    }
    write(MANIFEST, JSON.stringify(m, null, 2) + "\n");
    fs.writeFileSync(at, topology("NEW"));
    scaffold();
    for (const p of [AGENTS[0], SKILL, RULES]) expect(read(p), p).toBe(mine[p]);
  });

  it("a second scaffold with no .at change changes nothing", () => {
    scaffold();
    dropRecords(BODY_FILES);
    fs.writeFileSync(at, topology("NEW"));
    scaffold();
    const before = tree(project);
    const { out } = scaffold();
    expect(out).toMatch(/\b0 created, 0 updated/);
    expect(out).not.toMatch(/\bkept\b/);
    expect(tree(project)).toEqual(before);
  });

  it("deleting a file has scaffold write it fresh and record it", () => {
    scaffold();
    dropRecords(BODY_FILES);
    fs.unlinkSync(file(AGENTS[0]));
    scaffold();
    expect(typeof manifest().files[AGENTS[0]].body).toBe("string");
  });
});
