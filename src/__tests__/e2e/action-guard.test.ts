/**
 * Guards for script steps (N38). A gate whose `before:` is an action (a script
 * step) used to compile to nothing: V25 said "invoke it from your playbook" and
 * a session ran the step whether or not the gate held. Now one generated
 * script, before-action.sh, refuses the step's Bash command (exit 2) until the
 * ledger shows the gate's `after:` step finished ok for the same unit.
 *
 * The tests scaffold a small topology into a temp dir and run the generated
 * script the way Claude Code runs a hook: a shell, a subfolder as the current
 * directory, CLAUDE_PROJECT_DIR set, the event's JSON on stdin.
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
import { checkGuards } from "../../guard/check.js";

const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;

const topology = (extra = "", gate = `after: render\n      before: publish\n      ledger: trace`) => `topology ship : [pipeline] {
  meta { version: "1.0.0" description: "Render then publish" }
  orchestrator { model: sonnet handles: [render, publish] }
  action render {
    kind: external
    commands: ["./tool render"]
  }
  action publish {
    kind: external
    commands: ["./tool publish", "./tool republish"]
    unit-from: "./tool (?:re)?publish (\\S+)"
  }
  records {
    record trace { path: "logs/{unit}/trace.jsonl" }
  }
  gates {
    gate publish-ready {
      ${gate}
      on-fail: halt
    }
  }
  flow { render -> publish }
${extra}}
`;

let root: string;
const at = (p: string) => join(root, p);
const SCRIPT = ".claude/skills/ship/scripts/before-action.sh";

function scaffold(src: string) {
  const ast = parse(src);
  for (const f of claudeCodeBinding.scaffold(ast)) {
    fs.mkdirSync(dirname(at(f.path)), { recursive: true });
    fs.writeFileSync(at(f.path), f.content);
    if (f.executable) fs.chmodSync(at(f.path), 0o755);
  }
  fs.mkdirSync(at("src/deep"), { recursive: true });
  return ast;
}

function hook(stdin: string, command = `bash "$CLAUDE_PROJECT_DIR/${SCRIPT}"`) {
  return spawnSync("/bin/sh", ["-c", command], {
    cwd: at("src/deep"),
    input: stdin,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    encoding: "utf8",
    timeout: 20_000,
  });
}
const bash = (command: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
const ledger = (unit: string, lines: object[]) => {
  fs.mkdirSync(at(`logs/${unit}`), { recursive: true });
  fs.writeFileSync(at(`logs/${unit}/trace.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
};
const rec = (step: string, ok: boolean, unit?: string) => ({ step, ...(unit ? { unit } : {}), ok, at: "2026-01-01T00:00:00Z" });

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-action-guard-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe.skipIf(!hasJq)("[N38] before-action.sh refuses a script step until the ledger shows its gate held", () => {
  beforeEach(() => { scaffold(topology()); });

  it("[N38] AG1 is wired as a PreToolUse Bash entry with onFailure block, naming the script by $CLAUDE_PROJECT_DIR", () => {
    const settings = JSON.parse(fs.readFileSync(at(".claude/settings.json"), "utf8"));
    expect(settings.hooks.PreToolUse).toContainEqual({
      matcher: "Bash",
      hooks: [{ type: "command", command: `bash "$CLAUDE_PROJECT_DIR/${SCRIPT}"`, onFailure: "block" }],
    });
  });

  it("[N38] AG2 no ledger record for the step: exit 2, stderr names the gate, step, unit and ledger path", () => {
    const r = hook(bash("./tool publish ep42"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("publish-ready");
    expect(r.stderr).toContain("render");
    expect(r.stderr).toContain("ep42");
    expect(r.stderr).toContain("logs/ep42/trace.jsonl");
  });

  it("[N38] AG3 an ok record for the same unit: exit 0", () => {
    ledger("ep42", [rec("render", true, "ep42")]);
    expect(hook(bash("./tool publish ep42")).status).toBe(0);
    expect(hook(bash("./tool republish ep42")).status).toBe(0);
  });

  it("[N38] AG4 an ok record for another unit does not open this unit's gate", () => {
    ledger("ep41", [rec("render", true, "ep41")]);
    ledger("ep42", [rec("render", true, "ep41")]);
    expect(hook(bash("./tool publish ep42")).status).toBe(2);
  });

  it("[N38] AG5 the LAST record decides: ok:false after an earlier ok is a deny", () => {
    ledger("ep42", [rec("render", true, "ep42"), rec("render", false, "ep42")]);
    expect(hook(bash("./tool publish ep42")).status).toBe(2);
  });

  it("[N38] AG5 a later ok after an earlier failure opens the gate", () => {
    ledger("ep42", [rec("render", false, "ep42"), rec("render", true, "ep42")]);
    expect(hook(bash("./tool publish ep42")).status).toBe(0);
  });

  it("[N38] AG6 a command that matches no guarded action: exit 0", () => {
    expect(hook(bash("ls -la")).status).toBe(0);
    expect(hook(bash("./tool render ep42")).status).toBe(0);
    expect(hook(bash("./tool publishing ep42")).status).toBe(0);
  });

  it("[N38] AG7 a missing ledger file is a deny", () => {
    expect(fs.existsSync(at("logs"))).toBe(false);
    expect(hook(bash("./tool publish ep42")).status).toBe(2);
  });

  it("[N38] AG8 bad JSON on stdin: exit 2", () => {
    expect(hook("not json {").status).toBe(2);
    expect(hook("").status).toBe(2);
  });

  it("[N38] AG9 leading VAR=value assignments are stripped before matching", () => {
    expect(hook(bash("DEBUG=1 TOKEN='a b' ./tool publish ep42")).status).toBe(2);
    ledger("ep42", [rec("render", true, "ep42")]);
    expect(hook(bash("DEBUG=1 TOKEN='a b' ./tool publish ep42")).status).toBe(0);
  });

  it("[N38] AG10 a unit that would climb out of the project is a deny, not a path", () => {
    const r = hook(bash("./tool publish ../../etc"));
    expect(r.status).toBe(2);
  });

  it("[N38] AG11 fails closed when CLAUDE_PROJECT_DIR is unset", () => {
    const r = spawnSync("/bin/sh", ["-c", `bash ${at(SCRIPT)}`], {
      input: bash("ls"), env: { PATH: process.env.PATH }, encoding: "utf8",
    });
    expect(r.status).toBe(2);
  });

  it("[N38] AG12 a gate with run: also runs its wrapper, and a failing check denies", () => {
    scaffold(topology("", `after: render\n      before: publish\n      ledger: trace\n      run: "scripts/check.sh"`));
    ledger("ep42", [rec("render", true, "ep42")]);
    // the scaffolded wrapper is a stub that blocks until it is written
    expect(hook(bash("./tool publish ep42")).status).toBe(2);
    fs.writeFileSync(at(".claude/skills/ship/scripts/check.sh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    expect(hook(bash("./tool publish ep42")).status).toBe(0);
    fs.writeFileSync(at(".claude/skills/ship/scripts/check.sh"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
    expect(hook(bash("./tool publish ep42")).status).toBe(2);
  });
});

describe("[N38] the language: records, ledger and unit-from", () => {
  it("[N38] AG13 parse and serialize round-trip", () => {
    const ast = parse(topology());
    expect(ast.records).toEqual([{ id: "trace", path: "logs/{unit}/trace.jsonl" }]);
    const publish = ast.nodes.find((n) => n.id === "publish") as { unitFrom?: string };
    expect(publish.unitFrom).toBe("./tool (?:re)?publish (\\S+)");
    const gate = ast.nodes.find((n) => n.id === "publish-ready") as { ledger?: string };
    expect(gate.ledger).toBe("trace");
    const again = parse(serialize(ast));
    expect(again.records).toEqual(ast.records);
    expect((again.nodes.find((n) => n.id === "publish") as { unitFrom?: string }).unitFrom).toBe(publish.unitFrom);
    expect((again.nodes.find((n) => n.id === "publish-ready") as { ledger?: string }).ledger).toBe("trace");
  });

  it("[N38] AG14 V102 accepts the new names and still refuses unknown ones", () => {
    const rules = (src: string) => validate(parse(src)).filter((r) => r.rule === "V102");
    expect(rules(topology())).toEqual([]);
    expect(rules(topology().replace("ledger: trace", "ledgr: trace")).length).toBe(1);
  });
});

describe("[N38] validation", () => {
  const findings = (src: string, rule: string) => validate(parse(src)).filter((r) => r.rule === rule);

  it("[N38] AG15 V25 no longer warns for a bounce-back gate before an action with commands, and still does for one without", () => {
    const bounce = (src: string) => src.replace("on-fail: halt", "on-fail: bounce-back");
    expect(findings(bounce(topology()), "V25")).toEqual([]);
    const noCommands = bounce(topology()).replace(/(action publish \{\n    kind: external\n)    commands: \[[^\]]*\]\n/, "$1");
    expect(findings(noCommands, "V25").length).toBe(1);
  });

  it("[N38] AG16 V110 warns when a gate before an action has neither ledger nor run:", () => {
    const src = topology().replace("records {\n    record trace { path: \"logs/{unit}/trace.jsonl\" }\n  }\n", "").replace("      ledger: trace\n", "");
    const hits = findings(src, "V110");
    expect(hits.length).toBe(1);
    expect(hits[0].level).toBe("warning");
    expect(hits[0].node).toBe("publish-ready");
    expect(findings(topology(), "V110")).toEqual([]);
  });

  it("[N38] AG17 V110 does not fire when the single record is the default ledger", () => {
    expect(findings(topology().replace("      ledger: trace\n", ""), "V110")).toEqual([]);
  });

  it("[N38] AG18 V111 errors on a unit-from that is not a regex or has no capture group", () => {
    const bad = findings(topology().replace(/unit-from: ".*"/, 'unit-from: "./tool (publish"'), "V111");
    expect(bad.length).toBe(1);
    expect(bad[0].level).toBe("error");
    const none = findings(topology().replace(/unit-from: ".*"/, 'unit-from: "./tool publish \\\\S+"'), "V111");
    expect(none.length).toBe(1);
    expect(none[0].message).toMatch(/capture group/);
    expect(findings(topology(), "V111")).toEqual([]);
  });

  it("[N38] AG19 V112 errors on a ledger that names no record", () => {
    const hits = findings(topology().replace("ledger: trace", "ledger: nope"), "V112");
    expect(hits.length).toBe(1);
    expect(hits[0].level).toBe("error");
    expect(hits[0].message).toContain("nope");
  });

  it("[N38] AG19 V112 errors on an unsafe record path, and allows {unit}", () => {
    expect(findings(topology().replace("logs/{unit}/trace.jsonl", "../{unit}/trace.jsonl"), "V112").length).toBe(1);
    expect(findings(topology().replace("logs/{unit}/trace.jsonl", "/abs/trace.jsonl"), "V112").length).toBe(1);
    expect(findings(topology(), "V112")).toEqual([]);
  });

  it("[N38] AG19 V112 errors when a gate needs a ledger, names none, and several records exist", () => {
    const two = topology().replace("  }\n  gates", '    record audit { path: "logs/audit.jsonl" }\n  }\n  gates').replace("      ledger: trace\n", "");
    const hits = findings(two, "V112");
    expect(hits.length).toBe(1);
    expect(hits[0].message).toMatch(/more than one record|which/);
  });
});

describe.skipIf(!hasJq)("[N38] guard --check", () => {
  it("[N38] AG20 reports refuse by hook when the Bash entry and the script's line are on disk, with the scope note", () => {
    const ast = scaffold(topology());
    const g = checkGuards(ast, root).items.find((i) => i.id === "publish-ready")!;
    expect(g).toMatchObject({ kind: "gate", strength: "refuse", by: "hook" });
    expect(g.notes.join(" ")).toContain("refuses in Claude Code sessions only; a step run outside Claude is covered by step check (by: code)");
  });

  it("[N38] AG20 reports none when the settings entry is gone", () => {
    const ast = scaffold(topology());
    const s = JSON.parse(fs.readFileSync(at(".claude/settings.json"), "utf8"));
    delete s.hooks;
    fs.writeFileSync(at(".claude/settings.json"), JSON.stringify(s));
    const g = checkGuards(ast, root).items.find((i) => i.id === "publish-ready")!;
    expect(g.strength).toBe("none");
  });

  it("[N38] AG20 reports none when the script has no line for the gate", () => {
    const ast = scaffold(topology());
    fs.writeFileSync(at(SCRIPT), "#!/usr/bin/env bash\nexit 0\n");
    expect(checkGuards(ast, root).items.find((i) => i.id === "publish-ready")!.strength).toBe("none");
  });
});

describe.skipIf(!hasJq)("[N42] before-action.sh sees a step inside a chained command", () => {
  beforeEach(() => { scaffold(topology()); });

  it("[N42] AG21 a step after cd, ;, ||, | or on a later line is refused while its gate is unmet", () => {
    for (const c of [
      "cd sub && ./tool publish ep1",
      "true; ./tool publish ep1",
      "make x || ./tool publish ep1",
      "./tool lint | ./tool publish ep1",
      "echo hi\n./tool publish ep1",
      "(cd sub && ./tool publish ep1)",
      "cd sub && DEBUG=1 time ./tool publish ep1",
      "{ ./tool publish ep1; }",
      "./tool lint & ./tool publish ep1",
    ]) {
      const r = hook(bash(c));
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toContain("publish-ready");
    }
  });

  it("[N42] AG22 with an ok record the chained step runs, and the unit is read from the right segment", () => {
    ledger("ep1", [rec("render", true, "ep1")]);
    expect(hook(bash("cd sub && ./tool publish ep1")).status).toBe(0);
    const r = hook(bash("cd sub && ./tool publish ep2"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("ep2");
  });

  it("[N42] AG23 a command word that is not at a segment start is not a step", () => {
    expect(hook(bash("echo ./tool publish ep1")).status).toBe(0);
    expect(hook(bash("cd sub && echo ./tool publish ep1")).status).toBe(0);
  });

  it("[N42] AG24 two guarded steps in one command need both gates", () => {
    const two = topology().replace(
      "  records {",
      '  action archive {\n    kind: external\n    commands: ["./tool archive"]\n    unit-from: "./tool archive (\\S+)"\n  }\n  records {',
    ).replace("  }\n  flow", "    gate archive-ready {\n      after: publish\n      before: archive\n      ledger: trace\n      on-fail: halt\n    }\n  }\n  flow");
    scaffold(two);
    const cmd = "./tool publish ep1 && ./tool archive ep1";
    ledger("ep1", [rec("render", true, "ep1")]);
    const r = hook(bash(cmd));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("archive-ready");
    ledger("ep1", [rec("publish", true, "ep1")]);
    const r2 = hook(bash(cmd));
    expect(r2.status).toBe(2);
    expect(r2.stderr).toContain("publish-ready");
    ledger("ep1", [rec("render", true, "ep1"), rec("publish", true, "ep1")]);
    const ok = hook(bash(cmd));
    expect(ok.stderr).toBe("");
    expect(ok.status).toBe(0);
  });

  it("[N42] AG25 guard --check notes that an indirect run is not seen", () => {
    const ast = scaffold(topology());
    const g = checkGuards(ast, root).items.find((i) => i.id === "publish-ready")!;
    expect(g.notes.join(" ")).toContain("a command that runs the step indirectly (bash -c, eval, a script that calls it) is not seen");
  });
});
