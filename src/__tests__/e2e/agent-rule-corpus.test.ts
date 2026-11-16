/**
 * The agent deny/ask hook (scripts/agent-rule.sh) against a corpus of inputs,
 * each run as a real process (manager condition 1).
 *
 * One row = [rule, kind, input, expected, source, env?]:
 * - kind "deny": expected "block" (exit 2) or "pass" (exit 0, nothing printed);
 * - kind "ask": expected "ask" (exit 0, permissionDecision ask) or "pass";
 * - kind "both": the row runs as deny and as ask; "block" means deny blocks
 *   and ask asks.
 * Doubt is denied (an ask asks): over-blocking is accepted (ruling R5).
 * Sources: fable-r2-D/Q/I/NOT (hostile Bash spellings), fable-r3 (malformed
 * input, domains, params), fable-r4 (trailing syntax), R1..R14 and R5-<what>
 * (the rulings), e2e-N2 (the e2e hook probe). Adding a case is one line.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";

type Kind = "deny" | "ask" | "both";
type Expected = "block" | "ask" | "pass";
/** Environment changes for a row: no jq on PATH, a jq that prints nothing or `true`, the script saved with CRLF. */
type Env = "nojq" | "jq-empty" | "jq-true" | "crlf";
type Row = [rule: string, kind: Kind, input: object | string, expected: Expected, source: string, env?: Env];

const bash = (command: string) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
const fetch = (url: unknown) => ({ hook_event_name: "PreToolUse", tool_name: "WebFetch", tool_input: { url } });
const agent = (tool_input: unknown) => ({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input });
const BT = "`";
const RM = "Bash(rm *)";
const B = "both";

