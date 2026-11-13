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

describe("[T06] schedule carrier and survives", () => {
  const withJob = (job: string) => `topology t : [pipeline] {
  meta { version: "1.0.0"
    description: "g11" }
  agent a {
    model: sonnet
    description: "a"
  }
  schedule {
    job j {
      cron: "0 3 * * *"
      agent: a
${job}
    }
  }
  flow { a -> a }
}`;
  it("[T06] parses carrier and survives and round-trips them", () => {
    const ast = parse(withJob("      carrier: launchd\n      survives: reboot"));
    expect(ast.schedules[0]).toMatchObject({ carrier: "launchd", survives: "reboot" });
    const again = parse(serializeAST(ast));
    expect(again.schedules[0]).toMatchObject({ carrier: "launchd", survives: "reboot" });
  });
  it("[T06] every carrier and survives value is accepted", () => {
    for (const c of ["session", "cron", "launchd", "cloud", "calendar"])
      expect(rule(withJob(`      carrier: ${c}`), "V124"), c).toHaveLength(0);
    for (const s of ["pane-close", "reboot", "away"])
      expect(rule(withJob(`      carrier: cron\n      survives: ${s}`), "V124"), s).toHaveLength(0);
  });
  it("[T06] an unknown carrier or survives value is an error", () => {
    expect(rule(withJob("      carrier: pigeon"), "V124")).toHaveLength(1);
    expect(rule(withJob("      carrier: cron\n      survives: forever"), "V124")).toHaveLength(1);
  });
  it("[T06] [L-2] carrier: session with any survives is an error that says why", () => {
    for (const s of ["pane-close", "reboot", "away"]) {
      const r = rule(withJob(`      carrier: session\n      survives: ${s}`), "V125");
      expect(r, s).toHaveLength(1);
      expect(r[0].level).toBe("error");
      expect(r[0].message).toContain("a session cron dies with its session and after 7 days");
    }
    expect(rule(withJob("      carrier: session"), "V125")).toHaveLength(0);
    expect(rule(withJob("      carrier: launchd\n      survives: reboot"), "V125")).toHaveLength(0);
  });
  it("[T06] inventory lists launchd plists and crontab lines that point into the project dir", () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), "at-g11-proj-"));
    const agents = fs.mkdtempSync(join(os.tmpdir(), "at-g11-la-"));
    fs.writeFileSync(join(agents, "com.me.mine.plist"), `<plist><dict><key>Label</key><string>com.me.mine</string><key>ProgramArguments</key><array><string>${root}/run.sh</string></array></dict></plist>`);
    fs.writeFileSync(join(agents, "com.me.other.plist"), `<plist><dict><key>ProgramArguments</key><array><string>/elsewhere/run.sh</string></array></dict></plist>`);
    const crontab = `# comment ${root}\n0 3 * * * ${root}/nightly.sh\n5 * * * * /elsewhere/x.sh\n`;
    const items = collectInventory(root, { launchAgentsDir: agents, crontab });
    const ids = items.map((i) => i.id);
    expect(ids).toContain("launchd:com.me.mine");
    expect(ids).not.toContain("launchd:com.me.other");
    expect(ids).toContain(`cron:0 3 * * * ${root}/nightly.sh`);
    expect(ids.filter((i) => i.startsWith("cron:"))).toHaveLength(1);
    // they are the machine's, listed apart and never required
    expect(items.find((i) => i.id === "launchd:com.me.mine")?.tag).toBe("e");
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(agents, { recursive: true, force: true });
  });
});

import { checkStep } from "../../step/check.js";

