/**
 * Import module — reverse-engineers platform directory structures into .at files.
 *
 * @module
 */

import type { PlatformFile } from "../sync/index.js";
import { importClaudeCode } from "./claude-code.js";
import { importOpenClaw } from "./openclaw.js";
import { serializeAST } from "./serializer.js";
import { flowReportLines, type FlowReport } from "./flow.js";

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
    case "openclaw": {
      const ast = importOpenClaw(files, topologyName);
      return serializeAST(ast);
    }
    default:
      throw new Error(
        `Import not supported for binding: "${binding}". Currently supported: claude-code, openclaw`,
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
  return { source: `${header}\n\n${serializeAST(ast)}`, report };
}

export { flowReportLines, type FlowReport } from "./flow.js";
export { readProject, readClaudeProject, ReadBudgetError, type Unread } from "./walk.js";
export { importClaudeCode } from "./claude-code.js";
export { importOpenClaw } from "./openclaw.js";
export { serializeAST } from "./serializer.js";
