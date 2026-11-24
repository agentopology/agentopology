/**
 * A step gate recognises the agentopology CLI however a command names it: bare, at a path, with a
 * version or a tag (`agentopology@0.13.1`, `agentopology@latest`), through a package runner (npx, pnpm dlx,
 * pnpm exec, yarn dlx, bunx, npm exec --) or through an `npm:` alias. A command is fed to the generated
 * before-action.sh only; nothing is run.
 *
 * Two fixtures: three topologies (plain, ledger, go word) whose gated step runs `agentopology scaffold`,
 * and one with two step gates (a human go word before a scaffold step, a signed record before a validate step).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";

const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;

const SCAFFOLD_STEP = "agentopology scaffold";

const PLAIN = `topology plain : [pipeline] {
  meta { version: "0.1.0" description: "One gate before a scaffold step" }
  orchestrator { model: opus handles: [build, apply] }
  action build {
    kind: inline
    description: "Build"
    commands: ["npm run build"]
  }
  action apply {
    kind: external
    description: "Apply"
    commands: ["${SCAFFOLD_STEP}"]
  }
  gates {
    gate built {
      after: build
      before: apply
      run: "scripts/check.sh"
      strength: refuse
    }
  }
  flow { build -> apply }
}
`;

const LEDGER = `topology led : [pipeline] {
  meta { version: "0.1.0" description: "A ledger gate before a scaffold step" }
  orchestrator { model: opus handles: [draft, apply] }
  action draft {
    kind: inline
    description: "Draft"
    commands: ["./tool draft"]
  }
  action apply {
    kind: external
    description: "Apply"
    commands: ["${SCAFFOLD_STEP}"]
  }
  records {
    record run-ledger { path: "logs/run.jsonl" }
  }
  gates {
    gate drafted {
      after: draft
      before: apply
      ledger: run-ledger
      strength: refuse
    }
  }
  flow { draft -> apply }
}
`;

const GO = `topology go-apply : [pipeline, human-gate] {
  meta { version: "0.1.0" description: "A human go word before a scaffold step" }
  person owner {
  }
  orchestrator { model: opus handles: [draft, apply] }
  action draft {
    kind: inline
    description: "Draft"
    commands: ["./tool draft"]
  }
  human owner-go {
    description: "The owner types go before the apply"
    who: owner
    word: "go apply"
  }
  action apply {
    kind: external
    description: "Apply"
    commands: ["${SCAFFOLD_STEP}"]
  }
  records {
    record go-ledger { path: "logs/go.jsonl" }
  }
  gates {
    gate go-before-apply {
      after: owner-go
      before: apply
      ledger: go-ledger
      strength: refuse
    }
  }
  flow {
    draft -> owner-go
    owner-go -> apply
  }
}
`;

/** Two step gates: a human go word before a scaffold step, a signed record before a validate step. */
const TWO = `topology two-gates : [pipeline, human-gate] {
  meta { version: "0.1.0" description: "A go word before a scaffold step and a signed record before a validate step" }
  person owner {
  }
  orchestrator { model: opus handles: [draft, apply, sign, build] }
  action draft {
    kind: inline
    description: "Draft"
    commands: ["./tool draft"]
  }
  human owner-go {
    description: "The owner types go before the apply"
    who: owner
    word: "go apply"
  }
  action apply {
    kind: external
    description: "Apply"
    commands: ["${SCAFFOLD_STEP}"]
  }
  action sign {
    kind: inline
    description: "Sign the gated file"
    commands: ["./tool sign"]
  }
  action build {
    kind: external
    description: "Build from the gated file"
    commands: ["agentopology validate"]
  }
  records {
    record go-ledger { path: "logs/go.jsonl" }
    record sign-ledger { path: "logs/sign.jsonl" }
  }
  gates {
    gate go-before-apply {
      after: owner-go
      before: apply
      ledger: go-ledger
      strength: refuse
    }
    gate signed-before-build {
      after: sign
      before: build
      ledger: sign-ledger
      strength: refuse
    }
  }
  flow {
    draft -> owner-go
    owner-go -> apply
    apply -> sign
    sign -> build
  }
}
`;

