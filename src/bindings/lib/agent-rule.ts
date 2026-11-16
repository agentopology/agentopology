/**
 * The check behind an agent's `deny` and `ask` rules on claude-code (S-19,
 * manager conditions C and 1, rulings R1-R14). The frontmatter hook has the
 * rule's tool as matcher and no `if:` (R6): `agent-rule.sh` reads the
 * PreToolUse input and decides.
 *
 * Anything in doubt is DENIED, and an ask asks (R5 a). It passes (exit 0, no
 * output) only when it read the call with certainty and the rule does not
 * match it. An agent hook is a guardrail, not a security boundary: the agent
 * can edit the files that hold it (R7).
 *
 * The whole decision is one jq program, so no shell loop walks the input:
 * - Bash: the command is read as bash reads it: single, double and ANSI-C
 *   quotes, backslashes, `$( )`, backticks, `<( )` / `>( )` (their commands are
 *   checked too), redirections with fd numbers (`2>&1`, `&>`, `2>>`, one at the
 *   start of a command) dropped with their targets, `#` comments, and the
 *   separators `;` `&` `|` `&&` `||` `|&` newlines and parentheses. A heredoc
 *   body is not parsed: its lines are read as commands (over-blocking). Each
 *   command drops its leading assignments (quoted, escaped or `+=`), reserved
 *   words, and the wrappers Claude Code strips when they carry no unusual
 *   flags (nice, nohup, command, builtin, noglob, timeout, stdbuf). Then:
 *   DOUBT when the command word holds `$`, a substitution, a glob, a brace, a
 *   backslash, a `~`, or a `/`; when it is eval, exec, env, sudo, doas, xargs,
 *   time, source, `.`, alias, trap, function, coproc, watch, setsid, ionice,
 *   flock, busybox, chroot, su and the like; a shell (sh, bash, zsh, dash, ...:
 *   `-c`, a pipe into it, `<<<`); an interpreter given code (`python -c`,
 *   `perl -e`, `node -e`, ...); find with -exec/-execdir/-ok/-okdir; a
 *   function definition `f()`; and an argument holding an expansion where the
 *   words before it are the rule's. MATCH when the command's words, joined by
 *   one space, match the rule ("A `*` in a Bash rule matches any text";
 *   "A `*` at the end, with a space before it, also matches the bare
 *   command"). Unterminated quotes or substitutions, and NUL, are doubt.
 * - `Tool(param:value)`: tool_input must be an object (R8); a field the call
 *   leaves out never matches; a field that is not a single value is doubt.
 * - `Agent(name)`: tool_input.subagent_type ("Type of specialized agent to use",
 *   hooks reference) must be a string; it matches when equal.
 * - `WebFetch(domain:...)`: the host is read with certainty or the call is
 *   denied (R3): scheme http or https, then an authority with no `\`, `%`,
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
  kind: "all" | "bash" | "param" | "agent" | "domain" | "none";
  args: string[];
  /** none: why the rule cannot be matched. */
  reason?: string;
}

/** Escape a literal for an Oniguruma (jq) regex. */
const esc = (lit: string) => lit.replace(/[\\.^$|?+*()[\]{}]/g, "\\$&");

