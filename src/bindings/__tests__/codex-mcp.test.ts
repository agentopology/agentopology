import { describe, it, expect } from "vitest";
import { parse as parseToml } from "smol-toml";
import { parse } from "../../parser/index.js";
import { codexBinding } from "../codex.js";
import { codexSource } from "./codex-models.js";
import { matcherProblem } from "../../conformance/codex.js";

const SRC = `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "t"
  }

  mcp-servers {
    pager {
      command: "npx"
      args: ["-y", "pager-mcp"]
      env {
        PAGER_TOKEN: "\${PAGER_TOKEN}"
        REGION: "eu-west-1"
      }
      startup-timeout-sec: 20
      enabled-tools: ["page", "ack"]
    }
    remote {
      type: "sse"
      url: "https://mcp.example.com/sse"
      bearer-token-env-var: "REMOTE_TOKEN"
    }
  }

  agent worker {
    description: "Does work"
    model: sonnet
    permissions: autonomous
    tools: [Read]
  }

  action intake {
    kind: inline
    description: "entry"
  }

  flow { intake -> worker }
}
`;

const cfg = () => parseToml(codexBinding.scaffold(parse(codexSource(SRC))).find((f) => f.path === ".codex/config.toml")!.content) as any;

describe("[CX-14] MCP tables in full", () => {
  it("[CX-14] a server with an env map keeps every variable and every field", () => {
    const s = cfg().mcp_servers.pager;
    expect(s.command).toBe("npx");
    expect(s.args).toEqual(["-y", "pager-mcp"]);
    expect(s.env).toEqual({ PAGER_TOKEN: "${PAGER_TOKEN}", REGION: "eu-west-1" });
    expect(s.startup_timeout_sec).toBe(20);
    expect(s.enabled_tools).toEqual(["page", "ack"]);
  });

  it("[CX-14] a url server with a bearer variable round-trips and drops the type key", () => {
    const s = cfg().mcp_servers.remote;
    expect(s.url).toBe("https://mcp.example.com/sse");
    expect(s.bearer_token_env_var).toBe("REMOTE_TOKEN");
    expect(s.type).toBeUndefined();
  });

  it("[CX-14] matcherProblem for Codex flags a dotted mcp.server.tool matcher and names the fix", () => {
    const p = matcherProblem("PreToolUse", "mcp.pager.page");
    expect(p).toContain("mcp__pager__page");
    expect(matcherProblem("PreToolUse", "mcp.pager.*")).toContain("mcp__pager__.*");
  });

  it("[CX-14] matcherProblem accepts what Codex matches", () => {
    for (const m of ["", "*", "Bash", "mcp__pager__page", "mcp__pager__.*", "Edit|Write", "apply_patch"]) {
      expect(matcherProblem("PreToolUse", m), m).toBeNull();
    }
  });

  it("[CX-14] matcherProblem says a matcher on an event that ignores it never narrows anything", () => {
    expect(matcherProblem("Stop", "Bash")).toContain("ignores");
    expect(matcherProblem("PreToolUse", "(")).toContain("regex");
  });
});
