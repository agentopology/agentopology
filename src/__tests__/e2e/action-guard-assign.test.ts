/**
 * before-action.sh reads a lower-case variable the command itself sets to a plain literal at its
 * start (`t=/x; tool open $t build && tool enter map`) as that literal: the step's words are then
 * read as written, and a command that names no gated step runs without running the gate checks.
 * Every other shape of assignment stays unreadable, and the gate checks run as before: an
 * upper-case or underscore name (bash sets several itself: $_, FUNCNAME, REPLY, PWD, ...), and
 * any command with something that can change a variable between its assignment and its use.
 *
 * The gate's check script appends a line to a marker file, so each row can tell whether the
 * gate ran.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { MATCH_FUNCTIONS } from "../../bindings/lib/guards.js";

const topology = `topology ship : [pipeline] {
  meta { version: "1.0.0" description: "Open then accept" }
  orchestrator { model: sonnet handles: [open, accept] }
  action open {
    kind: external
    commands: ["python3 tools/runstate.py open"]
  }
  action accept {
    kind: external
    commands: ["python3 tools/runstate.py enter accept"]
  }
  gates {
    gate accept-ready {
      after: open
      before: accept
      run: "scripts/check.sh"
      on-fail: halt
    }
  }
  flow { open -> accept }
}
`;

const SCRIPT = ".claude/skills/ship/scripts/before-action.sh";
const X = "python3 tools/runstate.py";
/** The longest command at_resolve reads (characters), and the most leading assignments; past either it stays doubted. */
const MAX_LEN = 1024;
const MAX_NAMES = 16;
let root: string;
let marker: string;

beforeAll(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), "at-guard-assign-"));
  marker = join(root, "gate-ran");
  for (const f of claudeCodeBinding.scaffold(parse(topology))) {
    fs.mkdirSync(dirname(join(root, f.path)), { recursive: true });
    fs.writeFileSync(join(root, f.path), f.content);
    if (f.executable) fs.chmodSync(join(root, f.path), 0o755);
  }
  fs.writeFileSync(join(root, ".claude/skills/ship/scripts/check.sh"), `#!/usr/bin/env bash\necho ran >> '${marker}'\nexit 0\n`, { mode: 0o755 });
  fs.mkdirSync(join(root, "src/deep"), { recursive: true });
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
beforeEach(() => fs.rmSync(marker, { force: true }));

function run(command: string) {
  fs.rmSync(marker, { force: true });
  const t0 = performance.now();
  const r = spawnSync("/bin/sh", ["-c", `bash "$CLAUDE_PROJECT_DIR/${SCRIPT}"`], {
    cwd: join(root, "src/deep"),
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    encoding: "utf8",
    timeout: 20_000,
  });
  const ms = performance.now() - t0;
  return { status: r.status, stderr: r.stderr, ms, gateRan: fs.existsSync(marker) };
}

describe("a literal assignment at the command's start is read as its value", () => {
  it("the measured shape, with a lower-case name: an assignment, a step that is not gated, && another: no gate runs, under 1 s", () => {
    // best of up to 5 runs, as in the speed test: the full suite loads every core
    const cmd = `t=/x; ${X} open $t build && ${X} enter map`;
    let r = run(cmd);
    for (let i = 1; i < 5 && r.ms >= 1000; i++) {
      spawnSync("sleep", ["0.3"]);
      const again = run(cmd);
      if (again.ms < r.ms) r = again;
    }
    console.log(`[resolved] the measured shape: ${Math.round(r.ms)} ms, exit ${r.status}, gate ${r.gateRan ? "ran" : "not run"}`);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.gateRan).toBe(false);
    expect(r.ms).toBeLessThan(1000);
  });

  const resolved: [string, string][] = [
    ["; then $t", `t=/x; ${X} enter $t`],
    ["&& then \${t}", `t=/x && ${X} enter \${t}`],
    ["a newline then $t", `t=/x\n${X} enter $t`],
    ["two assignments, both used", `a=/x; b=map; ${X} $b $a`],
    ["the value quoted where it is used", `t=/x; ${X} enter "$t"`],
    ["a name with digits and underscores", `run_dir2=/x; ${X} enter $run_dir2`],
  ];
  for (const [shape, command] of resolved) {
    it(`resolved, no gated step named: ${shape}`, () => {
      const r = run(command);
      expect(r.status).toBe(0);
      expect(r.gateRan).toBe(false);
    });
  }
});

