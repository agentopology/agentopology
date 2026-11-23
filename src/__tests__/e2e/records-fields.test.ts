/**
 * Records with fields, a writer and a run state.
 *
 * A record used to hold only `path`. Now it can declare the fields a row
 * must hold, a schema, and a writer; a `kind: run-state` record has the fixed
 * fields target and step. On Claude Code each record gets a writer script
 * (record-<id>.sh) that refuses a row that lacks a field, a PostToolUse hook
 * appends a step's ledger row when its command succeeds, and every record is
 * listed in .claude/records.json.
 *
 * The tests scaffold a small topology into a temp dir and run the generated
 * scripts the way Claude Code runs a hook: a shell, a subfolder as the current
 * directory, CLAUDE_PROJECT_DIR set.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { serializeAST as serialize } from "../../import/serializer.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";

const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;

const RECORDS = `  records {
    record trace {
      path: "logs/trace.jsonl"
      fields: [step: string, ok: boolean, ts: ts]
      schema: row
      writer: render
    }
    record notes {
      path: "logs/notes.jsonl"
      fields: [text: string, count: number]
    }
    record state {
      path: "logs/state.jsonl"
      kind: run-state
    }
  }`;

const topology = (records = RECORDS) => `topology ship : [pipeline] {
  meta {
    version: "1.0.0"
    description: "Render then publish"
  }
  orchestrator {
    model: sonnet
    handles: [render, publish]
  }
  action render {
    kind: external
    commands: ["./tool render"]
  }
  action publish {
    kind: external
    commands: ["./tool publish"]
  }
  schemas {
    schema row {
      step: string
      ok: boolean
    }
  }
${records}
  gates {
    gate publish-ready {
      after: render
      before: publish
      ledger: trace
      on-fail: halt
    }
  }
  flow { render -> publish }
}
`;

let root: string;
const at = (p: string) => join(root, p);
const SCRIPTS = ".claude/skills/ship/scripts";

function scaffold(src: string) {
  const ast = parse(src);
  const files = claudeCodeBinding.scaffold(ast);
  for (const f of files) {
    fs.mkdirSync(dirname(at(f.path)), { recursive: true });
    fs.writeFileSync(at(f.path), f.content);
    if (f.executable) fs.chmodSync(at(f.path), 0o755);
  }
  fs.mkdirSync(at("src/deep"), { recursive: true });
  return { ast, files };
}

const run = (command: string, input = "") =>
  spawnSync("/bin/sh", ["-c", command], {
    cwd: at("src/deep"),
    input,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    encoding: "utf8",
    timeout: 20_000,
  });
const recordScript = (id: string, json: string) => run(`bash "$CLAUDE_PROJECT_DIR/${SCRIPTS}/record-${id}.sh" "$ROW"`.replace('"$ROW"', `'${json.replace(/'/g, `'\\''`)}'`));
const afterAction = (stdin: object) => run(`bash "$CLAUDE_PROJECT_DIR/${SCRIPTS}/after-action.sh"`, JSON.stringify(stdin));
const bashPost = (command: string, tool_response: unknown = { stdout: "", stderr: "", interrupted: false }) =>
  ({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_response });
const lines = (p: string) => fs.readFileSync(at(p), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const rules = (src: string, rule: string, target?: string) => validate(parse(src), target ? { target } : {}).filter((r) => r.rule === rule);

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-records-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe("records: the language", () => {
  it("RF1 fields, schema, writer and kind are read", () => {
    const ast = parse(topology());
    const trace = ast.records!.find((r) => r.id === "trace")!;
    expect(trace.fields).toEqual([{ name: "step", type: "string" }, { name: "ok", type: "boolean" }, { name: "ts", type: "ts" }]);
    expect(trace.schema).toBe("row");
    expect(trace.writer).toBe("render");
    expect(ast.records!.find((r) => r.id === "state")!.kind).toBe("run-state");
  });

  it("RF2 a record with fields validates with no error", () => {
    expect(validate(parse(topology())).filter((r) => r.level === "error").map((r) => `${r.rule}: ${r.message}`)).toEqual([]);
  });

  it("RF3 the serializer keeps fields, schema, writer and kind", () => {
    const again = parse(serialize(parse(topology())));
    expect(again.records).toEqual(parse(topology()).records);
  });

  it("RF4 a record with only a path is unchanged", () => {
    const ast = parse(topology(`  records {\n    record trace { path: "logs/trace.jsonl" }\n  }`));
    expect(ast.records).toEqual([{ id: "trace", path: "logs/trace.jsonl" }]);
  });
});

describe("records: validation", () => {
  it("RF5 an unknown field type is an error naming the field and the types", () => {
    const hits = rules(topology(RECORDS.replace("count: number", "count: integer")), "V137");
    expect(hits).toHaveLength(1);
    expect(hits[0].level).toBe("error");
    expect(hits[0].message).toMatch(/count/);
    expect(hits[0].message).toMatch(/integer/);
    expect(hits[0].message).toMatch(/string, number, boolean, ts/);
  });

  it("RF6 a schema that is not declared is an error", () => {
    const hits = rules(topology(RECORDS.replace("schema: row", "schema: nope")), "V137");
    expect(hits).toHaveLength(1);
    expect(hits[0].level).toBe("error");
    expect(hits[0].message).toMatch(/schema "nope"/);
  });

  it("RF7 a writer that names no action, agent or project path is an error", () => {
    const hits = rules(topology(RECORDS.replace("writer: render", "writer: ghost")), "V137");
    expect(hits).toHaveLength(1);
    expect(hits[0].level).toBe("error");
    expect(hits[0].message).toMatch(/writer "ghost"/);
  });

  it("RF8 a writer may be an action id or a project script path", () => {
    expect(rules(topology(RECORDS.replace("writer: render", "writer: tools/write-trace.sh")), "V137")).toEqual([]);
    expect(rules(topology(RECORDS.replace("writer: render", "writer: ../outside.sh")), "V137")).toHaveLength(1);
  });

  it("RF9 kind: run-state with fields is an error", () => {
    const bad = RECORDS.replace('kind: run-state', 'kind: run-state\n      fields: [target: string]');
    const hits = rules(topology(bad), "V137");
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toMatch(/run-state/);
  });

  it("RF10 an unknown kind is an error", () => {
    const hits = rules(topology(RECORDS.replace("kind: run-state", "kind: journal")), "V137");
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toMatch(/journal/);
  });

  it("RF11 fields and writer are not unknown names (V102 stays quiet)", () => {
    expect(rules(topology(), "V102")).toEqual([]);
  });

  it("RF12 codex and cursor warn that records are not written; claude-code does not", () => {
    expect(rules(topology(), "V138", "codex").map((r) => r.level)).toEqual(["warning"]);
    expect(rules(topology(), "V138", "cursor").map((r) => r.level)).toEqual(["warning"]);
    expect(rules(topology(), "V138", "claude-code")).toEqual([]);
    expect(rules(topology(), "V138")).toEqual([]);
    expect(rules(topology(`  records {\n    record trace { path: "logs/trace.jsonl" }\n  }`), "V138", "codex")).toEqual([]);
  });
});

describe.skipIf(!hasJq)("records: the writer script", () => {
  beforeEach(() => { scaffold(topology()); });

  it("RF13 a record gets .claude/skills/<topology>/scripts/record-<id>.sh", () => {
    expect(fs.existsSync(at(`${SCRIPTS}/record-trace.sh`))).toBe(true);
    expect(fs.existsSync(at(`${SCRIPTS}/record-notes.sh`))).toBe(true);
    expect(fs.existsSync(at(`${SCRIPTS}/record-state.sh`))).toBe(true);
  });

  it("RF14 a row missing a declared field: exit 2, names the field, writes nothing", () => {
    const r = recordScript("notes", '{"text":"hi"}');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/count/);
    expect(fs.existsSync(at("logs/notes.jsonl"))).toBe(false);
  });

  it("RF15 a row with a mistyped field: exit 2, names the field, writes nothing", () => {
    const r = recordScript("notes", '{"text":"hi","count":"three"}');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/count/);
    expect(r.stderr).toMatch(/number/);
    expect(fs.existsSync(at("logs/notes.jsonl"))).toBe(false);
  });

  it("RF16 a full row is appended, with ts added when missing", () => {
    expect(recordScript("notes", '{"text":"hi","count":2}').status).toBe(0);
    expect(recordScript("notes", '{"text":"again","count":3,"ts":"2026-01-01T00:00:00Z"}').status).toBe(0);
    const rows = lines("logs/notes.jsonl");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ text: "hi", count: 2 });
    expect(rows[0].ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(rows[1].ts).toBe("2026-01-01T00:00:00Z");
  });

  it("RF17 input that is not a JSON object is refused", () => {
    expect(recordScript("notes", "not json").status).toBe(2);
    expect(recordScript("notes", "[1,2]").status).toBe(2);
    expect(fs.existsSync(at("logs/notes.jsonl"))).toBe(false);
  });

  it("RF18 a run-state record needs target and step", () => {
    const bad = recordScript("state", '{"target":"prod"}');
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/step/);
    expect(recordScript("state", '{"target":"prod","step":"render"}').status).toBe(0);
    expect(lines("logs/state.jsonl")[0]).toMatchObject({ target: "prod", step: "render" });
  });

  it("RF19 an n/a row needs a reason", () => {
    const bad = recordScript("trace", '{"step":"render","ok":"n/a"}');
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/reason/);
    expect(fs.existsSync(at("logs/trace.jsonl"))).toBe(false);
    expect(recordScript("trace", '{"step":"render","ok":"n/a","reason":"no sources this run"}').status).toBe(0);
    expect(lines("logs/trace.jsonl")[0]).toMatchObject({ step: "render", ok: "n/a", reason: "no sources this run" });
  });
});

describe.skipIf(!hasJq)("records: the step's ledger row (PostToolUse)", () => {
  it("RF20 settings.json wires a PostToolUse hook on Bash that runs after-action.sh", () => {
    const { files } = scaffold(topology());
    const settings = JSON.parse(files.find((f) => f.path === ".claude/settings.json")!.content);
    const post = settings.hooks.PostToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    const entry = post.find((e) => e.hooks.some((h) => h.command.includes("after-action.sh")));
    expect(entry?.matcher).toBe("Bash");
  });

  it("RF21 the step's command exiting 0 appends {step, ok: true, ts, model}", () => {
    scaffold(topology());
    const r = afterAction({ ...bashPost("./tool render"), model: "claude-sonnet-5-5" });
    expect(r.status).toBe(0);
    const rows = lines("logs/trace.jsonl");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ step: "render", ok: true, model: "claude-sonnet-5-5" });
    expect(rows[0].ts).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("RF22 a failed command appends nothing (the payload carries Claude Code's error text)", () => {
    scaffold(topology());
    const r = afterAction(bashPost("./tool render", "Exit code 1\nboom"));
    expect(r.status).toBe(0);
    expect(fs.existsSync(at("logs/trace.jsonl"))).toBe(false);
  });

  it("RF23 a command that is not the step appends nothing", () => {
    scaffold(topology());
    expect(afterAction(bashPost("ls -la")).status).toBe(0);
    expect(afterAction(bashPost("git log --grep='./tool render'")).status).toBe(0);
    expect(fs.existsSync(at("logs/trace.jsonl"))).toBe(false);
  });

  it("RF24 a step no ledger records writes no after-action hook", () => {
    const { files } = scaffold(topology().replace("      ledger: trace\n", "").replace(/records \{[\s\S]*?\n  \}\n  gates/, "records {\n    record other { path: \"logs/o.jsonl\" }\n    record more { path: \"logs/m.jsonl\" }\n  }\n  gates"));
    expect(files.find((f) => f.path.endsWith("after-action.sh"))).toBeUndefined();
  });
});

describe("records: .claude/records.json", () => {
  it("RF25 lists every record, with who reads it", () => {
    const { files } = scaffold(topology());
    const f = files.find((x) => x.path === ".claude/records.json");
    expect(f).toBeDefined();
    const doc = JSON.parse(f!.content);
    const byId = Object.fromEntries(doc.records.map((r: { id: string }) => [r.id, r]));
    expect(Object.keys(byId).sort()).toEqual(["notes", "state", "trace"]);
    expect(byId.trace).toMatchObject({ path: "logs/trace.jsonl", writer: "render", readBy: ["publish-ready"] });
    expect(byId.trace.fields).toEqual([{ name: "step", type: "string" }, { name: "ok", type: "boolean" }, { name: "ts", type: "ts" }]);
  });

  it("RF26 a record no gate reads is listed with an empty readBy", () => {
    const { files } = scaffold(topology());
    const doc = JSON.parse(files.find((x) => x.path === ".claude/records.json")!.content);
    const notes = doc.records.find((r: { id: string }) => r.id === "notes");
    expect(notes.readBy).toEqual([]);
    expect(notes.path).toBe("logs/notes.jsonl");
  });

  it("RF27 a run-state record lists its fixed fields", () => {
    const { files } = scaffold(topology());
    const doc = JSON.parse(files.find((x) => x.path === ".claude/records.json")!.content);
    const state = doc.records.find((r: { id: string }) => r.id === "state");
    expect(state.kind).toBe("run-state");
    expect(state.fields.map((x: { name: string }) => x.name)).toEqual(["target", "step"]);
  });

  it("RF28 a topology with no records writes no records.json", () => {
    const { files } = scaffold(topology("").replace("      ledger: trace\n", "").replace("      after: render\n", ""));
    expect(files.find((x) => x.path === ".claude/records.json")).toBeUndefined();
  });
});
