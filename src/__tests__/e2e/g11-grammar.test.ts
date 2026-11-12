/**
 * 0.11 grammar lane (G11): inventory carry-over, T-10, T-07, T-06, T-09.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { collectInventory, coverage } from "../../inventory/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const sessionOps = fs.readFileSync(resolve(here, "fixtures/session-ops.at"), "utf8");
const compile = fs.readFileSync(resolve(here, "fixtures/compile.at"), "utf8");

describe("[N44c-inv] talk.jsonl is accounted for", () => {
  function withTalkLog(source: string) {
    const root = fs.mkdtempSync(join(os.tmpdir(), "at-g11-"));
    fs.mkdirSync(join(root, ".claude/state"), { recursive: true });
    fs.writeFileSync(join(root, ".claude/state/talk.jsonl"), "{}\n");
    const ast = parse(source);
    const r = coverage(ast, collectInventory(root), root);
    fs.rmSync(root, { recursive: true, force: true });
    return r.unmapped.map((i) => i.id);
  }
  it("[N44c-inv] is mapped when the topology declares session agents", () => {
    expect(withTalkLog(sessionOps)).not.toContain("claude-file:state/talk.jsonl");
  });
  it("[N44c-inv] is still unmapped when it declares none", () => {
    expect(withTalkLog(compile)).toContain("claude-file:state/talk.jsonl");
  });
});
