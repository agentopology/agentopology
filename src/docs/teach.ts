/**
 * The teaching layer — the CLI serving what it already knows, when it matters.
 *
 * WHY THIS EXISTS
 * ---------------
 * The package ships 41 documentation topics and 93 validation rules, and until
 * now the two never met. A rule would tell you a field was wrong; nothing told
 * you what the right form looked like, or where to read more.
 *
 * The cost of the alternative is the point. `agentopology docs --all` is
 * ~104 KB — nobody should ever load it. A single topic is 2-7 KB, and the
 * snippets here are a few hundred bytes. Serving the RIGHT one at the moment of
 * the mistake is what makes this context-efficient rather than a documentation
 * dump.
 *
 * It also works where a skill cannot: a Codex or Gemini session gets the same
 * lesson from the same command, because it is in the tool rather than beside it.
 *
 * @module
 */

/** What a rule teaches: the correct form, and the topic to read for more. */
export interface Lesson {
  /** `agentopology docs <topic>` — the full reference. */
  topic: string;
  /** A minimal correct example. Kept short on purpose. */
  snippet: string;
}

/**
 * Rule → lesson. Only rules whose fix is a SHAPE the author must write are
 * listed; a rule like "names must be unique" needs no example, and adding one
 * would be noise.
 */
const LESSONS: Record<string, Lesson> = {
  V2: {
    topic: "keywords",
    snippet: `# Reserved keywords cannot be node ids. Rename the node:
agent gates { … }        # ✗ "gates" is a block keyword
agent gate-runner { … }  # ✓`,
  },
  V4: {
    topic: "flow",
    snippet: `# Every agent must appear in flow, or be marked manual:
flow { intake -> my-agent }

# …or, for one invoked on demand:
agent my-agent {
  invocation: manual
}`,
  },
  V5: {
    topic: "agent",
    snippet: `# A [when] condition must name a declared output:
agent reviewer {
  outputs: {
    verdict: approve | revise | reject
  }
}
flow { reviewer -> done [when reviewer.verdict == approve] }`,
  },
  V6: {
    topic: "flow",
    snippet: `# Every back-edge needs a bound, or the loop is unbounded:
flow { reviewer -> writer [when reviewer.verdict == revise, max 2] }
#                                                        ^^^^^^^`,
  },
  V7: {
    topic: "agent",
    snippet: `# Every agent and orchestrator needs a model:
agent researcher {
  model: sonnet
  description: "…"
}`,
  },
  V12: {
    topic: "flow",
    snippet: `# Edge attributes go in ONE bracket, in order [when …, max N]:
flow { a -> b [when a.verdict == fail, max 3] }`,
  },
  V13: {
    topic: "gate",
    snippet: `# A gate's anchor must name a DECLARED node. One, or many:
agent builder {
  model: sonnet
  description: "..."
}
gates {
  gate verify {
    after: builder
    run: "npm test"
  }
}

# A list attaches one declaration to several anchors, so a repeated
# ritual cannot drift:  after: [lane-a, lane-b, lane-c]`,
  },
  V15: {
    topic: "flow",
    snippet: `# Conditional edges must cover every value of the output:
agent judge {
  outputs: {
    verdict: pass | fail
  }
}
flow { judge -> ship [when judge.verdict == pass]
       judge -> fix  [when judge.verdict == fail] }`,
  },
  V26: {
    topic: "action",
    snippet: `# action.kind is one of: external, git, decision, inline, report
action intake {
  kind: inline
  description: "…"
}`,
  },
  V35: {
    topic: "agent",
    snippet: `# thinking is the reasoning-effort field:
agent architect {
  model: opus
  thinking: xhigh   # off | low | medium | high | xhigh | max
}`,
  },
  V89: {
    topic: "agent",
    snippet: `# An agent prompt is a BLOCK, not a string:
agent analyzer {
  model: sonnet
  prompt {
    Read the diff at workspace/pr-diff.md.
    Report structural risk only.
  }
}`,
  },
  V90: {
    topic: "topology",
    snippet: `# Fields are ONE PER LINE. Two on one line and the first
# swallows the rest as its value:
agent a { model: sonnet retry: 3 }   # ✗ model becomes "sonnet retry: 3"

agent a {                            # ✓
  model: sonnet
  retry: 3
}`,
  },
  V91: {
    topic: "topology",
    snippet: `# meta.version and orchestrator.model are required. The parser
# substitutes a placeholder when they are missing, which is why
# nothing else complained:
meta {
  version: "1.0.0"
  description: "…"
}`,
  },
  V92: {
    topic: "flow",
    snippet: `# One bracket, comma-separated — not two:
flow { a -> b [when a.verdict == fail] [max 3] }   # ✗
flow { a -> b [when a.verdict == fail, max 3] }    # ✓`,
  },
  V93: {
    topic: "agent",
    snippet: `# An edge should declare what crosses it. The reader's reads
# must overlap the writer's writes:
agent builder {
  writes: ["workspace/diff.md"]
}
agent reviewer {
  reads: ["workspace/diff.md"]   # ← the handoff
}`,
  },
};

/**
 * Lessons for a set of validation results, deduplicated by rule.
 *
 * A run with twelve V90 errors gets the lesson once. That cap is the whole
 * reason this is affordable to always show.
 *
 * @param rules - Rule ids that fired, in any order, with duplicates.
 * @param limit - Maximum distinct lessons to return. Keeps a badly broken file
 *   from producing more teaching than output.
 */
export function lessonsFor(rules: string[], limit = 3): Array<Lesson & { rule: string }> {
  const seen = new Set<string>();
  const out: Array<Lesson & { rule: string }> = [];

  for (const rule of rules) {
    if (seen.has(rule)) continue;
    seen.add(rule);
    const lesson = LESSONS[rule];
    if (!lesson) continue;
    out.push({ rule, ...lesson });
    if (out.length >= limit) break;
  }

  return out;
}

/** Whether a rule has a lesson at all. */
export function hasLesson(rule: string): boolean {
  return rule in LESSONS;
}

/** Every rule that teaches — used by the coverage test. */
export function taughtRules(): string[] {
  return Object.keys(LESSONS);
}
