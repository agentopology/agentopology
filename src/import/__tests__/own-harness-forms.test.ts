/**
 * S-13: the forms that kept `import` from writing a valid .at for a project
 * that holds several topologies side by side (several topology skills, a
 * topology .at beside them). Every fixture is synthetic: small files written
 * for the test that reproduce one failing FORM, not any project's file.
 */
import { describe, it, expect } from "vitest";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { importFromPlatform } from "../index.js";
import type { PlatformFile } from "../../sync/index.js";

function file(path: string, content: string): PlatformFile {
  return { path, content } as PlatformFile;
}

function agent(id: string): PlatformFile {
  return file(`.claude/agents/${id}.md`, `---\nname: ${id}\ndescription: ${id} agent\nmodel: sonnet\n---\n\nYou are ${id}.\n`);
}

/** A topology skill with an orchestrator and a flow, as scaffold writes it. */
function topologySkill(name: string, handles: string[], flow: string[]): PlatformFile {
  return file(
    `.claude/skills/${name}/SKILL.md`,
    [
      "---",
      `name: ${name}`,
      `topology: ${name}`,
      'version: "1.0.0"',
      `description: ${name} team`,
      "---",
      "",
      "## Orchestrator",
      "",
      "Model: opus",
      `Handles: ${handles.join(", ")}`,
      "",
      "## Flow",
      "",
      ...flow.map((e) => `- ${e}`),
      "",
    ].join("\n"),
  );
}

function errors(source: string): string[] {
  return validate(parse(source))
    .filter((r) => r.level === "error")
    .map((r) => `${r.rule}: ${r.message}`);
}

describe("[S-13] V9: every action a merged flow uses is handled by the one orchestrator", () => {
  it("a second topology skill's orchestrator handles are kept", () => {
    const files = [
      agent("alpha-writer"),
      agent("beta-writer"),
      topologySkill("alpha-team", ["alpha-start"], ["alpha-start -> alpha-writer"]),
      topologySkill("beta-team", ["beta-start"], ["beta-start -> beta-writer"]),
    ];
    const source = importFromPlatform(files, "claude-code", "two-teams");
    expect(errors(source)).toEqual([]);
    const orch = parse(source).nodes.find((n) => n.type === "orchestrator") as { handles: string[] };
    expect(orch.handles).toEqual(expect.arrayContaining(["alpha-start", "beta-start"]));
  });
});

describe("[S-13] V9: a topology .at with no orchestrator brings its actions in handled", () => {
  // A pipeline .at that ends in a report action and states no orchestrator,
  // beside a topology skill that does have one.
  const pipelineAt = `topology gamma-line : [pipeline] {
  action gamma-done {
    kind: report
    description: "Line finished"
  }
  agent gamma-first {
    model: sonnet
  }
  agent gamma-second {
    model: sonnet
  }
  flow {
    gamma-first -> gamma-second
    gamma-second -> gamma-done
  }
}
`;
  it("validates with 0 errors and lists the .at's flow action in handles", () => {
    const files = [
      agent("alpha-writer"),
      agent("gamma-first"),
      agent("gamma-second"),
      topologySkill("alpha-team", ["alpha-start"], ["alpha-start -> alpha-writer"]),
      file("gamma-line.at", pipelineAt),
    ];
    const source = importFromPlatform(files, "claude-code", "mixed");
    expect(source).toContain("gamma-second -> gamma-done");
    expect(errors(source)).toEqual([]);
    const orch = parse(source).nodes.find((n) => n.type === "orchestrator") as { handles: string[] };
    expect(orch.handles).toEqual(["alpha-start", "gamma-done"]);
  });
});

describe("[S-13] V23: an MCP server's env is not a second top-level env block", () => {
  const mcp = file(
    ".mcp.json",
    JSON.stringify({
      mcpServers: {
        "store-one": { command: "uvx", args: ["some-server"], env: { STORE_PATH: "data/one" } },
        "store-two": { command: "uvx", args: ["other-server"], env: {} },
      },
    }),
  );

  it("imports with no V23 warning", () => {
    const source = importFromPlatform([agent("solo-agent"), mcp], "claude-code", "servers");
    const warnings = validate(parse(source)).filter((r) => r.rule === "V23");
    expect(warnings).toEqual([]);
  });

  // Held: the parser still reads the first `env`-named block at any depth as
  // the topology env (an MCP server's env, or `environments`). Fixing it
  // changes the CX-10 golden (examples/data-processing.at settings.json), so
  // it waits for a decision on that golden.
  it.skip("a server's env stays the server's: the topology env is not filled from it", () => {
    const ast = parse(importFromPlatform([agent("solo-agent"), mcp], "claude-code", "servers"));
    expect(ast.env).toEqual({});
    expect((ast.mcpServers["store-one"] as { env?: Record<string, string> }).env).toEqual({ STORE_PATH: "data/one" });
  });

  it("two real top-level env blocks still warn", () => {
    const src = `topology dup-env : [pipeline] {
  env {
    A: "1"
  }
  agent one {
    model: sonnet
  }
  env {
    B: "2"
  }
}
`;
    expect(validate(parse(src)).filter((r) => r.rule === "V23")).toHaveLength(1);
  });

  it("a longer keyword is not the same block: environments, observability-platform", () => {
    const src = `topology near-names : [pipeline] {
  env {
    A: "1"
  }
  environments {
    staging {
      region: "eu"
    }
  }
  agent one {
    model: sonnet
  }
}
`;
    expect(validate(parse(src)).filter((r) => r.rule === "V23")).toEqual([]);
    expect(parse(src).env).toEqual({ A: "1" });
  });
});
