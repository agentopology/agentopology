/**
 * Capability keys: whether the .at's value of a frontmatter key would grant
 * more than the file's.
 *
 * Scaffold never widens a capability key over a value it did not write (see
 * structure.ts). "Wider" per key:
 *
 * - `tools` (agent): an allowlist; omitted means every tool, the widest. The
 *   .at's list is wider when one of its entries is covered by none of the
 *   file's. A server wildcard covers that server's tools (`mcp__x__*` and
 *   `mcp__x` cover `mcp__x__a`); a bare tool covers its parameterised forms
 *   (`Bash` covers `Bash(git log:*)`). `mcp__*` covers every MCP tool
 *   (sub-agents.md: "Withhold every MCP tool from any server … `mcp__*`"),
 *   and `*` covers every tool, so a file with `tools: "*"` is as wide as one
 *   that omits the key. An unknown name is covered only by itself, so it
 *   counts as wider.
 * - `allowed-tools` (skill, command): tools approved without asking; omitted
 *   approves nothing. Wider by the same entry test.
 * - `disallowedTools` (agent), `disallowed-tools` (skill, command): a
 *   denylist; the .at's is wider when it stops denying a tool the file
 *   denies. For an agent an entry with a specifier denies the whole tool
 *   (code.claude.com/docs/en/sub-agents.md: "An entry with a specifier, such
 *   as `Bash(git push *)`, still removes the whole tool").
 * - `mcpServers` (agent): servers the agent gets; omitted adds none. Wider
 *   when the .at names a server the file does not.
 * - `permissionMode` (agent): a partial order on what runs without asking
 *   (code.claude.com/docs/en/permission-modes.md), least first:
 *   dontAsk < default (= manual) < acceptEdits < auto < bypassPermissions,
 *   and plan < auto. `dontAsk` "auto-denies every tool call that would
 *   otherwise prompt you", so it is below default. `plan` runs "Reads, plus
 *   classifier-approved commands when auto mode is available", which default
 *   would ask about, while it blocks the edits default can make after asking:
 *   it is not ranked against dontAsk, default or acceptEdits. An omitted mode
 *   is the session's, inherited (sub-agents.md: "If you leave it unset, the
 *   subagent inherits the main conversation's permission mode"), so only
 *   dontAsk is known to be no wider than it.
 *
 * What cannot be compared (a nested block, an unranked pair, an unknown
 * mode) counts as wider: the file's value is kept and said.
 *
 * @module
 */

import { toolList, type FieldValue } from "./frontmatter-patch.js";

type Kind = "agent" | "skill" | "command";

type Rule = "allow-omitted-all" | "grant" | "deny" | "deny-whole-tool" | "servers" | "mode";

function ruleOf(kind: Kind, key: string): Rule | null {
  if (kind === "agent") {
    if (key === "tools") return "allow-omitted-all";
    if (key === "disallowedTools") return "deny-whole-tool";
    if (key === "mcpServers") return "servers";
    if (key === "permissionMode") return "mode";
    return null;
  }
  if (key === "allowed-tools") return "grant";
  if (key === "disallowed-tools") return "deny";
  return null;
}

/** Whether a key decides what the agent, skill or command may do. */
export function isCapabilityKey(kind: string, key: string): boolean {
  return (kind === "agent" || kind === "skill" || kind === "command") && ruleOf(kind, key) !== null;
}

/** How the .at's value widens the file's: what it adds or drops, or why it cannot be compared. */
export type Widening =
  | { added: string[] }
  | { dropped: string[] }
  | { from: string; to: string }
  | { unranked: { at: string; file: string } }
  | { incomparable: true };

/** The server an MCP wildcard names (`mcp__x__*` or `mcp__x`), or null. */
function wildcardServer(t: string): string | null {
  const star = /^mcp__(.+)__\*$/.exec(t);
  if (star) return star[1];
  const bare = /^mcp__(.+)$/.exec(t);
  if (bare && !bare[1].includes("__")) return bare[1];
  return null;
}

/** Whether `f` grants or denies everything `e` does. */
function covers(f: string, e: string): boolean {
  if (f === e || f === "*") return true;
  // The docs' entry for every MCP tool from any server.
  if (f === "mcp__*") return e.startsWith("mcp__");
  const server = wildcardServer(f);
  if (server !== null) return e === `mcp__${server}` || e.startsWith(`mcp__${server}__`);
  if (!f.includes("(") && !f.startsWith("mcp__")) return e.startsWith(`${f}(`);
  return false;
}

