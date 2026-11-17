/**
 * The .at owns structure, the file owns content.
 *
 * Structure is the frontmatter keys the .at states and which files exist;
 * content is the body, the prose, and every frontmatter key the .at does not
 * state. Scaffold writes structure into files that already exist (hand-written
 * ones, imported ones with `file:`, and scaffolded ones the user edited) by
 * patching their frontmatter, and never writes their body, not even with
 * --force.
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
const scaffold = (...extra: string[]) => cli(["scaffold", at, "--target", "claude-code", "--output", project, ...extra]);
const editAt = (from: string, to: string) => {
  const text = fs.readFileSync(at, "utf-8");
  if (!text.includes(from)) throw new Error(`not in the .at: ${from}`);
  fs.writeFileSync(at, text.replace(from, to));
};

/** Everything after the closing frontmatter fence. */
function body(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/.exec(text);
  if (!m) throw new Error("no frontmatter");
  return text.slice(m[0].length);
}
/** The frontmatter lines. */
function front(text: string): string[] {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  if (!m) throw new Error("no frontmatter");
  return m[1].split(/\r?\n/);
}

// ---------------------------------------------------------------------------
// A hand-built project and the .at that import writes for it (`file:` on
// every agent, skill and command).
// ---------------------------------------------------------------------------

const AGENT = ".claude/agents/builder.md";
const SKILL = ".claude/skills/lint/SKILL.md";
const COMMAND = ".claude/commands/ship.md";

const AGENT_TEXT = [
  "---",
  "name: builder",
  "description: Builds the thing",
  "# picked by hand",
  "model: sonnet",
  "tools: Read, Grep",
  "color: blue",
  "---",
  "",
  "PROSE builder line one.",
  "",
  "## My notes",
  "PROSE kept: every byte.",
  "",
].join("\n");
const SKILL_TEXT = ["---", "name: lint", "description: Lints the code", "allowed-tools: Read", "---", "", "PROSE lint skill.", ""].join("\n");
const COMMAND_TEXT = ["---", "description: Ship it", "---", "", "# /ship", "", "PROSE ship command.", ""].join("\n");

const IMPORTED_AT = `topology shop : [] {
  meta {
    version: "1.0.0"
  }

  agent builder {
    file: .claude/agents/builder.md
    model: sonnet
    description: "Builds the thing"
    tools: [Read, Grep]
    invocation: manual
    color: blue
  }

  triggers {
    command ship {
      pattern: "/ship"
      file: .claude/commands/ship.md
    }
  }

  skills {
    skill lint {
      file: .claude/skills/lint/SKILL.md
      description: "Lints the code"
      allowed-tools: [Read]
    }
  }
}
`;

beforeEach(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), "at-structure-"));
  project = join(tmp, "project");
  at = join(tmp, "shop.at");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("an imported project: .at edits reach the hand-written files, prose stays", () => {
  beforeEach(() => {
    put(AGENT, AGENT_TEXT);
    put(SKILL, SKILL_TEXT);
    put(COMMAND, COMMAND_TEXT);
    fs.writeFileSync(at, IMPORTED_AT);
  });

  it("scaffold right after import writes no byte of the agent, skill or command", () => {
    const { code, out } = scaffold();
    expect(code, out).toBe(0);
    expect(read(AGENT)).toBe(AGENT_TEXT);
    expect(read(SKILL)).toBe(SKILL_TEXT);
    expect(read(COMMAND)).toBe(COMMAND_TEXT);
  });

  it("adding a skill to an agent writes skills: into its file", () => {
    editAt("color: blue\n", "color: blue\n    skills: [lint]\n");
    const { code, out } = scaffold();
    expect(code, out).toBe(0);
    const text = read(AGENT);
    expect(front(text)).toEqual([
      "name: builder",
      "description: Builds the thing",
      "# picked by hand",
      "model: sonnet",
      "tools: Read, Grep",
      "color: blue",
      "skills:",
      "  - lint",
    ]);
    expect(body(text)).toBe(body(AGENT_TEXT));
    expect(out).toContain(`~ ${AGENT}: skills (absent) → [lint]`);
    expect(out).toMatch(/ 1 updated/);
  });

  it("changing the model writes model: and nothing else", () => {
    editAt("model: sonnet", "model: haiku");
    const { out } = scaffold();
    const text = read(AGENT);
    expect(text).toBe(AGENT_TEXT.replace("model: sonnet", "model: haiku"));
    expect(out).toContain(`~ ${AGENT}: model sonnet → haiku`);
    expect(out).not.toMatch(/0 created, 0 updated/);
  });

  it("changing the tools writes tools: in the binding's comma form", () => {
    editAt("tools: [Read, Grep]", "tools: [Read, Grep, Bash]");
    const { out } = scaffold();
    expect(read(AGENT)).toBe(AGENT_TEXT.replace("tools: Read, Grep", "tools: Read, Grep, Bash"));
    expect(out).toContain(`~ ${AGENT}: tools [Read, Grep] → [Read, Grep, Bash]`);
  });

  it("changing the description writes description:", () => {
    editAt('description: "Builds the thing"', 'description: "Builds and checks the thing"');
    scaffold();
    expect(read(AGENT)).toBe(AGENT_TEXT.replace("description: Builds the thing", "description: Builds and checks the thing"));
  });

  it("changing a skill's allowed-tools writes allowed-tools: into SKILL.md", () => {
    editAt("allowed-tools: [Read]", "allowed-tools: [Read, Bash]");
    const { out } = scaffold();
    expect(read(SKILL)).toBe(SKILL_TEXT.replace("allowed-tools: Read", "allowed-tools: Read, Bash"));
    expect(out).toContain(`~ ${SKILL}: allowed-tools [Read] → [Read, Bash]`);
  });

  it("--force applies the same patch and still never touches the body", () => {
    editAt("model: sonnet", "model: haiku");
    scaffold("--force");
    expect(read(AGENT)).toBe(AGENT_TEXT.replace("model: sonnet", "model: haiku"));
    expect(read(SKILL)).toBe(SKILL_TEXT);
    expect(read(COMMAND)).toBe(COMMAND_TEXT);
  });

  it("a second scaffold with no .at change writes nothing to these files", () => {
    editAt("model: sonnet", "model: haiku");
    scaffold();
    expect(read(AGENT)).toContain("model: haiku");
    const after = [read(AGENT), read(SKILL), read(COMMAND)];
    const { out } = scaffold();
    expect([read(AGENT), read(SKILL), read(COMMAND)]).toEqual(after);
    expect(out).toMatch(/ 0 created, 0 updated/);
    expect(out).not.toContain(`~ ${AGENT}`);
  });
});

