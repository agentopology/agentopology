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

import { validate } from "../../parser/validator.js";
import { serializeAST } from "../../import/serializer.js";

const base = (stores: string, agents: string, extra = "") => `topology t : [pipeline] {
  meta { version: "1.0.0"
    description: "g11" }
  memory {
${stores}
  }
${extra}
${agents}
  flow { a -> b }
}`;
const agent = (id: string, extra = "") => `  agent ${id} {
    model: sonnet
    description: "${id}"
${extra}
  }`;
const rule = (src: string, id: string) => validate(parse(src)).filter((r) => r.rule === id);

describe("[T10] owner: on a store", () => {
  const store = (owner = "") => `    store notes {
      type: semantic
      backend: sqlite
      path: "notes/"
${owner}
    }`;
  const two = (aExtra: string, bExtra: string) => agent("a", aExtra) + "\n" + agent("b", bExtra);

  it("[T10] parses owner and round-trips it", () => {
    const ast = parse(base(store("      owner: a"), two("    memory: [notes]", "")));
    expect(ast.stores[0].owner).toBe("a");
    const again = parse(serializeAST(ast));
    expect(again.stores[0].owner).toBe("a");
  });
  it("[T10] two non-owner agents writing an owned store is an error naming both", () => {
    const src = base(store("      owner: c"), two("    memory: [notes]", "    memory: [notes]") + "\n" + agent("c"));
    const r = rule(src, "V121");
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("error");
    expect(r[0].message).toMatch(/"a"/);
    expect(r[0].message).toMatch(/"b"/);
  });
  it("[T10] one of the two being the owner is fine", () => {
    const src = base(store("      owner: a"), two("    memory: [notes]", "    memory: [notes]"));
    expect(rule(src, "V121")).toHaveLength(0);
  });
  it("[T10] an unowned store with two writers is not an error", () => {
    const src = base(store(), two("    memory: [notes]", "    memory: [notes]"));
    expect(rule(src, "V121")).toHaveLength(0);
  });
  it("[T10] an owner that is not an agent is an error", () => {
    const src = base(store("      owner: ghost"), two("", ""));
    const r = rule(src, "V121");
    expect(r).toHaveLength(1);
    expect(r[0].message).toMatch(/ghost/);
  });
});