describe("a resolved value that names the step is still the step", () => {
  const literal = run.bind(null);
  const caught: [string, string][] = [
    ["s=accept; tool enter $s", `s=accept; ${X} enter $s`],
    ["s=accept && tool enter \${s}", `s=accept && ${X} enter \${s}`],
    ["a=enter; b=accept; tool $a $b", `a=enter; b=accept; ${X} $a $b`],
    ["a newline between", `s=accept\n${X} enter $s`],
    ["the value joined to more letters", `s=acc; ${X} enter \${s}ept`],
  ];
  for (const [shape, command] of caught) {
    it(`caught like the literal command: ${shape}`, () => {
      const plain = literal(`${X} enter accept`);
      expect(plain.gateRan).toBe(true);
      const r = run(command);
      expect(r.gateRan).toBe(true);
      expect(r.status).toBe(plain.status);
    });
  }

  it("a failing check blocks the resolved form the way it blocks the literal one", () => {
    const check = join(root, ".claude/skills/ship/scripts/check.sh");
    const before = fs.readFileSync(check, "utf8");
    try {
      fs.writeFileSync(check, `#!/usr/bin/env bash\necho ran >> '${marker}'\nexit 1\n`, { mode: 0o755 });
      expect(run(`${X} enter accept`).status).toBe(2);
      const r = run(`s=accept; ${X} enter $s`);
      expect(r.gateRan).toBe(true);
      expect(r.status).toBe(2);
    } finally {
      fs.writeFileSync(check, before, { mode: 0o755 });
    }
  });
});

describe("every other assignment stays unreadable: the gate checks run", () => {
  const doubted: [string, string][] = [
    ["a reassignment later in the command", `t=/x; ${X} enter $t; t=/y`],
    ["an assignment inside a subshell", `( t=/x; ${X} enter $t )`],
    ["an assignment as a pipeline stage", `t=/x | ${X} enter $t`],
    ["a prefix assignment", `t=/x ${X} enter $t`],
    ["a conditional assignment", `false && t=/x; ${X} enter $t`],
    ["export t=x", `export t=/x; ${X} enter $t`],
    ["a value with $", `t=$HOME; ${X} enter $t`],
    ["a value with a glob", `t=/x*; ${X} enter $t`],
    ["a quoted value with a space", `t="/x y"; ${X} enter $t`],
    ["an assignment after the step's tool word", `${X} open; t=/x; ${X} enter $t`],
    ["t=/x; t=enter ...", `t=/x; t=enter; ${X} $t accept`],
    ["the same name assigned twice", `t=/x; t=/x; ${X} enter $t`],
    ["the name read into later", `t=/x; read t < f; ${X} enter $t`],
    ["eval in the command", `t=/x; eval "$y"; ${X} enter $t`],
    ["a program named by an expansion", `t=/x; $p; ${X} enter $t`],
    ["IFS set in the command", `t=/x; IFS=/; ${X} enter $t`],
    ["a ${t:-default} use", `t=/x; ${X} enter \${t:-accept}`],
    ["a single & after the assignment", `t=/x & ${X} enter $t`],
    ["|| after the assignment", `t=/x || ${X} enter $t`],
    ["eval behind time -p, the name built from other letters", `t=/x; m=tz; time -p eval "\${m:0:1}=accept"; ${X} enter $t`],
    ["eval written with quotes inside it", `t=/x; e''val "$y"; ${X} enter $t`],
    ["source", `t=/x; source ./env.sh; ${X} enter $t`],
    ["the dot command", `t=/x; . ./env.sh; ${X} enter $t`],
    ["printf -v", `t=/x; printf -v "$n" accept; ${X} enter $t`],
    ["declare with a built name", `t=/x; declare "$n=accept"; ${X} enter $t`],
    ["a function that sets the name", `t=/x; f() { t=accept; }; f; ${X} enter $t`],
    ["a loop over the name", `t=/x; for t in accept; do ${X} enter $t; done`],
    ["the name inside another value", `a=t; t=/x; ${X} enter $t`],
    ["[[ ]] in the command", `t=/x; [[ $n -eq 1 ]]; ${X} enter $t`],
  ];
  for (const [shape, command] of doubted) {
    it(`doubted: ${shape}`, () => {
      const r = run(command);
      expect(r.gateRan).toBe(true);
    });
  }
});

