/**
 * The check behind an agent's `deny` and `ask` rules on claude-code (S-19,
 * manager condition C). The frontmatter hook keeps `if:` (the rule), but does
 * not rely on it: Claude Code calls `if` best-effort, and its use in agent
 * frontmatter is undocumented. The hook runs `agent-rule.sh`, which reads the
 * PreToolUse input from stdin and matches the rule itself.
 *
 * It FAILS CLOSED: when it cannot tell (jq missing, input not JSON, a field
 * missing or not a single value, a command substitution that could hide the
 * match, a rule form it cannot match), a deny exits 2 and an ask asks. It
 * passes (exit 0, no output) only when it read the call and the rule does not
 * match it.
 *
 * What it matches, from the Claude Code permissions docs:
 * - a bare tool, `Tool(*)`, a tool-name glob: every call the hook's matcher lets in;
 * - `Bash(pattern)`: "A `*` in a Bash rule matches any text, including spaces";
 *   "A `*` at the end, with a space before it, also matches the bare command"
 *   when it is the rule's only wildcard; `:*` at the end is the same as ` *`.
 *   The command is split at `&` `|` `;` `(` `)` backticks and newlines after its
 *   redirections are dropped (the before-action.sh reading), and each part,
 *   and the whole, is matched as written and with quotes and backslashes
 *   dropped. Leading assignments and the wrappers Claude Code strips
 *   (`timeout`, `time`, `nice`, `nohup`, `stdbuf`, `command`, `builtin`,
 *   `noglob`, bare `xargs`) are stripped, and so are `if then elif else while
 *   until do ! {` (over-matching only);
 * - `Tool(param:value)`: the top-level input field, a single value, `*` a
 *   wildcard; a field the call leaves out is never matched;
 * - `WebFetch(domain:host)`: the url's host, or any subdomain of it (the docs
 *   do not say whether subdomains match, so both are taken).
 * Everything else cannot be matched and is refused (or asked): path rules
 * (how `/path` anchors in an agent file is undocumented), `Agent(name)` (the
 * input field naming the subagent is undocumented), PowerShell and Monitor
 * commands, and any other specifier.
 *
 * @module
 */

import type { PermissionRule } from "../../parser/permission-rule.js";
import { matchesWholeTool, paramName, COMMAND_TOOLS } from "../../parser/permission-rule.js";
import { MATCH_FUNCTIONS } from "./guards.js";

/** How the script checks one rule: its kind and the arguments the script reads. */
export interface RuleCheck {
  kind: "all" | "bash" | "param" | "domain" | "none";
  args: string[];
  /** none: why the rule cannot be matched. */
  reason?: string;
}

const ERE_SPECIAL = /[\\.^$|?+()[\]{}]/g;
const ere = (lit: string) => lit.replace(ERE_SPECIAL, "\\$&");

/** A Claude Code wildcard pattern as an anchored ERE. */
function patternRegex(p: string): string {
  const star = p.indexOf("*");
  // "A `*` at the end, with a space before it, also matches the bare command" (only wildcard).
  if (star === p.length - 1 && p.endsWith(" *") && p.indexOf("*") === p.lastIndexOf("*")) {
    return `^${ere(p.slice(0, -2))}( .*)?$`;
  }
  return `^${p.split("*").map(ere).join(".*")}$`;
}

