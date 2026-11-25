/**
 * The refusal event (EXPERIMENTAL: may change before 1.0).
 *
 * When a topology opts in (`meta { refusal-events: true }`, or a loaded plugin that declares
 * `reads: ["refusals"]`), every generated claude-code script that can refuse (exit 2) first appends
 * one JSON line to {@link REFUSAL_EVENT_FILE}: {v, ts, guard, gate, rule, tool, reason}.
 *
 * The append is a function the script defines near its top, and each `exit 2` calls it first:
 * `{ at_refusal_event 2>/dev/null || :; exit 2; }`. The function's own write is
 * `{ printf … >> "$LOG"; } 2>/dev/null || true`, so a failed append (a folder that cannot be made,
 * a full disk, a file that cannot be opened) changes nothing: the script still exits 2. Nothing
 * in the line comes from the refused call's text: `reason` is a fixed label, `tool` is the tool name,
 * `gate` and `guard` are ids the topology wrote.
 *
 * Without the opt-in this module is never called and every generated file is what it was.
 */

import type { GeneratedFile } from "../types.js";
import { shellQuote } from "./guards.js";
// (the type lives next to the bindings, one folder up)

/** Where the event lines go, relative to the project root. Fixed. */
export const REFUSAL_EVENT_FILE = ".claude/agentopology/events/refusals.jsonl";

/** The shell function a script defines. `$GUARD_NAME` is the script's own file name. */
function eventFunction(guard: string, rules: Record<string, string> = {}): string[] {
  const ruled = Object.entries(rules).filter(([id]) => /^[A-Za-z0-9_.:@/-]+$/.test(id));
  // Each gate that states a rule maps to the rule as a ready JSON string; any other gate writes null.
  const ruleCase = ruled.length
    ? [
        '  case "$GATE" in',
        ...ruled.map(([id, rule]) => `    ${id}) RULE=${shellQuote(JSON.stringify(rule))};;`),
        "    *) RULE=null;;",
        "  esac",
      ]
    : [];
  // The gate: a gate-<id>.sh wrapper is its gate's; deny() in the other guards sets AT_GATE.
  const gate = /^gate-(.+)\.sh$/.exec(guard)?.[1];
  const clean = "tr -cd 'A-Za-z0-9_.:@/-'";
  return [
    // One line per refusal: only the outermost guard writes. A guard that another guard runs (a gate's wrapper) sees the marker and stays silent; the guard that ran it writes.
    '[ -n "${AT_REFUSAL_OUTER:-}" ] || { AT_OUTERMOST=1; export AT_REFUSAL_OUTER=1; }',
    "at_refusal_event() {",
    '  [ "${AT_OUTERMOST:-}" = 1 ] || return 0',
    `  local LOG="\${CLAUDE_PROJECT_DIR:-.}/${REFUSAL_EVENT_FILE}" TS GATE TOOL REASON`,
    "  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) || TS=''",
    `  GATE=$(printf '%s' ${gate ? `'${gate.replace(/[^A-Za-z0-9_.:@/-]/g, "")}'` : '"${AT_GATE:-}"'} | ${clean})`,
    `  TOOL=$(printf '%s' "\${AT_TOOL_NAME:-$(printf '%s' "\${INPUT:-}" | jq -r '.tool_name // ""' 2>/dev/null)}" | ${clean})`,
    `  REASON=refused; [ -n "$GATE" ] && REASON="a gate refused the call"`,
    '  { mkdir -p "${LOG%/*}"; } 2>/dev/null || true',
    ...(ruled.length ? ["  local RULE=null", ...ruleCase] : []),
    ruled.length
      ? `  { printf '{"v":1,"ts":"%s","guard":"%s","gate":%s,"rule":%s,"tool":"%s","reason":"%s"}\\n' "$TS" ${JSON.stringify(guard)} "$([ -n "$GATE" ] && printf '"%s"' "$GATE" || printf null)" "$RULE" "$TOOL" "$REASON" >> "$LOG"; } 2>/dev/null || true`
      : `  { printf '{"v":1,"ts":"%s","guard":"%s","gate":%s,"rule":null,"tool":"%s","reason":"%s"}\\n' "$TS" ${JSON.stringify(guard)} "$([ -n "$GATE" ] && printf '"%s"' "$GATE" || printf null)" "$TOOL" "$REASON" >> "$LOG"; } 2>/dev/null || true`,
    "  return 0",
    "}",
  ];
}

const EXIT_2 = /(^|[\s;&|{(])exit 2(?![0-9A-Za-z_])/g;

/**
 * A generated script with the refusal event added: the function after the shebang, each `exit 2`
 * (outside a comment line) preceded by the append, and `deny()` noting its gate. A file that
 * is not a shell script, is a stub for the user to write, or never exits 2 is returned as it is.
 */
export function withRefusalEvent(file: GeneratedFile, rules: Record<string, string> = {}): GeneratedFile {
  if (!file.path.endsWith(".sh") || file.stub || !file.content.startsWith("#!") || !/\bexit 2\b/.test(file.content)) return file;
  const guard = file.path.slice(file.path.lastIndexOf("/") + 1);
  const nl = file.content.indexOf("\n");
  if (nl < 0) return file;
  const head = file.content.slice(0, nl + 1);
  const body = file.content
    .slice(nl + 1)
    .split("\n")
    .map((line) => {
      if (/^\s*#/.test(line)) return line;
      return line
        .replace(/\bdeny\(\) \{ /g, 'deny() { AT_GATE="$1"; ')
        .replace(EXIT_2, "$1{ at_refusal_event 2>/dev/null || :; exit 2; }");
    })
    .join("\n");
  return { ...file, content: `${head}${eventFunction(guard, rules).join("\n")}\n${body}` };
}