describe("names bash sets itself, and commands that can change a variable without naming it, stay doubted", () => {
  const doubted: [string, string][] = [
    // names bash sets: only lower-case names are read, and these are never read
    ["$_ after `: accept`", `_=x; : accept; ${X} enter $_`],
    ["$_ after `true accept &&`", `_=x; true accept && ${X} enter $_`],
    ["$_ after the step's own --help", `_=x; ${X} enter accept --help; ${X} enter $_`],
    ["FUNCNAME inside a function named accept", `FUNCNAME=x; accept() { ${X} enter $FUNCNAME; }; accept`],
    ["REPLY set by select", `REPLY=x; select y in a; do ${X} enter $REPLY; break; done <<< accept`],
    ["PWD after cd", `PWD=/x; cd /tmp && ${X} enter $PWD`],
    ["DIRSTACK after pushd", `DIRSTACK=x; pushd /tmp; ${X} enter $DIRSTACK`],
    ["an upper-case name", `T=/x; ${X} enter $T`],
    // commands that stop resolution for every name
    ["cd anywhere", `t=/x; cd /tmp; ${X} enter $t`],
    ["pushd anywhere", `t=/x; pushd /tmp; ${X} enter $t`],
    ["popd anywhere", `t=/x; popd; ${X} enter $t`],
    ["select anywhere", `t=/x; select y in a; do break; done; ${X} enter $t`],
    ["a function definition with ()", `t=/x; g() { :; }; ${X} enter $t`],
    ["a function definition with the keyword", `t=/x; function g { :; }; ${X} enter $t`],
    ["shopt", `t=/x; shopt -s expand_aliases; ${X} enter $t`],
    ["compgen -V with a built name", `t=/x; compgen -V "$w" -W accept; ${X} enter $t`],
    // arithmetic can assign to a name held in another variable's value
    ["(( )) on a variable", `t=/x; v=$'\\x74=5'; (( v )); ${X} enter $t`],
    ["$(( ))", `t=/x; echo $(( v )); ${X} enter $t`],
    ["$[ ]", `t=/x; echo $[ v ]; ${X} enter $t`],
    ["an array subscript in an assignment", `t=/x; a[v]=1; ${X} enter $t`],
    ["an array subscript in an expansion", `t=/x; echo \${a[v]}; ${X} enter $t`],
    ["a substring offset", `t=/x; echo \${s:v}; ${X} enter $t`],
    ["[ -v ] with a subscript", `t=/x; [ -v "a[v]" ]; ${X} enter $t`],
    ["test -v with a built name", `t=/x; test -v "$k"; ${X} enter $t`],
    ["a $'...' string", `t=/x; echo $'\\x61'; ${X} enter $t`],
    // already doubted before this change; kept as rows so they stay so
    ["declare -n through another name", `t=/x; declare -n r="$w"; r=accept; ${X} enter $t`],
    ["mapfile into a built name", `t=/x; mapfile -t "$w" <<< accept; ${X} enter $t`],
    ["getopts into a built name", `t=/x; getopts a "$w"; ${X} enter $t`],
    ["an alias", `t=/x; alias g='read -r t'; ${X} enter $t`],
    ["a trap", `t=/x; trap "$c" DEBUG; ${X} enter $t`],
    ["coproc", `t=/x; coproc cat; ${X} enter $t`],
    ["let", `t=/x; let "$v"; ${X} enter $t`],
    ["wait -p", `t=/x; wait -p "$w"; ${X} enter $t`],
    ["a {name}> redirection", `t=/x; : {t}>/dev/null; ${X} enter $t`],
    ["\${!ref}", `t=/x; echo \${!r}; ${X} enter $t`],
  ];
  for (const [shape, command] of doubted) {
    it(`doubted: ${shape}`, () => {
      const r = run(command);
      expect(r.gateRan).toBe(true);
    });
  }
});

