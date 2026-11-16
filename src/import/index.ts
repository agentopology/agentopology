/**
 * Import module — reverse-engineers platform directory structures into .at files.
 *
 * @module
 */

import type { PlatformFile } from "../sync/index.js";
import { importClaudeCode } from "./claude-code.js";
import { serializeAST } from "./serializer.js";
import { flowReportLines, type FlowReport } from "./flow.js";
import { compilesUnfaithfully, UNFAITHFUL } from "./run-words.js";
import { parse } from "../parser/index.js";
import type { TopologyAST } from "../parser/ast.js";

/**
 * Import platform files and generate .at source text.
 *
 * @param files - All files read from the platform directory
 * @param binding - Target binding name (e.g. "claude-code")
 * @param topologyName - Name for the generated topology
 * @returns .at source text
 */
export function importFromPlatform(
  files: PlatformFile[],
  binding: string,
  topologyName: string,
): string {
  switch (binding) {
    case "claude-code":
      return importClaudeCodeWithReport(files, topologyName).source;
    default:
      throw new Error(
        `Import not supported for binding: "${binding}". Currently supported: claude-code`,
      );
  }
}

/**
 * A Claude Code import with its flow report. The generated .at opens with the
 * report as comments, so what is known and unknown stays with the file.
 */
export function importClaudeCodeWithReport(
  files: PlatformFile[],
  topologyName: string,
): { source: string; report: FlowReport } {
  let report!: FlowReport;
  const ast = importClaudeCode(files, topologyName, (r) => (report = r));
  const header = flowReportLines(report).map((l) => `# ${l}`).join("\n");
  let source = `${header}\n\n${serializeAST(ast)}`;
  // B (0.11.3): a hook scaffold would not compile faithfully (a stub, D1, D2)
  // is an import error, so import → scaffold never silently replaces a command
  // that ran. Judged on the run as the written .at gives it back; reported
  // with the command as the harness wrote it.
  let written: TopologyAST | null = null;
  try {
    written = parse(source);
  } catch {
    // a .at that does not parse is reported by the caller (S-68)
  }
  const text = new Map(files.map((f) => [f.path.replace(/\\/g, "/").replace(/^\.\//, ""), f.content]));
  const raw = new Map(ast.hooks.map((h) => [h.name, h.run]));
  const errors = (written?.hooks ?? [])
    .filter((h) => (h.type ?? "command") === "command" && compilesUnfaithfully(h.run, (p) => text.get(p)))
    .map((h) => ({ hook: h.name, command: raw.get(h.name) ?? h.run, message: `Hook "${h.name}": ${UNFAITHFUL}` }));
  // P2-3: the warning sits in the .at, a comment directly above the hook.
  for (const e of errors) {
    source = source.replace(new RegExp(`^([ \\t]*)hook ${e.hook.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{`, "m"), (line, indent) => `${indent}# ⚠ ${UNFAITHFUL}\n${line}`);
  }
  return { source, report: errors.length ? { ...report, errors } : report };
}

export { flowReportLines, type FlowReport } from "./flow.js";
export { readProject, readClaudeProject, ReadBudgetError, type Unread } from "./walk.js";
export { importClaudeCode } from "./claude-code.js";
export { serializeAST } from "./serializer.js";
