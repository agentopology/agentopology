/**
 * The proof rows for before-action.sh (0.13.0). Three independent reads of the release candidate fed the
 * generated guard one Bash command at a time. Every command they found refused that should run is a
 * must-pass row here, on three topologies: a plain one (one gate, no human, no ledger), one with a ledger
 * gate, and one with a human who has a go word (with a declared claude runner). Every command the first
 * read found let through that gives the go or switches a guard off is a must-refuse row, on the go topology.
 * A command is fed to the guard only; nothing is run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";

const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;

/** One gate before a script step, no human, no ledger. */
const PLAIN = `topology plain : [pipeline] {
  meta { version: "0.1.0" description: "A plain pipeline with one script step and a gate" }
  orchestrator { model: opus handles: [build, deploy] }
  action build {
    kind: inline
    description: "Build"
    commands: ["npm run build"]
  }
  action deploy {
    kind: external
    description: "Deploy"
    commands: ["./deploy.sh"]
  }
  gates {
    gate built {
      after: build
      before: deploy
      run: "scripts/check.sh"
      strength: refuse
    }
  }
  flow { build -> deploy }
}
`;

/** A ledger gate, no human. */
const LEDGER = `topology led : [pipeline] {
  meta { version: "0.1.0" description: "A ledger gate with no human node" }
  orchestrator { model: opus handles: [draft, release] }
  action draft {
    kind: inline
    description: "Draft the release"
    commands: ["./tool draft"]
  }
  action release {
    kind: external
    description: "Release"
    commands: ["./tool release"]
  }
  records {
    record run-ledger { path: "logs/run.jsonl" }
  }
  gates {
    gate drafted {
      after: draft
      before: release
      ledger: run-ledger
      strength: refuse
    }
  }
  flow { draft -> release }
}
`;

/** A human with a go word, its ledger, a declared claude runner and a pane tool of the project's own. */
const GO = `topology p09-human : [pipeline, human-gate] {
  meta { version: "0.1.0" description: "The owner's go" }
  person owner {
  }
  agent x {
    model: sonnet
    description: "Reviews"
    invocation: manual
  }
  orchestrator { model: opus handles: [draft, release, review] }
  action draft {
    kind: inline
    description: "Draft the release"
    commands: ["./tool draft"]
  }
  human owner-go {
    description: "The owner types go for the release"
    who: owner
    word: "go release"
    typed-only-programs: [herdr]
  }
  action release {
    kind: external
    description: "Release"
    commands: ["./tool release"]
  }
  action review {
    kind: inline
    description: "A headless review run"
    commands: ["claude -p --agent x PROMPT"]
  }
  records {
    record go-ledger { path: "logs/go.jsonl" }
  }
  gates {
    gate go-given {
      after: owner-go
      before: release
      ledger: go-ledger
      strength: refuse
    }
  }
  flow {
    draft -> owner-go
    owner-go -> release
  }
}
`;

const TOPOLOGIES = [["plain", PLAIN, "plain"], ["a ledger gate", LEDGER, "led"], ["a go word", GO, "p09-human"]] as const;

/** Second read: ordinary commands the new guard refused. */
const ROUND2_PASS = [
  'sqlite3 db.sqlite "select * from t"',
  'psql -c "SELECT * FROM users"',
  'curl -H "Accept: */*" https://example.com',
  'echo "*" >> .gitignore',
  'echo "5 * 3" > build/x',
  'node -e "console.log(1 * 2)"',
  'npm test -- --grep "*"',
  "cd build && rm -rf *",
  "ls * > build/files.txt",
  "rm -f *.json",
  "cat .claude/settings.json 2>/dev/null",
  "cat .claude/settings.json > build/s.json",
  "cp .claude/settings.json build/settings.backup.json",
  String.raw`find . -name '*.sh' -exec chmod +x {} \;`,
];

