/**
 * The platform seam for conformance: one place that answers, per binding
 * target, "what was the output checked against" and "what is installed".
 * The CLI asks here instead of importing one platform's module.
 *
 * @module
 */

import * as claude from "./claude-code.js";
import * as codex from "./codex.js";

export interface PlatformConformance {
  /** The sentence about the version the output was checked against. */
  verifiedOnLine(): string;
  /** The line about the installed binary; null when it is the verified version. */
  installedMark(): string | null;
}

const PLATFORMS: Record<string, PlatformConformance> = {
  "claude-code": { verifiedOnLine: claude.verifiedOnLine, installedMark: claude.installedMark },
  codex: { verifiedOnLine: codex.verifiedOnLine, installedMark: codex.installedMark },
};

/** The conformance facts for a target, or null for a target with none. */
export function platformConformance(target: string): PlatformConformance | null {
  return PLATFORMS[target] ?? null;
}