describe("a use the parent shell does not expand, or a child that can see another value, stays doubted", () => {
  const doubted: [string, string][] = [
    // a child shell expands $ab from an environment the command sets under another spelling
    ["env a\"\"b=... bash -c '... $ab'", `ab=x; env a""b=accept bash -c '${X} enter $ab'`],
    ["env a''b=... bash -c '... $ab'", `ab=x; env a''b=accept bash -c '${X} enter $ab'`],
    ["env a\\b=... bash -c '... $ab'", `ab=x; env a\\b=accept bash -c '${X} enter $ab'`],
    ["env a\"\"b=... sh -c '... ${ab}'", `ab=x; env a""b=accept sh -c '${X} enter \${ab}'`],
    ["a here-doc with a quoted delimiter fed to bash", `ab=x; env a""b=accept bash <<'EOF'\n${X} enter $ab\nEOF`],
    ["sudo VAR=... sh -c", `ab=x; sudo a""b=accept sh -c '${X} enter $ab'`],
    ["\\$ab inside double quotes fed to bash -c", `ab=x; env a""b=accept bash -c "${X} enter \\$ab"`],
    ["docker -e", `ab=x; docker run -e a""b=accept img sh -c '${X} enter $ab'`],
    // the parent never expands these uses
    ["$ab inside single quotes", `ab=x; ${X} enter '$ab'`],
    ["\\$ab", `ab=x; ${X} enter \\$ab`],
    ["\\$ab inside double quotes", `ab=x; ${X} enter "\\$ab"`],
    ["double quotes inside single quotes", `ab=x; ${X} enter '"$ab"'`],
    ["a here-doc anywhere", `ab=x; ${X} enter $ab <<EOF\nz\nEOF`],
    // a child that can run a shell, or code given on the command line
    ["find -exec with a shell spelled apart", `ab=x; find . -exec s""h -c '${X} enter $ab' \\;`],
    ["busybox sh", `ab=x; busybox sh -c '${X} enter $ab'`],
    ["xargs", `ab=x; echo accept | xargs -I{} ${X} enter $ab`],
    ["nohup", `ab=x; nohup ${X} enter $ab`],
    ["time", `ab=x; time ${X} enter $ab`],
    ["python3 -c", `ab=x; python3 -c "import os; os.system('${X} enter $ab')"`],
    ["node -e", `ab=x; node -e "require('child_process').execSync('${X} enter $ab')"`],
    ["perl -e", `ab=x; perl -e 'system("${X} enter $ab")'`],
    ["a name spelled apart in a prefix assignment", `ab=x; a""b=accept ${X} enter $ab`],
    ["a shell with a version in its name", `ab=x; /usr/bin/e""nv a""b=accept bash5.2 -c '${X} enter $ab'`],
    ["a shell named .exe", `ab=x; bash.exe -c "${X} enter \\$ab"`],
    ["a here-doc with an escaped delimiter", `ab=x; cat <<\\EOF | sh\n${X} enter $ab\nEOF`],
    ["a here-doc with <<-", `ab=x; sh <<-"EOF"\n\t${X} enter $ab\n\tEOF`],
  ];
  for (const [shape, command] of doubted) {
    it(`doubted: ${shape}`, () => {
      const r = run(command);
      expect(r.gateRan).toBe(true);
    });
  }

  const resolved: [string, string][] = [
    ["single quotes elsewhere in the command", `t=/x; ${X} enter $t 'q r'`],
    ["the interpreter of the step itself, with a flag", `t=/x; python3 -u tools/runstate.py enter $t`],
  ];
  for (const [shape, command] of resolved) {
    it(`still resolved: ${shape}`, () => {
      const r = run(command);
      expect(r.gateRan).toBe(false);
    });
  }
});

