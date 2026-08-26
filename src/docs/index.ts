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

/**
 * The minimum an agent needs to write a valid `.at` from scratch.
 *
 * `getAllTopics()` is ~104 KB — loading it to write one topology is the
 * opposite of context-efficient. This is the compact alternative: the shape,
 * the handful of rules that actually bite, and where to go for more.
 *
 * @returns A few hundred lines, not a hundred kilobytes.
 */
export function getAgentGuide(): string {
  return `# Writing a .at file — the minimum

A topology says WHO works, WHEN they work, and WHAT THEY KNOW when they work.

\`\`\`
topology my-team : [pipeline] {

  meta {
    version: "1.0.0"          # required
    description: "..."        # required
  }

  agent researcher {
    model: sonnet             # required
    description: "..."
    reads:  ["workspace/task.md"]
    writes: ["workspace/findings.md"]
    prompt {
      Instructions go in a BLOCK, never as a string.
    }
  }

  agent reviewer {
    model: opus
    description: "..."
    reads: ["workspace/findings.md"]   # <- the handoff
    outputs: {
      verdict: approve | revise
    }
  }

  action intake {
    kind: inline              # external | git | decision | inline | report
    description: "..."
  }

  action ship {
    kind: report
    description: "..."
  }

  gates {
    gate tests-green {
      after: reviewer         # or a list: [a, b, c]
      run: "npm test"
      on-fail: bounce-back
    }
  }

  flow {
    intake -> researcher -> reviewer
    reviewer -> ship       [when reviewer.verdict == approve]
    reviewer -> researcher [when reviewer.verdict == revise, max 2]
  }
}
\`\`\`

## The five that actually bite

1. **One field per line.** \`{ model: sonnet retry: 3 }\` makes \`model\` the
   string "sonnet retry: 3". Nothing else will tell you.
2. **A prompt is a block**, not \`prompt: "path.md"\`. The string form belongs
   to \`skill\`, and on an agent it parses to nothing.
3. **Every back-edge needs \`[max N]\`.** An unbounded loop between two agents
   is a bill, not a design.
4. **Conditional edges must cover every enum value.** If \`verdict\` can be
   \`revise\`, some edge must handle \`revise\`.
5. **An edge should declare what crosses it.** The reader's \`reads\` should
   overlap the writer's \`writes\`, or the receiver runs after the sender with
   none of its output.

## Then

    agentopology validate my-team.at    # it will teach you what it rejects
    agentopology plan my-team.at        # run it now, nothing written to disk
    agentopology scaffold my-team.at --target claude-code

Deeper on any block: \`agentopology docs <topic>\`
Topics: \`agentopology docs\`
`;
}