const wholeTool = (t: string) => t.replace(/\(.*$/s, "");

/** Entries of `a` that no entry of `b` covers. */
const uncovered = (a: string[], b: string[]) => a.filter((e) => !b.some((f) => covers(f, e)));

const MODE_CHAIN = ["dontAsk", "default", "acceptEdits", "auto", "bypassPermissions"];
const KNOWN_MODES = new Set([...MODE_CHAIN, "plan"]);

/** Whether mode `a` runs nothing without asking that `b` would not ("inherit" is an omitted mode). */
function modeAtMost(a: string, b: string): boolean {
  if (a === b || b === "bypassPermissions") return true;
  if (b === "inherit") return a === "dontAsk";
  if (a === "plan") return b === "auto";
  const i = MODE_CHAIN.indexOf(a);
  const j = MODE_CHAIN.indexOf(b);
  return i !== -1 && j !== -1 && i <= j;
}

const isBlock = (v: FieldValue | undefined) => v !== undefined && typeof v === "object" && !Array.isArray(v);

/**
 * How the .at's value `at` would widen the file's `file` for this key, or
 * null when it grants nothing more (equal or narrower) or the key is not a
 * capability key.
 */
export function widening(kind: string, key: string, file: FieldValue | undefined, at: FieldValue): Widening | null {
  if (kind !== "agent" && kind !== "skill" && kind !== "command") return null;
  const rule = ruleOf(kind, key);
  if (rule === null) return null;

  if (rule === "mode") {
    if (isBlock(at) || Array.isArray(at) || isBlock(file) || Array.isArray(file)) return { incomparable: true };
    const norm = (v: string) => (v.trim() === "manual" ? "default" : v.trim());
    const a = norm(at as string);
    const f = file === undefined || (file as string).trim() === "" ? "inherit" : norm(file as string);
    if (modeAtMost(a, f)) return null;
    const shownFile = f === "inherit" ? "(absent: the session's)" : f;
    if (!KNOWN_MODES.has(a) || (f !== "inherit" && !KNOWN_MODES.has(f)) || !modeAtMost(f, a)) {
      return { unranked: { at: a, file: shownFile } };
    }
    return { from: shownFile, to: a };
  }

  if (isBlock(at) || isBlock(file)) return { incomparable: true };
  const atList = toolList(at as string | string[]);
  const fileList = file === undefined ? null : toolList(file as string | string[]);

  switch (rule) {
    case "allow-omitted-all": {
      if (fileList === null) return null; // omitted: every tool, nothing is wider
      const added = uncovered(atList, fileList);
      return added.length > 0 ? { added } : null;
    }
    case "grant":
    case "servers": {
      const added = uncovered(atList, fileList ?? []);
      return added.length > 0 ? { added } : null;
    }
    case "deny":
    case "deny-whole-tool": {
      const norm = rule === "deny-whole-tool" ? (l: string[]) => [...new Set(l.map(wholeTool))] : (l: string[]) => l;
      const dropped = uncovered(norm(fileList ?? []), norm(atList));
      return dropped.length > 0 ? { dropped } : null;
    }
  }
}

/** The line scaffold prints for a kept key, and the drift row's detail. */
export function keptWideningNote(key: string, w: Widening): string {
  const force = "; --force applies the .at's";
  if ("added" in w) return `${key} kept as written: the .at would widen them (${w.added.map((t) => `+${t}`).join(", ")})${force}`;
  if ("dropped" in w) {
    return `${key} kept as written: the .at would widen access by denying less (${w.dropped.map((t) => `-${t}`).join(", ")})${force}`;
  }
  if ("from" in w) return `${key} kept as written: the .at would widen it (${w.from} → ${w.to})${force}`;
  if ("unranked" in w) {
    return `${key} kept as written: the .at's ${w.unranked.at} cannot be ranked against the file's ${w.unranked.file}, so it counts as wider${force}`;
  }
  return `${key} kept as written: the .at's value cannot be compared with the file's, so it counts as wider${force}`;
}
