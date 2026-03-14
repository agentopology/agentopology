import { describe, it, expect } from "vitest";
import { parse } from "../../parser/index.js";
import {
  exporters,
  markdownExporter,
  mermaidExporter,
} from "../index.js";

// ---------------------------------------------------------------------------
// Test topologies
// ---------------------------------------------------------------------------

const SIMPLE_PIPELINE = `
topology simple-pipeline : [pipeline, human-gate] {
  meta {
    version: "1.0.0"
    description: "Research, write, and review"
  }

  orchestrator {
    model: sonnet
    generates: "commands/create.md"
    handles: [intake, done]
    outputs: {
      topic-type: technical | creative
    }
  }

  roles {
    researcher: "Gather information and compile research notes"
    writer: "Draft content based on research"
    reviewer: "Review drafts for accuracy"
  }

  action intake {
    kind: inline
    description: "Parse user request"
  }

  agent researcher {
    role: researcher
    model: gpt-4o
    permissions: supervised
    phase: 1
    tools: [Read, Grep, Glob, WebSearch]
    writes: ["workspace/research.md"]
    prompt {
        You are a research specialist.
    }
  }

  agent writer {
    role: writer
    model: sonnet
    permissions: autonomous
    phase: 2
    tools: [Read, Write, Glob]
    reads: ["workspace/research.md"]
    writes: ["workspace/draft.md"]
    outputs: {
      confidence: high | medium | low
    }
  }

  agent reviewer {
    role: reviewer
    model: opus
    permissions: supervised
    phase: 3
    tools: [Read, Grep, Glob]
    reads: ["workspace/draft.md", "workspace/research.md"]
    writes: ["workspace/review.md"]
    outputs: {
      verdict: approve | revise | reject
    }
  }

  flow {
    intake -> researcher
    researcher -> writer
    writer -> reviewer
    reviewer -> writer     [when reviewer.verdict == revise, max 2]
    reviewer -> researcher [when reviewer.verdict == reject, max 1]
    reviewer -> done       [when reviewer.verdict == approve]
  }

  gates {
    gate quality-check {
      after: writer
      before: reviewer
      run: "scripts/check-quality.sh"
      checks: [grammar, formatting]
      on-fail: bounce-back
    }
  }

  action done {
    kind: report
    description: "Deliver final content"
  }

  memory {
    workspace {
      path: "workspace/"
      structure: [research, drafts, reviews]
    }
  }

  triggers {
    command create {
      pattern: "/create <TOPIC>"
      argument: TOPIC
    }
  }

  settings {
    allow: ["Read", "Grep", "Glob", "WebSearch"]
    deny: ["Bash(rm -rf *)"]
  }
}
`;

const FAN_OUT_TOPOLOGY = `
topology code-review : [pipeline, fan-out] {
  meta {
    version: "2.0.0"
    description: "Code review with fan-out"
  }

  orchestrator {
    model: opus
    handles: [intake, create-report]
  }

  roles {
    analyzer: "Static analysis"
    security: "Security scanning"
    reviewer: "Code review"
  }

  action intake {
    kind: external
    source: "github-pr"
    description: "Fetch PR diff"
  }

  action create-report {
    kind: report
    description: "Final report"
  }

  agent analyzer {
    role: analyzer
    model: gemini-2.0-flash
    phase: 1
    tools: [Read, Grep]
    behavior: advisory
    outputs: {
      risk-level: low | medium | high
    }
  }

  agent security-scanner {
    role: security
    model: sonnet
    phase: 1
    tools: [Read, Grep]
    behavior: advisory
  }

  agent reviewer {
    role: reviewer
    model: opus
    phase: 2
    tools: [Read, Grep, Glob]
    outputs: {
      verdict: approve | reject
    }
  }

  flow {
    intake -> [analyzer, security-scanner]
    analyzer -> reviewer
    security-scanner -> reviewer
    reviewer -> create-report [when reviewer.verdict == approve]
    reviewer -> create-report [when reviewer.verdict == reject]
  }

  hooks {
    hook log-findings {
      on: AgentStop
      run: "scripts/log.sh"
      type: command
    }
  }
}
`;