const unquote = (s: string) => s.replace(/["'\\]/g, "");

/** What the script does for a rule. */
export function ruleCheck(rule: PermissionRule): RuleCheck {
  const cannot = (why: string): RuleCheck => ({ kind: "none", args: [], reason: `the hook cannot match this rule: ${why}` });
  if (rule.specifier === undefined || rule.tool.includes("*") || matchesWholeTool(rule)) return { kind: "all", args: [] };
  if (rule.form === "param") {
    const name = paramName(rule)!;
    const value = rule.specifier.slice(rule.specifier.indexOf(":") + 1).trim();
    return { kind: "param", args: [name, patternRegex(value)] };
  }
  if (rule.form === "domain") {
    return { kind: "domain", args: [rule.specifier.slice(rule.specifier.indexOf(":") + 1).trim().toLowerCase().replace(/\.$/, "")] };
  }
  if (rule.tool === "Bash" && rule.form === "command") {
    let p = rule.specifier.replace(/\s+/g, " ").trim();
    if (p.endsWith(":*")) p = `${p.slice(0, -2)} *`;
    const lit = p.slice(0, p.includes("*") ? p.indexOf("*") : p.length).trim();
    const key = p.startsWith("*") ? "" : unquote(lit.split(" ")[0] ?? "");
    return { kind: "bash", args: [patternRegex(p), patternRegex(unquote(p)), key] };
  }
  if (rule.form === "path") return cannot(`path rules are not matched; how a path pattern anchors in an agent file is not documented`);
  if (rule.form === "agent") return cannot(`Agent(name) is not matched; the hook input field that names the subagent is not documented`);
  if (COMMAND_TOOLS.has(rule.tool)) return cannot(`only Bash command rules are matched, not ${rule.tool}`);
  return cannot(`the ${rule.tool}(...) form is not matched`);
}

/** The generated script, one per topology. */
export function agentRuleScript(path: string): { path: string; content: string; category: "script"; executable: true } {
  const lines = [
    "#!/usr/bin/env bash",
    "# An agent's deny or ask rule, checked against the PreToolUse input on stdin.",
    "# Auto-generated by agentopology scaffold (S-19). Usage:",
    "#   agent-rule.sh deny|ask AGENT RULE KIND [ARGS...]",
    "# KIND: all | none REASON | bash RE RE_UNQUOTED KEY | param NAME RE | domain HOST",
    "# Fails closed: on any doubt a deny exits 2 and an ask asks; a call it read",
    "# and the rule does not match passes (exit 0, nothing printed).",
    "set -u",
    'MODE=${1-} AGENT=${2-} RULE=${3-} KIND=${4-}',
    "DONE=0",
    "json_str() {",
    "  local s=$1",
    "  s=${s//\\\\/\\\\\\\\}; s=${s//\\\"/\\\\\\\"}; s=${s//$'\\n'/\\\\n}; s=${s//$'\\r'/\\\\r}; s=${s//$'\\t'/\\\\t}",
    "  printf '\"%s\"' \"$s\"",
    "}",
    "# decide WHY: the rule applies (or doubt): a deny refuses, an ask asks.",
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
    'case $KIND in',
    '  all) decide "it covers every call of this tool" ;;',
    '  none) decide "${1-the hook cannot match this rule}" ;;',
    '  bash|param|domain) ;;',
    '  *) decide "the hook cannot match this rule: unknown kind $KIND" ;;',
    'esac',
    'command -v jq >/dev/null 2>&1 || decide "jq is required to check this rule and is not installed"',
    'INPUT=$(cat) || decide "the hook input could not be read"',
    'printf \'%s\' "$INPUT" | jq -e \'type == "object"\' >/dev/null 2>&1 || decide "the hook input is not valid JSON"',
    "",
    ...MATCH_FUNCTIONS,
    "collapse() { local t=${1//$'\\t'/ }; t=${t//$'\\r'/ }; while [[ $t == *'  '* ]]; do t=${t//'  '/' '}; done; t=${t# }; printf '%s' \"${t% }\"; }",
    "unq() { local t=$1; t=${t//\\\"/}; t=${t//\\'/}; t=${t//\\\\/}; printf '%s' \"$t\"; }",
    "# Leading assignments and the wrappers Claude Code strips before it matches a Bash rule.",
    "RE_ASSIGN='^[A-Za-z_][A-Za-z0-9_]*=[^ ]* (.*)$'",
    "RE_TIMEOUT='^timeout(( +(-[sk]|--signal|--kill-after) +[^ ]+)|( +-[^ ]+))* +[0-9.]+[smhd]? (.*)$'",
    "RE_NICE='^nice( +-n +-?[0-9]+| +-[0-9]+| +--adjustment=[^ ]+)? (.*)$'",
    "RE_STDBUF='^stdbuf( +-[ioe] *[^ ]+| +--(input|output|error)=[^ ]+)* (.*)$'",
    "RE_WORD='^(time( +-p)?|nohup|command|builtin|noglob|if|then|elif|else|while|until|do|!|\\{) (.*)$'",
    "RE_XARGS='^xargs ([^-].*)$'",
    "strip_lead() {",
    "  local s=$1 prev='' re",
    '  while [ "$s" != "$prev" ]; do',
    "    prev=$s",
    '    for re in "$RE_ASSIGN" "$RE_TIMEOUT" "$RE_NICE" "$RE_STDBUF" "$RE_WORD" "$RE_XARGS"; do',
    '      if [[ $s =~ $re ]]; then s=${BASH_REMATCH[${#BASH_REMATCH[@]}-1]}; break; fi',
    "    done",
    "  done",
    "  printf '%s' \"$s\"",
    "}",
    "",
    'case $KIND in',
    "  bash)",
    '    RE=${1-} RE_UNQ=${2-} KEY=${3-}',
    '    CMD=$(printf \'%s\' "$INPUT" | jq -er \'.tool_input.command | strings\') || decide "the hook input has no command to check"',
    "    CMD=${CMD//$'\\\\\\n'/}",
    "    # A command substitution could hide a matching command: doubt, when it may name the rule's program.",
    "    if [[ $CMD == *'$('* || $CMD == *'`'* || $CMD == *'<('* || $CMD == *'>('* ]]; then",
    '      if [ -z "$KEY" ] || [[ $CMD == *"$KEY"* ]]; then decide "a command substitution could hide a matching command"; fi',
    "    fi",
    "    set -f",
    "    check() {",
    "      local s n",
    '      s=$(strip_lead "$(collapse "$1")")',
    '      [ -n "$s" ] || return 0',
    '      [[ $s =~ $RE ]] && decide "the command matches"',
    '      n=$(strip_lead "$(collapse "$(unq "$s")")")',
    '      [[ $n =~ $RE_UNQ ]] && decide "the command matches"',
    "      return 0",
    "    }",
    '    check "$CMD"',
    '    SEGS=$(strip_redir "$CMD")',
    "    for sep in '&' '|' ';' '(' ')' '`'; do SEGS=${SEGS//\"$sep\"/$'\\n'}; done",
    '    while IFS= read -r S || [ -n "$S" ]; do check "$S"; done <<< "$SEGS"',
    "    pass ;;",
    "  param)",
    '    NAME=${1-} RE=${2-}',
    '    T=$(printf \'%s\' "$INPUT" | jq -r --arg n "$NAME" \'(.tool_input // {}) as $i | if ($i | type) != "object" then "bad" elif ($i | has($n)) | not then "absent" else ($i[$n] | type) end\') || decide "the hook input could not be read"',
    '    case $T in',
    "      absent|null) pass ;;",
    "      string|number|boolean) ;;",
    '      *) decide "the input field $NAME is not a single value" ;;',
    "    esac",
    '    V=$(printf \'%s\' "$INPUT" | jq -r --arg n "$NAME" \'.tool_input[$n] | tostring\') || decide "the hook input could not be read"',
    '    [[ $V =~ $RE ]] && decide "the input field $NAME matches"',
    "    pass ;;",
    "  domain)",
    '    D=${1-}',
    '    URL=$(printf \'%s\' "$INPUT" | jq -er \'.tool_input.url | strings\') || decide "the hook input has no url to check"',
    '    [ "$D" = "*" ] && decide "the url matches"',
    "    RE_URL='^[A-Za-z][A-Za-z0-9+.-]*://([^/?#@]*@)?(\\[[^]]*\\]|[^/?#:]+)'",
    '    [[ $URL =~ $RE_URL ]] || decide "the url could not be read"',
    "    H=$(printf '%s' \"${BASH_REMATCH[2]}\" | tr '[:upper:]' '[:lower:]'); H=${H%.}",
    '    if [ "$H" = "$D" ] || [[ $H == *".$D" ]]; then decide "the url\'s host matches"; fi',
    "    pass ;;",
    "esac",
    'decide "the hook reached its end without a decision"',
    "",
  ];
  return { path, content: lines.join("\n"), category: "script", executable: true };
}
