/**
 * Binding registry.
 *
 * Exports all available bindings and a lookup map keyed by target name.
 *
 * @module
 */

import type { BindingTarget } from "./types.js";
import { claudeCodeBinding } from "./claude-code.js";
import { codexBinding } from "./codex.js";
import { geminiCliBinding } from "./gemini-cli.js";
import { copilotCliBinding } from "./copilot-cli.js";
import { openClawBinding } from "./openclaw.js";
import { kiroBinding } from "./kiro.js";
import { cursorBinding } from "./cursor.js";

export type { GeneratedFile, BindingTarget } from "./types.js";
export { deduplicateFiles } from "./types.js";
export { claudeCodeBinding } from "./claude-code.js";
export { codexBinding } from "./codex.js";
export { geminiCliBinding } from "./gemini-cli.js";
export { copilotCliBinding } from "./copilot-cli.js";
export { openClawBinding } from "./openclaw.js";
export { kiroBinding } from "./kiro.js";
export { cursorBinding } from "./cursor.js";

/** All available binding targets, keyed by name. */
export const bindings: Record<string, BindingTarget> = {
  "claude-code": claudeCodeBinding,
  "codex": codexBinding,
  "gemini-cli": geminiCliBinding,
  "copilot-cli": copilotCliBinding,
  "openclaw": openClawBinding,
  "kiro": kiroBinding,
  "cursor": cursorBinding,
};
