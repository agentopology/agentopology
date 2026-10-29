/**
 * Binding registry.
 *
 * Exports all available bindings and a lookup map keyed by target name.
 *
 * @module
 */

import type { BindingTarget } from "./types.js";
import type { TopologyAST } from "../parser/ast.js";
import { claudeCodeBinding } from "./claude-code.js";
import { claudeWorkflowBinding } from "./claude-workflow.js";
import { codexBinding } from "./codex.js";
import { geminiCliBinding } from "./gemini-cli.js";
import { copilotCliBinding } from "./copilot-cli.js";
import { openClawBinding } from "./openclaw.js";
import { kiroBinding } from "./kiro.js";
import { cursorBinding } from "./cursor.js";

export type { GeneratedFile, BindingTarget } from "./types.js";
export { deduplicateFiles } from "./types.js";
export { claudeCodeBinding } from "./claude-code.js";
export { claudeWorkflowBinding } from "./claude-workflow.js";
export { codexBinding } from "./codex.js";
export { geminiCliBinding } from "./gemini-cli.js";
export { copilotCliBinding } from "./copilot-cli.js";
export { openClawBinding } from "./openclaw.js";
export { kiroBinding } from "./kiro.js";
export { cursorBinding } from "./cursor.js";

/**
 * `type: mod` hooks run inside the Claude Code engine; only the claude-code
 * binding can emit them (as a plugin). Every other target would write them
 * out as a shell command that runs a .ts file, so they are dropped with a
 * warning instead.
 */
export function withoutMods(binding: BindingTarget): BindingTarget {
  return {
    ...binding,
    scaffold(ast: TopologyAST) {
      const mods = ast.hooks.filter((h) => h.type === "mod");
      if (mods.length === 0) return binding.scaffold(ast);
      console.warn(
        `[${binding.name}] Mods run inside the Claude Code engine; ${binding.name} cannot host them. ` +
          `Skipped: ${mods.map((m) => m.name).join(", ")}.`,
      );
      return binding.scaffold({ ...ast, hooks: ast.hooks.filter((h) => h.type !== "mod") });
    },
  };
}

/** All available binding targets, keyed by name. */
export const bindings: Record<string, BindingTarget> = {
  "claude-code": claudeCodeBinding,
  "claude-workflow": withoutMods(claudeWorkflowBinding),
  "codex": withoutMods(codexBinding),
  "gemini-cli": withoutMods(geminiCliBinding),
  "copilot-cli": withoutMods(copilotCliBinding),
  "openclaw": withoutMods(openClawBinding),
  "kiro": withoutMods(kiroBinding),
  "cursor": withoutMods(cursorBinding),
};
