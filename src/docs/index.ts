/**
 * AgenTopology documentation system.
 *
 * Provides a built-in language reference accessible via `agentopology docs`.
 * All content is plain markdown — readable in terminals and consumable by LLMs.
 *
 * @module
 */

import { topics } from "./content.js";
import type { DocTopic } from "./content.js";

// ---------------------------------------------------------------------------
// ANSI colors (duplicated from CLI to keep this module self-contained)
// ---------------------------------------------------------------------------

const isColorSupported =
  process.env.NO_COLOR === undefined && process.stdout.isTTY;

const c = {
  bold: (s: string) => (isColorSupported ? `\x1b[1m${s}\x1b[0m` : s),
  cyan: (s: string) => (isColorSupported ? `\x1b[36m${s}\x1b[0m` : s),
  dim: (s: string) => (isColorSupported ? `\x1b[2m${s}\x1b[0m` : s),
  yellow: (s: string) => (isColorSupported ? `\x1b[33m${s}\x1b[0m` : s),
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** List all available topics with descriptions. */
export function listTopics(): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(c.bold("AgenTopology Language Reference"));
  lines.push("");
  lines.push(c.bold("Available topics:"));

  for (const topic of Object.values(topics)) {
    lines.push(`  ${c.cyan(topic.name.padEnd(16))} ${topic.description}`);
  }

  lines.push("");
  lines.push(`${c.dim("Usage:")} agentopology docs ${c.dim("<topic>")}`);
  lines.push(`       agentopology docs --all`);
  lines.push(`       agentopology docs --search ${c.dim("<term>")}`);
  lines.push("");

  return lines.join("\n");
}

/** Get the content of a specific topic. Returns null if not found. */
export function getTopic(name: string): string | null {
  const key = name.toLowerCase();
  const topic = topics[key];
  return topic ? topic.content() : null;
}

/** Get ALL topics concatenated (for --all flag, LLM ingestion). */
export function getAllTopics(): string {
  const sections: string[] = [];

  sections.push("# AgenTopology Language Reference");
  sections.push("");

  for (const topic of Object.values(topics)) {
    sections.push("=".repeat(72));
    sections.push("");
    sections.push(topic.content().trim());
    sections.push("");
  }

  return sections.join("\n");
}

/** Search across all topics for a term (case-insensitive). */
export function searchTopics(query: string): string {
  const q = query.toLowerCase();
  const matches: { topic: DocTopic; matchType: string; snippet: string }[] = [];

  for (const topic of Object.values(topics)) {
    // Check name
    if (topic.name.toLowerCase().includes(q)) {
      matches.push({
        topic,
        matchType: "topic name",
        snippet: topic.description,
      });
      continue;
    }

    // Check description
    if (topic.description.toLowerCase().includes(q)) {
      matches.push({
        topic,
        matchType: "description",
        snippet: topic.description,
      });
      continue;
    }

    // Check content
    const topicContent = topic.content();
    const contentLower = topicContent.toLowerCase();
    const idx = contentLower.indexOf(q);
    if (idx !== -1) {
      // Extract a snippet around the match
      const start = Math.max(0, idx - 40);
      const end = Math.min(topicContent.length, idx + q.length + 60);
      let snippet = topicContent.slice(start, end).replace(/\n/g, " ").trim();
      if (start > 0) snippet = "..." + snippet;
      if (end < topicContent.length) snippet = snippet + "...";
      matches.push({
        topic,
        matchType: "content",
        snippet,
      });
    }
  }

  if (matches.length === 0) {
    return `No matches for "${query}".`;
  }

  const lines: string[] = [];
  lines.push("");
  lines.push(c.bold(`Search results for "${query}":`));
  lines.push("");

  for (const m of matches) {
    lines.push(`  ${c.cyan(m.topic.name.padEnd(16))} ${c.dim(`(${m.matchType})`)} ${m.snippet}`);
  }

  lines.push("");
  lines.push(`${c.dim("View a topic:")} agentopology docs ${c.dim("<topic>")}`);
  lines.push("");

  return lines.join("\n");
}