/** A Claude Code Bash or parameter pattern as an anchored regex. */
function patternRegex(p: string): string {
  // "A `*` at the end, with a space before it, also matches the bare command" (only wildcard).
  if (p.endsWith(" *") && p.indexOf("*") === p.length - 1) return `^${esc(p.slice(0, -2))}( .*)?$`;
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
    const d = rule.specifier.slice(rule.specifier.indexOf(":") + 1).trim().toLowerCase().replace(/\.$/, "");
    return { kind: "domain", args: [domainRegex(d)] };
  }
  if (rule.form === "agent") return { kind: "agent", args: [rule.specifier.trim()] };
  if (rule.tool === "Bash" && rule.form === "command") {
    let p = unquote(rule.specifier).replace(/\s+/g, " ").trim();
    if (p.endsWith(":*")) p = `${p.slice(0, -2)} *`;
    // The rule's whole literal words before its first `*` (a partial word is left out).
    const lit = p.includes("*") ? p.slice(0, p.indexOf("*")) : `${p} `;
    const words = lit.split(" ").slice(0, -1).filter((w) => w !== "");
    return { kind: "bash", args: [patternRegex(p), JSON.stringify(words), p.startsWith("*") ? "1" : "0"] };
  }
  if (rule.form === "path") return cannot(`path rules are not matched; how a path pattern anchors in an agent file is not documented`);
  if (COMMAND_TOOLS.has(rule.tool)) return cannot(`only Bash command rules are matched, not ${rule.tool}`);
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
  "def first_verdict: (map(select(. != \"PASS\")) | first) // \"PASS\";",
  "",
  "# ---- the shell reader: a state machine over the characters of the command",
  "def nw: {t: \"\", q: false, x: false, g: false, b: false, bs: false, tl: false};",
  "def frame($k): {k: $k, m: \"n\", w: null, ws: [], op: null, redir: false, pend: \"\", esc: false};",
  "def cur: .f[(.f | length) - 1];",
  "def setcur(f): ((.f | length) - 1) as $i | .f[$i] |= f;",
  "def ensure: setcur(if .w == null then .w = nw else . end);",
  "def addc($c): ensure | setcur(.w.t += $c);",
  "def flag($k): ensure | setcur(.w[$k] = true);",
  "def endword: setcur(if .w == null then . elif .redir then .w = null | .redir = false else .ws += [.w] | .w = null end);",
  "def endcmd: endword | (cur.ws) as $ws | (if ($ws | length) > 0 then .out += [$ws] else . end) | setcur(.ws = []);",
  "def push($k): .f += [frame($k)];",
  "def pop: endcmd | .f |= .[:-1];",
  "def redir_start($c):",
  "  (cur.w) as $w",
  "  | (if $w != null and ($w.q | not) and ($w.x | not) and ($w.bs | not) and ($w.t | test(\"^[0-9]+$\")) then setcur(.w = null) else endword end)",
  "  | setcur(.op = $c);",
  "def nchar($c):",
  "  if cur.esc then setcur(.esc = false) | (if $c == \"\\n\" then . else addc($c) | flag(\"bs\") end)",
  "  elif $c == \"\\\\\" then ensure | setcur(.esc = true)",
  "  elif $c == \"\\u0027\" then flag(\"q\") | setcur(.m = \"sq\")",
  "  elif $c == \"\\\"\" then flag(\"q\") | setcur(.m = \"dq\")",
  "  elif $c == \"$\" then flag(\"x\") | addc(\"$\") | setcur(.pend = \"$\")",
  "  elif $c == \"`\" then (if cur.k == \"bt\" then pop else flag(\"x\") | push(\"bt\") end)",
  "  elif $c == \"(\" then (if cur.w != null then .err = \"a function definition or a parenthesis inside a word\" else endcmd end)",
  "  elif $c == \")\" then (if cur.k == \"sub\" or cur.k == \"proc\" then pop else endcmd end)",
  "  elif $c == \" \" or $c == \"\\t\" or $c == \"\\r\" then endword",
  "  elif $c == \"\\n\" or $c == \";\" or $c == \"|\" then endcmd",
  "  elif $c == \"&\" then endword | setcur(.pend = \"&\")",
  "  elif $c == \"<\" or $c == \">\" then redir_start($c)",
  "  elif $c == \"#\" and cur.w == null then setcur(.m = \"cmt\")",
  "  elif $c == \"*\" or $c == \"?\" or $c == \"[\" then addc($c) | flag(\"g\")",
  "  elif $c == \"{\" then addc($c) | flag(\"b\")",
  "  elif $c == \"~\" and cur.w == null then flag(\"tl\") | addc($c)",
  "  else addc($c) end;",
  "def dqchar($c):",
  "  if cur.esc then setcur(.esc = false) | (if $c == \"\\n\" then . elif ($c == \"$\" or $c == \"`\" or $c == \"\\\"\" or $c == \"\\\\\") then addc($c) else addc(\"\\\\\" + $c) end)",
  "  elif $c == \"\\\\\" then setcur(.esc = true)",
  "  elif $c == \"\\\"\" then setcur(.m = \"n\")",
  "  elif $c == \"$\" then flag(\"x\") | addc(\"$\") | setcur(.pend = \"$\")",
  "  elif $c == \"`\" then flag(\"x\") | push(\"bt\")",
  "  else addc($c) end;",
  "def step($c):",
  "  if .err != null then .",
  "  elif cur.op != null then",
  "    (if $c == \"<\" or $c == \">\" or $c == \"&\" or $c == \"|\" or ($c == \"-\" and (cur.op | test(\"(<<|&)$\"))) then setcur(.op += $c)",
  "     else (cur.op) as $op | setcur(.op = null)",
  "       | (if $c == \"(\" and ($op == \"<\" or $op == \">\") then flag(\"x\") | push(\"proc\") else setcur(.redir = true) | step($c) end) end)",
  "  elif cur.pend == \"$\" then setcur(.pend = \"\") | (if $c == \"(\" then push(\"sub\") elif $c == \"\\u0027\" then setcur(.m = \"sq\") else step($c) end)",
  "  elif cur.pend == \"&\" then setcur(.pend = \"\") | (if $c == \">\" then setcur(.op = \"&>\") else endcmd | step($c) end)",
  "  elif cur.m == \"sq\" then (if $c == \"\\u0027\" then setcur(.m = \"n\") else addc($c) end)",
  "  elif cur.m == \"dq\" then dqchar($c)",
  "  elif cur.m == \"cmt\" then (if $c == \"\\n\" then setcur(.m = \"n\") | endcmd else . end)",
  "  else nchar($c) end;",
  "def lex:",
  "  reduce (explode[] | [.] | implode) as $c ({f: [frame(\"top\")], out: [], err: null}; step($c))",
  "  | if .err != null then .",
  "    elif (.f | length) > 1 or cur.m == \"sq\" or cur.m == \"dq\" or cur.esc then .err = \"its quoting or nesting could not be read\"",
  "    else (if cur.pend == \"&\" then setcur(.pend = \"\") else . end) | (if cur.op != null then setcur(.op = null | .redir = true) else . end) | endcmd end;",
  "",
  "# ---- one simple command: strip what runs another command, then decide",
  "def plain($w): ($w.x | not) and ($w.g | not) and ($w.b | not) and ($w.bs | not) and ($w.tl | not);",
  "def isflag: .t | startswith(\"-\");",
  "def DOUBTWORDS: [\"eval\", \"exec\", \"env\", \"sudo\", \"doas\", \"xargs\", \"time\", \"source\", \".\", \"alias\", \"unalias\", \"trap\", \"function\", \"coproc\", \"watch\", \"setsid\", \"ionice\", \"flock\", \"busybox\", \"chroot\", \"su\", \"runuser\", \"nsenter\", \"unshare\", \"systemd-run\", \"parallel\", \"fakeroot\", \"proot\", \"torsocks\", \"strace\", \"ltrace\", \"script\", \"expect\", \"enable\", \"declare\", \"typeset\", \"export\", \"readonly\", \"local\", \"let\", \"mapfile\", \"readarray\", \"bind\", \"complete\", \"fc\", \"history\", \"hash\"];",
  "def SHELLS: [\"sh\", \"bash\", \"zsh\", \"dash\", \"ksh\", \"mksh\", \"ash\", \"fish\", \"csh\", \"tcsh\", \"yash\", \"rbash\"];",
  "def SKIPWORDS: [\"!\", \"{\", \"}\", \"if\", \"then\", \"elif\", \"else\", \"fi\", \"while\", \"until\", \"do\", \"done\", \"builtin\", \"noglob\"];",
  "def timeout_rest:",
  "  if length == 0 then null",
  "  elif (.[0].t == \"-s\" or .[0].t == \"-k\") and length > 1 then .[2:] | timeout_rest",
  "  elif (.[0].t | test(\"^(--signal=|--kill-after=|-s.|-k.)\")) or .[0].t == \"--foreground\" or .[0].t == \"--preserve-status\" then .[1:] | timeout_rest",
  "  elif (.[0].t | test(\"^[0-9]+(\\\\.[0-9]+)?[smhd]?$\")) then .[1:]",
  "  else null end;",
  "def stdbuf_rest:",
  "  if length == 0 then null",
  "  elif (.[0].t == \"-i\" or .[0].t == \"-o\" or .[0].t == \"-e\") and length > 1 then .[2:] | stdbuf_rest",
  "  elif (.[0].t | test(\"^(-[ioe].+|--(input|output|error)=.+)$\")) then .[1:] | stdbuf_rest",
  "  else . end;",
  "def strip:",
  "  if length == 0 then {ws: [], d: null}",
  "  else (.[0].t) as $t",
  "    | if ($t | test(\"^[A-Za-z_][A-Za-z0-9_]*\\\\+?=\")) then .[1:] | strip",
  "      elif (SKIPWORDS | index([$t])) != null then .[1:] | strip",
  "      elif $t == \"for\" or $t == \"select\" or $t == \"case\" or $t == \"in\" or $t == \"esac\" then {ws: [], d: null}",
  "      elif $t == \"nice\" or $t == \"nohup\" or $t == \"command\" then (if length > 1 and (.[1] | isflag) then {ws: ., d: ($t + \" with flags can run another command\")} else .[1:] | strip end)",
  "      elif $t == \"timeout\" then ((.[1:] | timeout_rest) as $r | if $r == null then {ws: ., d: \"timeout with unusual flags\"} else $r | strip end)",
  "      elif $t == \"stdbuf\" then ((.[1:] | stdbuf_rest) as $r | if $r == null or (($r | length) > 0 and ($r[0] | isflag)) then {ws: ., d: \"stdbuf with unusual flags\"} else $r | strip end)",
  "      else {ws: ., d: null} end end;",
  "def command_verdict($re; $lit; $star):",
  "  (strip) as $s",
  "  | if $s.d != null then doubt($s.d)",
  "    elif ($s.ws | length) == 0 then \"PASS\"",
  "    else $s.ws as $ws | $ws[0] as $cw | ($cw.t) as $t",
  "      | if $cw.x then doubt(\"the command word holds an expansion or a substitution\")",
  "        elif $cw.g and $t != \"[\" and $t != \"[[\" then doubt(\"the command word holds a glob\")",
  "        elif $cw.b then doubt(\"the command word holds a brace\")",
  "        elif $cw.bs then doubt(\"the command word holds a backslash\")",
  "        elif $cw.tl or ($t | contains(\"/\")) then doubt(\"the command word is a path\")",
  "        elif (DOUBTWORDS | index([$t])) != null then doubt($t + \" can run another command\")",
  "        elif (SHELLS | index([$t])) != null then doubt(\"a shell runs its arguments or input as commands\")",
  "        elif ($t | test(\"^(python[0-9.]*|pypy[0-9.]*|perl[0-9.]*|ruby|node|nodejs|php|deno|bun|osascript|lua|Rscript)$\")) and ($ws[1:] | any(.t | test(\"^(-c|-e|-E|--eval|-r|-p|--run|-x)$|^-[a-zA-Z]*[ce]$\"))) then doubt(\"an interpreter is given code to run\")",
  "        elif $t == \"find\" and ($ws[1:] | any(.t == \"-exec\" or .t == \"-execdir\" or .t == \"-ok\" or .t == \"-okdir\")) then doubt(\"find runs another command\")",
  "        elif ($ws | any(.t | test(\"\\\\[[^\\\\]]*(\\\\$\\\\(|`)\"))) then doubt(\"a word holds an array subscript with a substitution, which bash can evaluate\")",
  "        elif ($ws | map(.t) | join(\" \") | gsub(\"[\\u0000-\\u001f]\"; \" \") | test($re)) then hit(\"the command matches\")",
  "        elif $star and ($ws | any(plain(.) | not)) then doubt(\"an argument holds an expansion that could make it match\")",
  "        elif [range(1; $ws | length) | select((plain($ws[.]) | not) and ([range(0; [., ($lit | length)] | min)] | all(. as $j | $ws[$j].t == $lit[$j])))] | length > 0 then doubt(\"an argument holds an expansion that could make it match\")",
  "        else \"PASS\" end end;",
  "def bashcheck($re; $lit; $star):",
  "  (.tool_input) as $i",
  "  | if ($i | type) != \"object\" then doubt(\"the hook input has no tool_input object\")",
  "    elif ($i.command | type) != \"string\" then doubt(\"the hook input has no command to check\")",
  "    elif ($i.command | contains(\"\\u0000\")) then doubt(\"the command holds a NUL character\")",
  "    else ($i.command | lex) as $l",
  "      | if $l.err != null then doubt(\"the command could not be read: \" + $l.err)",
  "        else [$l.out[] | command_verdict($re; $lit; $star)] | first_verdict end end;",
  "",
  "# ---- the other rule kinds",
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
  "elif $kind == \"bash\" then bashcheck($a1; ($a2 | fromjson); $a3 == \"1\")",
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
    "# KIND: all | none REASON | bash RE WORDS STAR | param NAME RE | agent NAME | domain RE",
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
    "  bash|param|agent|domain) ;;",
    '  *) decide "the hook cannot match this rule: unknown kind $KIND" ;;',
    "esac",
    'command -v jq >/dev/null 2>&1 || decide "jq is required to check this rule and is not installed"',
    "PROG='",
    ...PROG,
    "'",
    'VERDICT=$(jq -r --arg kind "$KIND" --arg a1 "${1-}" --arg a2 "${2-}" --arg a3 "${3-}" "$PROG" 2>/dev/null) || decide "the hook input is not valid JSON or could not be checked"',
    'case "$VERDICT" in',
    "  PASS) pass ;;",
    '  MATCH:*) decide "${VERDICT#MATCH:}" ;;',
    '  DOUBT:*) decide "${VERDICT#DOUBT:}" ;;',
    '  *) decide "the check gave no verdict" ;;',
    "esac",
  ];
  // R14: every line ends inside a comment, so a CR that a CRLF checkout adds
  // lands in a comment (bash and jq; jq does not take a CR as space), never in
  // code. An empty line becomes "#".
  const content = shell.map((l) => (l === "" ? "#" : l.startsWith("#") ? l : `${l} #`)).join("\n") + "\n";
  return { path, content, category: "script", executable: true };
}