/** The two-gate fixture with a write gate over every .at file: its read list and the step gates answer different questions. */
const BOTH = TWO.replace("topology two-gates", "topology both-gates").replace(
  "  gates {\n",
  `  gates {
    gate at-open {
      after: owner-go
      before: write "**/*.at"
      ledger: go-ledger
      strength: refuse
    }
`,
);

const roots = new Map<string, string>();

function scaffold(src: string): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), "at-versioned-"));
  for (const f of claudeCodeBinding.scaffold(parse(src))) {
    fs.mkdirSync(dirname(join(root, f.path)), { recursive: true });
    fs.writeFileSync(join(root, f.path), f.content);
    if (f.executable || f.path.endsWith(".sh")) fs.chmodSync(join(root, f.path), 0o755);
  }
  for (const d of ["build", "logs", "src", "docs", "sub"]) fs.mkdirSync(join(root, d), { recursive: true });
  for (const f of ["package.json", "probe.at", "gated.at", "logs/run.jsonl", "logs/go.jsonl", "logs/sign.jsonl"]) fs.writeFileSync(join(root, f), "x\n");
  return root;
}

function action(root: string, name: string, command: string) {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: root };
  delete env.AT_SESSION;
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", cwd: root, tool_name: "Bash", tool_input: { command } });
  return spawnSync("bash", [join(root, `.claude/skills/${name}/scripts/before-action.sh`)], { cwd: root, input: payload, env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout: 20_000 });
}

function off(name: string, rows: readonly string[], want: number): string[] {
  const root = roots.get(name)!;
  return rows.flatMap((cmd) => {
    const r = action(root, name, cmd);
    return r.status === want ? [] : [`${cmd} -> ${r.status}: ${(r.stderr || "").split("\n")[0]}`];
  });
}

const TOPOLOGIES = [["plain", PLAIN, "plain"], ["a ledger gate", LEDGER, "led"], ["a go word", GO, "go-apply"], ["two step gates", TWO, "two-gates"], ["two step gates and a write gate", BOTH, "both-gates"]] as const;

beforeAll(() => { for (const [, src, name] of TOPOLOGIES) roots.set(name, scaffold(src)); });
afterAll(() => { for (const root of roots.values()) fs.rmSync(root, { recursive: true, force: true }); });

/** A scaffold run named with a version, a tag, a runner or an alias: every one runs the CLI, so the step gate refuses it. */
const SCAFFOLD_REFUSED = [
  // the named forms
  "npx -y agentopology@0.13.1 --no-plugins scaffold probe.at --target claude-code --dir .",
  "npx agentopology@latest scaffold probe.at",
  "pnpm dlx agentopology@0.13.1 scaffold probe.at",
  // forms that already refuse, and must keep refusing
  "agentopology scaffold probe.at",
  "npx agentopology scaffold probe.at",
  "./node_modules/.bin/agentopology scaffold probe.at",
  "cd sub && agentopology scaffold probe.at",
  // versions and tags
  "npx agentopology@1.0.0-rc.1 scaffold probe.at",
  "npx agentopology@next scaffold probe.at",
  // the runners
  "npx --yes agentopology@0.13.1 scaffold probe.at",
  "npx -y -p agentopology@0.13.1 agentopology scaffold probe.at",
  "npx --package=agentopology@0.13.1 agentopology scaffold probe.at",
  "npx --package agentopology@0.13.1 -- agentopology scaffold probe.at",
  "pnpm dlx agentopology scaffold probe.at",
  "pnpm exec agentopology scaffold probe.at",
  "pnpm exec agentopology@0.13.1 scaffold probe.at",
  "pnpm --silent dlx agentopology@latest scaffold probe.at",
  "yarn dlx agentopology@0.13.1 scaffold probe.at",
  "yarn dlx -p agentopology@0.13.1 agentopology scaffold probe.at",
  "bunx agentopology@0.13.1 scaffold probe.at",
  "bunx --bun agentopology@latest scaffold probe.at",
  "npm exec -- agentopology@0.13.1 scaffold probe.at",
  "npm exec --yes -- agentopology scaffold probe.at",
  "npm exec --package=agentopology@0.13.1 -- agentopology scaffold probe.at",
  // an npm: alias
  "npx agentopology@npm:agentopology@0.13.1 scaffold probe.at",
  "pnpm dlx some-alias@npm:agentopology@0.13.1 scaffold probe.at",
  // a runner inside a longer command
  "echo hi && npx -y agentopology@0.13.1 scaffold probe.at",
  "FOO=1 npx agentopology@0.13.1 scaffold probe.at",
  "cd sub && pnpm dlx agentopology@0.13.1 scaffold probe.at",
  "timeout 60 npx agentopology@0.13.1 scaffold probe.at",
];

