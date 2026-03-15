/**
 * Import module — reverse-engineers platform directory structures into .at files.
 *
 * @module
 */

import type { PlatformFile } from "../sync/index.js";
import { importClaudeCode } from "./claude-code.js";
import { serializeAST } from "./serializer.js";

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
    case "claude-code": {
      const ast = importClaudeCode(files, topologyName);
      return serializeAST(ast);
    }
    default:
      throw new Error(
        `Import not supported for binding: "${binding}". Currently supported: claude-code`,
      );
  }
}

export { importClaudeCode } from "./claude-code.js";
export { serializeAST } from "./serializer.js";