/** Third read: ordinary commands still refused wherever the own-file guard is written. */
const ROUND3_PASS = [
  // a variable the command does not set, handed to a writer
  'rm -rf "$T"',
  'rm -f "$tmpfile"',
  "T=$(mktemp -d); cp build/a.o $T/; rm -rf $T",
  'chmod +x "$f"',
  'cp build/a.o "$DEST"',
  "mv build/a.o $HOME/",
  "chown -R $USER build",
  'sed -i "s/x/y/" $FILE',
  "rm -rf ${BUILD_DIR:-build}",
  // loops
  "for f in *; do echo $f; done",
  "for f in *.json; do cp $f build/; done",
  'for f in build/*; do rm -f "$f"; done',
  "find build -name '*.o' | while read f; do rm \"$f\"; done",
  // a * in a here-document body
  "cat > src/a.js <<'EOF'\nconst a = 1 * 2;\nEOF",
  "cat > src/a.ts <<'EOF'\nimport * as fs from \"fs\";\nEOF",
  "cat > README.md <<'EOF'\n# Title\n\n* item one\n* item two\nEOF",
  "git commit -m \"$(cat <<'EOF'\nFix build\n\n* one\n* two\nEOF\n)\"",
  "python3 - <<'EOF'\nprint(2 * 3)\nEOF",
  // arithmetic and case
  "echo $((2 * 3))",
  'echo "$((2 * 3))"',
  "case $x in a*) echo y ;; *) echo n ;; esac",
  // text that only mentions a protected file
  "cat > build/note.md <<'EOF'\nsee .claude/settings.json\nEOF",
  // reads by a program that writes elsewhere
  "tar czf build/claude.tgz .claude",
  "zip -r build/c.zip .claude",
  "shellcheck .claude/skills/*/scripts/before-action.sh",
  // screen, which crashed the go guard
  "screen -ls",
  "screen -r build",
  "screen -dmS build npm run build",
  // a temp file the command makes with mktemp
  'tmp=$(mktemp); echo x > "$tmp"; rm -f "$tmp"',
  // a quoted argument with a space is text
  'gh pr create --title "x" --body "changes .claude/settings.json handling"',
  // the declared runner
  'claude -p --agent x "summarize the logs"',
];

/** First read: commands that gave the go or switched a guard off. Each stays refused on the go topology. */
const ROUND1_REFUSE = [
  'claude -p "go release"',
  'npx claude -p "go release"',
  'env FOO=1 claude -p "go release"',
  '/home/user/.local/bin/claude -p "go release"',
  'echo "go release" | claude -p',
  'claude -p <<< "go release"',
  'timeout 60 claude -p "go release"',
  `echo '{"prompt":"go release"}' | bash .claude/skills/p09-human/scripts/go-*.sh`,
  `cd .claude/skills/p09-human/scripts && echo '{"prompt":"go release"}' | bash go-own*`,
  `for f in .claude/skills/p09-human/scripts/go*; do echo '{"prompt":"go release"}' | bash $f; done`,
  String.raw`find .claude -name 'go-*' -exec bash {} \;`,
  `L=logs/go; echo '{"step":"owner-go","ok":true}' >> $L.jsonl`,
  `L=logs/go; echo '{"step":"owner-go","ok":true}' >> \${L}.jsonl`,
  'echo "exit 0" > .claude/skills/p09-human/scripts/before-action.sh',
  'echo "exit 0" > .claude/skills/p09-human/scripts/before-edit.sh',
  'echo "exit 0" > .claude/skills/p09-human/scripts/before-schedule.sh',
  'echo "{}" > .claude/settings.json',
  'echo "{}" > .claude/settings.local.json',
  'echo "{}" > .claude/.scaffold-manifest.json',
  'tmux send-keys -t 0 "go release" Enter',
  'screen -S main -X stuff "go release\\n"',
  'xdotool type "go release"',
  `osascript -e 'tell application "System Events" to keystroke "go release"'`,
  'wtype "go release"',
  'ydotool type "go release"',
  'herdr send main "go release"',
];

/** The edges of what the guard now reads as text: each of these still writes a protected file, and is refused. */
const EDGES_REFUSE = [
  // << inside quotes is no here-document: the lines after it run
  'echo "<<X"\nrm -rf .claude\nX',
  // an unquoted here-document body runs its command substitutions
  "cat > build/x <<EOF\n$(rm -rf .claude)\nEOF",
  // a body with no end line is read as written
  "cat > build/x <<EOF\nok\nrm -rf .claude",
  // arithmetic that holds a command substitution is read as written
  "echo $(( $(rm -rf .claude) + 1 ))",
  // tar extracting into a protected folder, zip moving a protected file into an archive
  "tar -C .claude -xf build/a.tgz",
  "tar xzf build/a.tgz -C .claude",
  "zip -m build/c.zip .claude/settings.json",
  "tar czf .claude/settings.json build",
  "zip -r .claude/settings.json build",
  "scp -o ProxyCommand=x .claude/settings.json host:/tmp/",
  "scp host:/tmp/x .claude/settings.json",
  // a case pattern is dropped, the command after it is read
  "case $x in a) rm -rf .claude ;; esac",
  // a quoted argument without a space, a redirect target, a writer's argument, inline code: read as before
  'rm -rf "logs"',
  'cp x "logs/go.jsonl"',
  'echo x > "logs/go.jsonl"',
  'bash -c "echo go release >> logs/go.jsonl"',
  "rm -rf \"logs/go.jsonl\" 'logs dir'",
  `nohup sh -c 'echo {} > .claude/settings.json' &`,
  'eval "rm -rf .claude"',
  // a variable set to a path, or set twice, is no temp file
  'tmp=logs/go.jsonl; echo x > "$tmp"',
  'tmp=$(mktemp); tmp=logs/go.jsonl; echo x > "$tmp"',
  'tmp=$(mktemp); for tmp in logs/go.jsonl; do echo x > "$tmp"; done',
  // a for list stays named: running a go hook through it
  `for f in .claude/skills/p09-human/scripts/go-*.sh; do echo '{"prompt":"go release"}' | bash "$f"; done`,
];