const MINIMAL_TOPOLOGY = `
topology minimal : [pipeline] {
  meta {
    version: "0.1.0"
    description: "Bare minimum"
  }
  orchestrator {
    model: sonnet
    handles: [start]
  }
  action start {
    kind: inline
    description: "Entry"
  }
  agent worker {
    model: haiku
    phase: 1
  }
  flow {
    start -> worker
  }
}
`;

// ---------------------------------------------------------------------------
// Registry tests
// ---------------------------------------------------------------------------

describe("exporter registry", () => {
  it("has markdown and mermaid exporters", () => {
    expect(exporters).toHaveProperty("markdown");
    expect(exporters).toHaveProperty("mermaid");
  });

  it("each exporter has required fields", () => {
    for (const exp of Object.values(exporters)) {
      expect(exp.name).toBeTruthy();
      expect(exp.description).toBeTruthy();
      expect(exp.extension).toBeTruthy();
      expect(typeof exp.export).toBe("function");
    }
  });
});

// ---------------------------------------------------------------------------
// Markdown exporter tests
// ---------------------------------------------------------------------------

describe("markdownExporter", () => {
  it("has correct metadata", () => {
    expect(markdownExporter.name).toBe("markdown");
    expect(markdownExporter.extension).toBe(".md");
  });

  it("generates a single .md file", () => {
    const ast = parse(SIMPLE_PIPELINE);
    const files = markdownExporter.export(ast);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("simple-pipeline.md");
  });

  describe("header section", () => {
    it("includes topology name as title", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const md = markdownExporter.export(ast)[0].content;
      expect(md).toContain("# Simple Pipeline");
    });

    it("includes description as italic", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const md = markdownExporter.export(ast)[0].content;
      expect(md).toContain("*Research, write, and review*");
    });

    it("includes version badge", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const md = markdownExporter.export(ast)[0].content;
      expect(md).toContain("version-1.0.0");
    });

    it("includes pattern badges", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const md = markdownExporter.export(ast)[0].content;
      expect(md).toContain("pattern-pipeline");
      expect(md).toContain("pattern-human-gate");
    });
  });

  describe("overview section", () => {
    it("shows component counts inline", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const md = markdownExporter.export(ast)[0].content;
      expect(md).toContain("At a Glance");
      expect(md).toContain("**3** Agents");
      expect(md).toContain("**2** Actions");
      expect(md).toContain("**1** Gate");
    });
  });

  describe("orchestrator section", () => {
    it("renders orchestrator with model", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const md = markdownExporter.export(ast)[0].content;
      expect(md).toContain("### Orchestrator");
      expect(md).toContain("Model: `sonnet`");
      expect(md).toContain("`intake`");
    });

    it("renders orchestrator outputs", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const md = markdownExporter.export(ast)[0].content;
      expect(md).toContain("`topic-type`");
      expect(md).toContain("`technical`");
      expect(md).toContain("`creative`");
    });
  });

  describe("agents section", () => {
    it("renders each agent", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const md = markdownExporter.export(ast)[0].content;
      expect(md).toContain("#### Researcher");
      expect(md).toContain("#### Writer");
      expect(md).toContain("#### Reviewer");
    });

    it("shows agent model inline with heading", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const md = markdownExporter.export(ast)[0].content;
      expect(md).toContain("#### Researcher `gpt-4o`");
    });

    it("shows agent phase", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const md = markdownExporter.export(ast)[0].content;
      expect(md).toContain("Phase **1**");
      expect(md).toContain("Phase **2**");
      expect(md).toContain("Phase **3**");
    });

    it("shows agent tools", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const md = markdownExporter.export(ast)[0].content;
      expect(md).toContain("`Read`");
      expect(md).toContain("`WebSearch`");
    });

    it("shows reads and writes", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const md = markdownExporter.export(ast)[0].content;
      expect(md).toContain("`workspace/research.md`");
      expect(md).toContain("`workspace/draft.md`");
    });

    it("shows agent outputs", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const md = markdownExporter.export(ast)[0].content;
      expect(md).toContain("`confidence`");
      expect(md).toContain("`high`");
    });

    it("shows inline prompt in collapsible details", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const md = markdownExporter.export(ast)[0].content;
      expect(md).toContain("<details>");
      expect(md).toContain("<summary>Prompt</summary>");
      expect(md).toContain("You are a research specialist.");
      expect(md).toContain("</details>");
    });

    it("renders role description from roles block", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const md = markdownExporter.export(ast)[0].content;
      expect(md).toContain("Gather information and compile research notes");
    });

    it("shows advisory behavior", () => {
      const ast = parse(FAN_OUT_TOPOLOGY);
      const md = markdownExporter.export(ast)[0].content;
      expect(md).toContain("Behavior: `advisory`");
    });
  });

  describe("actions section", () => {
    it("renders actions with kind and description", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const md = markdownExporter.export(ast)[0].content;
      expect(md).toContain("#### Intake `inline`");
      expect(md).toContain("Parse user request");
    });

    it("shows action source", () => {
      const ast = parse(FAN_OUT_TOPOLOGY);
      const md = markdownExporter.export(ast)[0].content;
      expect(md).toContain("Source: `github-pr`");
    });
  });

  describe("gates section", () => {
    it("renders gates with checks", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const md = markdownExporter.export(ast)[0].content;
      expect(md).toContain("#### Quality Check");
      expect(md).toContain("After: `writer`");
      expect(md).toContain("Before: `reviewer`");
      expect(md).toContain("`grammar`");
      expect(md).toContain("`formatting`");
    });
  });

  describe("flow section", () => {
    it("renders flow as code block", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const md = markdownExporter.export(ast)[0].content;
      expect(md).toContain("## Flow");
      expect(md).toContain("intake ───> researcher");
      expect(md).toContain("researcher ───> writer");
    });

    it("shows edge conditions", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const md = markdownExporter.export(ast)[0].content;
      expect(md).toContain("when reviewer.verdict == revise");
      expect(md).toContain("max 2");
    });

    it("shows edge conditions for approve", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const md = markdownExporter.export(ast)[0].content;
      expect(md).toContain("when reviewer.verdict == approve");
    });
  });

  describe("roles section", () => {
    it("renders roles as list", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const md = markdownExporter.export(ast)[0].content;
      expect(md).toContain("## Roles");
      expect(md).toContain("**Researcher**");
      expect(md).toContain("**Writer**");
      expect(md).toContain("**Reviewer**");
    });
  });

  describe("memory section", () => {
    it("renders memory blocks", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const md = markdownExporter.export(ast)[0].content;
      expect(md).toContain("## Memory");
      expect(md).toContain("**Workspace**");
      expect(md).toContain("`workspace/`");
    });
  });

  describe("triggers section", () => {
    it("renders triggers as list", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const md = markdownExporter.export(ast)[0].content;
      expect(md).toContain("## Triggers");
      expect(md).toContain("`create`");
      expect(md).toContain("`/create <TOPIC>`");
      expect(md).toContain("`TOPIC`");
    });
  });

  describe("hooks section", () => {
    it("renders hooks as list", () => {
      const ast = parse(FAN_OUT_TOPOLOGY);
      const md = markdownExporter.export(ast)[0].content;
      expect(md).toContain("## Hooks");
      expect(md).toContain("`log-findings`");
      expect(md).toContain("`AgentStop`");
    });
  });

  describe("settings section", () => {
    it("renders allow/deny lists", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const md = markdownExporter.export(ast)[0].content;
      expect(md).toContain("## Settings");
      expect(md).toContain("**Allow:**");
    });
  });

  describe("footer", () => {
    it("includes AgentTopology link", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const md = markdownExporter.export(ast)[0].content;
      expect(md).toContain("agentopology.com");
    });
  });

  describe("minimal topology", () => {
    it("works with minimal input", () => {
      const ast = parse(MINIMAL_TOPOLOGY);
      const files = markdownExporter.export(ast);
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("minimal.md");
      const md = files[0].content;
      expect(md).toContain("# Minimal");
      expect(md).toContain("#### Worker");
    });
  });
});

