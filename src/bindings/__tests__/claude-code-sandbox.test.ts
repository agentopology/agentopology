/**
 * The sandbox defaults for a topology with a go word (0.13.1).
 *
 * A human with `word:` makes the claude-code binding turn Claude Code's
 * sandbox on in .claude/settings.json: enabled, no unsandboxed retry, exit
 * where the sandbox cannot run, and denyWrite on the files only hooks (and
 * scaffold) write: the go ledger, the hook-written state files, the scaffold
 * manifest. Each also gets an Edit(...) deny rule. The route record and the
 * ledgers a step writes are not in it: the agent's own commands write them.
 *
 * The user's extensions { claude-code { sandbox.x } } merge in: lists add, a
 * value that weakens a default is kept as written, and validate, scaffold and
 * guard --check say so. A topology without a go word is unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { claudeCodeBinding } from "../claude-code.js";
import { checkGuards } from "../../guard/check.js";

function goSrc(extra = "", ext = ""): string {
  return `topology p09-human : [pipeline, human-gate] {
  meta {
    version: "0.1.0"
    description: "The owner's go before a script step"
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
    description: "The owner types go for the release"
    who: owner
    word: "go release"
  }
  action release {
    kind: external
    description: "Release"
    commands: ["./tool release"]
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
${extra}  flow {
    draft -> owner-go
    owner-go -> release
  }
${ext ? `  extensions {\n    claude-code {\n${ext}    }\n  }\n` : ""}}
`;
}

/** The same topology with no go word: the sandbox is never written. */
const NO_WORD = goSrc().replace('    word: "go release"\n', "");

function settingsOf(src: string): any {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const f = claudeCodeBinding.scaffold(parse(src)).find((x) => x.path === ".claude/settings.json");
    return f ? JSON.parse(f.content) : null;
  } finally {
    console.warn = warn;
  }
}

function scaffoldWarnings(src: string): string[] {
  const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    claudeCodeBinding.scaffold(parse(src));
    return spy.mock.calls.map((c) => String(c[0]));
  } finally {
    spy.mockRestore();
  }
}

const v130 = (src: string) => validate(parse(src), { target: "claude-code" }).filter((r) => r.rule === "V130").map((r) => r.message);