const roots = new Map<string, string>();

function scaffold(src: string): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), "at-proof-"));
  for (const f of claudeCodeBinding.scaffold(parse(src))) {
    fs.mkdirSync(dirname(join(root, f.path)), { recursive: true });
    fs.writeFileSync(join(root, f.path), f.content);
    if (f.executable || f.path.endsWith(".sh")) fs.chmodSync(join(root, f.path), 0o755);
  }
  for (const d of ["build", "logs", "src", "docs"]) fs.mkdirSync(join(root, d), { recursive: true });
  for (const f of ["build/a.o", "build/b.txt", "db.sqlite", "package.json", "tsconfig.json", "logs/run.jsonl", "logs/go.jsonl"]) fs.writeFileSync(join(root, f), "x\n");
  return root;
}

function action(root: string, name: string, command: string) {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: root };
  delete env.AT_SESSION;
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", cwd: root, tool_name: "Bash", tool_input: { command } });
  return spawnSync("bash", [join(root, `.claude/skills/${name.replace(/\+at$/, "")}/scripts/before-action.sh`)], { cwd: root, input: payload, env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout: 20_000 });
}

/** The rows whose exit is not `want`, each with the guard's first line. */
function off(name: string, rows: readonly string[], want: number): string[] {
  const root = roots.get(name)!;
  return rows.flatMap((cmd) => {
    const r = action(root, name, cmd);
    return r.status === want ? [] : [`${cmd} -> ${r.status}: ${(r.stderr || "").split("\n")[0]}`];
  });
}

beforeAll(() => { for (const [, src, name] of TOPOLOGIES) roots.set(name, scaffold(src)); });
afterAll(() => { for (const root of roots.values()) fs.rmSync(root, { recursive: true, force: true }); });

describe.skipIf(!hasJq)("proof: ordinary commands run on every topology", () => {
  for (const [label, , name] of TOPOLOGIES) {
    it.each(ROUND2_PASS)(`${label}, second read, passes: %s`, (cmd) => {
      expect(off(name, [cmd], 0)).toEqual([]);
    });
    it.each(ROUND3_PASS)(`${label}, third read, passes: %s`, (cmd) => {
      expect(off(name, [cmd], 0)).toEqual([]);
    });
  }
  // A ledger read by a program other than cat (grep, jq, a copy) is still refused, as before 0.13.0.
  for (const cmd of ["grep -c ok logs/run.jsonl", "jq -c 'select(.ok)' logs/run.jsonl | wc -l", "cp logs/run.jsonl build/"]) {
    it.todo(`a ledger gate: ${cmd}`);
  }
  it("a ledger gate: cat of the ledger passes", () => {
    expect(off("led", ["cat logs/run.jsonl"], 0)).toEqual([]);
  });
});

// 0.13.1: a gate `before: write "**/*.at"`: agentopology's own read-only subcommands name a .at file and are reads.
const AT_GATE: Record<string, string> = {
  plain: `    gate at-open {
      after: build
      before: write "**/*.at"
      run: "scripts/check.sh"
      strength: refuse
    }
`,
  led: `    gate at-open {
      after: draft
      before: write "**/*.at"
      ledger: run-ledger
      strength: refuse
    }
`,
  "p09-human": `    gate at-open {
      after: owner-go
      before: write "**/*.at"
      ledger: go-ledger
      strength: refuse
    }
`,
};

// A read loads no plugin: --no-plugins is part of every read form.
const AT_READ_FORMS = [
  "agentopology validate x.at --no-plugins",
  "agentopology guard x.at --check --no-plugins",
  "agentopology guard x.at --test --no-plugins",
  "agentopology inventory x.at --no-plugins",
  "agentopology plan x.at --no-plugins",
  "agentopology step check x.at --no-plugins",
  "agentopology info x.at --no-plugins",
  "agentopology visualize x.at --no-open --no-plugins",
  "agentopology scaffold x.at --dry-run --no-plugins",
  "npx agentopology validate x.at --no-plugins",
  "npx agentopology@0.13.0 validate x.at --no-plugins",
  "npx agentopology@0.13.1 validate x.at --no-plugins",
  "npx agentopology@1.0.0-rc.1 validate x.at --no-plugins",
  "npx -y agentopology validate x.at --no-plugins",
  "npx --yes agentopology@0.13.1 validate x.at --no-plugins",
  "agentopology validate docs/x.at --no-plugins",
  "npx agentopology@0.13.1 validate docs/x.at --no-plugins",
  "agentopology guard docs/x.at --check --no-plugins",
];

