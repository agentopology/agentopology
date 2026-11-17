/**
 * Compile one hook or gate `run:` with a built agentopology (a dist/ folder)
 * and record what it resolves to, for the 0.11.2 differential test.
 *
 * The same code runs against v0.11.2's dist (to freeze runs-0112.json) and
 * against this branch's dist (the test), so both sides are read the same way.
 *
 * A row is a run placed as a topology hook ("hook"), a gate ("gate") or an
 * agent's own hook ("agent-hook"). Its value is written into the .at as a JSON
 * string, or, for parser shapes, as the literal .at text `lit` (with
 * backslashes, braces, `#` as written), and the whole .at may use CRLF.
 *
 * Per row:
 *   - refused: validate reports V96 on it, a path scaffold would write is not
 *     a safe file name, or the .at does not parse
 *   - claude-code / codex: the command (settings.json / hooks.json for a hook,
 *     the gate wrapper's command line for a gate, the agent file's hook lines
 *     for an agent hook) and the stubs it adds
 *   - files: per target (claude-code, codex, cursor, claude-workflow), one
 *     digest of every generated file that differs from the baseline .at's:
 *     gate wrapper bodies, agent files, cursor hooks, all of it
 *   - step: for a gate, what `step check` reports (its run is executed; the
 *     tail of its output, which names the machine's paths, is cut)
 *
 * Plain JavaScript on purpose: it loads either dist by path.
 */

import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

export const TARGETS = ["claude-code", "codex", "cursor", "claude-workflow"];
const CODEX_MODEL = "gpt-5.2";
const STUB = "AGENTOPOLOGY_STUB";
const GATE_LINE = /^\s*(.*?) \|\| GATE_RESULT=\$\?\s*$/m;

/** The .at a run is compiled in: a declared bare script (`check-review`, by a second hook) and the run as hook h, gate g, or agent a's hook ah. */
export function atFor(kind, run, model = "sonnet", opts = {}) {
  const runLit = opts.lit ?? JSON.stringify(run);
  const hook = (id, ind) => [`${ind}hook ${id} {`, `${ind}  on: PreToolUse`, `${ind}  matcher: "Bash"`, `${ind}  run: ${runLit}`, `${ind}  type: command`, `${ind}}`];
  const text = [
    "topology t : [pipeline] {",
    "  meta {",
    '    version: "1.0.0"',
    '    description: "differential"',
    "  }",
    "  orchestrator {",
    `    model: ${model}`,
    "  }",
    "  agent a {",
    `    model: ${model}`,
    '    description: "a"',
    ...(kind === "agent-hook" ? ["    hooks {", ...hook("ah", "      "), "    }"] : []),
    "  }",
    "  agent b {",
    `    model: ${model}`,
    '    description: "b"',
    "  }",
    "  flow { a -> b }",
    ...(kind === "gate"
      ? ["  gates {", "    gate g {", "      after: a", "      before: b", `      run: ${runLit}`, "    }", "  }"]
      : []),
    "  hooks {",
    "    hook decl {",
    "      on: PostToolUse",
    '      matcher: "Edit"',
    '      run: "check-review"',
    "      type: command",
    "    }",
    ...(kind === "hook" ? hook("h", "    ") : []),
    "  }",
    "}",
  ].join("\n");
  return opts.crlf ? text.replace(/\n/g, "\r\n") : text;
}

export async function loadLib(dist) {
  const imp = (p) => import(pathToFileURL(join(dist, p)).href);
  const [{ parse }, { validate }, { bindings }, { unsafePathReason }, { checkStep, renderStepReport }] = await Promise.all([
    imp("parser/index.js"),
    imp("parser/validator.js"),
    imp("bindings/index.js"),
    imp("parser/paths.js"),
    imp("step/check.js"),
  ]);
  return { parse, validate, bindings, unsafePathReason, checkStep, renderStepReport, undo0114: from0114(dist) };
}

function silently(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = warn;
  }
}

const sha = (s) => createHash("sha256").update(s).digest("hex");

/**
 * The 0.11.4 guard-hook edits, as literal text (as0112-blocks.json, written once from the 0.11.4
 * generator), and what 0.11.2 had in their place.
 */
