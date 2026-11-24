/**
 * A boundary's `outbound` hosts go into the sandbox block's `sandbox.network.allowedDomains`, and only
 * when the sandbox block is generated (a human with a go word turns it on). Without it they stay in
 * boundaries.md and V166 warns.
 */
import { describe, it, expect } from "vitest";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";

const HUMAN = `  human owner-go {
    description: "The owner types go"
    word: "go ship"
  }
`;

function src(opts: { goWord: boolean; ext?: string }): string {
  return `topology ob : [pipeline] {
  meta {
    version: "1.0.0"
    description: "Outbound hosts"
  }
  orchestrator {
    model: opus
    handles: [a]
  }
  action a { kind: inline }
  agent worker { model: opus }
${opts.goWord ? HUMAN : ""}  flow { a -> worker }
  records {
    record go-ledger { path: "logs/go.jsonl" }
  }
  boundary vendor { path: "vendor/**", in: read-only, outbound: [api.example.com, "*.npmjs.org"] }
  boundary docs { path: "docs/**", outbound: [api.example.com] }
${opts.ext ?? ""}}
`;
}

function scaffold(text: string) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return claudeCodeBinding.scaffold(parse(text));
  } finally {
    console.warn = warn;
  }
}

function settingsOf(text: string): any {
  const f = scaffold(text).find((x) => x.path === ".claude/settings.json");
  return f ? JSON.parse(f.content) : {};
}

function boundariesDoc(text: string): string {
  return scaffold(text).find((x) => x.path.endsWith("/boundaries.md"))?.content ?? "";
}

describe("boundary outbound hosts and the sandbox block", () => {
  it("with a go word, the hosts are written to sandbox.network.allowedDomains, once each", () => {
    const s = settingsOf(src({ goWord: true }));
    expect(s.sandbox?.enabled).toBe(true);
    expect(s.sandbox?.network?.allowedDomains).toEqual(["api.example.com", "*.npmjs.org"]);
  });

  it("with a go word, your own extensions allowedDomains are kept beside the hosts", () => {
    const ext = `  extensions {\n    claude-code {\n      sandbox.network.allowedDomains: ["github.com"]\n    }\n  }\n`;
    const d = settingsOf(src({ goWord: true, ext })).sandbox?.network?.allowedDomains ?? [];
    expect(d).toContain("github.com");
    expect(d).toContain("api.example.com");
    expect(d).toContain("*.npmjs.org");
  });

  it("with no go word, no sandbox block is generated and the hosts are not written to settings.json", () => {
    const s = settingsOf(src({ goWord: false }));
    expect(s.sandbox).toBeUndefined();
  });

  it("V166 warns only when no sandbox block is generated", () => {
    const without = validate(parse(src({ goWord: false }))).filter((r) => r.rule === "V166");
    expect(without.length).toBeGreaterThan(0);
    expect(without.every((r) => r.level === "warning")).toBe(true);
    expect(validate(parse(src({ goWord: true }))).filter((r) => r.rule === "V166")).toEqual([]);
  });

  it("with a go word, V130 does not warn that the sandbox allows no network hosts", () => {
    const r = validate(parse(src({ goWord: true }))).filter((x) => x.message.includes("allows no network hosts"));
    expect(r).toEqual([]);
  });

  it("boundaries.md says where the hosts went", () => {
    expect(boundariesDoc(src({ goWord: true }))).toContain("written to `sandbox.network.allowedDomains`");
    expect(boundariesDoc(src({ goWord: false }))).toContain("add them there yourself");
  });
});
