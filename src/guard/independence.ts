import * as fs from "node:fs";
import * as path from "node:path";
import type { TopologyAST } from "../parser/ast.js";
import { independentAgentIds, judgePairs } from "../parser/independence.js";

/** One line per independent agent: what validate prints about independence. */
export function independenceLines(ast: TopologyAST): string[] {
  const pairs = judgePairs(ast);
  return independentAgentIds(ast).map((id) => {
    const by = pairs.filter((p) => p.judge === id);
    const judged = by.length ? `judges ${[...new Set(by.flatMap((p) => p.judges))].join(", ")}; ` : "";
    return `Agent "${id}" is independent: ${judged}independence is flagged, not enforced (a launch in the same session as the author is logged to logs/independence.jsonl, not refused).`;
  });
}

/** How many not-independent flags the project's logs/independence.jsonl holds. */
export function independenceFlagCount(root: string): number {
  try {
    return fs.readFileSync(path.join(root, "logs/independence.jsonl"), "utf8").split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}
