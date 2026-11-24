/**
 * `record <id> { max-per-day: N }` (0.13.1).
 *
 * The N+1th row appended on one UTC day is refused: by the record's generated
 * writer (record-<id>.sh), and by the before-action.sh guard on a direct
 * append to the record's path. A row counts for the day its `ts` (or `at`)
 * starts with; the writer adds `ts` when a row has none, so a record that
 * declares no ts field still counts. These are text checks: the guard reads
 * the command, counts the rows already in the file, and cannot know how many
 * rows one command appends.
 *
 * Must-pass rows sit beside the refusal rows: ordinary commands are not
 * refused on a topology that uses the field (the round-3 lesson).
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

const topology = (record = `    record events {\n      path: "logs/events.jsonl"\n      max-per-day: 2\n    }`) => `topology cap : [pipeline] {
  meta {
    version: "1.0.0"
    description: "Record with a daily cap"
  }
  orchestrator {
    model: sonnet
    handles: [work]
  }
  action work {
    kind: external
    commands: ["./tool work"]
  }
  records {
${record}
  }
  flow { work }
}
`;

const SCRIPTS = ".claude/skills/cap/scripts";
let root: string;
const at = (p: string) => join(root, p);
const today = () => new Date().toISOString().slice(0, 10);
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const rows = (day: string, n: number) => Array.from({ length: n }, (_, i) => JSON.stringify({ i, ts: `${day}T10:00:0${i}Z` })).join("\n") + (n ? "\n" : "");

function scaffold(src = topology()) {
  for (const f of claudeCodeBinding.scaffold(parse(src))) {
    fs.mkdirSync(dirname(at(f.path)), { recursive: true });
    fs.writeFileSync(at(f.path), f.content);
    if (f.executable || f.path.endsWith(".sh")) fs.chmodSync(at(f.path), 0o755);
  }
  fs.mkdirSync(at("logs"), { recursive: true });
  fs.mkdirSync(at("src"), { recursive: true });
  fs.writeFileSync(at("src/a.ts"), "x\n");
}
const hook = (script: string, payload: object) =>
  spawnSync("bash", [at(`${SCRIPTS}/${script}`)], {
    cwd: root, input: JSON.stringify(payload), encoding: "utf8", timeout: 20_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root } as NodeJS.ProcessEnv,
  });
const action = (command: string) => hook("before-action.sh", { hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command } });
const edit = (file_path: string) => hook("before-edit.sh", { hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Write", tool_input: { file_path, content: "x" } });
const writer = (json: string) =>
  spawnSync("bash", [at(`${SCRIPTS}/record-events.sh`), json], { cwd: root, encoding: "utf8", timeout: 20_000, env: { ...process.env, CLAUDE_PROJECT_DIR: root } as NodeJS.ProcessEnv });
const lineCount = () => (fs.existsSync(at("logs/events.jsonl")) ? fs.readFileSync(at("logs/events.jsonl"), "utf8").trim().split("\n").filter(Boolean).length : 0);
const rules = (src: string, rule: string) => validate(parse(src)).filter((r) => r.rule === rule);

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-maxday-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe("max-per-day: the language", () => {
  it("MD1 max-per-day is read as a number and kept by the serializer", () => {
    const ast = parse(topology());
    expect(ast.records![0].maxPerDay).toBe(2);
    expect(parse(serialize(ast)).records).toEqual(ast.records);
  });

  it("MD2 a record with max-per-day validates with no error and no unknown-name warning", () => {
    expect(validate(parse(topology())).filter((r) => r.level === "error").map((r) => `${r.rule}: ${r.message}`)).toEqual([]);
    expect(rules(topology(), "V102")).toEqual([]);
  });

  it.each(["0", "-1", "1.5", "two", '""'])("MD3 max-per-day: %s is an error naming the record", (v) => {
    const hits = rules(topology(`    record events {\n      path: "logs/events.jsonl"\n      max-per-day: ${v}\n    }`), "V158");
    expect(hits).toHaveLength(1);
    expect(hits[0].level).toBe("error");
    expect(hits[0].message).toMatch(/events/);
    expect(hits[0].message).toMatch(/positive whole number/);
  });

  it("MD4 max-per-day on a path with {unit} is an error (the count is per file)", () => {
    const hits = rules(topology(`    record events {\n      path: "logs/{unit}/events.jsonl"\n      max-per-day: 2\n    }`), "V158");
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toMatch(/\{unit\}/);
  });

  it("MD5 codex and cursor warn that max-per-day is not written", () => {
    const hits = validate(parse(topology()), { target: "codex" }).filter((r) => r.rule === "V140");
    expect(hits.map((r) => r.level)).toEqual(["warning"]);
  });

  it("MD6 a topology that does not use the field generates no rate guard text", () => {
    const files = claudeCodeBinding.scaffold(parse(topology(`    record events { path: "logs/events.jsonl" }`)));
    expect(files.some((f) => f.path.endsWith("/record-events.sh"))).toBe(false);
    expect(files.some((f) => f.content.includes("rate_guard"))).toBe(false);
  });
});

describe.skipIf(!hasJq)("max-per-day: the writer", () => {
  beforeEach(() => scaffold());

  it("MD7 the third row of the day is refused and nothing is written", () => {
    expect(writer('{"n":1}').status).toBe(0);
    expect(writer('{"n":2}').status).toBe(0);
    const r = writer('{"n":3}');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/max-per-day/);
    expect(lineCount()).toBe(2);
  });

  it("MD8 the writer adds ts to a row of a record that declares no ts field, and that row counts", () => {
    writer('{"n":1}');
    expect(JSON.parse(fs.readFileSync(at("logs/events.jsonl"), "utf8").trim()).ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    fs.writeFileSync(at("logs/events.jsonl"), rows(today(), 2));
    expect(writer('{"n":3}').status).toBe(2);
  });

  it("MD9 rows of an earlier UTC day do not count", () => {
    fs.writeFileSync(at("logs/events.jsonl"), rows(yesterday(), 5));
    expect(writer('{"n":1}').status).toBe(0);
    expect(lineCount()).toBe(6);
  });

  it("MD10 a row the writer was given with yesterday's ts is still checked against today's count", () => {
    fs.writeFileSync(at("logs/events.jsonl"), rows(today(), 2));
    // the day a row counts for is the day the writer appends it (UTC now), whatever ts the row carries
    expect(writer(`{"n":1,"ts":"${yesterday()}T00:00:00Z"}`).status).toBe(2);
  });
});

describe.skipIf(!hasJq)("max-per-day: the guard on a direct append", () => {
  beforeEach(() => scaffold());

  const REFUSED = [
    `echo '{"a":1}' >> logs/events.jsonl`,
    `printf '%s\\n' '{"a":1}' >> logs/events.jsonl`,
    `echo '{"a":1}' | tee -a logs/events.jsonl`,
    `cat extra.jsonl >> logs/events.jsonl`,
    `cp extra.jsonl logs/events.jsonl`,
    `cd logs && echo '{"a":1}' >> events.jsonl`,
    `E=logs/events.jsonl; echo '{"a":1}' >> $E`,
  ];

  it.each(REFUSED)("MD11 at the limit, refused: %s", (cmd) => {
    fs.writeFileSync(at("logs/events.jsonl"), rows(today(), 2));
    const r = action(cmd);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/max-per-day/);
  });

  it.each(REFUSED)("MD12 under the limit, passes: %s", (cmd) => {
    fs.writeFileSync(at("logs/events.jsonl"), rows(today(), 1));
    expect(action(cmd).status).toBe(0);
  });

  it("MD13 rows of an earlier day leave the append open", () => {
    fs.writeFileSync(at("logs/events.jsonl"), rows(yesterday(), 9));
    expect(action(`echo '{"a":1}' >> logs/events.jsonl`).status).toBe(0);
  });

  it("MD14 no file yet leaves the append open", () => {
    expect(action(`echo '{"a":1}' >> logs/events.jsonl`).status).toBe(0);
  });

  // MUST-PASS rows: at the limit, none of these is refused.
  const ORDINARY = [
    "git status",
    "npm test",
    "ls",
    "ls logs",
    "grep x src",
    "grep -r x src > /tmp/out.txt",
    'claude -p --agent x "summarize the logs"',
    "cat logs/events.jsonl",
    "grep error logs/events.jsonl",
    "wc -l logs/events.jsonl",
    "tail -n 5 logs/events.jsonl",
    "jq . logs/events.jsonl",
    "cat logs/events.jsonl 2>/dev/null",
    "echo hello > build.log",
    "echo '{}' >> logs/other.jsonl",
    "rm -rf *",
    "./tool work",
    `bash ${SCRIPTS}/record-events.sh '{"n":1}'`,
  ];
  it.each(ORDINARY)("MD15 at the limit, must pass: %s", (cmd) => {
    fs.writeFileSync(at("logs/events.jsonl"), rows(today(), 2));
    fs.writeFileSync(at("logs/other.jsonl"), "");
    const r = action(cmd);
    expect(r.status, r.stderr).toBe(0);
  });

  it("MD16 an Edit or Write of the record file is refused; another path passes", () => {
    expect(edit(at("logs/events.jsonl")).status).toBe(2);
    expect(edit("logs/events.jsonl").status).toBe(2);
    expect(edit(at("src/a.ts")).status).toBe(0);
    expect(edit(at("logs/other.jsonl")).status).toBe(0);
  });
});
