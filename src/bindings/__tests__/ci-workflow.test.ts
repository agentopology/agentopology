/**
 * `ci { provider: github, on: [...], gates: [...] }` compiles to a GitHub
 * Actions workflow that runs `agentopology step check` for the step after each
 * listed gate. The same check the generated hooks make, run on every push.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { claudeCodeBinding } from "../claude-code.js";
import { computeIncrementalPlan } from "../../scaffold/incremental.js";
import { hashContent } from "../../scaffold/manifest.js";
import type { ScaffoldManifest } from "../../scaffold/types.js";

const WORKFLOW = ".github/workflows/agentopology-gates.yml";

const topo = (ci: string, gateExtra = "") => `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "x"
  }
  orchestrator {
    model: opus
    handles: [intake]
  }
  action intake {
    kind: inline
    description: "in"
  }
  action publish {
    kind: external
    description: "Publish"
    commands: ["echo publish"]
  }
  action deploy {
    kind: external
    description: "Deploy"
    commands: ["echo deploy"]
  }
  gates {
    gate needs-review {
      after: intake
      before: publish
      run: tools/review.sh
    }
    gate smoke {
      after: publish
      before: deploy
      run: tools/smoke.sh
    }
    gate loose {
      after: intake
      run: tools/loose.sh
      ${gateExtra}
    }
  }
  flow {
    intake -> publish
    publish -> deploy
  }
  ${ci}
}
`;

const GOOD = `ci {
    provider: github
    on: [pull_request, push]
    gates: [needs-review, smoke]
  }`;

const errors = (src: string) => validate(parse(src)).filter((r) => r.level === "error");

describe("ci block: parse", () => {
  it("reads provider, on and gates", () => {
    const ast = parse(topo(GOOD));
    expect(ast.ci).toEqual({ provider: "github", on: ["pull_request", "push"], gates: ["needs-review", "smoke"] });
  });

  it("is absent when not written", () => {
    expect(parse(topo("")).ci).toBeUndefined();
  });

  it("reads the one-line form", () => {
    const ast = parse(topo("ci { provider: github, on: [push], gates: [smoke] }"));
    expect(ast.ci).toEqual({ provider: "github", on: ["push"], gates: ["smoke"] });
  });
});

describe("ci block: validation (V155)", () => {
  it("accepts a declared gate with a step after it", () => {
    expect(errors(topo(GOOD)).filter((r) => r.rule === "V155")).toEqual([]);
  });

  it("refuses a provider other than github", () => {
    const r = errors(topo(GOOD.replace("github", "gitlab"))).filter((x) => x.rule === "V155");
    expect(r).toHaveLength(1);
    expect(r[0].message).toContain("only github is supported");
  });

  it("refuses a gate id that is not declared", () => {
    const r = errors(topo(GOOD.replace("smoke", "no-such-gate"))).filter((x) => x.rule === "V155");
    expect(r).toHaveLength(1);
    expect(r[0].message).toContain("no-such-gate");
  });

  it("refuses a gate with no step after it", () => {
    const r = errors(topo(GOOD.replace("smoke", "loose"))).filter((x) => x.rule === "V155");
    expect(r).toHaveLength(1);
    expect(r[0].message).toContain("loose");
    expect(r[0].message).toContain("no step after it");
  });
});

describe("ci block: the generated workflow", () => {
  const gen = (src: string) => claudeCodeBinding.scaffold(parse(src)).find((f) => f.path === WORKFLOW);

  it("writes nothing without a ci block", () => {
    expect(gen(topo(""))).toBeUndefined();
  });

  it("checks out, sets up Node and runs step check for the step after each gate", () => {
    const text = gen(topo(GOOD))!.content;
    const version = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8")).version;
    expect(text).toContain("actions/checkout@");
    expect(text).toContain("actions/setup-node@");
    expect(text).toContain(`npx agentopology@${version} step check t.at publish`);
    expect(text).toContain(`npx agentopology@${version} step check t.at deploy`);
    expect(text).not.toContain("step check t.at intake");
  });

  it("is YAML the triggers and job steps read back from", () => {
    const text = gen(topo(GOOD))!.content;
    expect(text).toMatch(/^name: .+$/m);
    expect(text).toMatch(/^on:\n  pull_request:\n  push:\n/m);
    expect(text).toMatch(/^jobs:\n  gates:\n    runs-on: ubuntu-latest\n    steps:\n/m);
    // every line is indented with spaces only, and no tab
    expect(text).not.toMatch(/\t/);
    const runs = [...text.matchAll(/^ {8}run: (.+)$/gm)].map((m) => m[1]);
    expect(runs).toHaveLength(2);
  });

  it("lists a step once when two gates guard it", () => {
    const src = topo(GOOD.replace("[needs-review, smoke]", "[needs-review]")).replace("gate smoke {\n      after: publish\n      before: deploy", "gate smoke {\n      after: publish\n      before: publish");
    const text = gen(src.replace("gates: [needs-review]", "gates: [needs-review, smoke]"))!.content;
    expect(text.match(/step check t\.at publish/g)).toHaveLength(1);
  });
});

describe("ci block: scaffold keeps an edited workflow", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-wf-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const manifestFor = (content: string): ScaffoldManifest => ({
    source: "t.at", sourceHash: "x", target: "claude-code", generatedAt: "",
    files: { [WORKFLOW]: { hash: hashContent(content), category: "machine" } },
  });

  it("regenerates it while it is as scaffold wrote it, keeps it once edited", () => {
    const files = claudeCodeBinding.scaffold(parse(topo(GOOD)));
    const wf = files.find((f) => f.path === WORKFLOW)!;
    const abs = path.join(dir, WORKFLOW);
    fs.mkdirSync(path.dirname(abs), { recursive: true });

    fs.writeFileSync(abs, "old generated\n");
    const fresh = computeIncrementalPlan(dir, "claude-code", [wf], manifestFor("old generated\n"));
    expect(fresh.find((a) => a.path === WORKFLOW)?.type).toBe("update");

    fs.writeFileSync(abs, "name: mine\n");
    const edited = computeIncrementalPlan(dir, "claude-code", [wf], manifestFor("old generated\n"));
    expect(edited.find((a) => a.path === WORKFLOW)?.type).toBe("kept");
  });
});