// ---------------------------------------------------------------------------
// Mermaid exporter tests
// ---------------------------------------------------------------------------

describe("mermaidExporter", () => {
  it("has correct metadata", () => {
    expect(mermaidExporter.name).toBe("mermaid");
    expect(mermaidExporter.extension).toBe(".mmd");
  });

  it("generates a single .mmd file", () => {
    const ast = parse(SIMPLE_PIPELINE);
    const files = mermaidExporter.export(ast);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("simple-pipeline.mmd");
  });

  describe("header", () => {
    it("includes topology name as comment", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const mmd = mermaidExporter.export(ast)[0].content;
      expect(mmd).toContain("%% simple-pipeline v1.0.0");
    });

    it("includes description as comment", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const mmd = mermaidExporter.export(ast)[0].content;
      expect(mmd).toContain("%% Research, write, and review");
    });

    it("starts with flowchart TD", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const mmd = mermaidExporter.export(ast)[0].content;
      expect(mmd).toContain("flowchart TD");
    });
  });

  describe("style classes", () => {
    it("defines all node type classes", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const mmd = mermaidExporter.export(ast)[0].content;
      expect(mmd).toContain("classDef orchestrator");
      expect(mmd).toContain("classDef agent");
      expect(mmd).toContain("classDef action");
      expect(mmd).toContain("classDef gate");
      expect(mmd).toContain("classDef human");
      expect(mmd).toContain("classDef group");
    });
  });

  describe("node shapes", () => {
    it("renders orchestrator as stadium shape", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const mmd = mermaidExporter.export(ast)[0].content;
      expect(mmd).toMatch(/orchestrator\(\[".*"\]\)/);
    });

    it("renders actions as subroutine shape", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const mmd = mermaidExporter.export(ast)[0].content;
      expect(mmd).toMatch(/intake\[\[".*"\]\]/);
    });

    it("renders gates as diamond shape", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const mmd = mermaidExporter.export(ast)[0].content;
      expect(mmd).toMatch(/quality_check\{".*"\}/);
    });

    it("renders agents as rectangles", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const mmd = mermaidExporter.export(ast)[0].content;
      expect(mmd).toMatch(/researcher\[".*"\]/);
    });
  });

  describe("node labels", () => {
    it("includes agent model in label", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const mmd = mermaidExporter.export(ast)[0].content;
      expect(mmd).toContain("Model: gpt-4o");
      expect(mmd).toContain("Model: sonnet");
      expect(mmd).toContain("Model: opus");
    });

    it("includes agent phase in label", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const mmd = mermaidExporter.export(ast)[0].content;
      expect(mmd).toContain("Phase: 1");
      expect(mmd).toContain("Phase: 2");
      expect(mmd).toContain("Phase: 3");
    });
  });

  describe("phase subgraphs", () => {
    it("groups agents by phase", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const mmd = mermaidExporter.export(ast)[0].content;
      expect(mmd).toContain('subgraph Phase_1["Phase 1"]');
      expect(mmd).toContain('subgraph Phase_2["Phase 2"]');
      expect(mmd).toContain('subgraph Phase_3["Phase 3"]');
    });

    it("groups same-phase agents together", () => {
      const ast = parse(FAN_OUT_TOPOLOGY);
      const mmd = mermaidExporter.export(ast)[0].content;
      expect(mmd).toContain('subgraph Phase_1["Phase 1"]');
      const phase1Start = mmd.indexOf('subgraph Phase_1');
      const phase1End = mmd.indexOf("end", phase1Start);
      const phase1Content = mmd.slice(phase1Start, phase1End);
      expect(phase1Content).toContain("analyzer");
      expect(phase1Content).toContain("security_scanner");
    });
  });

  describe("edges", () => {
    it("renders simple edges", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const mmd = mermaidExporter.export(ast)[0].content;
      expect(mmd).toContain("intake --> researcher");
      expect(mmd).toContain("researcher --> writer");
    });

    it("renders conditional edges with annotations", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const mmd = mermaidExporter.export(ast)[0].content;
      expect(mmd).toContain('reviewer -->|"reviewer.verdict == revise, max 2"| writer');
    });

    it("renders edges with only condition", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const mmd = mermaidExporter.export(ast)[0].content;
      expect(mmd).toContain('reviewer -->|"reviewer.verdict == approve"| done');
    });
  });

  describe("hyphenated IDs", () => {
    it("converts hyphens to underscores in IDs", () => {
      const ast = parse(FAN_OUT_TOPOLOGY);
      const mmd = mermaidExporter.export(ast)[0].content;
      expect(mmd).toContain("security_scanner");
      expect(mmd).toContain("create_report");
      expect(mmd).not.toMatch(/\bsecurity-scanner\b.*\[/);
    });
  });

  describe("class assignments", () => {
    it("assigns correct classes to nodes", () => {
      const ast = parse(SIMPLE_PIPELINE);
      const mmd = mermaidExporter.export(ast)[0].content;
      expect(mmd).toContain(":::orchestrator");
      expect(mmd).toContain(":::agent");
      expect(mmd).toContain(":::action");
      expect(mmd).toContain(":::gate");
    });
  });

  describe("minimal topology", () => {
    it("works with minimal input", () => {
      const ast = parse(MINIMAL_TOPOLOGY);
      const files = mermaidExporter.export(ast);
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("minimal.mmd");
      const mmd = files[0].content;
      expect(mmd).toContain("flowchart TD");
      expect(mmd).toContain("start --> worker");
    });
  });
});