export const BLOCKS_0114 = JSON.parse(fs.readFileSync(new URL("./as0112-blocks.json", import.meta.url), "utf8"));
const OLD_AT_SPECIAL = "at_special() { [[ $1 == *[\\$\\`\\*\\?\\[\\{\\~]* ]]; }";
const OLD_LOOP = BLOCKS_0114.loop.replace('at_git_read "$i" || ', "");
const OLD_JQ_LINE = {
  "before-action.sh": 'command -v jq >/dev/null 2>&1 || { echo "agentopology: jq is required to check this step, so it is blocked" >&2; exit 2; }',
  "before-edit.sh": 'command -v jq >/dev/null 2>&1 || { echo "agentopology: jq is required to check this edit, so it is blocked" >&2; exit 2; }',
};
const TRAP = /^trap 'rc=\$\?;.*' EXIT$/gm;
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const HAS = "at_raw_has '[a-z0-9]+'(?: '[a-z0-9]+')*";
/** The no-jq block of one hook: its literal head and tail, and between them only the lines that name the gated words. */
const noJqBlock = (hook) => new RegExp(
  reEsc(BLOCKS_0114.noJqHead[hook]) + "\\n" +
  `(?:  if ${HAS}(?: \\|\\| ${HAS})*; then at_nojq_refuse; fi\\n)?` +
  `(?:${reEsc(BLOCKS_0114.noJqExpansionHead)}${HAS}(?: \\|\\| ${HAS})*; \\}; then at_nojq_refuse; fi\\n)?` +
  reEsc(BLOCKS_0114.noJqTail[hook]) + "\\n",
  "g",
);

/**
 * After 0.11.4: the no-jq block of the word reading, as literal pieces (as0112-blocks-words.json, written
 * once by freeze-nojq-blocks.mjs), and between them only the lines that name the gated words.
 */
export const BLOCKS_WORDS = JSON.parse(fs.readFileSync(new URL("./as0112-blocks-words.json", import.meta.url), "utf8"));
const QW = "'[^'\\s]+'";
const WORDS_HAS = `at_words_has ${QW}(?: ${QW})*`;
const noJqWordsBlock = (hook) => new RegExp(
  reEsc(BLOCKS_WORDS.head[hook]) + "\\n" +
  `(?:  if ${HAS}(?: \\|\\| ${HAS})*; then at_nojq_refuse; fi\\n)?` +
  (BLOCKS_WORDS.words[hook]
    ? `(?:${reEsc(BLOCKS_WORDS.words[hook])}\\n)?` + `(?:  if ${WORDS_HAS}(?: \\|\\| ${WORDS_HAS})*; then at_nojq_refuse; fi\\n)?`
    : "") +
  `(?:${reEsc(BLOCKS_WORDS.powershell)}${HAS}(?: \\|\\| ${HAS})*; \\}; then at_nojq_refuse; fi\\n)?` +
  `(?:${reEsc(BLOCKS_WORDS.expansionHead)}${HAS}(?: \\|\\| ${HAS})*; \\}; then at_nojq_refuse; fi\\n` +
  `${reEsc(BLOCKS_WORDS.globA)}${QW}(?: ${QW})*${reEsc(BLOCKS_WORDS.globB)}${QW}(?: ${QW})*${reEsc(BLOCKS_WORDS.globC)}\\n)?` +
  reEsc(BLOCKS_0114.noJqTail[hook]) + "\\n",
  "g",
);
/** at_names as 0.11.2 to 0.11.4 wrote it: the program word reader before the suffix, case and brace rule. */
const OLD_AT_NAMES = [
  "# at_names WORD KEY: WORD runs the tool KEY: its name at any path, or a glob or brace list that could be it.",
  "at_names() {",
  "  local w=$1 key=$2 b=${1##*/} part lit",
  "  [ \"$b\" = \"$key\" ] && return 0",
  "  if [[ $w == *'{'*','* ]]; then",
  "    for part in ${w//[\\{\\},]/ }; do [ \"${part##*/}\" = \"$key\" ] && return 0; done",
  "  fi",
  "  if [[ $b == *[\\*\\?\\[]* ]]; then",
  "    lit=$(letters \"$b\")",
  "    if [ \"${#lit}\" -ge 2 ] && [[ $key == $b ]]; then return 0; fi",
  "  fi",
  "  return 1",
  "}",
].join("\n");
/** Either no-jq block, 0.11.4's (letters) or the word reading's: exactly one of them must occur. */
const anyNoJqBlock = (hook) => new RegExp(`(?:${noJqBlock(hook).source})|(?:${noJqWordsBlock(hook).source})`, "g");