/** Commands that are not a scaffold of the CLI: the step gate lets them run. */
const VALIDATE_PASSED = [
  "agentopology validate probe.at --no-plugins",
  "npx agentopology validate probe.at --no-plugins",
  "npx agentopology@0.13.1 validate probe.at --no-plugins",
  "npx agentopology@0.13.1 validate x.at",
  "agentopology validate x.at",
  "pnpm dlx agentopology@0.13.1 validate probe.at --no-plugins",
];

const SCAFFOLD_PASSED = [
  "npx -y prettier@3.0.0 --check .",
  "npx cowsay@1.5.0 scaffold",
  "pnpm dlx create-vite@5.0.0 scaffold",
  "ls build",
  "git status",
  "npm test",
  "ls docs",
  "npx agentopology@0.13.1 info x.at --no-plugins",
];

/**
 * Known false refusals of the coarse step gate (it fails closed): a segment that names the step's program
 * inside any word, or an expansion after a runner, and holds the step's word is read as the step. Run the
 * step after its gate, or reword the command.
 */
const KNOWN_FALSE_REFUSALS = [
  "echo agentopology scaffold",
  "echo agentopology@0.13.1 scaffold",
  "bunx agentopology-extras@1.0.0 scaffold probe.txt",
  "npx @scope/agentopology-tools@1.0.0 scaffold probe.txt",
  "x=other@1; npx $x scaffold",
  // an expansion where a program stands, or xargs running a runner, reads the command's quoted text too
  "a=x; echo $a agentopology scaffold",
];

/**
 * Known false refusals of the subcommand rule: the step's word stands bare (unquoted) in a command that holds an
 * expansion, an alias, xargs, eval or a shell -c, so the command may build the CLI's name at run time. Quote the
 * word, or split the command.
 */
const RULE_FALSE_REFUSALS = [
  "ls $DIR; echo scaffold",
  "echo scaffold | xargs echo",
];

/** The subcommand rule: the step's word bare, and an expansion, an alias, xargs, eval or a shell -c somewhere. */
const RULE_FORMS = [
  "alias a='npx -y agentopology@1'\na {s}",
  "alias a='npx -y agentopology@1'; a {s}",
  "echo agento | xargs -I% %pology {s}",
  "echo agento | xargs -IX Xpology {s}",
  "echo agento | xargs --replace=Q Qpology {s}",
  "a=agento; exec -a x ${a}pology {s}",
  "a=agento; env -u X ${a}pology {s}",
  "a=agento; timeout -s KILL 5 ${a}pology {s}",
  "a=agento; sudo -u root ${a}pology {s}",
];

/** The validate twins and the rule's must-pass rows run in the tests below. */
const RULE_PASSED = [
  "git commit -m \"agentopology scaffold fix\" && echo $HOME",
  "grep -rl 'agentopology scaffold' . | xargs wc -l",
  "echo $HOME; git log --grep \"agentopology scaffold\"",
  "echo 'agentopology scaffold' | xargs echo",
];

/** The validate step of the two-gate fixture: refused before the sign, in every spelling. */
const VALIDATE_REFUSED = [
  "agentopology validate gated.at --no-plugins",
  "npx agentopology validate gated.at --no-plugins",
  "npx agentopology@0.13.1 validate gated.at",
  "npx agentopology@0.13.1 validate gated.at --no-plugins",
  "npx -y agentopology@latest validate gated.at --no-plugins",
  "pnpm dlx agentopology@0.13.1 validate gated.at --no-plugins",
  "pnpm exec agentopology validate gated.at --no-plugins",
  "yarn dlx agentopology@0.13.1 validate gated.at --no-plugins",
  "bunx agentopology@0.13.1 validate gated.at --no-plugins",
  "npm exec -- agentopology@0.13.1 validate gated.at --no-plugins",
];