const AT_WRITE_FORMS = [
  "agentopology scaffold x.at",
  "agentopology guard x.at --target claude-code",
  "agentopology sync x.at",
  "agentopology import --dir . x.at",
  "agentopology validate x.at > packs/new.at",
  "echo x > packs/new.at",
  "cp a.at packs/b.at",
  // export writes its output next to the .at it reads (docs/code-review.md): a write
  "agentopology export x.at",
  "agentopology export docs/x.at",
  // a plugin is code that runs: not a read
  "agentopology validate x.at --plugin ./evil.mjs --no-plugins",
  "agentopology validate x.at --plugin=./evil.mjs --no-plugins",
  "agentopology info --plugin ./evil.mjs x.at --no-plugins",
  // npx runs only the agentopology package itself, by name or name@version
  "npx agentopology@npm:evilpkg validate x.at --no-plugins",
  "npx agentopology@file:/tmp/evil validate x.at --no-plugins",
  "npx agentopology@latest validate x.at --no-plugins",
  "npx --package=evilpkg agentopology validate x.at --no-plugins",
  "npx -p evilpkg agentopology validate x.at --no-plugins",
  "npx --registry=https://example.invalid agentopology validate x.at --no-plugins",
  // --plugin always runs code, --no-plugins or not
  "agentopology validate docs/x.at --no-plugins --plugin ./p.mjs",
  "agentopology validate docs/x.at --no-plugins --plugin=./p.mjs",
  // --no-plugins counts only as its own word before any --
  "agentopology validate docs/x.at -- --no-plugins",
  'agentopology validate "docs/x.at --no-plugins"',
  // --no-plugins counts only in the agentopology call's own segment
  'agentopology validate "docs/x.at --no-plugins"; echo --no-plugins',
  "agentopology validate docs/x.at && agentopology info docs/x.at --no-plugins",
  "agentopology validate docs/x.at | cat --no-plugins",
  "agentopology validate docs/x.at\necho --no-plugins",
  // without --no-plugins a package.json plugin may run: not a read
  "agentopology validate docs/x.at",
  "agentopology info docs/x.at",
  // --dir names the folder whose package.json plugins load: not a read
  "agentopology validate docs/x.at --dir evil",
  "agentopology validate docs/x.at --dir=evil",
  "agentopology guard x.at --check --dir .",
  // only agentopology found on PATH: a program at a path is not it
  "evil/agentopology validate docs/x.at --no-plugins",
  "/tmp/evil/agentopology validate docs/x.at --no-plugins",
  "./node_modules/.bin/agentopology validate docs/x.at --no-plugins",
  "evil/npx agentopology validate docs/x.at --no-plugins",
];

describe.skipIf(!hasJq)("proof: agentopology's read-only subcommands on a .at file", () => {
  for (const [label, src, name] of TOPOLOGIES) {
    const key = `${name}+at`;
    beforeAll(() => { roots.set(key, scaffold(src.replace("  gates {\n", `  gates {\n${AT_GATE[name]}`))); });
    for (const cmd of AT_READ_FORMS) {
      it(`${label}, a .at gate, passes: ${cmd}`, () => {
        expect(off(key, [cmd], 0)).toEqual([]);
      });
    }
    for (const cmd of AT_WRITE_FORMS) {
      it(`${label}, a .at gate, refused: ${cmd}`, () => {
        expect(off(key, [cmd], 2)).toEqual([]);
      });
    }
    it(`${label}, a .at gate, the refusal of a read without --no-plugins says to add it`, () => {
      const r = action(roots.get(key)!, key, "agentopology validate docs/x.at");
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("add --no-plugins");
    });
  }
});

describe.skipIf(!hasJq)("proof: the first read's forms stay refused", () => {
  it.each(ROUND1_REFUSE)("a go word, first read, refused: %s", (cmd) => {
    expect(off("p09-human", [cmd], 2)).toEqual([]);
  });
  it.each(EDGES_REFUSE)("a go word, an edge of the text reading, refused: %s", (cmd) => {
    expect(off("p09-human", [cmd], 2)).toEqual([]);
  });
});
