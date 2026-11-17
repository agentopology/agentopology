/**
 * The frontmatter editor changes only the keys it is asked to change.
 *
 * Every other byte of the file stays as the author wrote it: other keys,
 * comments, key order, quoting, line endings, a byte-order mark, and the whole
 * body after the closing fence. What it cannot edit safely it refuses, and a
 * refusal writes nothing.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  patchFrontmatter,
  readFrontmatter,
  sameFieldValue,
  showFieldValue,
  type FrontmatterEdit,
} from "../frontmatter-patch.js";

const sha = (s: string) => createHash("sha256").update(s, "utf-8").digest("hex");

/** Everything from the closing fence on: the part no edit may touch. */
function bodyOf(text: string): string {
  const lines = text.split(/(?<=\n)/);
  for (let i = 1; i < lines.length; i++) {
    if (/^---[ \t]*\r?\n?$/.test(lines[i])) return lines.slice(i).join("");
  }
  throw new Error("no closing fence");
}

/** The frontmatter lines of every key, as written. */
function spans(text: string): Map<string, string[]> {
  const r = readFrontmatter(text);
  if (!r.ok) throw new Error(`refused: ${r.code} ${r.message}`);
  return new Map([...r.fields].map(([k, f]) => [k, f.lines]));
}

const BODY = [
  "",
  "# Builder",
  "",
  "Prose the author wrote. It has a colon: here, a list:",
  "- tools: not a key",
  "---",
  "model: not frontmatter either",
  "",
  "<!-- agentopology:prompt -->",
  "Keep me.",
  "<!-- /agentopology:prompt -->",
  "",
].join("\n");

/** Real frontmatter shapes: what Claude Code users and import actually write. */
const SHAPES: Record<string, string> = {
  "comma tools": [
    "---",
    "name: builder",
    "description: Builds the thing",
    "tools: Read, Grep, Bash",
    "model: sonnet",
    "---",
  ].join("\n") + BODY,
  "yaml list tools": [
    "---",
    "name: builder",
    "description: Builds the thing",
    "tools:",
    "  - Read",
    "  - Grep",
    "model: sonnet",
    "color: blue",
    "---",
  ].join("\n") + BODY,
  "list at column zero": [
    "---",
    "name: builder",
    "tools:",
    "- Read",
    "- Grep",
    "model: sonnet",
    "---",
  ].join("\n") + BODY,
  "flow list": [
    "---",
    "name: builder",
    "tools: [Read, \"Grep\", 'Bash(git *)']",
    "model: sonnet",
    "---",
  ].join("\n") + BODY,
  "quoted values": [
    "---",
    "name: 'builder'",
    "description: \"Builds: the thing, carefully\"",
    "model: \"sonnet\"",
    "---",
  ].join("\n") + BODY,
  comments: [
    "---",
    "# who I am",
    "name: builder # inline note",
    "description: Builds the thing",
    "",
    "# the model, picked by hand",
    "model: sonnet   # fast enough",
    "tools: Read, Grep",
    "---",
  ].join("\n") + BODY,
  crlf: [
    "---",
    "name: builder",
    "description: Builds the thing",
    "tools: Read, Grep",
    "model: sonnet",
    "---",
  ].join("\r\n") + BODY.replace(/\n/g, "\r\n"),
  bom: "﻿" + ["---", "name: builder", "model: sonnet", "tools: Read", "---"].join("\n") + BODY,
  "block scalar and nested map on other keys": [
    "---",
    "name: builder",
    "description: |",
    "  Builds the thing.",
    "",
    "  model: this is prose inside a block",
    "hooks:",
    "  PreToolUse:",
    "    - matcher: \"Bash\"",
    "      hooks:",
    "        - type: command",
    "          command: \"bash guard.sh\"",
    "model: sonnet",
    "tools: Read",
    "---",
  ].join("\n") + BODY,
  "no trailing newline": ["---", "name: builder", "model: sonnet", "tools: Read", "---"].join("\n"),
  "tabs inside values": ["---", "name: builder", "description: a\tb", "model: sonnet", "tools: Read", "---"].join("\n") + BODY,
  "multi-line plain description": [
    "---",
    "name: builder",
    "description: Builds the thing and then",
    "  checks it twice",
    "model: sonnet",
    "tools: Read",
    "---",
  ].join("\n") + BODY,
};

/** The edits scaffold makes, written in the binding's own style. */
const EDITS: Record<string, { edits: FrontmatterEdit[]; expect: Record<string, unknown> }> = {
  "change model": { edits: [{ key: "model", lines: ["model: haiku"] }], expect: { model: "haiku" } },
  "set tools (comma style)": {
    edits: [{ key: "tools", lines: ["tools: Read, Write"] }],
    expect: { tools: "Read, Write" },
  },
  "add skills (list style)": {
    edits: [{ key: "skills", lines: ["skills:", "  - lint", "  - ship"] }],
    expect: { skills: ["lint", "ship"] },
  },
  "remove model": { edits: [{ key: "model", remove: true }], expect: { model: undefined } },
  "two keys at once": {
    edits: [
      { key: "model", lines: ["model: opus"] },
      { key: "maxTurns", lines: ["maxTurns: 5"] },
    ],
    expect: { model: "opus", maxTurns: "5" },
  },
};

