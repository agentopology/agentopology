import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { codexBinding } from "../codex.js";
import { codexSource } from "./codex-models.js";

afterEach(() => vi.restoreAllMocks());

const topo = (settings: string, agents = "") => `topology guarded : [pipeline] {
  meta {
    version: "1.0.0"
    description: "t"
  }

  agent worker {
    description: "Does work"
    model: gpt-5.2
    permissions: autonomous
    tools: [Read]
  }
${agents}
  action intake {
    kind: inline
    description: "entry"
  }

  flow { intake -> worker }

  settings {
${settings}
  }
}
`;

const scaffold = (src: string) => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const files = codexBinding.scaffold(parse(codexSource(src)));
  const warnings = warn.mock.calls.map((c) => String(c[0]));
  warn.mockRestore();
  return { files, warnings };
};

const codexInstalled = spawnSync("codex", ["--version"], { encoding: "utf8" }).status === 0;

describe("[CX-13] permission rules", () => {
  const src = topo(`    deny: ["Bash(git push *)", "Bash(rm -rf *)"]
    ask: ["Bash(git push --force *)"]
    allow: [Read, "Bash(npm test *)"]`);

  it("[CX-13] a topology that forbids git push writes a .rules file whose own match example is git push origin main", () => {
    const { files } = scaffold(src);
    const rules = files.find((f) => f.path === ".codex/rules/guarded.rules")!;
    expect(rules).toBeDefined();
    expect(rules.content).toContain('pattern = ["git", "push"]');
    expect(rules.content).toContain('decision = "forbidden"');
    expect(rules.content).toContain('match = [["git", "push", "origin", "main"]]');
  });

  it("[CX-13] ask becomes prompt and allow becomes allow; a whole-tool allow entry (Read) writes nothing", () => {
    const rules = scaffold(src).files.find((f) => f.path === ".codex/rules/guarded.rules")!.content;
    expect(rules).toMatch(/pattern = \["git", "push", "--force"\],\n\s+decision = "prompt"/);
    expect(rules).toMatch(/pattern = \["npm", "test"\],\n\s+decision = "allow"/);
    expect(rules).not.toContain('"Read"');
  });

  it("[CX-13] an entry a prefix rule cannot hold is reported, never dropped silently", () => {
    const odd = topo(`    deny: ["WebFetch", "Bash(git * main)", "Bash(git push *)"]`);
    const { warnings } = scaffold(odd);
    expect(warnings.filter((w) => w.includes('"WebFetch"'))).toHaveLength(1);
    expect(warnings.filter((w) => w.includes('"Bash(git * main)"'))).toHaveLength(1);
    const v = validate(parse(codexSource(odd)), { target: "codex" }).filter((r) => r.rule === "CX13");
    expect(v).toHaveLength(2);
  });

  it("[CX-13] no settings means no rules file", () => {
    const { files } = scaffold(topo(`    sandbox: workspace-write`));
    expect(files.some((f) => f.path.startsWith(".codex/rules/"))).toBe(false);
  });

  it("[CX-13] the strictest decision wins when one command is in two lists", () => {
    const both = topo(`    deny: ["Bash(git push *)"]\n    allow: ["Bash(git push *)"]`);
    const rules = scaffold(both).files.find((f) => f.path.startsWith(".codex/rules/"))!.content;
    expect(rules.match(/pattern = \["git", "push"\]/g)).toHaveLength(1);
    expect(rules).toContain('decision = "forbidden"');
  });

  it("[CX-13] agents that differ in permissions give one warning naming the strictest agent and policy", () => {
    const agents = `
  agent careful {
    description: "Asks"
    model: gpt-5.2
    permissions: supervised
    tools: [Read]
  }
  agent free {
    description: "Does not ask"
    model: gpt-5.2
    permissions: unrestricted
    tools: [Read]
  }
`;
    const { warnings } = scaffold(topo(`    sandbox: workspace-write`, agents));
    const w = warnings.filter((x) => x.includes("differ in permissions"));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("careful");
    expect(w[0]).toContain("on-request");
  });

  it.skipIf(!codexInstalled)("[CX-13] codex execpolicy check returns forbidden for git push (also with --force: the strictest wins), forbidden for rm -rf, allow for npm test, and nothing for git status", () => {
    const rules = scaffold(src).files.find((f) => f.path === ".codex/rules/guarded.rules")!;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx13-"));
    const file = path.join(dir, "guarded.rules");
    fs.writeFileSync(file, rules.content);
    const check = (...cmd: string[]) => {
      const r = spawnSync("codex", ["execpolicy", "check", "--rules", file, "--", ...cmd], { encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(r.stdout);
    };
    expect(check("git", "push", "origin", "main").decision).toBe("forbidden");
    expect(check("git", "push", "--force", "origin", "main").decision).toBe("forbidden"); // strictest wins over the prompt rule
    expect(check("rm", "-rf", "/tmp/x").decision).toBe("forbidden");
    expect(check("npm", "test", "-s").decision).toBe("allow");
    expect(check("git", "status").decision).toBeUndefined();
  });

  it.runIf(!codexInstalled)("[CX-13] (skipped part) codex is not installed, so the execpolicy check did not run", () => {
    console.warn("[CX-13] codex not installed: the `codex execpolicy check` part of this test was skipped");
  });
});