describe("import → scaffold on keys import does not model", () => {
  it("nested hooks, skills and no model come back as written, byte for byte", () => {
    const text = [
      "---",
      "name: rev",
      "description: Reviews code",
      "tools:",
      "  - Read",
      "  - Grep",
      "hooks:",
      "  PreToolUse:",
      "    - matcher: Bash",
      "      hooks:",
      "        - type: command",
      "          command: echo hi",
      "skills:",
      "  - lint",
      "---",
      "",
      "PROSE.",
      "",
    ].join("\n");
    put(".claude/agents/rev.md", text);
    const imp = cli(["import", "--target", "claude-code", "--dir", project, "--name", "shop", "--output", tmp]);
    expect(imp.code, imp.out).toBe(0);
    const { code, out } = scaffold();
    expect(code, out).toBe(0);
    expect(read(".claude/agents/rev.md")).toBe(text);
    expect(out).not.toContain(".claude/agents/rev.md");
  });

  // Import reads a block-scalar description and a flow list with quotes
  // only in part. Scaffold compares through the same reading, so what import
  // could not read is not "changed by the .at" and is never written back.
  const LOSSY = [
    "---",
    "name: rev",
    "description: |",
    "  Reviews code.",
    "  Carefully.",
    "model: sonnet",
    'tools: [Read, "Grep"]',
    "maxTurns: 5",
    "---",
    "",
    "PROSE.",
    "",
  ].join("\n");

  it("values import reads only in part come back as written", () => {
    put(".claude/agents/rev.md", LOSSY);
    expect(cli(["import", "--target", "claude-code", "--dir", project, "--name", "shop", "--output", tmp]).code).toBe(0);
    const { code, out } = scaffold();
    expect(code, out).toBe(0);
    expect(read(".claude/agents/rev.md")).toBe(LOSSY);
    expect(out).not.toContain(".claude/agents/rev.md");
    // and a second run is as quiet
    expect(scaffold().out).not.toContain(".claude/agents/rev.md");
  });

  it("an .at edit to one key writes that key only, beside values import read in part", () => {
    put(".claude/agents/rev.md", LOSSY);
    cli(["import", "--target", "claude-code", "--dir", project, "--name", "shop", "--output", tmp]);
    editAt("model: sonnet", "model: haiku");
    const { out } = scaffold();
    expect(read(".claude/agents/rev.md")).toBe(LOSSY.replace("model: sonnet", "model: haiku"));
    expect(out).toContain("~ .claude/agents/rev.md: model sonnet → haiku");
  });
});