describe("format fuzz: only the target key changes, the body is byte-identical", () => {
  for (const [shape, text] of Object.entries(SHAPES)) {
    for (const [name, { edits, expect: want }] of Object.entries(EDITS)) {
      it(`${shape} × ${name}`, () => {
        const before = spans(text);
        const r = patchFrontmatter(text, edits);
        if (!r.ok) throw new Error(`refused: ${r.code} ${r.message}`);
        expect(sha(bodyOf(r.text))).toBe(sha(bodyOf(text)));
        if (text.startsWith("﻿")) expect(r.text.startsWith("﻿")).toBe(true);
        // Line endings follow the file.
        if (text.includes("\r\n")) expect(r.text.replace(/\r\n/g, "")).not.toContain("\n");
        const after = spans(r.text);
        const touched = new Set(edits.map((e) => e.key));
        for (const [k, lines] of before) {
          if (!touched.has(k)) expect(after.get(k), `untouched key ${k}`).toEqual(lines);
        }
        // Key order of the untouched keys is kept.
        const order = (m: Map<string, unknown>) => [...m.keys()].filter((k) => !touched.has(k));
        expect(order(after)).toEqual(order(before));
        const read = readFrontmatter(r.text);
        if (!read.ok) throw new Error("re-read refused");
        for (const [k, v] of Object.entries(want)) {
          expect(read.fields.get(k)?.value, k).toEqual(v);
        }
        // Applying the same edits again changes nothing.
        const again = patchFrontmatter(r.text, edits);
        expect(again.ok && again.text).toBe(r.text);
        expect(again.ok && again.changed).toBe(false);
      });
    }
  }
});

describe("the editor reads values the way Claude Code writes them", () => {
  it("a comma string and a YAML list of the same tools are the same set", () => {
    expect(sameFieldValue("tools", "Read, Grep", ["Grep", "Read"])).toBe(true);
    expect(sameFieldValue("tools", "Read, Grep", ["Read"])).toBe(false);
    expect(sameFieldValue("allowed-tools", "Bash(git add *) Read", ["Read", "Bash(git add *)"])).toBe(true);
  });
  it("quoting does not change a scalar", () => {
    const a = readFrontmatter("---\nmodel: \"sonnet\"\n---\n");
    const b = readFrontmatter("---\nmodel: sonnet\n---\n");
    if (!a.ok || !b.ok) throw new Error("refused");
    expect(sameFieldValue("model", a.fields.get("model")!.value, b.fields.get("model")!.value)).toBe(true);
  });
  it("a value prints the way a person reads it", () => {
    expect(showFieldValue("sonnet")).toBe("sonnet");
    expect(showFieldValue(["Read", "Grep"])).toBe("[Read, Grep]");
    expect(showFieldValue(undefined)).toBe("(absent)");
  });
});

describe("an edit that changes nothing writes nothing", () => {
  it("the same value in the same spelling is a no-op", () => {
    const text = SHAPES["comma tools"];
    const r = patchFrontmatter(text, [{ key: "model", lines: ["model: sonnet"] }]);
    expect(r.ok && r.changed).toBe(false);
    expect(r.ok && r.text).toBe(text);
  });
  it("removing a key that is not there is a no-op", () => {
    const text = SHAPES["comma tools"];
    const r = patchFrontmatter(text, [{ key: "color", remove: true }]);
    expect(r.ok && r.text).toBe(text);
  });
});

describe("an empty file gets a frontmatter block", () => {
  it("creates the fence around the new keys", () => {
    const r = patchFrontmatter("", [{ key: "model", lines: ["model: haiku"] }]);
    expect(r.ok && r.text).toBe("---\nmodel: haiku\n---\n");
  });
});

describe("refuses what it cannot edit safely, and writes nothing", () => {
  const cases: Array<[string, string, string]> = [
    ["no frontmatter in a file with text", "# Builder\n\nProse only.\n", "no-frontmatter"],
    ["an unterminated block", "---\nname: builder\nmodel: sonnet\n\nProse.\n", "unterminated"],
    ["an anchor", "---\nname: builder\ntools: &t [Read]\nmodel: sonnet\n---\nBody\n", "anchor-or-alias"],
    ["an alias", "---\nname: builder\ntools: *t\nmodel: sonnet\n---\nBody\n", "anchor-or-alias"],
    ["a merge key", "---\nname: builder\n<<: *base\nmodel: sonnet\n---\nBody\n", "anchor-or-alias"],
    ["an alias in a list", "---\nname: builder\ntools:\n  - *read\nmodel: sonnet\n---\nBody\n", "anchor-or-alias"],
    ["a document end marker", "---\nname: builder\n...\n---\nBody\n", "multi-document"],
    ["a second document start", "---\nname: builder\n--- !doc\nmodel: x\n---\nBody\n", "multi-document"],
    ["a directive", "---\n%YAML 1.2\nname: builder\n---\nBody\n", "multi-document"],
    ["a duplicate key", "---\nname: builder\nmodel: sonnet\nmodel: opus\n---\nBody\n", "duplicate-key"],
    ["an unclosed quote", "---\nname: builder\ndescription: \"Builds\nmodel: sonnet\n---\nBody\n", "unbounded-value"],
    ["an unclosed flow list", "---\nname: builder\ntools: [Read,\nmodel: sonnet\n---\nBody\n", "unbounded-value"],
    ["a line that is not a key", "---\nname: builder\njust words\n---\nBody\n", "unparseable-line"],
  ];
  for (const [name, text, code] of cases) {
    it(name, () => {
      const r = patchFrontmatter(text, [{ key: "model", lines: ["model: haiku"] }]);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe(code);
        expect(r.message.length).toBeGreaterThan(0);
      }
    });
  }
  it("an edit whose lines do not start with its key", () => {
    const r = patchFrontmatter(SHAPES["comma tools"], [{ key: "model", lines: ["tools: Read"] }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("bad-edit");
  });
});
