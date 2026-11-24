/**
 * What a plugin reads (EXPERIMENTAL): the view carries records, persons and
 * skills (with their extensions), and a block's parse gets its block id.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { pluginStateOf, viewOf } from "../runtime.js";
import type { AtPlugin, ReadonlyTopology } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));
let acme: AtPlugin;
beforeAll(async () => {
  acme = (await import(pathToFileURL(join(here, "fixtures/acme.mjs")).href)).default as AtPlugin;
});

const SRC = [
  "topology w : [pipeline] {",
  "  meta {",
  '    version: "1.0.0"',
  '    description: "view"',
  "  }",
  "  orchestrator {",
  "    model: sonnet",
  "  }",
  "  agent a {",
  "    model: sonnet",
  "    prompt { Do a. }",
  "  }",
  "  flow {",
  "    a -> a [max 1]",
  "  }",
  "  records {",
  "    record trace {",
  '      path: "logs/trace.jsonl"',
  "    }",
  "  }",
  "  person p1 {",
  "  }",
  "  skill s1 {",
  '    description: "a skill"',
  "    extensions {",
  "      acme {",
  "        level: 2",
  "      }",
  "    }",
  "  }",
  "  gadget g1 {",
  "    hello",
  "  }",
  "  gadget {",
  "    plain",
  "  }",
  "}",
  "",
].join("\n");

describe("the view a plugin reads", () => {
  it("carries records with id and path, persons, and skills with their extensions", () => {
    const view: ReadonlyTopology = viewOf(parse(SRC, { plugins: [acme] }));
    const { records, persons, skills } = view as unknown as Record<string, Array<Record<string, unknown>> | undefined>;
    expect(records).toEqual([{ id: "trace", path: "logs/trace.jsonl" }]);
    expect(persons?.map((p) => p.id)).toEqual(["p1"]);
    expect(skills?.find((s) => s.id === "s1")?.extensions).toEqual({ acme: { level: 2 } });
    expect(Object.isFrozen(skills)).toBe(true);
  });

  it("acme reads extensions { acme { } } on a skill, and the records and persons, from the view", () => {
    const warn = console.warn;
    console.warn = () => {};
    let files;
    try {
      files = claudeCodeBinding.scaffold(parse(SRC, { plugins: [acme] }));
    } finally {
      console.warn = warn;
    }
    expect(JSON.parse(files.find((f) => f.path === ".claude/acme/view.json")!.content)).toEqual({
      skills: [{ id: "s1", acme: { level: 2 } }],
      records: [{ id: "trace", path: "logs/trace.jsonl" }],
      persons: ["p1"],
    });
  });
});

describe("a block's parse", () => {
  it("gets the block id (the name after the keyword), and none when there is none", () => {
    const data = pluginStateOf(parse(SRC, { plugins: [acme] }))?.data.acme.gadget;
    expect(data).toEqual([
      { name: "g1", line: 31, text: "hello" },
      { name: null, line: 34, text: "plain" },
    ]);
  });
});