describe("three-way: the .at, the file, and what scaffold applied last", () => {
  beforeEach(() => {
    put(AGENT, AGENT_TEXT);
    put(SKILL, SKILL_TEXT);
    put(COMMAND, COMMAND_TEXT);
    fs.writeFileSync(at, IMPORTED_AT.replace("model: sonnet", "model: haiku"));
    scaffold(); // applies haiku; scaffold now records it
    expect(read(AGENT)).toContain("model: haiku");
  });

  it("a hand edit of a key the .at did not change is kept and reported as drift", () => {
    put(AGENT, read(AGENT).replace("model: haiku", "model: opus"));
    const { code, out } = scaffold();
    expect(code, out).toBe(0);
    expect(read(AGENT)).toContain("model: opus");
    expect(out).toContain(`! ${AGENT}: model is opus in the file, haiku in the .at`);
  });

  it("a key changed on both sides is kept and reported as a conflict with both values", () => {
    put(AGENT, read(AGENT).replace("model: haiku", "model: opus"));
    editAt("model: haiku", "model: sonnet");
    const { out } = scaffold();
    expect(read(AGENT)).toContain("model: opus");
    expect(out).toContain(`! ${AGENT}: model changed on both sides: .at sonnet, file opus, last applied haiku`);
  });

  it("--force takes the .at value for a conflicting key, and the body stays", () => {
    put(AGENT, read(AGENT).replace("model: haiku", "model: opus"));
    editAt("model: haiku", "model: sonnet");
    scaffold("--force");
    expect(read(AGENT)).toBe(AGENT_TEXT);
  });

  it("a key the .at stopped stating leaves the file when the file still holds what scaffold applied", () => {
    editAt("    color: blue\n", "");
    const { code, out } = scaffold();
    expect(code, out).toBe(0);
    expect(front(read(AGENT))).not.toContain("color: blue");
    expect(body(read(AGENT))).toBe(body(AGENT_TEXT));
    expect(out).toContain(`~ ${AGENT}: color blue → (removed)`);
  });

  it("a key the .at stopped stating stays when the file changed it", () => {
    put(AGENT, read(AGENT).replace("color: blue", "color: red"));
    editAt("    color: blue\n", "");
    const { code, out } = scaffold();
    expect(code, out).toBe(0);
    expect(read(AGENT)).toContain("color: red");
    expect(out).toContain(`! ${AGENT}: color left the .at`);
  });
});

describe("a hand-written file at a generated path (no file:)", () => {
  const AT = `topology shop : [] {
  meta {
    version: "1.0.0"
  }
  agent builder {
    model: haiku
    description: "Builds"
  }
  agent checker {
    model: haiku
    description: "Checks"
  }
  flow {
    builder -> checker
  }
  triggers {
    command ship {
      pattern: "/ship"
    }
  }
  skills {
    skill lint {
      description: "Lints"
      allowed-tools: [Read, Bash]
    }
  }
}
`;
  const HAND_AGENT = ["---", "name: builder", "description: Builds", "model: sonnet", "---", "", "PROSE hand agent.", ""].join("\n");
  const HAND_SKILL = ["---", "name: lint", "description: Lints", "---", "", "PROSE hand skill.", ""].join("\n");
  const HAND_COMMAND = ["---", "description: Ship", "---", "", "PROSE hand command.", ""].join("\n");

  beforeEach(() => {
    fs.writeFileSync(at, AT);
    put(".claude/agents/builder/AGENT.md", HAND_AGENT);
    put(".claude/skills/lint/SKILL.md", HAND_SKILL);
    put(".claude/commands/ship.md", HAND_COMMAND);
  });

  it("--force patches the frontmatter and keeps every byte of the prose", () => {
    const { code, out } = scaffold("--force");
    expect(code, out).toBe(0);
    const agent = read(".claude/agents/builder/AGENT.md");
    expect(agent).toContain("model: haiku");
    expect(body(agent)).toBe(body(HAND_AGENT));
    const skill = read(".claude/skills/lint/SKILL.md");
    expect(skill).toContain("allowed-tools: Read, Bash");
    expect(body(skill)).toBe(body(HAND_SKILL));
    expect(read(".claude/commands/ship.md")).toBe(HAND_COMMAND);
  });

  it("the hint no longer says --force overwrites them", () => {
    put(".claude/rules/shop.md", "my own rules\n");
    const { out } = scaffold();
    expect(out).not.toContain("--force overwrites them");
  });
});

describe("a scaffolded file the user edited outside the prompt markers", () => {
  const AT = `topology shop : [] {
  meta {
    version: "1.0.0"
  }
  agent builder {
    model: haiku
    description: "Builds"
    prompt {
      Build it.
    }
  }
  agent checker {
    model: haiku
    description: "Checks"
  }
  flow {
    builder -> checker
  }
}
`;
  const PATH = ".claude/agents/builder/AGENT.md";

  beforeEach(() => {
    fs.writeFileSync(at, AT);
    scaffold();
    put(PATH, read(PATH) + "\nMY NOTE outside the markers.\n");
  });

  it("a plain scaffold keeps the added text", () => {
    const before = read(PATH);
    const { out } = scaffold();
    expect(read(PATH)).toBe(before);
    expect(out).not.toContain(`${PATH} (prompt preserved)`);
  });

  it("a .at change reaches its frontmatter and the added text stays", () => {
    const before = read(PATH);
    editAt("model: haiku", "model: sonnet");
    const { out } = scaffold();
    expect(read(PATH)).toBe(before.replace("model: haiku", "model: sonnet"));
    expect(out).toContain(`~ ${PATH}: model haiku → sonnet`);
  });
});
