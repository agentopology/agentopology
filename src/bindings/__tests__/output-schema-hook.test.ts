/**
 * An agent's output-schema is checked when the agent finishes: a SubagentStop
 * hook reads `last_assistant_message` (the hooks reference says Stop and
 * SubagentStop carry it), parses it as JSON or as its first ```json block, and
 * exits 2 naming the first missing or mistyped field. An agent with no schema
 * gets no hook.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../claude-code.js";

const SRC = `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "x"
  }
  orchestrator {
    model: opus
    handles: [intake]
  }
  action intake {
    kind: inline
    description: "in"
  }
  agent checker {
    model: sonnet
    description: "Produces a report"
    prompt { Check. }
    output-schema {
      title: string
      score: number
      done: boolean
      meta: object
      tags: array of string
      level: low | high
      note: ?string
    }
  }
  agent plain {
    model: sonnet
    description: "No schema"
    prompt { Plain. }
  }
  flow {
    intake -> checker
    checker -> plain
  }
}`;

const files = claudeCodeBinding.scaffold(parse(SRC));
const SCRIPT = ".claude/skills/t/scripts/output-schema-checker.sh";

const GOOD = { title: "a", score: 1.5, done: true, meta: {}, tags: ["x"], level: "low" };

function run(message: string) {
  const root = fs.mkdtempSync(join(os.tmpdir(), "at-output-schema-"));
  try {
    for (const f of files) {
      fs.mkdirSync(dirname(join(root, f.path)), { recursive: true });
      fs.writeFileSync(join(root, f.path), f.content);
    }
    return spawnSync("bash", [join(root, SCRIPT)], {
      input: JSON.stringify({ hook_event_name: "SubagentStop", agent_type: "checker", last_assistant_message: message }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("output-schema SubagentStop hook", () => {
  it("is wired for the agent with a schema, and only that one", () => {
    const settings = JSON.parse(files.find((f) => f.path === ".claude/settings.json")!.content);
    const stops = settings.hooks?.SubagentStop ?? [];
    const mine = stops.filter((e: any) => JSON.stringify(e).includes("output-schema-checker.sh"));
    expect(mine).toHaveLength(1);
    expect(mine[0].matcher).toBe("checker");
    expect(files.some((f) => f.path.includes("output-schema-plain"))).toBe(false);
  });

  it("exits 0 for matching JSON", () => {
    expect(run(JSON.stringify(GOOD)).status).toBe(0);
  });

  it("exits 0 for the first ```json block in prose", () => {
    const msg = "Here you go:\n```json\n" + JSON.stringify(GOOD) + "\n```\nbye";
    expect(run(msg).status).toBe(0);
  });

  it("exits 2 naming the first missing field", () => {
    const { title: _t, ...rest } = GOOD;
    const r = run(JSON.stringify(rest));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("title");
  });

  it("exits 2 naming a mistyped field", () => {
    const r = run(JSON.stringify({ ...GOOD, score: "high" }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("score");
  });

  it("exits 2 for a list item of the wrong type and for a value outside the enum", () => {
    expect(run(JSON.stringify({ ...GOOD, tags: [1] })).stderr).toContain("tags");
    expect(run(JSON.stringify({ ...GOOD, level: "mid" })).stderr).toContain("level");
  });

  it("exits 2 when the message is not JSON", () => {
    expect(run("no json here").status).toBe(2);
  });

  it("lets an optional field be absent", () => {
    expect(run(JSON.stringify(GOOD)).status).toBe(0);
    expect(run(JSON.stringify({ ...GOOD, note: 3 })).status).toBe(2);
  });
});