/** Replace `find` (a string or a /g regex) by `repl`; it must occur EXACTLY ONCE, or the digest fails. */
function once(text, find, repl, what, path) {
  const n = typeof find === "string" ? text.split(find).length - 1 : (text.match(find) ?? []).length;
  if (n !== 1) throw new Error(`as0112: ${what} occurs ${n} times in ${path}; it must occur exactly once`);
  return text.replace(find, typeof repl === "function" ? repl : () => repl);
}
const indent = (block, ind) => block.split("\n").map((l) => ind + l).join("\n");

/**
 * A 0.11.4 generated file's text with 0.11.4's guard-hook edits undone, so the digest compares everything
 * else byte for byte with 0.11.2 (the hooks' behavior is held by hook-differential-0112). Each edit is an
 * exact text that must occur exactly once in the file it belongs to; any other count throws, so drift
 * still shows. The edits: in before-action.sh, before-edit.sh and before-agent.sh the no-jq block (and,
 * in the first two, the jq line it replaced); in before-action.sh and the Codex if filter (at-if.sh, the
 * reader indented two spaces) at_special, at_git_read and its call; in before-action.sh AT_GIT_STEPS.
 * Applied only to a build of 0.11.4 or later (`on`); a 0.11.2 or 0.11.3 build's text is used as is.
 */
