/**
 * On cursor, an action's `commands:` run as written, whatever its kind
 * (spec/grammar.md, actions). The cursor binding used to drop the commands of
 * a report, decision or external action for a TODO line; inline and git kept
 * them. An action with no commands keeps the body it had
 * (fixtures/cursor-action-commands/commands.at).
 */

import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { cursorBinding } from "../../bindings/cursor.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/cursor-action-commands/commands.at");
const ast = parse(fs.readFileSync(FIXTURE, "utf-8"));

const quiet = <T>(f: () => T): T => {
  const warn = console.warn;
  console.warn = () => {};
  try { return f(); } finally { console.warn = warn; }
};
const files = quiet(() => cursorBinding.scaffold(ast));
const script = (id: string): string => {
  const f = files.find((x) => x.path === `.cursor/scripts/actions/${id}.sh`);
  expect(f, `${id}.sh is written`).toBeDefined();
  return f!.content;
};
/** The script after its header (shebang, comments, set -euo pipefail). */
const body = (id: string): string => script(id).split("set -euo pipefail\n")[1];

const tmp = fs.mkdtempSync(join(os.tmpdir(), "cursor-action-commands-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const run = (id: string) => {
  const p = join(tmp, `${id}.sh`);
  fs.writeFileSync(p, script(id));
  const r = spawnSync("bash", [p], { encoding: "utf8" });
  return { stdout: r.stdout, code: r.status };
};

const withCommands: Array<[string, string[], string]> = [
  ["report-run", ["echo report-one", "echo report-two"], "\n\n# Report generation\necho report-one\necho report-two\n"],
  ["decision-run", ["echo decision-one"], "\n\necho decision-one\n"],
  ["external-run", ["echo external-one"], "\n# External source: feed\n\necho external-one\n"],
  ["inline-run", ["echo inline-one"], "\n\necho inline-one\n"],
  ["git-run", ["echo git-one"], "\n\n# Git operation\necho git-one\n"],
];

describe("cursor: an action with commands writes and runs them, whatever its kind", () => {
  for (const [id, commands, expected] of withCommands) {
    it(`${id}: the script holds each command and runs them`, () => {
      const lines = script(id).split("\n");
      for (const cmd of commands) expect(lines).toContain(cmd);
      expect(script(id)).not.toContain("TODO");
      expect(body(id)).toBe(expected);
      const r = run(id);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(commands.map((c) => c.replace(/^echo /, "") + "\n").join(""));
    });
  }
});

describe("cursor: an action with no commands keeps today's body", () => {
  const bare: Array<[string, string]> = [
    ["report-bare", '\n\n# Report generation\necho "TODO: implement report action"\n'],
    ["decision-bare", '\n\necho "TODO: implement decision action"\n'],
    ["external-bare", '\n# External source: feed\n\necho "TODO: implement external action -- fetch from feed"\n'],
    ["inline-bare", '\n\necho "TODO: implement inline action"\n'],
    ["git-bare", '\n\n# Git operation\necho "TODO: implement git action"\n'],
  ];
  for (const [id, expected] of bare) {
    it(`${id}: unchanged`, () => {
      expect(body(id)).toBe(expected);
    });
  }
});