/**
 * More spellings of a run of the CLI, `{s}` standing for the gated step and its file. Each runs the CLI,
 * so the step gate refuses it before its go or its sign.
 */
const STEP_FORMS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["a later runner word whose package name reads as empty", [
    "npx agentopology@1 {s} # npx npm:",
    "npx agentopology@1 {s} # npx x@npm:",
    "pnpm dlx agentopology@1 {s} # yarn dlx npm:",
    "npx agentopology@1 {s} --dir 'npx x@npm:'",
    "npx agentopology@1 {s} bunx y@npm:",
  ]],
  ["a runner option with a value before dlx, exec or x", [
    "pnpm -C . dlx agentopology@1 {s}",
    "pnpm --dir . dlx agentopology@1 {s}",
    "pnpm --filter x dlx agentopology@1 {s}",
    "npm --prefix . exec agentopology@1 {s}",
    "npm --prefix . x agentopology@1 {s}",
    "npm --prefix . exec -- agentopology@1 {s}",
    "npm -w x exec agentopology@1 {s}",
    "npm --registry R exec agentopology@1 {s}",
    "yarn --cwd . dlx agentopology@1 {s}",
    "bun --cwd . x agentopology@1 {s}",
    "pnpm --some-option value dlx agentopology@1 {s}",
  ]],
  ["a variable set to a versioned name", [
    "f=agentopology@1; npx $f {s}",
  ]],
  ["a tarball or a git spec", [
    "npx ./agentopology-0.13.1.tgz {s}",
    "npx https://registry.npmjs.org/agentopology/-/agentopology-0.13.1.tgz {s}",
    "npx git+https://github.com/agentopology/agentopology.git {s}",
  ]],
  ["the CLI's own file, a here-string, a runner's --call", [
    "node node_modules/agentopology/dist/cli/index.js {s}",
    "bash <<<'agentopology {s}'",
    "npx --call='agentopology {s}'",
    "npm exec --call='agentopology {s}'",
  ]],
  ["runner options the package reading does not know", [
    "npx --loglevel silent agentopology@1 {s}",
    "npm exec --loglevel silent agentopology@1 {s}",
    "pnpm dlx --reporter silent agentopology@1 {s}",
    "npx --foo bar agentopology@1 {s}",
    "npm --tag x exec agentopology@1 {s}",
  ]],
  ["a version that is itself a URL or git spec", [
    "npx agentopology@https://example.com/fork.tgz {s}",
    "npx agentopology@git+https://example.com/fork.git {s}",
  ]],
  ["a name set by any builtin or expansion and run through a runner", [
    "export f=agentopology@1; npx $f {s}",
    "local f=agentopology@1; npx $f {s}",
    "declare f=agentopology@1; npx $f {s}",
    "readonly f=agentopology@1; npx $f {s}",
    "typeset f=agentopology@1; npx $f {s}",
    "a=(agentopology@1); npx ${a[0]} {s}",
    "read f <<< agentopology@1; npx $f {s}",
    "printf -v f agentopology@1; npx $f {s}",
    "f=xagentopology@1; npx ${f#x} {s}",
  ]],
  ["other paths to the CLI's own file", [
    "node node_modules/agentopology/dist/cli/./index.js {s}",
    "node node_modules/agentopology/dist/cli/index {s}",
    "node node_modules/agentopology/dist/cli {s}",
  ]],
  ["here-strings with mixed quotes or escaped blanks, and an ANSI-C quoted --call", [
    "bash <<< \"agentopology\"' {s}'",
    "bash <<< agentopology\\ {s1}\\ {s2}",
    "npx --call=$'agentopology {s}'",
  ]],
  ["the subcommand in quoted text the shell later splits into arguments (an unquoted expansion, or xargs)", [
    "a='agentopology@1 {s}'; npx $a",
    "a='agentopology@1 {s}'; npx -y $a",
    "a='agentopology@1 {s}'; command $a",
    "a='-y agentopology@1 {s}'; npx $a",
    "echo '{s}' | xargs npx -y agentopology@1",
    "printf 'agentopology@1\\n{s1}\\n{s2}\\n' | xargs npx -y",
    "echo '{s}' | xargs npx agentopology@1",
  ]],
  ["a dot reads its file as code, git rebase runs --exec text, npm keeps text as a script", [
    ". <(echo 'agentopology {s}')",
    ". /dev/stdin <<< 'agentopology {s}'",
    "git rebase -x 'agentopology {s}' HEAD~1",
    "git rebase --exec='agentopology {s}' HEAD~1",
    "npm pkg set 'scripts.x=agentopology {s}'",
    "npm set-script x 'agentopology {s}'",
  ]],
  ["an alias whose value is the step is code", [
    "shopt -s expand_aliases\nalias a='agentopology {s}'\na",
    "shopt -s expand_aliases; alias a='agentopology {s}'; a",
    "alias a='npx agentopology@1 {s}'; a",
  ]],
  ["an expansion, $0 or the {} replacement where a code string names its program", [
    "a=agen; eval \"${a}topology {s}\"",
    "sh -c 'agento$0 {s}' pology",
    "bash -c '$0$1 {s}' agento pology",
    "xargs -I{} {}pology {s} <<< agento",
    "echo agento | xargs -I{} {}pology {s}",
    "echo agento | xargs -I{} npx {}pology@1 {s}",
    "echo agento | xargs -I{} sh -c '{}pology {s}'",
    "compgen -c | xargs -I{} {} {s}",
    "ls | xargs -I{} {} {s}",
  ]],
  ["wrappers, letter case and spaces around a versioned name", [
    "env npx agentopology@1 {s}",
    "nice npx agentopology@1 {s}",
    "sudo npx agentopology@1 {s}",
    "sh -c 'npx agentopology@1 {s}'",
    "eval npx agentopology@1 {s}",
    "echo x | xargs npx agentopology@1 {s}",
    "NPX Agentopology@1 {s}",
    "npx    agentopology@1    {s}",
  ]],
];

