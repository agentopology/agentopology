import { describe, it, expect } from "vitest";
import { parse } from "../index.js";
import { validate } from "../validator.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";

const SRC = (agentExtra = "", extra = "") => `topology t : [pipeline] {
  orchestrator {
    model: opus
    handles: [a]
  }
  action a { kind: inline }
  agent reviewer {
    model: opus
    ${agentExtra}
  }
  agent writer {
    model: opus
    never-reads: [".npmrc"]
  }
  flow { a -> reviewer -> writer }
  ${extra}
}`;

const settingsOf = (src: string) => {
  const files = claudeCodeBinding.scaffold(parse(src));
  return JSON.parse(files.find((f) => f.path === ".claude/settings.json")!.content);
};

describe("S-205: ask-reads parsing", () => {
  it("reads ask-reads on an agent", () => {
    const ast = parse(SRC(`ask-reads: ["~/.aws/**", "//etc/hosts", "notes/**"]`));
    const agent = ast.nodes.find((n) => n.id === "reviewer") as { askReads?: string[] };
    expect(agent.askReads).toEqual(["~/.aws/**", "//etc/hosts", "notes/**"]);
  });
  it("does not report ask-reads as unknown", () => {
    const res = validate(parse(SRC(`ask-reads: ["notes/**"]`)));
    expect(res.filter((r) => /unknown|not a (known )?field/i.test(r.message))).toEqual([]);
  });
});

describe("S-205: V158 never-reads and ask-reads overlap", () => {
  it("is an error when the same path is in both", () => {
    const src = SRC(`never-reads: ["private/**"]\n    ask-reads: ["private/**"]`);
    const v = validate(parse(src)).filter((r) => r.rule === "V158");
    expect(v).toHaveLength(1);
    expect(v[0].level).toBe("error");
    expect(v[0].message).toContain("private/**");
  });
  it("sees ./x and x as the same path, and ~/ and // forms as themselves", () => {
    const a = validate(parse(SRC(`never-reads: ["./private"]\n    ask-reads: ["private"]`))).filter((r) => r.rule === "V158");
    expect(a).toHaveLength(1);
    const b = validate(parse(SRC(`never-reads: ["~/.ssh/**"]\n    ask-reads: ["~/.ssh/**"]`))).filter((r) => r.rule === "V158");
    expect(b).toHaveLength(1);
  });
  it("is an error across agents (the ask rule is session-wide)", () => {
    const src = SRC(`ask-reads: [".npmrc"]`);
    expect(validate(parse(src)).filter((r) => r.rule === "V158")).toHaveLength(1);
  });
  it("is clean for different paths", () => {
    const src = SRC(`never-reads: ["private/**"]\n    ask-reads: ["notes/**", "~/.ssh/**"]`);
    expect(validate(parse(src)).filter((r) => r.rule === "V158")).toEqual([]);
  });
});

describe("S-205: ask-reads compiles to permissions.ask Read(...) in the documented forms", () => {
  // https://code.claude.com/docs/en/permissions, "Read and Edit": ~/path home, //path absolute, /path project root.
  it("writes ~/ as ~/, an absolute path as //, a project path anchored at the project root", () => {
    const s = settingsOf(SRC(`ask-reads: ["~/.aws/**", "//etc/hosts", "notes/**", ".env"]`));
    expect(s.permissions.ask).toEqual(["Read(~/.aws/**)", "Read(//etc/hosts)", "Read(/notes/**)", "Read(.env)"]);
  });
  it("adds to, and does not repeat, ask rules written in settings", () => {
    const s = settingsOf(SRC(`ask-reads: ["notes/**"]`, `settings { ask: ["Read(/notes/**)", "Bash(rm *)"] }`));
    expect(s.permissions.ask).toEqual(["Read(/notes/**)", "Bash(rm *)"]);
  });
  it("a topology with no ask-reads has no ask rules from this field", () => {
    const s = settingsOf(SRC(`never-reads: ["private/**"]`));
    expect(s.permissions?.ask).toBeUndefined();
  });
});

describe("S-205: never-reads and secrets with home and absolute paths (hook form)", () => {
  it("never-reads and secrets still do not write permission rules for project paths", () => {
    const s = settingsOf(SRC(`never-reads: ["private/**"]`));
    expect(s.permissions?.deny).toBeUndefined();
  });
  it("a secret nobody may read, at a home or absolute path, is also a Read deny rule", () => {
    const s = settingsOf(SRC("", `secrets { secret k { path: "~/.ssh/**", readers: [] }\n    secret e { path: "//etc/shadow", readers: [] } }`));
    expect(s.permissions.deny).toEqual(["Read(~/.ssh/**)", "Read(//etc/shadow)"]);
  });
  it("a secret with readers is not a global deny rule (the hook refuses per agent)", () => {
    const s = settingsOf(SRC("", `secrets { secret k { path: "~/.ssh/**", readers: [writer] } }`));
    expect(s.permissions?.deny).toBeUndefined();
  });
});