describe("[sandbox] defaults only with a go word", () => {
  it("a go word writes enabled, no unsandboxed retry and failIfUnavailable", () => {
    const s = settingsOf(goSrc());
    expect(s.sandbox.enabled).toBe(true);
    expect(s.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(s.sandbox.failIfUnavailable).toBe(true);
  });

  it("denyWrite holds the go ledger, the scaffold manifest, and nothing an agent's command writes", () => {
    const s = settingsOf(goSrc());
    expect(s.sandbox.filesystem.denyWrite).toEqual(["./logs/go.jsonl", "./.claude/.scaffold-manifest.json"]);
    expect(s.permissions.deny).toEqual(["Edit(/logs/go.jsonl)", "Edit(/.claude/.scaffold-manifest.json)"]);
  });

  it("the hook-written state file (talk.jsonl) is denied when a hook writes it", () => {
    const sessions = `  agent lead {
    model: opus
    description: "Leads"
    runs: session
  }
  agent helper {
    model: sonnet
    description: "Helps"
    runs: session
  }
`;
    const s = settingsOf(goSrc(sessions).replace("    owner-go -> release\n", "    owner-go -> release\n    lead -> helper\n    talk: hub lead\n"));
    expect(s.sandbox.filesystem.denyWrite).toContain("./.claude/state/talk.jsonl");
    expect(s.permissions.deny).toContain("Edit(/.claude/state/talk.jsonl)");
  });

  it("a ledger a step also writes is not denied: the sandbox would stop the step", () => {
    const shared = `  action check {
    kind: external
    description: "Checks"
    commands: ["./tool check"]
  }
  gates {
    gate checked {
      after: check
      before: release
      ledger: go-ledger
    }
  }
`;
    const s = settingsOf(goSrc(shared));
    expect(s.sandbox.filesystem.denyWrite).toEqual(["./.claude/.scaffold-manifest.json"]);
  });

  it("the user's deny rules come first, the Edit rules after, once each", () => {
    const s = settingsOf(goSrc(`  settings {\n    deny: ["Bash(rm *)", "Edit(/logs/go.jsonl)"]\n  }\n`));
    expect(s.permissions.deny).toEqual(["Bash(rm *)", "Edit(/logs/go.jsonl)", "Edit(/.claude/.scaffold-manifest.json)"]);
  });

  it("no go word: no sandbox key and no Edit deny (unchanged output)", () => {
    const s = settingsOf(NO_WORD);
    expect(s?.sandbox).toBeUndefined();
    expect(JSON.stringify(s ?? {})).not.toContain("Edit(");
  });
});

describe("[sandbox] the user's extensions merge in", () => {
  it("lists add to the defaults", () => {
    const s = settingsOf(goSrc("", `      sandbox.network.allowedDomains: [registry.npmjs.org, github.com]\n      sandbox.excludedCommands: ["docker compose *"]\n      sandbox.filesystem.denyWrite: ["./secrets"]\n      sandbox.filesystem.allowWrite: ["~/.kube"]\n`));
    expect(s.sandbox.network.allowedDomains).toEqual(["registry.npmjs.org", "github.com"]);
    expect(s.sandbox.excludedCommands).toEqual(["docker compose *"]);
    expect(s.sandbox.filesystem.denyWrite).toEqual(["./logs/go.jsonl", "./.claude/.scaffold-manifest.json", "./secrets"]);
    expect(s.sandbox.filesystem.allowWrite).toEqual(["~/.kube"]);
    expect(s.sandbox.enabled).toBe(true);
  });

  it("a weakening value is kept as written", () => {
    const s = settingsOf(goSrc("", "      sandbox.allowUnsandboxedCommands: true\n      sandbox.failIfUnavailable: false\n"));
    expect(s.sandbox.allowUnsandboxedCommands).toBe(true);
    expect(s.sandbox.failIfUnavailable).toBe(false);
    expect(settingsOf(goSrc(`  settings {\n    sandbox: false\n  }\n`)).sandbox.enabled).toBe(false);
  });
});

describe("[sandbox] each weakening warns (validate and scaffold)", () => {
  const cases: Array<[string, string, string, string]> = [
    ["settings sandbox: false", `  settings {\n    sandbox: false\n  }\n`, "", "sandbox.enabled"],
    ["enabled false", "", "      sandbox.enabled: false\n", "sandbox.enabled"],
    ["allowUnsandboxedCommands true", "", "      sandbox.allowUnsandboxedCommands: true\n", "sandbox.allowUnsandboxedCommands"],
    ["failIfUnavailable false", "", "      sandbox.failIfUnavailable: false\n", "sandbox.failIfUnavailable"],
    ["allowWrite covering a denied path", "", '      sandbox.filesystem.allowWrite: ["./logs"]\n', "sandbox.filesystem.allowWrite"],
  ];
  for (const [name, extra, ext, key] of cases) {
    it(name, () => {
      const msgs = v130(goSrc(extra, ext)).filter((m) => m.includes("weakens the sandbox"));
      expect(msgs.length, JSON.stringify(v130(goSrc(extra, ext)))).toBe(1);
      expect(msgs[0]).toContain(key);
      expect(scaffoldWarnings(goSrc(extra, ext)).filter((m) => m.includes("weakens the sandbox") && m.includes(key))).toHaveLength(1);
    });
  }

  it("the defaults alone warn of no weakening", () => {
    expect(v130(goSrc()).filter((m) => m.includes("weakens the sandbox"))).toEqual([]);
  });

  it("allowWrite outside the denied paths is no weakening", () => {
    expect(v130(goSrc("", '      sandbox.filesystem.allowWrite: ["~/.kube", "./build"]\n')).filter((m) => m.includes("weakens the sandbox"))).toEqual([]);
  });
});

describe("[sandbox] the empty network allow-list", () => {
  const TEXT = "the sandbox allows no network hosts: npm, git over HTTPS and curl will prompt or fail; list your hosts in settings { sandbox { network { allowedDomains } } }";
  it("a go word with no allowed hosts warns, naming docker and SSH git on macOS", () => {
    const m = v130(goSrc()).find((x) => x.includes("allows no network hosts"));
    expect(m).toBeDefined();
    expect(m).toContain(TEXT.split("; list")[0]);
    expect(m).toContain("allowedDomains");
    expect(m).toContain("docker");
    expect(m).toContain("excludedCommands");
    expect(m).toContain("SSH");
    expect(m).toContain("macOS");
  });

  it("listed hosts: no warning", () => {
    expect(v130(goSrc("", "      sandbox.network.allowedDomains: [registry.npmjs.org]\n")).some((x) => x.includes("allows no network hosts"))).toBe(false);
  });

  it("no go word: no sandbox warning at all", () => {
    expect(v130(NO_WORD).some((x) => x.includes("sandbox"))).toBe(false);
  });
});

describe("[sandbox] guard --check grades the go none when the sandbox is weakened", () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-sandbox-")); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function grade(src: string) {
    const ast = parse(src);
    const warn = console.warn;
    console.warn = () => {};
    try {
      for (const f of claudeCodeBinding.scaffold(ast)) {
        fs.mkdirSync(dirname(join(root, f.path)), { recursive: true });
        fs.writeFileSync(join(root, f.path), f.content);
      }
    } finally {
      console.warn = warn;
    }
    return checkGuards(ast, root).items.find((i) => i.kind === "gate" && i.id === "go-given")!;
  }

  it("with the defaults the go keeps its grade", () => {
    expect(grade(goSrc()).strength).not.toBe("none");
  });

  for (const [name, extra, ext, key] of [
    ["enabled false", "", "      sandbox.enabled: false\n", "sandbox.enabled"],
    ["allowUnsandboxedCommands true", "", "      sandbox.allowUnsandboxedCommands: true\n", "sandbox.allowUnsandboxedCommands"],
    ["failIfUnavailable false", "", "      sandbox.failIfUnavailable: false\n", "sandbox.failIfUnavailable"],
    ["allowWrite covering the go ledger", "", '      sandbox.filesystem.allowWrite: ["."]\n', "sandbox.filesystem.allowWrite"],
  ] as const) {
    it(name, () => {
      const g = grade(goSrc(extra, ext));
      expect(g.strength).toBe("none");
      expect(g.notes.join("\n")).toContain(key);
    });
  }

  it("a settings.json with no sandbox (scaffolded before 0.13.1) grades the go none", () => {
    const g0 = grade(goSrc());
    expect(g0.strength).not.toBe("none");
    const p = join(root, ".claude/settings.json");
    const s = JSON.parse(fs.readFileSync(p, "utf8"));
    delete s.sandbox;
    fs.writeFileSync(p, JSON.stringify(s));
    const g = checkGuards(parse(goSrc()), root).items.find((i) => i.kind === "gate" && i.id === "go-given")!;
    expect(g.strength).toBe("none");
    expect(g.notes.join("\n")).toContain("sandbox.enabled");
  });
});
