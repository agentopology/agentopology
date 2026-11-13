import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse } from "../../parser/index.js";
import { codexSource } from "./codex-models.js";
import { codexBinding } from "../codex.js";
import { syncFromPlatform } from "../../sync/index.js";
import { mergeAgentFile } from "../../scaffold/merge.js";
import { computeIncrementalPlan, executeActions, nextManifestFiles } from "../../scaffold/incremental.js";
import { getManifestPath } from "../../scaffold/manifest.js";
import type { GeneratedFile } from "../types.js";

function bigTopology(n: number): string {
  const agents: string[] = [];
  for (let i = 0; i < n; i++) {
    agents.push(`  agent worker-${i} {
    role: worker
    model: sonnet
    permissions: autonomous
    phase: ${i + 1}
    tools: [Read, Write]
    writes: ["workspace/out-${i}.md"]

    prompt {
      PROMPT-BODY-${i}: ${"Do the careful thing and explain it at length. ".repeat(40)}
    }
  }
`);
  }
  return `topology big : [pipeline] {
  version: "1.0.0"
  description: "Forty workers"

  roles {
    worker: "Does work"
  }

${agents.join("\n")}
  flow {
    ${Array.from({ length: n - 1 }, (_, i) => `worker-${i} -> worker-${i + 1}`).join("\n    ")}
  }
}
`;
}

const scaffold = (src: string): GeneratedFile[] => codexBinding.scaffold(parse(codexSource(src)));

describe("CX-6 small merged AGENTS.md", () => {
  it("[CX-6] 40 agents scaffold an AGENTS.md under 24 KiB with no agent prompt in it", () => {
    const files = scaffold(bigTopology(40));
    const md = files.find((f) => f.path === "AGENTS.md")!;
    expect(Buffer.byteLength(md.content)).toBeLessThan(24 * 1024);
    expect(md.content).not.toContain("PROMPT-BODY-");
    expect(md.content).not.toContain("Do the careful thing");
    // the prompts live in the agent files
    const a = files.find((f) => f.path === ".codex/agents/worker-7.toml")!;
    expect(a.content).toContain("PROMPT-BODY-7");
  });

  describe("on disk", () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "cxa-")); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    const run = (files: GeneratedFile[]) => {
      const mp = path.join(dir, getManifestPath("codex"));
      const prev = fs.existsSync(mp) ? JSON.parse(fs.readFileSync(mp, "utf-8")) : null;
      const actions = computeIncrementalPlan(dir, "codex", files, prev);
      const result = executeActions(dir, actions, { prune: false, force: false });
      const m = { source: "t.at", sourceHash: "x", target: "codex", generatedAt: "now", files: nextManifestFiles(dir, actions, files, prev, result) };
      fs.mkdirSync(path.dirname(mp), { recursive: true });
      fs.writeFileSync(mp, JSON.stringify(m));
    };

    it("[CX-6] a user's line above the managed block survives a second scaffold", () => {
      const src = bigTopology(3);
      run(scaffold(src));
      const p = path.join(dir, "AGENTS.md");
      fs.writeFileSync(p, "MY OWN RULE: be kind\n\n" + fs.readFileSync(p, "utf-8") + "\nMY TRAILER\n");
      run(scaffold(bigTopology(4)));
      const after = fs.readFileSync(p, "utf-8");
      expect(after.startsWith("MY OWN RULE: be kind")).toBe(true);
      expect(after).toContain("MY TRAILER");
      expect(after).toContain("worker-3");
      expect(after.match(/agentopology:begin/g)!.length).toBe(1);
    });
  });

  it("[CX-6] mergeAgentFile keeps text outside the managed block", () => {
    const gen = scaffold(bigTopology(2)).find((f) => f.path === "AGENTS.md")!.content;
    const merged = mergeAgentFile("top\n" + gen + "bottom\n", gen, "codex");
    expect(merged).toBe("top\n" + gen + "bottom\n");
  });

  it("[CX-6] sync still finds every prompt, now from the agent files", () => {
    const src = bigTopology(5);
    const files = scaffold(src);
    const bare = src.replace(/prompt \{[\s\S]*?\n    \}\n/g, "");
    expect(bare).not.toContain("PROMPT-BODY");
    const out = syncFromPlatform(bare, files.map((f) => ({ path: f.path, content: f.content })), "codex");
    for (let i = 0; i < 5; i++) expect(out).toContain(`PROMPT-BODY-${i}`);
    expect(parse(out).nodes.filter((n) => n.type === "agent").every((n) => (n as any).prompt?.includes("PROMPT-BODY-"))).toBe(true);
  });
});

describe("CX-7 skills where Codex reads them", () => {
  const src = `topology sk : [pipeline] {
  version: "1.0.0"
  description: "skills"

  roles {
    worker: "Does work"
  }

  agent a {
    role: worker
    model: sonnet
    permissions: autonomous
    phase: 1
    tools: [Read]
  }

  skill triage {
    description: "Sort incoming items"
  }

  skill manual-only {
    description: "Only when asked"
    disable-model-invocation: true
  }

  flow {
    a -> a
  }
}
`;

  it("[CX-7] each skill is .agents/skills/<id>/SKILL.md with name and description, none under .codex/skills/", () => {
    const files = scaffold(src);
    expect(files.some((f) => f.path.startsWith(".codex/skills/"))).toBe(false);
    for (const id of ["triage", "manual-only"]) {
      const f = files.find((x) => x.path === `.agents/skills/${id}/SKILL.md`)!;
      expect(f, id).toBeDefined();
      expect(f.content).toMatch(/^---\nname: ["']?[^\n]*\ndescription: /);
      expect(f.content).toContain(`name: ${id}`);
    }
  });

  it("[CX-7] disable-model-invocation writes agents/openai.yaml with allow_implicit_invocation: false", () => {
    const files = scaffold(src);
    const y = files.find((f) => f.path === ".agents/skills/manual-only/agents/openai.yaml")!;
    expect(y.content).toContain("policy:");
    expect(y.content).toContain("allow_implicit_invocation: false");
    expect(files.some((f) => f.path === ".agents/skills/triage/agents/openai.yaml")).toBe(false);
  });
});
