/**
 * The check behind an agent's `deny` and `ask` rules on claude-code (S-19).
 * The frontmatter hook has the rule's tool as matcher and no `if:`;
 * `agent-rule.sh` reads the PreToolUse input and decides.
 *
 * Bash rules are not here: an agent deny or ask on Bash is refused before
 * scaffold writes anything (ruling c). Three attacks found that a hook
 * re-implementing bash's tokenizer fails open (heredoc quotes, ANSI-C quotes,
 * `${...#}`); settings { deny } is the place for a Bash rule.
 *
 * Anything in doubt is denied, and an ask asks. The script passes (exit 0, no
 * output) only when it read the call with certainty and the rule does not
 * match it. An agent hook is a guardrail, not a security boundary: the agent
 * can edit the files that hold it.
 *
 * The decision is one jq program:
 * - a bare tool, `Tool(*)`, a tool-name glob: every call the matcher lets in;
 * - `Tool(param:value)`: tool_input must be an object; a field the call leaves
 *   out never matches; a field that is not a single value is doubt;
 * - `Agent(name)`: tool_input.subagent_type ("Type of specialized agent to
 *   use", hooks reference) must be a string; it matches when equal;
 * - `WebFetch(domain:...)`: the host is read with certainty or the call is
 *   denied: scheme http or https, then an authority with no `\`, `%`,
 *   non-ASCII, control character, whitespace or second `@`. "Matching is
 *   case-insensitive" and strips a trailing dot; `domain:x` matches x only,
 *   `*.x` any subdomain but not x, `*` every host (permissions docs).
 * Everything else cannot be matched and is refused (or asked): path rules
 * (how a path pattern anchors in an agent file is undocumented), PowerShell
 * and Monitor commands, and any other specifier.
 *
 * @module
 */

import type { PermissionRule } from "../../parser/permission-rule.js";
import { matchesWholeTool, paramName, COMMAND_TOOLS } from "../../parser/permission-rule.js";

/** How the script checks one rule: its kind and the arguments the script reads. */
export interface RuleCheck {
  kind: "all" | "param" | "agent" | "domain" | "none";
  args: string[];
  /** none: why the rule cannot be matched. */
  reason?: string;
}

/** Escape a literal for an Oniguruma (jq) regex. */
const esc = (lit: string) => lit.replace(/[\\.^$|?+*()[\]{}]/g, "\\$&");

/** A parameter pattern as an anchored regex: `*` any text, otherwise exact. */
function valueRegex(p: string): string {
  return `^${p.split("*").map(esc).join(".*")}$`;
}

/** A WebFetch domain pattern as an anchored regex on the lower-cased host. */
function domainRegex(d: string): string {
  if (d === "*") return "^.+$";
  // "`*.example.com` matches any subdomain at any depth ... but not `example.com` itself";
  // elsewhere "the wildcard matches only the text between two dots".
  const sub = d.startsWith("*.");
  const rest = (sub ? d.slice(2) : d).split("*").map(esc).join("[^.]*");
  return `^${sub ? "([^.]+\\.)+" : ""}${rest}$`;
}

/** What the script does for a rule (Bash rules never get here: they are refused). */
export function ruleCheck(rule: PermissionRule): RuleCheck {
  const cannot = (why: string): RuleCheck => ({ kind: "none", args: [], reason: `the hook cannot match this rule: ${why}` });
  if (rule.tool === "Bash") return cannot("an agent hook can't parse bash safely; use settings { deny }");
  if (rule.specifier === undefined || rule.tool.includes("*") || matchesWholeTool(rule)) return { kind: "all", args: [] };
  if (rule.form === "param") {
    const name = paramName(rule)!;
    const value = rule.specifier.slice(rule.specifier.indexOf(":") + 1).trim();
    return { kind: "param", args: [name, valueRegex(value)] };
  }
  if (rule.form === "domain") {
    const d = rule.specifier.slice(rule.specifier.indexOf(":") + 1).trim().toLowerCase().replace(/\.$/, "");
    return { kind: "domain", args: [domainRegex(d)] };
  }
  if (rule.form === "agent") return { kind: "agent", args: [rule.specifier.trim()] };
  if (rule.form === "path") return cannot(`path rules are not matched; how a path pattern anchors in an agent file is not documented`);
  if (COMMAND_TOOLS.has(rule.tool)) return cannot(`only rules on other tools are matched, not ${rule.tool} commands`);
  return cannot(`the ${rule.tool}(...) form is not matched`);
}

