/**
 * Merge logic for incremental scaffold.
 *
 * Handles preserving user-edited content (HUMAN zone) in agent files
 * while updating machine-generated sections, and hash-based overwrite
 * decisions for script files.
 *
 * @module
 */

import {
  extractSectionUntilKnownHeading,
  CLAUDE_CODE_STRUCTURAL_HEADINGS,
  COPILOT_STRUCTURAL_HEADINGS,
} from "../sync/index.js";
import { hashContent } from "./manifest.js";

/**
 * Return the list of known structural headings for a binding.
 * Falls back to the Claude Code list for unknown bindings.
 */
function getStructuralHeadings(binding: string): string[] {
  switch (binding) {
    case "copilot-cli":
      return COPILOT_STRUCTURAL_HEADINGS;
    case "claude-code":
    default:
      return CLAUDE_CODE_STRUCTURAL_HEADINGS;
  }
}

/**
 * Merge an existing agent file with a freshly generated one.
 *
 * Preserves the HUMAN zone (everything under `## Instructions` until the next
 * structural heading) from the existing file, while taking all machine-generated
 * sections from the generated file.
 *
 * If the existing file has no `## Instructions` section, returns the generated
 * file as-is.
 *
 * @param existing - Current file content on disk
 * @param generated - Freshly generated file content
 * @param binding - Target binding name (e.g. "claude-code")
 * @returns Merged file content
 */
export function mergeAgentFile(
  existing: string,
  generated: string,
  binding: string,
): string {
  const structuralHeadings = getStructuralHeadings(binding);

  // Extract the HUMAN zone from the existing file
  const humanContent = extractSectionUntilKnownHeading(
    existing,
    "## Instructions",
    structuralHeadings,
  );

  // If no Instructions section exists in existing, return generated as-is
  if (humanContent === null) {
    return generated;
  }

  // Find the ## Instructions section in the generated file
  const instructionsPattern = /^## Instructions\s*$/m;
  const instrMatch = instructionsPattern.exec(generated);
  if (!instrMatch) {
    // Generated file has no Instructions section — return it as-is
    return generated;
  }

  // Find where the generated instructions content ends (next structural heading or EOF)
  const afterHeading = instrMatch.index + instrMatch[0].length;
  const rest = generated.slice(afterHeading);

  let endPos = rest.length;
  for (const kh of structuralHeadings) {
    const khPattern = new RegExp(
      `^${kh.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
      "m",
    );
    const khMatch = khPattern.exec(rest);
    if (khMatch && khMatch.index < endPos) {
      endPos = khMatch.index;
    }
  }

  // Build merged file: everything before instructions content + human content + everything after
  const beforeContent = generated.slice(0, afterHeading);
  const afterContent = rest.slice(endPos);

  return beforeContent + "\n\n" + humanContent + "\n\n" + afterContent;
}

/**
 * Determine whether a script file should be overwritten.
 *
 * Compares the hash of the existing file content against the hash stored
 * in the manifest. If they match, the user has not edited the file and
 * it is safe to overwrite.
 *
 * @param existingContent - Current file content on disk
 * @param manifestHash - Hash from the scaffold manifest
 * @returns `true` if the file is unmodified and safe to overwrite
 */
export function shouldOverwriteScript(
  existingContent: string,
  manifestHash: string,
): boolean {
  return hashContent(existingContent) === manifestHash;
}

/**
 * Deep-merge two JSON config files.
 *
 * Scaffold-generated keys are added/updated into the existing config,
 * but user-only keys (not present in generated) are preserved.
 *
 * For nested objects (like mcpServers), merges by key — scaffold stubs
 * don't overwrite existing entries that have real config.
 *
 * @param existingRaw - Current file content on disk (JSON string)
 * @param generatedRaw - Freshly generated file content (JSON string)
 * @returns Merged JSON string, or existingRaw if parse fails
 */
export function deepMergeJson(existingRaw: string, generatedRaw: string): string {
  let existing: Record<string, unknown>;
  let generated: Record<string, unknown>;

  try {
    existing = JSON.parse(existingRaw);
    generated = JSON.parse(generatedRaw);
  } catch {
    // If either file isn't valid JSON, return existing unchanged
    return existingRaw;
  }

  const merged = mergeObjects(existing, generated);
  return JSON.stringify(merged, null, 2) + "\n";
}

function mergeObjects(
  existing: Record<string, unknown>,
  generated: Record<string, unknown>,
): Record<string, unknown> {
  // Start with a copy of existing (preserves user-only keys)
  const result: Record<string, unknown> = { ...existing };

  for (const [key, genValue] of Object.entries(generated)) {
    const exValue = existing[key];

    if (
      genValue !== null &&
      typeof genValue === "object" &&
      !Array.isArray(genValue) &&
      exValue !== null &&
      typeof exValue === "object" &&
      !Array.isArray(exValue)
    ) {
      // Both are objects — recurse
      result[key] = mergeObjects(
        exValue as Record<string, unknown>,
        genValue as Record<string, unknown>,
      );
    } else if (exValue === undefined) {
      // Key only in generated — add it
      result[key] = genValue;
    }
    // else: key exists in both and at least one is not an object — keep existing value
  }

  return result;
}