describe("a word that can set a variable anywhere in the command, or a $ that is not a read name, stays doubted", () => {
  const doubted: [string, string][] = [
    // a setter behind a builtin that runs another builtin, the name built from a read part
    ["jobs -x eval a$q=", `ab=x; q=b; jobs -x eval a$q=accept; ${X} enter $ab`],
    ["jobs -x read a$q", `ab=x; q=b; jobs -x read a$q <<< accept; ${X} enter $ab`],
    ["jobs -x printf -v a$q", `ab=x; q=b; jobs -x printf -v a$q accept; ${X} enter $ab`],
    ["jobs -x eval a$q= joined with &&", `ab=x && q=b && jobs -x eval a$q=accept && ${X} enter $ab`],
    ["builtin eval a$q=", `ab=x; q=b; builtin eval a$q=accept; ${X} enter $ab`],
    ["command read a$q", `ab=x; q=b; command read a$q <<< accept; ${X} enter $ab`],
    ["caller before eval a$q=", `ab=x; q=b; caller eval a$q=accept; ${X} enter $ab`],
    ["a$q= with no wrapper", `ab=x; q=b; a$q=accept; ${X} enter $ab`],
    ["jobs -x with the dot command", `ab=x; jobs -x . ./env.sh; ${X} enter $ab`],
    ["a setter word as a later argument", `ab=x; ${X} enter $ab; echo read`],
    // a setter or a name built at run time
    ["backticks that build eval and the name", "ab=x; `printf %s%s ev al` a`printf b`=accept; " + `${X} enter $ab`],
    ["$(...) that builds eval and the name", `ab=x; $(printf eval) a$(printf b)=accept; ${X} enter $ab`],
    ["a glob that can match eval", `ab=x; ev?l a?=accept; ${X} enter $ab`],
    ["a brace list that makes eval", `ab=x; {e,}val a{b,}=accept; ${X} enter $ab`],
    // a $ that is not a use of a read name, in another segment than the step
    ["a name not assigned in the command", `ab=x; echo $HOME; ${X} enter $ab`],
    ["a positional", `ab=x; echo $1; ${X} enter $ab`],
    ["$?", `ab=x; echo $?; ${X} enter $ab`],
    ["$$", `ab=x; echo $$; ${X} enter $ab`],
    ["$@", `ab=x; echo "$@"; ${X} enter $ab`],
    ["$#, $!, $-", `ab=x; echo $# $! $-; ${X} enter $ab`],
    ["an upper-case name assigned beside it", `ab=x; T=y; echo $T; ${X} enter $ab`],
    // the command as read is checked again: a read part that spells another read name
    ["a read part that spells another read name", `ab=x; q=b; ${X} enter a$q $ab`],
    // a setter written so that only the shell sees it as one
    ["a setter with a backslash in it", `ab=x; q=b; r\\ead a$q <<< accept; ${X} enter $ab`],
    ["a setter by a path", `ab=x; q=b; /x/read a$q <<< accept; ${X} enter $ab`],
    ["wait -p behind jobs -x", `ab=x; q=b; jobs -x wait -n -p a$q; ${X} enter $ab`],
    ["fc -s", `ab=x; fc -s; ${X} enter $ab`],
    ["bind -x", `ab=x; bind -x '"a": read ab'; ${X} enter $ab`],
    ["a ~ word", `ab=x; echo ~q; ${X} enter $ab`],
    ["--opt=$ab: a $ in a word with =", `ab=x; ${X} enter --opt=$ab`],
  ];
  for (const [shape, command] of doubted) {
    it(`doubted: ${shape}`, () => {
      const r = run(command);
      expect(r.gateRan).toBe(true);
    });
  }
});

