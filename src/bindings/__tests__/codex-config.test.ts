import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { parse } from "../../parser/index.js";
import { codexBinding } from "../codex.js";
import { PROJECT_FORBIDDEN_KEYS, APPROVAL_POLICIES, SANDBOX_MODES } from "../../conformance/codex.js";
import { tomlString, tomlMultiline } from "../lib/toml.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const keyList: { keys: string[] } = JSON.parse(fs.readFileSync(path.join(repo, "spec/codex/config-keys.json"), "utf8"));

/** kitchen-sink.at with the Claude model names swapped for a Codex one (CX-5 refuses the Claude names). */
export function kitchenSink(): string {
  return fs.readFileSync(path.join(repo, "kitchen-sink.at"), "utf8").replace(/model: (opus|sonnet|haiku)\b/g, "model: gpt-5.2");
}

/** Every dotted key path in a parsed TOML value, with `<id>`/`<name>`/`<tool>` for the open tables. */
function keyPaths(value: unknown, prefix: string[] = []): string[] {
  const out: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value)) {
    let p = [...prefix, k];
    if (prefix[0] === "mcp_servers" && prefix.length === 1) p = ["mcp_servers", "<id>"];
    else if (prefix[0] === "mcp_servers" && prefix[2] === "tools" && prefix.length === 3) p = [...prefix.slice(0, 3), "<tool>"];
    else if (prefix[0] === "model_providers" && prefix.length === 1) p = ["model_providers", "<id>"];
    else if (prefix[0] === "agents" && prefix.length === 1 && typeof v === "object" && !Array.isArray(v) && !keyList.keys.includes(`agents.${k}`)) p = ["agents", "<name>"];
    if (typeof v === "object" && v !== null && !Array.isArray(v) && !(p[0] === "mcp_servers" && p.length >= 3 && p[2] === "env")) {
      const nested = keyPaths(v, p.length === prefix.length + 1 && p[p.length - 1] === k ? p : p);
      if (nested.length === 0) out.push(p.join("."));
      out.push(...nested);
    } else out.push(p.join("."));
  }
  return out;
}

describe("[CX-4] a correct config.toml", () => {
  const files = codexBinding.scaffold(parse(kitchenSink()));
  const cfg = files.find((f) => f.path === ".codex/config.toml")!;

  it("[CX-4] the scaffold of kitchen-sink.at parses as TOML", () => {
    expect(() => parseToml(cfg.content)).not.toThrow();
  });

  it("[CX-4] approval_policy is on-request or never", () => {
    const t = parseToml(cfg.content) as any;
    expect(APPROVAL_POLICIES.has(t.approval_policy)).toBe(true);
    expect(cfg.content).not.toContain("untrusted");
  });

  it("[CX-4] supervised, plan and confirm map to on-request, never to untrusted (W1)", () => {
    for (const word of ["supervised", "plan", "confirm", "interactive", "suggest"]) {
      const src = kitchenSink().replace(/permissions: autonomous/g, `permissions: ${word}`);
      const toml = codexBinding.scaffold(parse(src)).find((f) => f.path === ".codex/config.toml")!;
      expect((parseToml(toml.content) as any).approval_policy, word).toBe("on-request");
    }
  });

  it("[CX-4] sandbox_mode is a legal mode and sits at the top level, not inside an MCP table", () => {
    const t = parseToml(cfg.content) as any;
    expect(SANDBOX_MODES.has(t.sandbox_mode)).toBe(true);
    for (const server of Object.values(t.mcp_servers ?? {}) as any[]) {
      expect(server["sandbox-mode"]).toBeUndefined();
      expect(server.sandbox_mode).toBeUndefined();
    }
  });

  it("[CX-4] no key is one a project config may not set", () => {
    const t = parseToml(cfg.content) as any;
    for (const k of PROJECT_FORBIDDEN_KEYS) expect(t[k], k).toBeUndefined();
    expect(cfg.content).not.toContain("[[providers]]");
  });

  it("[CX-4] [agents] has no max_depth and no legacy max_threads", () => {
    const t = parseToml(cfg.content) as any;
    expect(t.agents.max_depth).toBeUndefined();
    expect(t.agents.max_threads).toBeUndefined();
    expect(typeof t.agents.max_concurrent_threads_per_session).toBe("number");
  });

  it("[CX-4] no MCP table has a type key", () => {
    const t = parseToml(cfg.content) as any;
    for (const server of Object.values(t.mcp_servers ?? {}) as any[]) expect(server.type).toBeUndefined();
  });

  it("[CX-4] every key is in spec/codex/config-keys.json", () => {
    const t = parseToml(cfg.content);
    const unknown = keyPaths(t).filter((k) => !keyList.keys.includes(k));
    expect(unknown).toEqual([]);
  });

  it("[CX-4] no key the reference lacks (disable_response_storage, history.max_conversations, temperature, max_tokens)", () => {
    for (const k of ["disable_response_storage", "max_conversations", "max_depth"]) expect(cfg.content).not.toMatch(new RegExp(`^${k}\\b`, "m"));
    expect(cfg.content).not.toMatch(/^\s*(temperature|max_tokens)\s*=/m);
  });
});

describe("[CX-4] the TOML writer", () => {
  it("[CX-4] a string with quotes, backslashes and triple quotes round-trips", () => {
    const text = 'a "b" \\ c """ d\nline2\ttab';
    expect((parseToml(`x = ${tomlString(text)}`) as any).x).toBe(text);
    expect((parseToml(`x = ${tomlMultiline(text)}`) as any).x).toBe(text + "\n");
  });
});
