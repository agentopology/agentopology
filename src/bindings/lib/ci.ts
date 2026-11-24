/**
 * The `ci { }` block as a GitHub Actions workflow.
 *
 * `.github/workflows/agentopology-gates.yml` checks out the repo, sets up Node
 * and runs `npx agentopology@<version> step check <file.at> <step>` for the
 * step after each listed gate (the gate's `before:`), the same check a
 * generated hook makes in a Claude Code session. A step any hook guards but
 * no session runs is still refused here, on every push or pull request.
 *
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { GateNode, TopologyAST } from "../../parser/ast.js";
import { gateAnchors } from "../../parser/ast.js";
import type { GeneratedFile } from "../types.js";

export const CI_WORKFLOW_PATH = ".github/workflows/agentopology-gates.yml";

/** The version of the running package, which the workflow pins. */
export function packageVersion(): string {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(fs.readFileSync(path.resolve(dir, "../../../package.json"), "utf8")).version;
  } catch {
    return "latest";
  }
}

/** A YAML scalar: plain when that reads back as the same string, else double-quoted. */
function yamlScalar(s: string): string {
  return /^[A-Za-z0-9_](?:[A-Za-z0-9_./@+= -]*[A-Za-z0-9_./@+=-])?$/.test(s) && !/^(?:true|false|null|yes|no|on|off|~|[-+]?[\d._]+)$/i.test(s)
    ? s
    : JSON.stringify(s);
}

/** A shell word: bare when it holds only safe characters, else single-quoted. */
function shellWord(s: string): string {
  return /^[A-Za-z0-9_./@+=:-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The .at file as the workflow names it: relative to the project when it sits inside it. */
function sourceName(ast: TopologyAST): string {
  if (ast.sourcePath) {
    const rel = path.relative(process.cwd(), ast.sourcePath).split(path.sep).join("/");
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : path.basename(ast.sourcePath);
  }
  return `${ast.topology.name}.at`;
}

/** The steps to check: the `before:` of each listed gate, each once, in order. */
export function ciSteps(ast: TopologyAST): string[] {
  const steps: string[] = [];
  for (const id of ast.ci?.gates ?? []) {
    const gate = ast.nodes.find((n) => n.id === id && n.type === "gate") as GateNode | undefined;
    for (const step of gate ? gateAnchors(gate, "before") : []) if (!steps.includes(step)) steps.push(step);
  }
  return steps;
}

/** The workflow file, or none without a `ci { }` block (or when it names nothing to check). */
export function generateCiWorkflow(ast: TopologyAST): GeneratedFile[] {
  if (!ast.ci || ast.ci.provider !== "github") return [];
  const steps = ciSteps(ast);
  if (steps.length === 0) return [];
  const version = packageVersion();
  const file = sourceName(ast);
  const lines = [
    `# Written by agentopology scaffold from ${file}. Edit it freely: once you have,`,
    `# scaffold keeps your copy and no longer regenerates it.`,
    `name: agentopology-gates`,
    `on:`,
    ...ast.ci.on.map((e) => `  ${yamlScalar(e)}:`),
    `jobs:`,
    `  gates:`,
    `    runs-on: ubuntu-latest`,
    `    steps:`,
    `      - uses: actions/checkout@v4`,
    `      - uses: actions/setup-node@v4`,
    `        with:`,
    `          node-version: 20`,
    ...steps.flatMap((step) => [
      `      - name: ${yamlScalar(`Check ${step}`)}`,
      `        run: ${yamlScalar(`npx agentopology@${version} step check ${shellWord(file)} ${shellWord(step)}`)}`,
    ]),
  ];
  return [{
    path: CI_WORKFLOW_PATH,
    content: lines.join("\n") + "\n",
    category: "machine",
    // Regenerated while it is as scaffold wrote it; once edited it is the user's.
    userScript: true,
  }];
}
