import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { codexBinding } from "../codex.js";
import { syncFromPlatform } from "../../sync/index.js";
import { isClaudeModelName } from "../../conformance/codex.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "../../../dist/cli/index.js");

function topo(agentBody: string, model = "gpt-5.2"): string {
  return `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "t"
  }

  mcp-servers {
    logs {
      command: "npx"
      args: ["-y", "logs-mcp"]
    }
  }

  agent worker {
    description: "Does work"
    model: ${model}
    permissions: autonomous
    tools: [Read]
${agentBody}
  }

  action intake {
    kind: inline
    description: "entry"
  }

  flow { intake -> worker }
}
`;
}

afterEach(() => vi.restoreAllMocks());

describe("[CX-5] honest agent files and model names", () => {
  const body = `    sandbox: read-only\n    mcp-servers: [logs]`;

  it("[CX-5] an agent file has no sandbox_mode, no mcp_servers and no nickname_candidates", () => {
    const files = codexBinding.scaffold(parse(topo(body)));
    const f = files.find((x) => x.path === ".codex/agents/worker.toml")!;
    const t = parseToml(f.content) as any;
    expect(t.name).toBe("worker");
    expect(t.model).toBe("gpt-5.2");
    expect(t.sandbox_mode).toBeUndefined();
    expect(t.mcp_servers).toBeUndefined();
    expect(t.nickname_candidates).toBeUndefined();
    expect(f.content).not.toContain("sandbox_mode");
    expect(f.content).not.toContain("mcp_servers");
  });

  it("[CX-5] sandbox and mcp-servers on an agent give a warning each, naming the agent", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    codexBinding.scaffold(parse(topo(body)));
    const text = warn.mock.calls.map((c) => String(c[0]));
    expect(text.filter((m) => /worker/.test(m) && /sandbox/.test(m))).toHaveLength(1);
    expect(text.filter((m) => /worker/.test(m) && /mcp/.test(m))).toHaveLength(1);
  });

  it("[CX-5] validate with target codex gives 3 warnings naming the agent for sandbox, mcp-servers and a Claude model", () => {
    const ast = parse(topo(body, "opus"));
    const w = validate(ast, { target: "codex" }).filter((r) => r.level === "warning" && r.rule.startsWith("CX"));
    expect(w).toHaveLength(3);
    for (const r of w) expect(r.message).toContain('"worker"');
    expect(validate(ast).filter((r) => r.rule.startsWith("CX"))).toHaveLength(0);
  });

  it("[CX-5] a Claude model name is refused, naming the agent, and invents no Codex model", () => {
    for (const m of ["opus", "sonnet", "haiku", "fable", "claude-sonnet-5-5", "claude-opus-4"]) {
      expect(() => codexBinding.scaffold(parse(topo("", m))), m).toThrow(/worker.*Claude model/s);
    }
    expect(isClaudeModelName("gpt-5.2")).toBe(false);
    expect(isClaudeModelName("opus")).toBe(true);
  });

  it("[CX-5] scaffold --target codex exits 1 on the Claude model name and writes nothing", () => {
    if (!fs.existsSync(cli)) return; // needs `npm run build`; the gate builds first
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx5-"));
    const src = path.join(dir, "t.at");
    fs.writeFileSync(src, topo("", "opus"));
    const out = path.join(dir, "out");
    const r = spawnSync("node", [cli, "scaffold", src, "--target", "codex", "--output", out], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("worker");
    expect(fs.existsSync(out)).toBe(false);
    const ok = spawnSync("node", [cli, "scaffold", src, "--target", "claude-code", "--output", out], { encoding: "utf8" });
    expect(ok.status).toBe(0);
  });

  it("[CX-5] a prompt holding triple quotes, backslashes and quotes round-trips through TOML and sync", () => {
    const prompt = 'Say """hi""" and use a \\ backslash, "quotes" and \'single\'.\nSecond line with C:\\path\\to.';
    const ast = parse(topo(""));
    const agent: any = ast.nodes.find((n) => n.id === "worker");
    agent.prompt = prompt;
    const f = codexBinding.scaffold(ast).find((x) => x.path === ".codex/agents/worker.toml")!;
    const t = parseToml(f.content) as any;
    expect(t.developer_instructions).toContain(prompt);
    const back = syncFromPlatform(topo(""), [{ path: f.path, content: f.content }], "codex");
    expect(back).toContain("Say");
    expect(back).toContain("backslash");
  });

  it("[CX-5] a prompt that cannot sit in a literal string (a ''' run and a control character) still round-trips", () => {
    const agentSrc = parse(topo(""));
    const agent: any = agentSrc.nodes.find((n) => n.id === "worker");
    agent.prompt = "Has ''' three quotes and \"\"\" and a \\ and\ta tab\u0001ctl";
    const f = codexBinding.scaffold(agentSrc).find((x) => x.path === ".codex/agents/worker.toml")!;
    const t = parseToml(f.content) as any;
    expect(t.developer_instructions).toContain(agent.prompt);
    const back = syncFromPlatform(topo(""), [{ path: f.path, content: f.content }], "codex");
    expect(back).toContain(agent.prompt);
  });
});
