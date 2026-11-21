/**
 * Brief exporter — the interpreted-mode execution brief, written to a file.
 *
 * Same document `agentopology plan --brief` prints. Exposed here so it is
 * reachable as `--format brief` and so it inherits the exporter test harness.
 *
 * Note the default autonomy notch: an exported brief has no invocation context,
 * so it takes `execute`. `agentopology plan --mode` is the way to choose.
 *
 * @module
 */

import type { TopologyAST } from "../parser/ast.js";
import type { GeneratedFile } from "../bindings/types.js";
import type { Exporter } from "./types.js";
import { ruleAppliesTo, validate } from "../parser/validator.js";
import { buildExecutionBrief } from "../plan/brief.js";
import { renderBriefMarkdown } from "../plan/render.js";

export const briefExporter: Exporter = {
  name: "brief",
  description: "Execution brief — the interpreted-mode program a host agent enacts",
  extension: ".brief.md",

  export(ast: TopologyAST): GeneratedFile[] {
    // Interpreted mode: a rule about generated hooks (V135) does not apply.
    const errors = validate(ast)
      .filter((r) => r.level === "error" && ruleAppliesTo(r.rule, "interpreted"))
      .map((r) => ({ rule: r.rule, message: r.message, node: r.node }));

    const brief = buildExecutionBrief(ast, {
      source: `${ast.topology.name}.at`,
      autonomy: "execute",
      errors,
    });

    return [
      {
        path: `${ast.topology.name}.brief.md`,
        content: `${renderBriefMarkdown(brief)}\n`,
        category: "machine",
      },
    ];
  },
};