describe("resolution has a size limit: a longer command stays doubted", () => {
  /** `t=/x; tool enter $t $t ...`, padded with uses (and one filler) to exactly `len` characters. */
  const ofLength = (len: number) => {
    let c = `t=/x; ${X} enter`;
    while (c.length + 3 <= len - 2) c += " $t";
    return (c + " " + "z".repeat(len - c.length - 1)).slice(0, len);
  };

  it(`at the limit (${MAX_LEN} characters, mostly $t uses): resolved, no gate, under 1 s`, () => {
    const cmd = ofLength(MAX_LEN);
    expect(cmd.length).toBe(MAX_LEN);
    // best of up to 5 runs, as in the speed test: the full suite loads every core
    let r = run(cmd);
    for (let i = 1; i < 5 && r.ms >= 1000; i++) {
      spawnSync("sleep", ["0.3"]);
      const again = run(cmd);
      if (again.ms < r.ms) r = again;
    }
    console.log(`[cap] ${MAX_LEN} characters: ${Math.round(r.ms)} ms, exit ${r.status}, gate ${r.gateRan ? "ran" : "not run"}`);
    expect(r.gateRan).toBe(false);
    expect(r.ms).toBeLessThan(1000);
  });

  it(`one character past it (${MAX_LEN + 1}): doubted, the gate runs, under 1 s`, () => {
    const cmd = ofLength(MAX_LEN + 1);
    expect(cmd.length).toBe(MAX_LEN + 1);
    const r = run(cmd);
    console.log(`[cap] ${MAX_LEN + 1} characters: ${Math.round(r.ms)} ms, exit ${r.status}, gate ${r.gateRan ? "ran" : "not run"}`);
    expect(r.gateRan).toBe(true);
    expect(r.ms).toBeLessThan(1000);
  });

  it("the reading alone, on the costliest shapes at the limit, takes under 0.3 s", () => {
    const fill = (head: string, use: (i: number) => string) => {
      let c = `${head}${X} enter`;
      for (let i = 0; c.length + use(i).length + 1 <= MAX_LEN; i++) c += " " + use(i);
      return c;
    };
    const heads16 = Array.from({ length: MAX_NAMES }, (_, i) => `n${i}=/x; `).join("");
    const shapes: [string, string][] = [
      ["one name, $t uses", fill("t=/x; ", () => "$t")],
      ["one name, ${t} uses", fill("t=/x; ", () => "${t}")],
      ["one name, $t joined uses", fill("t=/x; ", () => "$t$t$t$t$t$t$t$t")],
      [`${MAX_NAMES} names, their uses in turn`, fill(heads16, (i) => `$n${i % MAX_NAMES}`)],
      ["one name, a segment per use", fill("t=/x; ", () => "; : $t")],
      // a single quote in the command: the reading follows the quotes
      ["one name, $t uses after a single-quoted word", fill("t=/x; echo 'q'; ", () => "$t")],
      ["one name, \"$t\" uses after a single-quoted word", fill("t=/x; echo 'q'; ", () => "\"$t\"")],
      ["one name, '$t' and $t in turn", fill("t=/x; ", (i) => (i % 2 ? "'$t'" : "$t"))],
    ];
    const slow: string[] = [];
    for (const [shape, cmd] of shapes) {
      expect(cmd.length).toBeLessThanOrEqual(MAX_LEN);
      // best of up to 5 runs, a short pause before each retry: the full suite loads every core
      let best = Infinity;
      let runs = 0;
      for (let i = 0; i < 5 && best >= 300; i++) {
        if (i > 0) spawnSync("sleep", ["0.3"]);
        const r = spawnSync("bash", ["-c", `${MATCH_FUNCTIONS.join("\n")}\nTIMEFORMAT=%3R; time at_resolve "$1" >/dev/null`, "at", cmd], { encoding: "utf8" });
        best = Math.min(best, Number(r.stderr.trim().split("\n").pop()) * 1000);
        runs = i + 1;
      }
      const row = `[cap] at_resolve alone, ${shape}, ${cmd.length} characters: ${Math.round(best)} ms (best of ${runs})`;
      console.log(row);
      if (!(best < 300)) slow.push(row);
    }
    expect(slow).toEqual([]);
  });

  const names = (k: number) => Array.from({ length: k }, (_, i) => `n${i}=/x; `).join("") + `${X} enter ` + Array.from({ length: k }, (_, i) => `$n${i}`).join(" ");

  it(`${MAX_NAMES} leading assignments: resolved, no gate`, () => {
    const r = run(names(MAX_NAMES));
    console.log(`[cap] ${MAX_NAMES} names: ${Math.round(r.ms)} ms, gate ${r.gateRan ? "ran" : "not run"}`);
    expect(r.gateRan).toBe(false);
  });

  it(`${MAX_NAMES + 1} leading assignments: doubted, the gate runs`, () => {
    const r = run(names(MAX_NAMES + 1));
    console.log(`[cap] ${MAX_NAMES + 1} names: ${Math.round(r.ms)} ms, gate ${r.gateRan ? "ran" : "not run"}`);
    expect(r.gateRan).toBe(true);
  });
});
