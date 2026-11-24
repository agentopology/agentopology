import { describe, it, expect } from "vitest";
import { parse } from "../index.js";
import { validate } from "../validator.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";

const SRC = (extra = "") => `topology bt : [pipeline] {
  orchestrator {
    model: opus
    handles: [a]
  }
  action a { kind: inline }
  agent worker {
    model: opus
  }
  flow { a -> worker }
  ${extra}
}`;

const files = (src: string) => claudeCodeBinding.scaffold(parse(src));
const settingsOf = (src: string) => JSON.parse(files(src).find((f) => f.path === ".claude/settings.json")!.content);

describe("boundary:boundary parsing", () => {
  it("reads path, in, out and outbound", () => {
    const ast = parse(SRC(`boundary vendor { path: "vendor/**", in: read-only, out: pr, outbound: [api.example.com, "cdn.example.com"] }`));
    expect(ast.boundaries).toEqual([
      { id: "vendor", path: "vendor/**", in: "read-only", out: "pr", outbound: ["api.example.com", "cdn.example.com"] },
    ]);
  });
  it("reads a multi-line block and the optional branch", () => {
    const ast = parse(SRC(`boundary b {
    path: "~/shared"
    in: read-write
    out: direct
    branch: release
  }`));
    expect(ast.boundaries).toEqual([{ id: "b", path: "~/shared", in: "read-write", out: "direct", outbound: [], branch: "release" }]);
  });
  it("is not reported as an unknown block", () => {
    const res = validate(parse(SRC(`boundary b { path: "x/**", in: read-only }`)));
    // V91 is the test topology's own missing meta fields, not the block.
    expect(res.filter((r) => r.level === "error" && r.rule !== "V91")).toEqual([]);
  });
});

describe("boundary:validation", () => {
  const v = (extra: string, rule: string) => validate(parse(SRC(extra))).filter((r) => r.rule === rule);
  it("V164: a boundary with no path is an error", () => {
    const r = v(`boundary b { in: read-only }`, "V164");
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("error");
    expect(r[0].message).toContain("b");
  });
  it("V164: an empty path is an error", () => {
    expect(v(`boundary b { path: "" }`, "V164")).toHaveLength(1);
  });
  it("V165: an unknown in or out value is an error naming it", () => {
    const a = v(`boundary b { path: "x", in: readonly }`, "V165");
    expect(a).toHaveLength(1);
    expect(a[0].message).toContain("readonly");
    const b = v(`boundary b { path: "x", out: push }`, "V165");
    expect(b).toHaveLength(1);
    expect(b[0].message).toContain("push");
  });
  it("V165: an outbound entry that is not a host name is an error", () => {
    expect(v(`boundary b { path: "x", outbound: ["https://a.com/x"] }`, "V165")).toHaveLength(1);
    expect(v(`boundary b { path: "x", outbound: ["a b"] }`, "V165")).toHaveLength(1);
  });
  it("V165: a branch on an out that is not pr is an error", () => {
    expect(v(`boundary b { path: "x", out: none, branch: release }`, "V165")).toHaveLength(1);
  });
  it("V166: outbound hosts with no generated sandbox are a warning that says where they went", () => {
    const r = v(`boundary b { path: "x", outbound: [api.example.com] }`, "V166");
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("warning");
    expect(r[0].message).toContain("boundaries.md");
  });
  it("valid boundaries are clean", () => {
    const res = validate(parse(SRC(`boundary b { path: "vendor/**", in: read-only, out: pr }`)));
    expect(res.filter((r) => ["V164", "V165", "V166"].includes(r.rule))).toEqual([]);
  });
  it("two boundaries with one id are an error (V165)", () => {
    expect(v(`boundary b { path: "x" }\n  boundary b { path: "y" }`, "V165").length).toBeGreaterThan(0);
  });
});

describe("boundary:what is generated", () => {
  it("in: read-only writes Edit deny rules in the documented path forms", () => {
    const s = settingsOf(SRC(`boundary a { path: "vendor/**", in: read-only }
  boundary b { path: "~/shared/**", in: read-only }
  boundary c { path: "//opt/data", in: read-only }
  boundary d { path: "docs/**", in: read-write }`));
    expect(s.permissions.deny).toEqual(["Edit(/vendor/**)", "Edit(~/shared/**)", "Edit(//opt/data)"]);
  });
  it("adds to, and does not repeat, deny rules written in settings", () => {
    const s = settingsOf(SRC(`settings { deny: ["Edit(/vendor/**)", "Bash(rm *)"] }
  boundary a { path: "vendor/**", in: read-only }`));
    expect(s.permissions.deny).toEqual(["Edit(/vendor/**)", "Bash(rm *)"]);
  });
  it("writes before-boundary.sh and one PreToolUse hook on Edit|Write|MultiEdit|NotebookEdit|Bash that blocks on failure", () => {
    const fs = files(SRC(`boundary a { path: "vendor/**", in: read-only, out: pr }`));
    expect(fs.some((f) => f.path.endsWith("/before-boundary.sh") && f.executable)).toBe(true);
    const s = JSON.parse(fs.find((f) => f.path === ".claude/settings.json")!.content);
    const e = (s.hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string; onFailure?: string }> }>).filter((x) => x.hooks[0].command.includes("before-boundary.sh"));
    expect(e).toHaveLength(1);
    expect(e[0].matcher).toBe("Edit|Write|MultiEdit|NotebookEdit|Bash");
  });
  it("a boundary that restricts nothing (read-write, direct) writes no guard and no rule", () => {
    const fs = files(SRC(`boundary a { path: "docs/**", in: read-write, out: direct }`));
    expect(fs.some((f) => f.path.endsWith("before-boundary.sh"))).toBe(false);
    const settings = fs.find((f) => f.path === ".claude/settings.json");
    expect(settings ? JSON.parse(settings.content).permissions?.deny : undefined).toBeUndefined();
  });
  it("a topology with no boundary writes no boundary file", () => {
    const fs = files(SRC());
    expect(fs.some((f) => /before-boundary|boundaries\.md/.test(f.path))).toBe(false);
  });
  it("outbound hosts go to boundaries.md (the sandbox block is not on this branch), saying what is a rule and what a text check", () => {
    const md = files(SRC(`boundary a { path: "vendor/**", in: read-only, out: pr, outbound: [api.example.com] }`)).find((f) => f.path.endsWith("/boundaries.md"))!;
    expect(md.content).toContain("api.example.com");
    expect(md.content).toContain("sandbox.network.allowedDomains");
    expect(md.content).toMatch(/permission rule/i);
    expect(md.content).toMatch(/text check/i);
  });
  it("outbound hosts are not written to sandbox settings here", () => {
    const f = files(SRC(`boundary a { path: "x", outbound: [api.example.com] }`)).find((x) => x.path === ".claude/settings.json");
    expect(f ? JSON.parse(f.content).sandbox?.network : undefined).toBeUndefined();
  });
});
