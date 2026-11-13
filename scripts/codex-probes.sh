#!/usr/bin/env bash
# Codex probe pack (CX-3). Settles 10 facts about Codex CLI that its docs do not state.
#
# Off by default: probes P1-P7 and P10 make live `codex exec` model calls on your own Codex login.
#   CODEX_LIVE=1 scripts/codex-probes.sh            # all probes
#   CODEX_LIVE=1 scripts/codex-probes.sh P1 P9      # some probes
# P8 and P9 start no model and run without CODEX_LIVE=1 when named explicitly.
#
# Every probe runs in a fresh temp git repo under one temp dir (printed at the start, or $PROBE_DIR).
# Project trust and hook trust are granted on the command line for that temp repo only
# (`-c projects.<repo>.trust_level="trusted"`, `--dangerously-bypass-hook-trust`).
# Nothing under $CODEX_HOME is written by this script; `--ignore-user-config` keeps your own
# config and hooks out of the runs (auth still comes from CODEX_HOME), and `--ephemeral` keeps
# sessions out of your history except where a probe needs a saved session (P5).
#
# Output: per probe, the hook log (`hooks.jsonl`, one JSON line per hook call) and the exec JSONL
# stream (`exec.jsonl`) in <dir>/<probe>/, plus a short summary on stdout. The answers recorded in
# spec/codex/probes.json were read from these files by hand.

set -u

PROBES=("$@")
[ ${#PROBES[@]} -eq 0 ] && PROBES=(P1 P2 P3 P4 P5 P6 P7 P8 P9 P10)

needs_model() { case "$1" in P8|P9) return 1 ;; *) return 0 ;; esac; }

if [ "${CODEX_LIVE:-}" != "1" ]; then
  for p in "${PROBES[@]}"; do
    if needs_model "$p" || [ $# -eq 0 ]; then
      echo "codex-probes: off. Set CODEX_LIVE=1 to run (live probes call a model on your Codex login)." >&2
      exit 0
    fi
  done
fi

command -v codex >/dev/null || { echo "codex-probes: codex not installed" >&2; exit 1; }
command -v python3 >/dev/null || { echo "codex-probes: python3 is needed" >&2; exit 1; }
echo "codex: $(codex --version)"

ROOT="${PROBE_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/codex-probes.XXXXXX")}"
ROOT="$(cd "$ROOT" && pwd -P)"
echo "probe dir: $ROOT"
EXEC_TIMEOUT="${EXEC_TIMEOUT:-240}"

# Run a command with a wall-clock limit, ending its whole process group (the npm `codex` wrapper
# spawns the native binary as a child; a plain alarm on the wrapper leaves the child running).
with_timeout() {
  local secs="$1"; shift
  perl -e '
    my $t = shift @ARGV; my $pid = fork();
    if ($pid == 0) { setpgrp(0,0); exec @ARGV or exit 127; }
    $SIG{ALRM} = sub { kill "TERM", -$pid; sleep 2; kill "KILL", -$pid; print STDERR "TIMEOUT\n"; exit 124; };
    alarm $t; waitpid($pid,0); alarm 0; exit($? >> 8);' "$secs" "$@"
}

# new_repo <probe>: fresh git repo with the logging hook script in it. Prints the repo path.
new_repo() {
  local d="$ROOT/$1"
  rm -rf "$d"; mkdir -p "$d/.codex"
  (cd "$d" && git init -q && git commit -q --allow-empty -m init)
  cat >"$d/probe-hook.py" <<'PY'
import json, os, sys, time
label = sys.argv[1]
raw = sys.stdin.read()
try:
    payload = json.loads(raw)
except Exception:
    payload = {"_raw": raw}
log = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hooks.jsonl")
with open(log, "a") as f:
    f.write(json.dumps({"label": label, "payload": payload}) + "\n")
# Exit as the probe asks: a marker in the tool input picks the exit.
text = json.dumps(payload.get("tool_input", ""))
if label == "gate":
    if "PROBE_EXIT2" in text:
        sys.stderr.write("probe: blocked with exit 2\n"); sys.exit(2)
    if "PROBE_EXIT1" in text:
        sys.stderr.write("probe: exit 1\n"); sys.exit(1)
    if "PROBE_EXIT127" in text:
        sys.stderr.write("probe: exit 127\n"); sys.exit(127)
    if "PROBE_TIMEOUT" in text:
        # Sleeps past the 3 s timeout, then would block. If the command still runs and the hook
        # log has no "after-sleep" line, Codex ended the hook at its timeout and failed open.
        time.sleep(20)
        with open(log, "a") as f:
            f.write(json.dumps({"label": "after-sleep", "payload": {}}) + "\n")
        sys.stderr.write("probe: blocked after sleeping past the timeout\n"); sys.exit(2)
sys.exit(0)
PY
  echo "$d"
}

