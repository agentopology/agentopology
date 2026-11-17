/**
 * The regions of a generated agent file: its frontmatter, the prompt between
 * the markers, and the rest of the body (the sections the binding generates).
 *
 * The manifest records a hash of the frontmatter and one of the body outside
 * the prompt, so a later run can tell which region a hand edit touched: an
 * edit between the markers leaves the generated sections scaffold's to
 * regenerate; an edit outside them makes the body the user's.
 *
 * @module
 */

import { fenceSpan, PROMPT_FENCE_CLOSE, PROMPT_FENCE_OPEN } from "../bindings/lib/prompt-fence.js";
import { hashContent } from "./manifest.js";
import type { ManifestEntry } from "./types.js";

const HEAD = /^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const PROMPT = "\u0000prompt\u0000";

export interface Regions {
  /** The frontmatter block, fences included ("" when there is none). */
  head: string;
  /** The body after the frontmatter, with the prompt's text taken out. */
  outside: string;
}

/** The file's regions, or null when it has no prompt markers in its body. */
export function regionsOf(content: string): Regions | null {
  const head = HEAD.exec(content)?.[0] ?? "";
  const body = content.slice(head.length);
  const span = fenceSpan(body);
  if (!span) return null;
  return { head, outside: body.slice(0, span.start) + PROMPT + body.slice(span.end) };
}

/** Hashes of a file's regions, as the manifest records them. */
export function regionHashes(content: string): { head: string; outside: string } | null {
  const r = regionsOf(content);
  return r ? { head: hashContent(r.head), outside: hashContent(r.outside) } : null;
}

/** The headings of the generated sections outside the prompt that the file does not hold as generated. */
export function staleSections(existing: string, generated: string): string[] {
  const mine = regionsOf(existing);
  return mine ? sectionsNotIn(mine.outside, generated) : [];
}

/** The headings of the generated sections outside the prompt that `text` does not hold as generated. */
function sectionsNotIn(text: string, generated: string): string[] {
  const gen = regionsOf(generated);
  if (!gen) return [];
  const out: string[] = [];
  const lines = gen.outside.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^#{1,6} /.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && !/^#{1,6} /.test(lines[j])) j++;
    const section = lines.slice(i, j).join("\n").replace(/\s+$/, "");
    if (!section.includes(PROMPT) && !text.includes(section)) out.push(lines[i].trim());
    i = j - 1;
  }
  return out;
}

/** Whether a file holds exactly one pair of prompt markers, the start before the end. */
export function markersIntact(content: string): boolean {
  const count = (m: string) => content.split(m).length - 1;
  if (count(PROMPT_FENCE_OPEN) !== 1 || count(PROMPT_FENCE_CLOSE) !== 1) return false;
  return content.indexOf(PROMPT_FENCE_OPEN) < content.indexOf(PROMPT_FENCE_CLOSE);
}

/**
 * For a scaffolded file with prompt markers the user edited: whether the edit
 * reached the frontmatter (`head`) and the body outside the prompt
 * (`outside`), and whether the .at changed that body since the last write.
 * Null when either file has no markers. A manifest entry from before the
 * region hashes counts a region as unedited only when it is already what the
 * .at generates.
 */
export function editedRegions(
  existing: string,
  generated: string,
  entry: ManifestEntry,
): { head: boolean; outside: boolean; generatedChanged: boolean } | null {
  const mine = regionsOf(existing);
  const theirs = regionsOf(generated);
  if (!mine || !theirs) return null;
  const was = (part: "head" | "outside") =>
    entry[part] !== undefined ? hashContent(mine[part]) === entry[part] : mine[part] === theirs[part];
  return {
    head: !was("head"),
    outside: !was("outside"),
    generatedChanged: generatedBodyChanged(generated, entry),
  };
}

/** Whether the .at changed the generated body outside the prompt since scaffold last wrote it (unknown counts as changed). */
function generatedBodyChanged(generated: string, entry: ManifestEntry): boolean {
  const theirs = regionsOf(generated);
  if (!theirs) return false;
  return entry.outside === undefined || hashContent(theirs.outside) !== entry.outside;
}

/**
 * A scaffolded agent file whose body is the user's: the line that names the
 * generated sections the .at changed and the file does not hold, or null
 * when there is nothing to say. The body is the user's when its text outside
 * the prompt markers was edited, or when the markers themselves are missing,
 * repeated, reordered or altered (the writer never guesses where the prompt
 * is). Said only when the .at changed a generated section, so a file the .at
 * has nothing new for gets no line.
 */
export function staleBodyNotice(existing: string, generated: string, entry: ManifestEntry): string | null {
  if (!regionsOf(generated) || !generatedBodyChanged(generated, entry)) return null;
  let why: string;
  let stale: string[];
  if (!markersIntact(existing)) {
    why = "the prompt markers are missing or altered, so the body is kept";
    stale = sectionsNotIn(existing.slice(HEAD.exec(existing)?.[0].length ?? 0), generated);
  } else {
    if (!editedRegions(existing, generated, entry)?.outside) return null;
    why = "the file's text outside the prompt markers was edited, so the body is kept";
    stale = staleSections(existing, generated);
  }
  return stale.length > 0 ? `generated sections not refreshed (${why}): ${stale.join(", ")}` : null;
}
