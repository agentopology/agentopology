/**
 * environments { } compile: each environment becomes env/<name>.env, and
 * sessions.md gets an AT_ENV=<name> variant of every start line.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";

process.env.AGENTOPOLOGY_CLAUDE_VERSION = "2.1.999";

function topology(envs: string, withSessions = false): string {
  return `topology envs : [pipeline] {
  meta {
    version: "1.0.0"
    description: "environments"
  }
  orchestrator {
    model: sonnet
    handles: [${withSessions ? "lane-a" : "worker"}]
  }
  agent ${withSessions ? "lane-a" : "worker"} {
    model: sonnet
    description: "Does the work"
${withSessions ? "    runs: session\n" : ""}  }
  flow {
    ${withSessions ? "lane-a -> lane-a" : "worker -> worker"}
  }
  environments {
${envs}
  }
}
`;
}

const ENVS = `    staging {
      api-url: "https://staging.example.com"
      replicas: 2
      note: "two words"
      api-token: "abc123"
      db-password: secret-value
      signing-key: "k"
      client-secret: "s"
    }
    production {
      api-url: "https://api.example.com"
    }`;

const compile = (src: string) => claudeCodeBinding.scaffold(parse(src));
const byPath = (files: { path: string; content: string }[], p: string) => files.find((f) => f.path === p);

describe("environments compile to env files", () => {
  it("writes env/<name>.env with upper-cased keys", () => {
    const files = compile(topology(ENVS));
    const staging = byPath(files, "env/staging.env");
    expect(staging).toBeDefined();
    expect(staging!.content).toContain("API_URL=https://staging.example.com");
    expect(staging!.content).toContain("REPLICAS=2");
    expect(staging!.content).toContain('NOTE="two words"');
    expect(byPath(files, "env/production.env")!.content).toContain("API_URL=https://api.example.com");
  });

  it("does not write secret-looking values, and says to set them outside the repo", () => {
    const content = byPath(compile(topology(ENVS)), "env/staging.env")!.content;
    for (const leaked of ["abc123", "secret-value"]) expect(content).not.toContain(leaked);
    expect(content).not.toMatch(/^API_TOKEN=/m);
    expect(content).not.toMatch(/^DB_PASSWORD=/m);
    expect(content).not.toMatch(/^SIGNING_KEY=/m);
    expect(content).not.toMatch(/^CLIENT_SECRET=/m);
    expect(content).toMatch(/^# API_TOKEN: .*outside the repo/m);
    expect(content).toMatch(/^# DB_PASSWORD: .*outside the repo/m);
  });

  it("tracks the env files as machine files, so the manifest lists them", () => {
    const f = byPath(compile(topology(ENVS)), "env/staging.env")!;
    expect((f as { category?: string }).category ?? "machine").toBe("machine");
  });

  it("writes no env files when there are no environments", () => {
    const files = claudeCodeBinding.scaffold(parse(topology("").replace(/environments \{\s*\}/, "")));
    expect(files.some((f) => f.path.startsWith("env/"))).toBe(false);
  });

  it("adds an AT_ENV variant of each start line to sessions.md", () => {
    const files = compile(topology(ENVS, true));
    const md = byPath(files, ".claude/sessions.md")!.content;
    expect(md).toContain("AT_SESSION=lane-a claude --agent lane-a -n lane-a");
    expect(md).toContain("AT_ENV=staging AT_SESSION=lane-a claude --agent lane-a -n lane-a");
    expect(md).toContain("AT_ENV=production AT_SESSION=lane-a claude --agent lane-a -n lane-a");
  });

  it("leaves settings.json without any environment key", () => {
    const settings = byPath(compile(topology(ENVS)), ".claude/settings.json");
    if (settings) expect(settings.content).not.toMatch(/staging|AT_ENV/);
  });
});

describe("environment values are checked", () => {
  const rule = (src: string) => validate(parse(src)).filter((r) => r.rule === "V137");

  it("accepts strings and numbers", () => {
    expect(rule(topology(ENVS))).toEqual([]);
  });

  it("errors on a list value", () => {
    const r = rule(topology(`    staging {\n      hosts: [a, b]\n    }`));
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("error");
    expect(r[0].message).toContain("hosts");
  });

  it("errors on a nested block", () => {
    const r = rule(topology(`    staging {\n      db {\n        host: x\n      }\n    }`));
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("error");
  });
});