hook() { # hook <repo> <label>: the command string for hooks.json
  printf 'python3 -I %s/probe-hook.py %s' "$1" "$2"
}

# write_hooks <repo> <json>: the hooks.json body
write_hooks() { printf '%s\n' "$2" >"$1/.codex/hooks.json"; }

# log-only hooks on every event, plus whatever extra entries the probe passes
std_hooks() {
  local r="$1" extra="${2:-}"
  local all; all="$(hook "$r" all)"
  cat <<JSON
{"hooks":{
 "SessionStart":[{"hooks":[{"type":"command","command":"$all","timeout":10}]}],
 "UserPromptSubmit":[{"hooks":[{"type":"command","command":"$all","timeout":10}]}],
 "PreToolUse":[{"hooks":[{"type":"command","command":"$all","timeout":10}]}${extra:+,$extra}],
 "PostToolUse":[{"hooks":[{"type":"command","command":"$all","timeout":10}]}],
 "SubagentStart":[{"hooks":[{"type":"command","command":"$all","timeout":10}]}],
 "SubagentStop":[{"hooks":[{"type":"command","command":"$all","timeout":10}]}],
 "Stop":[{"hooks":[{"type":"command","command":"$all","timeout":10}]}]
}}
JSON
}

RUNS=0
# run_exec <repo> <trust-hooks yes|no> <prompt> [extra codex args...]
# EPHEMERAL=0 saves the session (a subagent spawn fails in an ephemeral session: "no thread with id").
run_exec() {
  local r="$1" trust="$2" prompt="$3"; shift 3
  local eph=(--ephemeral); [ "${EPHEMERAL:-1}" = 0 ] && eph=()
  local args=(exec --json "${eph[@]}" --ignore-user-config -s workspace-write -C "$r"
    -c "projects.$r.trust_level=\"trusted\"" -c 'model_reasoning_effort="low"')
  [ "$trust" = yes ] && args+=(--dangerously-bypass-hook-trust)
  RUNS=$((RUNS + 1))
  with_timeout "$EXEC_TIMEOUT" codex "${args[@]}" "$@" "$prompt" </dev/null >"$r/exec.jsonl" 2>"$r/exec.stderr"
  echo "  exec exit: $?  (live run #$RUNS)"
}

summary() { # summary <repo>: hook labels/events/tool names, then exec item types
  local r="$1"
  python3 -I - "$r" <<'PY'
import json, os, sys
r = sys.argv[1]
p = os.path.join(r, "hooks.jsonl")
if os.path.exists(p):
    for line in open(p):
        e = json.loads(line); pl = e["payload"]
        print("  hook", e["label"], pl.get("hook_event_name"), pl.get("tool_name", ""),
              json.dumps(pl.get("tool_input", pl.get("prompt", pl.get("agent_type", ""))))[:160])
else:
    print("  hook log: none (no hook ran)")
p = os.path.join(r, "exec.jsonl")
for line in open(p) if os.path.exists(p) else []:
    try: e = json.loads(line)
    except Exception: continue
    it = e.get("item") or {}
    if e.get("type") == "item.completed":
        print("  item", it.get("type"), json.dumps({k: it.get(k) for k in ("command", "exit_code", "status", "text", "changes", "tool") if k in it})[:200])
PY
}