const ROWS: Row[] = [
  // --- fable r2, D: forms the Claude Code docs say a rule matches
  [RM, B, bash("rm x"), "block", "fable-r2-D"],
  [RM, B, bash("rm"), "block", "fable-r2-D"],
  [RM, B, bash(" rm x"), "block", "fable-r2-D"],
  [RM, B, bash("rm\tx"), "block", "fable-r2-D"],
  [RM, B, bash("ls && rm x"), "block", "fable-r2-D"],
  [RM, B, bash("ls;rm x"), "block", "fable-r2-D"],
  [RM, B, bash("ls|rm x"), "block", "fable-r2-D"],
  [RM, B, bash("ls |& rm x"), "block", "fable-r2-D"],
  [RM, B, bash("ls &\nrm x"), "block", "fable-r2-D"],
  [RM, B, bash("ls\nrm x"), "block", "fable-r2-D"],
  [RM, B, bash("ls\r\nrm x"), "block", "fable-r2-D"],
  [RM, B, bash("true || rm x"), "block", "fable-r2-D"],
  [RM, B, bash("rm x &"), "block", "fable-r2-D"],
  [RM, B, bash("FOO=1 rm x"), "block", "fable-r2-D"],
  [RM, B, bash("A=1 B=2 rm x"), "block", "fable-r2-D"],
  [RM, B, bash("FOO= rm x"), "block", "fable-r2-D"],
  [RM, B, bash('FOO="a b" rm x'), "block", "R2"],
  [RM, B, bash("FOO='a b' rm x"), "block", "R2"],
  [RM, B, bash("FOO=a\\ b rm x"), "block", "R2"],
  [RM, B, bash("FOO=$(date) rm x"), "block", "fable-r2-D"],
  [RM, B, bash("FOO+=1 rm x"), "block", "R2"],
  [RM, B, bash("timeout 5 rm x"), "block", "fable-r2-D"],
  [RM, B, bash("time rm x"), "block", "fable-r2-D"],
  [RM, B, bash("nice rm x"), "block", "fable-r2-D"],
  [RM, B, bash("nohup rm x"), "block", "fable-r2-D"],
  [RM, B, bash("stdbuf -oL rm x"), "block", "fable-r2-D"],
  [RM, B, bash("command rm x"), "block", "fable-r2-D"],
  [RM, B, bash("builtin rm x"), "block", "fable-r2-D"],
  [RM, B, bash("noglob rm x"), "block", "fable-r2-D"],
  [RM, B, bash("xargs rm"), "block", "fable-r2-D"],
  [RM, B, bash("echo x | xargs rm"), "block", "fable-r2-D"],
  [RM, B, bash("timeout 5 nice nohup rm x"), "block", "fable-r2-D"],
  [RM, B, bash("echo $(rm x)"), "block", "fable-r2-D"],
  [RM, B, bash(`echo ${BT}rm x${BT}`), "block", "fable-r2-D"],
  [RM, B, bash("(rm x)"), "block", "fable-r2-D"],
  [RM, B, bash("{ rm x; }"), "block", "fable-r2-D"],
  [RM, B, bash("rm x > /dev/null 2>&1"), "block", "fable-r2-D"],
  [RM, B, bash("> out rm x"), "block", "fable-r2-D"],
  [RM, B, bash("ls; > out rm x"), "block", "fable-r2-D"],
  [RM, B, bash("ls; 2>/dev/null rm x"), "block", "R1"],
  [RM, B, bash("ls; 2>&1 rm x"), "block", "R1"],
  [RM, B, bash("ls; &>/dev/null rm x"), "block", "R1"],
  [RM, B, bash("ls; <in rm x"), "block", "fable-r2-D"],
  [RM, B, bash("if true; then rm x; fi"), "block", "fable-r2-D"],
  [RM, B, bash("for f in a; do rm $f; done"), "block", "fable-r2-D"],
  [RM, B, bash("while true; do rm x; done"), "block", "fable-r2-D"],
  [RM, B, bash("! rm x"), "block", "fable-r2-D"],
  [RM, B, bash("rm \\\n -rf x"), "block", "fable-r2-D"],
  [RM, B, bash("r\\\nm x"), "block", "fable-r2-D"],
  [RM, B, bash("case x in x) rm y;; esac"), "block", "fable-r2-D"],
  [RM, B, bash("[[ -f x ]] && rm x"), "block", "fable-r2-D"],
  [RM, B, bash("time (rm x)"), "block", "fable-r2-D"],
  [RM, B, bash("rm x\r\n"), "block", "fable-r2-D"],
  [RM, B, bash("rm\u0000 x"), "block", "fable-r2-D"],
  [RM, B, bash("r\u0000m x"), "block", "fable-r2-D"],
  [RM, B, bash("rm x 😀 café"), "block", "fable-r2-D"],
  [RM, B, bash("echo " + "a;".repeat(20000) + " rm x"), "block", "fable-r2-D"],
  // --- fable r2, Q: the same program, spelled another way
  [RM, B, bash('"rm" x'), "block", "fable-r2-Q"],
  [RM, B, bash("'rm' x"), "block", "fable-r2-Q"],
  [RM, B, bash('r"m" x'), "block", "fable-r2-Q"],
  [RM, B, bash("r''m x"), "block", "fable-r2-Q"],
  [RM, B, bash("\\rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("r\\m x"), "block", "fable-r2-Q"],
  [RM, B, bash("$'rm' x"), "block", "fable-r2-Q"],
  [RM, B, bash("$'\\x72m' x"), "block", "fable-r2-Q"],
  [RM, B, bash("\"r\"'m' x"), "block", "fable-r2-Q"],
  [RM, B, bash("nice -n 5 rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("nice -n5 rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("nice -5 rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("nice --adjustment=5 rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("timeout -s KILL 5 rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("timeout --signal=KILL 5 rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("timeout -k 1 5s rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("timeout --foreground 5 rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("timeout 1m rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("time -p rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("command -p rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("command -- rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("stdbuf -o0 -e0 rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("stdbuf --output=L rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("nohup -- rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("xargs -n1 rm"), "block", "fable-r2-Q"],
  [RM, B, bash("xargs -I{} rm {}"), "block", "fable-r2-Q"],
  [RM, B, bash("/bin/rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("/usr/bin/rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("./rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("~/bin/rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("env rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("env -i rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("env FOO=1 rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("exec rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("sudo rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("sudo -u root rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("busybox rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("watch rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("setsid rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("ionice rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("flock /tmp/l rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("coproc rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("function f { rm x; }; f"), "block", "fable-r2-Q"],
  [RM, B, bash("f() { rm x; }; f"), "block", "fable-r2-Q"],
  [RM, B, bash("/b?n/rm x"), "block", "fable-r2-Q"],
  [RM, B, bash("/bin/r? x"), "block", "fable-r2-Q"],
  [RM, B, bash("r[m] x"), "block", "fable-r2-Q"],
  [RM, B, bash("{rm,x}"), "block", "fable-r2-Q"],
  [RM, B, bash("r{m,} x"), "block", "fable-r2-Q"],
  // --- fable r2, I: indirect
  [RM, B, bash("eval rm x"), "block", "fable-r2-I"],
  [RM, B, bash('eval "rm x"'), "block", "fable-r2-I"],
  [RM, B, bash("eval 'r''m x'"), "block", "fable-r2-I"],
  [RM, B, bash("bash -c 'rm x'"), "block", "fable-r2-I"],
  [RM, B, bash('sh -c "rm x"'), "block", "fable-r2-I"],
  [RM, B, bash("bash -c rm\\ x"), "block", "fable-r2-I"],
  [RM, B, bash("nice sh -c 'rm x'"), "block", "fable-r2-I"],
  [RM, B, bash("echo x | xargs sh -c 'rm \"$0\"'"), "block", "fable-r2-I"],
  [RM, B, bash("find . -name x -exec rm {} \\;"), "block", "fable-r2-I"],
  [RM, B, bash("find . -exec rm {} +"), "block", "fable-r2-I"],
  [RM, B, bash("X=rm; $X x"), "block", "fable-r2-I"],
  [RM, B, bash("X=rm && $X x"), "block", "fable-r2-I"],
  [RM, B, bash("a=r b=m; $a$b x"), "block", "fable-r2-I"],
  [RM, B, bash("${X:-rm} x"), "block", "fable-r2-I"],
  [RM, B, bash("$(echo rm) x"), "block", "fable-r2-I"],
  [RM, B, bash("$(echo r)m x"), "block", "fable-r2-I"],
  [RM, B, bash("$(printf 'r%s' m) x"), "block", "fable-r2-I"],
  [RM, B, bash(`${BT}echo rm${BT} x`), "block", "fable-r2-I"],
  [RM, B, bash(`${BT}echo r${BT}m x`), "block", "fable-r2-I"],
  [RM, B, bash("r$(true)m x"), "block", "fable-r2-I"],
  [RM, B, bash("r${Z}m x"), "block", "fable-r2-I"],
  [RM, B, bash("r$@m x"), "block", "fable-r2-I"],
  [RM, B, bash("cat <(rm x)"), "block", "fable-r2-I"],
  [RM, B, bash("echo >(rm x)"), "block", "fable-r2-I"],
  [RM, B, bash("bash <<< 'rm x'"), "block", "fable-r2-I"],
  [RM, B, bash("bash <<EOF\nrm x\nEOF"), "block", "fable-r2-I"],
  [RM, B, bash("cat <<EOF | sh\nrm x\nEOF"), "block", "fable-r2-I"],
  [RM, B, bash("sh <<'E'\n r\"\"m x\nE"), "block", "fable-r2-I"],
  [RM, B, bash("alias r=rm; r x"), "block", "fable-r2-I"],
  [RM, B, bash("alias ll='rm x'; ll"), "block", "fable-r2-I"],
  [RM, B, bash("trap 'rm x' EXIT"), "block", "fable-r2-I"],
  [RM, B, bash("printf 'rm x' | sh"), "block", "fable-r2-I"],
  [RM, B, bash("base64 -d <<< cm0geA== | sh"), "block", "fable-r2-I"],
  [RM, B, bash("python3 -c \"import os; os.system('rm x')\""), "block", "fable-r2-I"],
  [RM, B, bash("echo cm0geA== | base64 -d | bash"), "block", "fable-r2-I"],
  // --- clear non-matches that must pass
  [RM, B, bash("ls -la"), "pass", "fable-r2-NOT"],
  [RM, B, bash("rmdir x"), "pass", "fable-r2-NOT"],
  [RM, B, bash("echo rm x"), "pass", "fable-r2-NOT"],
  [RM, B, bash("echo rm"), "pass", "R12"],
  [RM, B, bash("git rm x"), "pass", "fable-r2-NOT"],
  [RM, B, bash("grep rm file"), "pass", "fable-r2-NOT"],
  [RM, B, bash("RM x"), "pass", "fable-r2-NOT"],
  [RM, B, bash("ｒｍ x"), "pass", "fable-r2-NOT"],
  [RM, B, bash("rm x"), "pass", "fable-r2-NOT"],
  [RM, B, bash("npm run rm"), "pass", "fable-r2-NOT"],
  [RM, B, bash("echo $(date)"), "pass", "fable-r2-NOT"],
  [RM, B, bash("echo 'a; rm x'"), "pass", "R12"],
  [RM, B, bash("git commit -m 'rm old files'"), "pass", "fable-r2-NOT"],
  [RM, B, bash("echo $(git log) | grep term"), "pass", "fable-r2-NOT"],
  [RM, B, bash("ls # rm x"), "pass", "R9"],
  [RM, B, bash("echo `date`"), "pass", "fable-r2-NOT"],
  [RM, B, bash("form x"), "pass", "fable-r2-NOT"],
  [RM, B, bash("echo $(ls) ; chmod +x a"), "pass", "fable-r2-NOT"],
  [RM, B, bash("lsof"), "pass", "brief"],
  ["Bash(git push *)", B, bash("git status"), "pass", "brief"],
  // over-blocked on purpose: a heredoc body is read as commands (the hook does not parse heredocs)
  [RM, B, bash("cat <<EOF\nrm x\nEOF"), "block", "fable-r2-NOT (over-block: heredoc body)"],
  // --- R5: what is doubt, shown on commands that are NOT the rule's (each is refused)
  [RM, B, bash("/bin/ls"), "block", "R5-path"],
  [RM, B, bash("./tool x"), "block", "R5-path"],
  [RM, B, bash("$X"), "block", "R5-dollar"],
  [RM, B, bash("l? x"), "block", "R5-glob"],
  [RM, B, bash("l[s] x"), "block", "R5-glob"],
  [RM, B, bash("{ls,} x"), "block", "R5-brace"],
  [RM, B, bash("\\ls"), "block", "R5-backslash"],
  [RM, B, bash("eval ls"), "block", "R5-eval"],
  [RM, B, bash("sh -c ls"), "block", "R5-sh-c"],
  [RM, B, bash("zsh -c ls"), "block", "R5-sh-c"],
  [RM, B, bash("dash -c ls"), "block", "R5-sh-c"],
  [RM, B, bash("env ls"), "block", "R5-env"],
  [RM, B, bash("exec ls"), "block", "R5-exec"],
  [RM, B, bash("sudo ls"), "block", "R5-sudo"],
  [RM, B, bash("doas ls"), "block", "R5-doas"],
  [RM, B, bash("nice -n 1 ls"), "block", "R5-nice-flags"],
  [RM, B, bash("nohup -- ls"), "block", "R5-nohup-flags"],
  [RM, B, bash("command -p ls"), "block", "R5-command-p"],
  [RM, B, bash("xargs ls"), "block", "R5-xargs"],
  [RM, B, bash("xargs -n1 ls"), "block", "R5-xargs"],
  [RM, B, bash("time ls"), "block", "R5-time"],
  [RM, B, bash("timeout --verbose 5 ls"), "block", "R5-timeout-flags"],
  [RM, B, bash("find . -exec ls {} \\;"), "block", "R5-find-exec"],
  [RM, B, bash("find . -execdir ls {} \\;"), "block", "R5-find-exec"],
  [RM, B, bash("find . -ok ls {} \\;"), "block", "R5-find-exec"],
  [RM, B, bash("echo ls | sh"), "block", "R5-pipe-sh"],
  [RM, B, bash("echo ls | bash"), "block", "R5-pipe-sh"],
  [RM, B, bash("echo ls | zsh"), "block", "R5-pipe-sh"],
  [RM, B, bash("source x"), "block", "R5-source"],
  [RM, B, bash(". x"), "block", "R5-source"],
  [RM, B, bash("alias l=ls"), "block", "R5-alias"],
  [RM, B, bash("g() { ls; }"), "block", "R5-function"],
  [RM, B, bash("function g { ls; }"), "block", "R5-function"],
  [RM, B, bash("trap ls EXIT"), "block", "R5-trap"],
  // found while building round 2: bash evaluates a quoted array subscript, running its substitution
  [RM, B, bash("[[ -v 'a[$(rm x)]' ]]"), "block", "own-subscript"],
  [RM, B, bash("printf -v 'a[$(rm x)]' x"), "block", "own-subscript"],
  [RM, B, bash("read 'a[`rm x`]' <<< y"), "block", "own-subscript"],
  [RM, B, bash("echo '$(rm x)'"), "pass", "own-subscript"],
  [RM, B, bash("echo 'a[1]'"), "pass", "own-subscript"],
  // --- fable r4 / R1, R9: ordinary trailing syntax on an exact rule
  ["Bash(npm run deploy)", B, bash("npm run deploy"), "block", "fable-r4"],
  ["Bash(npm run deploy)", B, bash("npm  run   deploy"), "block", "fable-r4"],
  ["Bash(npm run deploy)", B, bash("npm run deploy 2>&1"), "block", "R1"],
  ["Bash(npm run deploy)", B, bash("npm run deploy 2>/dev/null"), "block", "R1"],
  ["Bash(npm run deploy)", B, bash("npm run deploy >log 2>&1"), "block", "R1"],
  ["Bash(npm run deploy)", B, bash("npm run deploy 1>&2"), "block", "R1"],
  ["Bash(npm run deploy)", B, bash("npm run deploy 2>>err.log"), "block", "R1"],
  ["Bash(npm run deploy)", B, bash("npm run deploy &>log"), "block", "R1"],
  ["Bash(npm run deploy)", B, bash("cd app && npm run deploy 2>&1"), "block", "R1"],
  ["Bash(npm run deploy)", B, bash("2>&1 npm run deploy"), "block", "R1"],
  ["Bash(npm run deploy)", B, bash("npm run deploy # go"), "block", "R9"],
  ["Bash(npm run deploy)", B, bash("npm run 'deploy'"), "block", "fable-r4"],
  ["Bash(npm run deploy)", B, bash("NODE_ENV=prod npm run deploy"), "block", "fable-r4"],
  ["Bash(npm run deploy)", B, bash("npm run deploy --watch"), "pass", "fable-r4"],
  ["Bash(npm run deploy)", B, bash("npm run build"), "pass", "fable-r4"],
  ["Bash(* --no-verify)", B, bash("git commit --no-verify 2>&1"), "block", "R1"],
  ["Bash(* --no-verify)", B, bash("git commit --no-verify 2>/dev/null"), "block", "R1"],
  ["Bash(* --no-verify)", B, bash("git commit --no-verify # c"), "block", "R9"],
  ["Bash(* --no-verify)", B, bash("git commit -m x"), "pass", "fable-r4"],
  ["Bash(git push *)", B, bash("git push origin main"), "block", "fable-r4"],
  ["Bash(git push *)", B, bash("git push"), "block", "fable-r4"],
  ["Bash(ls *)", B, bash("lsof"), "pass", "fable-r4"],
  // --- e2e N2 (the hook probe's Bash cases)
  [RM, B, bash("/bin/rm x"), "block", "e2e-N2"],
  [RM, B, bash("bash -c 'rm x'"), "block", "e2e-N2"],
  ["Bash(git push *)", B, bash("git -C . push"), "block", "e2e-N2"],
  ["Bash(git push *)", B, bash("git -c push.default=current push origin main"), "block", "e2e-N2"],
  ["Bash(git push *)", B, bash("git --git-dir=.git push"), "block", "e2e-N2"],
  ["Bash(npm run deploy)", B, bash("npm --prefix app run deploy"), "block", "e2e-N2"],
  [RM, B, bash("$(echo rm) x"), "block", "e2e-G"],
  // --- fable r3: malformed input (doubt)
  [RM, B, "", "block", "fable-r3"],
  [RM, B, "   ", "block", "fable-r3"],
  [RM, B, "{ not json", "block", "fable-r3"],
  [RM, B, "null", "block", "fable-r3"],
  [RM, B, "[]", "block", "fable-r3"],
  [RM, B, '"s"', "block", "fable-r3"],
  [RM, B, "{}", "block", "fable-r3"],
  [RM, B, { tool_name: "Bash", tool_input: null }, "block", "fable-r3"],
  [RM, B, { tool_name: "Bash", tool_input: "rm x" }, "block", "fable-r3"],
  [RM, B, { tool_name: "Bash", tool_input: { command: 1 } }, "block", "fable-r3"],
  [RM, B, { tool_name: "Bash", tool_input: { command: ["rm"] } }, "block", "fable-r3"],
  [RM, B, JSON.stringify(bash("ls")) + JSON.stringify(bash("rm x")), "block", "fable-r3"],
  [RM, B, JSON.stringify(bash("rm x")) + JSON.stringify(bash("ls")), "block", "fable-r3"],
  [RM, B, bash(""), "pass", "fable-r3"],
  [RM, B, bash("   "), "pass", "fable-r3"],
  // --- fable r3: environment
  [RM, B, bash("ls"), "block", "fable-r3", "nojq"],
  [RM, B, bash("rm x"), "block", "fable-r3", "jq-empty"],
  [RM, B, bash("rm x"), "block", "fable-r3", "jq-true"],
  [RM, B, bash("rm x"), "block", "R14", "crlf"],
  [RM, B, bash("ls -la"), "pass", "R14", "crlf"],
  // --- R3/R4/R12: domains
  ["WebFetch(domain:evil.com)", B, fetch("https://evil.com/"), "block", "fable-r3"],
  ["WebFetch(domain:evil.com)", B, fetch("HTTPS://EVIL.COM/x"), "block", "fable-r3"],
  ["WebFetch(domain:evil.com)", B, fetch("https://evil.com:443/x"), "block", "fable-r3"],
  ["WebFetch(domain:evil.com)", B, fetch("https://evil.com?x=1"), "block", "fable-r3"],
  ["WebFetch(domain:evil.com)", B, fetch("http://evil.com./"), "block", "R12"],
  ["WebFetch(domain:evil.com)", B, fetch("https://user@evil.com/"), "block", "fable-r3"],
  ["WebFetch(domain:evil.com)", B, fetch("https://good.com@evil.com/"), "block", "fable-r3"],
  ["WebFetch(domain:evil.com)", B, fetch("https://a@b@evil.com/"), "block", "R3"],
  ["WebFetch(domain:evil.com)", B, fetch("https://evil.com\\.good.com/"), "block", "R3"],
  ["WebFetch(domain:evil.com)", B, fetch("https://evil.com\\@good.com/"), "block", "R3"],
  ["WebFetch(domain:evil.com)", B, fetch("https://ev%69l.com/"), "block", "R3"],
  ["WebFetch(domain:evil.com)", B, fetch("https://evil%2Ecom/"), "block", "R3"],
  ["WebFetch(domain:evil.com)", B, fetch("https://ｅvil.com/"), "block", "R3"],
  ["WebFetch(domain:evil.com)", B, fetch("https://evil。com/"), "block", "R3"],
  ["WebFetch(domain:evil.com)", B, fetch("https://ev­il.com/"), "block", "R3"],
  ["WebFetch(domain:evil.com)", B, fetch("https://ev\til.com/"), "block", "R3"],
  ["WebFetch(domain:evil.com)", B, fetch("https://evil\n.com/"), "block", "R3"],
  ["WebFetch(domain:evil.com)", B, fetch("https://evil.com /"), "block", "R3"],
  ["WebFetch(domain:evil.com)", B, fetch(" https://evil.com/"), "block", "R3"],
  ["WebFetch(domain:evil.com)", B, fetch("https:/evil.com/"), "block", "R3"],
  ["WebFetch(domain:evil.com)", B, fetch("ftp://evil.com/"), "block", "R3"],
  ["WebFetch(domain:evil.com)", B, fetch("evil.com"), "block", "R3"],
  ["WebFetch(domain:evil.com)", B, fetch(""), "block", "R3"],
  ["WebFetch(domain:evil.com)", B, fetch(1), "block", "fable-r3"],
  ["WebFetch(domain:evil.com)", B, { tool_name: "WebFetch" }, "block", "fable-r3"],
  ["WebFetch(domain:evil.com)", B, fetch("https://api.evil.com/"), "pass", "R12"],
  ["WebFetch(domain:evil.com)", B, fetch("https://notevil.com/"), "pass", "R12"],
  ["WebFetch(domain:evil.com)", B, fetch("https://good.com/evil.com"), "pass", "R12"],
  ["WebFetch(domain:*.evil.com)", B, fetch("https://api.evil.com/"), "block", "R4"],
  ["WebFetch(domain:*.evil.com)", B, fetch("https://a.b.evil.com/"), "block", "R4"],
  ["WebFetch(domain:*.evil.com)", B, fetch("https://evil.com/"), "pass", "R4"],
  ["WebFetch(domain:*.evil.com)", B, fetch("https://notevil.com/"), "pass", "R4"],
  ["WebFetch(domain:*.evil.com)", B, fetch("https://evil.com /"), "block", "R3"],
  // --- R8: param rules
  ["Agent(model:opus)", B, agent({ model: "opus" }), "block", "fable-r3"],
  ["Agent(model:opus)", B, agent({ model: "sonnet" }), "pass", "fable-r3"],
  ["Agent(model:opus)", B, agent({ prompt: "x" }), "pass", "fable-r3"],
  ["Agent(model:opus)", B, agent({ model: ["opus"] }), "block", "fable-r3"],
  ["Agent(model:opus)", B, { tool_name: "Agent" }, "block", "R8"],
  ["Agent(model:opus)", B, agent(null), "block", "R8"],
  ["Agent(model:opus)", B, agent(false), "block", "R8"],
  // --- R12: Agent(name) matches tool_input.subagent_type
  ["Agent(Explore)", B, agent({ subagent_type: "Explore", prompt: "x" }), "block", "R12"],
  ["Agent(Explore)", B, agent({ subagent_type: "Plan", prompt: "x" }), "pass", "R12"],
  ["Agent(Explore)", B, agent({ prompt: "x" }), "block", "R12"],
  ["Agent(Explore)", B, agent({ subagent_type: 1 }), "block", "R12"],
];

// ---------------------------------------------------------------------------

const topo = (list: "deny" | "ask", rule: string) => `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "corpus"
  }
  orchestrator {
    model: sonnet
    handles: [intake]
  }
  action intake {
    kind: inline
  }
  agent a {
    model: sonnet
    tools: [Bash, WebFetch, Agent, Read]
    ${list}: [${JSON.stringify(rule)}]
  }
  flow {
    intake -> a
  }
}
`;

const SCRIPT = ".claude/skills/t/scripts/agent-rule.sh";
let root: string;
const projects = new Map<string, { dir: string; command: string }>();
const envDirs = new Map<Env, string>();

/** A project scaffolded for one rule, written once. */
function project(list: "deny" | "ask", rule: string, env?: Env) {
  const key = `${list} ${rule} ${env ?? ""}`;
  const known = projects.get(key);
  if (known) return known;
  const dir = fs.mkdtempSync(join(root, "p-"));
  const files = claudeCodeBinding.scaffold(parse(topo(list, rule)));
  for (const f of files) {
    fs.mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    fs.writeFileSync(join(dir, f.path), env === "crlf" ? f.content.replace(/\n/g, "\r\n") : f.content);
  }
  const md = fs.readFileSync(join(dir, ".claude/agents/a/AGENT.md"), "utf8").replace(/\r\n/g, "\n");
  const line = md.split("\n").find((l) => /^\s+(- )?command: "/.test(l));
  if (!line) throw new Error(`no hook command for ${key}`);
  const command = JSON.parse(line.replace(/^\s+(- )?command: /, "")) as string;
  const p = { dir, command };
  projects.set(key, p);
  return p;
}

/** A PATH for an environment row: bash and cat, and no jq, or a jq that lies. */
function envPath(env: Env): string | undefined {
  if (env === "crlf") return undefined;
  const known = envDirs.get(env);
  if (known) return known;
  const bin = fs.mkdtempSync(join(root, `bin-${env}-`));
  for (const tool of ["bash", "cat", "sh"]) {
    const real = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    if (real) fs.symlinkSync(real, join(bin, tool));
  }
  if (env === "jq-empty") fs.writeFileSync(join(bin, "jq"), "#!/bin/sh\ncat >/dev/null\nexit 0\n", { mode: 0o755 });
  if (env === "jq-true") fs.writeFileSync(join(bin, "jq"), "#!/bin/sh\ncat >/dev/null\necho true\nexit 0\n", { mode: 0o755 });
  envDirs.set(env, bin);
  return bin;
}

function run(list: "deny" | "ask", rule: string, input: object | string, env?: Env) {
  const { dir, command } = project(list, rule, env);
  const path = env ? envPath(env) : undefined;
  return spawnSync("/bin/sh", ["-c", command], {
    cwd: dir,
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...(path ? { PATH: path } : {}) },
  });
}

const verdict = (list: "deny" | "ask", r: ReturnType<typeof run>): string => {
  if (list === "deny") return r.status === 2 ? "block" : r.status === 0 && r.stdout.trim() === "" ? "pass" : `other(exit ${r.status}, ${r.stdout.slice(0, 60)} ${r.stderr.slice(0, 120)})`;
  if (r.status !== 0) return `other(exit ${r.status}, ${r.stderr.slice(0, 120)})`;
  if (r.stdout.trim() === "") return "pass";
  try {
    return JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === "ask" ? "ask" : `other(${r.stdout.slice(0, 60)})`;
  } catch {
    return `other(${r.stdout.slice(0, 60)})`;
  }
};

const show = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 70 ? `${s.slice(0, 50)}…(${s.length} chars)` : s;
};

beforeAll(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), "at-corpus-"));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("agent-rule.sh corpus (condition 1)", () => {
  for (const [rule, kind, input, expected, source, env] of ROWS) {
    const lists = kind === "both" ? (["deny", "ask"] as const) : ([kind] as const);
    for (const list of lists) {
      const want = expected === "pass" ? "pass" : list === "deny" ? "block" : "ask";
      const name = `[${source}] ${list} ${rule} ${show(typeof input === "object" && input && "tool_input" in input ? (input as { tool_input: unknown }).tool_input : input)}${env ? ` (${env})` : ""} -> ${want}`;
      it(name, () => {
        expect(verdict(list, run(list, rule, input, env))).toBe(want);
      });
    }
  }
  it("the generated script exists where the hooks run it", () => {
    const { dir } = project("deny", RM);
    expect(fs.existsSync(join(dir, SCRIPT))).toBe(true);
  });
});
