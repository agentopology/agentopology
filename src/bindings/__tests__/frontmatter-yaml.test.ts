/**
 * Every frontmatter scalar the Claude Code binding writes reads back, as
 * YAML, as the exact text the .at states: in a fresh file and in the lines
 * scaffold patches into an existing one (both come from the same writer).
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../claude-code.js";
import type { AgentNode } from "../../parser/ast.js";
import { frontmatterOf, readFrontmatterYaml, type YamlValue } from "./yaml-scalar-check.js";

/** Values a description can hold, as written inside an .at string. */
const VALUES = [
  "Reviews: code",
  "Use it #always or # never",
  "It's fine",
  "- starts with dash",
  "-",
  "-x leading dash, no space",
  "? what",
  "?",
  ": colon first",
  ", leading comma",
  "*bold* start",
  "&anchor",
  "!tag",
  "| piped",
  "> folded",
  "%YAML",
  "@mention",
  "`code`",
  "{a} [b]",
  "[list]",
  "# not a comment",
  "trailing #c",
  "ends with colon:",
  "yes",
  "No",
  "on",
  "1.0",
  "123",
  "0x1F",
  ".inf",
  "~",
  "null",
  "2024-01-01",
  "2024-01-01 10:00:00",
  "1:20",
  "---",
  "...",
  "סוכן בודק 🚀",
  "plain words stay plain",
];

const AT = (desc: string) => `topology t : [pipeline] {
  meta {
    version: "1.0.0"
  }
  agent alpha {
    description: "${desc}"
    model: sonnet
    prompt {
      Do alpha.
    }
  }
  agent beta {
    model: haiku
  }
  skills {
    skill helper {
      description: "${desc}"
      argument-hint: "${desc}"
    }
  }
  flow {
    alpha -> beta
  }
}
`;

function stringValue(fields: Map<string, YamlValue | YamlValue[]>, key: string): string | undefined {
  const v = fields.get(key);
  if (v === undefined || Array.isArray(v)) return undefined;
  return v.notString ? undefined : v.text;
}

describe("a frontmatter scalar reads back as YAML as the .at states it", () => {
  it.each(VALUES)("%j", (value) => {
    const ast = parse(AT(value));
    const stated = (ast.nodes.find((n) => n.id === "alpha") as AgentNode).description!;
    const { files, structure } = claudeCodeBinding.scaffoldStructured!(ast);
    const texts = [
      files.find((f) => f.path === ".claude/agents/alpha/AGENT.md")!.content,
      files.find((f) => f.path === ".claude/skills/helper/SKILL.md")!.content,
      // The lines scaffold patches into an existing file.
      ...structure.filter((s) => s.id === "alpha" || s.id === "helper").map((s) => s.content),
    ];
    for (const text of texts) {
      const read = readFrontmatterYaml(frontmatterOf(text));
      expect(read.ok ? "" : read.why, frontmatterOf(text)).toBe("");
      if (!read.ok) continue;
      expect(stringValue(read.fields, "description"), frontmatterOf(text)).toBe(stated);
      if (read.fields.has("argument-hint")) expect(stringValue(read.fields, "argument-hint")).toBe(stated);
    }
  });
});

describe("a list item reads back as YAML as the .at states it", () => {
  const SKILL_AT = `topology t : [pipeline] {
  meta {
    version: "1.0.0"
  }
  agent alpha {
    description: "Alpha"
    model: sonnet
    skills: [helper]
    prompt {
      x
    }
  }
  agent beta {
    model: haiku
  }
  skills {
    skill helper {
      description: "Helps"
      paths: ["*.ts", "src/**/*.md", "!dist/**", "docs/[a-z*.md", "a: b.txt", "x #y.txt", "- dash", "&amp", "yes", "123"]
      arguments: [issue, "*all", "yes", "123"]
      allowed-tools: ["Bash(git commit:*)", "Bash(echo # hi)", Read]
    }
  }
  flow {
    alpha -> beta
  }
}
`;

  it("paths, arguments and allowed-tools with YAML-special items", () => {
    const ast = parse(SKILL_AT);
    const skill = ast.skills.find((s) => s.id === "helper")!;
    const { files, structure } = claudeCodeBinding.scaffoldStructured!(ast);
    const texts = [
      files.find((f) => f.path === ".claude/skills/helper/SKILL.md")!.content,
      structure.find((s) => s.id === "helper")!.content,
    ];
    for (const text of texts) {
      const read = readFrontmatterYaml(frontmatterOf(text));
      expect(read.ok ? "" : read.why, frontmatterOf(text)).toBe("");
      if (!read.ok) continue;
      const list = (key: string) => {
        const v = read.fields.get(key);
        return Array.isArray(v) ? v.map((x) => (x.notString ? `(not a string) ${x.text}` : x.text)) : v?.text;
      };
      expect(list("paths")).toEqual(skill.paths);
      const args = list("arguments");
      expect(Array.isArray(args) ? args : String(args).split(" ")).toEqual(skill.arguments);
      const tools = list("allowed-tools");
      expect(Array.isArray(tools) ? tools : String(tools).split(", ")).toEqual(skill.allowedTools);
    }
  });
});
