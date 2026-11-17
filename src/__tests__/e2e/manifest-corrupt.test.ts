/**
 * End to end: a scaffold manifest scaffold cannot read stops the run with one
 * line naming it, never a TypeError stack.
 *
 * Measured on 0.12.2: a manifest whose `files` is null, whose file entry is
 * null, or whose recorded frontmatter value is null, a number, an object or
 * a list of numbers crashed scaffold and validate --inventory with a stack.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../../dist/cli/index.js");
const AGENT = ".claude/agents/builder.md";
const MANIFEST = ".claude/.scaffold-manifest.json";
const AT = `topology t : [] {
  meta {
    version: "1.0.0"
  }

  agent builder {
    file: .claude/agents/builder.md
    model: sonnet
    description: "Builds"
    tools: [Read, Grep, Bash]
    invocation: manual
  }
}
`;
const HAND = "---\nname: builder\ndescription: Builds\nmodel: sonnet\ntools: Read, Grep\n---\n\nBODY\n";

let project: string;

function cli(args: string[]): { out: string; stdout: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { out, stdout: out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, stdout: e.stdout ?? "", code: e.status ?? 1 };
  }
}

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const j = (o: unknown) => JSON.stringify(o) + "\n";
const base = { source: "t.at", sourceHash: "", target: "claude-code", generatedAt: "2026-01-01T00:00:00.000Z" };

const CASES: Array<[string, string, string]> = [
  ["files is null", j({ ...base, files: null }), "files is not an object"],
  ["files is a string", j({ ...base, files: "x" }), "files is not an object"],
  ["a file entry is null", j({ ...base, files: { [AGENT]: null } }), `files["${AGENT}"] is not an entry with a hash`],
  ["fields is null", j({ ...base, files: {}, fields: null }), "fields is not an object"],
  ["a fields entry is null", j({ ...base, files: {}, fields: { [AGENT]: null } }), `fields["${AGENT}"] is not an object`],
  ["a fields entry is a list", j({ ...base, files: {}, fields: { [AGENT]: ["tools"] } }), `fields["${AGENT}"] is not an object`],
  ["a recorded value is null", j({ ...base, files: {}, fields: { [AGENT]: { tools: null } } }), `fields["${AGENT}"].tools is not a frontmatter value`],
  ["a recorded value is a number", j({ ...base, files: {}, fields: { [AGENT]: { tools: 5 } } }), `fields["${AGENT}"].tools is not a frontmatter value`],
  ["a recorded value is an empty object", j({ ...base, files: {}, fields: { [AGENT]: { tools: {} } } }), `fields["${AGENT}"].tools is not a frontmatter value`],
  ["a recorded list holds numbers", j({ ...base, files: {}, fields: { [AGENT]: { tools: [1, 2] } } }), `fields["${AGENT}"].tools is not a frontmatter value`],
];

beforeEach(() => {
  project = fs.mkdtempSync(join(os.tmpdir(), "at-manifest-corrupt-"));
  fs.writeFileSync(join(project, "t.at"), AT);
  fs.mkdirSync(dirname(join(project, AGENT)), { recursive: true });
  fs.writeFileSync(join(project, AGENT), HAND);
});

describe("a manifest scaffold cannot read: one line naming it, exit 1, nothing written", () => {
  for (const [label, text, why] of CASES) {
    it(label, () => {
      fs.writeFileSync(join(project, MANIFEST), text);
      const line = `Error: ${MANIFEST} is not a scaffold manifest this version can read: ${why}.`;

      for (const flags of [[], ["--dry-run"], ["--force"]]) {
        const r = cli(["scaffold", "t.at", "--target", "claude-code", ...flags]);
        expect(r.code, r.out).toBe(1);
        const out = plain(r.out);
        expect(out).not.toMatch(/TypeError|Cannot read|is not a function|^\s+at /m);
        expect(out).toContain(`${line} Fix or remove it by hand; nothing was written.`);
        expect(fs.readFileSync(join(project, AGENT), "utf-8")).toBe(HAND);
        expect(fs.readFileSync(join(project, MANIFEST), "utf-8")).toBe(text);
      }

      const inv = cli(["validate", "t.at", "--inventory", "."]);
      expect(inv.code, inv.out).toBe(1);
      expect(plain(inv.out)).not.toMatch(/TypeError|Cannot read|is not a function|^\s+at /m);
      expect(plain(inv.out)).toContain(line);

      const json = cli(["validate", "t.at", "--inventory", ".", "--json"]);
      expect(json.code, json.out).toBe(1);
      expect(JSON.parse(json.stdout)).toMatchObject({ schema: 1, file: "t.at", error: line.slice("Error: ".length) });
    });
  }

  it("a manifest it reads (the control) still scaffolds", () => {
    fs.writeFileSync(join(project, MANIFEST), j({ ...base, files: {}, fields: { [AGENT]: { tools: "Read, Grep", model: "sonnet" } } }));
    const r = cli(["scaffold", "t.at", "--target", "claude-code"]);
    expect(r.code, r.out).toBe(0);
  });
});