probe_P1_P10() { # one run covers P1 (exit 2) and P10 (exit 1, 127, timeout)
  local r; r="$(new_repo P1_P10)"
  local gate; gate="$(hook "$r" gate)"
  write_hooks "$r" "$(std_hooks "$r" "{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"$gate\",\"timeout\":3}]}")"
  run_exec "$r" yes 'Run these five shell commands, one tool call each, in this order, even if one fails or is blocked. Do not retry any of them and do not run anything else: 1) echo PROBE_EXIT2 > out-exit2.txt 2) echo PROBE_EXIT1 > out-exit1.txt 3) echo PROBE_EXIT127 > out-exit127.txt 4) echo PROBE_TIMEOUT > out-timeout.txt 5) echo PROBE_PLAIN > out-plain.txt. Then list which of the five files exist.'
  sleep 20  # let a hook that outlived its timeout write its "after-sleep" line, if it was not ended
  summary "$r"; echo "  files: $(cd "$r" && ls out-*.txt 2>/dev/null | tr '\n' ' ')"
  echo "  after-sleep lines (0 = the timed-out hook was ended): $(grep -c after-sleep "$r/hooks.jsonl")"
}

probe_P2() { # apply_patch tool name; P8 cross-check: shell write into .codex/
  local r; r="$(new_repo P2)"
  write_hooks "$r" "$(std_hooks "$r")"
  run_exec "$r" yes 'Create a file named hello.txt containing the single line hello, using your apply_patch tool (not the shell). Then run the shell command: touch .codex/probe-write. Report whether each step worked.'
  summary "$r"; echo "  files: $(cd "$r" && ls hello.txt .codex/probe-write 2>&1 | tr '\n' ' ')"
}

probe_P3_P4() { # subagent spawn: tool name, input, agent_type vs the agent file's name
  local r; r="$(new_repo P3_P4)"
  mkdir -p "$r/.codex/agents"
  cat >"$r/.codex/agents/probe-file.toml" <<'TOML'
name = "probe_reviewer"
description = "Replies with the word PONG and nothing else."
developer_instructions = "Reply with the single word PONG. Do not run any tools."
TOML
  write_hooks "$r" "$(std_hooks "$r")"
  EPHEMERAL=0 run_exec "$r" yes 'Spawn one subagent of the custom agent type probe_reviewer and ask it to reply. Wait for its answer and report it. Do nothing else.'
  summary "$r"
  echo "  note: this run saved a session and a subagent session (see the thread id in exec.jsonl)"
}

session_of() { # first session_id in the hook log
  python3 -I -c 'import json,sys; print(json.loads(open(sys.argv[1]).readline())["payload"]["session_id"])' "$1/hooks.jsonl" 2>/dev/null
}

# queue_while_busy <repo> <tui|exec>: start a session that runs `sleep 40`, queue a message during it.
queue_while_busy() {
  local r="$1" mode="$2" tid="" i
  local prompt='Run the shell command: sleep 40 && echo slept. After it finishes, reply DONE. If you receive any further message, answer it too.'
  local common=(-s workspace-write -C "$r" -c "projects.$r.trust_level=\"trusted\"" -c 'model_reasoning_effort="low"' --dangerously-bypass-hook-trust)
  RUNS=$((RUNS + 1))
  if [ "$mode" = exec ]; then
    with_timeout "$EXEC_TIMEOUT" codex exec --json --ignore-user-config "${common[@]}" "$prompt" \
      </dev/null >"$r/exec.jsonl" 2>"$r/exec.stderr" &
  else
    # The TUI needs a terminal: `script` gives it a pty; `/quit` ends it. The top-level command has no
    # --ignore-user-config, so your user config (and user-level hooks) load in this one run.
    # CODEX_TUI_MODEL picks a model your account supports.
    ( sleep 110; printf '/quit\r'; sleep 3; printf '\003\003' ) | with_timeout 140 script -q "$r/tui.log" \
      codex --no-alt-screen ${CODEX_TUI_MODEL:+-m "$CODEX_TUI_MODEL"} -a never "${common[@]}" "$prompt" >/dev/null 2>&1 &
  fi
  local pid=$!
  for i in $(seq 1 70); do grep -q '"PreToolUse"' "$r/hooks.jsonl" 2>/dev/null && break; sleep 1; done
  sleep 3; tid="$(session_of "$r")"
  echo "  queue ($mode): $(with_timeout 30 codex queue --thread "$tid" --message 'PROBE_QUEUED: reply with QUEUED-OK' </dev/null 2>&1 | grep -v 'refresh available' | head -1)"
  wait "$pid"; echo "  session exit: $?  (live run #$RUNS)"
  summary "$r"
  echo "  UserPromptSubmit prompts: $(grep -c '"UserPromptSubmit"' "$r/hooks.jsonl")  (2 = the queued message fired it)"
  echo "  note: this run saved session $tid"
}

