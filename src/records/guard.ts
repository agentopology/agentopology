/**
 * Generated record guards (Spec B, SP-7): pieces 1 and 2 of "What the Claude
 * Code binding generates". They are not a second guard: the 0.11.0 ledger
 * guards (src/bindings/lib/guards.ts) take these lines, so before-edit.sh
 * refuses a file-writing tool on a record and before-action.sh refuses a shell
 * command that names one and writes it, with the record's `written-by`
 * programs allowed. Both scripts fail closed. The same lines go into the
 * Codex scripts, which are built by the same library.
 *
 * A record is guarded here when it names its writers and cites no hand-built
 * guard (`guard:`, piece 5). A record with no `written-by` is one anyone may
 * write (SP-6 warns), so nothing is generated for it.
 *
 * @module
 */

import type { RecordDef, TopologyAST } from "../parser/ast.js";
import { ledgerPattern, shellQuote, type ProtectedLedger } from "../bindings/lib/guards.js";

/** The folder `agentopology record check` keeps its head files in (piece 3); the edit guard refuses it. */
export const RECORD_HEADS_DIR = ".agentopology/records";

/** The fixed text under every record: what no generated guard closes. The tool never prints "protected". */
export const RECORD_BYPASS_LINE = "a program running as the same OS user can still write this file; only a signature or another OS user closes that";

/** A record the generated guards hold: its patterns, as a gate ledger's, plus who may write it. */
export interface GuardedRecord extends ProtectedLedger {
  id: string;
  /** `written-by` as declared, for messages. */
  writers: string[];
  /** The `written-by` entries that are programs (not a node id), project-relative, lower case: what the shell guard lets write. */
  programs: string[];
  appendOnly: boolean;
}

/** True when the generated guards hold this record: it names its writers and cites no hand-built guard. */
export function isGuardedRecord(r: RecordDef): boolean {
  return (r.writtenBy?.length ?? 0) > 0 && (r.guard?.length ?? 0) === 0;
}

/** True when the generated guards leave this record to someone else: guarded here, or by a cited hand-built guard (piece 5). */
export function recordGuardedElsewhere(r: RecordDef): boolean {
  return isGuardedRecord(r) || (r.guard?.length ?? 0) > 0;
}