export function as0112(path, content, on) {
  const text = String(content);
  if (!on) return text;
  const base = path.replace(/^.*\//, "");
  const hook = /^(before-action|before-edit|before-agent)\.sh$/.test(base) ? base : null;
  const reader = base === "before-action.sh" ? "" : base === "at-if.sh" ? "  " : null;
  if (!hook && reader === null) {
    if (text.includes("at_git_read") || text.includes("# No jq (0.11.4)") || text.includes("at_words_has") || text.includes("at_brace_names")) throw new Error(`as0112: ${path} holds a 0.11.4 guard block`);
    return text;
  }
  let t = text;
  if (hook) {
    t = once(t, anyNoJqBlock(hook), "", "the no-jq block", path);
    if (OLD_JQ_LINE[hook]) t = once(t, TRAP, (m) => `${m}\n${OLD_JQ_LINE[hook]}`, "the trap line", path);
  }
  if (reader !== null) {
    t = once(t, indent(BLOCKS_0114.atSpecial, reader), reader + OLD_AT_SPECIAL, "at_special", path);
    t = once(t, indent(BLOCKS_0114.atGitRead, reader) + "\n", "", "at_git_read", path);
    t = once(t, reader + BLOCKS_0114.loop, reader + OLD_LOOP, "the at_git_read call", path);
    // the inline git alias check (0.11.4, its own commit)
    t = once(t, indent(BLOCKS_0114.atGitAlias, reader) + "\n", "", "at_git_alias", path);
    t = once(t, reader + BLOCKS_0114.aliasCall + "\n", "", "the at_git_alias call", path);
    // the program word reader (after 0.11.4): a suffix, a letter case or a brace list names the tool
    if (t.includes("at_brace_names")) t = once(t, indent(BLOCKS_WORDS.atNames, reader), indent(OLD_AT_NAMES, reader), "at_names", path);
  }
  if (base === "before-action.sh") t = once(t, /^AT_GIT_STEPS='[^'\n]*'\n/gm, "", "AT_GIT_STEPS", path);
  return t;
}

/** True for a dist of 0.11.4 or later, whose guard scripts carry the 0.11.4 edits. */
function from0114(dist) {
  const v = JSON.parse(fs.readFileSync(join(dist, "..", "package.json"), "utf8")).version;
  const [a, b, c] = v.split(/[.-]/).map(Number);
  return a > 0 || b > 11 || (b === 11 && c >= 4);
}

function scaffoldOf(lib, target, ast) {
  try {
    return { files: silently(() => lib.bindings[target].scaffold(ast)) };
  } catch (e) {
    return { error: String(e.message ?? e).slice(0, 200) };
  }
}

/** One digest of the files that differ from the baseline (added, changed or gone). */
function filesDigest(files, baseline, undo0114) {
  const now = new Map(files.map((f) => [f.path, sha(as0112(f.path, f.content, undo0114))]));
  const parts = [];
  for (const [p, h] of [...now].sort()) if (baseline.get(p) !== h) parts.push(`${p}\u0000${h}`);
  for (const p of [...baseline.keys()].sort()) if (!now.has(p)) parts.push(`${p}\u0000gone`);
  return sha(parts.join("\n")).slice(0, 16);
}

function commandOf(files, target, kind) {
  if (kind === "gate") {
    const wrapper = files.find((f) => /(^|\/)gate-g\.sh$/.test(f.path));
    const m = wrapper && GATE_LINE.exec(wrapper.content);
    return m ? m[1] : null;
  }
  if (kind === "agent-hook") {
    const agent = files.find((f) => /(^|\/)agents\/a(\/AGENT\.md|\.md|\.toml)$/.test(f.path));
    if (!agent) return null;
    const lines = String(agent.content).split("\n").filter((l) => /command|run|hook/i.test(l) && /\S/.test(l));
    return lines.length ? lines.join("\n") : null;
  }
  const cfg = files.find((f) => f.path === (target === "codex" ? ".codex/hooks.json" : ".claude/settings.json"));
  const pre = cfg ? JSON.parse(cfg.content).hooks?.PreToolUse ?? [] : [];
  const cmds = pre.flatMap((g) => (g.hooks ?? []).map((h) => h.command ?? h.prompt ?? ""));
  return cmds.length ? cmds.join(" ;; ") : null;
}

/** What `step check t.at b` reports for the gate: executed in an empty folder; output tails and paths cut. */
function stepCheck(lib, ast, run) {
  // Runs that would need a tool this machine may lack, or that write outside the folder, are not executed.
  if (/\b(bun|deno)\b|\/tmp\//.test(run)) return "skipped";
  const dir = fs.mkdtempSync(join(os.tmpdir(), "at-step-"));
  try {
    const report = lib.checkStep(ast, "b", { dir, today: "2026-01-01" });
    return lib.renderStepReport(report)
      .map((l) => l.split(dir).join("<DIR>").replace(/(exited \d+|did not finish): .*$/, "$1"))
      .join("\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** What `run` compiles to as a hook, a gate or an agent hook, per target. */
export function compileRun(lib, kind, run, baselines, opts = {}) {
  const parseFor = (model) => {
    try {
      return lib.parse(atFor(kind, run, model, opts));
    } catch {
      return null;
    }
  };
  const ast = parseFor("sonnet");
  // The .at does not parse (a lone brace in the run): nothing compiles.
  if (!ast) return { v96: false, parseError: true, refused: true };
  const owner = kind === "gate" ? 'Gate "g"' : kind === "agent-hook" ? 'Hook "ah"' : 'Hook "h"';
  const v96 = lib.validate(ast).some((r) => r.rule === "V96" && r.level === "error" && r.message.startsWith(owner));
  const out = { v96 };
  const files = {};
  for (const target of TARGETS) {
    // Codex runs no Claude model: the same .at with a Codex one.
    const tast = target === "codex" ? parseFor(CODEX_MODEL) : ast;
    const s = scaffoldOf(lib, target, tast);
    if (s.error) {
      files[target] = `error: ${s.error}`;
      if (target === "claude-code" || target === "codex") out[target] = { refused: true, command: null, stubs: [], error: s.error };
      continue;
    }
    files[target] = filesDigest(s.files, baselines[target], lib.undo0114);
    if (target === "claude-code" || target === "codex") {
      const unsafe = s.files.some((f) => lib.unsafePathReason(String(f.path).replace(/^\.\//, "")) !== null);
      const stubs = s.files.filter((f) => !baselines[target].has(f.path) && String(f.content).includes(STUB)).map((f) => f.path).sort();
      const command = commandOf(s.files, target, kind);
      // Codex's command opens with a long root-finding prelude: kept as a digest, the files digest covers the rest.
      out[target] = { refused: unsafe, command: target === "codex" && command ? `sha:${sha(command).slice(0, 16)}` : command, stubs };
    }
  }
  out.files = files;
  if (kind === "gate") out.step = stepCheck(lib, ast, run ?? opts.lit ?? "");
  out.refused = v96 || out["claude-code"].refused;
  return out;
}

/** The files each target scaffolds for the .at with a plain run: a row's changes are told apart from these. */
export function baselinesFor(lib) {
  const out = {};
  for (const target of TARGETS) {
    const ast = lib.parse(atFor("hook", "true", target === "codex" ? CODEX_MODEL : "sonnet"));
    out[target] = new Map(silently(() => lib.bindings[target].scaffold(ast)).map((f) => [f.path, sha(as0112(f.path, f.content, lib.undo0114))]));
  }
  return out;
}
