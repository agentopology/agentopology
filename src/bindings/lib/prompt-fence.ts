/**
 * Markers around an agent's instructions in a generated agent file.
 *
 * Only the text between them belongs to the prompt; everything else in the
 * file is generated. Sync used to take everything from "## Instructions" to
 * the next heading it knew, so generated sections (memory stores, handoffs)
 * and headings pushed one level down were copied into the .at, and the prompt
 * grew on every scaffold → sync cycle (N11). Re-scaffold's merge read the same
 * span and kept stale generated sections.
 *
 * @module
 */

export const PROMPT_FENCE_OPEN = "<!-- agentopology:prompt (edit between these markers; sync copies it into the .at) -->";
export const PROMPT_FENCE_CLOSE = "<!-- /agentopology:prompt -->";

/** Where the prompt's text starts and ends in `content`, or null without markers. */
export function fenceSpan(content: string): { start: number; end: number } | null {
  const open = content.indexOf(PROMPT_FENCE_OPEN);
  if (open === -1) return null;
  const start = open + PROMPT_FENCE_OPEN.length;
  const end = content.indexOf(PROMPT_FENCE_CLOSE, start);
  return end === -1 ? null : { start, end };
}

/** The text between the prompt markers, or null when the file has none. */
export function fencedPrompt(content: string): string | null {
  const span = fenceSpan(content);
  return span ? content.slice(span.start, span.end).replace(/^\n+|\s+$/g, "") : null;
}