/** Every record the generated guards hold, in declaration order. */
export function guardedRecords(ast: TopologyAST): GuardedRecord[] {
  const nodeIds = new Set(ast.nodes.map((n) => n.id));
  return (ast.records ?? []).filter(isGuardedRecord).map((r) => {
    const path = r.path.replace(/^\.\//, "");
    const writers = r.writtenBy ?? [];
    const programs = writers.filter((w) => !nodeIds.has(w)).map((w) => w.replace(/^\.\//, "").toLowerCase());
    return { ...ledgerPattern(path), id: r.id, writers, programs, appendOnly: r.appendOnly === true };
  });
}

/**
 * The before-edit.sh lines, inside its loop over the edited paths ($R the
 * project-relative path, $RL lower-cased): a path on a record, or under the
 * head-file folder, is refused. A tool never runs a `written-by` program, so
 * no tool write of a record is allowed. Empty when no record is guarded.
 */
export function recordEditGuardLines(records: GuardedRecord[]): string[] {
  if (records.length === 0) return [];
  const sq = shellQuote;
  const out: string[] = [];
  for (const r of records) {
    const args = `${sq(r.id)} ${sq(r.path)} ${sq(r.writers.join(", "))} "$R"`;
    out.push(`  PAT=${sq(r.glob.toLowerCase())}; if [[ $RL == $PAT ]]; then refuse_record ${args}; fi`);
    if (r.name) out.push(`  PAT=${sq(r.name.toLowerCase())}; if [[ \${RL##*/} == $PAT ]]; then refuse_record ${args}; fi`);
  }
  out.push(`  PAT=${sq(RECORD_HEADS_DIR.toLowerCase() + "/")}; if [[ $RL == $PAT* ]]; then refuse_head "$R"; fi`);
  return out;
}

/** The before-edit.sh functions the loop lines above call. Empty when no record is guarded. */
export function recordEditGuardFunctions(records: GuardedRecord[]): string[] {
  if (records.length === 0) return [];
  return [
    "refuse_record() { echo \"agentopology: the edit touches the record $1 ($2); only its written-by programs write it ($3), so this edit of $4 is refused\" >&2; exit 2; }",
    `refuse_head() { echo "agentopology: the edit touches $1, a record head file under ${RECORD_HEADS_DIR}; only agentopology record check writes it" >&2; exit 2; }`,
  ];
}

/** The shell functions of the record check in before-action.sh. Needs MATCH_FUNCTIONS, $CMD, $CMD_L, and `set -f`. */
const RECORD_SHELL_FUNCTIONS: string[] = [
  "# SP-7 (Spec B): a record is a file only its written-by programs write. A command that names one is refused",
  "# unless each part of it only reads or runs one of those programs (by its project path: the program itself, or",
  "# an interpreter's script), and no redirection writes the record or a target that cannot be read. The body of a",
  "# here-document fed to a program that only reads it is text, not a command. Graded detect, never refuse: a path",
  "# built at run time, an interpreter one-liner or a script an agent wrote is not seen.",
  "at_rec_reads() {",
  "  local x=0 base; local -a ws",
  "  read -ra ws <<< \"$(lower \"$(norm \"$1\")\")\"",
  "  while [ \"$x\" -lt \"${#ws[@]}\" ] && [[ \"$AT_LEAD\" == *\" ${ws[x]} \"* ]]; do x=$((x+1)); done",
  "  [ \"$x\" -lt \"${#ws[@]}\" ] || return 0",
  "  [[ ${ws[x]} =~ ^[a-z_][a-z0-9_]*= ]] && return 1",
  "  at_special \"${ws[x]}\" && return 1",
  "  base=${ws[x]##*/}",
  "  at_reads_only \"$base\" \"${ws[@]:x+1}\"",
  "}",
  "at_rec_writer() {",
  "  local x=0 p q w root; local -a ws",
  "  read -ra ws <<< \"$(lower \"$(norm \"$1\")\")\"; shift",
  "  for w in \"${ws[@]}\"; do at_special \"$w\" && return 1; done",
  "  while [ \"$x\" -lt \"${#ws[@]}\" ] && [[ \"$AT_LEAD\" == *\" ${ws[x]} \"* ]]; do x=$((x+1)); done",
  "  [ \"$x\" -lt \"${#ws[@]}\" ] || return 1",
  "  p=${ws[x]}",
  "  if [[ ${p##*/} =~ ^(python[0-9.]*|node|bash|sh|zsh|ruby|perl|deno|bun|tsx)$ ]]; then",
  "    x=$((x+1))",
  "    if [ \"$x\" -lt \"${#ws[@]}\" ] && [ \"${ws[x]}\" = -u ]; then x=$((x+1)); fi",
  "    [ \"$x\" -lt \"${#ws[@]}\" ] || return 1",
  "    p=${ws[x]}",
  "  fi",
  "  q=${p#./}; root=$(lower \"$PWD\")",
  "  for w in \"$@\"; do",
  "    if [ \"$q\" = \"$w\" ] || [ \"$p\" = \"$root/$w\" ]; then return 0; fi",
  "  done",
  "  return 1",
  "}",
  "at_rec_text() {",
  "  local line t delim=\"\" dash=0 out=\"\" qt=\"['\\\"]?\"",
  "  local re=\"<<(-?)[[:space:]]*${qt}([A-Za-z_][A-Za-z0-9_]*)${qt}\"",
  "  while IFS= read -r line || [ -n \"$line\" ]; do",
  "    if [ -n \"$delim\" ]; then",
  "      t=$line",
  "      if [ \"$dash\" = 1 ]; then t=${t#\"${t%%[!$'\\t']*}\"}; fi",
  "      [ \"$t\" != \"$delim\" ] || delim=\"\"",
  "      continue",
  "    fi",
  "    out=$out$line$'\\n'",
  "    [[ $line =~ $re ]] || continue",
  "    t=${BASH_REMATCH[2]}; dash=0; [ -z \"${BASH_REMATCH[1]}\" ] || dash=1",
  "    [[ $line != *'<<<'* && $line != *[\\|\\&\\;\\(\\)\\`]* ]] || continue",
  "    [[ ${line#*<<} != *'<<'* ]] || continue",
  "    if at_rec_reads \"$(strip_redir \"$line\")\"; then delim=$t; fi",
  "  done <<< \"$1\"",
  "  printf '%s' \"$out\"",
  "}",
  "set +u",
  "REC_TEXT=$(at_rec_text \"$CMD\")",
  "REC_SEGS=$(strip_redir \"$REC_TEXT\")",
  "for sep in '&' '|' ';' '(' ')' '`'; do REC_SEGS=${REC_SEGS//\"$sep\"/$'\\n'}; done",
  "set -u",
  "# record_guard ID 'PATTERN' LETTERS PATH WRITERS PROGRAM...: refuse a command that names the record and writes it.",
  "record_guard() {",
  "  local id=$1 pat=$2 lt=$3 path=$4 who=$5 hit=0 ok=1 w t seg re='(>&|&>>|&>|>>|>[|]|>)[[:space:]]*([^[:space:];&|()<>]*)'",
  "  shift 5",
  "  for w in $(lower \"$(norm \"$CMD\")\"); do if [[ $w == $pat || $w == */$pat ]]; then hit=1; fi; done",
  "  [[ $CMD_L == *\"$lt\"* ]] && hit=1",
  "  [ \"$hit\" = 1 ] || return 0",
  "  t=$(norm \"$REC_TEXT\")",
  "  while [[ $t =~ $re ]]; do",
  "    w=$(lower \"${BASH_REMATCH[2]}\")",
  "    t=${t/\"${BASH_REMATCH[0]}\"/ }",
  "    if at_special \"$w\" || [[ $w == $pat || $w == */$pat || $(letters \"$w\") == *\"$lt\"* ]]; then ok=0; fi",
  "  done",
  "  set +u",
  "  while IFS= read -r seg || [ -n \"$seg\" ]; do",
  "    at_rec_reads \"$seg\" && continue",
  "    at_rec_writer \"$seg\" \"$@\" && continue",
  "    ok=0",
  "  done <<< \"$REC_SEGS\"",
  "  set -u",
  "  [ \"$ok\" = 0 ] || return 0",
  "  echo \"agentopology: the command touches the record $id ($path); only its written-by programs write it ($who) ($CMD)\" >&2",
  "  exit 2",
  "}",
];

/**
 * The before-action.sh lines that refuse a shell write to a record (piece 2):
 * the functions, then one `record_guard` call per record. Empty when no record
 * is guarded.
 */
export function recordShellGuardLines(records: GuardedRecord[]): string[] {
  if (records.length === 0) return [];
  const sq = shellQuote;
  return [
    ...RECORD_SHELL_FUNCTIONS,
    ...records.map((r) => [
      "record_guard", sq(r.id), sq(r.glob.toLowerCase()), sq(r.letters), sq(r.path), sq(r.writers.join(", ")), ...r.programs.map(sq),
    ].join(" ")),
    "",
  ];
}

/** One way into a record and its honest grade (Spec B, "The honest grade"). */
export interface RecordWayIn {
  way: string;
  grade: "refuse, by hook" | "detect" | "none" | "detect, by code";
  note: string;
}

/**
 * The ways into a guarded record, one line each, for `guard --check` to print
 * under the record (SP-9 renders them). No single grade: the ways differ. The
 * file-writing tool is "unverified" until the conformance suite proves the hook
 * on the installed version (`proven`). The append-only line is there only for a
 * record that declares `append-only: true`.
 */
export function recordWaysIn(r: Pick<GuardedRecord, "appendOnly">, proven = false): RecordWayIn[] {
  const out: RecordWayIn[] = [
    { way: "a file-writing tool", grade: "refuse, by hook", note: proven ? "proven on the installed version" : "unverified" },
    { way: "a shell command that names the path", grade: "detect", note: "a pattern on the command text" },
    { way: "a shell command that builds the path at run time, an interpreter one-liner, a script an agent wrote", grade: "none", note: RECORD_BYPASS_LINE },
    { way: "a process outside Claude Code (a scheduler, a terminal)", grade: "none", note: RECORD_BYPASS_LINE },
  ];
  if (r.appendOnly) out.push({ way: "a rewrite found later by record check", grade: "detect, by code", note: "found at the next check, not stopped" });
  return out;
}
