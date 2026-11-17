/**
 * A topology that parses to less than its source declares must fail validate
 * and scaffold loudly (V131), naming the line where parsing stopped; and a
 * brace in a `#` comment must not lose anything at all.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI = resolve(root, "dist/cli/index.js");

function run(args: string[], cwd: string): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status ?? 1 };
  }
}

const topology = (agentLine: string, extra = "") => `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "comment braces"
  }
  agent alpha {
    description: "Alpha"
${agentLine}
    model: sonnet
    tools: [Read]
    prompt {
      Do alpha.
    }
  }
${extra}
  agent beta {
    model: haiku
    prompt {
      Do beta.
    }
  }
  settings {
    deny: ["Bash(rm:*)", "Read(./.env)"]
  }
  flow {
    alpha -> beta
  }
}
`;

function project(src: string): string {
  const dir = mkdtempSync(join(tmpdir(), "at-lost-"));
  writeFileSync(join(dir, "t.at"), src);
  return dir;
}

describe("lost structure is loud on the CLI", () => {
  it("the CLI is built", () => {
    expect(existsSync(CLI)).toBe(true);
  });

  it("a # } comment in an agent: validate passes, scaffold writes both agents and the deny rules", () => {
    const dir = project(topology("    # }"));
    const v = run(["validate", "t.at"], dir);
    expect(v.code, v.out).toBe(0);
    const s = run(["scaffold", "t.at", "--target", "claude-code"], dir);
    expect(s.code, s.out).toBe(0);
    expect(readdirSync(join(dir, ".claude", "agents")).sort()).toEqual(["alpha", "beta"]);
    expect(existsSync(join(dir, ".claude", "agents", "alpha", "AGENT.md"))).toBe(true);
    const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["Bash(rm:*)", "Read(./.env)"]));
  });

  it("a stray } that ends the topology early: validate and scaffold exit 1 naming the line, nothing is written", () => {
    const dir = project(topology("", "  }"));
    const v = run(["validate", "t.at"], dir);
    expect(v.code).toBe(1);
    expect(v.out).toContain("[V131]");
    expect(v.out).toMatch(/line 15/);
    expect(v.out).not.toContain("All validation rules passed");
    const s = run(["scaffold", "t.at", "--target", "claude-code"], dir);
    expect(s.code).toBe(1);
    expect(s.out).toContain("[V131]");
    expect(existsSync(join(dir, ".claude"))).toBe(false);
  });

  it("two gates { } blocks: validate exits 0 with the V23 warning alone, no brace reason", () => {
    const fixture = resolve(root, "src/parser/__tests__/fixtures/duplicate-gates.at");
    const dir = project(readFileSync(fixture, "utf8"));
    const v = run(["validate", "t.at"], dir);
    expect(v.code, v.out).toBe(0);
    expect(v.out).toContain('WARN  [V23] Duplicate "gates" block detected (found 2) — only the first occurrence is used');
    expect(v.out).toContain("0 error(s), 1 warning(s)");
    expect(v.out).not.toContain("V131");
    expect(v.out).not.toContain("brace");
  });
});