describe("[T09] person, away and valid", () => {
  const doc = (person: string, human: string, flow = "approve -> ship") => `topology t : [pipeline] {
  meta { version: "1.0.0"
    description: "g11" }
${person}
  human approve {
    description: "Sign off"
${human}
  }
  action ship {
    kind: script
    commands: ["./ship.sh"]
    description: "ship"
  }
  flow { ${flow} }
}`;
  const alice = `  person alice { away: "2026-11-10..2026-11-20" }`;
  const withToday = <T>(day: string, fn: () => T): T => {
    const old = process.env.AT_TODAY;
    process.env.AT_TODAY = day;
    try { return fn(); } finally { if (old === undefined) delete process.env.AT_TODAY; else process.env.AT_TODAY = old; }
  };

  it("[T09] parses person, who and valid, and round-trips them", () => {
    const ast = parse(doc(alice, "    who: alice\n    valid: \"2026-11-01..2026-12-01\"\n    timeout: 1h\n    on-timeout: skip"));
    expect(ast.persons).toEqual([{ id: "alice", away: "2026-11-10..2026-11-20" }]);
    const h = ast.nodes.find((n) => n.id === "approve") as any;
    expect(h.who).toBe("alice");
    expect(h.valid).toBe("2026-11-01..2026-12-01");
    const again = parse(serializeAST(ast));
    expect(again.persons).toEqual(ast.persons);
    expect((again.nodes.find((n) => n.id === "approve") as any).who).toBe("alice");
    expect((again.nodes.find((n) => n.id === "approve") as any).valid).toBe("2026-11-01..2026-12-01");
  });
  it("[T09] validate lists a step waiting on a person whose away window includes today, with its timeout behavior", () => {
    const src = doc(alice, "    who: alice\n    timeout: 1h\n    on-timeout: skip");
    const r = withToday("2026-11-12", () => rule(src, "V126"));
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("warning");
    expect(r[0].message).toContain("approve");
    expect(r[0].message).toContain("alice");
    expect(r[0].message).toContain("2026-11-10..2026-11-20");
    expect(r[0].message).toContain("skip");
  });
  it("[T09] a window that starts later is listed too; one that has ended is not", () => {
    const src = doc(alice, "    who: alice");
    expect(withToday("2026-11-01", () => rule(src, "V126"))).toHaveLength(1);
    expect(withToday("2026-11-21", () => rule(src, "V126"))).toHaveLength(0);
  });
  it("[T09] no timeout is said plainly", () => {
    const r = withToday("2026-11-12", () => rule(doc(alice, "    who: alice"), "V126"));
    expect(r[0].message).toMatch(/no timeout/);
  });
  it("[T09] a human with no who, or a person with no away window, is not listed", () => {
    expect(withToday("2026-11-12", () => rule(doc(alice, ""), "V126"))).toHaveLength(0);
    expect(withToday("2026-11-12", () => rule(doc("  person alice { }", "    who: alice"), "V126"))).toHaveLength(0);
  });
  it("[T09] an unknown person and a malformed or reversed window are errors", () => {
    expect(rule(doc(alice, "    who: bob"), "V127")).toHaveLength(1);
    expect(rule(doc('  person alice { away: "soon" }', "    who: alice"), "V127")).toHaveLength(1);
    expect(rule(doc('  person alice { away: "2026-11-20..2026-11-10" }', "    who: alice"), "V127")).toHaveLength(1);
    expect(rule(doc(alice, '    who: alice\n    valid: "2026-13-01..2026-14-01"'), "V127")).toHaveLength(1);
    expect(rule(doc(alice, '    who: alice\n    valid: "2026-11-01..2026-12-01"'), "V127")).toHaveLength(0);
  });
  it("[T09] step check refuses a step guarded by a human after that human's valid window", () => {
    const ast = parse(doc(alice, '    who: alice\n    valid: "2026-11-01..2026-11-30"'));
    const inside = checkStep(ast, "ship", { today: "2026-11-30" });
    expect(inside.ok).toBe(true);
    const after = checkStep(ast, "ship", { today: "2026-12-01" });
    expect(after.ok).toBe(false);
    expect(after.gates[0].reasons.join(" ")).toMatch(/approve.*2026-11-01\.\.2026-11-30/);
  });
  it("[T09] a gate after the human guards the step too; a human with no valid window never refuses", () => {
    const gateDoc = doc(alice, '    who: alice\n    valid: "2026-11-01..2026-11-30"', "approve -> ship").replace("  action ship", `  gates { gate sign { after: approve
      before: ship
      run: "scripts/ok.sh"
      on-fail: halt } }
  action ship`);
    const r = checkStep(parse(gateDoc), "ship", { today: "2027-01-01", dir: "/nonexistent" });
    expect(r.gates.some((g) => g.gate === "approve" && !g.ok)).toBe(true);
    expect(checkStep(parse(doc(alice, "    who: alice")), "ship", { today: "2027-01-01" }).ok).toBe(true);
  });
});