/** Commands near those forms that run no gated step: they still pass. */
const NEAR_PASSED = [
  "pnpm -C . dlx create-vite@5.0.0 scaffold",
  "npm --prefix . exec prettier@3.0.0 -- --check .",
  "npx ./other-tool-1.0.0.tgz scaffold",
  "npx --call='echo hi'",
  "node node_modules/other/dist/cli/index.js scaffold",
  "cat <<<'hello world'",
  "a=docs; ls $a",
  "echo hi | xargs echo",
  "git commit -m \"agentopology scaffold notes\"",
  "git add . && git commit -m \"agentopology scaffold notes\"",
  "git rebase main",
  "npm pkg get name",
  // an expansion in an ordinary argument, xargs running an ordinary program: the quoted text stays text
  "git commit -m \"agentopology scaffold fix\" && echo $HOME",
  "grep -rl 'agentopology scaffold' . | xargs wc -l",
  "echo $HOME; git log --grep \"agentopology scaffold\"",
  "echo 'agentopology scaffold' | xargs echo",
];

/** Text handed to a program that runs text as code: quoted or not, it is the step, and refused. */
const CODE_FORMS = [
  "bash -c '{c}'",
  "sh -c '{c}'",
  "eval '{c}'",
  "npx --call='{c}'",
  "npm exec -c '{c}'",
  "node -e '{c}'",
  "python3 -c '{c}'",
  "bash <<< '{c}'",
  "bash <<'EOF'\n{c}\nEOF",
  "perl -e '{c}'",
  "ruby -e '{c}'",
  "php -r '{c}'",
  "lua -e '{c}'",
  "deno eval '{c}'",
  "bun -e '{c}'",
  "awk 'BEGIN{system(\"{c}\")}'",
  "echo '{c}' | tclsh",
  "tclsh <<< '{c}'",
  "echo x | xargs sh -c '{c}'",
  "find . -exec sh -c '{c}' \\;",
  "git -c alias.x='!{c}' x",
  "env -S '{c}'",
  "script -c '{c}'",
  "watch '{c}'",
  "nohup sh -c '{c}'",
  "ssh host '{c}'",
  "docker run img sh -c '{c}'",
  "make -E '{c}'",
  "make --eval='{c}'",
];

/** Quoted text with a space, handed to no program that runs it: text, so it passes. */
const TEXT_PASSED = [
  "git commit -m \"agentopology {w} notes\"",
  "gh pr create --body \"fix the agentopology {w} step\"",
];

