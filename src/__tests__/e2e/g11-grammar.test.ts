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

describe("[T07] machines", () => {
  const machines = `  machines {
    machine mac { os: macos }
    machine box { os: linux }
  }`;
  const doc = (agentExtra = "", job = "", store = "", hooks = "", more = "") => `topology t : [pipeline] {
  meta { version: "1.0.0"
    description: "g11" }
${machines}
  memory {
    store notes {
      type: semantic
      backend: sqlite
${store}
    }
  }
  agent a {
    model: sonnet
    description: "a"
    runs: session
${agentExtra}
  }
  agent b {
    model: sonnet
    description: "b"
  }
${hooks}
${more}
  schedule {
    job nightly {
      cron: "0 3 * * *"
      agent: b
${job}
    }
  }
  flow { a -> b }
}`;

  it("[T07] parses the machines block and machine: on agents, jobs and stores, and round-trips them", () => {
    const ast = parse(doc("    machine: mac", "      machine: box", "      machine: mac"));
    expect(ast.machines).toEqual([{ id: "mac", os: "macos" }, { id: "box", os: "linux" }]);
    expect((ast.nodes.find((n) => n.id === "a") as any).machine).toBe("mac");
    expect(ast.schedules[0].machine).toBe("box");
    expect(ast.stores[0].machine).toBe("mac");
    const again = parse(serializeAST(ast));
    expect(again.machines).toEqual(ast.machines);
    expect((again.nodes.find((n) => n.id === "a") as any).machine).toBe("mac");
    expect(again.schedules[0].machine).toBe("box");
    expect(again.stores[0].machine).toBe("mac");
  });
  it("[T07] known machines validate clean", () => {
    expect(rule(doc("    machine: mac", "      machine: box", "      machine: mac"), "V122")).toHaveLength(0);
  });
  it("[T07] an unknown machine is an error on an agent, a job and a store", () => {
    const r = rule(doc("    machine: ghost", "      machine: ghost", "      machine: ghost"), "V122");
    expect(r).toHaveLength(3);
    expect(r.every((x) => x.level === "error" && /ghost/.test(x.message))).toBe(true);
  });
  it("[T07] a home-folder absolute path in a hook, gate, tool or action command is an error", () => {
    const hook = (run: string) => `  hooks { hook h { on: PreToolUse
      run: "${run}" } }`;
    for (const p of ["/Users/alice/bin/x.sh", "/home/bob/x.sh", "C:\\\\Users\\\\carol\\\\x.bat"]) {
      const r = rule(doc("", "", "", hook(p)), "V123");
      expect(r.length, p).toBe(1);
      expect(r[0].level).toBe("error");
    }
    const action = `  action act {
    kind: script
    commands: ["cd /Users/alice/proj && make"]
    description: "x"
  }`;
    expect(rule(doc("", "", "", "", action), "V123")).toHaveLength(1);
    const gate = `  gates { gate g { after: a
      run: "/home/bob/check.sh"
      on-fail: halt } }`;
    expect(rule(doc("", "", "", "", gate), "V123")).toHaveLength(1);
    const tool = `  tools { tool t { script: "/Users/alice/t.sh"
      description: "t" } }`;
    expect(rule(doc("", "", "", "", tool), "V123")).toHaveLength(1);
  });
  it("[T07] project-relative and system paths are fine", () => {
    const hook = `  hooks { hook h { on: PreToolUse
      run: "scripts/x.sh && /usr/bin/true && /home" } }`;
    expect(rule(doc("", "", "", hook), "V123")).toHaveLength(0);
  });
});