/**
 * The jq program: reads the PreToolUse input, prints PASS, MATCH:<why> or
 * DOUBT:<why>. No single quote may appear in it (it sits in a single-quoted
 * shell string), and no line may end inside a string (every line gets " #").
 */
const PROG = [
  "def doubt($r): \"DOUBT:\" + $r;",
  "def hit($r): \"MATCH:\" + $r;",
  "def paramcheck($name; $re):",
  "  (.tool_input) as $i",
  "  | if ($i | type) != \"object\" then doubt(\"the hook input has no tool_input object\")",
  "    elif ($i | has($name) | not) or $i[$name] == null then \"PASS\"",
  "    elif ([\"string\", \"number\", \"boolean\"] | index([$i[$name] | type])) == null then doubt(\"the input field \" + $name + \" is not a single value\")",
  "    elif ($i[$name] | tostring | test($re)) then hit(\"the input field \" + $name + \" matches\")",
  "    else \"PASS\" end;",
  "def agentcheck($name):",
  "  (.tool_input) as $i",
  "  | if ($i | type) != \"object\" then doubt(\"the hook input has no tool_input object\")",
  "    elif ($i.subagent_type | type) != \"string\" then doubt(\"the hook input names no subagent_type\")",
  "    elif $i.subagent_type == $name then hit(\"the subagent matches\")",
  "    else \"PASS\" end;",
  "def domaincheck($re):",
  "  (.tool_input) as $i",
  "  | if ($i | type) != \"object\" then doubt(\"the hook input has no tool_input object\")",
  "    elif ($i.url | type) != \"string\" then doubt(\"the hook input has no url to check\")",
  "    else ([$i.url | capture(\"^(?<s>[A-Za-z][A-Za-z0-9+.-]*)://(?<r>.*)$\")] | first) as $p",
  "      | if $p == null then doubt(\"the url has no scheme followed by ://\")",
  "        elif ([\"http\", \"https\"] | index([$p.s | ascii_downcase])) == null then doubt(\"the url scheme is not http or https\")",
  "        else ($p.r | split(\"/\")[0] | split(\"?\")[0] | split(\"#\")[0]) as $auth",
  "          | if ($auth | test(\"[^\\u0021-\\u007e]\")) or ($auth | test(\"[\\\\\\\\%]\")) then doubt(\"the url host could not be read with certainty\")",
  "            elif ($auth | split(\"@\") | length) > 2 then doubt(\"the url holds a second @\")",
  "            else ($auth | split(\"@\") | last) as $hp",
  "              | (if ($hp | startswith(\"[\")) then $hp",
  "                 else ($hp | split(\":\")) as $parts",
  "                   | if ($parts | length) > 2 then null",
  "                     elif ($parts | length) == 2 and ($parts[1] | test(\"^[0-9]*$\") | not) then null",
  "                     else $parts[0] end end) as $h",
  "              | if $h == null or $h == \"\" then doubt(\"the url host could not be read with certainty\")",
  "                elif ($h | ascii_downcase | sub(\"\\\\.$\"; \"\") | test($re)) then hit(\"the url host matches\")",
  "                else \"PASS\" end end end end;",
  "",
  "if type != \"object\" then doubt(\"the hook input is not a JSON object\")",
  "elif $kind == \"param\" then paramcheck($a1; $a2)",
  "elif $kind == \"agent\" then agentcheck($a1)",
  "elif $kind == \"domain\" then domaincheck($a1)",
  "else doubt(\"unknown rule kind \" + $kind) end",
];