/** A read-only program in the program's place, the words its arguments only: no step, so it passes. */
const READ_ONLY_PASSED = [
  "grep -rn agentopology import docs/",
  "rg agentopology guard",
  "grep -rn \"agentopology import\" docs/",
  "cat docs/agentopology-{w}.md",
  "head -5 agentopology.at",
  "wc -l docs/{w}.md agentopology.at",
  "grep agentopology docs/{w}.md",
  "tail -n 3 docs/agentopology-{w}.md",
  "sed -n 1,5p docs/agentopology-{w}.md",
  "awk '/agentopology/' docs/{w}.md",
];

/** The read-only rule never covers a substitution, a code runner or a second segment: refused. */
const READ_ONLY_REFUSED = [
  "grep x $({c})",
  "cat <({c})",
  "grep `{c}` f",
  "sed -n '1e {c}' f",
  "awk 'BEGIN{system(\"{c}\")}'",
  "grep x f | sh -c '{c}'",
  "env grep x; {c}",
  "rg --pre agentopology x docs/{w}.md",
];

/** --help, -h, --version or -v straight after the CLI word: the CLI prints and exits, no step. */
const HELP_PASSED = [
  "agentopology --help",
  "agentopology --version",
  "agentopology -h {w}",
  "npx agentopology@0.13.1 --help {w}",
  "node node_modules/agentopology/dist/cli/index.js --help",
];

/** The flag not first, a second segment, or anything that may run code before the CLI: refused. */
const HELP_REFUSED = [
  "{c} --help",
  "agentopology --help; {c}",
  "NODE_OPTIONS=--require=./x.js agentopology --help {w}",
  "node --require=./x.js node_modules/agentopology/dist/cli/index.js --help {w}",
  "npx --call=$f agentopology --help {w}",
  "npx -c '{c}' agentopology --help",
];

/** A form with the step filled in: `{s}` is the step and its file, `{s1}` and `{s2}` the two words alone. */
const fill = (form: string, step: string, file: string) =>
  form.replaceAll("{c}", `agentopology ${step} ${file}`).replaceAll("{s}", `${step} ${file}`)
    .replace("{s1}", step).replace("{s2}", file).replaceAll("{w}", step);

describe.skipIf(!hasJq)("more spellings of a run of the CLI reach the step gate", () => {
  for (const [label, , name] of TOPOLOGIES) {
    for (const [group, forms] of STEP_FORMS) {
      for (const form of forms) {
        const cmd = fill(form, "scaffold", "probe.at");
        it(`${label}: ${group}: refused: ${cmd}`, () => {
          expect(off(name, [cmd], 2)).toEqual([]);
        });
      }
    }
    for (const cmd of NEAR_PASSED) {
      it(`${label}: passes: ${cmd}`, () => {
        expect(off(name, [cmd], 0)).toEqual([]);
      });
    }
    for (const cmd of KNOWN_FALSE_REFUSALS) {
      it(`${label}: a known false refusal, documented: ${cmd}`, () => {
        expect(off(name, [cmd], 2)).toEqual([]);
      });
    }
  }
  for (const [group, forms] of STEP_FORMS) {
    for (const form of forms) {
      const cmd = fill(form, "validate", "gated.at");
      it(`two step gates: ${group}: the validate step is refused before the sign: ${cmd}`, () => {
        expect(off("two-gates", [cmd], 2)).toEqual([]);
      });
    }
  }
});

describe.skipIf(!hasJq)("quoted text, read-only programs and the CLI's own help", () => {
  const refused = [...CODE_FORMS, ...READ_ONLY_REFUSED, ...HELP_REFUSED];
  const passed = [...TEXT_PASSED, ...READ_ONLY_PASSED, ...HELP_PASSED];
  for (const [label, , name] of TOPOLOGIES) {
    for (const form of refused) {
      const cmd = fill(form, "scaffold", "probe.at");
      it(`${label}: refused: ${cmd}`, () => {
        expect(off(name, [cmd], 2)).toEqual([]);
      });
    }
    for (const form of passed) {
      const cmd = fill(form, "scaffold", "probe.at");
      it(`${label}: passes: ${cmd}`, () => {
        expect(off(name, [cmd], 0)).toEqual([]);
      });
    }
  }
  for (const form of refused) {
    const cmd = fill(form, "validate", "gated.at");
    it(`two step gates: the validate step is refused before the sign: ${cmd}`, () => {
      expect(off("two-gates", [cmd], 2)).toEqual([]);
    });
  }
  for (const form of passed) {
    const cmd = fill(form, "validate", "gated.at");
    it(`two step gates: passes: ${cmd}`, () => {
      expect(off("two-gates", [cmd], 0)).toEqual([]);
    });
  }
});

