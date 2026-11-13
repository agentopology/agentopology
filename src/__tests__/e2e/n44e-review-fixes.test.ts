/** Fixes from a code review of the whole 0.10.1 integration (N44e). */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";

const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;

const TOPO = (extra: string, flow: string, place = "ops") => `topology t : [hub] {
  meta { version: "1.0.0"
    description: "x" }
  orchestrator { model: sonnet
    handles: [lane-a] }
  agent lane-a { model: sonnet
    description: "a"
    runs: session
    place: ${place} }
  agent lane-b { model: sonnet
    description: "b"
    runs: session }
  ${extra}
  flow {
    ${flow}
  }
}
`;

let root: string;
beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-n44e-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function scaffoldTo(src: string) {
  const ast = parse(src);
  for (const f of claudeCodeBinding.scaffold(ast)) {
    const p = join(root, f.path);
    fs.mkdirSync(dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content);
    if (f.executable || f.path.endsWith(".sh")) fs.chmodSync(p, 0o755);
  }
  return ast;
}

describe("[N44e] talk guard allows non-session targets with snake_case or CamelCase ids", () => {
  it.skipIf(!hasJq)("[N44e] a session may message its declared subagent code_reviewer and CamelCase target", () => {
    const src = TOPO(
      `agent code_reviewer { model: sonnet
    description: "r" }
  agent Helper2 { model: sonnet
    description: "h" }`,
      `talk: all\n    lane-a -> code_reviewer\n    lane-a -> Helper2`,
    );
    scaffoldTo(src);
    const settings = JSON.parse(fs.readFileSync(join(root, ".claude/settings.json"), "utf8"));
    const cmd = settings.hooks.PreToolUse.find((x: any) => x.matcher === "SendMessage").hooks[0].command as string;
    const run = (to: string) =>
      spawnSync("/bin/sh", ["-c", cmd], {
        cwd: root,
        input: JSON.stringify({ tool_name: "SendMessage", tool_input: { to, message: "hi" } }),
        env: { ...process.env, CLAUDE_PROJECT_DIR: root, AT_SESSION: "lane-a" },
        encoding: "utf8",
      });
    expect(run("code_reviewer").status).toBe(0);
    expect(run("Helper2").status).toBe(0);
    expect(run("lane-b").status).toBe(0);
    expect(run("LANE-B").status).toBe(2); // session ids are lowercase kebab and match exactly
    expect(run("helper2").status).toBe(2); // other targets compare exactly
    expect(run("Code_Reviewer").status).toBe(2);
    expect(run("nobody").status).toBe(2);
  });
});

describe("[N44e] place and talk forms (V113)", () => {
  it("[N44e] place: Ops is a V113 error", () => {
    const r = validate(parse(TOPO("", "talk: all", "Ops")));
    expect(r.some((x) => x.rule === "V113" && x.level === "error" && /place/.test(x.message))).toBe(true);
  });
  it("[N44e] place: ops-2 is fine", () => {
    const r = validate(parse(TOPO("", "talk: all", "ops-2")));
    expect(r.filter((x) => x.rule === "V113" && x.level === "error")).toEqual([]);
  });
  it("[N44e] talk: hub with a non-session name is a V113 error naming it", () => {
    const r = validate(parse(TOPO("", "talk: hub ghost")));
    expect(r.some((x) => x.rule === "V113" && x.level === "error" && /ghost/.test(x.message))).toBe(true);
  });
  it("[N44e] talk: with any other form is a V113 error", () => {
    const r = validate(parse(TOPO("", "talk: everyone")));
    expect(r.some((x) => x.rule === "V113" && x.level === "error" && /everyone/.test(x.message))).toBe(true);
  });
});

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../../dist/cli/index.js");
const cli = (...a: string[]) => spawnSync("node", [CLI, ...a], { encoding: "utf8" });

const WITH_IMPORT = `topology t : [pipeline] {
  meta { version: "1.0.0"
    description: "x" }
  import missing from "./nope.at"
  orchestrator { model: sonnet
    handles: [a, b] }
  agent a { model: sonnet
    description: "a" }
  agent b { model: sonnet
    description: "b" }
  flow { a -> b }
}
`;

describe("[N44e] every CLI path that validates resolves imports", () => {
  for (const [name, args] of [
    ["scaffold", (f: string, d: string) => ["scaffold", f, "--target", "claude-code", "--output", d]],
    ["plan", (f: string, _d: string) => ["plan", f]],
    ["visualize", (f: string, d: string) => ["visualize", f, "--output", d]],
  ] as const) {
    it(`[N44e] ${name} of a file with a missing import refuses like validate does`, () => {
      const f = join(root, "t.at");
      fs.writeFileSync(f, WITH_IMPORT);
      const out = join(root, "out");
      const v = cli("validate", f);
      expect(v.status).toBe(1);
      const r = cli(...args(f, out));
      const text = r.stdout + r.stderr;
      if (name === "visualize") {
        // The page embeds the validation issues, so the missing import shows there.
        const html = fs.readdirSync(out).filter((x) => x.endsWith(".html")).map((x) => fs.readFileSync(join(out, x), "utf8")).join("");
        expect(html).toMatch(/file not found/);
        return;
      }
      expect(text, name).toMatch(/file not found|nope\.at/);
      expect(r.status, text).not.toBe(0);
    });
  }
});

import { generateVisualization, jsonForScript } from "../../visualizer/index.js";

describe("[N44e] the visualizer escapes inlined page data", () => {
  it("[N44e] an initial-prompt with </script><script>alert(1)</script> cannot break out of the data script", () => {
    const evil = "</script><script>alert(1)</script> & <!--";
    const src = `topology t : [pipeline] {
  meta { version: "1.0.0"
    description: "x" }
  orchestrator { model: sonnet
    handles: [a, b] }
  agent a { model: sonnet
    description: "a"
    initial-prompt: "${evil}" }
  agent b { model: sonnet
    description: "b" }
  flow { a -> b }
}
`;
    const html = generateVisualization(parse(src));
    const m = /const DEFAULT_DATA = (.*);\n/.exec(html)!;
    expect(m).not.toBeNull();
    expect(m[1]).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.stringify(JSON.parse(m[1]))).toContain("alert(1)"); // still decodes to the original text
    expect((html.match(/<\/script>/gi) ?? []).length).toBe((html.match(/<script\b/gi) ?? []).length);
    expect(html).not.toContain("<script>alert(1)");
  });
  it("[N44e] jsonForScript escapes <, >, &, U+2028 and U+2029 and round-trips", () => {
    const v = { a: "</script> <!-- & \u2028 \u2029 >" };
    const out = jsonForScript(v);
    expect(out).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(out)).toEqual(v);
  });
});

import { parseImportsDetailed } from "../../parser/index.js";

describe("[N44e] parseImportsDetailed ignores braces in strings and comments", () => {
  it("[N44e] an import after description: \"use { to open\" is kept", () => {
    const text = `meta {\n  description: "use { to open"\n}\nimport x from "./x.at"\n`;
    expect(parseImportsDetailed(text).imports.map((i) => i.alias)).toEqual(["x"]);
  });
  it("[N44e] a } in a string or a { in a # comment does not move the depth", () => {
    const text = `# a comment with {\nmeta {\n  description: "a } b \\" {"\n}\nimport y from "./y.at"\n`;
    expect(parseImportsDetailed(text).imports.map((i) => i.alias)).toEqual(["y"]);
  });
  it("[N44e] an import inside a block is still skipped", () => {
    const text = `agent a {\n  import z from "./z.at"\n}\n`;
    expect(parseImportsDetailed(text).imports).toEqual([]);
  });
});
