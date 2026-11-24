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
  "pnpm dlx agentopology@0.13.1 validate probe.at --no-plugins",
];

const SCAFFOLD_PASSED = [
  "npx -y prettier@3.0.0 --check .",
  "npx cowsay@1.5.0 scaffold",
  "pnpm dlx create-vite@5.0.0 scaffold",
  "bunx agentopology-extras@1.0.0 scaffold probe.txt",
  "npx @scope/agentopology-tools@1.0.0 scaffold probe.txt",
  "echo agentopology@0.13.1 scaffold",
  "ls build",
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
