/**
 * The `rules { rule "<id>" { text: "...", source: "..." } }` block: conduct
 * rules traced to their ids. Ids are quoted strings and may hold dots
 * ("R-7.6"); text is required; source says where the rule comes from.
 *
 * One home for reading the block, the summary line `validate` prints, and the
 * markdown section the bindings write, so they cannot drift apart.
 */

import type { RuleDef, TopologyAST } from "./ast.js";
import { braceText, closingBrace, parseFields, unquote } from "./lexer.js";

/** Markers around the generated Rules section; text outside them is the user's. */
export const RULES_FENCE_OPEN = "<!-- agentopology:rules (generated from the rules block; edit the .at, not this section) -->";
export const RULES_FENCE_CLOSE = "<!-- /agentopology:rules -->";

/** Read every `rule "<id>" { ... }` of a `rules` block body. */
export function parseRules(body: string): RuleDef[] {
  const out: RuleDef[] = [];
  const braces = braceText(body);
  const re = /(?:^|\n)[ \t]*rule[ \t]+"([^"\n]*)"[ \t]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const start = m.index + m[0].length;
    const end = closingBrace(braces, start);
    if (end < 0) continue;
    const fields = parseFields(body.slice(start, end));
    const rule: RuleDef = { id: m[1], text: fields.text !== undefined ? unquote(fields.text) : "" };
    if (fields.source !== undefined && unquote(fields.source) !== "") rule.source = unquote(fields.source);
    out.push(rule);
    re.lastIndex = end + 1;
  }
  return out;
}

/** The line `validate` prints: `rules: N declared (<ids>)`; null when there are none. */
export function rulesSummary(ast: TopologyAST): string | null {
  const rules = ast.rules ?? [];
  if (rules.length === 0) return null;
  return `rules: ${rules.length} declared (${rules.map((r) => r.id).join(", ")})`;
}

/**
 * The generated `## Rules` section, between its own markers, one entry per
 * rule with its id. Empty when no rule is declared.
 */
export function rulesSection(ast: TopologyAST): string[] {
  const rules = ast.rules ?? [];
  if (rules.length === 0) return [];
  const lines = [RULES_FENCE_OPEN, "## Rules", ""];
  for (const r of rules) {
    lines.push(`- **${r.id}**: ${r.text}${r.source ? ` (source: ${r.source})` : ""}`);
  }
  lines.push(RULES_FENCE_CLOSE, "");
  return lines;
}