// The program sits in a single-quoted shell string: one quote would end it.
if (PROG.some((l) => l.includes("'"))) throw new Error("agent-rule jq program holds a single quote");

/** The generated script, one per topology. */
export function agentRuleScript(path: string): { path: string; content: string; category: "script"; executable: true } {
  const shell = [
    "#!/usr/bin/env bash",
    "# An agent's deny or ask rule, checked against the PreToolUse input on stdin.",
    "# Auto-generated by agentopology scaffold (S-19). Usage:",
    "#   agent-rule.sh deny|ask AGENT RULE KIND [ARGS...]",
    "# KIND: all | none REASON | param NAME RE | agent NAME | domain RE",
    "# Anything in doubt is denied, and an ask asks; a call it read with certainty",
    "# that the rule does not match passes (exit 0, nothing printed).",
    "# An agent hook is a guardrail, not a security boundary: the agent can edit",
    "# the files that hold it. For a hard deny, use settings { deny }.",
    "# Every line ends in a comment so a CRLF checkout cannot change what it does.",
    "set -u",
    "MODE=${1-} AGENT=${2-} RULE=${3-} KIND=${4-}",
    "DONE=0",
    "json_str() {",
    "  local s=$1",
    "  s=${s//\\\\/\\\\\\\\}; s=${s//\\\"/\\\\\\\"}; s=${s//$'\\n'/\\\\n}; s=${s//$'\\r'/\\\\r}; s=${s//$'\\t'/\\\\t}",
    "  printf '\"%s\"' \"$s\"",
    "}",
    "decide() {",
    "  DONE=1",
    "  if [ \"$MODE\" = ask ]; then",
    "    printf '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"ask\",\"permissionDecisionReason\":%s}}\\n' \"$(json_str \"agent $AGENT asks before $RULE: $1\")\"",
    "    exit 0",
    "  fi",
    "  echo \"Refused: agent $AGENT denies $RULE: $1\" >&2",
    "  exit 2",
    "}",
    "pass() { DONE=1; exit 0; }",
    "trap 'rc=$?; [ \"$DONE\" = 1 ] || decide \"the check failed to run (exit $rc)\"' EXIT",
    '[ "$MODE" = deny ] || [ "$MODE" = ask ] || { MODE=deny; decide "the hook was called without deny or ask"; }',
    '[ "$#" -ge 4 ] || decide "the hook was called without a rule"',
    "shift 4",
    "case $KIND in",
    '  all) decide "it covers every call of this tool" ;;',
    '  none) decide "${1-the hook cannot match this rule}" ;;',
    "  param|agent|domain) ;;",
    '  *) decide "the hook cannot match this rule: unknown kind $KIND" ;;',
    "esac",
    'command -v jq >/dev/null 2>&1 || decide "jq is required to check this rule and is not installed"',
    "PROG='",
    ...PROG,
    "'",
    'VERDICT=$(jq -r --arg kind "$KIND" --arg a1 "${1-}" --arg a2 "${2-}" "$PROG" 2>/dev/null) || decide "the hook input is not valid JSON or could not be checked"',
    'case "$VERDICT" in',
    "  PASS) pass ;;",
    '  MATCH:*) decide "${VERDICT#MATCH:}" ;;',
    '  DOUBT:*) decide "${VERDICT#DOUBT:}" ;;',
    '  *) decide "the check gave no verdict" ;;',
    "esac",
  ];
  // Every line ends inside a comment, so a CR that a CRLF checkout adds lands
  // in a comment (bash and jq; jq does not take a CR as space), never in code.
  // An empty line becomes "#".
  const content = shell.map((l) => (l === "" ? "#" : l.startsWith("#") ? l : `${l} #`)).join("\n") + "\n";
  return { path, content, category: "script", executable: true };
}