probe_P5() { # does a message queued with `codex queue` fire UserPromptSubmit, and how is it marked
  local r
  r="$(new_repo P5-exec)"; write_hooks "$r" "$(std_hooks "$r")"; queue_while_busy "$r" exec
  r="$(new_repo P5-tui)"; write_hooks "$r" "$(std_hooks "$r")"; queue_while_busy "$r" tui
}

probe_P6() { # -c developer_instructions sets the session's role
  local r; r="$(new_repo P6)"
  write_hooks "$r" "$(std_hooks "$r")"
  run_exec "$r" yes 'What is your role code? Answer with the code only.' \
    -c 'developer_instructions="Your role code is ZEBRA-42. When asked for your role code, answer ZEBRA-42."'
  summary "$r"
}

probe_P7() { # project hook in exec without hook trust (no bypass flag)
  local r; r="$(new_repo P7)"
  write_hooks "$r" "$(std_hooks "$r")"
  run_exec "$r" no 'Run the shell command: echo probe7 > p7.txt. Then stop.'
  summary "$r"; grep -i hook "$r/exec.stderr" | head -5
}

probe_P8() { # .codex/ writable under the workspace-write sandbox? No model.
  local r; r="$(new_repo P8)"
  mkdir -p "$r/sub"
  (cd "$r" && codex sandbox -C "$r" -P :workspace -- sh -c \
    'touch .codex/w && echo codex-dir:ok; touch sub/w && echo sub-dir:ok; touch .git/w && echo git-dir:ok' 2>&1)
}

probe_P9() { # which no-model command honors --strict-config
  local r; r="$(new_repo P9)"
  printf 'bogus_probe_key = 1\n' >"$r/.codex/config.toml"
  local dead=(-c model_provider=deadp -c 'model_providers.deadp.name="dead"' -c 'model_providers.deadp.base_url="http://127.0.0.1:9/v1"')
  for c in "features list" "mcp list" "sandbox -P :workspace -- true"; do
    echo "  codex --strict-config $c: $(cd "$r" && with_timeout 20 codex --strict-config $c </dev/null 2>&1 | head -1)"
  done
  echo "  codex --strict-config -c bogus doctor --json: config.load status = $(cd "$r" && with_timeout 40 codex --strict-config -c bogus_probe_key=1 doctor --json </dev/null 2>/dev/null | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["checks"]["config.load"]["status"])')"
  # exec with a dead provider: a config error stops it before any model request; a good config would
  # only reach a closed local port.
  echo "  exec --strict-config, trusted project config with a bogus key:"
  (cd "$r" && with_timeout 20 codex exec --strict-config --ephemeral "${dead[@]}" -c "projects.$r.trust_level=\"trusted\"" "say hi" </dev/null 2>&1 | grep -v 'refresh available' | head -3; echo "  exit: ${PIPESTATUS[0]}")
  echo "  exec --strict-config, untrusted project (layer not loaded):"
  (cd "$r" && with_timeout 15 codex exec --strict-config --ephemeral "${dead[@]}" "say hi" </dev/null 2>&1 | grep -c 'unknown configuration field' ; echo "  (count of 'unknown configuration field' lines)")
}

for p in "${PROBES[@]}"; do
  echo "== $p"
  case "$p" in
    P1|P10) [ -z "${DONE_P1:-}" ] && { DONE_P1=1; probe_P1_P10; } ;;
    P3|P4) [ -z "${DONE_P3:-}" ] && { DONE_P3=1; probe_P3_P4; } ;;
    P2) probe_P2 ;; P5) probe_P5 ;; P6) probe_P6 ;; P7) probe_P7 ;; P8) probe_P8 ;; P9) probe_P9 ;;
    *) echo "unknown probe $p" ;;
  esac
done
echo "live exec runs: $RUNS"
echo "probe dir kept for reading: $ROOT"
