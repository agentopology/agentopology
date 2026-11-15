/**
 * S-35: frontmatter values that span lines. Each fixture is a small synthetic
 * agent or skill file for one YAML 1.2 shape.
 */
import { describe, it, expect } from "vitest";
import { parseFrontmatter, parseAgentMd } from "../claude-code.js";
import { importFromPlatform } from "../index.js";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import type { PlatformFile } from "../../sync/index.js";

const fm = (yaml: string, body = "Body.") => `---\n${yaml}\n---\n\n${body}\n`;
const fields = (yaml: string) => parseFrontmatter(fm(yaml)).fields;

describe("S-35: block scalars (YAML 1.2, 8.1)", () => {
  it("folded `>` joins lines with a space and keeps one final newline (clip)", () => {
    expect(fields("description: >\n  Reviews a diff\n  for bugs.\nmodel: opus")).toEqual({
      description: "Reviews a diff for bugs.\n",
      model: "opus",
    });
  });

  it("folded `>-` strips the final newline", () => {
    expect(fields("description: >-\n  Reviews a diff\n  for bugs.\n").description).toBe("Reviews a diff for bugs.");
  });

  it("folded keeps a blank line as a paragraph break", () => {
    expect(fields("description: >-\n  One\n  two.\n\n  Three.").description).toBe("One two.\nThree.");
  });

  it("folded keeps the break around a more-indented line", () => {
    expect(fields("description: >-\n  Intro:\n    - item\n  End.").description).toBe("Intro:\n  - item\nEnd.");
  });

  it("literal `|` keeps every newline", () => {
    expect(fields("description: |\n  Line one\n  Line two\nname: x")).toEqual({
      description: "Line one\nLine two\n",
      name: "x",
    });
  });

  it("literal `|-` strips the final newline", () => {
    expect(fields("description: |-\n  Line one\n\n  Line three\n").description).toBe("Line one\n\nLine three");
  });

  it("literal `|+` keeps the trailing newlines", () => {
    expect(fields("description: |+\n  Line one\n\nname: x").description).toBe("Line one\n\n");
  });

  it("an explicit indentation digit keeps the extra spaces", () => {
    expect(fields("description: |2-\n    indented\n  flush").description).toBe("  indented\nflush");
  });

  it("lines that look like `key: value` inside a block are text, not keys", () => {
    expect(fields('description: |-\n  Context: a user asks.\n  user: "fix it"\nmodel: opus')).toEqual({
      description: 'Context: a user asks.\nuser: "fix it"',
      model: "opus",
    });
  });
});

describe("S-35: plain scalars over several lines (YAML 1.2, 7.3.3, 6.5)", () => {
  it("a more-indented line continues the value, joined with a space", () => {
    expect(fields("description: Reviews a diff\n  for bugs.\nmodel: opus")).toEqual({
      description: "Reviews a diff for bugs.",
      model: "opus",
    });
  });

  it("a blank line inside the continuation is a newline", () => {
    expect(fields("description: One\n  two.\n\n  Three.").description).toBe("One two.\nThree.");
  });

  it("a value that starts on the next indented line", () => {
    expect(fields("description:\n  Reviews a diff\n  for bugs.\nmodel: opus")).toEqual({
      description: "Reviews a diff for bugs.",
      model: "opus",
    });
  });
});

describe("S-35: quoted scalars over several lines (YAML 1.2, 7.3.1, 7.3.2)", () => {
  it("double-quoted: a line break folds to a space", () => {
    expect(fields('description: "Reviews a diff\n  for bugs."\nmodel: opus')).toEqual({
      description: "Reviews a diff for bugs.",
      model: "opus",
    });
  });

  it("single-quoted: a line break folds to a space, a blank line to a newline", () => {
    expect(fields("description: 'One\n  two.\n\n  Three.'\nmodel: opus")).toEqual({
      description: "One two.\nThree.",
      model: "opus",
    });
  });
});

describe("S-35: the closing fence is a line that is exactly ---", () => {
  it("a value containing --- does not end the frontmatter", () => {
    const r = parseFrontmatter(fm("description: a --- b\nmodel: opus"));
    expect(r.fields).toEqual({ description: "a --- b", model: "opus" });
    expect(r.body).toBe("Body.");
  });

  it("a --- rule in the body stays in the body", () => {
    const r = parseFrontmatter(fm("name: x", "Top.\n\n---\n\nBottom."));
    expect(r.fields).toEqual({ name: "x" });
    expect(r.body).toBe("Top.\n\n---\n\nBottom.");
  });
});

describe("S-35: shapes that already parsed keep their parse", () => {
  it("single-line values, quotes, booleans, lists and colons", () => {
    expect(
      fields(
        [
          "name: reviewer",
          'description: "Quoted: with a colon"',
          "model: 'opus'",
          "disable-model-invocation: true",
          "user-invocable: false",
          "tools:",
          "  - Read",
          "  - Grep",
          "skills: a, b",
        ].join("\n"),
      ),
    ).toEqual({
      name: "reviewer",
      description: "Quoted: with a colon",
      model: "opus",
      "disable-model-invocation": true,
      "user-invocable": false,
      tools: ["Read", "Grep"],
      skills: "a, b",
    });
  });

  it("an indented `key: value` under an empty key reads as before", () => {
    expect(fields("hooks:\n  PreToolUse: x\nname: y")).toEqual({ hooks: [], PreToolUse: "x", name: "y" });
  });

  it("no frontmatter, or no closing fence, returns the content as body", () => {
    expect(parseFrontmatter("Just text.")).toEqual({ fields: {}, body: "Just text." });
    expect(parseFrontmatter("---\nname: x\n")).toEqual({ fields: {}, body: "---\nname: x\n" });
  });

  it("CRLF line ends", () => {
    const r = parseFrontmatter("---\r\nname: x\r\ndescription: y\r\n---\r\nBody.\r\n");
    expect(r.fields).toEqual({ name: "x", description: "y" });
    expect(r.body).toBe("Body.");
  });
});

describe("S-35: import carries the whole description into a valid .at", () => {
  const agentFile = (description: string): PlatformFile =>
    ({ path: ".claude/agents/reviewer.md", content: fm(`name: reviewer\n${description}\nmodel: opus`, "Review it.") }) as PlatformFile;

  it("parseAgentMd reads a folded description", () => {
    const node = parseAgentMd("reviewer", agentFile("description: >\n  Reviews a diff\n  for bugs.").content) as {
      description?: string;
    };
    expect(node.description?.trim()).toBe("Reviews a diff for bugs.");
  });

  for (const [shape, yaml] of [
    ["folded", "description: >\n  Reviews a diff\n  for bugs."],
    ["literal", "description: |\n  Reviews a diff\n  for bugs."],
    ["plain", "description: Reviews a diff\n  for bugs."],
  ] as const) {
    it(`a ${shape} description lands on one line and validates`, () => {
      const at = importFromPlatform([agentFile(yaml)], "claude-code", "pilot");
      expect(at).toContain('description: "Reviews a diff for bugs."');
      const errors = validate(parse(at)).filter((r) => r.level === "error");
      expect(errors).toEqual([]);
    });
  }
});
