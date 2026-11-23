/**
 * `context { file, includes, max-lines, glossary }` writes the context file:
 * one block between agentopology markers, the rest of the file the user's.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { claudeCodeBinding } from "../claude-code.js";
import { computeIncrementalPlan, executeActions } from "../../scaffold/incremental.js";

const topo = (ctx: string, entry = "entry: lead") => `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "x"
    ${entry}
  }
  orchestrator {
    model: opus
    handles: [intake]
  }
  action intake {
    kind: inline
    description: "in"
  }
  agent lead {
    model: sonnet
    description: "Leads"
    prompt { Lead. }
  }
  agent worker {
    model: sonnet
    description: "Works"
    prompt { Work. }
  }
  flow {
    intake -> lead
    lead -> worker
  }
  ${ctx}
}`;

const CTX = `context {
    file: "CLAUDE.md"
    includes: [docs/style.md, docs/api.md]
    max-lines: 40
    glossary {
      "ticket": "A unit of customer work"
      "sprint": "Two weeks, Monday to Friday"
    }
  }`;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ctx-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function scaffold(src: string): void {
  const ast = parse(src);
  const files = claudeCodeBinding.scaffold(ast);
  const actions = computeIncrementalPlan(dir, "claude-code", files, null);
  executeActions(dir, actions, { prune: false, force: false });
}

describe("context block: parsing", () => {
  it("reads max-lines and the glossary in order", () => {
    const ast = parse(topo(CTX));
    expect(ast.context.maxLines).toBe(40);
    expect(ast.context.glossary).toEqual([
      { term: "ticket", definition: "A unit of customer work" },
      { term: "sprint", definition: "Two weeks, Monday to Friday" },
    ]);
    expect(ast.context.file).toBe("CLAUDE.md");
    expect(ast.context.includes).toEqual(["docs/style.md", "docs/api.md"]);
  });
});

describe("context block: generated file", () => {
  it("writes CLAUDE.md with one marked block when file: is declared", () => {
    const files = claudeCodeBinding.scaffold(parse(topo(CTX)));
    const f = files.find((x) => x.path === "CLAUDE.md");
    expect(f).toBeDefined();
    const text = f!.content;
    expect(text.match(/agentopology:context:begin/g)).toHaveLength(1);
    expect(text.match(/agentopology:context:end/g)).toHaveLength(1);
    expect(text).toContain("lead");
    expect(text).toContain("If no agent is named, start as lead.");
    expect(text).toContain("@docs/style.md");
    expect(text).toContain("@docs/api.md");
    expect(text).toContain("ticket");
    expect(text).toContain("A unit of customer work");
  });

  it("writes no CLAUDE.md when file: is not declared", () => {
    const files = claudeCodeBinding.scaffold(parse(topo("context { includes: [docs/a.md] }")));
    expect(files.find((x) => /(^|\/)CLAUDE\.md$/.test(x.path))).toBeUndefined();
    const none = claudeCodeBinding.scaffold(parse(topo("")));
    expect(none.find((x) => /(^|\/)CLAUDE\.md$/.test(x.path))).toBeUndefined();
  });

  it("creates the file when missing", () => {
    scaffold(topo(CTX));
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
  });

  it("keeps every user line outside the block and replaces only the block", () => {
    writeFileSync(join(dir, "CLAUDE.md"), "# My project\n\nKeep me.\n");
    scaffold(topo(CTX));
    const first = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
    expect(first.startsWith("# My project\n\nKeep me.\n")).toBe(true);
    expect(first).toContain("If no agent is named, start as lead.");

    // The user adds lines above and below the block; the .at changes.
    writeFileSync(join(dir, "CLAUDE.md"), "TOP\n" + first + "BOTTOM\n");
    scaffold(topo(CTX.replace("Two weeks, Monday to Friday", "Fourteen days")));
    const second = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
    expect(second.startsWith("TOP\n# My project\n\nKeep me.\n")).toBe(true);
    expect(second.endsWith("BOTTOM\n")).toBe(true);
    expect(second).toContain("Fourteen days");
    expect(second).not.toContain("Monday to Friday");
    expect(second.match(/agentopology:context:begin/g)).toHaveLength(1);
  });

  it("is unchanged on a second run", () => {
    scaffold(topo(CTX));
    const a = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
    scaffold(topo(CTX));
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf-8")).toBe(a);
  });
});

describe("context block: validation", () => {
  it("warns (V137) on an include that does not exist, only with a project dir", () => {
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs/style.md"), "x");
    const ast = parse(topo(CTX));
    const without = validate(ast).filter((r) => r.rule === "V137");
    expect(without).toEqual([]);
    const withDir = validate(ast, { dir }).filter((r) => r.rule === "V137");
    expect(withDir).toHaveLength(1);
    expect(withDir[0].level).toBe("warning");
    expect(withDir[0].message).toContain("docs/api.md");
  });

  it("warns (V138) when the file is longer than max-lines", () => {
    const ast = parse(topo(CTX.replace("max-lines: 40", "max-lines: 5")));
    const r = validate(ast).filter((x) => x.rule === "V138");
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("warning");
    // The user's own lines count with --dir.
    writeFileSync(join(dir, "CLAUDE.md"), Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n") + "\n");
    const big = parse(topo(CTX));
    expect(validate(big).filter((x) => x.rule === "V138")).toEqual([]);
    expect(validate(big, { dir }).filter((x) => x.rule === "V138")).toHaveLength(1);
  });
});