// ---------------------------------------------------------------------------
// Cross-exporter tests
// ---------------------------------------------------------------------------

describe("cross-exporter", () => {
  const topologies = [
    { name: "simple-pipeline", source: SIMPLE_PIPELINE },
    { name: "fan-out", source: FAN_OUT_TOPOLOGY },
    { name: "minimal", source: MINIMAL_TOPOLOGY },
  ];

  for (const { name, source } of topologies) {
    it(`both exporters produce non-empty output for ${name}`, () => {
      const ast = parse(source);
      const mdFiles = markdownExporter.export(ast);
      const mmdFiles = mermaidExporter.export(ast);

      expect(mdFiles.length).toBeGreaterThan(0);
      expect(mmdFiles.length).toBeGreaterThan(0);

      for (const file of [...mdFiles, ...mmdFiles]) {
        expect(file.content.length).toBeGreaterThan(0);
        expect(file.path.length).toBeGreaterThan(0);
      }
    });
  }

  it("all nodes appear in both export formats", () => {
    const ast = parse(SIMPLE_PIPELINE);
    const md = markdownExporter.export(ast)[0].content;
    const mmd = mermaidExporter.export(ast)[0].content;

    for (const node of ast.nodes) {
      expect(md.toLowerCase()).toContain(node.id.replace(/-/g, " "));
      expect(mmd).toContain(node.id.replace(/-/g, "_"));
    }
  });

  it("all edges appear in both export formats", () => {
    const ast = parse(SIMPLE_PIPELINE);
    const md = markdownExporter.export(ast)[0].content;
    const mmd = mermaidExporter.export(ast)[0].content;

    for (const edge of ast.edges) {
      expect(md).toContain(edge.from);
      expect(md).toContain(edge.to);
      expect(mmd).toContain(edge.from.replace(/-/g, "_"));
      expect(mmd).toContain(edge.to.replace(/-/g, "_"));
    }
  });
});
