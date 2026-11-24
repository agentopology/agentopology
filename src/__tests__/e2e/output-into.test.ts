/**
 * `output-into: <record-id>` on an agent with an `output-schema` (0.13.1).
 *
 * A generated SubagentStop hook, output-into-<agent>.sh, reads the agent's final
 * output and appends ONE JSON row {ts, agent, ...fields} to the record, so a gate
 * can read the agent's result while the agent has no shell and no write access to
 * the record. Output that does not match the schema appends {ts, agent, error:
 * "schema"} instead, never the raw output.
 *
 * Fields used (https://code.claude.com/docs/en/hooks, SubagentStop input):
 * `last_assistant_message` (the text of the subagent's final response),
 * `agent_type` (the subagent's name, what the settings matcher filters on) and
 * `agent_id`.
 *
 * Must-pass rows sit beside the refusal rows: ordinary commands are not refused
 * on a topology that uses the field (the round-3 lesson).
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

const topology = (agentExtra = "    output-into: results", records = `  records {\n    record results { path: "logs/results.jsonl" }\n  }`, schema = true) => `topology rev : [pipeline] {
  meta {
    version: "1.0.0"
    description: "A reviewer whose result a gate reads"
  }
  orchestrator {
    model: sonnet
    handles: [intake]
  }
  action intake {
    kind: inline
    description: "in"
  }
  agent reviewer {
    model: sonnet
    description: "Reviews"
    prompt { Review. }
${schema ? "    output-schema {\n      verdict: ok | fail\n      score: number\n      note: ?string\n    }\n" : ""}${agentExtra}
  }
  agent other {
    model: sonnet
    description: "Does not write the record"
    prompt { Other. }
  }
${records}
  flow {
    intake -> reviewer
    reviewer -> other
  }
}
`;

const SCRIPTS = ".claude/skills/rev/scripts";
let root: string;
const at = (p: string) => join(root, p);

function scaffold(src = topology()) {
  const files = claudeCodeBinding.scaffold(parse(src));
  for (const f of files) {
    fs.mkdirSync(dirname(at(f.path)), { recursive: true });
    fs.writeFileSync(at(f.path), f.content);
    if (f.executable || f.path.endsWith(".sh")) fs.chmodSync(at(f.path), 0o755);
  }
  fs.mkdirSync(at("logs"), { recursive: true });
  fs.mkdirSync(at("src"), { recursive: true });
  fs.writeFileSync(at("src/a.ts"), "x\n");
  return files;
}
const env = () => ({ ...process.env, CLAUDE_PROJECT_DIR: root }) as NodeJS.ProcessEnv;
const stop = (message: string | undefined, extra: object = {}) =>
  spawnSync("bash", [at(`${SCRIPTS}/output-into-reviewer.sh`)], {
    cwd: at("src"), encoding: "utf8", timeout: 20_000, env: env(),
    input: JSON.stringify({ hook_event_name: "SubagentStop", agent_id: "def456", agent_type: "reviewer", ...(message === undefined ? {} : { last_assistant_message: message }), ...extra }),
  });
const hook = (script: string, payload: object) =>
  spawnSync("bash", [at(`${SCRIPTS}/${script}`)], { cwd: root, input: JSON.stringify(payload), encoding: "utf8", timeout: 20_000, env: env() });
const action = (command: string) => hook("before-action.sh", { hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command } });
const edit = (file_path: string) => hook("before-edit.sh", { hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Write", tool_input: { file_path, content: "x" } });
const rowsOf = () => (fs.existsSync(at("logs/results.jsonl")) ? fs.readFileSync(at("logs/results.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const rules = (src: string, rule: string, target?: string) => validate(parse(src), target ? { target } : {}).filter((r) => r.rule === rule);

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-outinto-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe("output-into: the language", () => {
  it("OI1 output-into is read and kept by the serializer", () => {
    const ast = parse(topology());
    const reviewer = ast.nodes.find((n) => n.id === "reviewer") as { outputInto?: string };
    expect(reviewer.outputInto).toBe("results");
    const again = parse(serialize(ast)).nodes.find((n) => n.id === "reviewer") as { outputInto?: string };
    expect(again.outputInto).toBe("results");
  });

  it("OI2 a valid output-into validates with no error and no unknown-name warning", () => {
    expect(validate(parse(topology())).filter((r) => r.level === "error").map((r) => `${r.rule}: ${r.message}`)).toEqual([]);
    expect(rules(topology(), "V102")).toEqual([]);
  });

  it("OI3 a record that is not declared is an error naming it", () => {
    const hits = rules(topology("    output-into: ghost"), "V159");
    expect(hits).toHaveLength(1);
    expect(hits[0].level).toBe("error");
    expect(hits[0].message).toMatch(/ghost/);
    expect(hits[0].message).toMatch(/results/);
  });

  it("OI4 an agent without an output-schema is refused", () => {
    const hits = rules(topology("    output-into: results", undefined, false), "V159");
    expect(hits).toHaveLength(1);
    expect(hits[0].level).toBe("error");
    expect(hits[0].message).toMatch(/output-schema/);
    expect(hits[0].message).toMatch(/reviewer/);
  });

  it("OI5 a record path with {unit} is an error (the hook knows no unit)", () => {
    const hits = rules(topology("    output-into: results", `  records {\n    record results { path: "logs/{unit}/results.jsonl" }\n  }`), "V159");
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toMatch(/\{unit\}/);
  });

  it("OI6 codex and cursor warn that output-into is not written", () => {
    expect(rules(topology(), "V159", "codex").map((r) => r.level)).toEqual(["warning"]);
    expect(rules(topology(), "V159", "claude-code")).toEqual([]);
  });
});

describe("output-into: generation", () => {
  it("OI7 an agent with output-into gets a hook script and a SubagentStop entry for that agent", () => {
    const files = claudeCodeBinding.scaffold(parse(topology()));
    expect(files.some((f) => f.path === `${SCRIPTS}/output-into-reviewer.sh`)).toBe(true);
    const settings = JSON.parse(files.find((f) => f.path === ".claude/settings.json")!.content);
    const mine = (settings.hooks.SubagentStop as Array<{ matcher: string; hooks: Array<{ command: string }> }>)
      .filter((e) => e.hooks.some((h) => h.command.includes("output-into-reviewer.sh")));
    expect(mine).toHaveLength(1);
    expect(mine[0].matcher).toBe("reviewer");
  });

  it("OI8 a topology that does not use output-into writes no such script and no mention of it", () => {
    const files = claudeCodeBinding.scaffold(parse(topology("")));
    expect(files.some((f) => f.path.includes("output-into"))).toBe(false);
    expect(files.some((f) => f.content.includes("output-into"))).toBe(false);
  });

  it("OI9 the script names the SubagentStop fields it reads", () => {
    const script = claudeCodeBinding.scaffold(parse(topology())).find((f) => f.path.endsWith("output-into-reviewer.sh"))!.content;
    expect(script).toContain("last_assistant_message");
    expect(script).toContain("SubagentStop");
  });
});

describe.skipIf(!hasJq)("output-into: the hook", () => {
  beforeEach(() => { scaffold(); });

  it("OI10 matching JSON output appends one row {ts, agent, fields}", () => {
    const r = stop('{"verdict":"ok","score":4.5,"note":"fine"}');
    expect(r.status, r.stderr).toBe(0);
    const rows = rowsOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent: "reviewer", verdict: "ok", score: 4.5, note: "fine" });
    expect(rows[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(rows[0].error).toBeUndefined();
  });

  it("OI11 the first ```json block of a longer message is read", () => {
    stop('Here is my review.\n```json\n{"verdict":"fail","score":1}\n```\nDone.');
    expect(rowsOf()).toHaveLength(1);
    expect(rowsOf()[0]).toMatchObject({ agent: "reviewer", verdict: "fail", score: 1 });
  });

  it("OI12 an optional field may be absent", () => {
    stop('{"verdict":"ok","score":2}');
    expect(rowsOf()[0]).toMatchObject({ verdict: "ok", score: 2 });
    expect(rowsOf()[0].note).toBeUndefined();
  });

  it("OI13 a field the schema does not declare is not copied", () => {
    stop('{"verdict":"ok","score":2,"secret":"do-not-copy","agent":"forged","ts":"1999-01-01T00:00:00Z"}');
    const row = rowsOf()[0];
    expect(row.secret).toBeUndefined();
    expect(row.agent).toBe("reviewer");
    expect(row.ts).not.toBe("1999-01-01T00:00:00Z");
  });

  it.each([
    ["a wrong type", '{"verdict":"ok","score":"high"}'],
    ["a missing required field", '{"verdict":"ok"}'],
    ["a value outside the enum", '{"verdict":"maybe","score":1}'],
    ["prose", "I reviewed it and it looks fine to me, token sk-SECRET-123"],
    ["a JSON array", "[1,2,3]"],
    ["an empty message", ""],
  ])("OI14 %s appends {ts, agent, error: schema} and never the raw output", (_label, message) => {
    const r = stop(message);
    expect(r.status, r.stderr).toBe(0);
    const rows = rowsOf();
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(["agent", "error", "ts"]);
    expect(rows[0]).toMatchObject({ agent: "reviewer", error: "schema" });
    expect(fs.readFileSync(at("logs/results.jsonl"), "utf8")).not.toContain("SECRET");
  });

  it("OI15 a payload with no last_assistant_message appends the error row", () => {
    stop(undefined);
    expect(rowsOf()).toEqual([expect.objectContaining({ agent: "reviewer", error: "schema" })]);
  });

  it("OI16 each stop appends one row, after the existing rows", () => {
    stop('{"verdict":"ok","score":1}');
    stop('{"verdict":"fail","score":2}');
    expect(rowsOf().map((r) => r.verdict)).toEqual(["ok", "fail"]);
  });

  it("OI17 the hook finds the project from CLAUDE_PROJECT_DIR, whatever its working directory", () => {
    const r = stop('{"verdict":"ok","score":1}');
    expect(r.status).toBe(0);
    expect(fs.existsSync(at("logs/results.jsonl"))).toBe(true);
    expect(fs.existsSync(at("src/logs/results.jsonl"))).toBe(false);
  });

  it("OI18 the hook never blocks the subagent (exit 0 on a mismatch too)", () => {
    expect(stop("nonsense").status).toBe(0);
  });
});

describe.skipIf(!hasJq)("output-into: the record is not writable by the agent or the session", () => {
  beforeEach(() => { scaffold(); });

  const REFUSED = [
    `echo '{"agent":"reviewer","verdict":"ok","score":9}' >> logs/results.jsonl`,
    `echo '{"verdict":"ok"}' | tee -a logs/results.jsonl`,
    `cp forged.jsonl logs/results.jsonl`,
    `rm logs/results.jsonl`,
    `cd logs && echo '{}' >> results.jsonl`,
  ];
  it.each(REFUSED)("OI19 refused: %s", (cmd) => {
    const r = action(cmd);
    expect(r.status, r.stderr).toBe(2);
  });

  // MUST-PASS rows.
  const ORDINARY = [
    "git status",
    "npm test",
    "ls",
    "ls logs",
    "grep x src",
    'claude -p --agent x "summarize the logs"',
    'claude -p --agent reviewer "summarize the logs"',
    "cat logs/results.jsonl",
    "grep verdict logs/results.jsonl",
    "wc -l logs/results.jsonl",
    "tail -n 3 logs/results.jsonl",
    "jq .verdict logs/results.jsonl",
    "cat logs/results.jsonl 2>/dev/null",
    "echo hello > build.log",
    "echo '{}' >> logs/other.jsonl",
    "rm -rf build",
  ];
  it.each(ORDINARY)("OI20 must pass: %s", (cmd) => {
    fs.writeFileSync(at("logs/results.jsonl"), "");
    const r = action(cmd);
    expect(r.status, r.stderr).toBe(0);
  });

  it("OI21 an Edit or Write of the record is refused; another path passes", () => {
    expect(edit(at("logs/results.jsonl")).status).toBe(2);
    expect(edit(at("src/a.ts")).status).toBe(0);
    expect(edit(at("logs/other.jsonl")).status).toBe(0);
  });

  it("OI22 the hook script itself is a file only scaffold writes", () => {
    expect(edit(at(`${SCRIPTS}/output-into-reviewer.sh`)).status).toBe(2);
    expect(action(`echo 'exit 0' > ${SCRIPTS}/output-into-reviewer.sh`).status).toBe(2);
    expect(action(`cat ${SCRIPTS}/output-into-reviewer.sh`).status).toBe(0);
  });
});