describe.skipIf(!hasJq)("a step gate recognises the CLI named with a version, a tag or a runner", () => {
  for (const [label, , name] of TOPOLOGIES) {
    for (const cmd of SCAFFOLD_REFUSED) {
      it(`${label}: refused: ${cmd}`, () => {
        expect(off(name, [cmd], 2)).toEqual([]);
      });
    }
    // only the two-gate fixture gates a validate step
    for (const cmd of name.endsWith("-gates") ? SCAFFOLD_PASSED : [...VALIDATE_PASSED, ...SCAFFOLD_PASSED]) {
      it(`${label}: passes: ${cmd}`, () => {
        expect(off(name, [cmd], 0)).toEqual([]);
      });
    }
  }
  for (const cmd of VALIDATE_REFUSED) {
    it(`two step gates: the validate step is refused before the sign: ${cmd}`, () => {
      expect(off("two-gates", [cmd], 2)).toEqual([]);
    });
  }
});

describe.skipIf(!hasJq)("the subcommand rule: the step's word bare, with an expansion, alias, xargs, eval or shell -c", () => {
  for (const [label, , name] of TOPOLOGIES) {
    for (const form of RULE_FORMS) {
      const cmd = fill(form, "scaffold", "probe.at");
      it(`${label}: refused: ${JSON.stringify(cmd)}`, () => {
        expect(off(name, [cmd], 2)).toEqual([]);
      });
    }
    for (const cmd of RULE_PASSED) {
      it(`${label}: passes: ${cmd}`, () => {
        expect(off(name, [cmd], 0)).toEqual([]);
      });
    }
    for (const cmd of RULE_FALSE_REFUSALS) {
      it(`${label}: a known false refusal, documented: ${cmd}`, () => {
        expect(off(name, [cmd], 2)).toEqual([]);
      });
    }
  }
  for (const form of [RULE_FORMS[1], RULE_FORMS[2], RULE_FORMS[5]]) {
    const cmd = fill(form, "validate", "gated.at");
    it(`two step gates: the validate twin is refused: ${JSON.stringify(cmd)}`, () => {
      expect(off("two-gates", [cmd], 2)).toEqual([]);
    });
  }
});

describe.skipIf(!hasJq)("the write gate's read list and the step gates answer different questions", () => {
  // a pinned npx with --no-plugins reads a .at file: the write gate lets it through
  it("a read of a .at file with a pinned npx passes both", () => {
    expect(off("both-gates", ["npx agentopology@0.13.1 info x.at --no-plugins", "npx -y agentopology@0.13.1 info x.at --no-plugins"], 0)).toEqual([]);
  });
  // the same pinned npx running a gated step is refused by the step gate, before its go or its sign
  it("a pinned npx scaffold --dry-run is a read for the write gate and still a refused step", () => {
    expect(off("both-gates", ["npx agentopology@0.13.1 scaffold x.at --dry-run --no-plugins"], 2)).toEqual([]);
  });
  it("a pinned npx validate is a read for the write gate and still a refused step before the sign", () => {
    expect(off("both-gates", ["npx agentopology@0.13.1 validate x.at --no-plugins", "agentopology validate x.at --no-plugins"], 2)).toEqual([]);
  });
  // the read list itself is as it was: a tag, a missing --no-plugins or a plugin is not a read
  it("the read list is unchanged: a tag, no --no-plugins, a plugin or --dir is not a read", () => {
    expect(off("both-gates", [
      "npx agentopology@latest info x.at --no-plugins",
      "npx agentopology@0.13.1 info x.at",
      "npx agentopology@0.13.1 info x.at --no-plugins --plugin ./p.mjs",
      "pnpm dlx agentopology@0.13.1 info x.at --no-plugins",
    ], 2)).toEqual([]);
  });
});
