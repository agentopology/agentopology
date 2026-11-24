/**
 * The `ci { }` block is not part of this package: a .at that declares one fails validate (V155),
 * with a message in plain words, and scaffold writes no workflow for it.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "../index.js";
import { validate } from "../validator.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { pluginStateOf, setActivePlugins } from "../../plugins/runtime.js";
import type { AtPlugin } from "../../plugins/types.js";

const here = dirname(fileURLToPath(import.meta.url));
let acme: AtPlugin;
beforeAll(async () => {
  acme = (await import(pathToFileURL(join(here, "../../plugins/__tests__/fixtures/acme.mjs")).href)).default as AtPlugin;
});
afterEach(() => setActivePlugins([]));

const topo = (extra: string) => `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "x"
  }
  orchestrator {
    model: opus
    handles: [intake]
  }
  action intake {
    kind: inline
    description: "in"
  }
  action publish {
    kind: external
    description: "Publish"
    commands: ["echo publish"]
  }
  flow { intake -> publish }
  gates {
    gate ready {
      after: intake
      before: publish
      run: "scripts/ready.sh"
    }
  }
${extra}}
`;

const CI = `  ci {
    provider: github
    on: [push, pull_request]
    gates: [ready]
  }
`;

describe("the ci block is not part of this package", () => {
  it("a .at with a ci block fails validate with V155, in plain words", () => {
    const errors = validate(parse(topo(CI))).filter((r) => r.level === "error");
    const v155 = errors.filter((r) => r.rule === "V155");
    expect(v155).toHaveLength(1);
    expect(v155[0].message).toContain("the `ci` block isn't part of this package");
    expect(v155[0].message).toContain("a plugin can provide it");
  });

  it("the ci block is reported once, as V155, not also as an unknown block (V102)", () => {
    const r = validate(parse(topo(CI)));
    expect(r.filter((x) => x.rule === "V102" && x.message.includes("ci"))).toEqual([]);
  });

  it("a one-line ci block fails the same way", () => {
    const r = validate(parse(topo(`  ci { provider: github, gates: [ready] }\n`)));
    expect(r.filter((x) => x.rule === "V155" && x.level === "error")).toHaveLength(1);
  });

  // The brace on the next line, after a comment: the block is read, not dropped.
  const CI_NEXT_LINE = `  ci # the pipeline
  {
    provider: github
    on: [push, pull_request]
    gates: [ready]
  }
`;

  // Comment lines and a blank line between the name and the brace.
  const CI_LATER_LINE = `  ci
  # the pipeline

  # runs on push
  {
    provider: github
  }
`;

  it("a ci block whose brace is on the next line, after a comment, fails the same way", () => {
    const r = validate(parse(topo(CI_NEXT_LINE)));
    expect(r.filter((x) => x.rule === "V155" && x.level === "error")).toHaveLength(1);
  });

  it("a ci block whose brace comes after comment and blank lines fails the same way", () => {
    const r = validate(parse(topo(CI_LATER_LINE)));
    expect(r.filter((x) => x.rule === "V155" && x.level === "error")).toHaveLength(1);
  });

  it("an unknown block whose brace is on the next line is V102, not dropped", () => {
    const r = validate(parse(topo("  widget w1 # mine\n  {\n    a: 1\n  }\n")));
    expect(r.filter((x) => x.rule === "V102" && x.message.includes("widget w1"))).toHaveLength(1);
  });

  it("an empty ci {} fails the same way", () => {
    const r = validate(parse(topo("  ci {}\n")));
    expect(r.filter((x) => x.rule === "V155" && x.level === "error")).toHaveLength(1);
  });

  it("a loaded plugin that declares ci receives the block in both forms", () => {
    const withCi: AtPlugin = { ...acme, blocks: { ...acme.blocks, ci: { multiplicity: "single", fields: ["provider", "on", "gates"] } } };
    setActivePlugins([withCi]);
    for (const form of [CI, CI_NEXT_LINE, CI_LATER_LINE]) {
      const ast = parse(topo(form));
      const r = validate(ast);
      expect(r.filter((x) => x.rule === "V155"), form).toEqual([]);
      const blocks = pluginStateOf(ast)?.data.acme.ci as Array<Record<string, unknown>> | undefined;
      expect(blocks, form).toHaveLength(1);
      expect(blocks?.[0]?.provider, form).toBe("github");
    }
  });

  it("without a ci block there is no V155", () => {
    expect(validate(parse(topo(""))).filter((r) => r.rule === "V155")).toEqual([]);
  });

  it("with a loaded plugin that declares the ci block, there is no V155 and the plugin receives the block's data", () => {
    const withCi: AtPlugin = { ...acme, blocks: { ...acme.blocks, ci: { multiplicity: "single", fields: ["provider", "on", "gates"] } } };
    setActivePlugins([withCi]);
    const ast = parse(topo(CI));
    const r = validate(ast);
    expect(r.filter((x) => x.rule === "V155")).toEqual([]);
    expect(r.filter((x) => x.rule === "V102" && x.message.includes("ci"))).toEqual([]);
    // A plugin's block data is a list, one entry per block (a `single` block keeps the first).
    const blocks = pluginStateOf(ast)?.data.acme.ci as Array<Record<string, unknown>> | undefined;
    expect(blocks).toHaveLength(1);
    const ci = blocks?.[0];
    expect(ci?.provider).toBe("github");
    expect(String(ci?.gates)).toContain("ready");
  });

  it("scaffold writes no GitHub workflow for a ci block", () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      const files = claudeCodeBinding.scaffold(parse(topo(CI)));
      expect(files.filter((f) => f.path.startsWith(".github/"))).toEqual([]);
    } finally {
      console.warn = warn;
    }
  });
});
