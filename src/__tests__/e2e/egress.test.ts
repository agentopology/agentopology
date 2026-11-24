/**
 * S-204: `egress { gate: <human-id | record-id>; covers: [observability, web, network, mcp] }`.
 *
 * Until the gate clears (the human's go row, or a row in the record), the covered tools are refused:
 * web = WebFetch and WebSearch; network = Bash commands that open a network connection by their first word
 * (curl, wget, nc, ncat, netcat, ssh, scp, sftp, telnet, ftp, rsync to a host, git push/fetch/pull/clone,
 * npm publish/install/i/ci/add); mcp = mcp__* tools; observability = the telemetry env is written only after
 * the clear. Every must-pass row: local commands (git status, git commit, npm test, ls) are not refused.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { serializeAST as serialize } from "../../import/serializer.js";

const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;

const OBS = `  observability {
    enabled: true
    exporter: otlp
    endpoint: "http://127.0.0.1:4318"
    service: "egress-probe"
  }
`;

function src(egress = "  egress {\n    gate: owner-go\n    covers: [observability, web, network, mcp]\n  }\n", obs = OBS, human = '    word: "go online"\n', recordPath = "logs/go.jsonl"): string {
  return `topology egressed : [pipeline, human-gate] {
  meta {
    version: "0.1.0"
    description: "Egress held until the go"
  }
  person owner {
  }
  orchestrator {
    model: opus
    handles: [draft, release]
  }
  action draft {
    kind: inline
    description: "Draft the release"
    commands: ["./tool draft"]
  }
  human owner-go {
    description: "The owner types go"
    who: owner
${human}  }
  action release {
    kind: external
    description: "Release"
    commands: ["./tool release"]
  }
  records {
    record go-ledger { path: "${recordPath}" }
  }
  gates {
    gate go-given {
      after: owner-go
      before: release
      ledger: go-ledger
      strength: refuse
    }
  }
${egress}${obs}  flow {
    draft -> owner-go
    owner-go -> release
  }
}
`;
}

const SCRIPTS = ".claude/skills/egressed/scripts";
let root: string;
const at = (p: string) => join(root, p);

function scaffold(s = src()) {
  const files = claudeCodeBinding.scaffold(parse(s));
  for (const f of files) {
    fs.mkdirSync(dirname(at(f.path)), { recursive: true });
    fs.writeFileSync(at(f.path), f.content);
    if (f.executable || f.path.endsWith(".sh")) fs.chmodSync(at(f.path), 0o755);
  }
  fs.mkdirSync(at("work/deep"), { recursive: true });
  return files;
}
const settings = () => JSON.parse(fs.readFileSync(at(".claude/settings.json"), "utf8"));

function run(command: string, stdin: string) {
  const base: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: root, AGENTOPOLOGY_TEST: "1" };
  delete base.AT_SESSION;
  return spawnSync("/bin/sh", ["-c", command], { cwd: at("work/deep"), input: stdin, env: base as NodeJS.ProcessEnv, encoding: "utf8", timeout: 20_000 });
}
function hookCmd(event: string, script: string): string {
  const e = (settings().hooks?.[event] ?? []).find((x: any) => x.hooks.some((h: any) => h.command.includes(script)));
  expect(e, `a ${event} entry for ${script}`).toBeTruthy();
  return e.hooks.find((h: any) => h.command.includes(script)).command;
}
const tool = (tool_name: string, tool_input: Record<string, unknown>) => JSON.stringify({ session_id: "s1", hook_event_name: "PreToolUse", tool_name, tool_input });
const bash = (command: string) => tool("Bash", { command });
const guard = (input: string) => run(hookCmd("PreToolUse", "egress-guard.sh"), input);
const type = (text: string) => run(hookCmd("UserPromptSubmit", "go-owner-go.sh"), JSON.stringify({ session_id: "s1", hook_event_name: "UserPromptSubmit", cwd: root, prompt: text }));

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-egress-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("[egress] grammar and validation", () => {
  it("egress { gate, covers } reads, round-trips and validates", () => {
    const ast = parse(src());
    expect(ast.egress).toEqual({ gate: "owner-go", covers: ["observability", "web", "network", "mcp"] });
    const r = validate(ast);
    expect(r.filter((x) => x.level === "error"), JSON.stringify(r)).toEqual([]);
    expect(r.filter((x) => x.rule === "V102" || x.rule === "V131")).toEqual([]);
    expect(parse(serialize(ast)).egress).toEqual(ast.egress);
  });

  it("a gate that is a record id validates", () => {
    const r = validate(parse(src("  egress {\n    gate: go-ledger\n    covers: [web]\n  }\n", "", '    word: "go online"\n')));
    expect(r.filter((x) => x.rule === "V160"), JSON.stringify(r)).toEqual([]);
  });

  it("a gate that names nothing is an error", () => {
    const r = validate(parse(src("  egress {\n    gate: nobody\n    covers: [web]\n  }\n")));
    const e = r.find((x) => x.rule === "V160" && x.level === "error");
    expect(e).toBeTruthy();
    expect(e!.message).toContain("nobody");
  });

  it("a gate that is a human with no word is an error", () => {
    const r = validate(parse(src(undefined, OBS, "")));
    const e = r.find((x) => x.rule === "V160" && x.level === "error");
    expect(e).toBeTruthy();
    expect(e!.message).toContain("word");
  });

  it("a gate that is a record whose path has {unit} is an error", () => {
    const r = validate(parse(src("  egress {\n    gate: go-ledger\n    covers: [web]\n  }\n", "", '    word: "go online"\n', "logs/{unit}.jsonl")));
    expect(r.some((x) => x.rule === "V160" && x.level === "error" && x.message.includes("{unit}"))).toBe(true);
  });

  it("covers that is empty, or names something else, is an error", () => {
    for (const covers of ["[]", "[files]", "[web, files]"]) {
      const r = validate(parse(src(`  egress {\n    gate: owner-go\n    covers: ${covers}\n  }\n`)));
      expect(r.some((x) => x.rule === "V160" && x.level === "error"), covers).toBe(true);
    }
  });

  it("an egress with no gate is an error", () => {
    const r = validate(parse(src("  egress {\n    covers: [web]\n  }\n")));
    expect(r.some((x) => x.rule === "V160" && x.level === "error")).toBe(true);
  });
});

describe("[egress] a topology without egress is unchanged", () => {
  it("writes no egress script or hook, and the telemetry env stays in settings.json", () => {
    const files = scaffold(src(""));
    expect(files.map((f) => f.path.replace(/^.*\//, "")).filter((p) => p.startsWith("egress-"))).toEqual([]);
    expect(JSON.stringify(settings().hooks)).not.toContain("egress-");
    expect(settings().env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
  });
});

describe("[egress] what is generated", () => {
  it("web, network and mcp write one PreToolUse guard; observability writes the env after the clear, not before", () => {
    const files = scaffold();
    const names = files.map((f) => f.path.replace(/^.*\//, ""));
    expect(names).toContain("egress-guard.sh");
    expect(names).toContain("egress-observability.sh");
    const pre = settings().hooks.PreToolUse.filter((x: any) => x.hooks.some((h: any) => h.command.includes("egress-guard.sh")));
    expect(pre).toHaveLength(1);
    expect(pre[0].hooks[0].onFailure).toBe("block");
    for (const t of ["WebFetch", "WebSearch", "Bash", "mcp__"]) expect(pre[0].matcher).toContain(t);
    expect(settings().env?.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined();
    expect(settings().env?.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    expect(JSON.stringify(settings().hooks.SessionStart)).toContain("egress-observability.sh");
  });

  it("covers: [web] alone writes a guard on WebFetch|WebSearch only, and leaves the telemetry env where it was", () => {
    scaffold(src("  egress {\n    gate: owner-go\n    covers: [web]\n  }\n"));
    const pre = settings().hooks.PreToolUse.find((x: any) => x.hooks.some((h: any) => h.command.includes("egress-guard.sh")));
    expect(pre.matcher).toBe("WebFetch|WebSearch");
    expect(settings().env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
    expect(fs.existsSync(at(`${SCRIPTS}/egress-observability.sh`))).toBe(false);
  });

  it("covers: [observability] alone writes no PreToolUse guard", () => {
    scaffold(src("  egress {\n    gate: owner-go\n    covers: [observability]\n  }\n"));
    expect(JSON.stringify(settings().hooks.PreToolUse ?? [])).not.toContain("egress-guard");
    expect(fs.existsSync(at(`${SCRIPTS}/egress-guard.sh`))).toBe(false);
  });
});

const LOCAL: Array<[string, string]> = [
  ["git status", "git status"],
  ["git commit", 'git commit -m "fetch the data, then push it later"'],
  ["npm test", "npm test"],
  ["ls", "ls"],
  ["grep x src", "grep x src"],
  ["git log, diff, add, branch", "git log --oneline && git diff && git add -A && git branch"],
  ["git -C sub status", "git -C sub status"],
  ["npm run build", "npm run build"],
  ["npx vitest run", "npx vitest run"],
  ["rsync between local folders", "rsync -a src/ dst/"],
  ["claude -p --agent x summarize", 'claude -p --agent x "summarize the logs"'],
  ["gh pr create --body naming curl", 'gh pr create --body "Stops curl; wget and ssh stay out"'],
  ["a for loop", "for f in a b c; do echo $f; done"],
  ["a heredoc to cat", "cat <<EOF\nhello\nEOF"],
  ["a heredoc to cat that mentions curl", "cat <<'EOF' > notes.md\ncurl https://example.com\nEOF"],
  ["command -v curl", "command -v curl"],
  ["echo curl", "echo curl"],
  ["which ssh", "which ssh"],
  ["a quoted semicolon", 'echo "a; curl x"'],
  ["a here-string", "cat <<< curl"],
];

describe.skipIf(!hasJq)("[egress] not cleared: local commands and local tools pass", () => {
  for (const [name, command] of LOCAL) {
    it(`passes ${name}`, () => {
      scaffold();
      const r = guard(bash(command));
      expect(r.status, r.stderr).toBe(0);
    });
  }

  it("passes the tools that are not covered: Read, Write, Edit, Grep, Glob, Agent", () => {
    scaffold();
    for (const [t, i] of [["Read", { file_path: "a.md" }], ["Write", { file_path: "a.md", content: "x" }], ["Edit", { file_path: "a.md" }], ["Grep", { pattern: "x" }], ["Glob", { pattern: "*" }], ["Agent", { prompt: "x" }]] as const) {
      const r = guard(tool(t, i));
      expect(r.status, `${t}: ${r.stderr}`).toBe(0);
    }
  });

  it("with covers: [web], a network command and an mcp tool pass", () => {
    scaffold(src("  egress {\n    gate: owner-go\n    covers: [web]\n  }\n"));
    expect(guard(bash("curl https://example.com")).status).toBe(0);
    expect(guard(tool("mcp__x__y", {})).status).toBe(0);
    expect(guard(tool("WebFetch", { url: "https://example.com" })).status).toBe(2);
  });
});

const NETWORK: Array<[string, string]> = [
  ["curl", "curl https://example.com"],
  ["wget", "wget https://example.com/a.tgz"],
  ["nc", "nc example.com 80"],
  ["ncat", "ncat example.com 80"],
  ["ssh", "ssh host ls"],
  ["scp", "scp a.txt host:/tmp/"],
  ["sftp", "sftp host"],
  ["rsync to a host", "rsync -a src/ user@host:/data/"],
  ["rsync with a url", "rsync -a rsync://host/mod/ dst/"],
  ["git push", "git push origin main"],
  ["git fetch", "git fetch --all"],
  ["git pull", "git pull"],
  ["git clone", "git clone https://example.com/r.git"],
  ["git -C d push", "git -C sub push"],
  ["git -c k=v push", "git -c http.proxy=x push"],
  ["npm publish", "npm publish"],
  ["npm install", "npm install left-pad"],
  ["npm i", "npm i"],
  ["npm ci", "npm ci"],
  ["after &&", "ls && curl https://example.com"],
  ["after a pipe", "echo hi | nc example.com 1"],
  ["after an assignment", "FOO=1 curl https://example.com"],
  ["after sudo", "sudo curl https://example.com"],
  ["after sudo -u", "sudo -u root curl https://example.com"],
  ["by path", "/usr/bin/curl https://example.com"],
  ["after timeout", "timeout 5 curl https://example.com"],
  ["after env", "env A=1 curl https://example.com"],
  ["after xargs", "echo x | xargs curl"],
  ["quoted letters", 'c"ur"l https://example.com'],
  ["in bash -c", 'bash -c "curl https://example.com"'],
  ["in eval", "eval curl https://example.com"],
  ["in a for loop", "for f in a b; do curl $f; done"],
  ["in a command substitution", "echo $(curl https://example.com)"],
  ["in a quoted command substitution", 'echo "$(curl https://example.com)"'],
  ["in backticks", "echo `curl https://example.com`"],
  ["on a second line", "ls\ncurl https://example.com"],
  ["in a heredoc fed to a shell", "bash <<EOF\ncurl https://example.com\nEOF"],
];

describe.skipIf(!hasJq)("[egress] not cleared: covered tools are refused", () => {
  for (const [name, command] of NETWORK) {
    it(`refuses ${name}`, () => {
      scaffold();
      const r = guard(bash(command));
      expect(r.status, command).toBe(2);
      expect(r.stderr).toContain("egress");
      expect(r.stderr).toContain("owner-go");
    });
  }

  it("refuses WebFetch, WebSearch and an MCP tool, naming the gate and the go word", () => {
    scaffold();
    for (const [t, i] of [["WebFetch", { url: "https://example.com" }], ["WebSearch", { query: "x" }], ["mcp__x__y", {}], ["mcp__github__get_me", {}]] as const) {
      const r = guard(tool(t, i));
      expect(r.status, t).toBe(2);
      expect(r.stderr).toContain("owner-go");
      expect(r.stderr).toContain("go online");
    }
  });

  it("a ledger that cannot be read does not clear it", () => {
    scaffold();
    fs.mkdirSync(at("logs"), { recursive: true });
    fs.writeFileSync(at("logs/go.jsonl"), "not json\n");
    expect(guard(bash("curl https://example.com")).status).toBe(2);
    expect(guard(bash("git status")).status).toBe(0);
  });

  it("another step's row does not clear it", () => {
    scaffold();
    fs.mkdirSync(at("logs"), { recursive: true });
    fs.writeFileSync(at("logs/go.jsonl"), '{"step":"draft","ok":true}\n');
    expect(guard(tool("WebFetch", { url: "https://example.com" })).status).toBe(2);
  });
});

describe.skipIf(!hasJq)("[egress] cleared by the human's go row", () => {
  it("after the typed go word every covered tool passes", () => {
    scaffold();
    expect(guard(bash("curl https://example.com")).status).toBe(2);
    expect(type("go online").status).toBe(0);
    for (const [, command] of NETWORK) {
      const r = guard(bash(command));
      expect(r.status, `${command}: ${r.stderr}`).toBe(0);
    }
    expect(guard(tool("WebFetch", { url: "https://example.com" })).status).toBe(0);
    expect(guard(tool("mcp__x__y", {})).status).toBe(0);
  });

  it("a later row of the same step that is not ok holds it again", () => {
    scaffold();
    type("go online");
    fs.appendFileSync(at("logs/go.jsonl"), '{"step":"owner-go","ok":false,"halt":true}\n');
    expect(guard(bash("git push")).status).toBe(2);
  });
});

describe.skipIf(!hasJq)("[egress] cleared by a row in the record", () => {
  it("is refused with no row, passes once the record holds a row", () => {
    // the topology already has a records block: put the second record in it
    const s = src("  egress {\n    gate: clearance\n    covers: [web, network, mcp]\n  }\n", "").replace('record go-ledger { path: "logs/go.jsonl" }', 'record go-ledger { path: "logs/go.jsonl" }\n    record clearance { path: "logs/clear.jsonl" }');
    expect(validate(parse(s)).filter((x) => x.level === "error"), JSON.stringify(validate(parse(s)))).toEqual([]);
    scaffold(s);
    expect(guard(bash("git push")).status).toBe(2);
    expect(guard(tool("WebSearch", { query: "x" })).status).toBe(2);
    expect(guard(bash("git status")).status).toBe(0);
    fs.mkdirSync(at("logs"), { recursive: true });
    fs.writeFileSync(at("logs/clear.jsonl"), '{"step":"approve","ok":true,"ts":"2026-11-24T10:00:00Z"}\n');
    expect(guard(bash("git push")).status).toBe(0);
    expect(guard(tool("WebSearch", { query: "x" })).status).toBe(0);
  });
});

describe.skipIf(!hasJq)("[egress] observability: the telemetry env is written only after the clear", () => {
  const obs = () => run(hookCmd("SessionStart", "egress-observability.sh"), JSON.stringify({ session_id: "s1", hook_event_name: "SessionStart", source: "startup" }));
  const local = () => (fs.existsSync(at(".claude/settings.local.json")) ? JSON.parse(fs.readFileSync(at(".claude/settings.local.json"), "utf8")) : null);

  it("not cleared: nothing is written, and the hook never blocks", () => {
    scaffold();
    const r = obs();
    expect(r.status, r.stderr).toBe(0);
    expect(local()).toBeNull();
  });

  it("cleared: the telemetry keys go to settings.local.json env, next to what is already there", () => {
    scaffold();
    fs.writeFileSync(at(".claude/settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] }, env: { MINE: "1" } }));
    type("go online");
    const r = obs();
    expect(r.status, r.stderr).toBe(0);
    const l = local();
    expect(l.env).toMatchObject({ MINE: "1", CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318", OTEL_METRICS_EXPORTER: "otlp" });
    expect(l.permissions).toEqual({ allow: ["Bash(ls:*)"] });
  });

  it("cleared: running it twice writes the same file", () => {
    scaffold();
    type("go online");
    obs();
    const a = fs.readFileSync(at(".claude/settings.local.json"), "utf8");
    obs();
    expect(fs.readFileSync(at(".claude/settings.local.json"), "utf8")).toBe(a);
  });

  it("a settings.local.json that is not JSON is left alone", () => {
    scaffold();
    fs.writeFileSync(at(".claude/settings.local.json"), "{ not json");
    type("go online");
    const r = obs();
    expect(r.status).toBe(0);
    expect(fs.readFileSync(at(".claude/settings.local.json"), "utf8")).toBe("{ not json");
  });
});
